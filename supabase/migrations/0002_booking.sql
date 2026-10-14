-- =============================================================================
-- Booking engine (RULES.md "Booking", "Waitlist", "Cancelling", "Check-in").
-- Everything runs inside one transaction per call, with the class row locked
-- (SELECT ... FOR UPDATE) so two people can't grab the last spot at once.
-- Lock order is always: class_sessions row -> the client's passes. Keep it that way.
--
-- Errors: raise 'CODE: friendly message' (SQLSTATE P0001). The app turns CODE into StoreError.code.
-- =============================================================================

-- Monday of the studio week (Mon-Sun, Australia/Sydney) an instant falls in.
create or replace function app.week_start(p_at timestamptz) returns date
language sql stable as $$
  select date_trunc('week', p_at at time zone app.tz())::date
$$;

create or replace function app.local_date(p_at timestamptz) returns date
language sql stable as $$
  select (p_at at time zone app.tz())::date
$$;

-- '6:00am Tue 14 Oct'
create or replace function app.fmt_when(p_at timestamptz) returns text
language sql stable as $$
  select lower(to_char(p_at at time zone app.tz(), 'FMHH12:MIam')) || ' ' || to_char(p_at at time zone app.tz(), 'Dy FMDD Mon')
$$;

-- The expiry a pass has, or would have if it were activated now.
create or replace function app.effective_expiry(p public.passes, p_now timestamptz) returns timestamptz
language sql stable as $$
  select coalesce(p.expires_at,
                  case when p.activated_at is null and p.validity_days is not null
                       then p_now + make_interval(days => p.validity_days) end)
$$;

-- Can this pass be used for a class starting at p_starts (ignoring how many credits are left)?
-- A cancelled membership keeps working until next_billing_at (the end of the period paid for).
create or replace function app.pass_usable(p public.passes, p_starts timestamptz, p_class_type uuid, p_now timestamptz)
returns boolean language sql stable as $$
  select (p.status in ('active','paused')
          or (p.status = 'cancelled' and p.kind = 'membership' and p.next_billing_at is not null
              and p_starts < p.next_billing_at and p_now < p.next_billing_at))
     and (p.class_type_ids is null or cardinality(p.class_type_ids) = 0 or p_class_type = any(p.class_type_ids))
     and (app.effective_expiry(p, p_now) is null
          or (app.effective_expiry(p, p_now) > p_starts and app.effective_expiry(p, p_now) > p_now))
     and not (p.paused_from is not null
              and app.local_date(p_starts) >= p.paused_from
              and (p.paused_until is null or app.local_date(p_starts) <= p.paused_until))
$$;

-- Credits left for a class at p_starts. null = unlimited.
-- Memberships: weekly credits minus bookings that count in that Mon-Sun week
-- (booked, checked in, late cancelled, no-show). Packs: total minus used.
create or replace function app.pass_remaining(p public.passes, p_starts timestamptz)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p.credits is null then null
    when p.kind = 'membership' then p.credits - (
      select count(*)::int from public.bookings b join public.class_sessions s on s.id = b.session_id
       where b.pass_id = p.id
         and b.status in ('booked','checked_in','late_cancelled','no_show')
         and app.week_start(s.starts_at) = app.week_start(p_starts))
    else p.credits - p.credits_used
  end
$$;

-- Best eligible pass (RULES.md priority): unlimited -> membership with weekly credits ->
-- pack/drop-in expiring soonest (not-yet-activated passes count as expiring last).
create or replace function app.best_pass(p_client uuid, p_starts timestamptz, p_class_type uuid, p_now timestamptz)
returns public.passes language sql stable security definer set search_path = public, pg_temp as $$
  select p.* from public.passes p
   where p.client_id = p_client
     and app.pass_usable(p, p_starts, p_class_type, p_now)
     and coalesce(app.pass_remaining(p, p_starts), 1) > 0
   order by case when p.credits is null then 0 when p.kind = 'membership' then 1 else 2 end,
            (p.activated_at is null),
            p.expires_at asc nulls last,
            p.purchased_at asc
   limit 1
