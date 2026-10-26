-- Online classes (on-demand video): locked vs unlocked per row, access through a flagged product, free videos, views, staff CRUD,
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
update public.studios set plan_id = '9c000000-0000-4000-8000-000000000003', billing_status = 'active', billing_comped = true where slug = 'harbour';  -- billing_plans.sql covers locked plans; these tests need the features on
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

-- ---------------------------------------------------------------- Harbour: a client and its own video
select test.studio('harbour');
select test.login('hank');
select public.ondemand_save_video(null, 'Harbour flow', 'Calm', 'Hank', 30, 'All levels', 'Full body', '', 'https://vimeo.com/123456789/abcdef1234', true, false) ->> 'id' as h_video \gset
select test.admin();
insert into test.ids values ('h_video', :'h_video');
insert into public.products (studio_id, kind, name, price_cents, credits) values (test.id('harbour'), 'dropin', 'Harbour single', 4200, 1) returning id as h_product \gset
insert into test.ids values ('h_product', :'h_product');

-- ---------------------------------------------------------------- Snowy: staff add videos
select test.studio('snowy');
select test.login('libby');
select public.ondemand_save_video(null, 'Mums + Bubs: getting started', 'Gentle', 'Grace P', 18, 'Postnatal', 'Mums + Bubs', 'img/portrait.webp', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', true, true) ->> 'id' as v_free \gset
select public.ondemand_save_video(null, 'Core foundations', '', 'Julia', 25, '', 'Core', '', 'https://example.test/core.mp4', true, false) ->> 'id' as v_paid \gset
select public.ondemand_save_video(null, 'Draft stretch', '', 'Libby', 12, 'All levels', 'Stretch', '', 'https://vimeo.com/987654321', false, false) ->> 'id' as v_draft \gset
select test.admin();
insert into test.ids values ('v_free', :'v_free'), ('v_paid', :'v_paid'), ('v_draft', :'v_draft');
select test.studio('snowy');
select test.login('libby');

select test.throws($$select public.ondemand_save_video(null, '', '', '', 10, '', 'Core', '', 'https://vimeo.com/123456', true, false)$$, 'INVALID', 'a title is required');
select test.throws($$select public.ondemand_save_video(null, 'x', '', '', 0, '', 'Core', '', 'https://vimeo.com/123456', true, false)$$, 'INVALID', 'a length of 0 is refused');
select test.throws($$select public.ondemand_save_video(null, 'x', '', '', 10, '', 'Core', '', 'https://example.test/page.html', true, false)$$, 'INVALID', 'only Vimeo, YouTube or a video file');
select test.throws($$select public.ondemand_save_video(null, 'x', '', '', 10, '', 'Core', '', 'javascript:alert(1)', true, false)$$, 'INVALID', 'not a script address');
select test.throws($$select public.ondemand_save_video(null, 'x', '', '', 10, '', 'Core', 'javascript:alert(1)', 'https://vimeo.com/123456', true, false)$$, 'INVALID', 'nor a script thumbnail');
select test.eq(public.ondemand_save_video(null, 'Mat', '', '', 10, '', 'Core', '', 'https://example.test/a.mp4', false, false) ->> 'level', 'All levels', 'level defaults');

select test.eq(jsonb_array_length(public.ondemand_admin_list()), 4, 'the owner sees all four Snowy videos (the draft too)');
select test.eq((public.ondemand_admin_list() -> 0) ->> 'title', 'Mums + Bubs: getting started', 'in the order they were added');
-- reorder: put the draft first
select public.ondemand_reorder(array[test.id('v_draft'), test.id('v_free'), test.id('v_paid'), (select id from public.ondemand_videos where title = 'Mat')]);
select test.eq((public.ondemand_admin_list() -> 0) ->> 'title', 'Draft stretch', 'reorder puts the draft first');
select test.throws(format('select public.ondemand_reorder(array[%L, %L]::uuid[])', test.id('v_free'), test.id('v_free')), 'INVALID', 'each video once');
select test.throws(format('select public.ondemand_reorder(array[%L]::uuid[])', test.id('h_video')), 'NOT_FOUND', 'a Harbour video can''t be reordered from Snowy');
select public.ondemand_set_published(test.id('v_draft'), true);
select test.eq((select published from public.ondemand_videos where id = test.id('v_draft')), true, 'publish');
select public.ondemand_set_published(test.id('v_draft'), false);
select test.eq((select published from public.ondemand_videos where id = test.id('v_draft')), false, 'unpublish');
select public.ondemand_delete_video((select id from public.ondemand_videos where title = 'Mat'));
select test.eq(jsonb_array_length(public.ondemand_admin_list()), 3, 'delete');

-- which products include online classes: Bob's membership (2 a week) is flagged, Alice's 4-pack is not
select test.throws(format('select public.ondemand_save_products(array[%L]::uuid[])', test.id('h_product')), 'NOT_FOUND', 'only products of this studio');
select test.eq(public.ondemand_save_products(array[test.id('p_week2')]), jsonb_build_array(test.id('p_week2')), 'flag the 2-a-week membership');
select test.eq(test.count($$select 1 from public.ondemand_products$$), 1, 'the owner can read the flags');

-- ---------------------------------------------------------------- locked vs unlocked (the heart of it)
select test.login('bob');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, true, 'Bob (flagged membership) has access');
select test.eq(jsonb_array_length(public.ondemand_list_videos() -> 'videos'), 2, 'clients only get published videos (not the draft)');
select test.eq(test.count($$select 1 from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where (v ->> 'locked')::boolean$$), 0, 'nothing is locked for Bob');
select test.eq(test.count($$select 1 from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where v ->> 'video_url' is null$$), 0, 'and every address comes back');

