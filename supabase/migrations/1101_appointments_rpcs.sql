-- Appointments (ROADMAP B1): the rules. Slot generation, booking, cancelling, packs, workshops / courses / events.
--
-- Same pattern as the core: security-definer RPCs in `public`, helpers in `app`, errors raised as 'CODE: friendly message'
-- (app.fail) so the apps can show them. The studio is the one in the x-studio header (app.current_studio_id()); ids passed in are
-- checked to belong to it (app.assert_in_studio).
-- The rules mirror src/features/appointments/logic.ts and demo.ts; supabase/tests/appointments_rpcs.sql checks the same cases
-- as tests/appointments.test.ts.
--
-- Money: every payment is a core sale (public.sales + sale_items, kind null so it reports as "retail"), so receipts, reports and
-- refunds just work. Pack credits are our own rows (appointment_credits), not core passes.
-- Clients never record a card payment themselves: online payment goes through 1102 (a held slot, Stripe Checkout, then the
-- webhook completes it). Clients can book with pack credits, and free events, directly.

-- ----------------------------------------------------------------------------- small helpers

create or replace function app.ap_iso(p_at timestamptz) returns text
language sql immutable as $$ select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Settings with the defaults when the studio hasn't saved any (matches DEFAULT_SETTINGS in logic.ts).
create or replace function app.ap_settings(p_studio uuid) returns public.appointment_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select s from public.appointment_settings s where s.studio_id = p_studio),
    row(p_studio, 30, 4, 28)::public.appointment_settings)
$$;

-- Who is calling. A person who is both staff and a client acts as a client unless they name a different client.
create type app.ap_actor_t as (studio uuid, staff_id uuid, role text, client_id uuid, as_staff boolean);

create or replace function app.ap_actor(p_client uuid default null) returns app.ap_actor_t
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t;
begin
  v.studio := app.current_studio_id();
  v.staff_id := public.current_staff_id();
  v.role := public.staff_role();
  v.client_id := public.current_client_id();
  if v.staff_id is null and v.client_id is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  v.as_staff := v.staff_id is not null and (v.client_id is null or (p_client is not null and p_client <> v.client_id));
  return v;
end $$;

-- view = any staff, book = front desk and above, manage = owner / manager (mirrors permissions.ts)
create or replace function app.ap_can(p_actor app.ap_actor_t, p_what text) returns boolean
language sql immutable as $$
  select case p_what
    when 'manage' then p_actor.role in ('owner', 'manager')
    when 'book' then p_actor.role in ('owner', 'manager', 'front_desk')
    else p_actor.role is not null end
$$;

create or replace function app.ap_require(p_actor app.ap_actor_t, p_what text) returns void
language plpgsql immutable as $$
begin
  if not app.ap_can(p_actor, p_what) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

-- The client a booking is for: staff (front desk and above) name one; clients can only act for themselves.
create or replace function app.ap_resolve_client(p_actor app.ap_actor_t, p_client uuid, p_what text default 'book') returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_actor.as_staff then
    perform app.ap_require(p_actor, 'book');
    if p_client is null then perform app.fail('INVALID', 'Choose a client.'); end if;
    if not exists (select 1 from public.clients where id = p_client and studio_id = p_actor.studio) then
      perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
    end if;
    return p_client;
  end if;
  if p_client is not null and p_client <> p_actor.client_id then
    -- family accounts (0010_family.sql): a parent acts for their dependants
    if app.is_guardian_of(p_client) then return p_client; end if;
    perform app.fail('NOT_ALLOWED', format('You can only %s for yourself and your family.', p_what));
  end if;
  return p_actor.client_id;
end $$;

-- ----------------------------------------------------------------------------- JSON shapes (camelCase, nulls dropped)

create or replace function app.ap_type_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', t.id, 'name', t.name, 'description', t.description, 'durationMin', t.duration_min, 'priceCents', t.price_cents,
    'capacity', t.capacity, 'bufferMin', t.buffer_min, 'bookingNote', t.booking_note, 'imageUrl', t.image_url,
    'active', t.active, 'sortOrder', t.sort_order,
    'staffIds', coalesce((select jsonb_agg(ts.staff_id order by ts.staff_id) from public.appointment_type_staff ts where ts.type_id = t.id), '[]'::jsonb)))
  from public.appointment_types t where t.id = p_id
$$;

create or replace function app.ap_pack_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'credits', p.credits, 'priceCents', p.price_cents,
    'validityDays', p.validity_days, 'typeIds', to_jsonb(p.type_ids), 'active', p.active))
  from public.appointment_packs p where p.id = p_id
$$;

create or replace function app.ap_appt_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', a.id, 'typeId', a.type_id, 'typeName', a.type_name, 'staffId', a.staff_id, 'staffName', coalesce(s.name, 'Instructor'),
    'clientId', a.client_id, 'clientName', coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'Client'),
    'people', a.people, 'startsAt', app.ap_iso(a.starts_at), 'endsAt', app.ap_iso(a.ends_at), 'bufferMin', a.buffer_min, 'status', a.status,
    'payment', jsonb_build_object('method', a.pay_method, 'amountCents', a.amount_cents,
                                  'credits', case when a.pay_method = 'pack' then a.credit_uses end, 'saleId', a.sale_id),
    'note', a.note, 'source', a.source, 'bookedByStaffId', a.booked_by_staff_id, 'createdAt', app.ap_iso(a.created_at),
    'cancelledAt', case when a.cancelled_at is not null then app.ap_iso(a.cancelled_at) end,
    -- refunded in the Sales screen (or in Stripe) => no longer due
    'refundDue', case when a.refund_due and coalesce((select sa.refunded_cents from public.sales sa where sa.id = a.sale_id), 0) < a.amount_cents then true end))
  from public.appointments a
  left join public.staff s on s.id = a.staff_id
  left join public.clients c on c.id = a.client_id
  where a.id = p_id
$$;

create or replace function app.ap_credit_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'clientId', c.client_id, 'packId', c.pack_id, 'name', c.name, 'credits', c.credits_total, 'used', c.used,
    'remaining', c.credits_total - c.used, 'validityDays', c.validity_days, 'typeIds', to_jsonb(c.type_ids),
    'purchasedAt', app.ap_iso(c.purchased_at),
    'activatedAt', case when c.activated_at is not null then app.ap_iso(c.activated_at) end,
    'expiresAt', case when c.expires_at is not null then app.ap_iso(c.expires_at) end,
    'saleId', c.sale_id,
    'status', case when c.credits_total - c.used <= 0 then 'used_up' when c.expires_at is not null and c.expires_at <= app.now() then 'expired' else 'active' end))
  from public.appointment_credits c where c.id = p_id
$$;

