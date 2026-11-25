-- Privates and events: a studio can switch the whole client-facing page off (and back on) from Settings › Appointments.
-- appointment_settings.client_enabled (default on). Off hides the Profile entry, the timetable banner and the screen in the client app;
-- staff still see and manage anything already booked. Snowy has it off for now (not on offer; Libby can turn it back on herself).

alter table public.appointment_settings add column client_enabled boolean not null default true;

create or replace function app.ap_settings(p_studio uuid) returns public.appointment_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select s from public.appointment_settings s where s.studio_id = p_studio),
    row(p_studio, 30, 4, 28, 12, 24, true)::public.appointment_settings)
$$;

drop function public.appointments_update_settings(int, int, int, int, int);
create or replace function public.appointments_update_settings(
  p_slot_step_min int, p_min_notice_hours int, p_horizon_days int, p_waitlist_claim_hours int default null, p_reminder_hours int default null,
  p_client_enabled boolean default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); v_claim int; v_remind int; v_on boolean;
begin
  perform app.ap_require(v, 'manage');
  v_claim := coalesce(p_waitlist_claim_hours, (app.ap_settings(v.studio)).waitlist_claim_hours);
  v_remind := coalesce(p_reminder_hours, (app.ap_settings(v.studio)).reminder_hours);
  v_on := coalesce(p_client_enabled, (app.ap_settings(v.studio)).client_enabled);
  if not (p_slot_step_min between 5 and 120) then perform app.fail('INVALID', 'Slots can start every 5 to 120 minutes.'); end if;
  if not (p_min_notice_hours between 0 and 336) then perform app.fail('INVALID', 'Minimum notice can be 0 to 336 hours.'); end if;
  if not (p_horizon_days between 1 and 365) then perform app.fail('INVALID', 'Clients can book 1 to 365 days ahead.'); end if;
  if not (v_claim between 1 and 72) then perform app.fail('INVALID', 'A waitlist offer can be open for 1 to 72 hours.'); end if;
  if v_remind not in (2, 12, 24, 48) then perform app.fail('INVALID', 'Reminders can go out 2, 12, 24 or 48 hours before.'); end if;
  insert into public.appointment_settings (studio_id, slot_step_min, min_notice_hours, horizon_days, waitlist_claim_hours, reminder_hours, client_enabled)
  values (v.studio, p_slot_step_min, p_min_notice_hours, p_horizon_days, v_claim, v_remind, v_on)
  on conflict (studio_id) do update set slot_step_min = excluded.slot_step_min, min_notice_hours = excluded.min_notice_hours,
    horizon_days = excluded.horizon_days, waitlist_claim_hours = excluded.waitlist_claim_hours, reminder_hours = excluded.reminder_hours,
    client_enabled = excluded.client_enabled;
  return jsonb_build_object('slotStepMin', p_slot_step_min, 'minNoticeHours', p_min_notice_hours, 'horizonDays', p_horizon_days,
                            'waitlistClaimHours', v_claim, 'reminderHours', v_remind, 'clientEnabled', v_on);
end $$;
revoke execute on function public.appointments_update_settings from public, anon;
grant execute on function public.appointments_update_settings to authenticated;

-- Snowy: privates and events are off for now. (A studio with no settings row yet gets one; a new studio is unaffected.)
insert into public.appointment_settings (studio_id, client_enabled)
select id, false from public.studios where slug = 'snowy'
on conflict (studio_id) do update set client_enabled = false;

-- Snowy's welcome and scrolling phrases (Libby's wording). Studios edit these in Settings › Branding; this is the one-off change.
update public.studios set branding = (branding - 'shopMarquee')
  || jsonb_build_object('marquee', jsonb_build_array('Join the club', 'Cooma''s home of Pilates', 'Build strength from the inside out',
                                                   'Classes are designed for every body', 'Beginners welcome (and encouraged)'))
  || jsonb_build_object('welcome', (branding -> 'welcome')
       || jsonb_build_object('headline', '', 'copy', 'Book (or cancel) classes, manage your passes and keep your health info up to date, all in one place.'))
 where slug = 'snowy' and branding ? 'welcome';
