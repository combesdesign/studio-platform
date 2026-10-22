-- Reviews and NPS (B5): the "How was…?" prompt, rating once per booking, "not now", who reads what, the Google link setting,
-- and Snowy vs Harbour isolation.
-- Snowy: Libby owner, Mia manager, Fran front desk, Julia + Grace T instructors, Alice + Bob + Cara clients. Harbour: Hank owner, Hana client.
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

-- ---------------------------------------------------------------- Harbour: studio, owner (who also teaches), one client with a checked-in class
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
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'hana@harbour.test', '{"first_name":"Hana","studio":"harbour"}', now());
insert into test.ids select 'hana', id from auth.users where email = 'hana@harbour.test';
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';
insert into test.ids select 'hana_client', id from public.clients where email = 'hana@harbour.test';
insert into public.class_types (studio_id, name, duration_min) values (test.id('harbour'), 'Reformer Flow', 50) returning id as h_type \gset
insert into test.ids values ('h_type', :'h_type');
insert into public.class_sessions (studio_id, class_type_id, starts_at, ends_at, instructor_id, capacity)
  values (test.id('harbour'), test.id('h_type'), '2026-10-19 06:00+11', '2026-10-19 06:50+11', test.id('hank_staff'), 8) returning id as h_session \gset
insert into test.ids values ('h_session', :'h_session');
insert into public.bookings (session_id, client_id, status, source, checked_in_at)
  values (test.id('h_session'), test.id('hana_client'), 'checked_in', 'staff', '2026-10-19 06:00+11') returning id as h_booking \gset
insert into test.ids values ('h_booking', :'h_booking');

-- ---------------------------------------------------------------- Snowy: bookings (Julia's mat class this morning, Grace T's mat class yesterday evening)
select test.mk_session('rv_grace', 'mat', '2026-10-18 17:00+11', 14, 'gracet');   -- Sunday, finished
select test.mk_session('rv_old',   'mat', '2026-09-01 06:00+10', 14, 'julia');    -- long ago
insert into public.bookings (session_id, client_id, status, source, checked_in_at) values
  (test.id('s_past'),   test.id('alice_client'), 'booked',     'staff', null),
  (test.id('s_past'),   test.id('bob_client'),   'checked_in', 'staff', '2026-10-19 06:00+11'),
  (test.id('rv_grace'), test.id('cara_client'),  'checked_in', 'staff', '2026-10-18 17:00+11'),
  (test.id('rv_grace'), test.id('alice_client'), 'checked_in', 'staff', '2026-10-18 17:00+11'),
  (test.id('rv_old'),   test.id('dan_client'),   'checked_in', 'staff', '2026-09-01 06:00+10'),
  (test.id('s_eve'),    test.id('erin_client'),  'checked_in', 'staff', null);      -- not started yet
insert into test.ids select 'b_alice_booked', id from public.bookings where session_id = test.id('s_past') and client_id = test.id('alice_client');
insert into test.ids select 'b_bob', id from public.bookings where session_id = test.id('s_past') and client_id = test.id('bob_client');
insert into test.ids select 'b_cara', id from public.bookings where session_id = test.id('rv_grace') and client_id = test.id('cara_client');
insert into test.ids select 'b_alice', id from public.bookings where session_id = test.id('rv_grace') and client_id = test.id('alice_client');
insert into test.ids select 'b_dan', id from public.bookings where session_id = test.id('rv_old') and client_id = test.id('dan_client');
insert into test.ids select 'b_erin', id from public.bookings where session_id = test.id('s_eve') and client_id = test.id('erin_client');