$$;

-- Take one credit from a (locked) pass. Activates it on first use.
create or replace function app.apply_credit(p_pass_id uuid, p_now timestamptz) returns public.passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
  select * into p from public.passes where id = p_pass_id for update;
  if p.activated_at is null then
    p.activated_at := p_now;
    if p.expires_at is null and p.validity_days is not null then
      p.expires_at := p_now + make_interval(days => p.validity_days);
    end if;
    if p.kind = 'membership' and p.next_billing_at is null and p.stripe_subscription_id is null then
      p.next_billing_at := p_now + case when p.billing_interval = 'month' then interval '1 month' else interval '7 days' end;
    end if;
  end if;
  if p.kind in ('pack','dropin') and p.credits is not null then
    p.credits_used := p.credits_used + 1;
    if p.credits_used >= p.credits then p.status := 'used_up'; end if;
  end if;
  update public.passes set activated_at = p.activated_at, expires_at = p.expires_at,
         next_billing_at = p.next_billing_at, credits_used = p.credits_used, status = p.status
   where id = p.id;
  return p;
end $$;

-- Give a credit back (cancel in time / studio cancels). Memberships need nothing: the
-- cancelled booking simply stops counting towards that week.
create or replace function app.return_credit(p_pass_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.passes
     set credits_used = greatest(0, credits_used - 1),
         status = case when status = 'used_up' then 'active' else status end
   where id = p_pass_id and kind in ('pack','dropin') and credits is not null;
end $$;

-- Outbox for emails/pushes (drained by the send-email edge function).
create or replace function app.notify(p_booking_id uuid, p_kind text, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select b.id as booking_id, c.id as client_id, c.email, c.first_name, ct.name as class_name, ct.booking_note,
         s.starts_at, s.cancel_reason, st.name as instructor_name, ss.name as studio_name, ss.address,
         ss.cancellation_policy_text, ss.waitlist_policy_text
    into r
    from public.bookings b
    join public.clients c on c.id = b.client_id
    join public.class_sessions s on s.id = b.session_id
    join public.class_types ct on ct.id = s.class_type_id
    left join public.staff st on st.id = s.instructor_id
    cross join public.studio_settings ss
   where b.id = p_booking_id;
  if r.booking_id is null or coalesce(r.email, '') = '' then return; end if;
  insert into public.notifications (client_id, kind, to_email, payload)
  values (r.client_id, p_kind, r.email, jsonb_build_object(
    'booking_id', r.booking_id, 'first_name', r.first_name, 'class_name', r.class_name,
    'starts_at', r.starts_at, 'when', app.fmt_when(r.starts_at), 'instructor', r.instructor_name,
    'studio_name', r.studio_name, 'address', r.address, 'booking_note', r.booking_note,
    'cancellation_policy', r.cancellation_policy_text, 'waitlist_policy', r.waitlist_policy_text,
    'cancel_reason', r.cancel_reason) || p_extra);
end $$;

create or replace function app.booking_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(b) - 'reminder_sent_at' - 'updated_at' from public.bookings b where b.id = p_id
$$;

create or replace function app.pass_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(p) || jsonb_build_object('adjustments', coalesce((
           select jsonb_agg(to_jsonb(a) order by a.at) from public.pass_adjustments a where a.pass_id = p.id), '[]'::jsonb))
    from public.passes p where p.id = p_id
$$;

-- Can the current user act as staff on this class? (owner/manager/front desk: any class;
-- instructor: only classes they teach). Privileged contexts (SQL editor, service role) always can.
create or replace function app.can_staff_session(p_session public.class_sessions) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_privileged()
      or public.has_role('owner','manager','front_desk')
      or (public.has_role('instructor') and p_session.instructor_id = public.current_staff_id())
$$;

-- ----------------------------------------------------------------------------- waitlist

-- Fill free spots from the waitlist, in order, skipping anyone without an eligible credit.
-- Stops 1h before class (waitlist_cutoff_hours): later spots stay open, the waitlist stays put.
-- Internal: not callable through the API. Returns the promoted bookings.
create or replace function app.promote_waitlist(p_session_id uuid, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, app.now());
  s public.class_sessions;
  v_cutoff numeric;
  v_booked int;
  w record;
  p public.passes;
  v_out jsonb := '[]'::jsonb;
begin
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null or s.status <> 'scheduled' then return v_out; end if;
  select waitlist_cutoff_hours into v_cutoff from public.studio_settings where id = 1;
  if v_now >= s.starts_at - make_interval(secs => coalesce(v_cutoff, 1) * 3600) then return v_out; end if;

  for w in select * from public.bookings
            where session_id = s.id and status = 'waitlisted'
            order by waitlist_position nulls last, created_at
            for update
  loop
    select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');
    exit when v_booked >= s.capacity;
    perform 1 from public.passes where client_id = w.client_id for update;
    p := app.best_pass(w.client_id, s.starts_at, s.class_type_id, v_now);
    continue when p.id is null;
    p := app.apply_credit(p.id, v_now);
    update public.bookings set status = 'booked', pass_id = p.id, promoted_from_waitlist_at = v_now,
           waitlist_position = null
     where id = w.id;
    perform app.notify(w.id, 'waitlist_promoted');
    perform app.audit('promote_waitlist', 'bookings', w.id::text, jsonb_build_object('pass_id', p.id));
    v_out := v_out || jsonb_build_array(app.booking_json(w.id));
  end loop;
  return v_out;
end $$;

-- Bigger class = maybe room for the waitlist.
create or replace function app.on_capacity_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.promote_waitlist(new.id, app.now());
  return null;
end $$;
create trigger sessions_capacity_up after update of capacity on public.class_sessions
  for each row when (new.capacity > old.capacity) execute function app.on_capacity_change();

-- ----------------------------------------------------------------------------- book

create or replace function public.book_class(
  p_session_id uuid,
  p_pass_id uuid default null,
  p_client_id uuid default null,
  p_as_staff boolean default false,
  p_allow_over_capacity boolean default false,
  p_skip_credit boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  v_client uuid;
  v_staff uuid := public.current_staff_id();
  s public.class_sessions;
  ct public.class_types;
  c public.clients;
  st public.studio_settings;
  p public.passes;
  v_booked int;
  v_pos int;
  b_id uuid;
begin
  select * into st from public.studio_settings where id = 1;

  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  select * into ct from public.class_types where id = s.class_type_id;

  if p_as_staff then
    if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to book clients into this class.'); end if;
    v_client := p_client_id;
    if v_client is null then perform app.fail('NOT_FOUND', 'Choose a client to book.'); end if;
  else
    v_client := public.current_client_id();
    if v_client is null then perform app.fail('NOT_ALLOWED', 'Please sign in to book.'); end if;
    if p_client_id is not null and p_client_id <> v_client then perform app.fail('NOT_ALLOWED', 'You can only book for yourself.'); end if;
    if p_allow_over_capacity or p_skip_credit then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  end if;

  select * into c from public.clients where id = v_client;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;

  if s.status = 'cancelled' then perform app.fail('NOT_ALLOWED', 'This class has been cancelled.'); end if;

  if p_as_staff then
    if v_now >= s.ends_at then perform app.fail('TOO_LATE', 'This class has already finished.'); end if;
  else
    if v_now >= s.starts_at then perform app.fail('TOO_LATE', 'This class has already started.'); end if;
    if not ct.bookable or not ct.active then perform app.fail('NOT_ALLOWED', 'This class isn''t open for booking yet.'); end if;
    if app.local_date(s.starts_at) > app.local_date(v_now) + st.booking_window_days then
      perform app.fail('NOT_ALLOWED', format('Bookings open %s days before class.', st.booking_window_days));
    end if;
    if c.waiver_signed_at is null then
      perform app.fail('WAIVER_REQUIRED', 'Please sign the waiver and health form before your first booking.');
    end if;
  end if;

  if exists (select 1 from public.bookings where session_id = s.id and client_id = v_client
               and status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'You''re already booked into this class.');
  end if;

  select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');

  -- Full: join the waitlist, no credit taken.
  if v_booked >= s.capacity and not p_allow_over_capacity then
    select coalesce(max(waitlist_position), 0) + 1 into v_pos from public.bookings
     where session_id = s.id and status = 'waitlisted';
    insert into public.bookings (session_id, client_id, status, waitlist_position, source, booked_by_staff_id)
    values (s.id, v_client, 'waitlisted', v_pos, case when p_as_staff then 'staff' else 'client' end,
            case when p_as_staff then v_staff end)
    returning id into b_id;
    return jsonb_build_object('outcome', 'waitlisted', 'booking', app.booking_json(b_id), 'pass', null);
  end if;

  perform 1 from public.passes where client_id = v_client for update;

  if p_skip_credit then
    p := null;
  elsif p_pass_id is not null then
    select * into p from public.passes where id = p_pass_id and client_id = v_client;
    if p.id is null or not app.pass_usable(p, s.starts_at, s.class_type_id, v_now)
       or coalesce(app.pass_remaining(p, s.starts_at), 1) <= 0 then
      perform app.fail('NO_CREDITS', 'That pass can''t be used for this class.');
    end if;
  else
    p := app.best_pass(v_client, s.starts_at, s.class_type_id, v_now);
    if p.id is null then perform app.fail('NO_CREDITS', 'You need a class pass to book this class.'); end if;
  end if;

  if p.id is not null then p := app.apply_credit(p.id, v_now); end if;

  insert into public.bookings (session_id, client_id, status, pass_id, source, booked_by_staff_id)
  values (s.id, v_client, 'booked', p.id, case when p_as_staff then 'staff' else 'client' end,
          case when p_as_staff then v_staff end)
  returning id into b_id;

  perform app.notify(b_id, 'booking_confirmed');
  if p_as_staff then
    perform app.audit('book_class', 'bookings', b_id::text,
      jsonb_build_object('over_capacity', p_allow_over_capacity, 'skip_credit', p_skip_credit));
  end if;

  return jsonb_build_object('outcome', 'booked', 'booking', app.booking_json(b_id),
                            'pass', case when p.id is not null then app.pass_json(p.id) end);
end $$;

-- ----------------------------------------------------------------------------- cancel

create or replace function public.cancel_booking(
  p_booking_id uuid,
  p_waive_penalty boolean default false,
  p_as_staff boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  b public.bookings;
  s public.class_sessions;
  v_window numeric;
  v_late boolean;
  v_returned boolean := false;
  v_promoted jsonb;
  v_sid uuid;
begin
  select session_id into v_sid from public.bookings where id = p_booking_id;
  if v_sid is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into s from public.class_sessions where id = v_sid for update;
  select * into b from public.bookings where id = p_booking_id for update;

  if p_as_staff then
    if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to change this booking.'); end if;
  else
    if b.client_id is distinct from public.current_client_id() then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
    if p_waive_penalty then perform app.fail('NOT_ALLOWED', 'Only staff can waive the cancellation policy.'); end if;
  end if;

  if b.status = 'waitlisted' then
    update public.bookings set status = 'removed', cancelled_at = v_now, waitlist_position = null where id = b.id;
    return jsonb_build_object('booking', app.booking_json(b.id), 'creditReturned', false, 'lateCancel', false, 'promoted', null);
  end if;

  if not (b.status = 'booked' or (p_as_staff and b.status in ('checked_in','no_show'))) then
    perform app.fail('NOT_ALLOWED', 'This booking can''t be cancelled.');
  end if;
  if not p_as_staff and v_now >= s.starts_at then
    perform app.fail('TOO_LATE', 'This class has already started.');
  end if;

  select cancel_window_hours into v_window from public.studio_settings where id = 1;
  v_late := v_now > s.starts_at - make_interval(secs => coalesce(v_window, 3) * 3600);

  if v_late and not p_waive_penalty then
    update public.bookings set status = 'late_cancelled', cancelled_at = v_now where id = b.id;
  else
    update public.bookings set status = 'cancelled', cancelled_at = v_now where id = b.id;
    -- A no-show pack credit was already spent; giving it back is the same as a cancel.
    if b.pass_id is not null then perform app.return_credit(b.pass_id); end if;
    v_returned := true;
  end if;

  if p_as_staff then
    perform app.audit('cancel_booking', 'bookings', b.id::text,
      jsonb_build_object('waived', p_waive_penalty, 'late', v_late, 'from_status', b.status));
  end if;

  v_promoted := app.promote_waitlist(s.id, v_now);

  return jsonb_build_object('booking', app.booking_json(b.id), 'creditReturned', v_returned,
    'lateCancel', v_late and not p_waive_penalty, 'promoted', v_promoted -> 0);
end $$;

create or replace function public.leave_waitlist(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; s public.class_sessions;
begin
  select * into b from public.bookings where id = p_booking_id for update;
  if b.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into s from public.class_sessions where id = b.session_id;
  if b.client_id is distinct from public.current_client_id() and not app.can_staff_session(s) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that booking.');
  end if;
  if b.status <> 'waitlisted' then perform app.fail('NOT_ALLOWED', 'You''re not on the waitlist for this class.'); end if;
  update public.bookings set status = 'removed', cancelled_at = app.now(), waitlist_position = null where id = b.id;
  return app.booking_json(b.id);
end $$;

-- Staff: move a booking to another class. The credit moves with it (old one returned, new one taken
-- from the same pass if it can be used, otherwise the best pass). CLASS_FULL if there's no room.
create or replace function public.move_booking(p_booking_id uuid, p_to_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.bookings; s_from public.class_sessions; s_to public.class_sessions; v_booked int; v_res jsonb; v_pass uuid;
  p public.passes;
begin
  select * into b from public.bookings where id = p_booking_id;
  if b.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  -- lock both classes in a fixed order so two moves can't deadlock
  perform 1 from public.class_sessions where id in (b.session_id, p_to_session_id) order by id for update;
  select * into s_from from public.class_sessions where id = b.session_id;
  select * into s_to from public.class_sessions where id = p_to_session_id;
  if s_to.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if not app.can_staff_session(s_from) or not app.can_staff_session(s_to) then
    perform app.fail('NOT_ALLOWED', 'You can only move bookings between classes you manage.');
  end if;
  select * into b from public.bookings where id = p_booking_id for update;
  if b.status not in ('booked','waitlisted') then perform app.fail('NOT_ALLOWED', 'Only upcoming bookings can be moved.'); end if;
  if b.session_id = s_to.id then perform app.fail('ALREADY_BOOKED', 'They''re already in that class.'); end if;
  select count(*) into v_booked from public.bookings where session_id = s_to.id and status in ('booked','checked_in');
  if b.status = 'booked' and v_booked >= s_to.capacity then perform app.fail('CLASS_FULL', 'That class is full.'); end if;

  update public.bookings set status = 'cancelled', cancelled_at = app.now(), waitlist_position = null where id = b.id;
  if b.status = 'booked' and b.pass_id is not null then perform app.return_credit(b.pass_id); end if;

  -- keep using the same pass when it's valid for the new class
  v_pass := null;
  if b.pass_id is not null then
    select * into p from public.passes where id = b.pass_id;
    if app.pass_usable(p, s_to.starts_at, s_to.class_type_id, app.now()) and coalesce(app.pass_remaining(p, s_to.starts_at), 1) > 0 then
      v_pass := p.id;
    end if;
  end if;
  v_res := public.book_class(s_to.id, v_pass, b.client_id, true, false, b.status = 'booked' and b.pass_id is null);
  perform app.promote_waitlist(s_from.id, app.now());
  perform app.audit('move_booking', 'bookings', b.id::text, jsonb_build_object('to_session', s_to.id, 'new_booking', v_res -> 'booking' ->> 'id'));
  return v_res;
end $$;

-- ----------------------------------------------------------------------------- check-in

create or replace function app.staff_booking_for_update(p_booking_id uuid) returns public.bookings
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; s public.class_sessions;
begin
  select * into b from public.bookings where id = p_booking_id for update;
  if b.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into s from public.class_sessions where id = b.session_id;
  if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to check in this class.'); end if;
  return b;
end $$;

create or replace function public.check_in(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id);
begin
  if b.status = 'waitlisted' then perform app.fail('NOT_ALLOWED', 'They''re on the waitlist. Book them in first.'); end if;
  if b.status not in ('booked','no_show','checked_in') then perform app.fail('NOT_ALLOWED', 'This booking was cancelled.'); end if;
  update public.bookings set status = 'checked_in', checked_in_at = coalesce(checked_in_at, app.now()) where id = b.id;
  return app.booking_json(b.id);
end $$;

create or replace function public.undo_check_in(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id);
begin
  if b.status <> 'checked_in' then perform app.fail('NOT_ALLOWED', 'They aren''t checked in.'); end if;
  update public.bookings set status = 'booked', checked_in_at = null where id = b.id;
  return app.booking_json(b.id);
end $$;

create or replace function public.mark_no_show(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id);
begin
  if b.status not in ('booked','no_show') then perform app.fail('NOT_ALLOWED', 'Only booked clients can be marked as a no-show.'); end if;
  update public.bookings set status = 'no_show' where id = b.id;
  return app.booking_json(b.id);
end $$;

-- "Mark rest as no-show" in one go. Returns how many were marked.
create or replace function public.mark_rest_no_show(p_session_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.class_sessions; n int;
begin
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to change this class.'); end if;
  update public.bookings set status = 'no_show' where session_id = s.id and status = 'booked';
  get diagnostics n = row_count;
  return n;
end $$;

-- ----------------------------------------------------------------------------- schedule

-- Studio cancels a class: bookings -> removed, credits back, waitlist cleared, everyone told.
create or replace function public.cancel_session(p_session_id uuid, p_reason text default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.class_sessions; b record; n int := 0;
begin
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if not (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to cancel classes.');
  end if;
  if s.status = 'cancelled' then return 0; end if;
  update public.class_sessions set status = 'cancelled', cancel_reason = p_reason where id = s.id;
  for b in select * from public.bookings where session_id = s.id and status in ('booked','checked_in','waitlisted','no_show') for update loop
    perform 1 from public.passes where client_id = b.client_id for update;
    if b.status <> 'waitlisted' and b.pass_id is not null then perform app.return_credit(b.pass_id); end if;
    update public.bookings set status = 'removed', cancelled_at = app.now(), waitlist_position = null where id = b.id;
    perform app.notify(b.id, 'class_cancelled');
    n := n + 1;
  end loop;
  perform app.audit('cancel_session', 'class_sessions', s.id::text, jsonb_build_object('reason', p_reason, 'bookings', n));
  return n;
end $$;

-- Create classes from the weekly templates for studio dates from..to (inclusive). Idempotent.
create or replace function public.generate_sessions(p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_tz text := app.tz();
begin
  if not (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to change the schedule.');
  end if;
  if p_to < p_from then return 0; end if;
  if p_to - p_from > 400 then perform app.fail('NOT_ALLOWED', 'Please generate at most about a year at a time.'); end if;

  insert into public.class_sessions (class_type_id, template_id, template_date, starts_at, ends_at, instructor_id, capacity)
  select t.class_type_id, t.id, d::date,
         ((d::date + t.start_time) at time zone v_tz),
         ((d::date + t.start_time) at time zone v_tz) + make_interval(mins => ct.duration_min),
         t.instructor_id, coalesce(t.capacity, ct.default_capacity)
    from public.schedule_templates t
    join public.class_types ct on ct.id = t.class_type_id
    cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
   where t.active and ct.active
     and extract(dow from d) = t.weekday
     and d::date >= t.starts_on
     and (t.ends_on is null or d::date <= t.ends_on)
  on conflict (template_id, template_date) where template_id is not null and template_date is not null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ----------------------------------------------------------------------------- reads

-- What a client can book with (optionally: for one class, counting that class's week).
create or replace function public.credit_summary(p_client_id uuid, p_session_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  s public.class_sessions;
  v_at timestamptz;
  p public.passes;
  v_rem int;
  v_out jsonb := '[]'::jsonb;
  v_label text;
begin
  if not (app.is_privileged() or p_client_id = public.current_client_id() or public.has_role('owner','manager','front_desk','instructor')) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  if p_session_id is not null then
    select * into s from public.class_sessions where id = p_session_id;
    if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  end if;
  v_at := coalesce(s.starts_at, v_now);

  for p in select * from public.passes where client_id = p_client_id
              and (status in ('active','paused')
                   or (status = 'cancelled' and kind = 'membership' and next_billing_at > v_now))
           order by case when credits is null then 0 when kind = 'membership' then 1 else 2 end,
                    (activated_at is null), expires_at nulls last, purchased_at
  loop
    if s.id is not null then
      continue when not app.pass_usable(p, s.starts_at, s.class_type_id, v_now);
    else
      continue when app.effective_expiry(p, v_now) is not null and app.effective_expiry(p, v_now) <= v_now;
    end if;
    v_rem := app.pass_remaining(p, v_at);
    continue when s.id is not null and v_rem is not null and v_rem <= 0;
    continue when s.id is null and p.kind <> 'membership' and v_rem is not null and v_rem <= 0;
    v_label := case
      when s.id is null and p.paused_from is not null and p.paused_from <= app.local_date(v_now)
           and (p.paused_until is null or p.paused_until >= app.local_date(v_now))
        then 'Paused' || coalesce(' until ' || to_char(p.paused_until, 'Dy FMDD Mon'), '')
      when v_rem is null then 'Unlimited'
      when p.kind = 'membership' then format('%s of %s left this week', greatest(v_rem, 0), p.credits)
      else format('%s of %s left', v_rem, p.credits) end;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'pass', app.pass_json(p.id), 'remaining', case when v_rem is null then null else greatest(v_rem, 0) end,
      'label', v_label,
      'expiresAt', case when p.status = 'cancelled' and p.kind = 'membership' then p.next_billing_at else p.expires_at end));
  end loop;
  return v_out;
end $$;

create or replace function public.is_intro_eligible(p_client_id uuid default null) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_client uuid := coalesce(p_client_id, public.current_client_id());
begin
  if v_client is null then return true; end if;  -- not signed up yet = new client
  if not (app.is_privileged() or v_client = public.current_client_id() or public.is_staff()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  return not exists (select 1 from public.clients where id = v_client and intro_ineligible)
     and not exists (select 1 from public.passes where client_id = v_client);
end $$;

-- Roster for check-in: booked/checked-in/no-show first, then waitlist in order, then late cancels.
create or replace function public.get_roster(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s public.class_sessions;
  v_notes boolean := app.is_privileged() or public.has_role('owner','manager','front_desk');
  v_week date;
begin
  select * into s from public.class_sessions where id = p_session_id;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You can only see rosters for your own classes.'); end if;
  v_week := app.week_start(s.starts_at);

  return coalesce((
    select jsonb_agg(entry order by grp, sort1 nulls last, created_at)
    from (
      select
        (to_jsonb(b) - 'reminder_sent_at' - 'updated_at') || jsonb_build_object(
          'client', (to_jsonb(c) - 'intro_ineligible' - 'momence_id' - 'user_id')
                    || case when v_notes then jsonb_build_object('staff_notes', (select n.notes from public.client_notes n where n.client_id = c.id)) else '{}'::jsonb end,
          'pass', case when p.id is not null then to_jsonb(p) end,
          'flags', to_jsonb(array_remove(array[
             case when not exists (select 1 from public.bookings ob join public.class_sessions os on os.id = ob.session_id
                                    where ob.client_id = c.id and ob.status = 'checked_in' and os.starts_at < s.starts_at)
                  then 'first_class' end,
             case when c.waiver_signed_at is null then 'no_waiver' end,
             case when coalesce(nullif(trim(c.injuries), ''), nullif(trim(c.health_form ->> 'injuries'), '')) is not null then 'injury' end,
             case when c.birthday is not null and exists (
                    select 1 from generate_series(v_week, v_week + 6, interval '1 day') d
                     where extract(month from d) = extract(month from c.birthday) and extract(day from d) = extract(day from c.birthday))
                  then 'birthday' end,
             case when p.id is not null and p.kind in ('pack','dropin') and p.credits is not null
                       and b.status in ('booked','checked_in') and p.credits - p.credits_used <= 0 then 'last_credit' end,
             case when p.id is not null and p.expires_at is not null and p.expires_at > s.starts_at
                       and p.expires_at <= s.starts_at + interval '7 days' then 'pass_expiring' end
          ]::text[], null))
        ) as entry,
        case when b.status in ('booked','checked_in','no_show') then 0 when b.status = 'waitlisted' then 1 else 2 end as grp,
        b.waitlist_position as sort1,
        b.created_at
      from public.bookings b
      join public.clients c on c.id = b.client_id
      left join public.passes p on p.id = b.pass_id
      where b.session_id = s.id and b.status in ('booked','checked_in','no_show','waitlisted','late_cancelled')
    ) x), '[]'::jsonb);
end $$;

-- A client's bookings with class details. when: 'upcoming' | 'past' | 'all'.
create or replace function public.list_client_bookings(p_client_id uuid, p_when text default 'all', p_statuses text[] default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now();
begin
  if not (app.is_privileged() or p_client_id = public.current_client_id() or public.is_staff()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  return coalesce((
    select jsonb_agg(
      (to_jsonb(b) - 'reminder_sent_at' - 'updated_at') || jsonb_build_object(
        'session', to_jsonb(sw), 'class_type', to_jsonb(ct),
        'instructor', (select to_jsonb(sp) from public.staff_public sp where sp.id = sw.instructor_id))
      order by case when p_when = 'past' then null else sw.starts_at end asc,
               case when p_when = 'past' then sw.starts_at end desc)
    from public.bookings b
    join public.sessions_with_counts sw on sw.id = b.session_id
    join public.class_types ct on ct.id = sw.class_type_id
    where b.client_id = p_client_id
      and (p_statuses is null or b.status = any(p_statuses))
      and (p_when = 'all' or (p_when = 'upcoming' and sw.starts_at >= v_now) or (p_when = 'past' and sw.starts_at < v_now))
  ), '[]'::jsonb);
end $$;

-- Client (or staff) records the waiver + health form.
create or replace function public.submit_waiver(p_client_id uuid, p_health jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now();
begin
  if not (app.is_privileged() or p_client_id = public.current_client_id() or public.is_staff()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  update public.clients
     set health_form = coalesce(p_health, '{}'::jsonb) || jsonb_build_object('submittedAt', v_now),
         waiver_signed_at = v_now,
         injuries = coalesce(nullif(trim(p_health ->> 'injuries'), ''), injuries)
   where id = p_client_id;
  if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;
  return (select to_jsonb(c) - 'intro_ineligible' - 'momence_id' from public.clients c where id = p_client_id);
end $$;

-- ----------------------------------------------------------------------------- grants
-- Supabase lets anon/authenticated execute new functions by default. Lock the internals away.
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.now(), app.tz(), app.is_privileged() to anon, authenticated;
revoke execute on function public.book_class, public.move_booking, public.cancel_booking, public.leave_waitlist, public.check_in,
  public.undo_check_in, public.mark_no_show, public.mark_rest_no_show, public.cancel_session,
  public.generate_sessions, public.credit_summary, public.get_roster, public.list_client_bookings,
  public.submit_waiver from public, anon;
grant execute on function public.book_class, public.move_booking, public.cancel_booking, public.leave_waitlist, public.check_in,
  public.undo_check_in, public.mark_no_show, public.mark_rest_no_show, public.cancel_session,
  public.generate_sessions, public.credit_summary, public.get_roster, public.list_client_bookings,
  public.submit_waiver to authenticated, service_role;
