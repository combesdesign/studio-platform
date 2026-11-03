-- "You're on the waitlist" for events, like classes have (waitlist_joined). Joining the waitlist for a full workshop, course or event
-- now queues an `event_waitlisted` email (editable in Settings > Emails like the other event emails). One per person per event
-- turn in line: the dedupe key is the waitlist row, so a repeat call can't send it twice.

alter table public.appointments_outbox drop constraint appointments_outbox_kind_check;
alter table public.appointments_outbox add constraint appointments_outbox_kind_check
  check (kind in ('appointment_confirmed', 'appointment_cancelled', 'appointment_reminder', 'appointment_moved',
                  'event_registered', 'event_cancelled', 'event_reminder', 'event_waitlisted', 'waitlist_offer'));

create or replace function app.editable_email_kinds() returns text[]
language sql immutable as $$
  select array['booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome',
               'receipt', 'gift_card', 'appointment_confirmed', 'appointment_cancelled', 'appointment_moved', 'appointment_reminder',
               'event_registered', 'event_cancelled', 'event_reminder', 'event_waitlisted', 'waitlist_offer', 'message_reply']
$$;

create function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;

-- "Send me a test" goes through the appointments outbox for event kinds
select app.patch_function('public.send_test_email(text)'::regprocedure,
  $q$'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer') then$q$,
  $q$'event_registered', 'event_cancelled', 'event_reminder', 'event_waitlisted', 'waitlist_offer') then$q$);

create or replace function app.ap_queue_waitlist_joined(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n int;
begin
  select w.id, w.studio_id, w.client_id, c.email, c.first_name,
         e.id as event_id, e.title, e.kind as event_kind, e.location, e.price_cents, e.refund_cutoff_hours,
         sd.timezone, ss.cancellation_policy_text,
         (select count(*) from public.studio_event_sessions s where s.event_id = e.id) as session_count,
         (select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id) as first_at,
         (select count(*) from public.studio_event_waitlist x where x.event_id = w.event_id and x.status in ('waiting', 'offered')
             and (x.created_at, x.id) <= (w.created_at, w.id)) as position
    into r
    from public.studio_event_waitlist w
    join public.studio_events e on e.id = w.event_id
    join public.clients c on c.id = w.client_id
    join public.studios sd on sd.id = w.studio_id
    left join public.studio_settings ss on ss.studio_id = w.studio_id
   where w.id = p_id;
  if r.id is null or coalesce(r.email, '') = '' then return false; end if;
  insert into public.appointments_outbox (studio_id, kind, client_id, to_email, dedupe_key, payload)
  values (r.studio_id, 'event_waitlisted', r.client_id, r.email, 'waitlisted:' || r.id, jsonb_strip_nulls(jsonb_build_object(
    'waitlist_id', r.id, 'event_id', r.event_id, 'first_name', r.first_name, 'title', r.title, 'event_kind', r.event_kind, 'location', r.location,
    'starts_at', r.first_at, 'when', app.fmt_when_tz(r.first_at, r.timezone), 'sessions', r.session_count, 'amount_cents', r.price_cents,
    'position', r.position, 'cancellation_policy', r.cancellation_policy_text, 'refund_cutoff_hours', r.refund_cutoff_hours)))
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

select app.patch_function('public.appointments_join_waitlist(uuid, uuid)'::regprocedure,
  $q$insert into public.studio_event_waitlist (studio_id, event_id, client_id) values (v.studio, e.id, v_client) returning id into v_id;$q$,
  $q$insert into public.studio_event_waitlist (studio_id, event_id, client_id) values (v.studio, e.id, v_client) returning id into v_id;
  perform app.ap_queue_waitlist_joined(v_id);$q$);

drop function app.patch_function(regprocedure, text, text);
