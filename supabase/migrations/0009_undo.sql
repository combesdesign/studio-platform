-- =============================================================================
-- Undo for staff mistakes (core change, the 0xxx range).
--   * bookings remember what they were before their last status change (prior_status, prior_waitlist_position),
--     so a cancel / removal can be put back exactly
--   * class_sessions remember when the studio cancelled them (cancelled_at), so restore knows which removals came from that
--   * undo_no_show, undo_cancel_booking, waive_penalty ("Return credit"), restore_session and void_sale
-- Every RPC mirrors the permission of the action it reverses, checks the studio, and writes an audit_log entry.
-- Stripe refunds are NOT undoable and void_sale refuses card payments.
-- =============================================================================

alter table public.bookings add column prior_status text, add column prior_waitlist_position integer;
alter table public.class_sessions add column cancelled_at timestamptz;

create or replace function app.remember_prior_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.prior_status := old.status;
    new.prior_waitlist_position := case when old.status = 'waitlisted' then old.waitlist_position end;
  end if;
  return new;
end $$;
create trigger remember_prior_status before update of status on public.bookings
  for each row execute function app.remember_prior_status();

create or replace function app.remember_session_cancel() returns trigger
language plpgsql as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then new.cancelled_at := app.now();
  elsif new.status <> 'cancelled' then new.cancelled_at := null;
  end if;
  return new;
end $$;
create trigger remember_session_cancel before update of status on public.class_sessions
  for each row execute function app.remember_session_cancel();