create or replace function app.ap_reg_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', r.id, 'eventId', r.event_id, 'eventTitle', e.title, 'eventKind', e.kind, 'clientId', r.client_id,
    'clientName', coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'Client'),
    'status', r.status,
    'payment', jsonb_build_object('method', r.pay_method, 'amountCents', r.amount_cents, 'saleId', r.sale_id),
    'createdAt', app.ap_iso(r.created_at),
    'cancelledAt', case when r.cancelled_at is not null then app.ap_iso(r.cancelled_at) end,
    'attended', coalesce((select jsonb_agg(app.ap_iso(x) order by x) from unnest(r.attended) x), '[]'::jsonb),
    'refundDue', case when r.refund_due and coalesce((select sa.refunded_cents from public.sales sa where sa.id = r.sale_id), 0) < r.amount_cents then true end,
    'startsAt', app.ap_iso(coalesce((select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id), r.created_at))))
  from public.studio_event_registrations r
  join public.studio_events e on e.id = r.event_id
  left join public.clients c on c.id = r.client_id
  where r.id = p_id
$$;

create or replace function app.ap_event_json(p_id uuid, p_client uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'title', e.title, 'description', e.description, 'imageUrl', e.image_url, 'priceCents', e.price_cents,
    'capacity', e.capacity, 'hostStaffId', e.host_staff_id, 'location', e.location, 'published', e.published,
    'cancelled', case when e.cancelled then true end, 'cancelReason', e.cancel_reason, 'refundCutoffHours', e.refund_cutoff_hours,
    'createdAt', app.ap_iso(e.created_at),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('startsAt', app.ap_iso(s.starts_at), 'endsAt', app.ap_iso(s.ends_at)) order by s.starts_at)
                            from public.studio_event_sessions s where s.event_id = e.id), '[]'::jsonb),
    'registered', n.reg,
    'spotsLeft', greatest(0, e.capacity - n.reg - n.held),
    'mine', case when p_client is not null then
              (select app.ap_reg_json(r.id) from public.studio_event_registrations r
                where r.event_id = e.id and r.client_id = p_client and r.status = 'registered' limit 1) end))
  from public.studio_events e
  cross join lateral (
    select count(*) filter (where r.status = 'registered')::int as reg,
           count(*) filter (where r.status = 'pending_payment' and r.hold_expires_at > app.now())::int as held
      from public.studio_event_registrations r where r.event_id = e.id) n
  where e.id = p_id
$$;

-- ----------------------------------------------------------------------------- slots

