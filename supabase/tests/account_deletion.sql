-- Account deletion (3000_account_deletion.sql): only the person themselves or the studio's owner may start it, the destructive step
-- is service-role only, personal details go but booking/pass/sale rows stay anonymised, it is idempotent and audit-logged,
-- and a login that belongs to another studio survives.
-- Snowy: Bob (weekly membership, with a dependant and a booking), Cara, Libby owner, Mia manager, Fran front desk, Julia instructor.
-- Harbour: Hank owner, Hana client (Hana is also a Snowy client, so her login must survive a Harbour deletion).
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
insert into test.ids select 'snowy_studio', studio_id from public.clients where id = test.id('bob_client');
-- Hana is a Snowy client too (same login, second studio).
insert into public.clients (studio_id, user_id, first_name, last_name, email) values (test.id('snowy_studio'), test.id('hana'), 'Hana', 'Both', 'hana@harbour.test');
insert into test.ids select 'hana_snowy', id from public.clients where user_id = test.id('hana') and studio_id = test.id('snowy_studio');
\o

-- Bob's world: a dependant, a Stripe-backed membership, a booking next week, notes, a photo, a health form, a queued email.
select test.studio('snowy');
select test.login('bob');
select (public.save_dependant(test.id('bob_client'), null, 'Bobby', null, '2019-05-05', 'Asthma') ->> 'id') as bobby \gset
select public.book_class(test.id('s_thu'));
select test.admin();
insert into test.ids values ('bobby', :'bobby');
update public.passes set stripe_subscription_id = 'sub_bob_1' where client_id = test.id('bob_client');
update public.clients set phone = '0400 000 000', birthday = '1990-01-02', injuries = 'Bad knee', emergency_contact_name = 'Ben', emergency_contact_phone = '0411',
       health_form = '{"injuries":"Bad knee"}', photo_url = 'https://x.test/storage/v1/object/public/avatars/' || id || '/1.jpg', marketing_opt_in = true
 where id = test.id('bob_client');
insert into public.client_notes (client_id, notes) values (test.id('bob_client'), 'Pays late');
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict do nothing;
insert into storage.objects (bucket_id, name) values ('avatars', test.id('bob_client')::text || '/1.jpg');
select count(*) as bob_bookings from public.bookings where client_id = test.id('bob_client') \gset
select count(*) as bob_sales from public.sales where client_id = test.id('bob_client') \gset
select test.ok(:bob_bookings >= 1 and :bob_sales >= 1, 'setup: Bob has bookings and sales');

-- ---------------------------------------------------------------- who may ask
select test.login('cara');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_ALLOWED', 'another client cannot delete Bob''s account');
select test.throws($$select public.account_deletion_plan(test.id('bobby'))$$, 'NOT_ALLOWED', 'another client cannot delete his dependant either');
select test.login('mia');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_ALLOWED', 'a manager cannot delete a client');
select test.login('fran');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_ALLOWED', 'front desk cannot delete a client');
select test.login('julia');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_ALLOWED', 'an instructor cannot delete a client');
select test.login('bob');
select test.throws($$select public.account_deletion_plan(test.id('bobby'))$$, 'NOT_ALLOWED', 'a parent goes through the family screen, not account deletion, for a dependant');
select test.throws($$select public.account_deletion_plan(test.id('cara_client'))$$, 'NOT_ALLOWED', 'Bob cannot delete Cara''s account');
select test.throws($$select public.account_deletion_plan(test.id('hana_client'))$$, 'NOT_FOUND', 'nor someone in another studio');
select test.anon();
select test.throws($$select public.account_deletion_plan()$$, '42501', 'signed out: nothing');
select test.login('hank');
select test.studio('harbour');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_FOUND', 'another studio''s owner (Harbour) cannot delete a Snowy client');
select test.studio('snowy');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_ALLOWED', '...even when asking as Snowy');
select test.login('bob');
select test.throws($$select public.account_delete_apply(test.id('cara_client'))$$, '42501', 'the destructive step is not callable from the app (client)');
select test.login('libby');
select test.throws($$select public.account_delete_apply(test.id('bob_client'))$$, '42501', 'nor by the owner directly');
select test.anon();
select test.throws($$select public.account_delete_apply(test.id('bob_client'))$$, '42501', 'nor signed out');
select test.admin();
select test.eq((select first_name from public.clients where id = test.id('cara_client')), 'Cara', 'Cara untouched by all of the above');

-- ---------------------------------------------------------------- the plan
select test.login('bob');
select public.account_deletion_plan() as plan \gset
select test.admin();
select test.eq((:'plan'::jsonb ->> 'by'), 'self', 'the plan says Bob is deleting himself');
select test.eq((:'plan'::jsonb -> 'subscriptions' ->> 0), 'sub_bob_1', 'the plan lists his Stripe subscription');
select test.eq(jsonb_array_length(:'plan'::jsonb -> 'client_ids'), 2, 'the plan covers Bob and Bobby');
select test.eq((:'plan'::jsonb -> 'avatar_paths' ->> 0), test.id('bob_client')::text || '/1.jpg', 'the plan lists his avatar file');

