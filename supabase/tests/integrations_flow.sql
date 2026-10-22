-- Integrations (B5): ClassPass / Gympass hooks. Roles, write-only keys, spots held per class type,
-- the webhook's database functions (service role only), and Snowy vs Harbour isolation.
-- Snowy: Libby owner, Mia manager, Fran front desk, Julia instructor, Alice client. Harbour: Hank owner.
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
grant execute on function test.studio(text), test.count(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- Harbour: studio, owner, a class type and a future class
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));
select test.login('pete');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test', 'Australia/Sydney', 'AUD', 'en-AU', null, '12 Bay St', '{}'::jsonb) ->> 'id') as harbour_id \gset
select test.admin();
insert into test.ids values ('harbour', :'harbour_id');
select test.login('pete');
select public.platform_invite_owner(test.id('harbour'), 'Hank', 'hank@harbour.test');
select test.admin();
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';
insert into public.class_types (studio_id, name, duration_min) values (test.id('harbour'), 'Reformer Flow', 50) returning id as h_type \gset
insert into test.ids values ('h_type', :'h_type');
insert into public.class_sessions (studio_id, class_type_id, starts_at, ends_at, instructor_id, capacity)
  values (test.id('harbour'), test.id('h_type'), '2026-10-22 06:00+11', '2026-10-22 06:50+11', test.id('hank_staff'), 8) returning id as h_session \gset
insert into test.ids values ('h_session', :'h_session');

-- ---------------------------------------------------------------- who can set partners up
select test.studio('snowy');
select test.login('fran');
select test.throws($$select public.integrations_list_partners()$$, 'NOT_ALLOWED', 'front desk can''t open the partner settings');
select test.throws($$select public.integrations_save_partner('classpass', true, 'CP-1')$$, 'NOT_ALLOWED', 'front desk can''t save a partner');
select test.login('julia');
select test.throws($$select public.integrations_list_partners()$$, 'NOT_ALLOWED', 'an instructor can''t open the partner settings');
select test.login('alice');
select test.throws($$select public.integrations_save_partner('classpass', true, 'CP-1')$$, 'NOT_ALLOWED', 'a client can''t save a partner');

select test.login('mia');
select test.eq(jsonb_array_length(public.integrations_list_partners()), 2, 'both partners are listed, even when nothing is saved');
select test.eq((public.integrations_list_partners() -> 0 ->> 'enabled')::boolean, false, '...switched off');
select test.throws($$select public.integrations_save_partner('classpass', true, '')$$, 'INVALID', 'can''t switch a partner on without its ID');
select test.throws($$select public.integrations_save_partner('mindbody', false, 'x')$$, 'INVALID', 'only ClassPass and Gympass');
select test.eq(public.integrations_save_partner('classpass', true, '  CP-1  ') ->> 'partner_studio_id', 'CP-1', 'the manager saves the ID (trimmed) and switches ClassPass on');
select test.throws($$select public.integrations_save_partner('classpass', null, null, 'sekrit-1')$$, 'NOT_ALLOWED', 'a manager can''t enter an API key');
select test.login('libby');
select test.eq((public.integrations_save_partner('classpass', null, null, 'sekrit-1') ->> 'key_set')::boolean, true, 'the owner enters the key: key_set comes back, not the key');
select test.ok(not (public.integrations_list_partners()::text like '%sekrit%'), 'listing the partners never includes the key');
select test.throws($$select * from public.integrations_secrets$$, '42501', 'the key table can''t be read by the app (no grant)');
select test.admin();
select test.eq((select api_key from public.integrations_secrets where partner = 'classpass' and studio_id = (select id from public.studios where slug = 'snowy')), 'sekrit-1', 'the key is stored on the server');
select test.studio('snowy');
select test.login('libby');
select test.eq((public.integrations_save_partner('classpass', null, null, '') ->> 'key_set')::boolean, false, 'an empty key removes it');
select test.eq(test.count($$select 1 from public.integrations_partners$$), 1, 'the partner table is readable by owner/manager through RLS');
select test.admin();
select test.eq(test.count($$select 1 from public.integrations_secrets where partner = 'classpass'$$), 0, '...and the key row is gone');
select test.studio('snowy');
select test.login('julia');
select test.eq(test.count($$select 1 from public.integrations_partners$$), 0, 'an instructor can''t read the partner table');

