-- 0007: many studios in one database. Studio A (Snowy, the default) and studio B (Harbour) can't see or change
-- each other's data, whoever asks and however they ask (tables, views, RPCs, storage). Plus the platform admin
-- functions, studio-scoped sign-up, one login across studios, and owners editing their own studio.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- Which studio a request is for: the x-studio header the apps send (studio id or slug).
create function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on function test.studio(text) to anon, authenticated, service_role;
create function test.count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
grant execute on function test.count(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- the default studio
select test.eq((select slug from public.studios where is_default), 'snowy', 'Snowy is studio #1 and the default studio');
select test.eq((select count(*)::int from public.class_types where studio_id <> app.default_studio()), 0, 'existing data was backfilled to Snowy');

-- ---------------------------------------------------------------- platform admin creates studio B
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank","studio":"harbour"}', now());
select test.eq((select count(*)::int from public.clients where email = 'hank@harbour.test'), 0, 'a sign-up naming a studio that doesn''t exist yet makes no client row anywhere');
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));

select test.login('libby');
select test.throws($$select public.platform_create_studio('Nope', 'nope', 'a@b.test')$$, 'NOT_ALLOWED', 'a studio owner is not a platform admin');
select test.login('pete');
select test.throws($$select public.platform_create_studio('Bad', 'Bad Slug!', 'a@b.test')$$, 'INVALID', 'slugs are checked');
select test.throws($$select public.platform_create_studio('Dup', 'snowy', 'a@b.test')$$, 'SLUG_TAKEN', 'slugs are unique');
select test.throws($$select public.platform_create_studio('Admin', 'admin', 'a@b.test')$$, 'INVALID', 'reserved slugs are refused');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test',
  'Australia/Sydney', 'AUD', 'en-AU', null, '12 Bay St, Double Bay', '{"appName":"Harbour Reformer Co."}'::jsonb) ->> 'id') as harbour_id \gset
select test.admin();
insert into test.ids values ('harbour', :'harbour_id');
select test.login('pete');
select test.eq((select status from public.studios where id = test.id('harbour')), 'onboarding', 'a new studio starts in onboarding');
select test.ok(exists (select 1 from public.studio_settings where studio_id = test.id('harbour')), 'a new studio gets its own settings row');
select test.eq((public.platform_invite_owner(test.id('harbour'), 'Hank', 'hank@harbour.test') ->> 'role'), 'owner', 'platform admin invites the owner');
select test.eq(test.count($$select 1 from public.staff where studio_id = test.id('harbour')$$), 0, 'platform admins don''t read studio data through RLS');
select test.admin();
select test.ok((select user_id = test.id('hank') from public.staff where studio_id = test.id('harbour') and email = 'hank@harbour.test'),
               'the owner''s existing login is linked to the new staff row');
select test.login('pete');
select test.eq((public.platform_studio_stats() -> test.id('harbour')::text ->> 'staff')::int, 1, 'platform stats count staff per studio');
select test.login('hank');
select test.throws($$select public.platform_set_studio_status(test.id('harbour'), 'live')$$, 'NOT_ALLOWED', 'owners can''t change their platform status');

-- Studio B's setup, done by its owner with the studio header (like the onboarding wizard).
select test.studio('harbour');
select test.eq((public.whoami() ->> 'role'), 'owner', 'Hank is the owner in studio B');
insert into public.class_types (name, duration_min, default_capacity) values ('Reformer Flow', 50, 2) returning id as h_flow \gset
insert into public.products (kind, name, price_cents, credits, validity_days) values ('pack', '5 pack', 19500, 5, 90) returning id as h_pack \gset
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity)
values (:'h_flow', '2026-10-21 07:00+11', '2026-10-21 07:50+11', (select id from public.staff where email = 'hank@harbour.test'), 2) returning id as h_session \gset
select test.admin();
insert into test.ids values ('h_flow', :'h_flow'), ('h_pack', :'h_pack'), ('h_session', :'h_session');
select test.login('hank');
select test.studio('harbour');
select test.ok((select studio_id = test.id('harbour') from public.class_types where id = test.id('h_flow')), 'rows land in the requested studio');
select test.eq((public.update_my_studio('{"status":"live","branding":{"appName":"Harbour Reformer Co.","colors":{"primary":"#1F4A3D"}}}') ->> 'status'),
               'live', 'the owner finishes onboarding (go live) and saves branding');
