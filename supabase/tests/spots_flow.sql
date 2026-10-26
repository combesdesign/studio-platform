-- 2300: spot (mat / reformer) selection. A room's layout and the class type's toggle decide whether a class uses spots; two people can't
-- hold one; waitlist promotions and dependants are given spots; cancelling frees the spot; capacity is untouched; clients move their own
-- spot until the class starts, staff any time until it ends; one studio can't see or change another's spots.
-- Snowy (default studio): Libby owner, Fran front desk, Alice (4 pack), Bob (2 a week), Dan (4 pack + unlimited), Fay (two 4 packs), Gus (single),
-- Cara (no pass). Harbour: Hank owner, Hana client.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create function test.sp_studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create function test.sp_count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
create function test.sp_affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute p_sql; get diagnostics n = row_count; return n; end $$;
-- the live booking of a client in a class, and the spot it holds
create function test.sp_bid(p_client text, p_session text) returns uuid language sql security definer as $$
  select id from public.bookings where client_id = test.id(p_client || '_client') and session_id = test.id(p_session)
     and status in ('booked', 'checked_in', 'waitlisted') $$;
create function test.sp_spot(p_client text, p_session text) returns text language sql security definer as $$
  select spot from public.bookings where client_id = test.id(p_client || '_client') and session_id = test.id(p_session)
     and status in ('booked', 'checked_in', 'waitlisted') $$;
