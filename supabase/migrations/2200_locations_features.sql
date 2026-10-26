-- Multi-location and rooms, part 2 (after the feature migrations, which this builds on):
--   * sessions_with_counts carries location_id and room_id (1703's definition, plus the two columns)
--   * appointments and studio_events get nullable location_id / room_id too
--   * the room clash check (0013) now also looks at appointments and event sessions, and they are checked too

create or replace view public.sessions_with_counts as
select s.id, s.class_type_id, s.template_id, s.starts_at, s.ends_at, s.instructor_id, s.capacity,
       s.status, s.note, s.cancel_reason, s.updated_at, s.studio_id,
       coalesce(c.booked, 0)::int as booked_count,
       coalesce(c.waitlisted, 0)::int as waitlist_count,
       greatest(0, s.capacity - coalesce(c.booked, 0)
                   - case when public.current_staff_id() is null then app.held_back_spots(s.id) else 0 end)::int as spots_left,   -- held
       s.location_id, s.room_id
  from public.class_sessions s
  left join lateral (
    select count(*) filter (where b.status in ('booked','checked_in')) as booked,
           count(*) filter (where b.status = 'waitlisted') as waitlisted
      from public.bookings b where b.session_id = s.id
  ) c on true
 where s.studio_id = app.current_studio_id();

alter table public.appointments add column location_id uuid, add column room_id uuid;
alter table public.studio_events add column location_id uuid, add column room_id uuid;
alter table public.appointments
  add constraint appointments_place_check check (room_id is null or location_id is not null),
  add constraint appointments_location_same_studio foreign key (studio_id, location_id) references public.locations (studio_id, id),
  add constraint appointments_room_in_location foreign key (location_id, room_id) references public.rooms (location_id, id);
alter table public.studio_events
  add constraint events_place_check check (room_id is null or location_id is not null),
  add constraint events_location_same_studio foreign key (studio_id, location_id) references public.locations (studio_id, id),
  add constraint events_room_in_location foreign key (location_id, room_id) references public.rooms (location_id, id);
create index appointments_room_idx on public.appointments (room_id, starts_at) where room_id is not null;
create index studio_events_room_idx on public.studio_events (room_id) where room_id is not null;

-- classes, then appointments, then event sessions
create or replace function app.room_clash(p_room uuid, p_start timestamptz, p_end timestamptz, p_skip_class uuid default null,
                                          p_skip_appt uuid default null, p_skip_event_session uuid default null) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select r.name || ' is already booked at ' || lower(to_char(s.starts_at at time zone app.studio_tz(s.studio_id), 'FMHH12:MIam')) || ' for ' || ct.name || '. Pick another room or time.'
       from public.class_sessions s
       join public.rooms r on r.id = s.room_id
       join public.class_types ct on ct.id = s.class_type_id
      where s.room_id = p_room and s.status = 'scheduled' and s.id is distinct from p_skip_class
        and s.starts_at < p_end and p_start < s.ends_at
      limit 1),
    (select r.name || ' is already booked at ' || lower(to_char(a.starts_at at time zone app.studio_tz(a.studio_id), 'FMHH12:MIam')) || ' for an appointment. Pick another room or time.'
       from public.appointments a
       join public.rooms r on r.id = a.room_id
      where a.room_id = p_room and a.status in ('booked','completed','no_show','pending_payment') and a.id is distinct from p_skip_appt
        and a.starts_at < p_end and p_start < a.ends_at
      limit 1),
    (select r.name || ' is already booked at ' || lower(to_char(es.starts_at at time zone app.studio_tz(es.studio_id), 'FMHH12:MIam')) || ' for ' || e.title || '. Pick another room or time.'
       from public.studio_event_sessions es
       join public.studio_events e on e.id = es.event_id
       join public.rooms r on r.id = e.room_id
      where e.room_id = p_room and not e.cancelled and es.id is distinct from p_skip_event_session
        and es.starts_at < p_end and p_start < es.ends_at
      limit 1))
$$;

create or replace function app.check_appointment_room() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text;
begin
  if new.room_id is null or new.status not in ('booked','completed','no_show','pending_payment') then return new; end if;
  if tg_op = 'UPDATE' and old.room_id is not distinct from new.room_id and old.starts_at = new.starts_at and old.ends_at = new.ends_at and old.status = new.status then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));
  v_msg := app.room_clash(new.room_id, new.starts_at, new.ends_at, null, new.id);
  if v_msg is not null then perform app.fail('ROOM_BUSY', v_msg); end if;
  return new;
end $$;
create trigger appointments_room_free before insert or update on public.appointments for each row execute function app.check_appointment_room();

-- an event session is checked against the room of its event; moving the event to another room re-checks all its sessions
create or replace function app.check_event_session_room() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room uuid; v_cancelled boolean; v_msg text;
begin
  select room_id, cancelled into v_room, v_cancelled from public.studio_events where id = new.event_id;
  if v_room is null or v_cancelled then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));
  v_msg := app.room_clash(v_room, new.starts_at, new.ends_at, null, null, new.id);
  if v_msg is not null then perform app.fail('ROOM_BUSY', v_msg); end if;
  return new;
end $$;
create trigger event_sessions_room_free before insert or update of starts_at, ends_at on public.studio_event_sessions for each row execute function app.check_event_session_room();

create or replace function app.check_event_room() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; v_msg text;
begin
  if new.room_id is null or new.cancelled then return new; end if;
  if old.room_id is not distinct from new.room_id and old.cancelled = new.cancelled then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));
  for s in select id, starts_at, ends_at from public.studio_event_sessions where event_id = new.id loop
    -- the event's own sessions are not a clash with each other, and it isn't in the table with its new room yet
    v_msg := app.room_clash(new.room_id, s.starts_at, s.ends_at, null, null, s.id);
    if v_msg is not null then perform app.fail('ROOM_BUSY', v_msg); end if;
  end loop;
  return new;
end $$;
create trigger events_room_free before update on public.studio_events for each row execute function app.check_event_room();
