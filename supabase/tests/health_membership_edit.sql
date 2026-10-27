-- 2400: the quick health check, the health policy settings, and owner/manager membership edits.
-- Snowy: Libby owner, Mia manager, Fran front desk, Julia instructor, Alice (4 pack), Bob (2 a week membership). Harbour: Hank owner.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on function test.studio(text) to anon, authenticated, service_role;

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

-- ---------------------------------------------------------------- policy settings
select test.studio('snowy');
select test.eq((select long_health_form_first_timers and quick_health_check and quick_health_check_days = 30 from public.studio_settings ss join public.studios st on st.id = ss.studio_id where st.slug = 'snowy'), true, 'defaults: long form on, quick check on, every 30 days');
select test.login('libby');
update public.studio_settings set quick_health_check_days = 14, quick_health_check = false;
select test.eq((select quick_health_check_days from public.studio_settings), 14, 'the owner changes the policy');
select test.throws($$update public.studio_settings set quick_health_check_days = 0$$, '23514', 'days must be 1 to 365');
select test.login('alice');
update public.studio_settings set quick_health_check = true;   -- RLS: no row is visible for update
select test.eq((select quick_health_check from public.studio_settings), false, 'client update changed nothing');
select test.admin();
select test.eq((select quick_health_check_days from public.studio_settings ss join public.studios st on st.id = ss.studio_id where st.slug = 'harbour'), 30, 'another studio keeps its own settings');
select test.studio('snowy');

-- ---------------------------------------------------------------- quick health check
select test.login('alice');
select test.eq(public.submit_health_check(test.id('alice_client'), false) ->> 'injuries', null, 'No = nothing written to injuries');
select test.ok((select health_checked_at is not null and health_update is null from public.clients where id = test.id('alice_client')), 'No stamps the date only');
select test.throws($$select public.submit_health_check(test.id('alice_client'), true, '   ')$$, 'INVALID', 'Yes needs a note');
select public.submit_health_check(test.id('alice_client'), true, 'sore left knee');
select test.eq((select injuries from public.clients where id = test.id('alice_client')), '19 Oct 2026: sore left knee', 'Yes adds a dated line to injuries');
select public.submit_health_check(test.id('alice_client'), true, 'tight hip');
select test.eq((select injuries from public.clients where id = test.id('alice_client')), E'19 Oct 2026: sore left knee\n19 Oct 2026: tight hip', 'notes pile up');
select test.eq((select health_update ->> 'note' from public.clients where id = test.id('alice_client')), 'tight hip', 'the latest update is kept for the roster');
select test.throws($$select public.submit_health_check(test.id('bob_client'), false)$$, 'NOT_FOUND', 'not for someone else');
update public.clients set health_update = null, health_checked_at = null where id = test.id('alice_client');
select test.ok((select health_update is not null and health_checked_at is not null from public.clients where id = test.id('alice_client')), 'a client can''t write the health check columns directly');

-- the roster flags it for the instructor until alice has been checked in to a class since
select public.book_class(test.id('s_thu'));
select test.login('julia');
select test.ok(exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e
                        where e ->> 'client_id' = test.id('alice_client')::text and e -> 'flags' ? 'health_update'), 'roster flags health_update');
select test.ok(exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e
                        where e ->> 'client_id' = test.id('alice_client')::text and e -> 'flags' ? 'injury'), 'and the usual injury flag');
select test.eq((select count(*)::int from public.clients where id = test.id('alice_client') and health_update is not null), 1, 'instructors can read the update');
-- another studio's owner can't use the check on this client
select test.studio('harbour');
select test.login('hank');
select test.throws($$select public.submit_health_check(test.id('alice_client'), false)$$, 'NOT_FOUND', 'another studio can''t record a check for our client');
select test.eq((select count(*)::int from public.clients where id = test.id('alice_client')), 0, 'or read the note');
select test.studio('snowy');

-- ---------------------------------------------------------------- membership edits
select test.admin();
select p.id as bob_pass from public.passes p where p.client_id = test.id('bob_client') and p.kind = 'membership' \gset
update public.passes set next_billing_at = '2026-10-26 08:00+11', activated_at = '2026-10-19 07:00+11' where id = :'bob_pass';
select test.studio('snowy');

select test.login('fran');
select test.throws(format($f$select public.edit_membership_date(%L, '2026-11-02 00:00+11')$f$, :'bob_pass'), 'NOT_ALLOWED', 'front desk can''t move a renewal date');
select test.login('julia');
select test.throws(format($f$select public.change_membership(%L, %L)$f$, :'bob_pass', test.id('p_week1')), 'NOT_ALLOWED', 'an instructor can''t move a membership');
select test.login('bob');
select test.throws(format($f$select public.edit_membership_date(%L, '2026-11-02 00:00+11')$f$, :'bob_pass'), 'NOT_ALLOWED', 'a client can''t edit their own membership');