-- Every open start time for an appointment type between two studio dates (inclusive), earliest first. Same rules as computeSlots():
--  * on the slot grid inside one of the instructor's weekly windows, and the whole session fits inside it
--  * at least min_notice_hours from now and no further than horizon_days ahead (staff can book closer in and further out, never in the past)
--  * not overlapping time off
--  * the session plus its buffer doesn't overlap another appointment (plus its own buffer) or a class they teach
create or replace function app.ap_slots(
  p_studio uuid, p_type uuid, p_from date, p_to date, p_staff uuid, p_as_staff boolean, p_now timestamptz
) returns table (staff_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t public.appointment_types;
  cfg public.appointment_settings := app.ap_settings(p_studio);
  tz text := app.studio_tz(p_studio);
  v_earliest timestamptz;
  v_latest timestamptz;
  v_to date := least(p_to, p_from + 62);
begin
  select * into t from public.appointment_types where id = p_type and studio_id = p_studio;
  if t.id is null or v_to < p_from then return; end if;
  v_earliest := p_now + case when p_as_staff then interval '0' else make_interval(hours => cfg.min_notice_hours) end;
  v_latest := case when p_as_staff then 'infinity'::timestamptz else p_now + make_interval(days => cfg.horizon_days) end;

  return query
  with days as (
    select d::date as day from generate_series(p_from, v_to, interval '1 day') d
  ), windows as (
    select a.staff_id, ((d.day + a.start_time) at time zone tz) as ws, ((d.day + a.end_time) at time zone tz) as we
      from days d
      join public.appointment_availability a on a.weekday = extract(dow from d.day)::int and a.studio_id = p_studio
      join public.appointment_type_staff ts on ts.type_id = p_type and ts.staff_id = a.staff_id
      join public.staff st on st.id = a.staff_id and st.active
     where p_staff is null or a.staff_id = p_staff
  ), cand as (
    select distinct w.staff_id as sid, g as s
      from windows w
      cross join lateral generate_series(w.ws, w.we - make_interval(mins => t.duration_min), make_interval(mins => greatest(5, cfg.slot_step_min))) g
  )
  select c.sid, c.s, c.s + make_interval(mins => t.duration_min)
    from cand c
   where c.s >= v_earliest and c.s <= v_latest
     and not exists (select 1 from public.appointment_time_off o
                      where o.staff_id = c.sid and c.s < o.ends_at and o.starts_at < c.s + make_interval(mins => t.duration_min))
     and not exists (select 1 from public.appointments a
                      where a.staff_id = c.sid
                        and (a.status in ('booked', 'completed', 'no_show') or (a.status = 'pending_payment' and a.hold_expires_at > p_now))
                        and c.s < a.ends_at + make_interval(mins => a.buffer_min)
                        and a.starts_at < c.s + make_interval(mins => t.duration_min + t.buffer_min))
     and not exists (select 1 from public.class_sessions cs
                      where cs.instructor_id = c.sid and cs.status <> 'cancelled'
                        and c.s < cs.ends_at and cs.starts_at < c.s + make_interval(mins => t.duration_min + t.buffer_min))
   order by c.s, c.sid;
end $$;

-- Expire held slots / sign-ups whose payment never arrived (pending_payment past hold_expires_at).
create or replace function app.ap_release_holds(p_studio uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now();
begin
  update public.appointments set status = 'cancelled', cancelled_at = v_now
   where studio_id = p_studio and status = 'pending_payment' and hold_expires_at <= v_now;
  update public.studio_event_registrations set status = 'cancelled', cancelled_at = v_now
   where studio_id = p_studio and status = 'pending_payment' and hold_expires_at <= v_now;
  update public.appointment_orders set status = 'expired'
   where studio_id = p_studio and status = 'pending' and expires_at <= v_now;
end $$;

-- Everything a booking or a hold needs to be true; serialises on the instructor so two clients can't take the same slot.
create or replace function app.ap_check_slot(
  p_studio uuid, p_type uuid, p_staff uuid, p_starts timestamptz, p_people int, p_client uuid, p_as_staff boolean
) returns public.appointment_types
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.appointment_types; v_day date;
begin
  select * into t from public.appointment_types where id = p_type and studio_id = p_studio;
  if t.id is null or (not t.active and not p_as_staff) then perform app.fail('NOT_FOUND', 'We couldn''t find that session.'); end if;
  if p_people is null or p_people < 1 or p_people > t.capacity then
    perform app.fail('INVALID', case when t.capacity = 1 then 'This is a one-to-one session.' else format('This session takes up to %s people.', t.capacity) end);
  end if;
  if not exists (select 1 from public.staff where id = p_staff and studio_id = p_studio) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that instructor.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('appointments:' || p_staff::text, 0));
  perform app.ap_release_holds(p_studio);
  v_day := (p_starts at time zone app.studio_tz(p_studio))::date;
  if not exists (select 1 from app.ap_slots(p_studio, p_type, v_day, v_day, p_staff, p_as_staff, app.now()) s
                  where s.starts_at = p_starts and s.staff_id = p_staff) then
    perform app.fail('SLOT_TAKEN', 'That time isn''t available any more. Please pick another.');
  end if;
  if exists (select 1 from public.appointments where client_id = p_client and starts_at = p_starts and status in ('booked', 'pending_payment')) then
    perform app.fail('ALREADY_BOOKED', 'You already have a session at that time.');
  end if;
  return t;
end $$;

-- ----------------------------------------------------------------------------- money helpers

create or replace function app.ap_make_sale(
  p_studio uuid, p_client uuid, p_staff uuid, p_name text, p_qty int, p_unit int, p_method text, p_note text,
  p_session text default null, p_payment_intent text default null, p_total int default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sale uuid;
begin
  insert into public.sales (studio_id, client_id, total_cents, method, staff_id, note, stripe_checkout_session_id, stripe_payment_intent_id)
  values (p_studio, p_client, case when p_method = 'comp' then 0 else coalesce(p_total, p_qty * p_unit) end, p_method, p_staff, p_note, p_session, p_payment_intent)
  returning id into v_sale;
  insert into public.sale_items (studio_id, sale_id, name, qty, unit_cents) values (p_studio, v_sale, p_name, p_qty, p_unit);
  perform app.queue_receipt(v_sale);
  return v_sale;
end $$;

-- Take `p_people` credits from the client's packs: soonest to expire first, packs not started yet last, then oldest.
-- Returns [{creditId, n}] or null when there aren't enough. p_credit forces one credit (it must cover everyone).
create or replace function app.ap_take_credits(p_studio uuid, p_client uuid, p_type uuid, p_people int, p_at timestamptz, p_credit uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.appointment_credits; need int := p_people; take int; v_uses jsonb := '[]'::jsonb; v_now timestamptz := app.now();
begin
  for c in
    select * from public.appointment_credits
     where studio_id = p_studio and client_id = p_client and used < credits_total
       and (expires_at is null or expires_at > p_at)
       and (cardinality(type_ids) = 0 or p_type = any (type_ids))
       and (p_credit is null or id = p_credit)
     order by expires_at nulls last, purchased_at, id
       for update
  loop
    exit when need <= 0;
    if p_credit is not null and c.credits_total - c.used < p_people then return null; end if;
    take := least(need, c.credits_total - c.used);
    update public.appointment_credits
       set used = used + take,
           activated_at = coalesce(activated_at, v_now),
           expires_at = case when activated_at is null and validity_days is not null then v_now + make_interval(days => validity_days) else expires_at end
     where id = c.id;
    v_uses := v_uses || jsonb_build_object('creditId', c.id, 'n', take);
    need := need - take;
  end loop;
  return case when need > 0 then null else v_uses end;
end $$;

create or replace function app.ap_return_credits(p_uses jsonb) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare u jsonb; n int := 0;
begin
  for u in select * from jsonb_array_elements(coalesce(p_uses, '[]'::jsonb)) loop
    update public.appointment_credits set used = greatest(0, used - (u ->> 'n')::int) where id = (u ->> 'creditId')::uuid;
    n := n + (u ->> 'n')::int;
  end loop;
  return n;
end $$;

-- Who may pay with what: clients can use their credits (cards go through checkout, 1102); the front desk takes cards at the till, cash or comps.
create or replace function app.ap_check_method(p_actor app.ap_actor_t, p_method text, p_allow_pack boolean) returns void
language plpgsql immutable as $$
begin
  if p_method not in ('pack', 'card_online', 'card_reader', 'cash', 'comp') then perform app.fail('INVALID', 'Choose how it''s being paid.'); end if;
  if p_method = 'pack' and not p_allow_pack then perform app.fail('INVALID', 'Pack credits can''t be used for that.'); end if;
  if not p_actor.as_staff then
    if p_method <> 'pack' then perform app.fail('NOT_ALLOWED', 'Pay online by card at checkout.'); end if;
  elsif p_method = 'card_online' then
    perform app.fail('NOT_ALLOWED', 'Take card payments at the till (card reader).');
  end if;
end $$;

-- ----------------------------------------------------------------------------- settings, catalogue, hours (reads are table selects under RLS)

create or replace function public.appointments_update_settings(p_slot_step_min int, p_min_notice_hours int, p_horizon_days int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor();
begin
  perform app.ap_require(v, 'manage');
  if not (p_slot_step_min between 5 and 120) then perform app.fail('INVALID', 'Slots can start every 5 to 120 minutes.'); end if;
  if not (p_min_notice_hours between 0 and 336) then perform app.fail('INVALID', 'Minimum notice can be 0 to 336 hours.'); end if;
  if not (p_horizon_days between 1 and 365) then perform app.fail('INVALID', 'Clients can book 1 to 365 days ahead.'); end if;
  insert into public.appointment_settings (studio_id, slot_step_min, min_notice_hours, horizon_days)
  values (v.studio, p_slot_step_min, p_min_notice_hours, p_horizon_days)
  on conflict (studio_id) do update set slot_step_min = excluded.slot_step_min, min_notice_hours = excluded.min_notice_hours, horizon_days = excluded.horizon_days;
  return jsonb_build_object('slotStepMin', p_slot_step_min, 'minNoticeHours', p_min_notice_hours, 'horizonDays', p_horizon_days);
end $$;

create or replace function public.appointments_list_types(p_include_inactive boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor();
begin
  return coalesce((
    select jsonb_agg(app.ap_type_json(t.id) order by t.sort_order, t.name)
      from public.appointment_types t
     where t.studio_id = v.studio and (t.active or (v.staff_id is not null and p_include_inactive))), '[]'::jsonb);
end $$;

create or replace function public.appointments_upsert_type(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_dur int := round((p ->> 'durationMin')::numeric);
  v_price int := round((p ->> 'priceCents')::numeric);
  v_cap int := (p ->> 'capacity')::int;
  v_buf int := round(coalesce((p ->> 'bufferMin')::numeric, 0));
begin
  perform app.ap_require(v, 'manage');
  if v_name = '' then perform app.fail('INVALID', 'Give the session a name.'); end if;
  if not (v_dur between 5 and 480) then perform app.fail('INVALID', 'Sessions run 5 to 480 minutes.'); end if;
  if not (v_price >= 0) then perform app.fail('INVALID', 'The price can''t be negative.'); end if;
  if v_cap is null or v_cap not in (1, 2) then perform app.fail('INVALID', 'A session is for 1 or 2 people.'); end if;
  if not (v_buf between 0 and 120) then perform app.fail('INVALID', 'Buffer time can be 0 to 120 minutes.'); end if;
  if v_id is not null then perform app.assert_in_studio('appointment_types', v_id, 'We couldn''t find that session type.'); end if;

  if v_id is null or not exists (select 1 from public.appointment_types where id = v_id) then
    insert into public.appointment_types (id, studio_id, name, description, duration_min, price_cents, capacity, buffer_min, booking_note, image_url, active, sort_order)
    values (coalesce(v_id, gen_random_uuid()), v.studio, v_name, coalesce(p ->> 'description', ''), v_dur, v_price, v_cap, v_buf,
            nullif(trim(coalesce(p ->> 'bookingNote', '')), ''), nullif(p ->> 'imageUrl', ''), coalesce((p ->> 'active')::boolean, true),
            coalesce((p ->> 'sortOrder')::int, 100))
    returning id into v_id;
  else
    update public.appointment_types set name = v_name, description = coalesce(p ->> 'description', ''), duration_min = v_dur, price_cents = v_price,
           capacity = v_cap, buffer_min = v_buf, booking_note = nullif(trim(coalesce(p ->> 'bookingNote', '')), ''), image_url = nullif(p ->> 'imageUrl', ''),
           active = coalesce((p ->> 'active')::boolean, active), sort_order = coalesce((p ->> 'sortOrder')::int, sort_order)
     where id = v_id;
  end if;

  delete from public.appointment_type_staff where type_id = v_id;
  insert into public.appointment_type_staff (studio_id, type_id, staff_id)
  select v.studio, v_id, s.id from public.staff s
   where s.studio_id = v.studio and s.active
     and s.id in (select distinct (x)::uuid from jsonb_array_elements_text(coalesce(p -> 'staffIds', '[]'::jsonb)) x);
  return app.ap_type_json(v_id);
end $$;

create or replace function public.appointments_upsert_pack(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_credits int := (p ->> 'credits')::int;
  v_price int := round((p ->> 'priceCents')::numeric);
  v_days int := nullif(p ->> 'validityDays', '')::int;
  v_types uuid[];
begin
  perform app.ap_require(v, 'manage');
  if v_name = '' then perform app.fail('INVALID', 'Give the pack a name.'); end if;
  if v_credits is null or v_credits < 1 then perform app.fail('INVALID', 'A pack needs at least one credit.'); end if;
  if not (v_price >= 0) then perform app.fail('INVALID', 'The price can''t be negative.'); end if;
  if v_days is not null and v_days < 1 then perform app.fail('INVALID', 'Packs last at least a day (or leave it blank for no expiry).'); end if;
  if v_id is not null then perform app.assert_in_studio('appointment_packs', v_id, 'We couldn''t find that pack.'); end if;
  select coalesce(array_agg(t.id), '{}') into v_types from public.appointment_types t
   where t.studio_id = v.studio and t.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p -> 'typeIds', '[]'::jsonb)) x);

  if v_id is null or not exists (select 1 from public.appointment_packs where id = v_id) then
    insert into public.appointment_packs (id, studio_id, name, description, credits, price_cents, validity_days, type_ids, active)
    values (coalesce(v_id, gen_random_uuid()), v.studio, v_name, coalesce(p ->> 'description', ''), v_credits, v_price, v_days, v_types, coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update public.appointment_packs set name = v_name, description = coalesce(p ->> 'description', ''), credits = v_credits, price_cents = v_price,
           validity_days = v_days, type_ids = v_types, active = coalesce((p ->> 'active')::boolean, active)
     where id = v_id;
  end if;
  return app.ap_pack_json(v_id);
end $$;

create or replace function public.appointments_set_availability(p_staff_id uuid, p_rules jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor();
  r record;
  v_prev_wd int := -1;
  v_prev_end time;
begin
  if not (app.ap_can(v, 'manage') or (v.staff_id is not null and v.staff_id = p_staff_id)) then
    perform app.fail('NOT_ALLOWED', 'You can only change your own hours.');
  end if;
  perform app.assert_in_studio('staff', p_staff_id, 'We couldn''t find that person.');
  if jsonb_typeof(coalesce(p_rules, '[]'::jsonb)) <> 'array' then perform app.fail('INVALID', 'Send the hours as a list.'); end if;

  create temporary table if not exists _ap_rules (wd int, st time, en time) on commit drop;
  delete from _ap_rules;
  begin
    insert into _ap_rules
    select (x ->> 'weekday')::int, (x ->> 'start')::time, (x ->> 'end')::time from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) x;
  exception when others then
    perform app.fail('INVALID', 'Use times like 09:00.');
  end;
  if exists (select 1 from _ap_rules where wd is null or wd not between 0 and 6) then perform app.fail('INVALID', 'Pick a day of the week.'); end if;
  if exists (select 1 from _ap_rules where en <= st) then perform app.fail('INVALID', 'Each window needs to finish after it starts.'); end if;
  for r in select * from _ap_rules order by wd, st loop
    if r.wd = v_prev_wd and r.st < v_prev_end then perform app.fail('INVALID', 'Two windows on the same day overlap.'); end if;
    v_prev_wd := r.wd; v_prev_end := r.en;
  end loop;

  delete from public.appointment_availability where staff_id = p_staff_id and studio_id = v.studio;
  insert into public.appointment_availability (studio_id, staff_id, weekday, start_time, end_time)
  select v.studio, p_staff_id, wd, st, en from _ap_rules;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'staffId', a.staff_id, 'weekday', a.weekday,
                                                       'start', to_char(a.start_time, 'HH24:MI'), 'end', to_char(a.end_time, 'HH24:MI')) order by a.weekday, a.start_time)
                    from public.appointment_availability a where a.staff_id = p_staff_id and a.studio_id = v.studio), '[]'::jsonb);
end $$;

create or replace function public.appointments_add_time_off(p_staff_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); v_id uuid;
begin
  if not (app.ap_can(v, 'manage') or (v.staff_id is not null and v.staff_id = p_staff_id)) then
    perform app.fail('NOT_ALLOWED', 'You can only change your own time off.');
  end if;
  perform app.assert_in_studio('staff', p_staff_id, 'We couldn''t find that person.');
  if not (p_ends_at > p_starts_at) then perform app.fail('INVALID', 'Time off needs to finish after it starts.'); end if;
  insert into public.appointment_time_off (studio_id, staff_id, starts_at, ends_at, note)
  values (v.studio, p_staff_id, p_starts_at, p_ends_at, nullif(trim(coalesce(p_note, '')), '')) returning id into v_id;
  return jsonb_strip_nulls(jsonb_build_object('id', v_id, 'staffId', p_staff_id, 'startsAt', app.ap_iso(p_starts_at), 'endsAt', app.ap_iso(p_ends_at), 'note', nullif(trim(coalesce(p_note, '')), '')));
end $$;

create or replace function public.appointments_remove_time_off(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); t public.appointment_time_off;
begin
  perform app.assert_in_studio('appointment_time_off', p_id, 'We couldn''t find that time off.');
  select * into t from public.appointment_time_off where id = p_id;
  if t.id is null then return; end if;
  if not (app.ap_can(v, 'manage') or (v.staff_id is not null and v.staff_id = t.staff_id)) then
    perform app.fail('NOT_ALLOWED', 'You can only change your own time off.');
  end if;
  delete from public.appointment_time_off where id = p_id;
end $$;

-- ----------------------------------------------------------------------------- slots + booking

create or replace function public.appointments_list_slots(p_type_id uuid, p_from date, p_to date, p_staff_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor();
begin
  perform app.assert_in_studio('appointment_types', p_type_id, 'We couldn''t find that session.');
  if not exists (select 1 from public.appointment_types where id = p_type_id and studio_id = v.studio and (active or v.as_staff)) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that session.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('typeId', p_type_id, 'staffId', s.staff_id, 'startsAt', app.ap_iso(s.starts_at), 'endsAt', app.ap_iso(s.ends_at)) order by s.starts_at, s.staff_id)
      from app.ap_slots(v.studio, p_type_id, p_from, p_to, p_staff_id, v.as_staff, app.now()) s), '[]'::jsonb);
