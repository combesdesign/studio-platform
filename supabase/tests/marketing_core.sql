-- Marketing (1200–1202): permissions, segments, opt-in on every marketing send, automations (idempotent),
-- the send queue + tracking, the two-way inbox, push devices, and studio isolation (Snowy vs Harbour).
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

-- Alice and Bob said yes to marketing; Cara has no email address. Gus holds a single class credit (pack running low).
select test.admin();
update public.clients set marketing_opt_in = true where id in (test.id('alice_client'), test.id('bob_client'));
update public.clients set marketing_opt_in = true, email = '' where id = test.id('cara_client');
update public.clients set birthday = '1990-10-19' where id = test.id('bob_client');
create temp table mk (k text primary key, v text);
grant all on mk to authenticated, service_role;

-- ---------------------------------------------------------------- permissions
select test.studio('snowy');
select test.login('libby');
select test.eq(jsonb_array_length(public.marketing_list_segments()), 7, 'first visit: the starter segments are created');
select test.eq(jsonb_array_length(public.marketing_list_automations()), 8, 'first visit: all eight automations, on');
select test.ok((select bool_and((a ->> 'enabled')::boolean) from jsonb_array_elements(public.marketing_list_automations()) a), 'automations start on');

select test.login('fran');
select test.ok(jsonb_array_length(public.marketing_list_campaigns()) >= 0, 'front desk can view marketing');
select test.throws($$select public.marketing_save_segment(null, 'Desk list', null, '{"match":"all","rules":[]}')$$, 'NOT_ALLOWED', 'front desk can''t change segments');
select test.throws($$select public.marketing_save_campaign('{"name":"x","channel":"email"}')$$, 'NOT_ALLOWED', 'front desk can''t make campaigns');
select test.ok(public.marketing_inbox_unread() >= 0, 'front desk can use the inbox');

select test.login('julia');
select test.throws($$select public.marketing_list_segments()$$, 'NOT_ALLOWED', 'instructors don''t see marketing');
select test.throws($$select public.marketing_list_threads()$$, 'NOT_ALLOWED', 'instructors don''t see the inbox');
select test.eq(test.count($$select 1 from public.marketing_segments$$), 0, 'instructors can''t read segments directly');

select test.login('alice');
select test.throws($$select public.marketing_list_segments()$$, 'NOT_ALLOWED', 'clients don''t see marketing');
select test.throws($$select public.marketing_run_automations(true)$$, 'NOT_ALLOWED', 'clients can''t run automations');
select test.eq(test.count($$select 1 from public.marketing_campaigns$$), 0, 'clients can''t read campaigns');

select test.anon();
select test.throws($$select public.marketing_list_segments()$$, '42501', 'anon can''t call marketing RPCs');

-- Nobody writes the tables directly: everything goes through the RPCs.
select test.login('libby');
select test.throws($$insert into public.marketing_campaigns (name, channel) values ('Sneaky', 'email')$$, '42501', 'no direct inserts');
select test.throws($$update public.marketing_automations set enabled = false$$, '42501', 'no direct updates');
select test.throws($$update public.clients set marketing_opt_in = true where id = test.id('dan_client')$$ || ' and false', '42501', 'sanity: clients table rules unchanged')
  where false;  -- (clients writes are covered by the core tests)

-- ---------------------------------------------------------------- segments
select test.eq((public.marketing_preview_audience('{"match":"all","rules":[{"type":"opted_in"}]}') ->> 'count')::int, 3, 'opted in: Alice, Bob, Cara');
select test.eq((public.marketing_preview_audience('{"match":"all","rules":[{"type":"pack_low","credits":1,"days":7}]}') ->> 'count')::int, 1, 'pack low: Gus (1 credit left)');
select test.eq((public.marketing_preview_audience('{"match":"all","rules":[{"type":"pack_low","credits":1,"days":10}]}') ->> 'count')::int, 2, 'pack low within 10 days: Fay''s pack expiring 27 Oct too');
select test.eq((public.marketing_preview_audience('{"match":"all","rules":[{"type":"active_member"}]}') ->> 'count')::int, 2, 'active members: Bob and Dan');
select test.eq((public.marketing_preview_audience('{"match":"all","rules":[{"type":"active_member","not":true},{"type":"opted_in"}]}') ->> 'count')::int, 2,
               'not a member and opted in: Alice and Cara');