grant execute on function test.sp_studio(text), test.sp_count(text), test.sp_affected(text), test.sp_bid(text, text), test.sp_spot(text, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------- Harbour: an owner, a client, a reformer class
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
insert into test.ids select 'hana_client', id from public.clients where email = 'hana@harbour.test';
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';
update public.clients set waiver_signed_at = '2026-10-01 09:00+10' where id = test.id('hana_client');
insert into public.class_types (studio_id, name, duration_min, default_capacity) values (test.id('harbour'), 'Reformer Flow', 50, 8) returning id as h_flow \gset
insert into test.ids values ('h_flow', :'h_flow');
insert into public.class_sessions (studio_id, class_type_id, starts_at, ends_at, instructor_id, capacity)
  values (test.id('harbour'), test.id('h_flow'), '2026-10-21 07:00+11', '2026-10-21 07:50+11', test.id('hank_staff'), 8) returning id as h_sess \gset
insert into test.ids values ('h_sess', :'h_sess');
\o
select test.sp_studio('snowy');

-- ---------------------------------------------------------------- a room's layout: who can set it, and what is a valid one
select test.eq((select count(*)::int from public.rooms where spot_layout is not null), 0, 'no room has a layout to begin with');
select test.eq((select count(*)::int from public.class_types where spot_picking), 0, 'and no class type has spots switched on');
select test.eq((select count(*)::int from public.bookings where spot is not null), 0, 'and no booking holds a spot: the app is unchanged until a studio turns it on');
select test.login('fran');
select test.eq(test.sp_affected($$update public.rooms set spot_layout = '{"rows":1,"cols":1,"cells":[{"label":"1","kind":"spot"}]}'$$), 0, 'front desk can''t set a layout');
select test.login('alice');
select test.eq(test.sp_affected($$update public.class_types set spot_picking = true$$), 0, 'a client can''t switch spots on');
select test.login('libby');
select test.throws(
  $$update public.rooms set spot_layout = '{"rows":1,"cols":2,"cells":[{"label":"1","kind":"spot"},{"label":"1","kind":"spot"}]}' where location_id in (select id from public.locations where is_default)$$,
  '23514', 'two spots with the same name are refused');
select test.throws(
  $$update public.rooms set spot_layout = '{"rows":2,"cols":2,"cells":[{"label":"1","kind":"spot"}]}' where location_id in (select id from public.locations where is_default)$$,
  '23514', 'a layout whose cells don''t fill the grid is refused');
select test.throws(
  $$update public.rooms set spot_layout = '{"rows":1,"cols":2,"cells":[{"label":"","kind":"unavailable"},{"label":"Instructor","kind":"instructor"}]}' where location_id in (select id from public.locations where is_default)$$,
  '23514', 'a layout with nothing to book is refused');
select test.throws(
  $$update public.rooms set spot_layout = '{"rows":11,"cols":1,"cells":[]}' where location_id in (select id from public.locations where is_default)$$,
  '23514', 'and so is one that''s too big');

-- ---------------------------------------------------------------- Alice books a class before spots exist; the class gets no spot
select test.login('alice');
select test.eq(public.book_class(test.id('s_eve')) ->> 'outcome', 'booked', 'Alice books while spots are off');
select test.admin();
select test.eq(test.sp_spot('alice', 's_eve'), null, 'spots off: no spot is given');

-- ---------------------------------------------------------------- the owner sets up a 2 x 3 layout: instructor, 4 spots, 1 out of order
select test.login('libby');
update public.rooms set spot_layout = '{"rows":2,"cols":3,"cells":[{"label":"Instructor","kind":"instructor"},{"label":"1","kind":"spot"},{"label":"2","kind":"spot"},{"label":"","kind":"unavailable"},{"label":"3","kind":"spot"},{"label":"4","kind":"spot"}]}'
 where location_id in (select id from public.locations where is_default);
select test.eq(test.sp_count($$select 1 from public.rooms where spot_layout is not null$$), 1, 'the owner sets a layout on the default room');
select test.admin();
select test.eq(test.sp_spot('alice', 's_eve'), null, 'a layout alone does nothing: the class type is still off');
select test.eq(public.session_spots(test.id('s_eve')) ->> 'enabled', 'false', 'session_spots says the class doesn''t use spots');
select test.login('libby');
update public.class_types set spot_picking = true where id = test.id('mat');
select test.admin();
select test.eq(test.sp_spot('alice', 's_eve'), '1', 'switching it on gives people already booked a spot');
select test.eq(public.session_spots(test.id('s_eve')) ->> 'enabled', 'true', 'now the class uses spots');

-- ---------------------------------------------------------------- picking while booking, auto-assign, and the clash
select test.login('bob');
select test.eq(public.book_class(test.id('s_eve'), null, null, false, false, false, '4') -> 'booking' ->> 'spot', '4', 'Bob picks spot 4 as he books');
select test.login('dan');
select test.eq(public.book_class(test.id('s_eve')) -> 'booking' ->> 'spot', '2', 'Dan picks nothing and gets the first free spot');
select test.login('fay');
select test.throws($$select public.book_class(test.id('s_eve'), null, null, false, false, false, '4')$$, 'SPOT_TAKEN', 'a taken spot is refused');
select test.throws($$select public.book_class(test.id('s_eve'), null, null, false, false, false, '9')$$, 'INVALID', 'a spot that isn''t in the layout is refused');
select test.throws($$select public.book_class(test.id('s_eve'), null, null, false, false, false, 'Instructor')$$, 'INVALID', 'so is the instructor''s place');
select test.admin();
select test.eq((select count(*)::int from public.bookings where client_id = test.id('fay_client')), 0, 'a refused spot leaves no booking behind');
select test.eq((select sum(credits_used)::int from public.passes where client_id = test.id('fay_client')), 1, '...and no credit taken (her old pack still has its one use)');
select test.login('fay');
select test.eq((select jsonb_agg(x order by x) from jsonb_array_elements_text(public.session_spots(test.id('s_eve')) -> 'taken') x), '["1", "2", "4"]'::jsonb, 'the picker is told which spots are taken');
select test.ok(public.session_spots(test.id('s_eve'))::text !~* 'alice|bob|dan|client', 'and never who holds them');
select test.admin();
select test.throws(format('update public.bookings set spot = %L where id = %L', '1', test.sp_bid('bob', 's_eve')), '23505', 'the database itself refuses two bookings in one spot (unique session + spot)');

-- ---------------------------------------------------------------- choose and move
select test.login('alice');
select test.eq(public.choose_spot(test.sp_bid('alice', 's_eve'), '3') ->> 'spot', '3', 'Alice moves to spot 3');
select test.throws(format('select public.choose_spot(%L, %L)', test.sp_bid('alice', 's_eve'), '4'), 'SPOT_TAKEN', 'she can''t take Bob''s spot');
select test.eq(public.choose_spot(test.sp_bid('alice', 's_eve'), '3') ->> 'spot', '3', 'choosing the spot you already have is fine');
select test.throws(format('select public.choose_spot(%L, %L)', test.sp_bid('alice', 's_eve'), 'zz'), 'INVALID', 'a spot outside the layout is refused');
select test.login('bob');
select test.eq(public.choose_spot(test.sp_bid('bob', 's_eve'), '1') ->> 'spot', '1', 'spot 1 was freed when Alice moved: Bob takes it');
select test.throws(format('select public.choose_spot(%L, %L)', test.sp_bid('alice', 's_eve'), '4'), 'NOT_FOUND', 'Bob can''t move Alice');
select test.login('dan');
select test.eq(public.choose_spot(test.sp_bid('dan', 's_eve'), null) ->> 'spot', '2', 'pick for me: the first free spot (Dan''s own doesn''t count against him)');
select test.login('bob');
select test.eq(public.choose_spot(test.sp_bid('bob', 's_eve')) ->> 'spot', '1', 'pick for me with no spot given');

-- ---------------------------------------------------------------- cancelling frees the spot
select test.login('bob');
select public.cancel_booking(test.sp_bid('bob', 's_eve'));
select test.admin();
select test.eq((select spot from public.bookings where client_id = test.id('bob_client') and session_id = test.id('s_eve')), null, 'a cancelled booking holds no spot');
select test.ok(not '1' = any(app.taken_spots(test.id('s_eve'))), 'spot 1 is free again');
select test.login('fay');
select test.eq(public.book_class(test.id('s_eve'), null, null, false, false, false, '1') -> 'booking' ->> 'spot', '1', 'and Fay takes it');

-- ---------------------------------------------------------------- waitlist promotion is given a spot (a class of 2)
select test.login('gus');
select test.eq(public.book_class(test.id('s_early')) -> 'booking' ->> 'spot', '1', 'Gus is first in the small class: spot 1');
select test.login('alice');
select test.eq(public.book_class(test.id('s_early')) -> 'booking' ->> 'spot', '2', 'Alice: spot 2');
select test.login('dan');
select test.eq(public.book_class(test.id('s_early')) ->> 'outcome', 'waitlisted', 'Dan is waitlisted: the class is full whatever the layout says');
select test.admin();
select test.eq(test.sp_spot('dan', 's_early'), null, 'a waitlisted booking holds no spot');
select test.login('alice');
select public.cancel_booking(test.sp_bid('alice', 's_early'));
select test.admin();
select test.eq((select status from public.bookings where id = test.sp_bid('dan', 's_early')), 'booked', 'Dan is promoted');
select test.eq(test.sp_spot('dan', 's_early'), '2', 'and is given the spot just freed');
select test.eq((select count(*)::int from public.bookings where session_id = test.id('s_early') and status = 'booked'), 2, 'capacity is as before: still 2');

-- ---------------------------------------------------------------- staff: walk-ins, moving, and capacity beyond the layout (class of 14, 4 spots)
select test.login('alice');
select test.eq(public.book_class(test.id('s_thu'), null, null, false, false, false, '4') -> 'booking' ->> 'spot', '4', 'Alice books Thursday in spot 4');
select (public.save_dependant(test.id('alice_client'), null, 'Ally', null, '2021-03-02', null) ->> 'id') as ally \gset
select test.admin();
insert into test.ids values ('ally', :'ally');
insert into test.ids values ('ally_client', :'ally');
update public.clients set waiver_signed_at = '2026-10-01 09:00+10' where id = test.id('ally');
select test.login('alice');
select test.eq(public.book_class(test.id('s_thu'), null, test.id('ally')) -> 'booking' ->> 'spot', '3', 'her dependant is given the spot next to her (3), not the first free one (1)');
select test.login('fran');
select test.eq(public.book_class(test.id('s_thu'), null, test.id('bob_client'), true, false, true, '1') -> 'booking' ->> 'spot', '1', 'front desk books a walk-in into spot 1');
select test.throws(format('select public.book_class(%L, null, %L, true, false, true, %L)', test.id('s_thu'), test.id('cara_client'), '1'), 'SPOT_TAKEN', 'and can''t double up on it');
select test.eq(public.choose_spot(test.sp_bid('bob', 's_thu'), '2', true) ->> 'spot', '2', 'front desk moves a client''s spot');
select test.eq(public.book_class(test.id('s_thu'), null, test.id('cara_client'), true, false, true) -> 'booking' ->> 'spot', '1', 'a walk-in with no choice gets the first free spot');
select test.eq(public.book_class(test.id('s_thu'), null, test.id('erin_client'), true, false, true) -> 'booking' ->> 'status', 'booked', 'a fifth person is still booked: capacity (14) decides, not the layout');
select test.admin();
select test.eq(test.sp_spot('erin', 's_thu'), null, '...with no spot (only 4 exist)');
select test.eq((select count(distinct spot)::int from public.bookings where session_id = test.id('s_thu') and spot is not null), 4, 'four people, four different spots');
select test.login('alice');
select test.throws(format('select public.choose_spot(%L, %L, true)', test.sp_bid('alice', 's_thu'), '1'), 'NOT_ALLOWED', 'a client can''t use the staff switch');

-- ---------------------------------------------------------------- when it can be changed
select test.at('2026-10-21 18:10+11');   -- Wednesday's 6pm class has started
select test.login('alice');
select test.throws(format('select public.choose_spot(%L, %L)', test.sp_bid('alice', 's_eve'), '1'), 'TOO_LATE', 'a client can''t change their spot once the class has started');
select test.login('fran');
select test.ok(public.choose_spot(test.sp_bid('alice', 's_eve'), '4', true) ->> 'spot' = '4', 'front desk still can');
select test.at('2026-10-21 19:00+11');   -- and it has finished
select test.throws(format('select public.choose_spot(%L, %L, true)', test.sp_bid('alice', 's_eve'), '3'), 'TOO_LATE', 'but not after it has ended');
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- a class type with spots off is unchanged even in a room with a layout
select test.login('alice');
select test.eq(public.book_class(test.id('s_cancel')) -> 'booking' ->> 'spot', null, 'Mums + Bubs (spots off) books with no spot');
select test.eq(public.session_spots(test.id('s_cancel')) ->> 'enabled', 'false', '...and says so');
select test.throws(format('select public.choose_spot(%L, %L)', test.sp_bid('alice', 's_cancel'), '1'), 'INVALID', 'choosing a spot there is refused');
select test.login('cara');
select test.throws(format('select public.book_class(%L, null, null, false, false, false, %L)', test.id('s_cancel'), '1'), 'INVALID', 'and so is asking for one as you book');

-- ---------------------------------------------------------------- the other studio can't see or change any of it
select test.sp_studio('harbour');
select test.login('hank');
select test.eq(test.sp_count($$select 1 from public.rooms where spot_layout is not null$$), 0, 'Hank sees no layouts: Snowy''s is Snowy''s');
select test.eq(test.sp_count($$select 1 from public.bookings where spot is not null$$), 0, 'and no one''s booking spots');
select test.throws(format('select public.choose_spot(%L, %L, true)', test.sp_bid('alice', 's_thu'), '2'), 'NOT_FOUND', 'Hank can''t move a Snowy booking from his own studio');
select test.throws(format('select public.session_spots(%L)', test.id('s_thu')), 'NOT_FOUND', '...or read a Snowy class''s spots');
select test.eq(test.sp_affected($$update public.rooms set spot_layout = '{"rows":1,"cols":1,"cells":[{"label":"1","kind":"spot"}]}'$$), 1, 'Hank sets Harbour''s own layout (only its own room changes)');
select test.eq(test.sp_affected($$update public.class_types set spot_picking = true$$), 1, '...and switches Harbour''s only class type on');
select test.eq(public.book_class(test.id('h_sess'), null, test.id('hana_client'), true, false, true) -> 'booking' ->> 'spot', '1', 'a Harbour client gets spot 1 even though Snowy''s spot 1 is taken in its own classes');
select test.sp_studio('snowy');
select test.login('libby');
select test.eq(test.sp_count($$select 1 from public.rooms where spot_layout is not null$$), 1, 'Libby still sees exactly Snowy''s one layout');
select test.throws(format('select public.choose_spot(%L, %L, true)', test.sp_bid('hana', 'h_sess'), '1'), 'NOT_FOUND', 'Libby can''t touch a Harbour booking from Snowy');
select test.sp_studio('harbour');
select test.throws(format('select public.choose_spot(%L, %L, true)', test.sp_bid('hana', 'h_sess'), '1'), 'NOT_ALLOWED', 'or from the Harbour address (she isn''t Harbour staff)');
select test.eq(test.sp_affected($$update public.rooms set spot_layout = null$$), 0, '...and can''t clear Harbour''s layout');
select test.login('hana');
select test.eq(public.choose_spot(test.sp_bid('hana', 'h_sess')) ->> 'spot', '1', 'Hana, a Harbour client, can use pick for me in her own studio');
select test.anon();
select test.throws(format('select public.choose_spot(%L)', test.sp_bid('hana', 'h_sess')), '42501', 'signed-out visitors can''t choose spots');

rollback;
