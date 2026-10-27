-- Libby round two (2500): the editable client emails, the new transactional emails (waitlist, cancelled, welcome), the intro
-- check-in and Google review-ask automations, the review-ask settings, "Send a text", and studio isolation.
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

create temp table lb (k text primary key, v text);
grant all on lb to authenticated, service_role;

-- ---------------------------------------------------------------- who can see and change the emails
select test.studio('snowy');
select test.login('libby');
select test.eq(jsonb_array_length(public.list_email_templates()), 0, 'no overrides yet: everything is on, default wording');
select test.eq(public.save_email_template('booking_confirmed', '{"subject":"Booked: {class_name}","intro":"Hi {first_name}, see you soon."}') ->> 'subject',
               'Booked: {class_name}', 'the owner saves wording');
select test.login('mia');
select test.eq(public.save_email_template('waitlist_joined', '{"enabled":false}') ->> 'enabled', 'false', 'a manager can switch an email off');
select test.eq(jsonb_array_length(public.list_email_templates()), 2, 'two overrides stored');
select test.login('fran');
select test.throws($$select public.list_email_templates()$$, 'NOT_ALLOWED', 'front desk can''t see the email settings');
select test.throws($$select public.save_email_template('welcome', '{"enabled":false}')$$, 'NOT_ALLOWED', '...or change them');
select test.throws($$select public.send_test_email('welcome')$$, 'NOT_ALLOWED', '...or send tests');
select test.eq(test.count($$select 1 from public.email_templates$$), 0, '...or read the table');
select test.login('julia');
select test.throws($$select public.save_email_template('welcome', '{"enabled":false}')$$, 'NOT_ALLOWED', 'instructors can''t either');
select test.login('alice');
select test.throws($$select public.list_email_templates()$$, 'NOT_ALLOWED', 'clients can''t');
select test.anon();
select test.throws($$select public.list_email_templates()$$, '42501', 'signed-out visitors can''t call it');
select test.login('libby');
select test.throws($$select public.save_email_template('nope', '{}')$$, 'NOT_FOUND', 'unknown email');
select test.throws($$select public.save_email_template('welcome', jsonb_build_object('subject', repeat('x', 151)))$$, 'INVALID', 'subject length is limited');
select test.eq(public.save_email_template('booking_confirmed', '{"subject":"","intro":""}') ->> 'subject', null, 'blank goes back to the default wording');
select test.eq(jsonb_array_length(public.list_email_templates()), 1, '...and the row disappears when it is all default');
select test.eq(public.send_test_email('class_cancelled') ->> 'to', 'libby@example.test', 'a test goes to the signed-in staff member');
select test.admin();
select test.ok((select (payload ->> 'is_test')::boolean from public.notifications where kind = 'class_cancelled' and to_email = 'libby@example.test'), 'the test is queued as a test');

-- ---------------------------------------------------------------- the switch: waitlist email is off, so none is queued
select test.login('alice'); select public.book_class(test.id('s_early'));
select test.login('bob');   select public.book_class(test.id('s_early'));
select test.login('cara');
select test.eq(public.book_class(test.id('s_early')) ->> 'outcome', 'waitlisted', 'full class: Cara waitlisted');
select test.admin();
select test.eq((select count(*)::int from public.notifications where kind = 'waitlist_joined'), 0, 'waitlist email switched off: nothing queued');
select test.eq((select count(*)::int from public.notifications where kind = 'booking_confirmed' and to_email = 'alice@example.test'), 1, 'booking confirmed still goes');
select test.login('libby'); select public.save_email_template('waitlist_joined', '{"enabled":true}');
select test.login('fay');
select test.eq(public.book_class(test.id('s_early')) ->> 'outcome', 'waitlisted', 'Fay waitlisted');
select test.admin();
select test.eq((select count(*)::int from public.notifications where kind = 'waitlist_joined'), 1, 'switched back on: Fay''s waitlist email is queued');
select test.eq((select payload ->> 'waitlist_position' from public.notifications where kind = 'waitlist_joined'), '2', '...with her position');
select test.eq((select to_email from public.notifications where kind = 'waitlist_joined'), 'fay@example.test', '...to her');

