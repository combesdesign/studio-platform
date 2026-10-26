-- Appointments: moving an appointment to another free time in one step.
--
-- A client (or the front desk) moves a booked appointment to another open time for the SAME session type, with the same instructor or
-- any other who offers it. It is one update of the existing row, not a cancel and a rebook: the same appointment keeps its payment
-- (the sale, or the pack credits) and its history, nothing is refunded or charged, and the client gets a "moved" email.
-- Clients can move while the appointment is still outside the studio's cancellation window (studio_settings.cancel_window_hours, the
-- same line cancelling uses); the front desk can move at any time. The new time has to be a real open slot under the usual rules
-- (minimum notice, horizon, hours, time off, other appointments, classes), and the appointment's own current time doesn't block it.

-- ----------------------------------------------------------------------------- open slots, ignoring one appointment
-- ap_slots with an optional appointment to leave out (the one being moved), so a move to 30 minutes later isn't blocked by itself.
drop function app.ap_slots(uuid, uuid, date, date, uuid, boolean, timestamptz);
create or replace function app.ap_slots(
  p_studio uuid, p_type uuid, p_from date, p_to date, p_staff uuid, p_as_staff boolean, p_now timestamptz, p_exclude uuid default null
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
                      where a.staff_id = c.sid and a.id is distinct from p_exclude
                        and (a.status in ('booked', 'completed', 'no_show') or (a.status = 'pending_payment' and a.hold_expires_at > p_now))
                        and c.s < a.ends_at + make_interval(mins => a.buffer_min)
                        and a.starts_at < c.s + make_interval(mins => t.duration_min + t.buffer_min))
     and not exists (select 1 from public.class_sessions cs
                      where cs.instructor_id = c.sid and cs.status <> 'cancelled'
                        and c.s < cs.ends_at and cs.starts_at < c.s + make_interval(mins => t.duration_min + t.buffer_min))
   order by c.s, c.sid;
end $$;

drop function public.appointments_list_slots(uuid, date, date, uuid);
create or replace function public.appointments_list_slots(
  p_type_id uuid, p_from date, p_to date, p_staff_id uuid default null, p_exclude_appointment uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); v_exclude uuid;