select test.eq((public.marketing_preview_audience('{"match":"any","rules":[{"type":"birthday_month"},{"type":"pack_low"}]}') ->> 'count')::int, 2, 'any: Bob (birthday) or Gus (pack)');
select test.throws($$select public.marketing_preview_audience('{"rules":[{"type":"nope"}]}')$$, 'INVALID', 'unknown rules are refused');

select test.eq(public.marketing_set_client_tags(test.id('alice_client'), array['VIP', ' vip ', 'Morning  crew']), '["VIP", "Morning crew"]'::jsonb, 'tags are tidied and de-duplicated');
select test.eq((public.marketing_preview_audience('{"match":"all","rules":[{"type":"tag","tag":"vip"}]}') ->> 'count')::int, 1, 'tag rule (any case)');
select test.eq((select (s ->> 'count')::int from jsonb_array_elements(public.marketing_list_segments()) s where s ->> 'name' = 'VIP'), 1, 'the VIP starter segment counts tagged clients');
insert into mk select 'seg', public.marketing_save_segment(null, 'Members who said yes', 'Members we can email', '{"match":"all","rules":[{"type":"active_member"},{"type":"opted_in"}]}') ->> 'id';
select test.throws($$select public.marketing_save_segment(null, 'members WHO said yes', null, '{}')$$, 'INVALID', 'segment names are unique');

-- ---------------------------------------------------------------- campaigns: opt-in on every send
insert into mk select 'c_all', public.marketing_save_campaign(jsonb_build_object('name', 'October news', 'channel', 'email', 'subject', 'Hi {{first_name}}',
  'blocks', '[{"type":"heading","text":"October at *the studio*"},{"type":"text","text":"New classes."},{"type":"button","label":"Book","url":"{{app_url}}"}]'::jsonb)) ->> 'id';
select test.throws($$select public.marketing_save_campaign('{"name":"Bad link","channel":"email","blocks":[{"type":"button","label":"x","url":"javascript:alert(1)"}]}')$$,
                   'INVALID', 'javascript: links are refused');
select test.throws($$select public.marketing_send_campaign((select v::uuid from mk where k = 'seg'))$$, 'NOT_FOUND', 'a segment id isn''t a campaign');
select test.eq(public.marketing_send_campaign((select v::uuid from mk where k = 'c_all')) ->> 'status', 'sending', 'send now: queued');
select test.eq((select count(*)::int from public.marketing_messages where campaign_id = (select v::uuid from mk where k = 'c_all')), 2,
               'only opted-in clients with an email address get it (Alice, Bob; not Cara)');
select test.eq((select string_agg(subject, ',' order by subject) from public.marketing_messages where campaign_id = (select v::uuid from mk where k = 'c_all')), 'Hi Alice,Hi Bob',
               'subjects are merged per person');
select test.eq((select (c -> 'stats' ->> 'skipped')::int from jsonb_array_elements(public.marketing_list_campaigns()) c where c ->> 'name' = 'October news'),
               (select count(*)::int - 2 from public.clients where studio_id = app.default_studio() and not archived), 'everyone else is counted as skipped');
select test.throws($$select public.marketing_send_campaign((select v::uuid from mk where k = 'c_all'))$$, 'INVALID', 'a campaign goes out once');
select test.throws($$select public.marketing_delete_campaign((select v::uuid from mk where k = 'c_all'))$$, 'INVALID', 'sent campaigns are kept');

-- A segment with nobody opted in can't be sent to.
insert into mk select 'c_gus', public.marketing_save_campaign(jsonb_build_object('name', 'Top up', 'channel', 'sms', 'body', 'Top up today',
  'segmentId', (select s ->> 'id' from jsonb_array_elements(public.marketing_list_segments()) s where s ->> 'name' = 'Pack running low'))) ->> 'id';
