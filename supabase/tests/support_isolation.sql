-- Support: sending, who reads what, platform admin across studios, the status banner, and Snowy vs Harbour isolation.
-- Snowy: Libby owner, Mia manager, Fran front desk, Julia instructor, Alice client. Harbour: Hank owner. Pete: platform admin.
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

-- ---------------------------------------------------------------- Harbour and Pete (platform admin)
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

-- ---------------------------------------------------------------- sending
select test.studio('snowy');
select test.login('fran');
select (public.support_send('  Clients can''t pay for a pack  ', true, null, '#/pos', '0.1.0', 'Safari on iPhone', null) ->> 'id') as r_fran \gset
select test.eq((select body from public.support_requests where id = :'r_fran'), 'Clients can''t pay for a pack', 'the text is trimmed and saved');
select test.eq((select staff_name || '/' || staff_role || '/' || studio_name from public.support_requests where id = :'r_fran'), 'Fran Desk/front_desk/' || (select name from public.studios where slug = 'snowy'), 'who and which studio are attached by the database, not the browser');
select test.eq((select reply_by from public.support_requests where id = :'r_fran'), null::timestamptz, 'urgent requests carry no reply-by time');
select test.eq((select count(*)::int from public.support_messages where request_id = :'r_fran'), 1, 'the request is the first message in its thread');
select (public.support_send('How do I add a staff member?', false, null, '#/settings/staff', '0.1.0', 'Chrome on Mac', '2026-10-19 11:00+11') ->> 'id') as r_fran2 \gset
select test.eq((select reply_by from public.support_requests where id = :'r_fran2'), '2026-10-19 11:00+11'::timestamptz, 'a normal request keeps its reply-by time');
select test.throws($$select public.support_send('   ', false)$$, 'INVALID', 'an empty request is refused');
select test.throws(format('select public.support_send(%L)', repeat('x', 4001)), 'INVALID', 'a very long one is refused');
select test.throws($$select public.support_send('hi', false, 'data:text/html;base64,AAAA')$$, 'INVALID', 'only images can be attached');
select test.login('alice');
select test.throws($$select public.support_send('hello', false)$$, 'NOT_ALLOWED', 'a client can''t send support requests');
select test.eq(test.count($$select 1 from public.support_requests$$), 0, 'and can''t read them');
select test.throws($$insert into public.support_requests (body, staff_name, staff_role) values ('x', 'a', 'b')$$, '42501', 'nor write the table directly');

-- ---------------------------------------------------------------- who reads what
select test.login('julia');
select (public.support_send('The timetable shows the wrong teacher', false, null, '#/schedule', '0.1.0', '', '2026-10-19 11:00+11') ->> 'id') as r_julia \gset
select test.eq(test.count($$select 1 from public.support_requests$$), 1, 'an instructor sees only her own request');
select test.throws(format('select public.support_follow(%L, %L)', :'r_fran', 'me too'), 'NOT_FOUND', 'and can''t add to someone else''s thread');
select test.login('fran');
select test.eq(test.count($$select 1 from public.support_requests$$), 2, 'front desk sees hers (two)');
select test.login('libby');
select test.eq(test.count($$select 1 from public.support_requests$$), 3, 'the owner sees the whole studio''s requests');
select test.login('mia');
select test.eq(test.count($$select 1 from public.support_messages$$), 3, 'the manager sees the threads too');
select public.support_follow(:'r_julia', 'Julia, is it the Monday mat class?');
select test.login('julia');
select test.eq((select count(*)::int from public.support_messages where request_id = :'r_julia'), 2, 'a follow-up lands in the thread');

