-- Security review regressions (migration 2900, docs/SECURITY-REVIEW.md):
--   * the structural audit (supabase/audit/security_audit.sql) finds nothing, and does catch a writable view
--   * staff_public / sessions_with_counts cannot be written through (they skipped RLS and the staff guards)
--   * a person with no client row in a studio can't read or change another client's records by id (NULL guard bug)
--   * logo SVG and website can't carry script; the avatars bucket can't be listed by everyone
--   * the kiosk PIN locks after 5 wrong tries
--   * a generic tenant fuzz: every public RPC, handed ids from the other studio / other clients, never answers
-- Snowy: Libby owner, Fran front desk, Julia instructor, Alice and Bob clients. Harbour: Hank owner, Hana client.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on function test.studio(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- 1. the audit
\ir ../audit/security_audit.sql
do $$
declare r text;
begin
  select string_agg(chk || ': ' || object, '; ') into r from pg_temp.sec_audit() where severity = 'FAIL';
  if r is not null then raise exception 'FAIL: security audit found: %', r; end if;
  raise notice 'ok - security audit: no tables without RLS or studio scope, no definer functions without search_path, no signed-out definers, no writable views';
end $$;
-- the audit really sees a writable view
grant insert on public.staff_public to anon;
do $$
begin
  if not exists (select 1 from pg_temp.sec_audit() where chk = 'view_writable') then raise exception 'FAIL: audit missed a writable view'; end if;
  raise notice 'ok - audit catches a view that signed-out callers can write';
end $$;
revoke insert on public.staff_public from anon;

-- ---------------------------------------------------------------- studio B and a stranger
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank"}', now()),
  (gen_random_uuid(), 'zed@nowhere.test', '{"first_name":"Zed","studio":"nonexistent"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test', 'zed@nowhere.test');
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
select test.login('hank');
select test.studio('harbour');
select public.update_my_studio('{"status":"live"}');
insert into public.class_types (name, duration_min, default_capacity) values ('Reformer Flow', 50, 2) returning id as h_flow \gset
insert into public.products (kind, name, price_cents, credits, validity_days) values ('pack', '5 pack', 19500, 5, 90) returning id as h_pack \gset
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity)
values (:'h_flow', '2026-10-21 07:00+11', '2026-10-21 07:50+11', (select id from public.staff where email = 'hank@harbour.test'), 2) returning id as h_session \gset
select test.admin();
update public.clients set waiver_signed_at = now() where email = 'hana@harbour.test';
select test.login('hank'); select test.studio('harbour');
select public.checkout_cart(test.id('hana_client'), jsonb_build_array(jsonb_build_object('product_id', :'h_pack')), 'cash');
select public.book_class(:'h_session', null, test.id('hana_client'), true);
select test.admin();
\o
select test.studio('snowy');

-- ---------------------------------------------------------------- 2. views are read-only
select test.anon();
select test.throws($$update public.staff_public set name = 'Pwned'$$, '42501', 'signed out: cannot rename staff through staff_public');
select test.throws($$update public.staff_public set role = 'manager'$$, '42501', 'signed out: cannot change a role through staff_public');
select test.throws($$delete from public.staff_public$$, '42501', 'signed out: cannot delete staff through staff_public');
select test.throws($$insert into public.staff_public (name, role, studio_id) values ('Eve', 'manager', app.current_studio_id())$$, '42501', 'signed out: cannot add staff through staff_public');
select test.throws($$update public.sessions_with_counts set capacity = 1$$, '55000', 'signed out: cannot edit classes through sessions_with_counts (not updatable at all)');
select test.ok((select count(*) from public.staff_public) >= 5, 'signed out can still read the public staff list');
select test.ok((select count(*) from public.sessions_with_counts) >= 9, 'signed out can still read the timetable');
select test.login('julia');
select test.throws($$update public.staff_public set role = 'manager' where name = 'Julia'$$, '42501', 'an instructor cannot promote herself through staff_public');
select test.throws($$delete from public.staff_public where name = 'Libby'$$, '42501', 'an instructor cannot delete the owner through staff_public');
select test.admin();
select test.eq((select role from public.staff where name = 'Julia'), 'instructor', 'Julia is still an instructor');