-- ---------------------------------------------------------------- spots held per class type
select test.login('fran');
select test.throws(format('select public.integrations_set_reserved(%L, ''classpass'', 2)', test.id('mat')), 'NOT_ALLOWED', 'front desk can''t hold spots');
select test.login('mia');
select test.throws(format('select public.integrations_set_reserved(%L, ''classpass'', 201)', test.id('mat')), 'INVALID', 'up to 200');
select test.throws(format('select public.integrations_set_reserved(%L, ''classpass'', -1)', test.id('mat')), 'INVALID', 'not negative');
select test.throws(format('select public.integrations_set_reserved(%L, ''classpass'', 2)', test.id('h_type')), 'NOT_FOUND', 'a Harbour class type isn''t Snowy''s to hold spots in');
select public.integrations_set_reserved(test.id('mat'), 'classpass', 2);
select test.eq((select spots from public.integrations_reserved where class_type_id = test.id('mat')), 2, 'Mat Essentials holds 2 ClassPass spots');
select public.integrations_set_reserved(test.id('mat'), 'classpass', 3);
select public.integrations_set_reserved(test.id('mat'), 'classpass', 2);
select test.eq(test.count($$select 1 from public.integrations_reserved$$), 1, 'changing it keeps one row');
select test.login('julia');
select test.eq(test.count($$select 1 from public.integrations_reserved$$), 1, 'an instructor can see what is held (for the roster)');
select test.login('alice');
select test.eq(test.count($$select 1 from public.integrations_reserved$$), 0, 'a client can''t');