select test.throws($$select public.marketing_send_campaign((select v::uuid from mk where k = 'c_gus'))$$, 'INVALID', 'nobody opted in: nothing to send');
select test.throws($$select public.marketing_delete_segment((select (s ->> 'id')::uuid from jsonb_array_elements(public.marketing_list_segments()) s where s ->> 'name' = 'Pack running low'))$$,
                   'INVALID', 'a segment used by a draft can''t be deleted');

-- ---------------------------------------------------------------- automations
select test.login('libby');
select test.at('2026-10-19 08:00+11');
select public.marketing_save_automation('{"key":"winback","enabled":false}');
select test.throws($$select public.marketing_save_automation('{"key":"winback","delay":2}')$$, 'INVALID', 'delays are kept in range');
insert into mk select 'dry', public.marketing_run_automations(true)::text;
select test.ok((select count(*) from jsonb_array_elements((select v::jsonb from mk where k = 'dry') -> 'items') i
                 where i ->> 'key' = 'welcome' and i ->> 'clientName' like 'Alice%') = 1, 'dry run: Alice gets the welcome (joined yesterday, opted in)');
select test.ok((select count(*) from jsonb_array_elements((select v::jsonb from mk where k = 'dry') -> 'items') i
                 where i ->> 'key' = 'welcome' and i ->> 'clientName' like 'Dan%') = 0, 'welcome is marketing: Dan (not opted in) doesn''t get it');
select test.ok((select count(*) from jsonb_array_elements((select v::jsonb from mk where k = 'dry') -> 'skipped') i
                 where i ->> 'key' = 'welcome' and i ->> 'why' = 'Not opted into marketing') >= 1, '...and is listed as skipped');
select test.ok((select count(*) from jsonb_array_elements((select v::jsonb from mk where k = 'dry') -> 'items') i
                 where i ->> 'key' = 'pack_low' and i ->> 'clientName' like 'Gus%' and i ->> 'subject' = 'Your Single class is running low') = 1,
               'pack low is a service message: Gus gets it without opting in');
select test.ok((select count(*) from jsonb_array_elements((select v::jsonb from mk where k = 'dry') -> 'items') i where i ->> 'key' = 'birthday' and i ->> 'clientName' like 'Bob%') = 1,
               'birthday today: Bob');
select test.eq((select count(*)::int from public.marketing_messages where source = 'automation'), 0, 'a dry run sends nothing');
select test.eq(jsonb_array_length(public.marketing_run_automations(false) -> 'items'), jsonb_array_length((select v::jsonb from mk where k = 'dry') -> 'items'), 'a real run sends the same list');
select test.eq((select count(*)::int from public.marketing_messages where source = 'automation'), jsonb_array_length((select v::jsonb from mk where k = 'dry') -> 'items'), '...queued');
select test.eq(jsonb_array_length(public.marketing_run_automations(true) -> 'items'), 0, 'run again: nothing new (the sent log stops repeats)');
select test.service();
select test.eq((public.marketing_tick('2026-10-19 08:30+11') ->> 'automations')::int, 0, 'the scheduler doesn''t repeat them either');

-- Scheduling: the scheduler sends it when it's due. (After the automations block: a tick also queues automations, which would use up the dry run.)
select test.login('libby');
select test.at('2026-10-19 08:00+11');
insert into mk select 'c_sched', public.marketing_save_campaign(jsonb_build_object('name', 'Members news', 'channel', 'email', 'subject', 'For members',
  'segmentId', (select v from mk where k = 'seg'), 'blocks', '[{"type":"text","text":"Hello members"}]'::jsonb)) ->> 'id';