select test.throws($$select public.update_my_studio('{"status":"live"}')$$, 'INVALID', 'a live studio can''t "go live" again');
select test.throws($$select public.update_my_studio('{"slug":"stolen"}')$$, 'INVALID', 'owners can''t change their web address');
select test.eq((select name from public.studios where id = test.id('harbour')), 'Harbour Reformer Co.', 'studio record readable');

-- A client signs up from studio B's app (raw_user_meta_data.studio): their client row is in B only.
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
values (gen_random_uuid(), 'hcli@example.test', '{"first_name":"Hana","studio":"harbour"}', now());
insert into test.ids select 'hcli', id from auth.users where email = 'hcli@example.test';
insert into test.ids select 'hcli_client', id from public.clients where email = 'hcli@example.test';
select test.eq((select count(*)::int from public.clients where email = 'hcli@example.test'), 1, 'sign-up from studio B makes one client row');
select test.eq((select studio_id from public.clients where email = 'hcli@example.test'), test.id('harbour'), '...in studio B');
update public.clients set waiver_signed_at = now() where id = test.id('hcli_client');
select test.studio('harbour');
select public.checkout_cart(test.id('hcli_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('h_pack'))), 'cash');
select test.studio(null);
select test.eq((select studio_id from public.passes where client_id = test.id('hcli_client')), test.id('harbour'), 'a pass sold in B belongs to B');
select test.eq((select count(*)::int from public.sale_items i join public.sales s on s.id = i.sale_id where s.client_id = test.id('hcli_client') and i.studio_id = test.id('harbour')), 1,
               'sale items take their sale''s studio');

-- Alice (a Snowy client) also joins studio B with the same login.
select test.login('alice');
select test.studio('harbour');
select test.eq((public.join_studio() ->> 'kind'), 'client', 'one login, many studios: Alice joins studio B as a client');
select test.admin();
insert into test.ids select 'alice_harbour', id from public.clients where user_id = test.id('alice') and studio_id = test.id('harbour');
select test.login('alice');
select test.studio('snowy');
select test.eq(public.current_client_id(), test.id('alice_client'), 'in studio A she is still her Snowy client record');
select test.studio('harbour');
select test.eq(public.current_client_id(), test.id('alice_harbour'), 'in studio B she is her studio B record');
select test.eq(jsonb_array_length(public.my_studios()), 2, 'my_studios lists both studios');

-- Julia (Snowy instructor) is also hired at studio B.
select test.login('hank');
select test.studio('harbour');
insert into public.staff (name, email, role) values ('Julia', 'julia@example.test', 'instructor');
select test.login('julia');
select test.studio('harbour');
select test.eq(public.whoami() ->> 'role', 'instructor', 'staff at two studios: instructor at B');
select test.studio('snowy');
select test.eq(public.whoami() ->> 'staff_id', test.id('julia_staff')::text, '...and her own staff record at A');
select test.eq((select count(*)::int from jsonb_array_elements(public.my_studios()) m where m ->> 'kind' = 'staff'), 2, 'my_studios shows both staff memberships');

-- ---------------------------------------------------------------- isolation: studio A staff can't touch studio B
select test.login('libby');
select test.studio('snowy');
select test.eq(test.count($$select 1 from public.clients where studio_id = test.id('harbour')$$), 0, 'A owner: no B clients (header A)');
select test.eq(test.count($$select 1 from public.passes where studio_id = test.id('harbour')$$), 0, 'A owner: no B passes');
select test.eq(test.count($$select 1 from public.sales where studio_id = test.id('harbour')$$), 0, 'A owner: no B sales');
select test.eq(test.count($$select 1 from public.class_types where id = test.id('h_flow')$$), 0, 'A owner: no B class types');
select test.eq(test.count($$select 1 from public.sessions_with_counts where id = test.id('h_session')$$), 0, 'A owner: B classes not in the timetable view');
select test.throws($$select public.get_roster(test.id('h_session'))$$, 'NOT_FOUND', 'A owner: B roster -> NOT_FOUND');
select test.throws($$select public.book_class(test.id('h_session'), null, test.id('alice_client'), true)$$, 'NOT_FOUND', 'A owner: can''t book into a B class');
select test.throws($$select public.credit_summary(test.id('hcli_client'))$$, 'NOT_FOUND', 'A owner: B client credits -> NOT_FOUND');
select test.throws($$select public.list_client_bookings(test.id('hcli_client'))$$, 'NOT_FOUND', 'A owner: B client bookings -> NOT_FOUND');
select test.throws($$select public.submit_waiver(test.id('hcli_client'), '{}')$$, 'NOT_FOUND', 'A owner: can''t sign a B client''s waiver');
select test.throws($$select public.checkout_cart(test.id('hcli_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'cash')$$,
                   'NOT_FOUND', 'A owner: can''t sell to a B client');
select test.throws($$select public.checkout_cart(test.id('alice_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('h_pack'))), 'cash')$$,
                   'NOT_FOUND', 'A owner: can''t sell a B product');
select test.throws($$select public.refund_sale((select id from public.sales where studio_id = test.id('harbour') limit 1))$$, 'NOT_FOUND', 'A owner: can''t refund a B sale (can''t even see it)');
select test.throws($$select public.cancel_session(test.id('h_session'), 'x')$$, 'NOT_FOUND', 'A owner: can''t cancel a B class');
select test.eq(test.count($$select 1 from (select jsonb_array_elements(public.list_class_interest())) x$$), 0, 'A owner: interest list is A only');
update public.class_types set name = 'Hacked' where id = test.id('h_flow');
update public.studio_settings set name = 'Hacked' where studio_id = test.id('harbour');
select test.throws($$insert into public.class_types (studio_id, name, duration_min) values (test.id('harbour'), 'Sneaky', 50)$$, 'NOT_ALLOWED', 'A owner: can''t insert into B (guard trigger, before RLS)');
select test.throws($$insert into storage.objects (bucket_id, name) values ('avatars', test.id('hcli_client') || '/1.jpg')$$, '42501', 'A owner: can''t write a B client''s photo');
-- Same staff, header for B: they aren't staff there.
select test.studio('harbour');
select test.eq(public.whoami(), null::jsonb, 'A owner asking for B: not a member');
select test.eq(test.count($$select 1 from public.clients$$), 0, 'A owner asking for B: sees no clients');
select test.eq(test.count($$select 1 from public.staff$$), 0, 'A owner asking for B: sees no staff');
select test.throws($$select public.get_roster(test.id('h_session'))$$, 'NOT_ALLOWED', 'A owner asking for B: roster refused');
select test.throws($$select public.report('2026-10-01', '2026-10-31')$$, 'NOT_ALLOWED', 'A owner asking for B: no reports');
select test.throws($$select public.update_my_studio('{"name":"Mine now"}')$$, 'NOT_ALLOWED', 'A owner asking for B: can''t edit B');
select test.throws($$insert into public.clients (first_name, email) values ('X', 'x@x.test')$$, '42501', 'A owner asking for B: can''t add B clients');
-- No header at all: membership decides (nothing of B).
select test.studio(null);
select test.eq(test.count($$select 1 from public.clients where studio_id = test.id('harbour')$$), 0, 'A owner without a header: still no B clients');
select test.eq(test.count($$select 1 from public.bookings where studio_id = test.id('harbour')$$), 0, 'A owner without a header: no B bookings');
select test.admin();
select test.eq((select name from public.class_types where id = test.id('h_flow')), 'Reformer Flow', 'B class type unchanged');
select test.eq((select name from public.studio_settings where studio_id = test.id('harbour')), 'Harbour Reformer Co.', 'B settings unchanged');

-- ---------------------------------------------------------------- isolation: studio B staff and clients can't touch studio A
select test.login('hank');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.clients$$), 2, 'B owner sees B clients only (Hana, Alice''s B record, none of A)');
select test.eq(test.count($$select 1 from public.clients where studio_id = app.default_studio()$$), 0, 'B owner: no A clients');
select test.eq(test.count($$select 1 from public.bookings where studio_id = app.default_studio()$$), 0, 'B owner: no A bookings');
select test.eq(test.count($$select 1 from public.staff_pay where studio_id = app.default_studio()$$), 0, 'B owner: no A pay rates');
select test.throws($$select public.book_class(test.id('h_session'), null, test.id('alice_client'), true)$$, 'NOT_FOUND', 'B owner: can''t book an A client into B');
select test.throws($$select public.check_in((select id from public.bookings where studio_id = app.default_studio() limit 1))$$, 'NOT_FOUND', 'B owner: can''t check in an A booking');
select test.throws($$select public.adjust_pass(test.id('fay_old_pass'), 5, null, false, 'free credits')$$, 'NOT_FOUND', 'B owner: can''t adjust an A pass');
select test.throws($$select public.get_roster((select id from public.class_sessions where studio_id = app.default_studio() limit 1))$$, 'NOT_FOUND', 'B owner: no A rosters');
select test.eq(public.book_class(test.id('h_session'), null, test.id('hcli_client'), true) ->> 'outcome', 'booked', 'B owner books a B client into a B class');
select test.eq((public.report('2026-10-01', '2026-10-31') ->> 'sales_count')::int, 1, 'B report counts B sales only');
select test.studio('snowy');
select test.eq(public.whoami(), null::jsonb, 'B owner asking for A: not a member');
select test.eq(test.count($$select 1 from public.clients$$), 0, 'B owner asking for A: no clients');

-- Alice: a client of both. Studio-scoped as a client too.
select test.login('alice');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.passes$$), 0, 'client in B sees only her B passes (none), not her A ones');
select test.throws($$select public.credit_summary(test.id('alice_client'))$$, 'NOT_FOUND', 'client asking B for her A record: NOT_FOUND');
select test.throws($$select public.book_class(test.id('s_eve'))$$, 'NOT_FOUND', 'client asking B to book an A class: NOT_FOUND');
select test.throws($$select public.book_class(test.id('h_session'))$$, 'WAIVER_REQUIRED', 'client in B needs B''s waiver');
select test.studio('snowy');
select test.ok(test.count($$select 1 from public.passes$$) > 0, 'client in A sees her A passes');
select test.throws($$select public.book_class(test.id('h_session'))$$, 'NOT_FOUND', 'client asking A to book a B class: NOT_FOUND');
select test.studio(null);
select test.eq(test.count($$select 1 from public.clients$$), 2, 'without a header she sees both of her own records (realtime), no one else');

-- Anonymous visitors: a studio's public timetable only.
select test.anon();
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.sessions_with_counts$$), 1, 'anon with B header: B timetable only');
select test.eq(test.count($$select 1 from public.class_types$$), 1, 'anon with B header: B class types only');
select test.studio('nope-not-a-studio');
select test.eq(test.count($$select 1 from public.class_types$$), 0, 'an unknown studio scopes to nothing (never the default)');
select test.studio(null);
select test.eq(test.count($$select 1 from public.studios where slug = 'harbour'$$), 1, 'live studios are in the public directory');

