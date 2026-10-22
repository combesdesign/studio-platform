-- Custom domains: only platform admins change them, they are cleaned and checked, one domain belongs to one studio,
-- and a domain opens its own studio and nobody else's (Snowy vs Harbour).
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
insert into test.ids select 'snowy', id from public.studios where slug = 'snowy';
select test.login('pete');
select public.platform_invite_owner(test.id('harbour'), 'Hank', 'hank@harbour.test');
select public.platform_set_studio_status(test.id('harbour'), 'live');

-- ---------------------------------------------------------------- saving and cleaning
select test.eq(public.platform_update_studio(test.id('snowy'), '{"custom_domains":["  App.SnowyPilatesClub.com ", "book.snowy.example", "app.snowypilatesclub.com"]}') -> 'custom_domains', '["app.snowypilatesclub.com", "book.snowy.example"]'::jsonb,
               'domains are trimmed, lower-cased and de-duplicated');
select test.eq(public.platform_update_studio(test.id('snowy'), '{"custom_domains":["app.snowypilatesclub.com"]}') -> 'custom_domains', '["app.snowypilatesclub.com"]'::jsonb, 'removing one keeps the rest');
select test.throws($$select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["https://app.snowypilatesclub.com"]}')$$, 'INVALID', 'a web address with https:// is refused');
select test.throws($$select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["app.snowypilatesclub.com/studio"]}')$$, 'INVALID', 'a path is refused');
select test.throws($$select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["localhost"]}')$$, 'INVALID', 'a name with no dot is refused');
select test.throws($$select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["-bad.example.com"]}')$$, 'INVALID', 'labels can''t start with a hyphen');
select test.throws($$select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["a b.example.com"]}')$$, 'INVALID', 'no spaces');
select test.throws($$select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["a.example.com","b.example.com","c.example.com","d.example.com","e.example.com","f.example.com","g.example.com","h.example.com","i.example.com","j.example.com","k.example.com"]}')$$, 'INVALID', 'at most 10');
select test.eq(public.platform_update_studio(test.id('snowy'), '{"name":"Snowy Pilates Club"}') -> 'custom_domains', '["app.snowypilatesclub.com"]'::jsonb, 'saving something else leaves the domains alone');
select test.eq(jsonb_array_length(public.platform_update_studio(test.id('snowy'), '{"custom_domains":[]}') -> 'custom_domains'), 0, 'all domains can be removed');
select public.platform_update_studio(test.id('snowy'), '{"custom_domains":["app.snowypilatesclub.com"]}');

-- ---------------------------------------------------------------- one domain, one studio
select test.throws(format('select public.platform_update_studio(%L, %L)', test.id('harbour'), '{"custom_domains":["APP.snowypilatesclub.com"]}'), 'DOMAIN_TAKEN', 'Harbour can''t take Snowy''s domain (even in capitals)');
select test.eq(public.platform_update_studio(test.id('harbour'), '{"custom_domains":["studio.harbourreformer.example"]}') -> 'custom_domains', '["studio.harbourreformer.example"]'::jsonb, 'Harbour saves its own');
select test.throws(format('select public.platform_update_studio(%L, %L)', test.id('snowy'), '{"custom_domains":["app.snowypilatesclub.com","studio.harbourreformer.example"]}'), 'DOMAIN_TAKEN', 'and Snowy can''t take Harbour''s');
select test.eq(public.platform_update_studio(test.id('harbour'), '{"custom_domains":["studio.harbourreformer.example"]}') -> 'custom_domains', '["studio.harbourreformer.example"]'::jsonb, 'saving a studio''s own domain again is fine');

-- ---------------------------------------------------------------- who can change them
select test.login('hank');
select test.throws(format('select public.platform_update_studio(%L, %L)', test.id('harbour'), '{"custom_domains":["x.harbour.example"]}'), 'NOT_ALLOWED', 'a studio owner can''t set their own domains (platform admins do)');
select test.studio('harbour');
select test.throws($$select public.update_my_studio('{"custom_domains":["x.harbour.example"]}')$$, 'INVALID', 'nor through the owner''s own studio settings');
select test.studio(null);
select test.admin();
select test.throws(format('update public.studios set custom_domains = array[''app.snowypilatesclub.com''] where id = %L', test.id('harbour')), 'DOMAIN_TAKEN', 'writing the column directly is checked too');
select test.eq((select custom_domains from public.studios where id = test.id('harbour')), array['studio.harbourreformer.example'], 'nothing changed');

-- ---------------------------------------------------------------- a domain opens its own studio and nobody else's
select test.anon();
select test.eq((select slug from public.studios where custom_domains @> array['app.snowypilatesclub.com']), 'snowy', 'Snowy''s domain finds Snowy');
select test.eq((select slug from public.studios where custom_domains @> array['studio.harbourreformer.example']), 'harbour', 'Harbour''s finds Harbour');
select test.eq(test.count($$select 1 from public.studios where custom_domains @> array['nobody.example.com']$$), 0, 'an unknown domain finds nothing');
select test.admin();
rollback;