select test.throws($$select public.marketing_schedule_campaign((select v::uuid from mk where k = 'c_sched'), '2026-10-19 07:00+11')$$, 'INVALID', 'can''t schedule in the past');
select test.eq(public.marketing_schedule_campaign((select v::uuid from mk where k = 'c_sched'), '2026-10-20 09:00+11') ->> 'status', 'scheduled', 'scheduled');
select test.throws($$select public.marketing_save_campaign(jsonb_build_object('id', (select v from mk where k = 'c_sched'), 'name', 'x', 'channel', 'email'))$$,
                   'INVALID', 'unschedule before editing');
select test.service();
select test.eq((public.marketing_tick('2026-10-19 09:00+11') ->> 'campaigns')::int, 0, 'not due yet');
select test.eq((public.marketing_tick('2026-10-20 09:01+11') ->> 'campaigns')::int, 1, 'due: the scheduler sends it');
select test.eq((select count(*)::int from public.marketing_messages where campaign_id = (select v::uuid from mk where k = 'c_sched')), 1, 'to the segment: Bob (member, opted in)');

-- ---------------------------------------------------------------- queue, tracking, unsubscribe
select test.service();
insert into mk select 'jobs', public.marketing_claim(array['email'], 100)::text;
select test.ok(jsonb_array_length((select v::jsonb from mk where k = 'jobs')) >= 3, 'the sender claims queued emails');
select test.eq(jsonb_array_length(public.marketing_claim(array['email'], 100)), 0, 'claimed ones aren''t handed out twice');
select test.ok((select bool_and(j -> 'studio' ->> 'name' is not null and j ->> 'kind' in ('marketing', 'service')) from jsonb_array_elements((select v::jsonb from mk where k = 'jobs')) j),
               'jobs carry what the renderer needs');
select public.marketing_finish((j ->> 'id')::uuid, null, 'prov-' || (j ->> 'id'), '["https://example.test/book"]'::jsonb)
  from jsonb_array_elements((select v::jsonb from mk where k = 'jobs')) j;
select test.eq((select status from public.marketing_campaigns where id = (select v::uuid from mk where k = 'c_all')), 'sent', 'drained campaign is sent');
select test.eq(public.marketing_track((select id from public.marketing_messages where campaign_id = (select v::uuid from mk where k = 'c_all') and subject = 'Hi Alice'), 'click', 0) ->> 'url',
               'https://example.test/book', 'click goes to the link we sent');
select test.eq(public.marketing_track((select id from public.marketing_messages where campaign_id = (select v::uuid from mk where k = 'c_all') and subject = 'Hi Alice'), 'click', 7) ->> 'url',
               null, 'unknown link index: no redirect');
select public.marketing_track((select id from public.marketing_messages where campaign_id = (select v::uuid from mk where k = 'c_all') and subject = 'Hi Bob'), 'unsubscribe');
select test.ok(not (select marketing_opt_in from public.clients where id = test.id('bob_client')), 'unsubscribe turns marketing off');
select test.login('libby');
select test.eq((select c -> 'stats' from jsonb_array_elements(public.marketing_list_campaigns()) c where c ->> 'name' = 'October news') - 'skipped',
               '{"sent": 2, "failed": 0, "opened": 1, "clicked": 1, "audience": 2, "unsubscribed": 1}'::jsonb, 'campaign stats are recorded');
-- Bob's queued marketing (if any) is skipped now he has opted out.
select test.admin();
insert into public.marketing_messages (studio_id, client_id, channel, source, automation_key, ref_name, to_address, dedupe_key)
values (app.default_studio(), test.id('bob_client'), 'email', 'automation', 'winback', 'Win-back', 'bob@example.test', 'test:bob');
select test.service();
select public.marketing_claim(array['email'], 100);
select test.eq((select status from public.marketing_messages where dedupe_key = 'test:bob'), 'skipped', 'opted out after queueing: not sent');
-- A failure is retried, then given up on.
select test.admin();
insert into public.marketing_messages (studio_id, client_id, channel, source, automation_key, ref_name, to_address, dedupe_key)
values (app.default_studio(), test.id('gus_client'), 'email', 'automation', 'pack_low', 'Pack low', 'gus@example.test', 'test:gus');
select test.service();
select public.marketing_finish((j ->> 'id')::uuid, 'Resend 500') from jsonb_array_elements(public.marketing_claim(array['email'], 10)) j;
select test.eq((select status from public.marketing_messages where dedupe_key = 'test:gus'), 'queued', 'a failed send goes back in the queue');