-- ---------------------------------------------------------------- booking cancelled: only when the client cancels
select test.login('bob'); select public.book_class(test.id('s_thu'));
select test.login('alice'); select public.book_class(test.id('s_thu'));
select test.admin();
select test.login('alice');
select public.cancel_booking((select id from public.bookings where client_id = test.id('alice_client') and session_id = test.id('s_thu') and status = 'booked'));
select test.admin();
select test.eq((select count(*)::int from public.notifications where kind = 'booking_cancelled' and to_email = 'alice@example.test'), 1, 'a client''s own cancel sends "Booking cancelled"');
select test.eq((select (payload ->> 'late')::boolean from public.notifications where kind = 'booking_cancelled' and to_email = 'alice@example.test'), false, '...early, so not late');
select test.eq((select (payload ->> 'credit_returned')::boolean from public.notifications where kind = 'booking_cancelled' and to_email = 'alice@example.test'), true, '...and the credit is back');
-- Staff cancelling on a client's behalf is not the client cancelling.
select test.login('fran');
select public.cancel_booking((select id from public.bookings where client_id = test.id('bob_client') and session_id = test.id('s_thu') and status = 'booked'), false, true);
select test.admin();
select test.eq((select count(*)::int from public.notifications where kind = 'booking_cancelled' and to_email = 'bob@example.test'), 0, 'staff cancelling for a client: no cancelled email');
-- Late cancel (Fay: booked via the promotion below is overkill; use Erin-free Dan with a pack).
select test.login('dan'); select public.book_class(test.id('s_fri'));
select test.at('2026-10-23 04:00+11');   -- two hours before s_fri (inside the 3h window)
select public.cancel_booking((select id from public.bookings where client_id = test.id('dan_client') and session_id = test.id('s_fri') and status = 'booked'));
select test.at('2026-10-19 08:00+11');
select test.admin();
select test.eq((select (payload ->> 'late')::boolean from public.notifications where kind = 'booking_cancelled' and to_email = 'dan@example.test'), true, 'a late cancel is flagged late');
select test.eq((select (payload ->> 'credit_returned')::boolean from public.notifications where kind = 'booking_cancelled' and to_email = 'dan@example.test'), false, '...and no credit comes back');

-- ---------------------------------------------------------------- welcome: one owner
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'wendy@example.test', '{"first_name":"Wendy"}', now());
select test.eq((select count(*)::int from public.notifications where kind = 'welcome' and to_email = 'wendy@example.test'), 1, 'a new sign-up gets the transactional welcome (not opted in)');
-- Libby opens Marketing (creates the settings and the automations, Welcome on). An opted-in client is left to the Welcome automation.
select test.login('libby');
select test.eq(jsonb_array_length(public.marketing_list_automations()), 10, 'marketing automations exist (intro check-in and review ask included)');
select test.eq((select a ->> 'delay' from jsonb_array_elements(public.marketing_list_automations()) a where a ->> 'key' = 'intro_checkin'), '7', 'intro check-in defaults to day 7 (mid-offer)');
select test.eq((select a ->> 'enabled' from jsonb_array_elements(public.marketing_list_automations()) a where a ->> 'key' = 'intro_checkin'), 'true', '...and is on');
select test.admin();
insert into public.clients (first_name, last_name, email, marketing_opt_in) values ('Oli', 'Opt', 'oli@example.test', true);
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'oli@example.test', '{"first_name":"Oli"}', now());
select test.eq((select count(*)::int from public.clients where email = 'oli@example.test' and user_id is not null), 1, 'Oli''s login is linked to his client');
select test.eq((select count(*)::int from public.notifications where kind = 'welcome' and to_email = 'oli@example.test'), 0, 'opted-in + Welcome automation on: no transactional welcome');
select test.login('libby'); select public.marketing_save_automation('{"key":"welcome","enabled":false}');
select test.admin();
insert into public.clients (first_name, last_name, email, marketing_opt_in) values ('Pam', 'Opt', 'pam@example.test', true);
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'pam@example.test', '{"first_name":"Pam"}', now());
select test.eq((select count(*)::int from public.notifications where kind = 'welcome' and to_email = 'pam@example.test'), 1, 'Welcome automation off: the transactional welcome goes instead');
select test.login('libby'); select public.marketing_save_automation('{"key":"welcome","enabled":true}');
select test.eq((select count(*)::int from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'welcome' and i ->> 'clientName' like 'Pam%'), 0, 'the Welcome automation skips someone who already got the transactional welcome');
select test.admin();
update public.notifications set studio_id = studio_id where false;   -- (no-op: keeps the block tidy)

-- ---------------------------------------------------------------- intro check-in
select test.admin();
update public.clients set marketing_opt_in = true where id = test.id('alice_client');
select test.login('libby');
select test.admin();
select public.checkout_cart(test.id('erin_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro'))), 'cash');
-- The intro pass starts on first use; set it to have started 7 days ago and end in 7.
update public.passes set activated_at = app.now() - interval '7 days', expires_at = app.now() + interval '7 days'
 where client_id = test.id('erin_client') and product_id = test.id('p_intro');
