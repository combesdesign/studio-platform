-- Appointments: the reminder lead time is a studio setting.
--
-- appointment_settings.reminder_hours (2, 12, 24 or 48; default 24) is how long before an appointment, workshop or event session the
-- reminder email goes out. appointments_queue_reminders() (run every few minutes by the email drain) reads each studio's own setting;
-- passing p_hours forces one lead time for every studio (the tests do).

-- Fix: a signed-in client has no staff role (null), and `null in (...)` is null, not false, so `if not ap_can(...)` never raised and a
-- client could call the staff-only RPCs (settings, session types, packs, events). Staff checks now treat "no role" as "not allowed".
create or replace function app.ap_can(p_actor app.ap_actor_t, p_what text) returns boolean
language sql immutable as $$
  select coalesce(case p_what
    when 'manage' then p_actor.role in ('owner', 'manager')
    when 'book' then p_actor.role in ('owner', 'manager', 'front_desk')
    else p_actor.role is not null end, false)
$$;

alter table public.appointment_settings
  add column reminder_hours integer not null default 24 check (reminder_hours in (2, 12, 24, 48));

create or replace function app.ap_settings(p_studio uuid) returns public.appointment_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select s from public.appointment_settings s where s.studio_id = p_studio),
    row(p_studio, 30, 4, 28, 12, 24)::public.appointment_settings)
$$;

drop function public.appointments_update_settings(int, int, int, int);
create or replace function public.appointments_update_settings(
  p_slot_step_min int, p_min_notice_hours int, p_horizon_days int, p_waitlist_claim_hours int default null, p_reminder_hours int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); v_claim int; v_remind int;
begin
  perform app.ap_require(v, 'manage');
  v_claim := coalesce(p_waitlist_claim_hours, (app.ap_settings(v.studio)).waitlist_claim_hours);
  v_remind := coalesce(p_reminder_hours, (app.ap_settings(v.studio)).reminder_hours);
  if not (p_slot_step_min between 5 and 120) then perform app.fail('INVALID', 'Slots can start every 5 to 120 minutes.'); end if;
  if not (p_min_notice_hours between 0 and 336) then perform app.fail('INVALID', 'Minimum notice can be 0 to 336 hours.'); end if;
  if not (p_horizon_days between 1 and 365) then perform app.fail('INVALID', 'Clients can book 1 to 365 days ahead.'); end if;
  if not (v_claim between 1 and 72) then perform app.fail('INVALID', 'A waitlist offer can be open for 1 to 72 hours.'); end if;
  if v_remind not in (2, 12, 24, 48) then perform app.fail('INVALID', 'Reminders can go out 2, 12, 24 or 48 hours before.'); end if;
  insert into public.appointment_settings (studio_id, slot_step_min, min_notice_hours, horizon_days, waitlist_claim_hours, reminder_hours)
  values (v.studio, p_slot_step_min, p_min_notice_hours, p_horizon_days, v_claim, v_remind)
  on conflict (studio_id) do update set slot_step_min = excluded.slot_step_min, min_notice_hours = excluded.min_notice_hours,
    horizon_days = excluded.horizon_days, waitlist_claim_hours = excluded.waitlist_claim_hours, reminder_hours = excluded.reminder_hours;
  return jsonb_build_object('slotStepMin', p_slot_step_min, 'minNoticeHours', p_min_notice_hours, 'horizonDays', p_horizon_days,
                            'waitlistClaimHours', v_claim, 'reminderHours', v_remind);
end $$;

-- Queue "see you soon" emails for appointments and event sessions starting within each studio's reminder lead time (each queued once).
create or replace function public.appointments_queue_reminders(p_hours numeric default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; r record; v_now timestamptz := app.now(); n int := 0; v_hours numeric;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for s in select id from public.studios where status <> 'suspended' loop
    perform app.use_studio(s.id);
    v_hours := coalesce(p_hours, (app.ap_settings(s.id)).reminder_hours);   -- the studio's own lead time unless one is forced
    for r in select a.id from public.appointments a
              where a.studio_id = s.id and a.status = 'booked' and a.starts_at > v_now and a.starts_at <= v_now + make_interval(secs => v_hours * 3600)
    loop
      if app.ap_queue_appointment(r.id, 'appointment_reminder', 'reminder:' || r.id) then n := n + 1; end if;
    end loop;
    for r in select g.id, es.starts_at from public.studio_event_registrations g
              join public.studio_event_sessions es on es.event_id = g.event_id
              join public.studio_events e on e.id = g.event_id
              where g.studio_id = s.id and g.status = 'registered' and not e.cancelled
                and es.starts_at > v_now and es.starts_at <= v_now + make_interval(secs => v_hours * 3600)
    loop
      if app.ap_queue_registration(r.id, 'event_reminder', 'reminder:' || r.id || ':' || extract(epoch from r.starts_at)::bigint, r.starts_at) then n := n + 1; end if;
    end loop;
  end loop;
  perform app.use_studio(null);
  return n;
end $$;

revoke execute on function public.appointments_update_settings from public, anon;
grant execute on function public.appointments_update_settings to authenticated;
revoke execute on function public.appointments_queue_reminders(numeric) from public, anon, authenticated;
grant execute on function public.appointments_queue_reminders(numeric) to service_role;
grant execute on all functions in schema public to service_role;
