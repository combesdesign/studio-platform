-- TEST ONLY: helper functions + a small cast of fake people for the database tests.
\o /dev/null
-- "Now" in the tests is Monday 19 Oct 2026, 8:00am Sydney time (AEDT, UTC+11).

create schema test;
grant usage on schema test to anon, authenticated, service_role;

create table test.ids (name text primary key, id uuid not null);
grant select on test.ids to anon, authenticated, service_role;

create function test.id(p_name text) returns uuid language plpgsql stable as $$
declare v uuid;
begin
  select id into v from test.ids where name = p_name;
  if v is null then raise exception 'test.id: unknown name %', p_name; end if;
  return v;
end $$;

-- Act as a signed-in user (by test name), as anon, or go back to admin (SQL editor).
create function test.login(p_name text) returns void language plpgsql as $$
declare v uuid := test.id(p_name);
begin
  perform set_config('request.jwt.claim.sub', v::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create function test.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  perform set_config('role', 'anon', false);
end $$;
create function test.service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  perform set_config('role', 'service_role', false);
end $$;
create function test.admin() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '', false);
  perform set_config('role', 'none', false);
end $$;
create function test.at(p_now text) returns void language plpgsql as $$
begin perform set_config('app.now', p_now, false); end $$;

create function test.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok - %', p_name;
end $$;

create function test.eq(p_got anyelement, p_want anyelement, p_name text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then raise exception 'FAIL: % (got %, want %)', p_name, p_got, p_want; end if;
  raise notice 'ok - %', p_name;
end $$;

-- Run SQL and expect it to fail with a StoreError code ('NO_CREDITS') or a SQLSTATE ('42501').
create function test.throws(p_sql text, p_code text, p_name text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_code || ':%' or sqlstate = p_code then
      raise notice 'ok - % (% raised)', p_name, p_code;
      return;
    end if;
    raise exception 'FAIL: % (expected %, got % %)', p_name, p_code, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (expected %, but it worked)', p_name, p_code;
end $$;

grant execute on all functions in schema test to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- people
select test.at('2026-10-18 12:00+11');

update public.staff set email = 'libby@example.test' where name = 'Libby';
update public.staff set email = 'julia@example.test' where name = 'Julia';
update public.staff set email = 'gracet@example.test' where name = 'Grace T';
insert into public.staff (name, email, role) values ('Mia Manager', 'mia@example.test', 'manager'),
                                                    ('Fran Desk', 'fran@example.test', 'front_desk');
insert into public.staff_pay (staff_id, pay_per_class_cents)
select id, 6000 from public.staff where name in ('Julia', 'Grace T', 'Libby');

-- Confirmed sign-ups. Staff emails link to their staff rows; everyone else becomes a client.
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
select gen_random_uuid(), e, jsonb_build_object('first_name', f, 'last_name', 'Test'), now()
  from (values ('libby@example.test', 'Libby'), ('julia@example.test', 'Julia'), ('gracet@example.test', 'Grace'),
               ('mia@example.test', 'Mia'), ('fran@example.test', 'Fran'),
               ('alice@example.test', 'Alice'), ('bob@example.test', 'Bob'), ('cara@example.test', 'Cara'),
               ('dan@example.test', 'Dan'), ('erin@example.test', 'Erin'), ('fay@example.test', 'Fay'),
               ('gus@example.test', 'Gus')) v(e, f);

insert into test.ids
select split_part(email, '@', 1), id from auth.users;
insert into test.ids
select split_part(c.email, '@', 1) || '_client', c.id from public.clients c;
insert into test.ids
select split_part(s.email, '@', 1) || '_staff', s.id from public.staff s where s.email is not null;
insert into test.ids values
  ('mat', 'c1a55000-0000-4000-8000-000000000001'), ('mums', 'c1a55000-0000-4000-8000-000000000002'),
  ('sculpt', 'c1a55000-0000-4000-8000-000000000003'),
  ('p_week1', '9a0d0000-0000-4000-8000-000000000001'), ('p_week2', '9a0d0000-0000-4000-8000-000000000002'),
  ('p_unlimited', '9a0d0000-0000-4000-8000-000000000004'), ('p_single', '9a0d0000-0000-4000-8000-000000000011'),
  ('p_pack4', '9a0d0000-0000-4000-8000-000000000012'), ('p_pack8', '9a0d0000-0000-4000-8000-000000000013'),
  ('p_intro', '9a0d0000-0000-4000-8000-000000000021'), ('p_socks', '9a0d0000-0000-4000-8000-000000000031');

-- Everyone but Erin has signed the waiver.
update public.clients set waiver_signed_at = '2026-10-01 09:00+10' where email <> 'erin@example.test';

-- ----------------------------------------------------------------------------- passes (bought at the desk)
select public.checkout_cart(test.id('alice_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'cash');
select public.checkout_cart(test.id('bob_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_week2'))), 'card_reader');
select public.checkout_cart(test.id('dan_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4')),
                                                                     jsonb_build_object('product_id', test.id('p_unlimited'))), 'card_reader');
-- Fay: two 4-packs. One already in use and expiring in 8 days (should be used first).
select public.checkout_cart(test.id('fay_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 2)), 'cash');
with p as (select id from public.passes where client_id = test.id('fay_client') order by id limit 1)
update public.passes set activated_at = '2026-08-29 10:00+10', expires_at = '2026-10-27 10:00+11', credits_used = 1
 where id = (select id from p);
insert into test.ids select 'fay_old_pass', id from public.passes where client_id = test.id('fay_client') and activated_at is not null;
insert into test.ids select 'fay_new_pass', id from public.passes where client_id = test.id('fay_client') and activated_at is null;
-- Gus: single class credit.
select public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'cash');

-- ----------------------------------------------------------------------------- classes (one-offs)
create function test.mk_session(p_name text, p_type text, p_starts timestamptz, p_cap int, p_instructor text)
returns void language plpgsql as $$
declare v uuid; d int;
begin
  select duration_min into d from public.class_types where id = test.id(p_type);
  insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity)
  values (test.id(p_type), p_starts, p_starts + make_interval(mins => d), test.id(p_instructor || '_staff'), p_cap)
  returning id into v;
  insert into test.ids values (p_name, v);
end $$;

select test.mk_session('s_early',  'mat',    '2026-10-21 06:00+11', 2,  'julia');   -- Wed, tiny class for waitlist tests
select test.mk_session('s_eve',    'mat',    '2026-10-21 18:00+11', 14, 'gracet');  -- Wed
select test.mk_session('s_thu',    'mat',    '2026-10-22 06:00+11', 14, 'julia');   -- Thu
select test.mk_session('s_fri',    'mat',    '2026-10-23 06:00+11', 14, 'libby');   -- Fri
select test.mk_session('s_cancel', 'mums',   '2026-10-23 09:30+11', 2,  'gracet');  -- Fri
select test.mk_session('s_next',   'mat',    '2026-10-26 06:00+11', 14, 'julia');   -- next Mon (new week)
select test.mk_session('s_past',   'mat',    '2026-10-19 06:00+11', 14, 'julia');   -- started 2h ago
select test.mk_session('s_far',    'mat',    '2026-11-04 06:00+11', 14, 'julia');   -- beyond 14-day window
select test.mk_session('s_sculpt', 'sculpt', '2026-10-22 18:00+11', 14, 'julia');   -- coming soon class

select test.at('');