-- ---------------------------------------------------------------- the prompt
select test.studio('snowy');
select test.login('alice');
select test.eq(public.reviews_pending() ->> 'booking_id', test.id('b_alice')::text, 'Alice is asked about the class she was checked into (not the one she only booked)');
select test.eq(public.reviews_pending() ->> 'class_name', 'Mat Essentials', 'the prompt names the class');
select test.eq(public.reviews_pending() ->> 'instructor_name', 'Grace T', '...and who taught it');
select test.login('dan');
select test.eq(public.reviews_pending(), null::jsonb, 'a class from months ago isn''t asked about');
select test.login('erin');
select test.eq(public.reviews_pending(), null::jsonb, 'a class that hasn''t happened yet isn''t asked about');
select test.login('libby');
select test.eq(public.reviews_pending(), null::jsonb, 'staff have no prompt');

-- ---------------------------------------------------------------- rating
select test.login('bob');
select test.throws(format('select public.reviews_submit(%L, 6, 8, null)', test.id('b_bob')), 'INVALID', '6 flowers is out of range');
select test.throws(format('select public.reviews_submit(%L, 0, 8, null)', test.id('b_bob')), 'INVALID', '0 flowers is out of range');
select test.throws(format('select public.reviews_submit(%L, 5, 11, null)', test.id('b_bob')), 'INVALID', 'a score above 10 is refused');
select test.throws(format('select public.reviews_submit(%L, 5, 9, %L)', test.id('b_bob'), repeat('x', 1001)), 'INVALID', 'a 1001 character comment is refused');
select test.throws(format('select public.reviews_submit(%L, 5, 9, null)', test.id('b_alice')), 'NOT_FOUND', 'Bob can''t review Alice''s booking');
select test.throws(format('select public.reviews_submit(%L, 5, 9, null)', test.id('b_alice_booked')), 'NOT_FOUND', 'and nobody rates a class they only booked');
select test.eq(public.reviews_submit(test.id('b_bob'), 5, 9, '  Loved it  '), '{}'::jsonb, 'Bob rates his class; no Google link is set yet, so none comes back');
select test.throws(format('select public.reviews_submit(%L, 4, 8, null)', test.id('b_bob')), 'ALREADY_REVIEWED', 'once per booking');
select test.eq(public.reviews_pending(), null::jsonb, 'Bob isn''t asked again');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 0, 'clients can''t read the reviews table (not even their own)');
select test.throws($$select * from public.reviews_skips$$, '42501', 'nor the "not now" table');

select test.login('alice');
select public.reviews_dismiss(test.id('b_alice'));
select test.eq(public.reviews_pending(), null::jsonb, '"Not now" stops the prompt for that booking');
select test.throws(format('select public.reviews_submit(%L, 5, 10, null)', test.id('b_alice')), 'ALREADY_REVIEWED', 'and it can''t be rated afterwards');
select test.throws(format('select public.reviews_dismiss(%L)', test.id('b_bob')), 'NOT_FOUND', 'you can''t dismiss someone else''s booking');

select test.login('cara');
select test.eq(public.reviews_submit(test.id('b_cara'), 3, 6, null), '{}'::jsonb, 'Cara gives Grace T 3 flowers and a 6');

-- ---------------------------------------------------------------- who reads what
select test.login('libby');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 2, 'the owner sees every review');
select test.login('mia');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 2, 'the manager sees every review');
select test.login('julia');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 1, 'Julia sees only her own class''s review');
select test.eq((select comment from public.reviews_entries), 'Loved it', '...and the comment was trimmed');
select test.login('gracet');
select test.eq((select rating::int from public.reviews_entries), 3, 'Grace T sees only hers');
select test.login('fran');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 0, 'front desk sees no reviews');
select test.throws($$select public.reviews_save_settings('https://g.page/r/x')$$, 'NOT_ALLOWED', 'front desk can''t change the setting');
select test.login('julia');
select test.throws($$select public.reviews_save_settings('https://g.page/r/x')$$, 'NOT_ALLOWED', 'an instructor can''t change the setting');
select test.login('alice');
select test.throws($$select public.reviews_save_settings('https://g.page/r/x')$$, 'NOT_ALLOWED', 'a client can''t change the setting');