-- Put a booking back on the waitlist where it was (by when they joined), then renumber 1..n.
create or replace function app.rejoin_waitlist(p_booking_id uuid, p_position integer default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; k int;
begin
  select * into b from public.bookings where id = p_booking_id;
  k := coalesce(p_position, (select count(*)::int from public.bookings x
                              where x.session_id = b.session_id and x.status = 'waitlisted' and x.id <> b.id and x.created_at < b.created_at) + 1);
  update public.bookings set waitlist_position = waitlist_position + 1
   where session_id = b.session_id and status = 'waitlisted' and id <> b.id and waitlist_position >= k;
  update public.bookings set status = 'waitlisted', waitlist_position = k, cancelled_at = null, pass_id = null, promoted_from_waitlist_at = null
   where id = b.id;
  perform app.renumber_waitlist(b.session_id);
end $$;

-- ----------------------------------------------------------------------------- no-show -> booked
create or replace function public.undo_no_show(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id);
begin
  perform app.assert_studio_open(b.studio_id);
  if b.status <> 'no_show' then perform app.fail('INVALID', 'This booking is no longer marked as a no-show.'); end if;
  update public.bookings set status = 'booked' where id = b.id;
  perform app.audit('undo_no_show', 'bookings', b.id::text, jsonb_build_object('client_id', b.client_id));
  return app.booking_json(b.id);
end $$;

-- ----------------------------------------------------------------------------- staff cancel / late cancel / waitlist removal -> back
create or replace function public.undo_cancel_booking(p_booking_id uuid, p_demote_booking_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.bookings := app.staff_booking_for_update(p_booking_id);
  s public.class_sessions; w public.bookings; p public.passes;
  v_now timestamptz := app.now();
  v_prior text := b.prior_status;
  v_taken boolean := false;
  v_demoted jsonb;
begin
  perform app.assert_studio_open(b.studio_id);
  select * into s from public.class_sessions where id = b.session_id for update;
  if s.status = 'cancelled' then perform app.fail('CLASS_CANCELLED', 'That class has been cancelled. Restore the class instead.'); end if;
  if v_now >= s.ends_at then perform app.fail('TOO_LATE', 'That class has finished.'); end if;
  if not ((b.status = 'removed' and v_prior = 'waitlisted')
          or (b.status in ('cancelled','late_cancelled') and v_prior in ('booked','checked_in','no_show'))) then
    perform app.fail('INVALID', 'This booking can''t be put back any more.');
  end if;
  if exists (select 1 from public.bookings x where x.session_id = s.id and x.client_id = b.client_id and x.id <> b.id
                and x.status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'They have been booked into this class again already.');
  end if;

  if b.status = 'removed' then
    if v_now >= s.starts_at then perform app.fail('TOO_LATE', 'The class has started, so the waitlist is closed.'); end if;
    perform app.rejoin_waitlist(b.id, b.prior_waitlist_position);
    perform app.audit('undo_cancel_booking', 'bookings', b.id::text, jsonb_build_object('back_to', 'waitlisted'));
    return jsonb_build_object('booking', app.booking_json(b.id), 'creditTaken', false, 'demoted', null);
  end if;

  if p_demote_booking_id is not null then
    perform app.assert_in_studio('bookings', p_demote_booking_id, 'We couldn''t find that booking.');
    select * into w from public.bookings where id = p_demote_booking_id for update;
    if w.session_id <> s.id or w.status <> 'booked' or w.promoted_from_waitlist_at is null then
      perform app.fail('INVALID', 'The person who took that spot can''t be moved back.');
    end if;
    if w.pass_id is not null then perform app.return_credit(w.pass_id); end if;
    perform app.rejoin_waitlist(w.id, case when w.prior_status = 'waitlisted' then w.prior_waitlist_position end);   -- the place they had before the promotion
    v_demoted := app.booking_json(w.id);
  end if;

  if (select count(*) from public.bookings where session_id = s.id and status in ('booked','checked_in')) >= s.capacity then
    perform app.fail('CLASS_FULL', 'Someone else has taken that spot, so they can''t be put back.');
  end if;

  if b.status = 'cancelled' and b.pass_id is not null then   -- a late cancel never gave the credit back
    select * into p from public.passes where id = b.pass_id for update;
    if p.id is null or not (app.pass_usable(p, s.starts_at, s.class_type_id, v_now) and coalesce(app.pass_remaining(p, s.starts_at), 1) > 0) then
      perform app.fail('NO_CREDITS', 'They can''t be put back: their pass has no credit for this class now.');
    end if;
    perform app.apply_credit(p.id, v_now);
    v_taken := true;
  end if;

  update public.bookings set status = v_prior, cancelled_at = null where id = b.id;
  perform app.renumber_waitlist(s.id);
  perform app.audit('undo_cancel_booking', 'bookings', b.id::text,
    jsonb_build_object('back_to', v_prior, 'credit_taken', v_taken, 'demoted', p_demote_booking_id));
  return jsonb_build_object('booking', app.booking_json(b.id), 'creditTaken', v_taken, 'demoted', v_demoted);
end $$;

-- ----------------------------------------------------------------------------- "Return credit": waive a late cancel / no-show later
create or replace function public.waive_penalty(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id);
begin
  perform app.assert_studio_open(b.studio_id);
  if b.status not in ('late_cancelled','no_show') then perform app.fail('INVALID', 'There is no penalty on this booking to waive.'); end if;
  update public.bookings set status = 'cancelled', cancelled_at = coalesce(cancelled_at, app.now()) where id = b.id;
  if b.pass_id is not null then perform app.return_credit(b.pass_id); end if;
  perform app.audit('waive_penalty', 'bookings', b.id::text, jsonb_build_object('from_status', b.status, 'client_id', b.client_id));
  return app.booking_json(b.id);
end $$;

-- ----------------------------------------------------------------------------- restore a cancelled class
create or replace function public.restore_session(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.class_sessions; b record; p public.passes;
  v_now timestamptz := app.now();
  v_stamp timestamptz;
  v_ids uuid[] := '{}';
  v_attention jsonb := '[]'::jsonb;
  v_why text;
  v_restored jsonb;
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  select * into s from public.class_sessions where id = p_session_id for update;
  if not (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to restore classes.');
  end if;
  perform app.assert_studio_open(s.studio_id);
  if s.status <> 'cancelled' then perform app.fail('INVALID', 'This class is not cancelled.'); end if;
  if v_now >= s.ends_at then perform app.fail('TOO_LATE', 'That class has finished.'); end if;
  v_stamp := coalesce(s.cancelled_at, (select max(cancelled_at) from public.bookings where session_id = s.id and status = 'removed'));
  update public.class_sessions set status = 'scheduled', cancel_reason = null where id = s.id;

  -- people who had a spot, in the order they booked
  for b in select bk.*, trim(c.first_name || ' ' || c.last_name) as nm, c.archived as c_archived
             from public.bookings bk join public.clients c on c.id = bk.client_id
            where bk.session_id = s.id and bk.status = 'removed' and bk.prior_status in ('booked','checked_in','no_show')
              and bk.cancelled_at >= v_stamp
            order by bk.created_at, bk.id for update of bk
  loop
    v_why := null;
    if exists (select 1 from public.bookings x where x.session_id = s.id and x.client_id = b.client_id and x.id <> b.id and x.status in ('booked','waitlisted','checked_in')) then
      v_why := 'Already booked into this class again';
    elsif exists (select 1 from public.bookings x join public.class_sessions o on o.id = x.session_id
                   where x.client_id = b.client_id and x.session_id <> s.id and x.status in ('booked','checked_in')
                     and o.status <> 'cancelled' and o.starts_at < s.ends_at and o.ends_at > s.starts_at) then
      v_why := 'Took another class at the same time';
    elsif b.c_archived then v_why := 'Client is archived';
    elsif (select count(*) from public.bookings where session_id = s.id and status in ('booked','checked_in')) >= s.capacity then
      v_why := 'No spot left';
    elsif b.pass_id is not null then
      select * into p from public.passes where id = b.pass_id for update;
      if p.id is null then v_why := 'Their pass is gone';
      elsif not (app.pass_usable(p, s.starts_at, s.class_type_id, v_now) and coalesce(app.pass_remaining(p, s.starts_at), 1) > 0) then
        v_why := 'No credit left on their ' || p.name;
      else perform app.apply_credit(p.id, v_now);
      end if;
    end if;
    if v_why is not null then
      v_attention := v_attention || jsonb_build_array(jsonb_build_object('bookingId', b.id, 'clientId', b.client_id, 'name', b.nm, 'reason', v_why));
    else
      update public.bookings set status = b.prior_status, cancelled_at = null where id = b.id;
      v_ids := v_ids || b.id;
      perform app.notify(b.id, 'booking_confirmed');
    end if;
  end loop;

  -- the waitlist, back in its old order
  for b in select bk.*, trim(c.first_name || ' ' || c.last_name) as nm
             from public.bookings bk join public.clients c on c.id = bk.client_id
            where bk.session_id = s.id and bk.status = 'removed' and bk.prior_status = 'waitlisted' and bk.cancelled_at >= v_stamp
            order by bk.prior_waitlist_position nulls last, bk.created_at, bk.id for update of bk
  loop
    if exists (select 1 from public.bookings x where x.session_id = s.id and x.client_id = b.client_id and x.id <> b.id and x.status in ('booked','waitlisted','checked_in')) then
      v_attention := v_attention || jsonb_build_array(jsonb_build_object('bookingId', b.id, 'clientId', b.client_id, 'name', b.nm, 'reason', 'Already booked into this class again'));
    else
      update public.bookings set status = 'waitlisted', cancelled_at = null, waitlist_position = b.prior_waitlist_position where id = b.id;
      v_ids := v_ids || b.id;
    end if;
  end loop;
  perform app.renumber_waitlist(s.id);
  perform app.promote_waitlist(s.id, v_now);   -- a spare spot goes to the waitlist, as it always would

  select coalesce(jsonb_agg(jsonb_build_object('bookingId', x.id, 'clientId', x.client_id, 'name', trim(c.first_name || ' ' || c.last_name), 'status', x.status)
                            order by x.created_at, x.id), '[]'::jsonb)
    into v_restored
    from public.bookings x join public.clients c on c.id = x.client_id where x.id = any (v_ids);
  perform app.audit('restore_session', 'class_sessions', s.id::text,
    jsonb_build_object('restored', cardinality(v_ids), 'needs_attention', jsonb_array_length(v_attention)));
  return jsonb_build_object('restored', v_restored, 'needsAttention', v_attention);
end $$;

-- ----------------------------------------------------------------------------- void a desk sale made by mistake today
create or replace function public.void_sale(p_sale_id uuid, p_reason text default null, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.sales; v_passes jsonb; v_blocked text; v_used record; v_reason text; r jsonb;
begin
  perform app.assert_in_studio('sales', p_sale_id, 'We couldn''t find that sale.');
  if not (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to void sales.');
  end if;
  select * into s from public.sales where id = p_sale_id for update;
  perform app.assert_studio_open(s.studio_id);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name,
           'classesUsed', (select count(*) from public.bookings b where b.pass_id = p.id and b.status in ('booked','checked_in','no_show','late_cancelled'))) order by p.purchased_at, p.id), '[]'::jsonb)
    into v_passes from public.passes p where p.sale_id = s.id and p.status <> 'cancelled';

  if s.refunded_at is not null then v_blocked := 'This sale has already been refunded or voided.';
  elsif s.method = 'card_online' or s.stripe_payment_intent_id is not null or s.stripe_checkout_session_id is not null or s.stripe_invoice_id is not null then
    v_blocked := 'Card payments can’t be voided. Use Refund so the money goes back to the card.';
  elsif app.local_date(s.created_at) <> app.local_date(app.now()) then
    v_blocked := 'Only sales made today can be voided. For older sales, use Refund.';
  else
    select x ->> 'name' as name, (x ->> 'classesUsed')::int as n into v_used
      from jsonb_array_elements(v_passes) x where (x ->> 'classesUsed')::int > 0 limit 1;
    if found then
      v_blocked := v_used.name || ' has already been used for ' || v_used.n || case when v_used.n = 1 then ' class' else ' classes' end
                   || ', so this sale can’t be voided. Use Refund, or adjust their pass.';
    end if;
  end if;

  if v_blocked is not null and not p_dry_run then perform app.fail('INVALID', v_blocked); end if;
  if v_blocked is not null or p_dry_run then
    return jsonb_build_object('voided', false, 'blocked', v_blocked, 'sale', app.sale_json(s.id), 'passes', v_passes);
  end if;

  v_reason := 'Voided' || case when nullif(trim(p_reason), '') is not null then ': ' || trim(p_reason) else ' (entered by mistake)' end;
  r := public.refund_sale(s.id, null, true, v_reason);   -- full refund: passes cancelled, stock and gift card amounts go back
  perform app.audit('void_sale', 'sales', s.id::text, jsonb_build_object('total_cents', s.total_cents, 'method', s.method, 'reason', p_reason));
  return jsonb_build_object('voided', true, 'sale', r, 'passes', v_passes);
end $$;

revoke execute on function public.undo_no_show, public.undo_cancel_booking, public.waive_penalty, public.restore_session, public.void_sale from public, anon;
grant execute on function public.undo_no_show, public.undo_cancel_booking, public.waive_penalty, public.restore_session, public.void_sale to authenticated;
grant execute on all functions in schema public to service_role;
revoke execute on function app.rejoin_waitlist, app.remember_prior_status, app.remember_session_cancel from public, anon, authenticated;