-- ---------------------------------------------------------------- the database itself refuses cross-studio rows
select test.admin();
select test.studio(null);
select test.throws($$insert into public.bookings (studio_id, session_id, client_id, status) values (test.id('harbour'), test.id('s_eve'), test.id('hcli_client'), 'booked')$$,
                   '23503', 'a B booking can''t point at an A class (composite foreign key)');
select test.throws($$insert into public.passes (studio_id, client_id, kind, name) values (app.default_studio(), test.id('hcli_client'), 'pack', 'x')$$,
                   '23503', 'an A pass can''t belong to a B client');
select test.throws($$update public.clients set studio_id = app.default_studio() where id = test.id('hcli_client')$$, 'NOT_ALLOWED', 'records can''t move between studios');

-- ---------------------------------------------------------------- suspended studios
select test.login('pete');
select public.platform_set_studio_status(test.id('harbour'), 'suspended');
select test.eq(test.count($$select 1 from public.studios where id = test.id('harbour')$$), 1, 'platform admins still see a suspended studio');
select test.anon();
select test.studio(null);
select test.eq(test.count($$select 1 from public.studios where slug = 'harbour'$$), 0, 'a suspended studio leaves the public directory');
select test.login('hcli');
select test.studio('harbour');
select test.throws($$select public.cancel_booking((select id from public.bookings where client_id = test.id('hcli_client') limit 1))$$,
                   'STUDIO_SUSPENDED', 'nobody can book or cancel at a suspended studio');
select test.login('pete');
select public.platform_set_studio_status(test.id('harbour'), 'live');

-- ---------------------------------------------------------------- service role (Stripe webhook) lands in the right studio
select test.service();
select test.studio(null);
select test.eq((public.create_pass_from_purchase(test.id('hcli_client'), test.id('h_pack'), 19500, 'card_online', 'cs_harbour_1') -> 'sale' ->> 'studio_id'),
               test.id('harbour')::text, 'webhook purchase for a B client is recorded in B');
select test.throws($$select public.create_pass_from_purchase(test.id('hcli_client'), test.id('p_pack4'), 10000, 'card_online', 'cs_mix')$$,
                   'INVALID', 'webhook can''t sell an A product to a B client');
select test.admin();
select test.eq((select studio_id from public.notifications where kind = 'receipt' and client_id = test.id('hcli_client') order by created_at desc limit 1),
               test.id('harbour'), 'the receipt email belongs to B (its own studio name and tax)');
select set_config('app.studio', '', false);
select test.studio(null);

rollback;
