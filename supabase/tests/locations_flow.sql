-- 0013 + 2200: multi-location and rooms. Every studio gets one default location and room; two studios in one database can't see or
-- change each other's locations and rooms or point a class at the other's room; a room can't be double-booked (classes, event sessions,
-- generated weekly classes skip a taken room); adding a second location needs the multi_location plan feature; the report filters by location.
-- Snowy (default studio): Libby owner, Fran front desk, Alice client. Harbour: Hank owner.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create or replace function test.count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
create or replace function test.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute p_sql; get diagnostics n = row_count; return n; end $$;
grant execute on function test.studio(text), test.count(text), test.affected(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- studio B (Harbour), on the Studio plan (no multi_location)
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));
select test.login('pete');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test', 'Australia/Sydney', 'AUD', 'en-AU', null, '12 Bay St, Double Bay', '{}'::jsonb) ->> 'id') as harbour_id \gset
select test.admin();
insert into test.ids values ('harbour', :'harbour_id');
select test.login('pete');
select public.platform_invite_owner(test.id('harbour'), 'Hank', 'hank@harbour.test');
select test.admin();
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';
insert into public.class_types (studio_id, name, duration_min, default_capacity) values (test.id('harbour'), 'Reformer Flow', 50, 8) returning id as h_flow \gset
insert into test.ids values ('h_flow', :'h_flow');

-- ---------------------------------------------------------------- every studio has one default location and room
select test.eq(test.count($$select 1 from public.locations where is_default$$), 2, 'Snowy and the new Harbour each have a default location');
select test.eq((select count(*)::int from public.locations where studio_id = app.default_studio()), 1, 'Snowy has exactly one (existing studios are backfilled)');
select test.eq((select count(*)::int from public.rooms r join public.locations l on l.id = r.location_id where l.studio_id = app.default_studio() and l.is_default), 1, '...with one room');
select test.eq((select l.address from public.locations l where l.studio_id = test.id('harbour')), '12 Bay St, Double Bay', 'a new studio''s default location takes the studio address');
select test.eq((select count(*)::int from public.class_sessions where location_id is not null or room_id is not null), 0, 'existing classes are left unplaced: null means the default location');
select test.throws($$insert into public.locations (studio_id, name, is_default) values (app.default_studio(), 'Second default', true)$$, '23505', 'only one default location per studio');

-- ---------------------------------------------------------------- Snowy adds a location and rooms (Signature: multi_location on)
select test.studio('snowy');
select test.login('libby');
insert into public.locations (name, address) values ('Cooma North', '9 Sharp St, Cooma NSW 2630') returning id as cn \gset
insert into public.rooms (location_id, name, capacity) values (:'cn', 'Studio 1', 12) returning id as r1 \gset
insert into public.rooms (location_id, name) values (:'cn', 'Studio 2') returning id as r2 \gset
select test.admin();
insert into test.ids values ('cn', :'cn'), ('r1', :'r1'), ('r2', :'r2');
select test.eq((select studio_id from public.locations where id = test.id('cn')), app.default_studio(), 'a location made as Snowy''s owner belongs to Snowy');
select test.eq((select timezone from public.locations where id = test.id('cn')), null, 'timezone is empty = the studio''s');
select test.throws($$insert into public.locations (studio_id, name) values (app.default_studio(), 'cooma NORTH')$$, '23505', 'names are unique per studio, whatever the case');
select test.throws(format('insert into public.rooms (studio_id, location_id, name) values (app.default_studio(), %L, ''studio 1'')', test.id('cn')), '23505', 'room names are unique per location');

-- ---------------------------------------------------------------- who can change them
select test.studio('snowy');
select test.login('fran');
select test.throws($$insert into public.locations (name) values ('Fran''s')$$, '42501', 'front desk can''t add a location');
select test.eq(test.affected(format('update public.locations set name = ''Hijack'' where id = %L', test.id('cn'))), 0, '...or rename one');
select test.eq(test.count($$select 1 from public.locations$$), 2, 'front desk can read them');
select test.login('alice');
select test.eq(test.count($$select 1 from public.locations$$), 2, 'a client can read the active locations (the timetable shows them)');
select test.throws($$insert into public.rooms (location_id, name) values (test.id('cn'), 'Alice''s room')$$, '42501', 'a client can''t add a room');
select test.login('libby');
update public.locations set active = false where id = test.id('cn');
select test.login('alice');
select test.eq(test.count($$select 1 from public.locations$$), 1, 'a switched-off location is hidden from clients');
select test.login('libby');
select test.eq(test.count($$select 1 from public.locations$$), 2, '...but not from the owner');
select test.throws($$delete from public.locations where id = test.id('cn')$$, '42501', 'locations are never deleted, only switched off');
update public.locations set active = true where id = test.id('cn');

