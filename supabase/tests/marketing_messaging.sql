-- Messaging (2800): who can use the inbox, and the two email alerts (to the studio when a client writes, to the client when the
-- studio replies): batched to one per conversation per 15 minutes, switchable, and re-checked when the sender claims the queue.
\o /dev/null
begin;
select test.at('2026-10-27 09:00+11');
create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create or replace function test.count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
grant execute on function test.studio(text), test.count(text) to anon, authenticated, service_role;
create temp table mk (k text primary key, v text);
grant all on mk to authenticated, service_role;

select test.admin();
update public.studios set email = 'hello@snowy.example.test' where slug = 'snowy';
update public.clients set marketing_opt_in = false;   -- the inbox emails are service messages: they must go to people who opted out of news too

select test.studio('snowy');
select test.login('libby');
select test.eq(public.marketing_get_settings() ->> 'inboxAccess', 'no_instructors', 'default: owner, managers and front desk (what the inbox always did)');
select test.eq((public.marketing_get_settings() ->> 'emailStudio')::boolean, true, 'studio alerts are on by default');
select test.eq((public.marketing_get_settings() ->> 'emailClient')::boolean, true, 'client emails are on by default');
select test.throws($$select public.marketing_update_settings('{"inboxAccess":"everyone"}')$$, 'INVALID', 'unknown access level refused');

-- ---------------------------------------------------------------- who can see the inbox
select test.login('alice');
select public.marketing_send_my_message('Hi! Can I bring a friend on Saturday?');

select test.login('libby');  select test.ok(public.marketing_inbox_unread() >= 1, 'default: owner');
select test.login('mia');    select test.ok(public.marketing_inbox_unread() >= 1, 'default: manager');
select test.login('fran');   select test.ok(public.marketing_inbox_unread() >= 1, 'default: front desk');
select test.login('julia');
select test.throws($$select public.marketing_list_threads()$$, 'NOT_ALLOWED', 'default: an instructor can''t list conversations');
select test.throws($$select public.marketing_get_thread(test.id('alice_client'))$$, 'NOT_ALLOWED', 'default: ...or open one');
select test.throws($$select public.marketing_send_staff_message(test.id('alice_client'), 'hi')$$, 'NOT_ALLOWED', 'default: ...or reply');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 0, 'default: an instructor can''t read messages through the API');
select test.eq(test.count($$select 1 from public.marketing_threads$$), 0, 'default: ...or threads');
select test.eq((public.marketing_inbox_access() ->> 'allowed')::boolean, false, 'an instructor is told they have no access');

select test.login('libby');
select public.marketing_update_settings('{"inboxAccess":"owner"}');
select test.eq(public.marketing_inbox_access() ->> 'access', 'owner', 'owner only is saved');
select test.login('mia');
select test.throws($$select public.marketing_list_threads()$$, 'NOT_ALLOWED', 'owner only: a manager is out');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 0, 'owner only: a manager can''t read messages through the API');
select test.login('fran');
select test.throws($$select public.marketing_inbox_unread()$$, 'NOT_ALLOWED', 'owner only: front desk is out');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 0, 'owner only: front desk can''t read messages through the API');
select test.login('libby');
select test.eq(jsonb_array_length(public.marketing_list_threads()), 1, 'owner only: the owner still can');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 1, 'owner only: and reads the rows');
select test.login('alice');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 1, 'a client always reads their own conversation');

select test.login('libby');
select public.marketing_update_settings('{"inboxAccess":"owner_manager"}');
select test.login('mia');  select test.ok(jsonb_array_length(public.marketing_list_threads()) = 1, 'owner + managers: a manager is in');
select test.login('fran'); select test.throws($$select public.marketing_list_threads()$$, 'NOT_ALLOWED', 'owner + managers: front desk is out');

select test.login('libby');
select public.marketing_update_settings('{"inboxAccess":"all_staff"}');
select test.login('julia');
select test.ok(jsonb_array_length(public.marketing_list_threads()) = 1, 'all staff: an instructor can read the inbox');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 1, 'all staff: ...and the rows');
select test.login('fran'); select test.ok(jsonb_array_length(public.marketing_list_threads()) = 1, 'all staff: front desk too');

select test.login('mia');
select public.marketing_update_settings('{"inboxAccess":"no_instructors"}');   -- managers can change the setting
select test.login('julia');
select test.throws($$select public.marketing_list_threads()$$, 'NOT_ALLOWED', 'back to the default: the instructor is out again');
select test.login('fran');
select test.throws($$select public.marketing_update_settings('{"inboxAccess":"all_staff"}')$$, 'NOT_ALLOWED', 'front desk can''t change who sees the inbox');

