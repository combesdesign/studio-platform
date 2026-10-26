-- Integrations (B5): the Xero export settings (account codes). Roles, validation, and Snowy vs Harbour isolation.
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

-- ---------------------------------------------------------------- Harbour: studio and owner
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
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';

-- ---------------------------------------------------------------- Xero settings
select test.studio('snowy');
select test.login('fran');
select test.throws($$select public.integrations_save_accounting('{"salesAccount":"210"}')$$, 'NOT_ALLOWED', 'front desk can''t change account codes');
select test.login('mia');
select test.eq(public.integrations_save_accounting('{"salesAccount":"  210 ","bogus":"x","gstAccount":"821"}'), '{"salesAccount":"210","gstAccount":"821"}'::jsonb, 'the manager saves codes; unknown keys are dropped');
select test.eq(public.integrations_save_accounting('{"cashAccount":"091"}'), '{"salesAccount":"210","gstAccount":"821","cashAccount":"091"}'::jsonb, 'a second save merges');
select test.throws($$select public.integrations_save_accounting('{"salesAccount":"1234567890123456789012345678901234567890123456789012345678901234567890"}')$$, 'INVALID', 'codes are short');
select test.throws($$select public.integrations_save_accounting('{"salesAccount":5}')$$, 'INVALID', 'codes are text');
select test.eq(test.count($$select 1 from public.integrations_accounting$$), 1, 'owner and manager can read them');
select test.login('julia');
select test.eq(test.count($$select 1 from public.integrations_accounting$$), 0, 'an instructor can''t');

-- ---------------------------------------------------------------- Snowy vs Harbour
select test.studio('harbour');
select test.login('hank');
select test.eq(test.count($$select 1 from public.integrations_accounting$$), 0, 'Hank sees none of Snowy''s Xero codes');
select test.eq(public.integrations_save_accounting('{"salesAccount":"4-1000"}') ->> 'salesAccount', '4-1000', 'Harbour saves its own account codes');
select test.eq(test.count($$select 1 from public.integrations_accounting$$), 1, '...and sees only its own row');
select test.studio('snowy');
select test.throws($$select public.integrations_save_accounting('{"salesAccount":"999"}')$$, 'NOT_ALLOWED', 'Harbour''s owner can''t change Snowy''s codes');
select test.login('mia');
select test.eq(public.integrations_save_accounting('{}') ->> 'salesAccount', '210', 'Snowy''s codes are untouched by Harbour''s save');
select test.eq((select settings ->> 'salesAccount' from public.integrations_accounting), '210', '...and Snowy sees only its own row');
select test.admin();
select test.throws(format('insert into public.integrations_accounting (studio_id, settings) values (%L, ''[]'')', test.id('harbour')), '23514', 'settings are an object');

select test.studio(null);
rollback;