end $$;

create or replace function public.appointments_book(
  p_type_id uuid, p_staff_id uuid, p_starts_at timestamptz, p_people int default 1, p_client_id uuid default null,
  p_note text default null, p_method text default 'pack', p_credit_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor(p_client_id);
  v_client uuid;
  t public.appointment_types;
  v_waiver timestamptz;
  v_uses jsonb;
  v_sale uuid;
  v_amount int := 0;
  v_id uuid;
begin
  perform app.assert_in_studio('appointment_types', p_type_id, 'We couldn''t find that session.');
  perform app.assert_studio_open(v.studio);
  v_client := app.ap_resolve_client(v, p_client_id);
  if not v.as_staff then
    select waiver_signed_at into v_waiver from public.clients where id = v_client;
    if v_waiver is null then perform app.fail('WAIVER_REQUIRED', 'Please complete your waiver and health form before booking.'); end if;
  end if;
  perform app.ap_check_method(v, p_method, true);
  t := app.ap_check_slot(v.studio, p_type_id, p_staff_id, p_starts_at, coalesce(p_people, 1), v_client, v.as_staff);

  if p_method = 'pack' then
    v_uses := app.ap_take_credits(v.studio, v_client, t.id, coalesce(p_people, 1), p_starts_at, p_credit_id);
    if v_uses is null then
      perform app.fail('NO_CREDITS', case when coalesce(p_people, 1) > 1 then format('You need %s credits for this session.', p_people) else 'You don''t have a credit for this session.' end);
    end if;
  else
    v_amount := case when p_method = 'comp' then 0 else coalesce(p_people, 1) * t.price_cents end;
    v_sale := app.ap_make_sale(v.studio, v_client, v.staff_id,
                               case when coalesce(p_people, 1) = 2 then t.name || ' (2 people)' else t.name end,
                               coalesce(p_people, 1), t.price_cents, p_method, 'Appointment');
  end if;

  begin
    insert into public.appointments (studio_id, type_id, type_name, staff_id, client_id, people, starts_at, ends_at, buffer_min, status, pay_method,
                                     amount_cents, credit_uses, sale_id, note, source, booked_by_staff_id)
    values (v.studio, t.id, t.name, p_staff_id, v_client, coalesce(p_people, 1), p_starts_at, p_starts_at + make_interval(mins => t.duration_min), t.buffer_min,
            'booked', p_method, v_amount, coalesce(v_uses, '[]'::jsonb), v_sale, nullif(trim(coalesce(p_note, '')), ''),
            case when v.as_staff then 'staff' else 'client' end, case when v.as_staff then v.staff_id end)
    returning id into v_id;
  exception when unique_violation then
    perform app.fail('SLOT_TAKEN', 'That time isn''t available any more. Please pick another.');
  end;
  return jsonb_strip_nulls(jsonb_build_object('appointment', app.ap_appt_json(v_id), 'sale', case when v_sale is not null then app.sale_json(v_sale) end));
end $$;

create or replace function public.appointments_cancel(p_id uuid, p_waive_penalty boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t;
  a public.appointments;
  v_now timestamptz := app.now();
  v_window numeric;
  v_late boolean;
  v_returned int := 0;
  v_refund boolean := false;
begin
  perform app.assert_in_studio('appointments', p_id, 'We couldn''t find that appointment.');
  select * into a from public.appointments where id = p_id for update;
  if a.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that appointment.'); end if;
  v := app.ap_actor(a.client_id);
  if not v.as_staff then
    if a.client_id <> v.client_id and not app.is_guardian_of(a.client_id) then perform app.fail('NOT_FOUND', 'We couldn''t find that appointment.'); end if;
    if p_waive_penalty then perform app.fail('NOT_ALLOWED', 'Only staff can waive the cancellation policy.'); end if;
  else
    perform app.ap_require(v, 'book');
  end if;
  if a.status <> 'booked' then perform app.fail('INVALID', 'This appointment can''t be cancelled.'); end if;
  if not v.as_staff and v_now >= a.starts_at then perform app.fail('TOO_LATE', 'This session has already started.'); end if;

  select cancel_window_hours into v_window from public.studio_settings where studio_id = a.studio_id;
  v_late := v_now > a.starts_at - (coalesce(v_window, 0) * interval '1 hour') and not coalesce(p_waive_penalty, false);
  if v_late then
    update public.appointments set status = 'late_cancelled', cancelled_at = v_now where id = a.id;
  else
    update public.appointments set status = 'cancelled', cancelled_at = v_now where id = a.id;
    if a.pay_method = 'pack' then
      v_returned := app.ap_return_credits(a.credit_uses);
    elsif a.amount_cents > 0 then
      v_refund := true;
      update public.appointments set refund_due = true where id = a.id;
    end if;
  end if;
  return jsonb_build_object('appointment', app.ap_appt_json(a.id), 'creditsReturned', v_returned, 'refundDue', v_refund, 'late', v_late);
end $$;

create or replace function public.appointments_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); a public.appointments;
begin
  perform app.assert_in_studio('appointments', p_id, 'We couldn''t find that appointment.');
  if not v.as_staff or v.staff_id is null then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  select * into a from public.appointments where id = p_id for update;
  if a.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that appointment.'); end if;
  if not app.ap_can(v, 'book') and a.staff_id <> v.staff_id then perform app.fail('NOT_ALLOWED', 'You can only update your own sessions.'); end if;
  if p_status not in ('completed', 'no_show', 'booked') then perform app.fail('INVALID', 'Choose completed, no-show or booked.'); end if;
  if a.status not in ('booked', 'completed', 'no_show') then perform app.fail('INVALID', 'This appointment was cancelled.'); end if;
  if p_status <> 'booked' and app.now() < a.starts_at then perform app.fail('INVALID', 'You can mark it once the session has started.'); end if;
  update public.appointments set status = p_status where id = a.id;
  return app.ap_appt_json(a.id);
end $$;

-- Clients: their own. Instructors: their own sessions. Owner / manager / front desk: everyone's. startsAt in [from, to).
create or replace function public.appointments_list(
  p_from timestamptz default null, p_to timestamptz default null, p_staff_id uuid default null, p_client_id uuid default null, p_include_cancelled boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(p_client_id); v_staff uuid := p_staff_id; v_client uuid := p_client_id;
begin
  if not v.as_staff then v_client := v.client_id;
  elsif not app.ap_can(v, 'book') then v_staff := v.staff_id; end if;
  return coalesce((
    select jsonb_agg(app.ap_appt_json(a.id) order by a.starts_at, a.id)
      from public.appointments a
     where a.studio_id = v.studio and a.status <> 'pending_payment'
       and (p_include_cancelled or a.status not in ('cancelled', 'late_cancelled'))
       and (v_staff is null or a.staff_id = v_staff) and (v_client is null or a.client_id = v_client or (not v.as_staff and app.is_guardian_of(a.client_id)))
       and (p_from is null or a.starts_at >= p_from) and (p_to is null or a.starts_at < p_to)), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- packs

create or replace function public.appointments_buy_pack(p_pack_id uuid, p_client_id uuid default null, p_method text default 'card_reader') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(p_client_id); v_client uuid; pk public.appointment_packs; v_sale uuid; v_id uuid;
begin
  perform app.assert_in_studio('appointment_packs', p_pack_id, 'That pack isn''t available.');
  v_client := app.ap_resolve_client(v, p_client_id, 'buy');
  perform app.ap_check_method(v, p_method, false);
  select * into pk from public.appointment_packs where id = p_pack_id and studio_id = v.studio and active;
  if pk.id is null then perform app.fail('NOT_FOUND', 'That pack isn''t available.'); end if;
  v_sale := app.ap_make_sale(v.studio, v_client, v.staff_id, pk.name, 1, pk.price_cents, p_method, 'Appointment pack');
  insert into public.appointment_credits (studio_id, client_id, pack_id, name, credits_total, validity_days, type_ids, sale_id)
  values (v.studio, v_client, pk.id, pk.name, pk.credits, pk.validity_days, pk.type_ids, v_sale) returning id into v_id;
  return jsonb_build_object('credit', app.ap_credit_json(v_id), 'sale', app.sale_json(v_sale));
end $$;

create or replace function public.appointments_list_credits(p_client_id uuid default null, p_include_inactive boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(p_client_id); v_client uuid := p_client_id;
begin
  if not v.as_staff then v_client := case when p_client_id is not null and app.is_guardian_of(p_client_id) then p_client_id else v.client_id end; end if;
  if v_client is null then perform app.fail('INVALID', 'Choose a client.'); end if;
  return coalesce((
    select jsonb_agg(j.x order by c.purchased_at, c.id)
      from public.appointment_credits c, lateral (select app.ap_credit_json(c.id) as x) j
     where c.studio_id = v.studio and c.client_id = v_client
       and (p_include_inactive or (c.used < c.credits_total and (c.expires_at is null or c.expires_at > app.now())))), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- workshops, courses, events

create or replace function public.appointments_list_events(p_include_past boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor();
begin
  if not v.as_staff then
    return coalesce((
      select jsonb_agg(app.ap_event_json(e.id, v.client_id) order by (select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id))
        from public.studio_events e
       where e.studio_id = v.studio and e.published and not e.cancelled
         and (select max(s.ends_at) from public.studio_event_sessions s where s.event_id = e.id) > app.now()), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(app.ap_event_json(e.id)
                     order by case when p_include_past then null else (select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id) end,
                              case when p_include_past then (select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id) end desc)
      from public.studio_events e
     where e.studio_id = v.studio
       and (p_include_past or (select max(s.ends_at) from public.studio_event_sessions s where s.event_id = e.id) > app.now())), '[]'::jsonb);
end $$;

create or replace function public.appointments_get_event(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); e public.studio_events;
begin
  perform app.assert_in_studio('studio_events', p_id, 'We couldn''t find that event.');
  select * into e from public.studio_events where id = p_id and studio_id = v.studio;
  if e.id is null or (not v.as_staff and not e.published) then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
  return app.ap_event_json(e.id, case when v.as_staff then null else v.client_id end);
end $$;

create or replace function public.appointments_upsert_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_kind text := p ->> 'kind';
  v_title text := trim(coalesce(p ->> 'title', ''));
  v_cap int := (p ->> 'capacity')::int;
  v_price int := round(coalesce((p ->> 'priceCents')::numeric, 0));
  v_cutoff int := round(coalesce((p ->> 'refundCutoffHours')::numeric, 48));
  v_host uuid := nullif(p ->> 'hostStaffId', '')::uuid;
  v_sessions jsonb := coalesce(p -> 'sessions', '[]'::jsonb);
  v_registered int := 0;
  x jsonb;
begin
  perform app.ap_require(v, 'manage');
  if v_kind not in ('workshop', 'course', 'event') then perform app.fail('INVALID', 'Choose workshop, course or event.'); end if;
  if v_title = '' then perform app.fail('INVALID', 'Give it a name.'); end if;
  if v_cap is null or v_cap < 1 then perform app.fail('INVALID', 'Capacity needs to be at least 1.'); end if;
  if v_price < 0 then perform app.fail('INVALID', 'The price can''t be negative.'); end if;
  if v_cutoff < 0 then perform app.fail('INVALID', 'The refund cut-off can''t be negative.'); end if;
  if jsonb_typeof(v_sessions) <> 'array' or jsonb_array_length(v_sessions) = 0 then perform app.fail('INVALID', 'Add at least one date.'); end if;
  for x in select * from jsonb_array_elements(v_sessions) loop
    begin
      if (x ->> 'endsAt')::timestamptz <= (x ->> 'startsAt')::timestamptz then perform app.fail('INVALID', 'Each session needs to finish after it starts.'); end if;
    exception when invalid_datetime_format or datetime_field_overflow or null_value_not_allowed then
      perform app.fail('INVALID', 'Check the dates and times.');
    end;
  end loop;
  if v_kind <> 'course' and jsonb_array_length(v_sessions) > 1 then
    perform app.fail('INVALID', 'Workshops and events are a single date. Choose “Course” for several dates.');
  end if;
  if v_host is not null and not exists (select 1 from public.staff where id = v_host and studio_id = v.studio) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that host.');
  end if;
  if v_id is not null then
    perform app.assert_in_studio('studio_events', v_id, 'We couldn''t find that event.');
    select count(*) into v_registered from public.studio_event_registrations where event_id = v_id and status = 'registered';
    if v_cap < v_registered then perform app.fail('INVALID', format('%s people are registered, so capacity can''t go below that.', v_registered)); end if;
  end if;

  if v_id is null or not exists (select 1 from public.studio_events where id = v_id) then
    insert into public.studio_events (id, studio_id, kind, title, description, image_url, price_cents, capacity, host_staff_id, location, published, refund_cutoff_hours)
    values (coalesce(v_id, gen_random_uuid()), v.studio, v_kind, v_title, coalesce(p ->> 'description', ''), nullif(p ->> 'imageUrl', ''), v_price, v_cap, v_host,
            nullif(trim(coalesce(p ->> 'location', '')), ''), coalesce((p ->> 'published')::boolean, false), v_cutoff)
    returning id into v_id;
  else
    update public.studio_events set kind = v_kind, title = v_title, description = coalesce(p ->> 'description', ''), image_url = nullif(p ->> 'imageUrl', ''),
           price_cents = v_price, capacity = v_cap, host_staff_id = v_host, location = nullif(trim(coalesce(p ->> 'location', '')), ''),
           published = coalesce((p ->> 'published')::boolean, published), refund_cutoff_hours = v_cutoff
     where id = v_id;
  end if;
  delete from public.studio_event_sessions where event_id = v_id;
  insert into public.studio_event_sessions (studio_id, event_id, starts_at, ends_at)
  select v.studio, v_id, (j ->> 'startsAt')::timestamptz, (j ->> 'endsAt')::timestamptz from jsonb_array_elements(v_sessions) j;
  return app.ap_event_json(v_id);
end $$;

create or replace function public.appointments_cancel_event(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); v_now timestamptz := app.now();
begin
  perform app.ap_require(v, 'manage');
  perform app.assert_in_studio('studio_events', p_id, 'We couldn''t find that event.');
  if not exists (select 1 from public.studio_events where id = p_id) then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
  update public.studio_events set cancelled = true, published = false, cancel_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Cancelled by the studio') where id = p_id;
  update public.studio_event_registrations
     set status = 'cancelled', cancelled_at = v_now, refund_due = (amount_cents > 0 and status = 'registered')
   where event_id = p_id and status in ('registered', 'pending_payment');
  return app.ap_event_json(p_id);
end $$;

create or replace function public.appointments_register(p_event_id uuid, p_client_id uuid default null, p_method text default 'comp') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor(p_client_id);
  v_client uuid;
  e public.studio_events;
  v_now timestamptz := app.now();
  v_start timestamptz; v_end timestamptz;
  v_method text;
  v_sale uuid;
  v_id uuid;
  v_taken int;
begin
  perform app.assert_in_studio('studio_events', p_event_id, 'We couldn''t find that event.');
  perform app.assert_studio_open(v.studio);
  v_client := app.ap_resolve_client(v, p_client_id, 'register');
  select * into e from public.studio_events where id = p_event_id and studio_id = v.studio for update;
  if e.id is null or e.cancelled or (not v.as_staff and not e.published) then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
  select min(starts_at), max(ends_at) into v_start, v_end from public.studio_event_sessions where event_id = e.id;
  if not v.as_staff and v_now >= v_start then perform app.fail('TOO_LATE', 'Sign-up closed when it started.'); end if;
  if v_now >= v_end then perform app.fail('TOO_LATE', 'That one has finished.'); end if;
  perform app.ap_release_holds(v.studio);
  if exists (select 1 from public.studio_event_registrations where event_id = e.id and client_id = v_client and status in ('registered', 'pending_payment')) then
    perform app.fail('ALREADY_BOOKED', 'You''re already registered.');
  end if;
  select count(*) into v_taken from public.studio_event_registrations where event_id = e.id and status in ('registered', 'pending_payment');
  if v_taken >= e.capacity then perform app.fail('EVENT_FULL', 'Sorry, that one is full.'); end if;
  if not v.as_staff and (select waiver_signed_at from public.clients where id = v_client) is null then
    perform app.fail('WAIVER_REQUIRED', 'Please complete your waiver and health form before booking.');
  end if;

  v_method := case when e.price_cents = 0 then 'comp' else p_method end;
  if e.price_cents > 0 then
    perform app.ap_check_method(v, v_method, false);
    v_sale := app.ap_make_sale(v.studio, v_client, v.staff_id, e.title, 1, e.price_cents, v_method, case when e.kind = 'course' then 'Course' else 'Workshop / event' end);
  end if;
  insert into public.studio_event_registrations (studio_id, event_id, client_id, status, pay_method, amount_cents, sale_id)
  values (v.studio, e.id, v_client, 'registered', v_method, case when v_method = 'comp' then 0 else e.price_cents end, v_sale)
  returning id into v_id;
  return jsonb_strip_nulls(jsonb_build_object('registration', app.ap_reg_json(v_id), 'sale', case when v_sale is not null then app.sale_json(v_sale) end));
end $$;

create or replace function public.appointments_cancel_registration(p_id uuid, p_waive_penalty boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t; r public.studio_event_registrations; e public.studio_events;
  v_now timestamptz := app.now(); v_start timestamptz; v_late boolean; v_refund boolean;
begin
  perform app.assert_in_studio('studio_event_registrations', p_id, 'We couldn''t find that registration.');
  select * into r from public.studio_event_registrations where id = p_id for update;
  if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that registration.'); end if;
  select * into e from public.studio_events where id = r.event_id;
  v := app.ap_actor(r.client_id);
  if not v.as_staff then
    if r.client_id <> v.client_id and not app.is_guardian_of(r.client_id) then perform app.fail('NOT_FOUND', 'We couldn''t find that registration.'); end if;
    if p_waive_penalty then perform app.fail('NOT_ALLOWED', 'Only staff can waive the cancellation policy.'); end if;
  else
    perform app.ap_require(v, 'book');
  end if;
  if r.status <> 'registered' then perform app.fail('INVALID', 'This registration can''t be cancelled.'); end if;
  select min(starts_at) into v_start from public.studio_event_sessions where event_id = e.id;
  if not v.as_staff and v_now >= v_start then perform app.fail('TOO_LATE', 'It has already started.'); end if;
  v_late := v_now > v_start - (e.refund_cutoff_hours * interval '1 hour') and not coalesce(p_waive_penalty, false);
  v_refund := not v_late and r.amount_cents > 0;
  update public.studio_event_registrations
     set status = case when v_late then 'late_cancelled' else 'cancelled' end, cancelled_at = v_now, refund_due = v_refund
   where id = r.id;
  return jsonb_build_object('registration', app.ap_reg_json(r.id), 'refundDue', v_refund, 'late', v_late);
end $$;

-- A client's own sign-ups, or an event's attendee list (the host and the front desk).
create or replace function public.appointments_list_registrations(p_client_id uuid default null, p_event_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(p_client_id); e public.studio_events; v_client uuid;
begin
  if p_event_id is not null then
    if not v.as_staff then perform app.fail('NOT_ALLOWED', 'Only staff can see attendee lists.'); end if;
    perform app.assert_in_studio('studio_events', p_event_id, 'We couldn''t find that event.');
    select * into e from public.studio_events where id = p_event_id and studio_id = v.studio;
    if e.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
    if not app.ap_can(v, 'book') and e.host_staff_id is distinct from v.staff_id then
      perform app.fail('NOT_ALLOWED', 'Only the host and the front desk can see who''s coming.');
    end if;
    return coalesce((select jsonb_agg(app.ap_reg_json(r.id) order by c.last_name, c.first_name, r.id)
                       from public.studio_event_registrations r join public.clients c on c.id = r.client_id
                      where r.event_id = p_event_id and r.status <> 'pending_payment'), '[]'::jsonb);
  end if;
  v_client := case when v.as_staff then p_client_id else v.client_id end;
  if v_client is null then perform app.fail('INVALID', 'Choose a client.'); end if;
  if not v.as_staff and p_client_id is not null and p_client_id <> v.client_id and not app.is_guardian_of(p_client_id) then
    perform app.fail('NOT_ALLOWED', 'You can only see your own sign-ups.');
  end if;
  -- a client's own list includes their dependants' (family accounts)
  return coalesce((select jsonb_agg(app.ap_reg_json(r.id) order by r.created_at, r.id)
                     from public.studio_event_registrations r
                    where r.studio_id = v.studio and r.status <> 'pending_payment'
                      and (r.client_id = v_client or (not v.as_staff and v_client = v.client_id and app.is_guardian_of(r.client_id)))), '[]'::jsonb);
end $$;

create or replace function public.appointments_set_attendance(p_registration_id uuid, p_session_starts_at timestamptz, p_present boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); r public.studio_event_registrations; e public.studio_events;
begin
  perform app.assert_in_studio('studio_event_registrations', p_registration_id, 'We couldn''t find that registration.');
  if v.staff_id is null then perform app.fail('NOT_ALLOWED', 'Only staff can take attendance.'); end if;
  select * into r from public.studio_event_registrations where id = p_registration_id for update;
  if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that registration.'); end if;
  select * into e from public.studio_events where id = r.event_id;
  if not app.ap_can(v, 'book') and e.host_staff_id is distinct from v.staff_id then
    perform app.fail('NOT_ALLOWED', 'Only the host and the front desk can take attendance.');
  end if;
  if not exists (select 1 from public.studio_event_sessions where event_id = e.id and starts_at = p_session_starts_at) then
    perform app.fail('INVALID', 'That isn''t one of the dates.');
  end if;
  if r.status <> 'registered' then perform app.fail('INVALID', 'This registration was cancelled.'); end if;
  update public.studio_event_registrations
     set attended = case when p_present then (select coalesce(array_agg(distinct x order by x), '{}') from unnest(attended || p_session_starts_at) x)
                         else array_remove(attended, p_session_starts_at) end
   where id = r.id;
  return app.ap_reg_json(r.id);
end $$;

-- After refunding the sale (Sales screen or Stripe), clear the "refund due" flag.
create or replace function public.appointments_mark_refunded(p_appointment_id uuid default null, p_registration_id uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor();
begin
  perform app.ap_require(v, 'book');
  if p_appointment_id is not null then
    perform app.assert_in_studio('appointments', p_appointment_id, 'We couldn''t find that appointment.');
    update public.appointments set refund_due = false where id = p_appointment_id and studio_id = v.studio;
    if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that appointment.'); end if;
  elsif p_registration_id is not null then
    perform app.assert_in_studio('studio_event_registrations', p_registration_id, 'We couldn''t find that registration.');
    update public.studio_event_registrations set refund_due = false where id = p_registration_id and studio_id = v.studio;
    if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that registration.'); end if;
  else
    perform app.fail('INVALID', 'Choose an appointment or a registration.');
  end if;
end $$;

-- ----------------------------------------------------------------------------- grants
-- Our app.ap_* helpers are internal: only the security-definer RPCs (and the service role) call them.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname like 'ap\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

revoke execute on function
  public.appointments_update_settings, public.appointments_list_types, public.appointments_upsert_type, public.appointments_upsert_pack,
  public.appointments_set_availability, public.appointments_add_time_off, public.appointments_remove_time_off, public.appointments_list_slots,
  public.appointments_book, public.appointments_cancel, public.appointments_set_status, public.appointments_list, public.appointments_buy_pack,
  public.appointments_list_credits, public.appointments_list_events, public.appointments_get_event, public.appointments_upsert_event,
  public.appointments_cancel_event, public.appointments_register, public.appointments_cancel_registration, public.appointments_list_registrations,
  public.appointments_set_attendance, public.appointments_mark_refunded
  from public, anon;
grant execute on function
  public.appointments_update_settings, public.appointments_list_types, public.appointments_upsert_type, public.appointments_upsert_pack,
  public.appointments_set_availability, public.appointments_add_time_off, public.appointments_remove_time_off, public.appointments_list_slots,
  public.appointments_book, public.appointments_cancel, public.appointments_set_status, public.appointments_list, public.appointments_buy_pack,
  public.appointments_list_credits, public.appointments_list_events, public.appointments_get_event, public.appointments_upsert_event,
  public.appointments_cancel_event, public.appointments_register, public.appointments_cancel_registration, public.appointments_list_registrations,
  public.appointments_set_attendance, public.appointments_mark_refunded
  to authenticated;
grant execute on all functions in schema public to service_role;