-- ---------------------------------------------------------------- the studio alert, batched
select test.admin();
delete from public.marketing_messages where source = 'inbox';
delete from public.marketing_thread_messages; delete from public.marketing_threads;
select test.at('2026-10-27 09:00+11');
select test.login('alice');
select public.marketing_send_my_message('First question');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'staff'), 1, 'a client message queues one alert');
select test.eq((select to_address from public.marketing_messages where source = 'inbox' and channel = 'email'), 'hello@snowy.example.test', 'to the studio''s contact email');
select test.eq((select payload ->> 'preview' from public.marketing_messages where source = 'inbox' and channel = 'email'), 'First question', 'with a snippet');
select test.at('2026-10-27 09:05+11');
select test.login('alice');
select public.marketing_send_my_message('Second, five minutes later');
select test.at('2026-10-27 09:14+11');
select public.marketing_send_my_message('Third, still inside the window');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'staff'), 1, 'more messages inside 15 minutes add no alert');
select test.at('2026-10-27 09:16+11');
select test.login('alice');
select public.marketing_send_my_message('Fourth, a new window');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'staff'), 2, 'after 15 minutes the next message alerts again');
select test.at('2026-10-27 09:17+11');
select test.login('bob');
select public.marketing_send_my_message('Bob here');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'staff'), 3, 'another conversation has its own window');
-- an alert for a studio with no contact email goes to the owner
update public.studios set email = '' where slug = 'snowy';
select test.at('2026-10-27 12:00+11');
select test.login('alice');
select public.marketing_send_my_message('Later');
select test.admin();
select test.eq((select to_address from public.marketing_messages where source = 'inbox' and channel = 'email' order by created_at desc, id limit 1), 'libby@example.test', 'no contact email: the owner gets it');
update public.studios set email = 'hello@snowy.example.test' where slug = 'snowy';

-- switched off: nothing is queued, and one already queued is closed when the sender claims
select test.login('libby');
select public.marketing_update_settings('{"emailStudio":false}');
select test.at('2026-10-27 13:00+11');
select test.login('alice');
select public.marketing_send_my_message('While alerts are off');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'staff' and created_at >= '2026-10-27 13:00+11'), 0, 'switched off: no alert queued');
select test.login('libby');
select public.marketing_update_settings('{"emailStudio":true}');
select test.at('2026-10-27 14:00+11');
select test.login('alice');
select public.marketing_send_my_message('Queued while on');
select test.login('libby');
select public.marketing_update_settings('{"emailStudio":false}');
select test.service();
select test.ok(not exists (select 1 from jsonb_array_elements(public.marketing_claim(array['email'], 100)) j where j ->> 'source' = 'inbox' and j -> 'payload' ->> 'audience' = 'staff'),
               'switched off after queueing: the sender is not handed the alert');
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and status = 'skipped' and payload ->> 'audience' = 'staff' and payload ->> 'preview' = 'Queued while on'), 1, '...and it is closed as skipped');
select test.login('libby');
select public.marketing_update_settings('{"emailStudio":true}');

-- ---------------------------------------------------------------- the client email, batched and conditional
select test.admin();
delete from public.marketing_messages where source = 'inbox';
select test.at('2026-10-27 15:00+11');
select test.login('libby');
select public.marketing_send_staff_message(test.id('alice_client'), 'Yes, bring her along. 9am Saturday.');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'client' and client_id = test.id('alice_client')), 1, 'a staff reply queues an email to the client');
select test.eq((select to_address from public.marketing_messages where source = 'inbox' and channel = 'email'), 'alice@example.test', 'to the client''s address');
select test.at('2026-10-27 15:10+11');
select test.login('libby');
select public.marketing_send_staff_message(test.id('alice_client'), 'One more thing');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'client'), 1, 'a second reply inside 15 minutes adds no email');
select test.at('2026-10-27 15:30+11');
select test.login('libby');
select public.marketing_send_staff_message(test.id('alice_client'), 'And later');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'client'), 2, 'later, a new email');

