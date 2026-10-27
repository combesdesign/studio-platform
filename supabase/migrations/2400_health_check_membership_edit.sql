-- =============================================================================
-- Libby's feedback (27 Oct): a lighter booking flow, and owners can edit memberships.
--
--  1. Health step policies, per studio (Settings > Policies): long health form for first-timers on/off; quick health check for
--     returning clients on/off + every N days (default 30).
--  2. clients.health_checked_at (last time they answered the quick check) and clients.health_update ({ note, at }: the latest
--     "yes, something's changed"). submit_health_check() stamps the first, and on a yes appends a dated line to injuries and sets the
--     second. get_roster then flags 'health_update' until the client has been checked in to a class since.
--  3. Membership edits (owner / manager only): edit_membership_date() and change_membership(). The edit-membership edge function
--     moves the Stripe subscription first and then calls these (as the signed-in person, so the audit trail names them). Moving to
--     another membership "from the next cycle" is kept in passes.pending_change and applied by a trigger when a renewal moves
--     next_billing_at forward (the invoice.paid webhook), so the renewal charge and the weekly allowance change together.
-- =============================================================================

alter table public.studio_settings add column long_health_form_first_timers boolean not null default true;
alter table public.studio_settings add column quick_health_check boolean not null default true;
alter table public.studio_settings add column quick_health_check_days integer not null default 30 check (quick_health_check_days between 1 and 365);

alter table public.clients add column health_checked_at timestamptz;
alter table public.clients add column health_update jsonb;
alter table public.passes add column pending_change jsonb;

-- A throwaway helper (0010 dropped its copy): rewrite part of an existing function, failing loudly if the text isn't found.
create function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;

-- Clients can't write these themselves (submit_health_check does): same rule as the waiver and health form.
select app.patch_function('app.guard_client()'::regprocedure,
  $q$new.health_form := old.health_form;$q$,
  $q$new.health_form := old.health_form;
  new.health_checked_at := old.health_checked_at;
  new.health_update := old.health_update;$q$);

