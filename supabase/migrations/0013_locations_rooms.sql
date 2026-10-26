-- Multi-location and rooms (ROADMAP B5). A studio can have several locations, each with rooms; classes, weekly slots (and, from 2200,
-- appointments and events) happen in a room at a location.
--
--   * locations / rooms: per studio, RLS like class_types (everyone in the studio reads active ones, owners and managers write, never delete).
--   * location_id / room_id on class_sessions and schedule_templates are NULLABLE. Null means "the studio's default location, no particular
--     room", so a one-location studio never sets or sees any of this. Every studio gets one default location + room (backfilled below,
--     and made for each new studio by a trigger).
--   * A room can't be used by two classes at once: trigger app.check_room_free (ROOM_BUSY), under a per-room advisory lock so two
--     requests at the same moment can't both win. 2200 extends the check to appointments and events.
--   * Adding a second location needs the plan feature 'multi_location' (or the studio already has several).
--   * report(p_from, p_to, p_location) filters classes by location (revenue isn't per location). sessions_with_counts gains the columns in 2200.

-- ----------------------------------------------------------------------------- tables
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  address text not null default '',
  -- IANA zone; null = the studio's
  timezone text,
  active boolean not null default true,
  -- classes without a location belong to this one; exactly one per studio
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index locations_one_default on public.locations (studio_id) where is_default;
create unique index locations_name_key on public.locations (studio_id, lower(name));
select app.scope_table('locations');

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  location_id uuid not null,
  name text not null check (length(trim(name)) > 0),
  -- prefills the capacity of a class held here
  capacity integer check (capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (studio_id, location_id) references public.locations (studio_id, id)
);
create unique index rooms_name_key on public.rooms (location_id, lower(name));
-- target of the (location_id, room_id) foreign keys: a room can only be used at its own location
alter table public.rooms add constraint rooms_location_id_key unique (location_id, id);
select app.scope_table('rooms');

-- ----------------------------------------------------------------------------- RLS
create policy locations_read on public.locations for select to anon, authenticated using (active or app.is_staff_of(studio_id));
create policy locations_insert on public.locations for insert to authenticated with check (app.has_role_in(studio_id, 'owner', 'manager'));
create policy locations_update on public.locations for update to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));
create policy rooms_read on public.rooms for select to anon, authenticated using (active or app.is_staff_of(studio_id));
create policy rooms_insert on public.rooms for insert to authenticated with check (app.has_role_in(studio_id, 'owner', 'manager'));
create policy rooms_update on public.rooms for update to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));
revoke all on public.locations, public.rooms from anon, authenticated;
grant select on public.locations, public.rooms to anon, authenticated;
grant insert, update on public.locations, public.rooms to authenticated;
grant all on public.locations, public.rooms to service_role;

-- read-only studios (billing) can look, not change
create trigger zz_billing_read_only before insert or update or delete on public.locations for each row execute function app.billing_read_only_guard();
create trigger zz_billing_read_only before insert or update or delete on public.rooms for each row execute function app.billing_read_only_guard();