begin
  perform app.assert_in_studio('appointment_types', p_type_id, 'We couldn''t find that session.');
  if not exists (select 1 from public.appointment_types where id = p_type_id and studio_id = v.studio and (active or v.as_staff)) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that session.');
  end if;
  -- only your own appointment (or your family's, or any for staff) can be left out of the busy times
  select a.id into v_exclude from public.appointments a
   where a.id = p_exclude_appointment and a.studio_id = v.studio and (v.as_staff or a.client_id = v.client_id or app.is_guardian_of(a.client_id));
  return coalesce((
    select jsonb_agg(jsonb_build_object('typeId', p_type_id, 'staffId', s.staff_id, 'startsAt', app.ap_iso(s.starts_at), 'endsAt', app.ap_iso(s.ends_at)) order by s.starts_at, s.staff_id)
      from app.ap_slots(v.studio, p_type_id, p_from, p_to, p_staff_id, v.as_staff, app.now(), v_exclude) s), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- the move
create or replace function public.appointments_move(p_id uuid, p_starts_at timestamptz, p_staff_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t;
  a public.appointments;
  t public.appointment_types;
  v_now timestamptz := app.now();
  v_window numeric;
  v_staff uuid;
  v_day date;
begin
  perform app.assert_in_studio('appointments', p_id, 'We couldn''t find that appointment.');
  select * into a from public.appointments where id = p_id for update;
  if a.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that appointment.'); end if;
  v := app.ap_actor(a.client_id);
  if not v.as_staff then
    if a.client_id <> v.client_id and not app.is_guardian_of(a.client_id) then perform app.fail('NOT_FOUND', 'We couldn''t find that appointment.'); end if;
  else
    perform app.ap_require(v, 'book');
  end if;
  perform app.assert_studio_open(a.studio_id);
  if a.status <> 'booked' then perform app.fail('INVALID', 'This appointment can''t be moved.'); end if;
  if not v.as_staff then
    if v_now >= a.starts_at then perform app.fail('TOO_LATE', 'This session has already started.'); end if;
    select cancel_window_hours into v_window from public.studio_settings where studio_id = a.studio_id;
    if v_now > a.starts_at - (coalesce(v_window, 0) * interval '1 hour') then
      perform app.fail('TOO_LATE', 'It''s inside the cancellation window, so it can''t be moved online. Please contact the studio.');
    end if;
  end if;
  select * into t from public.appointment_types where id = a.type_id and studio_id = a.studio_id;
  if t.id is null or (not t.active and not v.as_staff) then perform app.fail('NOT_FOUND', 'We couldn''t find that session.'); end if;
  v_staff := coalesce(p_staff_id, a.staff_id);
  if p_starts_at is null then perform app.fail('INVALID', 'Choose a new time.'); end if;
  if v_staff = a.staff_id and p_starts_at = a.starts_at then perform app.fail('INVALID', 'That is the time you already have.'); end if;

  perform pg_advisory_xact_lock(hashtextextended('appointments:' || v_staff::text, 0));
  perform app.ap_release_holds(a.studio_id);
  v_day := (p_starts_at at time zone app.studio_tz(a.studio_id))::date;
  if not exists (select 1 from app.ap_slots(a.studio_id, a.type_id, v_day, v_day, v_staff, v.as_staff, v_now, a.id) s
                  where s.starts_at = p_starts_at and s.staff_id = v_staff) then
    perform app.fail('SLOT_TAKEN', 'That time isn''t available any more. Please pick another.');
  end if;
  if exists (select 1 from public.appointments where client_id = a.client_id and id <> a.id and starts_at = p_starts_at and status in ('booked', 'pending_payment')) then
    perform app.fail('ALREADY_BOOKED', 'You already have a session at that time.');
  end if;
  -- pack credits keep paying for it, as long as they haven't run out by then
  if a.pay_method = 'pack' and exists (
       select 1 from jsonb_array_elements(a.credit_uses) u join public.appointment_credits c on c.id = (u ->> 'creditId')::uuid
        where c.expires_at is not null and c.expires_at <= p_starts_at) then
    perform app.fail('CREDIT_EXPIRES', 'Your pack runs out before that time. Please pick an earlier one.');
  end if;

  begin
    update public.appointments
       set starts_at = p_starts_at, ends_at = p_starts_at + make_interval(mins => t.duration_min), staff_id = v_staff, buffer_min = t.buffer_min
     where id = a.id;
  exception when unique_violation then
    perform app.fail('SLOT_TAKEN', 'That time isn''t available any more. Please pick another.');
  end;
  -- a reminder already sent for the old time shouldn't stop one for the new time
  update public.appointments_outbox set dedupe_key = dedupe_key || ':moved:' || gen_random_uuid() where studio_id = a.studio_id and dedupe_key = 'reminder:' || a.id;
  return app.ap_appt_json(a.id);
end $$;

-- ----------------------------------------------------------------------------- the "moved" email
alter table public.appointments_outbox drop constraint appointments_outbox_kind_check;
alter table public.appointments_outbox add constraint appointments_outbox_kind_check
  check (kind in ('appointment_confirmed', 'appointment_cancelled', 'appointment_reminder', 'appointment_moved',
                  'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer'));

-- ap_queue_appointment with extra payload fields (the old time, for "moved").
drop function app.ap_queue_appointment(uuid, text, text);
create or replace function app.ap_queue_appointment(p_appt_id uuid, p_kind text, p_dedupe text default null, p_extra jsonb default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n int;
begin
  select a.id, a.studio_id, a.client_id, a.starts_at, a.ends_at, a.type_name, a.people, a.note, a.status, a.pay_method, a.amount_cents,
         c.email, c.first_name, st.name as staff_name, sd.timezone, ss.cancellation_policy_text, ss.cancel_window_hours
    into r
    from public.appointments a
    join public.clients c on c.id = a.client_id
    join public.studios sd on sd.id = a.studio_id
    left join public.staff st on st.id = a.staff_id
    left join public.studio_settings ss on ss.studio_id = a.studio_id
   where a.id = p_appt_id;
  if r.id is null or coalesce(r.email, '') = '' then return false; end if;
  insert into public.appointments_outbox (studio_id, kind, client_id, to_email, dedupe_key, payload)
  values (r.studio_id, p_kind, r.client_id, r.email, p_dedupe, jsonb_strip_nulls(jsonb_build_object(
    'appointment_id', r.id, 'first_name', r.first_name, 'title', r.type_name, 'starts_at', r.starts_at,
    'when', app.fmt_when_tz(r.starts_at, r.timezone), 'staff', r.staff_name, 'people', r.people, 'note', r.note,
    'cancellation_policy', r.cancellation_policy_text, 'cancel_window_hours', r.cancel_window_hours,
    'late', r.status = 'late_cancelled',
    'credit_returned', r.status = 'cancelled' and r.pay_method = 'pack',
    'refund_due', r.status = 'cancelled' and r.pay_method <> 'pack' and r.amount_cents > 0,
    'amount_cents', r.amount_cents, 'paid_by', r.pay_method) || coalesce(p_extra, '{}'::jsonb)))
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function app.ap_appt_email_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'booked' then perform app.ap_queue_appointment(new.id, 'appointment_confirmed', 'confirmed:' || new.id); end if;
  elsif old.status is distinct from new.status then
    if new.status = 'booked' and old.status = 'pending_payment' then
      perform app.ap_queue_appointment(new.id, 'appointment_confirmed', 'confirmed:' || new.id);
    elsif new.status in ('cancelled', 'late_cancelled') and old.status = 'booked' then
      perform app.ap_queue_appointment(new.id, 'appointment_cancelled', 'cancelled:' || new.id);
    end if;
  elsif new.status = 'booked' and (old.starts_at is distinct from new.starts_at or old.staff_id is distinct from new.staff_id) then
    perform app.ap_queue_appointment(new.id, 'appointment_moved', 'moved:' || new.id || ':' || gen_random_uuid(),   -- every move is its own email
      jsonb_build_object('previous_starts_at', old.starts_at,
                         'previous_when', app.fmt_when_tz(old.starts_at, (select timezone from public.studios where id = new.studio_id)),
                         'previous_staff', (select name from public.staff where id = old.staff_id)));
  end if;
  return null;
end $$;
drop trigger ap_appt_email on public.appointments;
create trigger ap_appt_email after insert or update of status, starts_at, staff_id on public.appointments
  for each row execute function app.ap_appt_email_trigger();

-- ----------------------------------------------------------------------------- grants
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

revoke execute on function public.appointments_list_slots, public.appointments_move from public, anon;
grant execute on function public.appointments_list_slots, public.appointments_move to authenticated;
grant execute on all functions in schema public to service_role;