update public.clients set marketing_opt_in = true where id = test.id('erin_client');
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'intro_checkin' and i ->> 'clientName' like 'Erin%') = 1, 'seven days into the intro offer: Erin gets the check-in');
select test.admin();
update public.passes set activated_at = app.now() - interval '2 days', expires_at = app.now() + interval '12 days'
 where client_id = test.id('erin_client') and product_id = test.id('p_intro');
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'intro_checkin' and i ->> 'clientName' like 'Erin%') = 0, 'two days in: too early');
select public.marketing_save_automation('{"key":"intro_checkin","delay":2}');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'intro_checkin' and i ->> 'clientName' like 'Erin%') = 1, '...unless Libby moves the day to 2');
select test.throws($$select public.marketing_save_automation('{"key":"intro_checkin","delay":14}')$$, 'INVALID', 'the day has to be inside the offer');
select public.marketing_save_automation('{"key":"intro_checkin","delay":7}');
select test.admin();
update public.clients set marketing_opt_in = false where id = test.id('erin_client');
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'intro_checkin' and i ->> 'clientName' like 'Erin%') = 0, 'not opted in: no check-in');

-- ---------------------------------------------------------------- review settings + the Google review ask
select test.login('fran');
select test.throws($$select public.reviews_save_settings('https://g.page/r/snowy', true, 3)$$, 'NOT_ALLOWED', 'front desk can''t change the review ask');
select test.login('libby');
select test.throws($$select public.reviews_save_settings(null, true, 3)$$, 'INVALID', 'the ask needs a review link first');
select test.throws($$select public.reviews_save_settings('https://g.page/r/snowy', true, 0)$$, 'INVALID', 'N has to be at least 1');
select test.eq(public.reviews_save_settings('https://g.page/r/snowy', true, 3) ->> 'google_ask_every', '3', 'owner turns the ask on, every 3 classes');
select test.eq((select google_ask_enabled from public.reviews_settings), true, '...saved');

-- Alice: three checked-in classes in the past; the third is the milestone.
select test.admin();
select test.mk_session('r1', 'mat', '2026-10-12 06:00+11', 14, 'julia');
select test.mk_session('r2', 'mat', '2026-10-13 06:00+11', 14, 'julia');
select test.mk_session('r3', 'mat', '2026-10-19 03:00+11', 14, 'julia');   -- finished 03:45 -> +3h = 06:45, due by 08:00
insert into public.bookings (session_id, client_id, status, checked_in_at)
select test.id(s), test.id('alice_client'), 'checked_in', (select starts_at from public.class_sessions where id = test.id(s)) from unnest(array['r1', 'r2', 'r3']) s;
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'review_ask' and i ->> 'clientName' like 'Alice%') = 1, 'after her 3rd class, Alice is asked for a review');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'review_ask' and i ->> 'clientName' like 'Bob%') = 0, 'Bob has no check-ins: nothing');
select public.marketing_run_automations(false);
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where automation_key = 'review_ask' and client_id = test.id('alice_client')), 1, 'queued once');
select test.eq((select payload ->> 'review_url' from public.marketing_messages where automation_key = 'review_ask' and client_id = test.id('alice_client')), 'https://g.page/r/snowy',
               '...carrying the link');
select test.login('libby');
select test.eq(jsonb_array_length(public.marketing_run_automations(true) -> 'items'), 0, 'run again: she is not asked twice');

-- Three more classes: the 6th is the next milestone, but not within 60 days of the last ask.
select test.admin();
select test.mk_session('r4', 'mat', '2026-10-19 03:10+11', 14, 'julia');
select test.mk_session('r5', 'mat', '2026-10-19 03:20+11', 14, 'julia');
select test.mk_session('r6', 'mat', '2026-10-19 03:30+11', 14, 'julia');
insert into public.bookings (session_id, client_id, status, checked_in_at)
select test.id(s), test.id('alice_client'), 'checked_in', (select starts_at from public.class_sessions where id = test.id(s)) from unnest(array['r4', 'r5', 'r6']) s;
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i where i ->> 'key' = 'review_ask') = 0,
               'a 6th class inside 60 days of the last ask: not asked again');
-- 61 days later the same milestone would be fine (shift the first ask back), unless she clicked.
select test.admin();
update public.marketing_messages set created_at = app.now() - interval '61 days' where automation_key = 'review_ask' and client_id = test.id('alice_client');
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i
                 where i ->> 'key' = 'review_ask' and i ->> 'clientName' like 'Alice%') = 1, 'after 60 days, the next milestone asks again');