-- ----------------------------------------------------------------------------- default location and room
create or replace function app.default_location_id(p_studio uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.locations where studio_id = p_studio and is_default
$$;

create or replace function app.make_default_location(p_studio uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_loc uuid; v_prev text := current_setting('app.studio', true);
begin
  if exists (select 1 from public.locations where studio_id = p_studio) then return; end if;
  perform app.use_studio(p_studio);   -- the rows are written for that studio, whoever is making it
  insert into public.locations (studio_id, name, address, is_default)
    select id, 'Main location', address, true from public.studios where id = p_studio returning id into v_loc;
  insert into public.rooms (studio_id, location_id, name) values (p_studio, v_loc, 'Main room');
  perform set_config('app.studio', coalesce(v_prev, ''), true);
end $$;

-- every studio that exists now, and every new one
select app.make_default_location(id) from public.studios;

create or replace function app.studio_default_location() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.make_default_location(new.id);
  return new;
end $$;
create trigger studios_default_location after insert on public.studios for each row execute function app.studio_default_location();

-- Adding a location past the first needs the plan's multi_location feature (a studio that already runs several keeps editing them).
create or replace function app.check_location_plan() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.is_privileged() or new.is_default then return new; end if;
  if (select count(*) from public.locations where studio_id = new.studio_id) >= 2 then return new; end if;
  if not app.studio_has_feature(new.studio_id, 'multi_location') then
    perform app.fail('FEATURE_LOCKED', 'More than one location is on a higher plan.');
  end if;
  return new;
end $$;
create trigger locations_plan before insert on public.locations for each row execute function app.check_location_plan();

-- ----------------------------------------------------------------------------- where classes happen
alter table public.class_sessions add column location_id uuid, add column room_id uuid;
alter table public.schedule_templates add column location_id uuid, add column room_id uuid;
alter table public.class_sessions
  add constraint sessions_place_check check (room_id is null or location_id is not null),
  add constraint sessions_location_same_studio foreign key (studio_id, location_id) references public.locations (studio_id, id),
  add constraint sessions_room_in_location foreign key (location_id, room_id) references public.rooms (location_id, id);
alter table public.schedule_templates
  add constraint templates_place_check check (room_id is null or location_id is not null),
  add constraint templates_location_same_studio foreign key (studio_id, location_id) references public.locations (studio_id, id),
  add constraint templates_room_in_location foreign key (location_id, room_id) references public.rooms (location_id, id);
create index class_sessions_room_idx on public.class_sessions (room_id, starts_at) where room_id is not null;
create index class_sessions_location_idx on public.class_sessions (location_id, starts_at) where location_id is not null;

-- ----------------------------------------------------------------------------- a room can't be double-booked
-- The first thing that already holds the room at that time, as a friendly message (null = free). 2200 adds appointments and events.
create or replace function app.room_clash(p_room uuid, p_start timestamptz, p_end timestamptz, p_skip_class uuid default null,
                                          p_skip_appt uuid default null, p_skip_event_session uuid default null) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select r.name || ' is already booked at ' || lower(to_char(s.starts_at at time zone app.studio_tz(s.studio_id), 'FMHH12:MIam')) || ' for ' || ct.name || '. Pick another room or time.'
    from public.class_sessions s
    join public.rooms r on r.id = s.room_id
    join public.class_types ct on ct.id = s.class_type_id
   where s.room_id = p_room and s.status = 'scheduled' and s.id is distinct from p_skip_class
     and s.starts_at < p_end and p_start < s.ends_at
   limit 1
$$;

create or replace function app.check_room_free() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text;
begin
  if new.room_id is null or new.status = 'cancelled' then return new; end if;
  if tg_op = 'UPDATE' and old.room_id is not distinct from new.room_id and old.starts_at = new.starts_at and old.ends_at = new.ends_at and old.status = new.status then
    return new;   -- nothing that matters changed (a note, a capacity)
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));
  v_msg := app.room_clash(new.room_id, new.starts_at, new.ends_at, new.id);
  if v_msg is not null then perform app.fail('ROOM_BUSY', v_msg); end if;
  return new;
end $$;
create trigger sessions_room_free before insert or update on public.class_sessions for each row execute function app.check_room_free();