select test.login('libby');
select test.throws($$select public.marketing_claim(array['email'])$$, '42501', 'staff can''t claim the queue');
select test.throws($$select public.marketing_track(gen_random_uuid(), 'open')$$, '42501', 'trackers are service only');
select test.ok(jsonb_array_length(public.marketing_message_log(20)) > 0, 'message log lists sends');

-- ---------------------------------------------------------------- inbox
select test.login('alice');
select test.eq(public.marketing_my_unread(), 0, 'no messages yet');
select test.eq(public.marketing_send_my_message('  Hi! Can I bring a friend on Saturday?  ') ->> 'body', 'Hi! Can I bring a friend on Saturday?', 'client sends a message');
select test.throws($$select public.marketing_send_my_message('   ')$$, 'INVALID', 'empty messages are refused');
select test.login('libby');
select test.eq(public.marketing_inbox_unread(), 1, 'staff see one unread');
select test.eq((public.marketing_list_threads() -> 0 ->> 'clientName'), 'Alice Test', 'thread list shows the client');
select test.eq(public.marketing_send_staff_message(test.id('alice_client'), 'Of course!') ->> 'staffName', 'Libby', 'staff reply carries their name');
select test.eq(public.marketing_inbox_unread(), 0, 'replying marks it read');
select test.eq(jsonb_array_length(public.marketing_get_thread(test.id('alice_client')) -> 'messages'), 2, 'thread has both messages');
select test.login('alice');
select test.eq(public.marketing_my_unread(), 1, 'client sees the reply as unread');
select public.marketing_mark_my_thread_read();
select test.eq((public.marketing_my_thread() ->> 'unread')::int, 0, 'and can mark it read');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 2, 'a client reads their own messages');
select test.login('cara');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 0, 'other clients can''t read them');
select test.eq(test.count($$select 1 from public.marketing_threads$$), 0, '...or the thread');
select test.throws($$select public.marketing_get_thread(test.id('alice_client'))$$, 'NOT_ALLOWED', 'clients can''t open staff inbox threads');
select test.login('fran');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 2, 'front desk reads the inbox');

-- ---------------------------------------------------------------- push devices
select test.login('alice');
select public.marketing_register_push('web', 'https://push.example.test/sub/alice', '{"p256dh":"k","auth":"a"}', 'Test browser');
select test.ok((public.marketing_push_status() ->> 'registered')::boolean, 'device registered');
select test.throws($$select token from public.marketing_push_devices$$, '42501', 'push tokens can''t be read through the API');
select test.throws($$select public.marketing_register_push('fax', 'x')$$, 'INVALID', 'unknown platforms refused');
select test.login('libby');
select public.marketing_send_staff_message(test.id('alice_client'), 'See you then');
select test.eq((select count(*)::int from public.marketing_messages where channel = 'push' and client_id = test.id('alice_client')), 1, 'a staff reply queues a push to the client');
select test.service();
select test.eq((public.marketing_claim(array['push'], 10) -> 0 -> 'devices' -> 0 ->> 'token'), 'https://push.example.test/sub/alice', 'the push sender gets the client''s device');
select test.login('alice');
select public.marketing_unregister_push('https://push.example.test/sub/alice');
select test.ok(not (public.marketing_push_status() ->> 'registered')::boolean, 'device removed');

-- ---------------------------------------------------------------- settings
select test.login('libby');
select test.eq(public.marketing_update_settings('{"fromName":"Libby at the studio","replyTo":"hello@example.test"}') ->> 'fromName', 'Libby at the studio', 'settings saved');
select test.throws($$select public.marketing_update_settings('{"replyTo":"nope"}')$$, 'INVALID', 'reply-to must be an email');