-- ---------------------------------------------------------------- the other studio
select test.studio('harbour');
select test.login('hank');
select test.eq(test.count($$select 1 from public.locations$$), 1, 'Hank sees only Harbour''s location');
select test.eq(test.count($$select 1 from public.rooms$$), 1, '...and its room');
select test.throws($$insert into public.locations (name) values ('Harbour Bondi')$$, 'FEATURE_LOCKED', 'Harbour is on the Studio plan: a second location is locked');
select test.admin();
update public.studios set plan_id = '9c000000-0000-4000-8000-000000000003', billing_status = 'active', billing_comped = true where id = test.id('harbour');
select test.studio('harbour');
select test.login('hank');
insert into public.locations (name, address) values ('Harbour Bondi', '1 Beach Rd, Bondi') returning id as hb \gset
insert into public.rooms (location_id, name) values (:'hb', 'Room A') returning id as hr \gset
select test.admin();
insert into test.ids values ('hb', :'hb'), ('hr', :'hr');
select test.eq((select studio_id from public.rooms where id = test.id('hr')), test.id('harbour'), 'Hank''s room belongs to Harbour');
select test.studio('snowy');
select test.login('libby');
select test.eq(test.count($$select 1 from public.locations where studio_id <> app.default_studio()$$), 0, 'Libby (header: snowy) never sees a Harbour location');
select test.eq(test.count($$select 1 from public.rooms where studio_id <> app.default_studio()$$), 0, '...or room');
select test.throws(format('insert into public.locations (studio_id, name) values (%L, ''Sneaky'')', test.id('harbour')), 'NOT_ALLOWED', 'Libby can''t write a location into Harbour');
select test.throws(format('insert into public.rooms (location_id, name) values (%L, ''Sneaky'')', test.id('hb')), '23503', 'a room can''t go under the other studio''s location');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.locations where id = test.id('cn')$$), 0, 'Libby asking as Harbour can''t see Snowy''s location');
select test.eq(test.affected(format('update public.locations set name = ''Hijack'' where id = %L', test.id('hb'))), 0, 'and can''t rename Harbour''s (she isn''t on its staff)');

-- ---------------------------------------------------------------- the database itself keeps classes in their own studio's places
select test.admin();
select test.throws(format('insert into public.class_sessions (studio_id, class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id) values (app.default_studio(), %L, ''2026-10-24 09:00+11'', ''2026-10-24 09:55+11'', %L, 10, %L, %L)', test.id('mat'), test.id('libby_staff'), test.id('hb'), test.id('hr')), '23503', 'a Snowy class can''t use a Harbour room');
select test.throws(format('insert into public.class_sessions (studio_id, class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id) values (app.default_studio(), %L, ''2026-10-24 09:00+11'', ''2026-10-24 09:55+11'', %L, 10, %L, %L)', test.id('mat'), test.id('libby_staff'), test.id('cn'), test.id('hr')), '23503', '...nor a room from another location of its own studio');
select test.throws(format('insert into public.class_sessions (studio_id, class_type_id, starts_at, ends_at, instructor_id, capacity, room_id) values (app.default_studio(), %L, ''2026-10-24 09:00+11'', ''2026-10-24 09:55+11'', %L, 10, %L)', test.id('mat'), test.id('libby_staff'), test.id('r1')), '23514', 'a room with no location is refused');
select test.throws(format('insert into public.schedule_templates (studio_id, class_type_id, weekday, start_time, instructor_id, location_id, room_id) values (app.default_studio(), %L, 6, ''09:00'', %L, %L, %L)', test.id('mat'), test.id('libby_staff'), test.id('hb'), test.id('hr')), '23503', 'a Snowy weekly slot can''t use a Harbour room either');

-- ---------------------------------------------------------------- a room can't be double-booked
select test.studio('snowy');
select test.login('fran');
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id)
  values (test.id('mat'), '2026-10-24 09:00+11', '2026-10-24 09:55+11', test.id('julia_staff'), 12, test.id('cn'), test.id('r1')) returning id as c1 \gset
select test.throws(format('insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id) values (%L, ''2026-10-24 09:30+11'', ''2026-10-24 10:25+11'', %L, 12, %L, %L)', test.id('mat'), test.id('libby_staff'), test.id('cn'), test.id('r1')), 'ROOM_BUSY', 'the same room at an overlapping time is refused');
select test.throws(format('insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id) values (%L, ''2026-10-24 08:30+11'', ''2026-10-24 09:01+11'', %L, 12, %L, %L)', test.id('mat'), test.id('libby_staff'), test.id('cn'), test.id('r1')), 'ROOM_BUSY', '...even by a minute');
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id)
  values (test.id('mat'), '2026-10-24 09:55+11', '2026-10-24 10:50+11', test.id('julia_staff'), 12, test.id('cn'), test.id('r1'));   -- starts as the other ends
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id)
  values (test.id('mat'), '2026-10-24 09:00+11', '2026-10-24 09:55+11', test.id('libby_staff'), 12, test.id('cn'), test.id('r2'));   -- another room
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity)
  values (test.id('mat'), '2026-10-24 09:00+11', '2026-10-24 09:55+11', test.id('gracet_staff'), 12);   -- no room at all
