-- 0011: the Stripe Connect fields (studio_stripe). Only the studio's owner can see them, and nobody can set them from an app:
-- the edge functions (service role) write them. Studio B can't see studio A's, whoever asks.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create function test.cs_studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create function test.cs_count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
grant execute on all functions in schema test to anon, authenticated, service_role;

insert into public.studios (id, slug, name, status) values ('00000000-0000-4000-8000-0000000000b2', 'connectb', 'Connect B', 'live');
select test.service();
select public.stripe_connect_save(app.default_studio(), 'acct_SNOWY1', true, true, true);
select public.stripe_connect_save('00000000-0000-4000-8000-0000000000b2', 'acct_BEE1');
select test.admin();

select test.cs_studio('snowy');
select test.login('libby');
select test.eq((public.whoami() ->> 'role'), 'owner', 'Libby is the owner');
select test.eq(test.cs_count($$select 1 from public.studio_stripe$$), 1, 'the owner reads her own studio''s Stripe row (and only hers)');
select test.eq((select stripe_account_id from public.studio_stripe), 'acct_SNOWY1', 'the owner sees the account id');
select test.eq((public.my_stripe_status() ->> 'accountId'), 'acct_SNOWY1', 'my_stripe_status: the owner sees the account');
select test.ok((public.my_stripe_status() ->> 'chargesEnabled')::boolean, 'my_stripe_status: flags');

-- Not the owner: nothing.
select test.login('mia');
select test.eq((select role from public.staff where user_id = test.id('mia')), 'manager', 'Mia is a manager');
select test.eq(test.cs_count($$select 1 from public.studio_stripe$$), 0, 'a manager sees no Stripe rows');
select test.throws($$select public.my_stripe_status()$$, 'NOT_ALLOWED', 'a manager can''t call my_stripe_status');
select test.login('fran');
select test.eq(test.cs_count($$select 1 from public.studio_stripe$$), 0, 'front desk / instructors see no Stripe rows');
select test.throws($$select public.my_stripe_status()$$, 'NOT_ALLOWED', 'non-owner staff can''t call my_stripe_status');
select test.login('cara');
select test.eq(test.cs_count($$select 1 from public.studio_stripe$$), 0, 'a client sees no Stripe rows');
select test.throws($$select public.my_stripe_status()$$, 'NOT_ALLOWED', 'a client can''t call my_stripe_status');
select test.anon();
select test.throws($$select count(*) from public.studio_stripe$$, '42501', 'the public can''t read the table at all');

-- Nobody sets it from an app, the owner included.
select test.login('libby');
select test.throws($$update public.studio_stripe set stripe_account_id = 'acct_EVIL1'$$, '42501', 'the owner can''t edit the account id');
select test.throws($$insert into public.studio_stripe (studio_id, stripe_account_id) values ('00000000-0000-4000-8000-0000000000b2', 'acct_EVIL2')$$, '42501', 'the owner can''t insert');
select test.throws($$select public.stripe_connect_save(app.default_studio(), 'acct_EVIL3', true, true, true)$$, '42501', 'the owner can''t call stripe_connect_save');
select test.throws($$delete from public.studio_stripe$$, '42501', 'the owner can''t delete');

-- The studio directory (readable by everyone) doesn't carry it.
select test.anon();
select test.ok(not exists (select 1 from jsonb_object_keys(to_jsonb((select s from public.studios s limit 1))) k where k ilike '%stripe%'), 'public.studios has no Stripe columns');

-- Studio B's owner sees only B's row.
select test.admin();
insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), 'bee@connectb.test', now());
insert into public.staff (studio_id, user_id, name, email, role) select '00000000-0000-4000-8000-0000000000b2', id, 'Bee', 'bee@connectb.test', 'owner' from auth.users where email = 'bee@connectb.test';
insert into test.ids select 'bee', id from auth.users where email = 'bee@connectb.test';
select test.cs_studio('connectb');
select test.login('bee');
select test.eq((select stripe_account_id from public.studio_stripe), 'acct_BEE1', 'studio B''s owner sees B''s account');
select test.eq(test.cs_count($$select 1 from public.studio_stripe$$), 1, 'and only B''s');
select test.eq((public.my_stripe_status() ->> 'chargesEnabled')::boolean, false, 'a new connection starts with charges off');
select test.cs_studio('snowy');
select test.eq(test.cs_count($$select 1 from public.studio_stripe$$), 0, 'asking for studio A as B''s owner shows nothing');

-- The service role can update flags and the account id is kept.
select test.service();
select public.stripe_connect_save('00000000-0000-4000-8000-0000000000b2', null, true, false, true);
select test.eq((select stripe_account_id from public.studio_stripe where studio_id = '00000000-0000-4000-8000-0000000000b2'), 'acct_BEE1', 'null keeps the stored account id');
select test.eq((select charges_enabled and details_submitted and not payouts_enabled from public.studio_stripe where studio_id = '00000000-0000-4000-8000-0000000000b2'), true, 'flags update');
select test.throws($$select public.stripe_connect_save('00000000-0000-4000-8000-0000000000b2', 'acct_SNOWY1')$$, '23505', 'one Stripe account can''t be linked to two studios');

select test.admin();
rollback;