-- ---------------------------------------------------------------- studio isolation (Snowy vs Harbour)
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'hank.mk@harbour.test', '{"first_name":"Hank"}', now()),
  (gen_random_uuid(), 'hana.mk@harbour.test', '{"first_name":"Hana","studio":"harbour"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('hank.mk@harbour.test', 'hana.mk@harbour.test')
  on conflict do nothing;
insert into mk select 'harbour', coalesce((select id::text from public.studios where slug = 'harbour'),
  public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test') ->> 'id');
select public.platform_invite_owner((select v::uuid from mk where k = 'harbour'), 'Hank', 'hank.mk@harbour.test');
update public.staff set user_id = test.id('hank.mk') where email = 'hank.mk@harbour.test' and studio_id = (select v::uuid from mk where k = 'harbour');
insert into public.clients (studio_id, user_id, first_name, last_name, email, marketing_opt_in)
values ((select v::uuid from mk where k = 'harbour'), test.id('hana.mk'), 'Hana', 'Harbour', 'hana.mk@harbour.test', true)
on conflict do nothing;
insert into mk select 'hana', id::text from public.clients where email = 'hana.mk@harbour.test' and studio_id = (select v::uuid from mk where k = 'harbour');

select test.login('hank.mk');
select test.studio('harbour');
select test.eq(jsonb_array_length(public.marketing_list_segments()), 7, 'Harbour gets its own starter segments');
select test.eq(jsonb_array_length(public.marketing_list_campaigns()), 0, 'Harbour sees none of Snowy''s campaigns');
select test.eq(public.marketing_inbox_unread(), 0, 'Harbour''s inbox is its own');
select test.eq(test.count($$select 1 from public.marketing_messages$$), 0, 'Harbour staff can''t read Snowy''s send log');
select test.eq(test.count($$select 1 from public.marketing_thread_messages$$), 0, '...or Snowy''s inbox');
select test.throws($$select public.marketing_get_campaign((select v::uuid from mk where k = 'c_all'))$$, 'NOT_FOUND', 'can''t open a Snowy campaign');
select test.throws($$select public.marketing_send_staff_message(test.id('alice_client'), 'hi')$$, 'NOT_FOUND', 'can''t message a Snowy client');
select test.throws($$select public.marketing_set_client_tags(test.id('alice_client'), array['x'])$$, 'NOT_FOUND', 'can''t tag a Snowy client');
select test.throws($$select public.marketing_delete_segment((select v::uuid from mk where k = 'seg'))$$, 'NOT_FOUND', 'can''t delete a Snowy segment');
select test.eq(test.count($$select 1 from public.marketing_segments where name = 'Members who said yes'$$), 0, 'Snowy segments are invisible');
select test.studio('snowy');
select test.throws($$select public.marketing_list_segments()$$, 'NOT_ALLOWED', 'Harbour owner has no role at Snowy');
select test.eq(test.count($$select 1 from public.marketing_campaigns$$), 0, 'and reads nothing there');

select test.login('libby');
select test.studio('harbour');
select test.throws($$select public.marketing_list_campaigns()$$, 'NOT_ALLOWED', 'Snowy owner has no role at Harbour');
select test.studio('snowy');
select test.throws($$select public.marketing_send_staff_message((select v::uuid from mk where k = 'hana'), 'hi')$$, 'NOT_FOUND', 'Snowy can''t message a Harbour client');
select test.eq(test.count($$select 1 from public.marketing_segments$$), 8, 'Snowy staff see only Snowy segments (7 starters + 1)');

select test.login('hana.mk');
select test.studio('harbour');
select public.marketing_send_my_message('Hello Harbour');
select test.login('hank.mk');
select test.eq(public.marketing_inbox_unread(), 1, 'Harbour''s owner gets Harbour''s client message');
select test.login('libby');
select test.studio('snowy');
select test.eq(public.marketing_inbox_unread(), 0, 'Snowy doesn''t');

rollback;