-- Weekly classes: copy the slot's place. A class whose room is busy is skipped (the first one wins) rather than failing the whole run.
create or replace function app.gen_sessions(p_from date, p_to date, p_template uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r record; v_sid uuid := app.current_studio_id(); v_tz text := app.studio_tz(app.current_studio_id());
begin
  if p_to < p_from or v_sid is null then return 0; end if;
  for r in
    select t.studio_id, t.class_type_id, t.id as template_id, d::date as template_date,
           ((d::date + t.start_time) at time zone v_tz) as starts_at,
           ((d::date + t.start_time) at time zone v_tz) + make_interval(mins => ct.duration_min) as ends_at,
           t.instructor_id, coalesce(t.capacity, ct.default_capacity) as capacity, t.location_id, t.room_id
      from public.schedule_templates t
      join public.class_types ct on ct.id = t.class_type_id
     cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
     where t.studio_id = v_sid and t.active and ct.active
       and (p_template is null or t.id = p_template)
       and extract(dow from d) = t.weekday
       and d::date >= t.starts_on
       and (t.ends_on is null or d::date <= t.ends_on)
     order by d, t.start_time
  loop
    begin
      insert into public.class_sessions (studio_id, class_type_id, template_id, template_date, starts_at, ends_at, instructor_id, capacity, location_id, room_id)
      values (r.studio_id, r.class_type_id, r.template_id, r.template_date, r.starts_at, r.ends_at, r.instructor_id, r.capacity, r.location_id, r.room_id)
      on conflict (template_id, template_date) where template_id is not null and template_date is not null do nothing;
      if found then n := n + 1; end if;
    exception when others then
      if sqlerrm not like 'ROOM_BUSY:%' then raise; end if;
    end;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------- reads
-- (sessions_with_counts gets location_id and room_id in 2200, because 1703 redefines that view later.)
-- Reports: classes at one location (sessions without a location count for the default one). Sales aren't split by location.
drop function public.report(date, date);
create or replace function public.report(p_from date, p_to date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_sid uuid := app.current_studio_id();
  v_tz text := app.tz();
  v_now timestamptz := app.now();
  v_start timestamptz := (p_from::timestamp) at time zone v_tz;
  v_end timestamptz := ((p_to + 1)::timestamp) at time zone v_tz;
  v_pay boolean := app.is_privileged() or public.has_role('owner', 'manager');
  v_money boolean := app.is_privileged() or public.has_role('owner', 'manager');
  v jsonb;
begin
  if not (app.is_privileged() or public.is_staff()) then
    perform app.fail('NOT_ALLOWED', 'Reports are for staff.');
  end if;

  with
  sl as (select * from public.sales where studio_id = v_sid and created_at >= v_start and created_at < v_end),
  it as (
    select i.sale_id, i.id, coalesce(i.kind, 'retail') as kind, (i.qty * i.unit_cents)::numeric as g, sl.total_cents::numeric as t
      from public.sale_items i join sl on sl.id = i.sale_id
     where coalesce(i.kind, '') <> 'discount'),
  it2 as (
    select it.*, sum(g) over (partition by sale_id) as gs,
           row_number() over (partition by sale_id order by id) as rn, count(*) over (partition by sale_id) as n
      from it),
  it3 as (
    select sale_id, kind, rn, n, t, gs,
           case when gs <= 0 then case when rn = 1 then t else 0 end else floor(g * t / gs) end as a
      from it2),
  alloc as (
    select kind, a + case when gs > 0 and rn = n then t - sum(a) over (partition by sale_id) else 0 end as a from it3),
  ses as (
    select s.id, s.class_type_id, s.instructor_id, s.starts_at, s.capacity, ct.name as ct_name,
           count(b.id) filter (where b.status in ('booked','checked_in','no_show','late_cancelled')) as total_b,
           count(b.id) filter (where b.status = 'checked_in') as attended,
           count(b.id) filter (where b.status in ('booked','checked_in','no_show')) as filled,
           count(b.id) filter (where b.status = 'no_show') as no_shows,
           count(b.id) filter (where b.status = 'late_cancelled') as late_cancels
      from public.class_sessions s
      join public.class_types ct on ct.id = s.class_type_id
      left join public.bookings b on b.session_id = s.id
     where s.studio_id = v_sid and s.status = 'scheduled' and s.starts_at >= v_start and s.starts_at < v_end and s.starts_at <= v_now
       and (p_location is null or coalesce(s.location_id, app.default_location_id(v_sid)) = p_location)
     group by s.id, ct.name),
  ses2 as (
    select ses.*, case when capacity > 0 then least(100.0, filled * 100.0 / capacity) else 0 end as fill,
           to_char(starts_at at time zone v_tz, 'Dy') || ' ' || lower(to_char(starts_at at time zone v_tz, 'FMHH12:MIam')) as slot
      from ses)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'revenue_cents', coalesce((select sum(total_cents) from sl), 0),
    'refunds_cents', coalesce((select sum(refunded_cents) from public.sales where studio_id = v_sid and refunded_at >= v_start and refunded_at < v_end), 0),
    'revenue_by_method', coalesce((select jsonb_object_agg(method, c) from (select method, sum(total_cents) c from sl group by method) x), '{}'::jsonb),
    'revenue_by_kind', coalesce((select jsonb_object_agg(kind, c) from (select kind, sum(a)::bigint c from alloc group by kind) x), '{}'::jsonb),
    'sales_count', (select count(*) from sl),
    'classes_run', (select count(*) from ses2),
    'total_bookings', coalesce((select sum(total_b) from ses2), 0),
    'attended', coalesce((select sum(attended) from ses2), 0),
    'no_shows', coalesce((select sum(no_shows) from ses2), 0),
    'late_cancels', coalesce((select sum(late_cancels) from ses2), 0),
    'avg_fill_pct', coalesce((select round(avg(fill), 1) from ses2), 0),
    'new_clients', (select count(*) from public.clients where studio_id = v_sid and created_at >= v_start and created_at < v_end),
    'active_memberships', (select count(*) from public.passes p where p.studio_id = v_sid and p.kind = 'membership' and app.pass_status_now(p, v_now) = 'active'),
    'active_packs', (select count(*) from public.passes p where p.studio_id = v_sid and p.kind <> 'membership' and app.pass_status_now(p, v_now) = 'active'),
    'by_instructor', coalesce((
        select jsonb_agg(jsonb_build_object('staff_id', x.instructor_id, 'name', coalesce(st.name, 'Unknown'), 'classes', x.classes,
                 'attendees', x.att, 'pay_cents', case when v_pay then x.classes * coalesce(sp.pay_per_class_cents, 0) else 0 end)
               order by x.classes desc, coalesce(st.name, 'Unknown'))
          from (select instructor_id, count(*) classes, sum(attended) att from ses2 group by instructor_id) x
          left join public.staff st on st.id = x.instructor_id
          left join public.staff_pay sp on sp.staff_id = x.instructor_id), '[]'::jsonb),
    'by_class_type', coalesce((
        select jsonb_agg(jsonb_build_object('class_type_id', class_type_id, 'name', ct_name, 'classes', classes,
                 'attendees', att, 'avg_fill_pct', fill) order by classes desc, ct_name)
          from (select class_type_id, ct_name, count(*) classes, sum(attended) att, round(avg(fill), 1) fill
                  from ses2 group by class_type_id, ct_name) x), '[]'::jsonb),
    'top_slots', coalesce((
        select jsonb_agg(jsonb_build_object('label', slot, 'avg_attendees', avg_att) order by avg_att desc, slot)
          from (select slot, round(avg(attended), 1) as avg_att from ses2 group by slot order by 2 desc, 1 limit 5) x), '[]'::jsonb)
  ) into v;
  if not v_money then
    v := v || jsonb_build_object('revenue_cents', 0, 'refunds_cents', 0, 'revenue_by_method', '{}'::jsonb,
                                 'revenue_by_kind', '{}'::jsonb, 'sales_count', 0);
  end if;
  return v;
end $$;

revoke execute on function public.report(date, date, uuid) from public, anon;
grant execute on function public.report(date, date, uuid) to authenticated;
grant execute on function public.report(date, date, uuid) to service_role;