select test.login('mia');
select test.throws(format($f$select public.edit_membership_date(%L, '2026-10-19 12:00+11')$f$, :'bob_pass'), 'INVALID', 'a renewal date has to be after today');
select test.throws(format($f$select public.edit_membership_date(%L, '2027-03-01 00:00+11')$f$, :'bob_pass'), 'INVALID', 'and within 60 days');
select public.edit_membership_date(:'bob_pass', '2026-11-02 00:00+11');
select test.eq((select next_billing_at from public.passes where id = :'bob_pass'), '2026-11-02 00:00+11'::timestamptz, 'a manager moves the renewal date');
select test.ok(exists (select 1 from public.pass_adjustments where pass_id = :'bob_pass' and delta = 0 and reason like 'Renewal date moved from 2026-10-26 to 2026-11-02%'), 'history entry on the pass');
select test.login('libby');
select test.ok(exists (select 1 from public.audit_log where action = 'membership_renewal_date' and entity_id = :'bob_pass' and actor_staff_id = test.id('mia_staff')), 'audit log names who did it');

-- move to another membership: from the next cycle by default
select test.throws(format($f$select public.change_membership(%L, %L)$f$, :'bob_pass', test.id('p_pack4')), 'INVALID', 'only to a membership');
select test.throws(format($f$select public.change_membership(%L, %L)$f$, :'bob_pass', test.id('p_week2')), 'INVALID', 'not to the one they are on');
select public.change_membership(:'bob_pass', test.id('p_unlimited'));
select test.ok((select name = '2 classes per week' and credits = 2 and (pending_change ->> 'productId')::uuid = test.id('p_unlimited') from public.passes where id = :'bob_pass'), 'allowance unchanged until the next cycle');
select test.ok((select pending_change ->> 'name' is not null and (pending_change ->> 'effectiveAt')::timestamptz = '2026-11-02 00:00+11'::timestamptz from public.passes where id = :'bob_pass'), 'pending change takes effect on the billing date');
-- moving the date by hand keeps the pending change attached to the new date and does not apply it
select public.edit_membership_date(:'bob_pass', '2026-11-05 00:00+11');
select test.ok((select pending_change is not null and (pending_change ->> 'effectiveAt')::timestamptz = '2026-11-05 00:00+11'::timestamptz and credits = 2 from public.passes where id = :'bob_pass'), 'editing the date does not trigger the pending move');
-- a renewal (billing date has passed, webhook moves it on) applies it
select test.admin();
update public.passes set next_billing_at = '2026-10-19 06:00+11' where id = :'bob_pass';
update public.passes set next_billing_at = '2026-10-26 06:00+11' where id = :'bob_pass';
select test.ok((select pending_change is null and credits is null and name = 'Unlimited' and product_id = test.id('p_unlimited') from public.passes where id = :'bob_pass'), 'the renewal applies the new membership');
select test.ok(exists (select 1 from public.pass_adjustments where pass_id = :'bob_pass' and reason like 'Now on Unlimited%'), 'and says so in the history');
-- right away, with the proration noted
select test.login('libby');
select public.change_membership(:'bob_pass', test.id('p_week1'), true, -1750);
select test.ok((select name = '1 class per week' and credits = 1 and pending_change is null from public.passes where id = :'bob_pass'), 'immediately switches now');
select test.ok(exists (select 1 from public.pass_adjustments where pass_id = :'bob_pass' and reason like '%straight away; $17.50 credited to their account.'), 'the credit is written in the history');
select test.ok(exists (select 1 from public.audit_log where action = 'membership_change' and entity_id = :'bob_pass'), 'audit log has the move');

-- another studio's owner can't see or change it
select test.studio('harbour');
select test.login('hank');
select test.throws(format($f$select public.edit_membership_date(%L, '2026-11-09 00:00+11')$f$, :'bob_pass'), 'NOT_FOUND', 'another studio can''t move our renewal date');
select test.throws(format($f$select public.change_membership(%L, %L)$f$, :'bob_pass', test.id('p_week2')), 'NOT_FOUND', 'or our membership');
select test.studio('snowy');

-- a cancelled membership can't be edited
select test.admin();
update public.passes set status = 'cancelled' where id = :'bob_pass';
select test.login('libby');
select test.throws(format($f$select public.edit_membership_date(%L, '2026-11-09 00:00+11')$f$, :'bob_pass'), 'INVALID', 'cancelled memberships have nothing to edit');

rollback;