-- ---------------------------------------------------------------- 3. strangers can't read or change a client by id
-- Zed has a login but no client row anywhere. Alice's UUID is all they know.
select test.login('zed');
select test.studio('snowy');
select test.throws($$select public.credit_summary(test.id('alice_client'))$$, 'NOT_FOUND', 'a stranger cannot read a client''s passes');
select test.throws($$select public.list_client_bookings(test.id('alice_client'))$$, 'NOT_FOUND', 'a stranger cannot read a client''s bookings');
select test.throws($$select public.is_intro_eligible(test.id('alice_client'))$$, 'NOT_FOUND', 'a stranger cannot probe a client''s intro status');
select test.throws($$select public.submit_waiver(test.id('alice_client'), '{"injuries":"Zed was here"}')$$, 'NOT_FOUND', 'a stranger cannot read or overwrite a client''s waiver and health form');
select test.throws($$select public.submit_health_check(test.id('alice_client'), true, 'Zed was here')$$, 'NOT_FOUND', 'a stranger cannot change a client''s health check');
select test.throws($$select public.register_interest(test.id('sculpt'), test.id('alice_client'))$$, 'NOT_ALLOWED', 'a stranger cannot register interest for a client');
select test.studio('harbour');
select test.throws($$select public.credit_summary(test.id('hana_client'))$$, 'NOT_FOUND', 'a stranger cannot read another studio''s client either');
select test.throws($$select public.submit_waiver(test.id('hana_client'), '{"injuries":"Zed was here"}')$$, 'NOT_FOUND', '...or overwrite its waiver');
-- a client of studio A, asking for studio B
select test.login('alice');
select test.studio('harbour');
select test.throws($$select public.credit_summary(test.id('hana_client'))$$, 'NOT_FOUND', 'a Snowy client cannot read a Harbour client through the Harbour header');
select test.throws($$select public.list_client_bookings(test.id('hana_client'))$$, 'NOT_FOUND', '...or their bookings');
select test.admin();
select test.ok((select coalesce(injuries, '') not like '%Zed%' and coalesce(health_form::text, '') not like '%Zed%' from public.clients where id = test.id('alice_client')), 'Alice''s health data is untouched');
select test.ok((select coalesce(injuries, '') not like '%Zed%' and coalesce(health_form::text, '') not like '%Zed%' from public.clients where id = test.id('hana_client')), 'Hana''s health data is untouched');
-- and the people who should still work do
select test.studio('snowy');
select test.login('alice');
select test.ok(public.credit_summary(test.id('alice_client')) is not null, 'a client still reads her own credit summary');
select test.ok(public.list_client_bookings(test.id('alice_client')) is not null, '...and her own bookings');
select test.ok(public.submit_waiver(test.id('alice_client'), '{"injuries":"Sore wrist"}') ->> 'waiver_signed_at' is not null, '...and signs her own waiver');
select test.login('fran');
select test.ok(public.credit_summary(test.id('alice_client')) is not null, 'front desk still reads a client''s credit summary');
select test.admin();

-- ---------------------------------------------------------------- 4. branding is data
select test.login('libby');
select test.throws($$select public.update_my_studio('{"branding":{"logo":{"svg":"<text>Snowy</text><script>alert(1)</script>"}}}')$$, 'INVALID', 'a logo with a script tag is refused');
select test.throws($$select public.update_my_studio('{"branding":{"logo":{"svg":"<g onload=\"alert(1)\"><path d=\"M0 0\"/></g>"}}}')$$, 'INVALID', 'a logo with an event handler is refused');
select test.throws($$select public.update_my_studio('{"branding":{"logo":{"svg":"<a href=\"javascript:alert(1)\"><text>x</text></a>"}}}')$$, 'INVALID', 'a logo with a link is refused');
select test.throws($$select public.update_my_studio('{"branding":{"logo":{"svg":"<foreignObject><div>x</div></foreignObject>"}}}')$$, 'INVALID', 'a logo with foreignObject is refused');
select test.throws($$select public.update_my_studio('{"branding":{"logo":{"svg":"<path d=\"M0 0\" style=\"fill:url(https://evil.test/x)\"/>"}}}')$$, 'INVALID', 'a logo with an external reference is refused');
select test.throws($$select public.update_my_studio('{"branding":{"logo":{"svg":"<image href=\"data:text/html;base64,AAAA\"/>"}}}')$$, 'INVALID', 'a logo with an embedded image is refused');
select test.ok((public.update_my_studio('{"branding":{"logo":{"svg":"<svg class=\"lf\" style=\"--n:0\" x=\"0\" y=\"34\" width=\"112\" height=\"112\" viewBox=\"0 0 100 100\"><path d=\"M10 10L90 90\" fill=\"var(--logo-mark)\"/></svg><text class=\"lt\" style=\"--n:1\" x=\"136\" y=\"124\" font-family=\"var(--display)\" font-size=\"92\" fill=\"var(--logo-letters)\">Snowy</text>"},"appName":"Snowy Pilates Club"}}') ->> 'name') is not null, 'the app''s own text logo is accepted');
select test.throws($$select public.update_my_studio('{"website":"javascript:alert(1)"}')$$, 'INVALID', 'a javascript: website is refused');
select test.eq((public.update_my_studio('{"website":"snowypilatesclub.com"}') ->> 'website'), 'https://snowypilatesclub.com', 'a bare website gets https://');
select test.login('pete');
select test.throws($$select public.platform_update_studio(test.id('harbour'), '{"branding":{"logo":{"svg":"<svg onload=alert(1)>"}}}')$$, 'INVALID', 'the platform admin path is checked too');
select test.admin();
select test.ok(app.svg_is_safe('<text x="0" y="0">Hello &amp; welcome</text>'), 'plain text is safe');
select test.ok(not app.svg_is_safe('<svg><style>*{}</style></svg>'), 'style elements are not safe');
select test.ok(not app.svg_is_safe('<svg><use href="#a"/></svg>'), 'use is not safe');
select test.ok(not app.svg_is_safe('<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>'), 'animate is not safe');