-- ---------------------------------------------------------------- platform admin: across studios
select test.studio('harbour');
select test.login('hank');
select (public.support_send('Can we use our own logo on receipts?', false, null, '#/settings/branding', '0.1.0', '', '2026-10-19 11:00+11') ->> 'id') as r_hank \gset
select test.eq(test.count($$select 1 from public.support_requests$$), 1, 'Hank sees only Harbour''s request');
select test.throws(format('select public.support_follow(%L, %L)', :'r_fran', 'hello'), 'NOT_FOUND', 'Hank can''t add to a Snowy thread');
select test.throws(format('select public.support_admin_reply(%L, %L)', :'r_fran', 'hi'), 'NOT_ALLOWED', 'and isn''t a platform admin');
select test.throws($$select public.support_admin_set_banner('Payments are slow', 'warn')$$, 'NOT_ALLOWED', 'so he can''t set the status banner either');
select test.login('libby');   -- a Snowy owner using Harbour's header sees nothing of Harbour's
select test.eq(test.count($$select 1 from public.support_requests$$), 0, 'a Snowy owner reads nothing from Harbour (no membership there)');

select test.studio(null);
select test.login('pete');
select test.eq(test.count($$select 1 from public.support_requests$$), 4, 'Pete reads every studio''s requests with no studio picked');
select test.eq(test.count($$select 1 from public.support_requests where urgent$$), 1, '...and the urgent one is flagged');
select test.eq(test.count($$select 1 from public.support_messages$$), 5, '...and every thread');
select public.support_admin_reply(:'r_fran', 'On it now. Looking at Stripe.');
select test.eq((select status from public.support_requests where id = :'r_fran'), 'waiting', 'a reply moves the request to waiting');
select public.support_admin_reply(:'r_hank', 'Yes, upload it in Settings > Branding. Done on our side.', 'resolved');
select test.eq((select status from public.support_requests where id = :'r_hank'), 'resolved', 'or straight to resolved');
select test.eq((select author_name from public.support_messages where request_id = :'r_hank' and from_platform), 'Pete', 'the reply is signed with Pete''s first name');
select public.support_admin_set_status(:'r_fran', 'resolved');
select test.eq((select status from public.support_requests where id = :'r_fran'), 'resolved', 'Pete can set a status without replying');
select test.throws(format('select public.support_admin_set_status(%L, %L)', :'r_fran', 'closed'), 'INVALID', 'unknown statuses are refused');

-- ---------------------------------------------------------------- the reply shows in the studio's thread
select test.studio('snowy');
select test.login('fran');
select test.eq((select count(*)::int from public.support_messages where request_id = :'r_fran' and from_platform), 1, 'Fran sees Pete''s reply in her thread');
select test.studio('harbour');
select test.login('hank');
select test.eq((select count(*)::int from public.support_messages where request_id = :'r_hank' and from_platform), 1, 'Hank sees his');
select test.eq(test.count($$select 1 from public.support_messages where from_platform$$), 1, '...and only his');
update public.support_requests set body = 'edited';
select test.eq(test.count($$select 1 from public.support_requests where body = 'edited'$$), 0, 'staff can''t edit a request directly (no policy lets the update touch a row)');
select test.throws($$delete from public.support_requests$$, '42501', 'or delete one');

-- ---------------------------------------------------------------- the status banner
select test.studio(null);
select test.login('pete');
select test.eq(public.support_admin_set_banner('  Payments are slow right now, we''re on it  ', 'warn') ->> 'message', 'Payments are slow right now, we''re on it', 'Pete sets a platform-wide message');
select test.throws(format('select public.support_admin_set_banner(%L)', repeat('x', 201)), 'INVALID', 'a long one is refused');
select test.throws($$select public.support_admin_set_banner('hi', 'red')$$, 'INVALID', 'so is an unknown tone');
select test.studio('snowy');
select test.login('mia');
select test.eq((select message from public.support_status), 'Payments are slow right now, we''re on it', 'every studio''s staff see it');
select test.studio('harbour');
select test.login('hank');
select test.eq((select tone from public.support_status), 'warn', '...including Harbour');
select test.throws($$update public.support_status set message = 'hacked'$$, '42501', 'but can''t change it');
select test.studio(null);
select test.login('pete');
select test.eq(public.support_admin_set_banner('') ->> 'message', '', 'an empty message clears it');

rollback;
\o