-- ---------------------------------------------------------------- the webhook's database functions
select test.admin();
select test.eq(test.count($$select 1 from public.bookings where session_id = test.id('s_thu')$$), 0, 'Thursday''s class starts empty');
select test.login('libby');
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-1'', ''m-1'', ''Maya'', ''Singh'')', test.id('s_thu')), '42501', 'staff can''t call the webhook function');
select test.service();
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-9'', %L, ''B-1'', ''m-1'', ''Maya'', ''Singh'')', test.id('s_thu')), 'NOT_FOUND', 'an unknown partner ID is refused');
select test.throws(format('select public.integrations_partner_book(''gympass'', ''CP-1'', %L, ''B-1'', ''m-1'', ''Maya'', ''Singh'')', test.id('s_thu')), 'NOT_FOUND', 'Gympass is not switched on');
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, '''', ''m-1'', ''Maya'', ''Singh'')', test.id('s_thu')), 'INVALID', 'a booking with no id is refused');
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-1'', ''m-1'', ''Maya'', ''Singh'')', test.id('s_cancel')), 'NO_PARTNER_SPOTS', 'no spots held for Mums + Bubs');
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-1'', ''m-1'', ''Maya'', ''Singh'')', test.id('s_past')), 'TOO_LATE', 'not into a class that has started');
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-1'', ''m-1'', ''Maya'', ''Singh'')', test.id('h_session')), 'NOT_FOUND', 'a Harbour class can''t be booked with Snowy''s partner ID');
select (public.integrations_partner_book('classpass', 'CP-1', test.id('s_thu'), 'B-1', 'm-1', 'Maya', 'Singh') ->> 'booking_id') as pb1 \gset
select test.admin();
insert into test.ids values ('pb1', :'pb1');
select test.eq((select status || '/' || source || '/' || coalesce(pass_id::text, 'no pass') from public.bookings where id = test.id('pb1')), 'booked/staff/no pass', 'a booked spot, no pass used');
select test.eq((select c.first_name || ' ' || c.last_name from public.bookings b join public.clients c on c.id = b.client_id where b.id = test.id('pb1')), 'Maya Singh', 'for a new partner client');
select test.eq((select source from public.integrations_partner_bookings where booking_id = test.id('pb1')), 'classpass', 'the source is classpass');
select test.service();
select test.eq(public.integrations_partner_book('classpass', 'CP-1', test.id('s_thu'), 'B-1', 'm-1', 'Maya', 'Singh') ->> 'duplicate', 'true', 'the partner retrying the same booking id changes nothing');
select test.admin();
select test.eq(test.count($$select 1 from public.bookings where session_id = test.id('s_thu')$$), 1, '...still one booking');
select test.service();
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-1b'', ''m-1'', ''Maya'', ''Singh'')', test.id('s_thu')), 'ALREADY_BOOKED', 'the same member can''t take two spots in one class');
select public.integrations_partner_book('classpass', 'CP-1', test.id('s_thu'), 'B-2', 'm-2', 'Tom', 'Alvarez');
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-3'', ''m-3'', ''Ben'', ''Cho'')', test.id('s_thu')), 'NO_PARTNER_SPOTS', 'only 2 spots are held, so a third is refused');
select test.admin();
select test.eq(test.count($$select 1 from public.clients where first_name in ('Maya','Tom') and email = ''$$), 2, 'two partner clients were made');
-- a second class for Maya reuses her client row
select test.service();
select public.integrations_partner_book('classpass', 'CP-1', test.id('s_eve'), 'B-4', 'm-1', 'Maya', 'Singh');
select test.admin();
select test.eq(test.count($$select 1 from public.clients where first_name = 'Maya'$$), 1, 'the same member is the same client next time');
-- a full class
select test.eq((select capacity from public.class_sessions where id = test.id('s_early')), 2, 'the early class holds 2');
insert into public.bookings (session_id, client_id, status, source) values (test.id('s_early'), test.id('bob_client'), 'booked', 'staff'), (test.id('s_early'), test.id('cara_client'), 'booked', 'staff');
select test.service();
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''B-5'', ''m-5'', ''Kai'', ''Lee'')', test.id('s_early')), 'CLASS_FULL', 'a full class stays full');

-- who sees partner bookings
select test.login('julia');
select test.eq(test.count($$select 1 from public.integrations_partner_bookings where session_id = test.id('s_thu')$$), 2, 'instructors see the partner bookings (for the roster badge)');
select test.login('alice');
select test.eq(test.count($$select 1 from public.integrations_partner_bookings$$), 0, 'clients don''t');

-- cancel
select test.service();
select test.eq(public.integrations_partner_cancel('classpass', 'CP-1', 'B-2') ->> 'status', 'cancelled', 'the partner cancels a booking');
select test.eq(public.integrations_partner_cancel('classpass', 'CP-1', 'B-2') ->> 'status', 'cancelled', '...and repeating it is fine');
select test.throws($$select public.integrations_partner_cancel('classpass', 'CP-1', 'nope')$$, 'NOT_FOUND', 'an unknown booking is refused');
select test.throws($$select public.integrations_partner_cancel('classpass', 'CP-9', 'B-2')$$, 'NOT_FOUND', 'with the wrong partner ID too');
select public.integrations_partner_book('classpass', 'CP-1', test.id('s_thu'), 'B-3', 'm-3', 'Ben', 'Cho');

-- ---------------------------------------------------------------- Snowy vs Harbour
select test.studio('harbour');
select test.login('hank');
select test.eq(public.integrations_list_partners() -> 0 ->> 'partner_studio_id', '', 'Harbour starts with nothing saved (Snowy''s ID isn''t visible)');
select test.eq(test.count($$select 1 from public.integrations_partners$$), 0, 'Hank sees none of Snowy''s partner rows');
select test.eq(test.count($$select 1 from public.integrations_reserved$$), 0, '...none of its held spots');
select test.eq(test.count($$select 1 from public.integrations_partner_bookings$$), 0, '...none of its partner bookings');
select test.throws($$select public.integrations_save_partner('classpass', true, 'CP-1')$$, 'INVALID', 'Harbour can''t take the partner ID Snowy already uses');
select test.throws(format('select public.integrations_set_reserved(%L, ''gympass'', 2)', test.id('mat')), 'NOT_FOUND', 'Harbour can''t hold spots on a Snowy class type');
select test.eq(public.integrations_save_partner('gympass', true, 'GP-9') ->> 'partner_studio_id', 'GP-9', 'Harbour saves its own Gympass ID');
select public.integrations_set_reserved(test.id('h_type'), 'gympass', 1);
select test.studio('snowy');
select test.throws($$select public.integrations_list_partners()$$, 'NOT_ALLOWED', 'Harbour''s owner isn''t Snowy staff');
select test.login('mia');
select test.service();
select test.eq(public.integrations_partner_book('gympass', 'GP-9', test.id('h_session'), 'G-1', 'g-1', 'Gia', 'Lopez') ->> 'duplicate', 'false', 'Gympass books into Harbour''s class with Harbour''s ID');
select test.throws(format('select public.integrations_partner_book(''gympass'', ''GP-9'', %L, ''G-2'', ''g-2'', ''Gus'', ''Lee'')', test.id('s_thu')), 'NOT_FOUND', '...but not into a Snowy class');
select test.admin();
select test.eq((select studio_id from public.integrations_partner_bookings where partner_booking_id = 'G-1'), test.id('harbour'), 'the partner booking belongs to Harbour');
select test.eq((select studio_id from public.clients where first_name = 'Gia'), test.id('harbour'), '...and so does the partner client');
select test.throws(format('insert into public.integrations_reserved (studio_id, class_type_id, partner, spots) values (%L, %L, ''gympass'', 1)', test.id('harbour'), test.id('mat')), '23503', 'a Harbour row can''t point at a Snowy class type');
insert into test.ids select 'b_bob_early', id from public.bookings where session_id = test.id('s_early') and client_id = test.id('bob_client');
select test.throws(format('insert into public.integrations_partner_bookings (studio_id, booking_id, session_id, source, partner_booking_id) values (%L, %L, %L, ''gympass'', ''X'')', test.id('harbour'), test.id('b_bob_early'), test.id('s_thu')), '23503', 'nor a Snowy session');

select test.studio(null);
rollback;