-- ---------------------------------------------------------------- 5. avatars cannot be listed by everyone
insert into storage.objects (bucket_id, name) values ('avatars', test.id('alice_client') || '/1.jpg'), ('avatars', test.id('bob_client') || '/1.jpg');
select test.anon();
select test.eq((select count(*)::int from storage.objects where bucket_id = 'avatars'), 0, 'signed out cannot list client photos');
select test.login('zed');
select test.eq((select count(*)::int from storage.objects where bucket_id = 'avatars'), 0, 'a stranger cannot list client photos');
select test.login('alice');
select test.eq((select count(*)::int from storage.objects where bucket_id = 'avatars'), 1, 'a client sees only her own photo folder');
select test.login('fran');
select test.eq((select count(*)::int from storage.objects where bucket_id = 'avatars'), 2, 'front desk sees the studio''s photo folders');
select test.admin();

-- ---------------------------------------------------------------- 6. kiosk PIN lockout
select test.studio('snowy');
select test.login('libby');
select public.kiosk_set_pin('4821');
select test.login('fran');
select test.eq(public.kiosk_check_pin('4821'), true, 'the right PIN works');
select public.kiosk_check_pin('0000'); select public.kiosk_check_pin('0001'); select public.kiosk_check_pin('0002'); select public.kiosk_check_pin('0003');
select test.eq(public.kiosk_check_pin('4821'), true, 'four wrong tries and a right one still works');
select public.kiosk_check_pin('1111'); select public.kiosk_check_pin('1112'); select public.kiosk_check_pin('1113'); select public.kiosk_check_pin('1114');
select test.eq(public.kiosk_check_pin('1115'), false, 'the fifth wrong try is just wrong');
select test.throws($$select public.kiosk_check_pin('4821')$$, 'LOCKED', 'then the kiosk is locked, even for the right PIN');
select test.throws($$select public.kiosk_check_pin('0000')$$, 'LOCKED', '...and stays locked');
select test.login('libby');
select public.kiosk_set_pin('4821');
select test.login('fran');
select test.eq(public.kiosk_check_pin('4821'), true, 'setting a new PIN lifts the lock');
select test.login('libby');
select public.kiosk_set_pin(null);
select test.admin();

-- ---------------------------------------------------------------- 7. tenant fuzz
-- Every public function that takes a uuid is called with each id that belongs to someone else (the other studio, other clients),
-- one argument at a time, inside a rolled-back sub-transaction. Any call that answers with data is a leak.
create table test.b_ids (tbl text, id uuid);
grant select on test.b_ids to authenticated, anon;
do $$
declare t record;
begin
  for t in select c.table_name from information_schema.columns c join information_schema.columns d on d.table_schema = c.table_schema and d.table_name = c.table_name and d.column_name = 'studio_id'
            where c.table_schema = 'public' and c.column_name = 'id' and c.data_type = 'uuid' and c.table_name <> 'studios' loop
    execute format('insert into test.b_ids select %L, id from public.%I where studio_id = %L limit 8', t.table_name, t.table_name, (select id from test.ids where name = 'harbour'));
  end loop;
  insert into test.b_ids select 'studios', id from test.ids where name = 'harbour';
  insert into test.b_ids select 'clients', id from public.clients where studio_id = app.default_studio() and id <> test.id('alice_client');
  insert into test.b_ids select 'bookings', id from public.bookings where studio_id = app.default_studio() and client_id <> test.id('alice_client');
  insert into test.b_ids select 'passes', id from public.passes where studio_id = app.default_studio() and client_id <> test.id('alice_client');
  insert into test.b_ids select 'sales', id from public.sales where studio_id = app.default_studio() and client_id <> test.id('alice_client');
  insert into test.b_ids select 'class_sessions', id from public.class_sessions where studio_id = app.default_studio() limit 6;
