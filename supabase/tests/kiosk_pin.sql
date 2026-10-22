-- Kiosk (B5): the exit PIN. Owner/manager set it, owner/manager/front desk check it, nobody else can, it is stored
-- hashed and can't be read, and another studio never sees or uses it.
-- Snowy: Libby owner, Mia manager, Fran front desk, Julia instructor, Alice client. Harbour: Hank owner.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on function test.studio(text) to anon, authenticated, service_role;

-- studio B (Harbour) with an owner
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

-- ---------------------------------------------------------------- Snowy
select test.studio('snowy');
select test.login('fran');
select test.eq(public.kiosk_has_pin(), false, 'no PIN to start with (exit uses the staff password)');
select test.eq(public.kiosk_check_pin('1234'), false, 'with no PIN set, nothing matches');
select test.throws($$select public.kiosk_set_pin('1234')$$, 'NOT_ALLOWED', 'front desk can''t set the PIN');
select test.login('julia');
select test.throws($$select public.kiosk_has_pin()$$, 'NOT_ALLOWED', 'an instructor can''t use the kiosk');
select test.throws($$select public.kiosk_check_pin('1234')$$, 'NOT_ALLOWED', 'an instructor can''t check the PIN');
select test.login('alice');
select test.throws($$select public.kiosk_check_pin('1234')$$, 'NOT_ALLOWED', 'a client can''t check the PIN');
select test.throws($$select public.kiosk_set_pin('1234')$$, 'NOT_ALLOWED', 'a client can''t set the PIN');

select test.login('mia');
select test.throws($$select public.kiosk_set_pin('12')$$, 'INVALID', 'a PIN is exactly 4 numbers');
select test.throws($$select public.kiosk_set_pin('12a4')$$, 'INVALID', 'a PIN is numbers only');
select public.kiosk_set_pin('4821');
select test.login('fran');
select test.eq(public.kiosk_has_pin(), true, 'front desk can see a PIN is set');
select test.eq(public.kiosk_check_pin('4821'), true, 'the right PIN works');
select test.eq(public.kiosk_check_pin('4822'), false, 'a wrong PIN doesn''t');
select test.throws($$select * from public.kiosk_settings$$, '42501', 'the hash can''t be read (no grant)');
select test.admin();
select test.ok((select pin_hash like '$2%' and pin_hash <> '4821' from public.kiosk_settings where studio_id = (select id from public.studios where slug = 'snowy')), 'the PIN is stored hashed');
select test.login('libby');
select public.kiosk_set_pin('9999');
select test.eq(public.kiosk_check_pin('4821'), false, 'changing the PIN replaces the old one');
select test.eq(public.kiosk_check_pin('9999'), true, 'the new PIN works');

-- ---------------------------------------------------------------- Harbour can't see or use Snowy's PIN
select test.studio('harbour');
select test.login('hank');
select test.eq(public.kiosk_has_pin(), false, 'Harbour has no PIN of its own');
select test.eq(public.kiosk_check_pin('9999'), false, 'Snowy''s PIN doesn''t open Harbour''s kiosk');
select public.kiosk_set_pin('1111');
select test.eq(public.kiosk_check_pin('1111'), true, 'Harbour''s own PIN works');
select test.studio('snowy');
select test.login('hank');
select test.throws($$select public.kiosk_check_pin('1111')$$, 'NOT_ALLOWED', 'Harbour''s owner isn''t Snowy staff');
select test.studio('harbour');
select test.login('fran');
select test.throws($$select public.kiosk_check_pin('9999')$$, 'NOT_ALLOWED', 'Snowy''s front desk isn''t Harbour staff');

select test.admin();
select test.studio(null);
rollback;