select test.login('alice');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, false, 'Alice (an unflagged 4-pack) has no access');
select test.eq((select (v ->> 'locked')::boolean from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where v ->> 'title' = 'Core foundations'), true, 'the paid video is locked for her');
select test.eq((select v ->> 'video_url' from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where v ->> 'title' = 'Core foundations'), null, '...and its address is withheld');
select test.eq((select (v ->> 'locked')::boolean from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where v ->> 'title' like 'Mums%'), false, 'the free video is open');
select test.ok((select v ->> 'video_url' from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where v ->> 'title' like 'Mums%') like 'https://www.youtube.com/%', '...with its address');
select test.eq(test.count($$select 1 from public.ondemand_videos$$), 0, 'a client can''t read the table (so a locked address can''t leak)');
select test.eq(test.count($$select 1 from public.ondemand_products$$), 0, 'nor the flags');
select test.throws($$select * from public.ondemand_views$$, '42501', 'nor the views');
select test.throws($$select public.ondemand_admin_list()$$, 'NOT_ALLOWED', 'nor the staff list');
select test.throws($$select public.ondemand_save_products(array[]::uuid[])$$, 'NOT_ALLOWED', 'nor change the flags');
select test.throws(format('select public.ondemand_set_published(%L, true)', test.id('v_draft')), 'NOT_ALLOWED', 'nor publish');
select test.throws(format('select public.ondemand_record_view(%L)', test.id('v_paid')), 'LOCKED', 'pressing play on a locked video is refused');
select test.throws(format('select public.ondemand_record_view(%L)', test.id('v_draft')), 'NOT_FOUND', 'a draft doesn''t exist for clients');
select public.ondemand_record_view(test.id('v_free'));
select public.ondemand_record_view(test.id('v_free'));
select test.ok((select v ->> 'last_watched_at' from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where v ->> 'title' like 'Mums%') is not null, 'the free video shows as recently watched');

select test.login('cara');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, false, 'Cara has no pass: no access');
select test.eq(test.count($$select 1 from jsonb_array_elements(public.ondemand_list_videos() -> 'videos') v where not (v ->> 'locked')::boolean$$), 1, '...but the free video is open to anyone signed in');