-- ----------------------------------------------------------------------------- quick health check
-- p_changes false: just stamp it. p_changes true: also needs a note, which is added to injuries with the date and flagged on rosters.
create or replace function public.submit_health_check(p_client_id uuid, p_changes boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_line text;
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  if not (app.is_privileged() or p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id) or public.is_staff()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  if coalesce(p_changes, false) and v_note is null then perform app.fail('INVALID', 'Tell us a little about what''s changed.'); end if;
  if coalesce(p_changes, false) then
    v_line := to_char(app.local_date(v_now), 'FMDD Mon YYYY') || ': ' || v_note;
    update public.clients
       set health_checked_at = v_now,
           health_update = jsonb_build_object('note', v_note, 'at', v_now),
           injuries = case when nullif(trim(coalesce(injuries, '')), '') is null then v_line else trim(injuries) || E'\n' || v_line end
     where id = p_client_id;
  else
    update public.clients set health_checked_at = v_now where id = p_client_id;
  end if;
  if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;
  return (select to_jsonb(c) - 'intro_ineligible' - 'momence_id' from public.clients c where id = p_client_id);
end $$;

-- Roster flag: they told us about a health change and haven't been checked in to a class since (and it was before this class).
select app.patch_function('app.get_roster_impl(uuid)'::regprocedure,
  $q$case when c.waiver_signed_at is null then 'no_waiver' end,$q$,
  $q$case when c.waiver_signed_at is null then 'no_waiver' end,
             case when c.health_update is not null and (c.health_update ->> 'at')::timestamptz <= s.starts_at
                       and not exists (select 1 from public.bookings ob join public.class_sessions os on os.id = ob.session_id
                                        where ob.client_id = c.id and ob.status = 'checked_in'
                                          and os.starts_at < s.starts_at and os.starts_at > (c.health_update ->> 'at')::timestamptz)
                  then 'health_update' end,$q$);

drop function app.patch_function(regprocedure, text, text);

-- ----------------------------------------------------------------------------- membership edits
create or replace function app.membership_for_edit(p_pass_id uuid) returns public.passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
  perform app.assert_in_studio('passes', p_pass_id, 'We couldn''t find that membership.');
  if not (app.is_privileged() or public.has_role('owner', 'manager')) then
    perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can edit a membership.');
  end if;
  select * into p from public.passes where id = p_pass_id for update;
  if p.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that membership.'); end if;
  if p.kind <> 'membership' or p.status in ('cancelled', 'expired') then
    perform app.fail('INVALID', 'Only a membership that''s still billing can be edited.');
  end if;
  return p;
end $$;

-- Move the next billing date (the edit-membership function has already moved the Stripe subscription).
create or replace function public.edit_membership_date(p_pass_id uuid, p_next_billing_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.membership_for_edit(p_pass_id); v_today date := app.local_date(app.now());
begin
  if p_next_billing_at is null or app.local_date(p_next_billing_at) <= v_today or app.local_date(p_next_billing_at) > v_today + 60 then
    perform app.fail('INVALID', 'Pick a renewal date after today and within the next 60 days.');
  end if;
  update public.passes
     set next_billing_at = p_next_billing_at,
         pending_change = case when pending_change is null then null else pending_change || jsonb_build_object('effectiveAt', p_next_billing_at) end
   where id = p.id;
  insert into public.pass_adjustments (pass_id, staff_id, delta, reason)
  values (p.id, public.current_staff_id(), 0,
          format('Renewal date moved%s to %s. No charge in between.',
                 case when p.next_billing_at is null then '' else ' from ' || app.local_date(p.next_billing_at)::text end,
                 app.local_date(p_next_billing_at)::text));
  perform app.audit('membership_renewal_date', 'passes', p.id::text,
    jsonb_build_object('client_id', p.client_id, 'from', p.next_billing_at, 'to', p_next_billing_at));
  return app.pass_json(p.id);
end $$;

-- Move to another membership. The Stripe price is already swapped. p_immediately: credits + allowance switch now, else at the next
-- billing date (pending_change). p_proration_cents is what Stripe charged (+) or credited (-), for the history only.
create or replace function public.change_membership(p_pass_id uuid, p_product_id uuid, p_immediately boolean default false, p_proration_cents integer default 0)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.membership_for_edit(p_pass_id); pr public.products; v_line text;
begin
  perform app.assert_in_studio('products', p_product_id, 'We couldn''t find that membership.');
  select * into pr from public.products where id = p_product_id;
  if pr.id is null or pr.kind <> 'membership' or not pr.active then perform app.fail('INVALID', 'Choose one of the studio''s current memberships.'); end if;
  if coalesce(pr.billing_interval, 'week') <> coalesce(p.billing_interval, 'week') then
    perform app.fail('INVALID', 'That membership bills on a different schedule, so it can''t be swapped in.');
  end if;
  if pr.id = p.product_id then perform app.fail('INVALID', 'They''re already on that membership.'); end if;
  v_line := format('Moved from %s to %s', p.name, pr.name);
  if coalesce(p_immediately, false) then
    update public.passes
       set product_id = pr.id, name = pr.name, credits = pr.credits, price_cents = pr.price_cents, class_type_ids = pr.class_type_ids,
           no_classes = pr.no_classes, family_shareable = pr.family_shareable, pending_change = null
     where id = p.id;
    v_line := v_line || ', credits and allowance switched straight away';
  else
    update public.passes
       set pending_change = jsonb_build_object('productId', pr.id, 'name', pr.name, 'credits', pr.credits, 'priceCents', pr.price_cents,
                                               'effectiveAt', coalesce(p.next_billing_at, app.now()))
     where id = p.id;
    v_line := v_line || ', credits and allowance switch from ' || coalesce(app.local_date(p.next_billing_at)::text, 'the next cycle');
  end if;
  v_line := v_line || case
    when coalesce(p_proration_cents, 0) > 0 then format('; charged the $%s difference', to_char(p_proration_cents / 100.0, 'FM999990.00'))
    when coalesce(p_proration_cents, 0) < 0 then format('; $%s credited to their account', to_char(-p_proration_cents / 100.0, 'FM999990.00'))
    else '; no charge or credit for the change' end;
  insert into public.pass_adjustments (pass_id, staff_id, delta, reason) values (p.id, public.current_staff_id(), 0, v_line || '.');
  perform app.audit('membership_change', 'passes', p.id::text,
    jsonb_build_object('client_id', p.client_id, 'from_product', p.product_id, 'to_product', pr.id, 'immediately', coalesce(p_immediately, false), 'proration_cents', coalesce(p_proration_cents, 0)));
  return app.pass_json(p.id);
end $$;

-- A renewal (next_billing_at moves forward after the old date has passed) makes a pending move take effect.
-- Moving the date by hand (edit_membership_date) happens before the old date, so it never triggers this.
create or replace function app.apply_pending_membership() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr public.products; v_pid uuid;
begin
  if new.pending_change is null or old.next_billing_at is null or new.next_billing_at is null then return new; end if;
  if not (new.next_billing_at > old.next_billing_at and old.next_billing_at <= app.now()) then return new; end if;
  v_pid := (new.pending_change ->> 'productId')::uuid;
  select * into pr from public.products where id = v_pid;
  if pr.id is not null then
    new.product_id := pr.id; new.name := pr.name; new.credits := pr.credits; new.price_cents := pr.price_cents;
    new.class_type_ids := pr.class_type_ids; new.no_classes := pr.no_classes; new.family_shareable := pr.family_shareable;
  else
    new.product_id := v_pid; new.name := coalesce(new.pending_change ->> 'name', new.name);
    new.credits := (new.pending_change ->> 'credits')::int; new.price_cents := coalesce((new.pending_change ->> 'priceCents')::int, new.price_cents);
  end if;
  new.pending_change := null;
  insert into public.pass_adjustments (pass_id, staff_id, delta, reason) values (new.id, null, 0, format('Now on %s (from %s).', new.name, app.local_date(old.next_billing_at)::text));
  return new;
end $$;
create trigger apply_pending_membership before update of next_billing_at on public.passes
  for each row execute function app.apply_pending_membership();

revoke execute on function app.membership_for_edit(uuid), app.apply_pending_membership() from public, anon, authenticated;
revoke execute on function public.submit_health_check(uuid, boolean, text), public.edit_membership_date(uuid, timestamptz), public.change_membership(uuid, uuid, boolean, integer) from public, anon;
grant execute on function public.submit_health_check(uuid, boolean, text), public.edit_membership_date(uuid, timestamptz), public.change_membership(uuid, uuid, boolean, integer) to authenticated, service_role;