select test.ok(true, 'back-to-back, another room and no room are all fine');
select test.throws(format('update public.class_sessions set room_id = %L where id = %L', test.id('r1'), (select id from public.class_sessions where room_id = test.id('r2'))), 'ROOM_BUSY', 'moving a class into a busy room is refused');
update public.class_sessions set note = 'Bring a towel' where id = :'c1';
select test.ok(true, 'editing a class''s note is not a clash with itself');
select test.admin();
select test.studio('snowy');
select test.login('fran');
select public.cancel_session(:'c1', 'Teacher sick');
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id)
  values (test.id('mat'), '2026-10-24 08:30+11', '2026-10-24 09:25+11', test.id('libby_staff'), 12, test.id('cn'), test.id('r1')) returning id as c3 \gset
select test.ok(true, 'a cancelled class lets go of its room');
select test.throws(format('update public.class_sessions set status = ''scheduled'' where id = %L', :'c1'), 'ROOM_BUSY', '...and putting it back is refused while the room is taken');
select test.eq((select location_id from public.sessions_with_counts where id = :'c3'), test.id('cn'), 'sessions_with_counts carries the location');
select test.eq((select room_id from public.sessions_with_counts where id = :'c3'), test.id('r1'), '...and the room');

-- event sessions share the same rooms
select test.login('libby');
insert into public.studio_events (kind, title, capacity, location_id, room_id) values ('workshop', 'Back care workshop', 10, test.id('cn'), test.id('r2')) returning id as ev \gset
select test.throws(format('insert into public.studio_event_sessions (event_id, starts_at, ends_at) values (%L, ''2026-10-24 09:30+11'', ''2026-10-24 11:00+11'')', :'ev'), 'ROOM_BUSY', 'an event session can''t overlap a class in its room');
insert into public.studio_event_sessions (event_id, starts_at, ends_at) values (:'ev', '2026-10-24 11:00+11', '2026-10-24 12:30+11');
select test.throws(format('insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id) values (%L, ''2026-10-24 12:00+11'', ''2026-10-24 12:55+11'', %L, 12, %L, %L)', test.id('mat'), test.id('libby_staff'), test.id('cn'), test.id('r2')), 'ROOM_BUSY', 'and a class can''t overlap an event session');

-- weekly classes: two slots for one room; generating the classes skips the second instead of failing
select test.admin();
select test.studio('snowy');
select test.login('libby');
insert into public.schedule_templates (class_type_id, weekday, start_time, instructor_id, starts_on, location_id, room_id) values (test.id('mat'), 3, '19:00', test.id('julia_staff'), '2026-10-01', test.id('cn'), test.id('r1'));
insert into public.schedule_templates (class_type_id, weekday, start_time, instructor_id, starts_on, location_id, room_id) values (test.id('mat'), 3, '19:30', test.id('libby_staff'), '2026-10-01', test.id('cn'), test.id('r1'));
select public.generate_sessions('2026-10-28', '2026-11-03') as gen \gset
select test.eq(:gen, 1, 'generating the week made the first slot''s class and skipped the one whose room was taken');
select test.eq((select count(*)::int from public.class_sessions where room_id = test.id('r1') and starts_at = '2026-10-28 19:00+11'), 1, '...and the class that was made carries its room');

-- ---------------------------------------------------------------- reports by location
select test.admin();
select test.studio('snowy');
select test.login('libby');
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity, location_id, room_id) values
  (test.id('mat'), '2026-09-02 09:00+10', '2026-09-02 09:55+10', test.id('julia_staff'), 12, test.id('cn'), test.id('r1')),
  (test.id('mat'), '2026-09-03 09:00+10', '2026-09-03 09:55+10', test.id('julia_staff'), 12, test.id('cn'), test.id('r1'));
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity) values (test.id('mat'), '2026-09-04 09:00+10', '2026-09-04 09:55+10', test.id('julia_staff'), 12);
select ((public.report('2026-09-01', '2026-09-30') ->> 'classes_run')::int) as all_n \gset
select test.eq(:all_n, 3, 'the report with no location counts every class');
select test.eq((public.report('2026-09-01', '2026-09-30', test.id('cn')) ->> 'classes_run')::int, 2, 'limited to Cooma North: its two classes');
select test.eq((public.report('2026-09-01', '2026-09-30', app.default_location_id(app.default_studio())) ->> 'classes_run')::int, 1, 'limited to the default location: the class with no location');

select test.admin();
select test.studio(null);
rollback;