select test.login('bob');
select public.ondemand_record_view(test.id('v_paid'));
select test.login('libby');
select test.eq(((public.ondemand_admin_list()) -> 1 ->> 'views')::int, 2, 'views are counted: 2 plays of the free video (Alice, twice)');
select test.eq((select (v ->> 'views')::int from jsonb_array_elements(public.ondemand_admin_list()) v where v ->> 'title' = 'Core foundations'), 1, '...and 1 of the paid one (Bob)');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, true, 'the owner previews everything');
select public.ondemand_record_view(test.id('v_paid'));
select test.eq((select (v ->> 'views')::int from jsonb_array_elements(public.ondemand_admin_list()) v where v ->> 'title' = 'Core foundations'), 1, '...without counting as a view');

-- a pass that stops counting: unflag, or it expires
select public.ondemand_save_products(array[]::uuid[]);
select test.login('bob');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, false, 'untick the product and Bob loses access');
select test.login('libby');
select public.ondemand_save_products(array[test.id('p_week2')]);
select test.admin();
select test.studio('snowy');
update public.passes set status = 'paused' where client_id = test.id('bob_client');
select test.login('bob');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, false, 'a paused membership doesn''t unlock');
select test.admin();
select test.studio('snowy');
update public.passes set status = 'active', expires_at = '2026-10-01 00:00+10' where client_id = test.id('bob_client');
select test.login('bob');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, false, 'an expired pass doesn''t unlock');
select test.admin();
select test.studio('snowy');
update public.passes set expires_at = null where client_id = test.id('bob_client');

-- ---------------------------------------------------------------- front desk / instructors
select test.login('fran');
select test.throws($$select public.ondemand_admin_list()$$, 'NOT_ALLOWED', 'front desk can''t manage videos');
select test.throws($$select public.ondemand_list_videos()$$, 'AUTH_REQUIRED', 'and have no client library');
select test.login('mia');
select test.eq(jsonb_array_length(public.ondemand_admin_list()), 3, 'the manager can');

-- ---------------------------------------------------------------- Snowy vs Harbour
select test.studio('harbour');
select test.login('hank');
select test.eq(jsonb_array_length(public.ondemand_admin_list()), 1, 'Hank sees only Harbour''s one video');
select test.eq(test.count($$select 1 from public.ondemand_videos$$), 1, '...and the table agrees');
select test.eq(test.count($$select 1 from public.ondemand_products$$), 0, '...none of Snowy''s flags');
select test.throws(format('select public.ondemand_set_published(%L, false)', test.id('v_free')), 'NOT_FOUND', 'he can''t change a Snowy video');
select test.throws(format('select public.ondemand_delete_video(%L)', test.id('v_free')), 'NOT_FOUND', 'or delete one');
select test.throws(format('select public.ondemand_save_video(%L, ''x'', '''', '''', 10, '''', ''Core'', '''', ''https://vimeo.com/123456'', true, false)', test.id('v_free')), 'NOT_FOUND', 'or edit one');
select test.login('hana');
select test.eq((public.ondemand_list_videos() ->> 'access')::boolean, false, 'Hana has no pass');
select test.eq(jsonb_array_length(public.ondemand_list_videos() -> 'videos'), 1, 'Hana sees only Harbour''s video');
select test.eq((public.ondemand_list_videos() -> 'videos' -> 0 ->> 'locked')::boolean, true, '...locked');
select test.throws(format('select public.ondemand_record_view(%L)', test.id('v_free')), 'NOT_FOUND', 'she can''t play a Snowy video, even a free one');
select test.login('alice');
select test.throws($$select public.ondemand_list_videos()$$, 'AUTH_REQUIRED', 'Snowy''s Alice is no client at Harbour');
select test.admin();
select test.throws(format('insert into public.ondemand_products (studio_id, product_id) values (%L, %L)', test.id('harbour'), test.id('p_week2')), '23503', 'a Harbour flag can''t point at a Snowy product');
select test.throws(format('insert into public.ondemand_views (studio_id, video_id, client_id) values (%L, %L, %L)', test.id('harbour'), test.id('v_free'), test.id('hana_client')), '23503', 'a Harbour view can''t point at a Snowy video');

select test.studio(null);
rollback;