-- no push: the sender is handed it, with the client's name and the studio's email wording
select test.service();
select test.eq(jsonb_array_length(public.marketing_claim(array['email'], 100, null, true)), 2, 'client with no push device: both emails are claimed (push is on)');
select test.admin();
update public.marketing_messages set status = 'queued', claimed_at = null, attempts = 0 where source = 'inbox';
-- a web push device: the email is dropped, only when push is on
select test.login('alice');
select public.marketing_register_push('web', 'https://push.example.test/sub/alice', '{"p256dh":"k","auth":"a"}', 'Test browser');
select test.service();
select test.eq(jsonb_array_length(public.marketing_claim(array['email'], 100, null, false)), 2, 'push not configured: the email still goes');
select test.admin();
update public.marketing_messages set status = 'queued', claimed_at = null, attempts = 0 where source = 'inbox';
select test.service();
select test.eq(jsonb_array_length(public.marketing_claim(array['email'], 100, null, true)), 0, 'push configured and the client has a device: no email');
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and status = 'skipped'), 2, '...closed as skipped');
select test.login('alice');
select public.marketing_unregister_push('https://push.example.test/sub/alice');

-- the switches
select test.admin();
update public.marketing_messages set status = 'queued', claimed_at = null, attempts = 0, error = null where source = 'inbox';
select test.login('libby');
select public.marketing_update_settings('{"emailClient":false}');
select test.service();
select test.eq(jsonb_array_length(public.marketing_claim(array['email'], 100, null, true)), 0, '"Email clients when we reply" off: nothing is sent');
select test.login('libby');
select public.marketing_update_settings('{"emailClient":true}');
select test.admin();
update public.marketing_messages set status = 'queued', claimed_at = null, attempts = 0, error = null where source = 'inbox';
insert into public.email_templates (studio_id, kind, enabled) select id, 'message_reply', false from public.studios where slug = 'snowy';
select test.service();
select test.eq(jsonb_array_length(public.marketing_claim(array['email'], 100, null, true)), 0, 'switched off in Settings > Emails: nothing is sent');
select test.admin();
update public.email_templates set enabled = true, subject = 'News from {studio_name}', intro = 'Hi {first_name}, we replied.' where kind = 'message_reply';
update public.marketing_messages set status = 'queued', claimed_at = null, attempts = 0, error = null where source = 'inbox';
select test.service();
select test.eq(public.marketing_claim(array['email'], 100, null, true) -> 0 -> 'emailOverrides' -> 'message_reply' ->> 'subject', 'News from {studio_name}', 'the studio''s own wording reaches the sender');

-- a client with no email address gets nothing
select test.admin();
delete from public.marketing_messages where source = 'inbox';
select test.at('2026-10-27 18:00+11');
update public.clients set email = '' where id = test.id('cara_client');
select test.login('cara');
select public.marketing_send_my_message('Hello from Cara');
select test.login('libby');
select public.marketing_send_staff_message(test.id('cara_client'), 'Hi Cara');
select test.admin();
select test.eq((select count(*)::int from public.marketing_messages where source = 'inbox' and channel = 'email' and payload ->> 'audience' = 'client'), 0, 'no email address: no client email');

-- ---------------------------------------------------------------- another studio
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'hank.mm@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email = 'hank.mm@harbour.test' on conflict do nothing;
insert into mk select 'harbour', coalesce((select id::text from public.studios where slug = 'harbour'),
  public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test') ->> 'id');
select public.platform_invite_owner((select v::uuid from mk where k = 'harbour'), 'Hank', 'hank.mm@harbour.test');
update public.staff set user_id = test.id('hank.mm') where email = 'hank.mm@harbour.test' and studio_id = (select v::uuid from mk where k = 'harbour');
select test.studio('harbour'); select test.login('hank.mm');
select test.eq(public.marketing_inbox_access() ->> 'access', 'no_instructors', 'Harbour has its own inbox setting');
select public.marketing_update_settings('{"inboxAccess":"owner","emailStudio":false}');
select test.eq(test.count($$select 1 from public.marketing_messages$$), 0, 'Harbour staff can''t see Snowy''s queue');
select test.studio('snowy'); select test.login('libby');
select test.eq(public.marketing_inbox_access() ->> 'access', 'no_instructors', 'and Harbour''s change did not touch Snowy''s');
select test.eq((public.marketing_get_settings() ->> 'emailStudio')::boolean, true, '...or its alert switch');
select test.studio('snowy'); select test.login('hank.mm');
select test.throws($$select public.marketing_inbox_access()$$, 'NOT_ALLOWED', 'a Harbour owner has no inbox at Snowy');

rollback;
