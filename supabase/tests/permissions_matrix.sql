-- Round 3: permissions matrix. Who can call what, and who can read or change what, for every role, with other studios always shut out.
--
-- Roles (letters used below):  A anon   a alice (a client)   b bob (the client who owns the test data)   j julia (instructor of the class)
--   g gracet (instructor of a different class)   f fran (front desk)   m mia (manager)   o libby (owner)   p pete (platform admin)
--   h hcli (client of ANOTHER studio)   k hank (owner of ANOTHER studio)   z zed (signed in, belongs to no studio: the "stranger" baseline)
--
-- 1. FUNCTIONS. The list of RPCs comes from the catalog (every security definer function in public): one that is missing from `test.pm_rpc_expect`
--    below fails the test, and so does a listed one that no longer exists. Each RPC is called as every role with arguments that point at real rows
--    of the studio, inside a savepoint that is rolled back. "Allowed" means it got past its permission checks (any error other than NOT_ALLOWED,
--    AUTH_REQUIRED, NOT_FOUND or a privilege error). Where the sample arguments can't reach the body, the first error is the verdict (a gate that
--    runs before the lookup, which is the pattern in this code base). Grants are checked too: anon may only run the helpers listed; service-only
--    functions must not be callable by clients. Then the same calls run as the other studio's people, and as this studio's people with the other
--    studio's header, and must never be allowed (except the few identity-only helpers that are about the signed-in user, not a studio).
-- 2. TABLES. Every table and view in public gets one generic row per studio (checks dropped and FK triggers off, in this rolled-back transaction only).
--    Per role: can it read, insert, update, delete that row? Compared with `test.pm_table_expect`, which is grouped into named access patterns.
--    A table missing from the list fails the test. Cross-studio: another studio's people see, change and add exactly what a stranger can, which is
--    nothing of the studio's private data; and this studio's people can't touch the other studio's rows either (any header).
-- 3. HEALTH NOTES. Visible per studio_settings.health_notes_visibility (default: owner, managers and that class's instructor) through every path
--    that returns them: client_health, the class roster, and the raw table columns. A new function that mentions the health columns fails the test.
--
-- To print the observed matrix instead of asserting (to review a change):  psql ... -v pm_dump=1 -f supabase/tests/permissions_matrix.sql
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- people and studios
create function test.pm_hdr(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null or p_slug = 'none' then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on function test.pm_hdr(text) to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test',  '{"first_name":"Pete","studio":"none"}', now()),   -- platform admin, no client row anywhere
  (gen_random_uuid(), 'zed@example.test',    '{"first_name":"Zed","studio":"none"}', now()),    -- a stranger: signed in, in no studio
  (gen_random_uuid(), 'dummy@example.test',  '{"first_name":"Dummy","studio":"none"}', now()),  -- owner of generic rows that need a user (not a client or staff anywhere)
  (gen_random_uuid(), 'hank@harbour.test',   '{"first_name":"Hank","studio":"harbour"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'zed@example.test', 'dummy@example.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));
select test.login('pete');
select public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test');
select public.platform_invite_owner((select id from public.studios where slug = 'harbour'), 'Hank', 'hank@harbour.test');
-- the top plan, so Harbour has every feature switched on (a plan-locked function would otherwise say FEATURE_LOCKED before it checks who is asking)
select public.platform_set_studio_plan((select id from public.studios where slug = 'harbour'), (select id from public.plans order by price_cents desc limit 1), 'active', true);
select test.admin();
-- (a sign-up naming a studio that doesn't exist yet makes no client row, so the other studio's client signs up now)
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'hcli@example.test', '{"first_name":"Hana","studio":"harbour"}', now());
insert into test.ids select 'hcli', id from auth.users where email = 'hcli@example.test';
insert into test.ids select 'hcli_client', id from public.clients where email = 'hcli@example.test';
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';
insert into test.ids values ('harbour', (select id from public.studios where slug = 'harbour')), ('snowy', (select id from public.studios where slug = 'snowy'));
update public.clients set waiver_signed_at = '2026-10-01 09:00+10' where id = test.id('hcli_client');
-- Bob has a booking in Julia's class (health notes: Julia sees Bob's notes by default, Gracet does not).
select test.login('bob'); select public.book_class(test.id('s_thu'));
select test.admin();
update public.clients set injuries = 'Bad knee (fake note)', health_form = '{"injuries":"Bad knee (fake note)"}' where id = test.id('bob_client');

create table test.pm_role (letter text primary key, name text not null, hdr text not null, ord int);
insert into test.pm_role values ('A','anon','snowy',1), ('a','alice','snowy',2), ('b','bob','snowy',3), ('j','julia','snowy',4), ('g','gracet','snowy',5),
  ('f','fran','snowy',6), ('m','mia','snowy',7), ('o','libby','snowy',8), ('p','pete','snowy',9),
  ('h','hcli','harbour',10), ('k','hank','harbour',11), ('z','zed','snowy',12);
create function test.pm_as(p_letter text, p_hdr text) returns void language plpgsql as $$
declare v_name text;
begin
  perform test.admin();
  select name into v_name from test.pm_role where letter = p_letter;
  if v_name = 'anon' then perform test.anon(); else perform test.login(v_name); end if;
  perform test.pm_hdr(p_hdr);
end $$;
grant execute on function test.pm_as(text, text) to anon, authenticated, service_role;
create function test.pm_letters(p_letters text) returns text language sql immutable as $$
  select coalesce(string_agg(l, '' order by o), '') from (select x as l, array_position(array['A','a','b','j','g','f','m','o','p','h','k','z'], x) as o from unnest(string_to_array(regexp_replace(p_letters, '(.)', '\1,', 'g'), ',')) x where x <> '') s
$$;