-- ---------------------------------------------------------------- Google review link
select test.login('mia');
select test.throws($$select public.reviews_save_settings('javascript:alert(1)')$$, 'INVALID', 'only web addresses');
select test.eq(public.reviews_save_settings('https://g.page/r/snowy/review') ->> 'google_review_url', 'https://g.page/r/snowy/review', 'the manager saves the link');
select test.admin();
select test.studio('snowy');
insert into public.bookings (session_id, client_id, status, source, checked_in_at) values (test.id('rv_grace'), test.id('bob_client'), 'checked_in', 'staff', '2026-10-18 17:00+11');
insert into test.ids select 'b_bob2', id from public.bookings where session_id = test.id('rv_grace') and client_id = test.id('bob_client');
select test.login('bob');
select test.eq(public.reviews_submit(test.id('b_bob2'), 5, 10, null) ->> 'google_url', 'https://g.page/r/snowy/review', 'a 10 gets the Google link');
select test.admin();
insert into public.bookings (session_id, client_id, status, source, checked_in_at) values (test.id('rv_grace'), test.id('dan_client'), 'checked_in', 'staff', '2026-10-18 17:00+11');
insert into test.ids select 'b_dan2', id from public.bookings where session_id = test.id('rv_grace') and client_id = test.id('dan_client');
select test.login('dan');
select test.eq(public.reviews_submit(test.id('b_dan2'), 4, 8, null), '{}'::jsonb, 'an 8 doesn''t');
select test.login('libby');
select test.eq(public.reviews_save_settings('') ->> 'google_review_url', '', 'the owner turns it off again');

-- ---------------------------------------------------------------- Snowy vs Harbour
select test.studio('harbour');
select test.login('hana');
select test.eq(public.reviews_pending() ->> 'class_name', 'Reformer Flow', 'Hana is asked about her Harbour class');
select test.throws(format('select public.reviews_submit(%L, 5, 9, null)', test.id('b_cara')), 'NOT_FOUND', 'Hana can''t review a Snowy booking (even with the Harbour header)');
select test.eq(public.reviews_submit(test.id('h_booking'), 2, 4, 'Too loud') , '{}'::jsonb, 'Hana rates her Harbour class');
select test.login('hank');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 1, 'Hank sees only Harbour''s one review');
select test.eq((select comment from public.reviews_entries), 'Too loud', '...which is Hana''s');
select test.eq(public.reviews_save_settings('https://g.page/r/harbour') ->> 'google_review_url', 'https://g.page/r/harbour', 'Harbour saves its own link');
select test.eq(test.count($$select 1 from public.reviews_settings$$), 1, 'Hank sees only Harbour''s settings row');
select test.studio('snowy');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 0, 'Hank (Harbour staff) sees no Snowy reviews');
select test.throws($$select public.reviews_save_settings('https://example.com')$$, 'NOT_ALLOWED', 'Harbour''s owner can''t change Snowy''s link');
select test.login('libby');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 4, 'Libby sees Snowy''s four reviews');
select test.eq((select google_review_url from public.reviews_settings), '', 'Snowy''s link is still off (Harbour''s save didn''t touch it)');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.reviews_entries$$), 0, 'Libby (Snowy staff) sees no Harbour reviews');
select test.login('hana');
select test.studio('snowy');
select test.eq(public.reviews_pending(), null::jsonb, 'Hana isn''t a Snowy client: no prompt there');
select test.throws(format('select public.reviews_submit(%L, 5, 9, null)', test.id('b_dan')), 'AUTH_REQUIRED', 'and can''t rate at Snowy');

-- same-studio links in the table itself
select test.admin();
select test.throws(format('insert into public.reviews_entries (studio_id, booking_id, session_id, client_id, class_type_id, instructor_id, rating) values (%L, %L, %L, %L, %L, %L, 5)',
  test.id('harbour'), test.id('b_dan'), test.id('h_session'), test.id('dan_client'), test.id('h_type'), test.id('hank_staff')), '23503', 'a Harbour review can''t point at a Snowy client');

select test.studio(null);
rollback;