select test.admin();
update public.marketing_messages set clicked_at = app.now() - interval '60 days' where automation_key = 'review_ask' and client_id = test.id('alice_client');
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i where i ->> 'key' = 'review_ask') = 0,
               'once she has clicked the link, she is never asked again');
-- Switched off in Settings > Reviews: nobody.
select test.admin();
update public.marketing_messages set clicked_at = null where automation_key = 'review_ask' and client_id = test.id('alice_client');
select test.login('libby');
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i where i ->> 'key' = 'review_ask') = 1, '(sanity: asks again without the click)');
select public.reviews_save_settings(null, false, null);
select test.ok((select count(*) from jsonb_array_elements(public.marketing_run_automations(true) -> 'items') i where i ->> 'key' = 'review_ask') = 0, 'the ask switched off in Reviews: no review emails');

-- ---------------------------------------------------------------- Send a text
select test.admin();
update public.clients set phone = '0412 345 678' where id = test.id('alice_client');
update public.clients set phone = '' where id = test.id('bob_client');
select test.login('fran');
select test.eq(public.marketing_send_text(test.id('alice_client'), 'Hi Alice, your mat is ready.') ->> 'channel', 'sms', 'front desk sends a text');
select test.login('mia');
select test.ok(public.marketing_send_text(test.id('alice_client'), 'See you at 6.') ->> 'channel' = 'sms', 'a manager can too');
select test.login('libby');
select test.ok(public.marketing_send_text(test.id('alice_client'), 'Thanks for coming!') ->> 'channel' = 'sms', 'and the owner');
select test.throws($$select public.marketing_send_text(test.id('bob_client'), 'Hello')$$, 'NO_PHONE', 'no phone number: it says so');
select test.throws($$select public.marketing_send_text(test.id('alice_client'), '   ')$$, 'INVALID', 'a blank text isn''t sent');
select test.throws($$select public.marketing_send_text(test.id('alice_client'), repeat('x', 481))$$, 'INVALID', 'up to 3 texts');
select test.login('julia');
select test.throws($$select public.marketing_send_text(test.id('alice_client'), 'Hello')$$, 'NOT_ALLOWED', 'instructors can''t send texts');
select test.login('alice');
select test.throws($$select public.marketing_send_text(test.id('alice_client'), 'Hello')$$, 'NOT_ALLOWED', 'clients can''t');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where channel = 'sms' and source = 'inbox' and client_id = test.id('alice_client') and status = 'queued'), 3, 'three texts queued for the sender');
select test.eq((select to_address from public.marketing_messages where channel = 'sms' and source = 'inbox' order by created_at limit 1), '0412 345 678', '...to her number');
select test.eq((select payload ->> 'body' from public.marketing_messages where channel = 'sms' and source = 'inbox' and payload ->> 'body' like 'Hi Alice%'), 'Hi Alice, your mat is ready.', '...with the exact words');
select test.eq((select count(*)::int from public.marketing_thread_messages where client_id = test.id('alice_client') and channel = 'sms' and sender = 'staff'), 3, 'each is logged in her message history');
select test.login('fran');
select test.eq((select count(*)::int from jsonb_array_elements(public.marketing_get_thread(test.id('alice_client')) -> 'messages') m where m ->> 'channel' = 'sms'), 3, 'history shows them as texts');

-- ---------------------------------------------------------------- studio isolation
select test.admin();
insert into lb select 'harbour', coalesce((select id::text from public.studios where slug = 'harbour'),
  public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test') ->> 'id');
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'hank.l2@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email = 'hank.l2@harbour.test' on conflict do nothing;
select public.platform_invite_owner((select v::uuid from lb where k = 'harbour'), 'Hank', 'hank.l2@harbour.test');
select test.studio('harbour');
select test.login('hank.l2');
select test.eq(jsonb_array_length(public.list_email_templates()), 0, 'Harbour sees none of Snowy''s email settings');
select test.eq(public.save_email_template('welcome', '{"enabled":false}') ->> 'enabled', 'false', 'Harbour switches its own welcome off');
select test.throws($$select public.marketing_send_text(test.id('alice_client'), 'Hello')$$, 'NOT_FOUND', 'Harbour can''t text a Snowy client');
select test.studio('snowy');
select test.login('libby');
select test.eq((select count(*)::int from jsonb_array_elements(public.list_email_templates()) t where t ->> 'kind' = 'welcome'), 0, 'Snowy''s welcome is untouched');
select test.eq((select count(*)::int from public.email_templates), 0, '...and Snowy sees none of Harbour''s rows');
select test.admin();
select test.eq((select app.email_on((select v::uuid from lb where k = 'harbour'), 'welcome')), false, 'the switch is per studio');

rollback;