-- ---------------------------------------------------------------- one generic row per table per studio
create function test.pm_lit(p_table regclass, p_col text) returns text language sql as $$
  select (regexp_match(pg_get_constraintdef(c.oid), '''([^'']*)''::text'))[1]
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attname = p_col
   where c.conrelid = p_table and c.contype = 'c' and a.attnum = any (c.conkey) and cardinality(c.conkey) = 1 and pg_get_constraintdef(c.oid) ~ '''::text' limit 1
$$;

-- The INSERT for one generic row of a table in a studio. Clients and staff it points at are Bob / Julia (Snowy) and Hana / Hank (Harbour).
create function test.pm_row(p_table text, p_studio text, p_strict boolean) returns text language plpgsql as $$
declare
  v_sid uuid := test.id(p_studio);
  c record; v_fk record; v_cols text := ''; v_vals text := ''; v_val text;
  v_cli text := case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end;
  v_stf text := case p_studio when 'snowy' then 'julia_staff' else 'hank_staff' end;
  v_usr text := 'dummy';   -- never a real role: a generic row must not make Bob a staff member or platform admin
begin
  for c in select a.attname, a.attnotnull, a.atthasdef, format_type(a.atttypid, a.atttypmod) ty, a.attgenerated,
                  pg_get_expr(d.adbin, d.adrelid) def
             from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = p_table::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum loop
    continue when c.attgenerated <> '';
    v_val := null;
    if c.attname = 'studio_id' then v_val := quote_literal(v_sid);
    elsif c.ty = 'boolean' and c.attname in ('published','active','visible','enabled','bookable') then v_val := 'true';
    elsif c.attname = 'id' and c.ty like '%int%' then v_val := null;
    elsif c.attname in ('client_unread', 'staff_unread') then v_val := '1';   -- (so "mark as read" really has a row to touch and its checks run every time)
    else
      select f.confrelid::regclass::text rt, (select attname from pg_attribute where attrelid = f.confrelid and attnum = f.confkey[1]) rc into v_fk
        from pg_constraint f where f.conrelid = p_table::regclass and f.contype = 'f'
         and f.conkey = array[(select attnum from pg_attribute where attrelid = p_table::regclass and attname = c.attname)]::smallint[]
         and f.confrelid::regclass::text <> 'public.studios' limit 1;
      if v_fk.rt is not null then
        if v_fk.rt = 'auth.users' then v_val := quote_literal(test.id(v_usr));
        elsif v_fk.rt = 'public.clients' then v_val := quote_literal(test.id(v_cli));
        elsif v_fk.rt = 'public.staff' then v_val := quote_literal(test.id(v_stf));
        else
          execute format('select %I::text from %s where %s order by ctid limit 1', v_fk.rc, v_fk.rt,
                         case when exists (select 1 from pg_attribute where attrelid = v_fk.rt::regclass and attname = 'studio_id') then format('studio_id = %L', v_sid) else 'true' end) into v_val;
          if v_val is null and p_strict then return null; end if;
          v_val := quote_literal(coalesce(v_val, gen_random_uuid()::text));
        end if;
      elsif (c.attnotnull and not c.atthasdef) then
        v_val := quote_nullable(test.pm_lit(p_table::regclass, c.attname));
        if v_val = 'NULL' then
          v_val := case
            when c.ty = 'uuid' then quote_literal(gen_random_uuid())
            when c.ty like 'text%' or c.ty like 'character%' then quote_literal('pm ' || c.attname || ' ' || p_studio)
            when c.ty in ('integer','bigint','smallint') or c.ty like 'numeric%' then '1'
            when c.ty = 'boolean' then 'false'
            when c.ty like 'timestamp%' then quote_literal(app.now())
            when c.ty = 'date' then quote_literal(app.now()::date)
            when c.ty like 'time %' then quote_literal('10:00')
            when c.ty = 'jsonb' then '''{}'''
            when c.ty like '%[]' then '''{}'''
            else 'null' end;
        end if;
      elsif c.attnotnull and c.def like '%auth.uid()%' then v_val := quote_literal(test.id(v_usr));
      end if;
    end if;
    if v_val is not null then v_cols := v_cols || format('%I,', c.attname); v_vals := v_vals || v_val || ','; end if;
  end loop;
  if v_cols = '' then return format('insert into %s default values', p_table); end if;
  return format('insert into %s (%s) values (%s)', p_table, rtrim(v_cols, ','), rtrim(v_vals, ','));
end $$;

create table test.pm_seeded (tbl text, studio text, rows_n int, primary key (tbl, studio));
create function test.pm_seed() returns void language plpgsql as $$
declare r record; v_studio text; v_pass int; v_sql text; v_n int; v_pending text[]; v_next text[];
begin
  foreach v_studio in array array['snowy','harbour'] loop
    select array_agg(k.oid::regclass::text order by relname) into v_pending from pg_class k join pg_namespace n on n.oid = k.relnamespace
     where nspname = 'public' and relkind = 'r' and relname not in ('studios', 'platform_admins');   -- (Pete's row is the only admin there is)
    for v_pass in 1..4 loop      -- passes 1-3 wait for parents to exist, pass 4 takes whatever is left
      v_next := '{}';
      for r in select unnest(v_pending) t loop
        v_sql := test.pm_row(r.t, v_studio, v_pass < 4);
        if v_sql is null then v_next := v_next || r.t; continue; end if;
        begin
          execute v_sql;
        exception when others then
          if sqlstate <> '23505' then raise notice 'seed % %: % [%]', r.t, v_studio, sqlerrm, left(v_sql, 200); end if;   -- (23505: a row is already there)
        end;
      end loop;
      v_pending := v_next;
      exit when cardinality(v_pending) = 0;
    end loop;
  end loop;
  for r in select k.oid::regclass::text t, k.relname from pg_class k join pg_namespace n on n.oid = k.relnamespace where nspname = 'public' and relkind = 'r' loop
    foreach v_studio in array array['snowy','harbour'] loop
      if exists (select 1 from pg_attribute where attrelid = r.t::regclass and attname = 'studio_id' and not attisdropped) then
        execute format('select count(*) from %s where studio_id = %L', r.t, test.id(v_studio)) into v_n;
      elsif r.relname = 'studios' then execute format('select count(*) from %s where id = %L', r.t, test.id(v_studio)) into v_n;
      else execute format('select count(*) from %s', r.t) into v_n; end if;
      insert into test.pm_seeded values (r.relname, v_studio, v_n);
    end loop;
  end loop;
end $$;

-- Test-only relaxations, undone by the rollback at the end: drop CHECK constraints so generic values fit, switch FK triggers off while seeding.
do $$ declare r record; begin
  for r in select conrelid::regclass::text t, conname from pg_constraint c join pg_class k on k.oid = c.conrelid join pg_namespace n on n.oid = k.relnamespace
            where n.nspname = 'public' and c.contype = 'c' loop
    execute format('alter table %s drop constraint %I', r.t, r.conname);
  end loop;
end $$;
set session_replication_role = replica;
select test.pm_seed();
set session_replication_role = origin;

-- ================================================================ 1. FUNCTIONS
-- Sample arguments: the ids of real rows in Snowy (Bob's booking, pass, sale; Julia; the class types ...).
create table test.pm_idtbl (fn text, arg text, tbl text);
insert into test.pm_idtbl values
  (null, 'p_event_id', 'studio_events'), (null, 'p_registration_id', 'studio_event_registrations'), (null, 'p_appointment_id', 'appointments'),
  (null, 'p_type_id', 'appointment_types'), (null, 'p_video_id', 'ondemand_videos'), (null, 'p_promo_id', 'commerce_promos'),
  (null, 'p_request_id', 'support_requests'), (null, 'p_credit_id', 'appointment_credits'), (null, 'p_room_id', 'rooms'), (null, 'p_location', 'locations'),
  ('appointments_remove_time_off', 'p_id', 'appointment_time_off'), ('appointments_cancel_event', 'p_id', 'studio_events'), ('appointments_get_event', 'p_id', 'studio_events'),
  ('appointments_leave_waitlist', 'p_id', 'studio_event_waitlist'), ('appointments_cancel_registration', 'p_id', 'studio_event_registrations'),
  ('appointments_move', 'p_id', 'appointments'), ('appointments_cancel', 'p_id', 'appointments'), ('appointments_set_status', 'p_id', 'appointments'),
  ('ondemand_delete_video', 'p_id', 'ondemand_videos'), ('ondemand_set_published', 'p_id', 'ondemand_videos'), ('ondemand_save_video', 'p_id', 'ondemand_videos'),
  ('ondemand_reorder', 'p_ids', 'ondemand_videos'), ('payroll_review_timesheets', 'p_ids', 'payroll_timesheets'),
  ('marketing_save_segment', 'p_id', 'marketing_segments'), ('marketing_delete_segment', 'p_id', 'marketing_segments'),
  ('marketing_get_campaign', 'p_id', 'marketing_campaigns'), ('marketing_delete_campaign', 'p_id', 'marketing_campaigns'), ('marketing_send_campaign', 'p_id', 'marketing_campaigns'),
  ('marketing_schedule_campaign', 'p_id', 'marketing_campaigns'), ('marketing_unschedule_campaign', 'p_id', 'marketing_campaigns'),
  ('commerce_adjust_gift_card', 'p_id', 'commerce_gift_cards'), ('commerce_get_gift_card', 'p_id', 'commerce_gift_cards'), ('commerce_resend_gift_card', 'p_id', 'commerce_gift_cards'),
  ('commerce_void_gift_card', 'p_id', 'commerce_gift_cards'),
  ('payroll_delete_rule', 'p_id', 'payroll_pay_rules'), ('payroll_claim_cover', 'p_id', 'payroll_cover_requests'), ('payroll_withdraw_claim', 'p_id', 'payroll_cover_requests'),
  ('payroll_decide_cover', 'p_id', 'payroll_cover_requests'), ('payroll_cancel_cover', 'p_id', 'payroll_cover_requests'),
  ('payroll_delete_timesheet', 'p_id', 'payroll_timesheets'), ('payroll_remove_adjustment', 'p_id', 'payroll_adjustments'), ('platform_save_plan', 'p_id', 'plans');

create function test.pm_arg(p_fn text, p_arg text, p_studio text) returns text language plpgsql as $$
declare v text; t text;
begin
  v := case p_arg
    when 'p_session_id' then (select id::text from public.class_sessions where studio_id = test.id(p_studio) order by (id = test.id('s_thu')) desc, ctid limit 1)
    when 'p_to_session_id' then (select id::text from public.class_sessions where studio_id = test.id(p_studio) order by (id = test.id('s_fri')) desc, ctid limit 1)
    when 'p_booking_id' then (select id::text from public.bookings where studio_id = test.id(p_studio) and status = 'booked' order by ctid limit 1)
    when 'p_client_id' then test.id(case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end)::text
    when 'p_dependant_id' then test.id(case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end)::text
    when 'p_guardian_id' then test.id(case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end)::text
    when 'p_pass_id' then (select id::text from public.passes where studio_id = test.id(p_studio) and client_id = test.id(case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end) order by ctid limit 1)
    when 'p_sale_id' then (select id::text from public.sales where studio_id = test.id(p_studio) and client_id = test.id(case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end) order by ctid limit 1)
    when 'p_staff_id' then test.id(case p_studio when 'snowy' then 'julia_staff' else 'hank_staff' end)::text
    when 'p_class_type_id' then (select id::text from public.class_types where studio_id = test.id(p_studio) order by (id = test.id('mat')) desc, ctid limit 1)
    when 'p_product_id' then (select id::text from public.products where studio_id = test.id(p_studio) order by (id = test.id('p_pack4')) desc, ctid limit 1)
    when 'p_studio_id' then test.id(p_studio)::text when 'p_studio' then test.id(p_studio)::text
    when 'p_template_id' then (select id::text from public.schedule_templates where studio_id = test.id(p_studio) limit 1)
    else null end;
  if v is null then
    select tbl into t from test.pm_idtbl where arg = p_arg and (fn = p_fn or fn is null) order by fn nulls last limit 1;
    if t is not null then
      execute format('select id::text from public.%I where %s order by ctid limit 1', t,
        case when exists (select 1 from pg_attribute where attrelid = ('public.' || t)::regclass and attname = 'studio_id') then format('studio_id = %L', test.id(p_studio)) else 'true' end) into v;
    end if;
  end if;
  return v;
end $$;

create table test.pm_calls (fn text, studio text, oid oid, sql text, primary key (fn, studio));
create function test.pm_call_sql(p_oid oid, p_studio text) returns text language plpgsql as $$
declare r record; v_args text := ''; v text; ty text;
begin
  for r in select u.ord, u.n, u.t, p.proname from pg_proc p,
           unnest(p.proargtypes::oid[], coalesce(p.proargnames[1:p.pronargs], array_fill(null::text, array[p.pronargs]::int[]))) with ordinality u(t, n, ord)
           where p.oid = p_oid order by u.ord loop
    ty := format_type(r.t, null);
    v := test.pm_arg(r.proname, r.n, p_studio);
    v_args := v_args || case when v_args = '' then '' else ',' end || case
      when v is not null and ty = 'uuid' then quote_literal(v) || '::uuid'
      when ty = 'uuid' then quote_literal(gen_random_uuid()) || '::uuid'
      when ty = 'uuid[]' then format('array[%L]::uuid[]', coalesce(v, test.id(case p_studio when 'snowy' then 'bob_client' else 'hcli_client' end)::text))
      when ty like '%[]' then format('''{}''::%s', ty)
      when ty = 'text' then quote_literal(case r.n when 'p_method' then 'cash' when 'p_email' then 'x@example.test' else 'x' end) || '::text'
      when ty = 'jsonb' then case when r.n in ('p_items','p_entry','p_keys') then '''[]''::jsonb' else '''{}''::jsonb' end
      when ty in ('integer','bigint') then '1'
      when ty = 'boolean' then 'false'
      when ty = 'date' then quote_literal(app.now()::date) || '::date'
      when ty like 'timestamp%' then quote_literal(app.now() + interval '1 day') || '::timestamptz'
      else 'null::' || ty end;
  end loop;
  return v_args;
end $$;
insert into test.pm_calls
select p.proname, st, p.oid, format('select public.%I(%s)', p.proname, test.pm_call_sql(p.oid, st))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['snowy', 'harbour']) st
 where n.nspname = 'public' and p.prosecdef and p.prokind = 'f' and p.provariadic = 0 and has_function_privilege('authenticated', p.oid, 'execute');
grant select on test.pm_calls to public;

create table test.pm_rpc_out (tag text, letter text, fn text, strict_ok boolean, loose_ok boolean, msg text);
create function test.pm_probe_rpcs(p_tag text, p_letter text, p_hdr text, p_studio text) returns void language plpgsql as $$
declare r record; v_msg text; v_state text; v_strict boolean; v_loose boolean;
begin
  for r in select fn, sql from test.pm_calls where studio = p_studio order by fn loop
    perform test.pm_as(p_letter, p_hdr);
    begin
      execute r.sql;
      raise exception using errcode = 'RB000', message = 'rolled back';
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_state := sqlstate;
    end;
    perform test.admin();
    v_loose := not (v_state = '42501' or v_msg ~ '^(NOT_ALLOWED|AUTH_REQUIRED)');
    v_strict := v_loose and v_msg !~ '^NOT_FOUND';
    insert into test.pm_rpc_out values (p_tag, p_letter, r.fn, v_strict, v_loose, left(v_state || ' ' || v_msg, 70));
  end loop;
end $$;

-- main: every role, Snowy's header
select test.pm_probe_rpcs('main', letter, 'snowy', 'snowy') from test.pm_role order by ord;
-- cross, Snowy's data: the other studio's people with no header
select test.pm_probe_rpcs('x_none', letter, 'none', 'snowy') from test.pm_role where letter in ('h','k');
select test.pm_probe_rpcs('x_none', letter, 'none', 'snowy') from test.pm_role where letter in ('A','a','b','j','g','f','m','o','p','z');
-- cross, Harbour's data with Harbour's header: Hank (Harbour's owner) is the control that shows the sample arguments reach the function's checks;
-- Snowy's anon, clients, staff, owner and the stranger make the same calls and must be refused wherever he gets in
select test.pm_probe_rpcs('x_harbour', letter, 'harbour', 'harbour') from test.pm_role where letter in ('h','k','A','a','b','j','g','f','m','o','p','z');

-- the roles that got past each function's permission checks (see the header for how that is decided)
create table test.pm_rpc_seen as
select tag, fn,
       test.pm_letters(case when tag = 'main' then coalesce(nullif(string_agg(letter, '') filter (where strict_ok), ''), string_agg(letter, '') filter (where loose_ok), '')
                            else coalesce(string_agg(letter, '') filter (where strict_ok), '') end) as roles
  from test.pm_rpc_out group by tag, fn;

-- ================================================================ 2. TABLES
-- One INSERT per table and studio (built as the admin: the roles can't read the catalogue rows it needs), then every role tries to read, insert, update
-- and delete that studio's generic row. Every attempt is rolled back.
create table test.pm_ins (tbl text, studio text, sql text, upd_col text, primary key (tbl, studio));
insert into test.pm_ins
select k.relname, st, case when k.relkind = 'r' then test.pm_row(k.oid::regclass::text, st, false) end,
       (select a.attname from pg_attribute a where a.attrelid = k.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
         and has_column_privilege('authenticated', k.oid, a.attnum, 'update') order by a.attnum limit 1)
  from pg_class k join pg_namespace n on n.oid = k.relnamespace, unnest(array['snowy','harbour']) st
 where n.nspname = 'public' and k.relkind in ('r','v') ;
grant select on test.pm_ins to public;
create function test.pm_filter(p_tbl text, p_studio text) returns text language sql stable security definer as $$
  select case when exists (select 1 from pg_attribute where attrelid = ('public.' || p_tbl)::regclass and attname = 'studio_id' and not attisdropped) then format('studio_id = %L', test.id(p_studio))
              when p_tbl = 'studios' then format('id = %L', test.id(p_studio)) else 'true' end
$$;
grant execute on function test.pm_filter(text, text) to public;

create table test.pm_t_out (tag text, letter text, tbl text, rd int, tot int, ins boolean, upd int, del int);
create function test.pm_denied(p_state text, p_msg text) returns boolean language sql immutable as $$
  select p_state = '42501' or p_msg ~ '^(NOT_ALLOWED|AUTH_REQUIRED)'
$$;
-- tag names the run; p_hdr is the studio header; p_target the studio whose generic row is aimed at
create function test.pm_probe_tables(p_tag text, p_letter text, p_hdr text, p_target text) returns void language plpgsql as $$
declare r record; v_rd int; v_tot int; v_ins boolean; v_upd int; v_del int; v_sql text; v_state text; v_msg text; v_filter text;
begin
  for r in select k.relname t, k.relkind from pg_class k join pg_namespace n on n.oid = k.relnamespace where n.nspname = 'public' and k.relkind in ('r','v') order by 1 loop
    select i.sql, i.upd_col into v_sql, v_msg from test.pm_ins i where i.tbl = r.t and i.studio = p_target;
    v_filter := test.pm_filter(r.t, p_target);
    execute format('select count(*) from public.%I where %s', r.t, v_filter) into v_tot;   -- everything there is (the admin sees all)
    perform test.pm_as(p_letter, p_hdr);
    begin execute format('select count(*) from public.%I where %s', r.t, v_filter) into v_rd;
    exception when others then v_rd := 0; end;
    v_ins := false; v_upd := 0; v_del := 0;
    if r.relkind = 'r' then
      begin
        execute v_sql;
        raise exception using errcode = 'RB000', message = 'rolled back';
      exception when others then
        get stacked diagnostics v_msg = message_text; v_state := sqlstate;
        v_ins := not test.pm_denied(v_state, v_msg);
      end;
      perform test.pm_as(p_letter, p_hdr);
      select i.upd_col into v_msg from test.pm_ins i where i.tbl = r.t and i.studio = p_target;
      if v_msg is not null then
        begin
          execute format('update public.%I set %I = %I where %s', r.t, v_msg, v_msg, v_filter);
          get diagnostics v_upd = row_count;
          raise exception using errcode = 'RB000', message = 'rolled back';
        exception when others then
          get stacked diagnostics v_msg = message_text; v_state := sqlstate;
          if v_state <> 'RB000' then v_upd := case when test.pm_denied(v_state, v_msg) then 0 else 1 end; end if;
        end;
      end if;
      perform test.pm_as(p_letter, p_hdr);
      begin
        execute format('delete from public.%I where %s', r.t, v_filter);
        get diagnostics v_del = row_count;
        raise exception using errcode = 'RB000', message = 'rolled back';
      exception when others then
        get stacked diagnostics v_msg = message_text; v_state := sqlstate;
        if v_state <> 'RB000' then v_del := case when test.pm_denied(v_state, v_msg) then 0 else 1 end; end if;
      end;
    end if;
    perform test.admin();
    insert into test.pm_t_out values (p_tag, p_letter, r.t, v_rd, v_tot, v_ins, v_upd, v_del);
  end loop;
end $$;

-- home: Snowy's people (and the stranger, for comparison) aiming at Snowy's rows with Snowy's header
select test.pm_probe_tables('home', letter, 'snowy', 'snowy') from test.pm_role where letter in ('A','a','b','j','g','f','m','o','p','z') order by ord;
-- cross: the other studio's people aiming at Snowy's rows (with Snowy's header, no header, their own header) and the stranger the same way
select test.pm_probe_tables('xs_' || hh.x, letter, hh.x, 'snowy') from test.pm_role, unnest(array['snowy','none','harbour']) as hh(x) where letter in ('h','k','z');
-- cross: Snowy's people and the stranger aiming at Harbour's rows (Harbour's header, no header, Snowy's header)
select test.pm_probe_tables('xh_' || hh.x, letter, hh.x, 'harbour') from test.pm_role, unnest(array['harbour','none','snowy']) as hh(x) where letter in ('A','a','b','j','g','f','m','o','p','z');

-- the observed pattern of each table: the roles that can read / insert / update / delete the Snowy row
create table test.pm_t_seen as
select tbl,
       test.pm_letters(string_agg(letter, '') filter (where rd > 0)) as r,
       test.pm_letters(string_agg(letter, '') filter (where rd > 0 and rd = tot)) as a,
       test.pm_letters(string_agg(letter, '') filter (where ins)) as i,
       test.pm_letters(string_agg(letter, '') filter (where upd > 0)) as u,
       test.pm_letters(string_agg(letter, '') filter (where del > 0)) as d
  from test.pm_t_out where tag = 'home' and letter <> 'z' group by tbl;

-- ================================================================ expected results (reviewed by hand; see the header for the letters)
-- Functions: the roles that get past each one's permission checks with the sample arguments.
--   S = service only (no client role may execute it), V = variadic helper (grants only). Everything else is a letter list.
--   Functions that read or change one client's data are judged with Bob's id: a (alice) not being listed there is the "someone else's client" rule.
create table test.pm_rpc_expect (fn text primary key, roles text not null);
insert into test.pm_rpc_expect values
  -- S: 57
  ('account_delete_apply','S'), ('appointments_attach_checkout','S'), ('appointments_claim_outbox','S'), ('appointments_complete_order','S'),
  ('appointments_expire_order','S'), ('appointments_finish_outbox','S'), ('appointments_queue_reminders','S'), ('appointments_release_holds','S'),
  ('appointments_waitlist_sweep','S'), ('billing_apply','S'), ('billing_save_customer','S'), ('claim_notifications','S'),
  ('commerce_activate_gift_card','S'), ('commerce_claim_outbox','S'), ('commerce_finish_outbox','S'), ('commerce_send_due','S'),
  ('create_pass_from_purchase','S'), ('end_membership_subscription','S'), ('finish_notification','S'), ('housekeeping','S'),
  ('integrations_partner_book','S'), ('integrations_partner_cancel','S'), ('integrations_require','S'), ('kiosk_require','S'), ('marketing_claim','S'),
  ('marketing_finish','S'), ('marketing_prune','S'), ('marketing_tick','S'), ('marketing_track','S'), ('ondemand_client_has_access','S'),
  ('ondemand_require_manage','S'), ('payroll_approve_now','S'), ('payroll_assert_open','S'), ('payroll_claim_outbox','S'), ('payroll_clash','S'),
  ('payroll_clocks_in','S'), ('payroll_cover_json','S'), ('payroll_eligible','S'), ('payroll_finish_outbox','S'), ('payroll_me','S'),
  ('payroll_need_live','S'), ('payroll_notify','S'), ('payroll_require','S'), ('payroll_sdate','S'), ('payroll_settings_json','S'),
  ('prune_notifications','S'), ('queue_class_reminders','S'), ('record_membership_payment','S'), ('record_stripe_refund','S'), ('reviews_require','S'),
  ('stripe_connect_save','S'), ('studio_has_feature','S'), ('studio_read_only','S'), ('support_alert_claim_outbox','S'),
  ('support_alert_finish_outbox','S'), ('terminal_mark','S'), ('terminal_record_sale','S'),
  -- fmo: 46
  ('adjust_pass','fmo'), ('appointments_book','fmo'), ('appointments_buy_pack','fmo'), ('appointments_cancel','fmo'),
  ('appointments_cancel_registration','fmo'), ('appointments_leave_waitlist','fmo'), ('appointments_list_registrations','fmo'),
  ('appointments_list_waitlist','fmo'), ('appointments_mark_refunded','fmo'), ('appointments_set_attendance','fmo'), ('appointments_set_status','fmo'),
  ('cancel_session','fmo'), ('commerce_adjust_stock','fmo'), ('commerce_get_gift_card','fmo'), ('commerce_list_gift_cards','fmo'),
  ('commerce_list_promos','fmo'), ('commerce_list_retail','fmo'), ('commerce_promo_redemptions','fmo'), ('commerce_referral_stats','fmo'),
  ('commerce_stock_log','fmo'), ('commerce_stock_report','fmo'), ('commerce_update_retail','fmo'), ('delete_template','fmo'),
  ('generate_sessions','fmo'), ('kiosk_check_pin','fmo'), ('kiosk_has_pin','fmo'), ('marketing_get_campaign','fmo'),
  ('marketing_get_client_tags','fmo'), ('marketing_get_settings','fmo'), ('marketing_get_thread','fmo'), ('marketing_inbox_unread','fmo'),
  ('marketing_list_automations','fmo'), ('marketing_list_campaigns','fmo'), ('marketing_list_segments','fmo'), ('marketing_list_tags','fmo'),
  ('marketing_list_threads','fmo'), ('marketing_mark_thread_read','fmo'), ('marketing_message_log','fmo'), ('marketing_preview_audience','fmo'),
  ('marketing_send_staff_message','fmo'), ('marketing_send_text','fmo'), ('move_booking','fmo'), ('refresh_template_sessions','fmo'),
  ('refund_sale','fmo'), ('restore_session','fmo'), ('void_sale','fmo'),
  -- mo: 43
  ('appointments_cancel_event','mo'), ('appointments_remove_time_off','mo'), ('appointments_update_settings','mo'), ('appointments_upsert_event','mo'),
  ('appointments_upsert_pack','mo'), ('appointments_upsert_type','mo'), ('change_membership','mo'), ('commerce_adjust_gift_card','mo'),
  ('commerce_update_settings','mo'), ('commerce_upsert_promo','mo'), ('commerce_void_gift_card','mo'), ('edit_membership_date','mo'),
  ('integrations_list_partners','mo'), ('integrations_save_accounting','mo'), ('integrations_set_reserved','mo'), ('kiosk_set_pin','mo'),
  ('list_email_templates','mo'), ('marketing_delete_campaign','mo'), ('marketing_delete_segment','mo'), ('marketing_run_automations','mo'),
  ('marketing_save_automation','mo'), ('marketing_save_campaign','mo'), ('marketing_save_segment','mo'), ('marketing_schedule_campaign','mo'),
  ('marketing_send_campaign','mo'), ('marketing_set_client_tags','mo'), ('marketing_unschedule_campaign','mo'), ('marketing_update_settings','mo'),
  ('ondemand_admin_list','mo'), ('ondemand_delete_video','mo'), ('ondemand_reorder','mo'), ('ondemand_save_products','mo'),
  ('ondemand_save_video','mo'), ('ondemand_set_published','mo'), ('payroll_cancel_cover','mo'), ('payroll_decide_cover','mo'),
  ('payroll_delete_timesheet','mo'), ('payroll_period_inputs','mo'), ('reviews_save_settings','mo'), ('save_email_template','mo'),
  ('send_test_email','mo'), ('support_follow','mo'), ('update_my_studio','mo'),
  -- jgfmo: 20
  ('checkout_cart','jgfmo'), ('commerce_find_retail','jgfmo'), ('commerce_hold_codes','jgfmo'), ('commerce_quote','jgfmo'),
  ('commerce_resend_gift_card','jgfmo'), ('commerce_sell_gift_card','jgfmo'), ('commerce_settle_hold','jgfmo'), ('list_class_interest','jgfmo'),
  ('marketing_inbox_access','jgfmo'), ('payroll_clock_out','jgfmo'), ('payroll_clock_status','jgfmo'), ('payroll_cover_for_session','jgfmo'),
  ('payroll_get_settings','jgfmo'), ('payroll_list_cover','jgfmo'), ('payroll_save_timesheet','jgfmo'), ('payroll_update_settings','jgfmo'),
  ('payroll_withdraw_claim','jgfmo'), ('report','jgfmo'), ('support_send','jgfmo'), ('terminal_quote','jgfmo'),
  -- abjgfmophkz: 11
  ('client_health','abjgfmophkz'), ('ensure_sessions','abjgfmophkz'), ('join_studio','abjgfmophkz'), ('marketing_my_unread','abjgfmophkz'),
  ('marketing_push_status','abjgfmophkz'), ('marketing_unregister_push','abjgfmophkz'), ('my_studios','abjgfmophkz'),
  ('remove_dependant','abjgfmophkz'), ('reviews_pending','abjgfmophkz'), ('session_spots','abjgfmophkz'), ('whoami','abjgfmophkz'),
  -- p: 11
  ('platform_create_studio','p'), ('platform_invite_owner','p'), ('platform_save_billing_settings','p'), ('platform_save_plan','p'),
  ('platform_set_studio_plan','p'), ('platform_set_studio_status','p'), ('platform_studio_stats','p'), ('platform_update_studio','p'),
  ('support_admin_reply','p'), ('support_admin_set_banner','p'), ('support_admin_set_status','p'),
  -- ab: 10
  ('appointments_hold_order','ab'), ('commerce_buy_gift_card','ab'), ('commerce_claim_referral','ab'), ('commerce_my_gift_cards','ab'),
  ('commerce_my_referral','ab'), ('commerce_purchase_with_codes','ab'), ('marketing_mark_my_thread_read','ab'), ('marketing_my_thread','ab'),
  ('marketing_send_my_message','ab'), ('reviews_submit','ab'),
  -- o: 10
  ('integrations_save_partner','o'), ('my_billing','o'), ('my_stripe_status','o'), ('payroll_add_adjustment','o'), ('payroll_delete_rule','o'),
  ('payroll_mark_paid','o'), ('payroll_remove_adjustment','o'), ('payroll_reopen','o'), ('payroll_review_timesheets','o'), ('payroll_save_rule','o'),
  -- abjgfmo: 9
  ('appointments_get_event','abjgfmo'), ('appointments_list','abjgfmo'), ('appointments_list_credits','abjgfmo'),
  ('appointments_list_events','abjgfmo'), ('appointments_list_slots','abjgfmo'), ('appointments_list_types','abjgfmo'),
  ('commerce_get_settings','abjgfmo'), ('commerce_lookup_gift_card','abjgfmo'), ('marketing_register_push','abjgfmo'),
  -- jfmo: 8
  ('check_in','jfmo'), ('get_roster','jfmo'), ('mark_no_show','jfmo'), ('mark_rest_no_show','jfmo'), ('undo_cancel_booking','jfmo'),
  ('undo_check_in','jfmo'), ('undo_no_show','jfmo'), ('waive_penalty','jfmo'),
  -- bfmo: 7
  ('appointments_join_waitlist','bfmo'), ('appointments_register','bfmo'), ('cancel_membership','bfmo'), ('pause_pass','bfmo'),
  ('register_interest','bfmo'), ('resume_pass','bfmo'), ('save_dependant','bfmo'),
  -- b: 5
  ('book_attendees','b'), ('book_class','b'), ('cancel_booking','b'), ('choose_spot','b'), ('reviews_dismiss','b'),
  -- bjgfmo: 5
  ('credit_summary','bjgfmo'), ('is_intro_eligible','bjgfmo'), ('list_client_bookings','bjgfmo'), ('submit_health_check','bjgfmo'),
  ('submit_waiver','bjgfmo'),
  -- Aabjgfmophkz: 4
  ('current_client_id','Aabjgfmophkz'), ('current_staff_id','Aabjgfmophkz'), ('is_staff','Aabjgfmophkz'), ('staff_role','Aabjgfmophkz'),
  -- jmo: 4
  ('appointments_add_time_off','jmo'), ('appointments_set_availability','jmo'), ('payroll_list_timesheets','jmo'), ('payroll_request_cover','jmo'),
  -- abmo: 2
  ('ondemand_list_videos','abmo'), ('ondemand_record_view','abmo'),
  -- V: 1
  ('has_role','V'),
  -- abfmo: 1
  ('appointments_move','abfmo'),
  -- bjfmo: 1
  ('leave_waitlist','bjfmo'),
  -- bo: 1
  ('account_deletion_plan','bo'),
  -- f: 1
  ('payroll_clock_in','f'),
  -- jgo: 1
  ('payroll_claim_cover','jgo');

-- Tables: the roles that can read ANY row / read ALL rows / insert / update / delete the studio's generic row.
create table test.pm_table_expect (tbl text primary key, r text not null, a text not null, i text not null, u text not null, d text not null);
insert into test.pm_table_expect values
  -- front desk and above read, RPCs write   [read any: fmo | read all: fmo | insert: - | update: - | delete: -]
  ('appointments','fmo','fmo','','',''), ('commerce_gift_cards','fmo','fmo','','',''), ('commerce_gift_entries','fmo','fmo','','',''),
  ('commerce_promos','fmo','fmo','','',''), ('commerce_redemptions','fmo','fmo','','',''), ('commerce_referrals','fmo','fmo','','',''),
  ('commerce_retail','fmo','fmo','','',''), ('commerce_stock_log','fmo','fmo','','',''), ('marketing_automations','fmo','fmo','','',''),
  ('marketing_campaigns','fmo','fmo','','',''), ('marketing_client_tags','fmo','fmo','','',''), ('marketing_messages','fmo','fmo','','',''),
  ('marketing_segments','fmo','fmo','','',''), ('marketing_settings','fmo','fmo','','',''), ('marketing_thread_messages','fmo','fmo','','',''),
  ('marketing_threads','fmo','fmo','','',''), ('studio_event_registrations','fmo','fmo','','',''), ('studio_event_waitlist','fmo','fmo','','',''),
  -- no client role reads or writes directly (service role and RPCs only)   [read any: - | read all: - | insert: - | update: - | delete: -]
  ('appointment_orders','','','','',''), ('commerce_ref_codes','','','','',''), ('integrations_partner_clients','','','','',''), ('integrations_secrets','','','','',''),
  ('kiosk_settings','','','','',''), ('notifications','','','','',''), ('ondemand_views','','','','',''), ('push_tokens','','','','',''),
  ('reviews_skips','','','','',''), ('stripe_customers','','','','',''), ('stripe_events','','','','',''), ('studio_terminal','','','','',''),
  ('support_alert_outbox','','','','',''), ('support_assist_log','','','','',''), ('terminal_payments','','','','',''), ('terminal_readers','','','','',''),
  -- owner/manager read, RPCs write   [read any: mo | read all: mo | insert: - | update: - | delete: -]
  ('appointments_outbox','mo','mo','','',''), ('audit_log','mo','mo','','',''), ('email_templates','mo','mo','','',''), ('integrations_accounting','mo','mo','','',''),
  ('integrations_partners','mo','mo','','',''), ('marketing_push_devices','mo','mo','','',''), ('ondemand_products','mo','mo','','',''),
  ('ondemand_videos','mo','mo','','',''), ('payroll_adjustments','mo','mo','','',''), ('payroll_pay_rules','mo','mo','','',''), ('payroll_runs','mo','mo','','',''),
  ('payroll_timesheets','mo','mo','','',''), ('reviews_entries','mo','mo','','',''),
  -- public read, RPCs write   [read any: Aabjgfmop | read all: Aabjgfmop | insert: - | update: - | delete: -]
  ('plans','Aabjgfmop','Aabjgfmop','','',''), ('platform_billing_settings','Aabjgfmop','Aabjgfmop','','',''), ('sessions_with_counts','Aabjgfmop','Aabjgfmop','','',''),
  ('staff_public','Aabjgfmop','Aabjgfmop','','',''), ('studios','Aabjgfmop','Aabjgfmop','','',''), ('support_status','Aabjgfmop','Aabjgfmop','','',''),
  -- everyone in the studio reads, owner/manager write (catalogue)   [read any: abjgfmo | read all: abjgfmo | insert: mo | update: mo | delete: mo]
  ('appointment_packs','abjgfmo','abjgfmo','mo','mo','mo'), ('appointment_settings','abjgfmo','abjgfmo','mo','mo','mo'),
  ('appointment_type_staff','abjgfmo','abjgfmo','mo','mo','mo'), ('appointment_types','abjgfmo','abjgfmo','mo','mo','mo'),
  ('studio_event_sessions','abjgfmo','abjgfmo','mo','mo','mo'), ('studio_events','abjgfmo','abjgfmo','mo','mo','mo'),
  -- all staff read, nobody writes directly (RPCs only)   [read any: jgfmo | read all: jgfmo | insert: - | update: - | delete: -]
  ('appointment_credits','jgfmo','jgfmo','','',''), ('integrations_partner_bookings','jgfmo','jgfmo','','',''), ('integrations_reserved','jgfmo','jgfmo','','',''),
  ('payroll_cover_requests','jgfmo','jgfmo','','',''), ('payroll_settings','jgfmo','jgfmo','','',''), ('reviews_settings','jgfmo','jgfmo','','',''),
  -- owner only   [read any: o | read all: o | insert: - | update: - | delete: -]
  ('commerce_outbox','o','o','','',''), ('payroll_outbox','o','o','','',''), ('studio_billing','o','o','','',''), ('studio_stripe','o','o','','',''),
  -- public read, owner/manager add and change   [read any: Aabjgfmop | read all: Aabjgfmop | insert: mo | update: mo | delete: -]
  ('locations','Aabjgfmop','Aabjgfmop','mo','mo',''), ('rooms','Aabjgfmop','Aabjgfmop','mo','mo',''),
  -- a client sees their own, front desk and above see all   [read any: abfmo | read all: fmo | insert: - | update: - | delete: -]
  ('sale_items','abfmo','fmo','','',''), ('sales','abfmo','fmo','','',''),
  -- staff read, owner/manager write   [read any: jgfmo | read all: jgfmo | insert: mo | update: mo | delete: mo]
  ('appointment_availability','jgfmo','jgfmo','mo','mo','mo'), ('appointment_time_off','jgfmo','jgfmo','mo','mo','mo'),
  -- public read, owner/manager change   [read any: Aabjgfmop | read all: Aabjgfmop | insert: - | update: mo | delete: -]
  ('studio_settings','Aabjgfmop','Aabjgfmop','','mo',''),
  -- public read, front desk and above add and change   [read any: Aabjgfmop | read all: Aabjgfmop | insert: fmo | update: fmo | delete: -]
  ('class_sessions','Aabjgfmop','Aabjgfmop','fmo','fmo',''),
  -- public read, front desk and above write   [read any: Aabjgfmop | read all: Aabjgfmop | insert: fmo | update: fmo | delete: fmo]
  ('class_types','Aabjgfmop','Aabjgfmop','fmo','fmo','fmo'),
  -- public read, owner/manager write   [read any: Aabjgfmop | read all: Aabjgfmop | insert: mo | update: mo | delete: mo]
  ('products','Aabjgfmop','Aabjgfmop','mo','mo','mo'),
  -- everyone in the studio reads, RPCs write   [read any: abjgfmo | read all: abjgfmo | insert: - | update: - | delete: -]
  ('commerce_settings','abjgfmo','abjgfmo','','',''),
  -- a client sees their own, staff see all   [read any: abjgfmo | read all: jgfmo | insert: - | update: - | delete: -]
  ('passes','abjgfmo','jgfmo','','',''),
  -- signed-in people see only themselves (staff see all); a client can edit their own row   [read any: abjgfmo | read all: jgfmo | insert: fmo | update: abfmo | delete: -]
  ('clients','abjgfmo','jgfmo','fmo','abfmo',''),
  -- pass adjustments (the generic row points at Alice's pass: she and staff see it)   [read any: ajgfmo | read all: ajgfmo | insert: - | update: - | delete: -]
  ('pass_adjustments','ajgfmo','ajgfmo','','',''),
  -- a client sees their own; the class instructor and front desk and above see the studio's   [read any: bjfmo | read all: jfmo | insert: - | update: - | delete: -]
  ('bookings','bjfmo','jfmo','','',''),
  -- front desk and above read and write   [read any: fmo | read all: fmo | insert: fmo | update: fmo | delete: fmo]
  ('client_notes','fmo','fmo','fmo','fmo','fmo'),
  -- staff read, front desk and above add and remove   [read any: jgfmo | read all: jgfmo | insert: fmo | update: - | delete: fmo]
  ('class_interest','jgfmo','jgfmo','fmo','','fmo'),
  -- staff read, front desk and above write   [read any: jgfmo | read all: jgfmo | insert: fmo | update: fmo | delete: fmo]
  ('schedule_templates','jgfmo','jgfmo','fmo','fmo','fmo'),
  -- staff read, owner/manager add, owner changes and removes   [read any: jgfmo | read all: jgfmo | insert: mo | update: o | delete: o]
  ('staff','jgfmo','jgfmo','mo','o','o'),
  -- owner/manager read, owner writes   [read any: mo | read all: mo | insert: o | update: o | delete: o]
  ('staff_pay','mo','mo','o','o','o'),
  -- studio owner/manager and platform admin read; the platform admin adds and changes   [read any: mop | read all: mop | insert: p | update: p | delete: -]
  ('support_requests','mop','mop','p','p',''),
  -- platform admin only   [read any: p | read all: p | insert: - | update: - | delete: -]
  ('platform_admins','p','p','','',''),
  -- platform admin only (reads, adds, changes)   [read any: p | read all: p | insert: p | update: p | delete: -]
  ('support_messages','p','p','p','p','');

-- ================================================================ results
\if :{?pm_dump}
\o
\echo -- observed functions (roles per function, one line per group)
select roles, count(*), string_agg(fn, ' ' order by fn) from test.pm_rpc_seen where tag = 'main' group by 1 order by 2 desc;
\echo -- observed tables
select r, a, i, u, d, count(*), string_agg(tbl, ' ' order by tbl) from test.pm_t_seen group by 1,2,3,4,5 order by 6 desc;
\else
create function test.pm_fail(p_what text, p_items text[]) returns void language plpgsql as $$
begin
  if cardinality(p_items) > 0 then raise exception 'PERMISSIONS MATRIX: % (%): %', p_what, cardinality(p_items), array_to_string(p_items[1:12], ' | ') || case when cardinality(p_items) > 12 then ' | ...' else '' end; end if;
  raise notice 'ok - %', p_what;
end $$;

-- ---------------------------------------------------------------- functions: nothing unclassified, grants as expected
select test.pm_fail('every public function is classified (add new RPCs to test.pm_rpc_expect)', coalesce((
  select array_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and not exists (select 1 from test.pm_rpc_expect e where e.fn = p.proname)), '{}'));
select test.pm_fail('no classified function has been removed (clean up test.pm_rpc_expect)', coalesce((
  select array_agg(e.fn order by e.fn) from test.pm_rpc_expect e
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = e.fn)), '{}'));
select test.pm_fail('every public function is security definer (a plain one would run with the caller''s rights and escape this matrix)', coalesce((
  select array_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and not p.prosecdef and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')), '{}'));
select test.pm_fail('anon can execute only the identity helpers', coalesce((
  select array_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
     and p.proname not in ('current_client_id', 'current_staff_id', 'has_role', 'is_intro_eligible', 'is_staff', 'staff_role')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')), '{}'));
select test.pm_fail('service-only functions can''t be executed by anon or signed-in users, but can by the service role', coalesce((
  select array_agg(p.proname order by p.proname) from pg_proc p join test.pm_rpc_expect e on e.fn = p.proname join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where e.roles = 'S' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or not has_function_privilege('service_role', p.oid, 'execute'))), '{}'));
select test.pm_fail('every other function can be executed by signed-in users (what they may do is decided inside)', coalesce((
  select array_agg(p.proname order by p.proname) from pg_proc p join test.pm_rpc_expect e on e.fn = p.proname join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where e.roles <> 'S' and not has_function_privilege('authenticated', p.oid, 'execute')), '{}'));

-- ---------------------------------------------------------------- functions: each role gets exactly what it should
select test.pm_fail('RPC x role matrix: ' || (select count(*) from test.pm_calls where studio = 'snowy') || ' functions x 12 roles as expected', coalesce((
  select array_agg(s.fn || ' expected [' || e.roles || '] got [' || s.roles || ']' order by s.fn)
    from test.pm_rpc_seen s join test.pm_rpc_expect e on e.fn = s.fn where s.tag = 'main' and s.roles <> e.roles), '{}'));

-- other studio's people and the stranger never get in, whatever header they send (only identity helpers, which aren't about a studio, are open to them)
select test.pm_fail('cross-studio RPCs: the other studio''s client and owner are refused everywhere in Snowy (header Snowy and no header)', coalesce((
  select array_agg(s.tag || ' ' || s.fn || ' let in [' || regexp_replace(s.roles, '[^hk]', '', 'g') || ']' order by s.fn)
    from test.pm_rpc_seen s join test.pm_rpc_expect e on e.fn = s.fn
   where s.tag = 'x_none' and regexp_replace(s.roles, '[^hk]', '', 'g') <> '' and e.roles !~ '[hk]'), '{}'))
  where (select count(*) from test.pm_rpc_seen where tag = 'x_none') > 0;
select test.pm_fail('cross-studio RPCs: with Harbour''s header, Snowy''s staff, clients and anon are refused wherever Harbour''s owner gets in (checked on ' ||
  (select count(*) from test.pm_rpc_seen where tag = 'x_harbour' and roles ~ 'k') || ' functions)', coalesce((
  select array_agg(s.fn || ' let in [' || regexp_replace(s.roles, '[hk]', '', 'g') || ']' order by s.fn)
    from test.pm_rpc_seen s join test.pm_rpc_expect e on e.fn = s.fn
   where s.tag = 'x_harbour' and s.roles ~ 'k' and e.roles !~ 'z'
     and regexp_replace(s.roles, '[hk]', '', 'g') <> regexp_replace(e.roles, '[^p]', '', 'g')), '{}'));
select test.pm_fail('cross-studio RPCs: with no header, nobody gets in anywhere they wouldn''t with Snowy''s header', coalesce((
  select array_agg(s.fn || ' [' || s.roles || '] vs [' || e.roles || ']' order by s.fn)
    from test.pm_rpc_seen s join test.pm_rpc_expect e on e.fn = s.fn
   where s.tag = 'x_none' and exists (select 1 from unnest(string_to_array(regexp_replace(s.roles, '(.)', '\1,', 'g'), ',')) l where l <> '' and position(l in e.roles) = 0)), '{}'));

-- ---------------------------------------------------------------- tables
select test.pm_fail('every table and view in public is classified (add new ones to test.pm_table_expect)', coalesce((
  select array_agg(k.relname order by k.relname) from pg_class k join pg_namespace n on n.oid = k.relnamespace
   where n.nspname = 'public' and k.relkind in ('r','v','m','p') and not exists (select 1 from test.pm_table_expect e where e.tbl = k.relname)), '{}'));
select test.pm_fail('no classified table has been removed (clean up test.pm_table_expect)', coalesce((
  select array_agg(e.tbl order by e.tbl) from test.pm_table_expect e where not exists (select 1 from pg_class k join pg_namespace n on n.oid = k.relnamespace and n.nspname = 'public' where k.relname = e.tbl)), '{}'));
select test.pm_fail('row level security is on for every table', coalesce((
  select array_agg(k.relname order by k.relname) from pg_class k join pg_namespace n on n.oid = k.relnamespace
   where n.nspname = 'public' and k.relkind in ('r','p') and not k.relrowsecurity), '{}'));
select test.pm_fail('every table with a studio_id has the restrictive studio_scope policy that keeps a request inside its studio (or is closed to clients altogether: no policies, no grants)', coalesce((
  select array_agg(k.relname order by k.relname) from pg_class k join pg_namespace n on n.oid = k.relnamespace
   where n.nspname = 'public' and k.relkind = 'r' and exists (select 1 from pg_attribute a where a.attrelid = k.oid and a.attname = 'studio_id' and not a.attisdropped)
     and not exists (select 1 from pg_policy po where po.polrelid = k.oid and po.polname = 'studio_scope' and not po.polpermissive)
     and (exists (select 1 from pg_policy po where po.polrelid = k.oid) or has_table_privilege('anon', k.oid, 'select, insert, update, delete') or has_table_privilege('authenticated', k.oid, 'select, insert, update, delete')
          or has_any_column_privilege('anon', k.oid, 'select, insert, update') or has_any_column_privilege('authenticated', k.oid, 'select, insert, update'))), '{}'));
select test.pm_fail('no policy hands a table to anon except the public catalogue tables', coalesce((
  select array_agg(k.relname || '.' || po.polname order by k.relname) from pg_policy po join pg_class k on k.oid = po.polrelid join pg_namespace n on n.oid = k.relnamespace
   where n.nspname = 'public' and po.polpermissive and po.polcmd = 'r' and (po.polroles = '{0}' or exists (select 1 from unnest(po.polroles) r where r = 'anon'::regrole::oid))
     and k.relname not in (select tbl from test.pm_table_expect where r ~ 'A')), '{}'));
select test.pm_fail('every table has a row in each studio to test with (' || (select count(*) from test.pm_seeded) || ' checked)', coalesce((
  select array_agg(tbl || '/' || studio order by tbl) from test.pm_seeded where rows_n = 0), '{}'));
select test.pm_fail('table x role matrix: ' || (select count(*) from test.pm_table_expect) || ' tables x 9 roles x read, read-all, insert, update, delete as expected', coalesce((
  select array_agg(s.tbl || ' expected [' || e.r || '|' || e.a || '|' || e.i || '|' || e.u || '|' || e.d || '] got [' || s.r || '|' || s.a || '|' || s.i || '|' || s.u || '|' || s.d || ']' order by s.tbl)
    from test.pm_t_seen s join test.pm_table_expect e on e.tbl = s.tbl
   where (s.r, s.a, s.i, s.u, s.d) is distinct from (e.r, e.a, e.i, e.u, e.d)), '{}'));
-- Another studio's people see, add, change and delete exactly what a signed-in stranger can. That is nothing of the studio's private data.
-- (The platform admin is the one deliberate exception, on the studios list and support requests.)
select test.pm_fail('cross-studio tables: Harbour''s client and owner see and change nothing of Snowy''s beyond a stranger (3 header variants)', coalesce((
  select array_agg(x.tag || ' ' || x.letter || ' ' || x.tbl || ' (sees ' || x.rd || ' vs stranger ' || z.rd || ', insert ' || x.ins || ', update ' || x.upd || ', delete ' || x.del || ')' order by x.tbl)
    from test.pm_t_out x join test.pm_t_out z on z.tag = x.tag and z.tbl = x.tbl and z.letter = 'z'
   where x.tag like 'xs\_%' and x.letter in ('h','k') and (x.rd <> z.rd or (x.ins and not z.ins) or x.upd > 0 or x.del > 0)), '{}'));
select test.pm_fail('cross-studio tables: Snowy''s anon, clients, instructors, front desk, manager and owner see and change nothing of Harbour''s beyond a stranger (3 header variants)', coalesce((
  select array_agg(x.tag || ' ' || x.letter || ' ' || x.tbl || ' (sees ' || x.rd || ' vs stranger ' || z.rd || ', insert ' || x.ins || ', update ' || x.upd || ', delete ' || x.del || ')' order by x.tbl)
    from test.pm_t_out x join test.pm_t_out z on z.tag = x.tag and z.tbl = x.tbl and z.letter = 'z'
   where x.tag like 'xh\_%' and x.letter in ('A','a','b','j','g','f','m','o') and (x.rd <> z.rd or (x.ins and not z.ins) or x.upd > 0 or x.del > 0)), '{}'));
select test.pm_fail('cross-studio tables: the platform admin reaches other studios'' rows only on the studios list, support requests and the admin list itself', coalesce((
  select array_agg(x.tag || ' ' || x.tbl order by x.tbl)
    from test.pm_t_out x join test.pm_t_out z on z.tag = x.tag and z.tbl = x.tbl and z.letter = 'z'
   where x.tag like 'xh\_%' and x.letter = 'p' and x.tbl not in ('studios', 'support_requests', 'support_messages', 'platform_admins')
     and (x.rd <> z.rd or (x.ins and not z.ins) or x.upd > 0 or x.del > 0)), '{}'));

-- ================================================================ 3. HEALTH NOTES
-- Who can see Bob's notes (he is booked into Julia's class) under each of the three settings, through each way out:
--   fn      public.client_health        roster  the roster of Julia's class        columns  select injuries / health_form straight from clients
-- Nobody, not even the owner, can read the raw columns: the app roles only get them through the two functions, which apply the setting.
select test.pm_fail('only the known code returns health notes (a new function that mentions them must be added here after review)', coalesce((
  select array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosrc ~* 'injuries|health_form|health_update'
     and (n.nspname || '.' || p.proname) not in ('app.account_delete_apply_core', 'app.get_roster_impl', 'app.get_roster_raw', 'app.guard_client', 'app.submit_waiver_impl',
                                                'public.client_health', 'public.platform_create_studio', 'public.save_dependant', 'public.submit_health_check')), '{}'));
select test.pm_fail('no view shows health notes', coalesce((
  select array_agg(viewname order by viewname) from pg_views where schemaname = 'public' and definition ~* 'injuries|health_form|health_update'), '{}'));
select test.eq((select column_default from information_schema.columns where table_name = 'studio_settings' and column_name = 'health_notes_visibility'), '''class_instructor''::text', 'the default is owner, managers and the class instructor');

create table test.pm_h_out (setting text, hdr text, letter text, via_fn boolean, via_roster boolean, via_cols boolean);
create function test.pm_probe_health(p_setting text, p_letter text, p_hdr text) returns void language plpgsql as $$
declare v_fn boolean := false; v_roster boolean := false; v_cols boolean := false; v_bob text := test.id('bob_client')::text;
begin
  perform test.pm_as(p_letter, p_hdr);
  begin v_fn := jsonb_array_length(public.client_health(array[v_bob::uuid])) > 0; exception when others then v_fn := false; end;
  begin
    select coalesce(bool_or((e -> 'client') ? 'injuries'), false) into v_roster from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e where e ->> 'client_id' = v_bob;
  exception when others then v_roster := false; end;
  begin perform injuries from public.clients limit 1; perform health_form from public.clients limit 1; v_cols := true; exception when others then v_cols := false; end;
  perform test.admin();
  insert into test.pm_h_out values (p_setting, p_hdr, p_letter, v_fn, v_roster, v_cols);
end $$;
do $$ declare s text; begin
  foreach s in array array['class_instructor', 'owner_manager', 'all_staff'] loop
    update public.studio_settings set health_notes_visibility = s where studio_id = test.id('snowy');
    perform test.pm_probe_health(s, letter, 'snowy') from test.pm_role order by ord;
    perform test.pm_probe_health(s, letter, hh.x) from test.pm_role, unnest(array['none', 'harbour']) as hh(x) where letter in ('h', 'k');
  end loop;
end $$;
create temp table pm_h_seen on commit drop as
select setting, hdr,
       test.pm_letters(string_agg(letter, '') filter (where via_fn)) as fn, test.pm_letters(string_agg(letter, '') filter (where via_roster)) as roster,
       test.pm_letters(string_agg(letter, '') filter (where via_cols)) as cols
  from test.pm_h_out group by setting, hdr;
select test.pm_fail('health notes, default (owner, managers, that class''s instructor): client_health and the roster agree', coalesce((
  select array_agg(setting || '/' || hdr || ' fn [' || fn || '] roster [' || roster || ']') from pm_h_seen
   where setting = 'class_instructor' and hdr = 'snowy' and (fn, roster) is distinct from ('bjmo', 'jmo')), '{}'));
select test.pm_fail('health notes, owner and managers only', coalesce((
  select array_agg(setting || '/' || hdr || ' fn [' || fn || '] roster [' || roster || ']') from pm_h_seen
   where setting = 'owner_manager' and hdr = 'snowy' and (fn, roster) is distinct from ('bmo', 'mo')), '{}'));
select test.pm_fail('health notes, all staff (not other studios'' staff, other clients or the platform admin)', coalesce((
  select array_agg(setting || '/' || hdr || ' fn [' || fn || '] roster [' || roster || ']') from pm_h_seen
   where setting = 'all_staff' and hdr = 'snowy' and (fn, roster) is distinct from ('bjgfmo', 'jfmo')), '{}'));
select test.pm_fail('health notes: the other studio''s client and owner never see them, under any setting or header', coalesce((
  select array_agg(setting || '/' || hdr || ' fn [' || fn || '] roster [' || roster || ']') from pm_h_seen
   where fn ~ '[hk]' or roster ~ '[hk]'), '{}'));
select test.pm_fail('health notes: the raw columns are closed to every role', coalesce((select array_agg(setting || '/' || hdr || ' [' || cols || ']') from pm_h_seen where cols <> ''), '{}'));
\endif

rollback;