-- ---------------------------------------------------------------- the owner can do it too (plan only: nothing changes until apply)
select test.login('libby');
select test.eq((public.account_deletion_plan(test.id('bob_client')) ->> 'by'), 'owner', 'the studio owner may delete a client on request');
select test.admin();
select test.eq((select first_name from public.clients where id = test.id('bob_client')), 'Bob', 'planning changes nothing');

-- ---------------------------------------------------------------- apply (Edge function = service role)
select test.service();
select test.eq((public.account_delete_apply(test.id('bob_client'), test.id('bob'), 'self') ->> 'delete_auth_user')::boolean, true, 'Bob has no other studio: his login goes');
select test.admin();
select test.eq((select first_name || '|' || last_name || '|' || email from public.clients where id = test.id('bob_client')), 'Deleted|client|', 'name and email cleared');
select test.ok((select phone is null and birthday is null and injuries is null and emergency_contact_name is null and emergency_contact_phone is null
                       and health_form is null and photo_url is null and not marketing_opt_in and archived and deleted_at is not null
                  from public.clients where id = test.id('bob_client')), 'phone, birthday, health, contacts, photo cleared; archived');
select test.eq((select first_name from public.clients where id = test.id('bobby')), 'Deleted', 'the dependant is anonymised too');
select test.ok((select injuries is null and birthday is null from public.clients where id = test.id('bobby')), '...with their health info gone');
select test.eq((select count(*) from public.client_notes where client_id = test.id('bob_client')), 0::bigint, 'staff notes deleted');
select test.eq((select count(*) from public.bookings where client_id = test.id('bob_client')), :bob_bookings::bigint, 'booking rows stay (for the records)');
select test.eq((select count(*) from public.sales where client_id = test.id('bob_client')), :bob_sales::bigint, 'sales stay (for tax)');
select test.eq((select count(*) from public.bookings b join public.class_sessions s on s.id = b.session_id
                 where b.client_id = test.id('bob_client') and b.status in ('booked', 'waitlisted') and s.starts_at >= app.now()), 0::bigint, 'upcoming classes cancelled');
select test.eq((select count(*) from public.passes where client_id = test.id('bob_client') and status <> 'cancelled'), 0::bigint, 'memberships cancelled');
select test.eq((select count(*) from public.audit_log where action = 'account.delete' and entity_id = test.id('bob_client')::text), 1::bigint, 'one audit row');
select test.ok(not exists (select 1 from public.audit_log where action = 'account.delete' and details::text ~* 'bob'), '...with no personal details in it');
select test.eq((select details ->> 'by' from public.audit_log where action = 'account.delete' and entity_id = test.id('bob_client')::text), 'self', '...saying who asked');

-- idempotent: again changes and logs nothing, and still says the login needs deleting
select test.service();
select test.eq((public.account_delete_apply(test.id('bob_client'), test.id('bob'), 'self') ->> 'already_deleted')::boolean, true, 'second run: already done');
select test.admin();
select test.eq((select count(*) from public.audit_log where action = 'account.delete' and entity_id = test.id('bob_client')::text), 1::bigint, '...and logs nothing more');
-- Bob can still reach the plan to finish a half-done job (login not yet deleted), nobody else can
select test.login('bob');
select test.eq((public.account_deletion_plan() ->> 'already_deleted')::boolean, true, 'the plan can be repeated');
select test.login('cara');
select test.throws($$select public.account_deletion_plan(test.id('bob_client'))$$, 'NOT_ALLOWED', 'still not Cara');

-- ---------------------------------------------------------------- a login used by another studio survives
select test.studio('harbour');
select test.login('hana');
select test.eq((public.account_deletion_plan() ->> 'by'), 'self', 'Hana deletes her Harbour account');
select test.service();
select test.eq((public.account_delete_apply(test.id('hana_client'), test.id('hana'), 'self') ->> 'delete_auth_user')::boolean, false, 'her login stays: she is a Snowy client too');
select test.admin();
select test.ok((select user_id is null and deleted_at is not null from public.clients where id = test.id('hana_client')), 'Harbour''s link is removed');
select test.eq((select user_id from public.clients where id = test.id('hana_snowy')), test.id('hana'), 'Snowy''s link and details are untouched');
select test.eq((select first_name from public.clients where id = test.id('hana_snowy')), 'Hana', '...');
select test.eq((select count(*) from auth.users where id = test.id('hana')), 1::bigint, 'the login still exists');

rollback;