end $$;

create function test.fuzz() returns table(fn text, argpos int, tbl text) language plpgsql as $$
declare f record; b record; i int; args text; base_ok boolean; base_txt text; got_txt text; ok boolean; types oid[];
begin
  for f in select p.oid, p.proname, p.proargtypes::oid[] as ty from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.provariadic = 0 and p.prorettype <> 'trigger'::regtype
              and has_function_privilege(current_user, p.oid, 'execute')
              and p.proname not in ('whoami','my_studios','current_client_id','current_staff_id','staff_role','is_staff','has_role')
              and 'uuid'::regtype::oid = any (p.proargtypes::oid[]) loop
    types := f.ty;
    select string_agg('null::' || format_type(t, null), ',' order by n) into args from unnest(types) with ordinality u(t, n);
    base_txt := null;
    begin execute format('select (public.%I(%s))::text', f.proname, args) into base_txt; raise exception using errcode = 'P0099', message = 'x';
    exception when sqlstate 'P0099' then base_ok := true; when others then base_ok := false; end;
    for i in 1..coalesce(array_length(types, 1), 0) loop
      continue when types[i] <> 'uuid'::regtype::oid;
      for b in select * from test.b_ids loop
        select string_agg(case when n = i then quote_literal(b.id) || '::uuid' else 'null::' || format_type(t, null) end, ',' order by n) into args from unnest(types) with ordinality u(t, n);
        got_txt := null;
        begin
          execute format('select (public.%I(%s))::text', f.proname, args) into got_txt;
          raise exception using errcode = 'P0099', message = 'x';
        exception when sqlstate 'P0099' then ok := true; when others then ok := false; end;
        if ok and coalesce(got_txt, '') not in ('', '[]', '{}', 'null') and (not base_ok or got_txt is distinct from base_txt) then
          fn := f.proname; argpos := i; tbl := b.tbl; return next;
        end if;
      end loop;
    end loop;
  end loop;
end $$;
grant execute on function test.fuzz() to authenticated, anon;
create function test.leaks(p_who text, p_studio text) returns text language plpgsql as $$
declare r text;
begin
  perform test.login(p_who); perform test.studio(p_studio);
  select string_agg(distinct x.fn || '(' || x.argpos || ')<-' || x.tbl, ', ') into r from test.fuzz() x;
  perform test.admin();
  return coalesce(r, 'none');
end $$;
grant execute on function test.leaks(text, text) to authenticated, anon;

select test.eq(test.leaks('zed', 'snowy'), 'none', 'fuzz: a stranger asking for Snowy gets nothing back');
select test.eq(test.leaks('zed', 'harbour'), 'none', 'fuzz: a stranger asking for Harbour gets nothing back');
select test.eq(test.leaks('libby', 'harbour'), 'none', 'fuzz: Snowy''s owner asking for Harbour gets nothing back');
select test.eq(test.leaks('hank', 'snowy'), 'none', 'fuzz: Harbour''s owner asking for Snowy gets nothing back');
select test.eq(test.leaks('alice', 'harbour'), 'none', 'fuzz: a Snowy client asking for Harbour gets nothing back');
select test.eq(test.leaks('julia', 'harbour'), 'none', 'fuzz: a Snowy instructor asking for Harbour gets nothing back');
select test.eq(test.leaks('fran', 'harbour'), 'none', 'fuzz: Snowy''s front desk asking for Harbour gets nothing back');
delete from test.b_ids where tbl not in ('clients','bookings','passes','sales');
select test.eq(test.leaks('alice', 'snowy'), 'none', 'fuzz: a client handed other clients'' client, booking, pass and sale ids gets nothing back');

rollback;
