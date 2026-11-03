-- Database security audit. Read-only: lists anything that breaks the platform's rules.
--   psql "$DATABASE_URL" -X -f supabase/audit/security_audit.sql        (against the real project, as the postgres role)
--   bash supabase/tests/run.sh                                          (security_review.sql runs it and fails on any FAIL row)
-- Each row is FAIL (fix it) or INFO (look at it). An empty FAIL list is the goal.
--
--   rls_off            a public table without row level security
--   no_studio_scope    a public table without the restrictive studio_scope policy (app.scope_table), unless it is on the short
--                      "platform level or deny-all" list below
--   definer_no_path    a SECURITY DEFINER function without a fixed search_path (public/app/storage schemas)
--   anon_definer       a public SECURITY DEFINER function a signed-out caller can run, unless on the short allow list below
--   anon_write_policy  a policy that lets the anon role write (insert/update/delete)
--   view_writable      a view that anon or authenticated can write to (views skip RLS)
--   secret_column      a table holding secrets (PIN hashes, partner keys) with any grant to anon/authenticated
--   no_with_check      an INSERT/UPDATE/ALL policy for authenticated/anon with a USING clause but no WITH CHECK (updates could move rows)
--   app_schema_anon    (INFO) functions in the app schema a signed-out caller can run. Fine while `app` is not an exposed API schema.
create or replace function pg_temp.sec_audit() returns table (severity text, chk text, object text, detail text)
language sql stable as $f$
  -- tables
  select 'FAIL', 'rls_off', c.relname::text, 'row level security is off'
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relrowsecurity
  union all
  select 'FAIL', 'no_studio_scope', c.relname::text, 'no restrictive studio_scope policy'
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'studio_scope')
     and c.relname not in ('notifications','plans','platform_admins','platform_billing_settings','push_tokens','stripe_customers','stripe_events',
                           'studios','support_alert_outbox','support_assist_log','support_status')
  union all
  -- functions
  select 'FAIL', 'definer_no_path', p.oid::regprocedure::text, 'SECURITY DEFINER without search_path'
    from pg_proc p where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace) and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'FAIL', 'anon_definer', p.oid::regprocedure::text, 'a signed-out caller can run this SECURITY DEFINER function'
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('anon', p.oid, 'execute')
     and p.proname not in ('current_client_id','current_staff_id','has_role','is_intro_eligible','is_staff','staff_role')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'INFO', 'app_schema_anon', p.oid::regprocedure::text, 'signed-out callers can run this (keep the app schema out of the exposed API schemas)'
    from pg_proc p where p.pronamespace = 'app'::regnamespace and p.prosecdef and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('anon', p.oid, 'execute')
     and p.proname in ('make_default_location', 'use_studio', 'gen_sessions')
  union all
  -- policies
  select 'FAIL', 'anon_write_policy', pl.tablename::text, pl.policyname::text || ' (' || pl.cmd || ')'
    from pg_policies pl where pl.schemaname in ('public','storage') and pl.cmd in ('INSERT','UPDATE','DELETE') and pl.permissive = 'PERMISSIVE'
     and (pl.roles && array['anon','public']::name[])
  union all
  select 'FAIL', 'no_with_check', pl.tablename::text, pl.policyname::text
    from pg_policies pl where pl.schemaname = 'public' and pl.cmd in ('INSERT','UPDATE') and pl.permissive = 'PERMISSIVE' and pl.with_check is null and pl.qual is null
  union all
  -- views skip RLS: they must be read-only
  select 'FAIL', 'view_writable', c.relname::text || ' (' || g.grantee || ' ' || g.privilege_type || ')', 'views run with their owner''s rights'
    from pg_class c join information_schema.role_table_grants g on g.table_schema = 'public' and g.table_name = c.relname
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m') and g.grantee in ('anon','authenticated','public')
     and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
  union all
  -- secrets
  select 'FAIL', 'secret_column', g.table_name::text, g.grantee::text || ' has ' || g.privilege_type
    from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name in ('kiosk_settings','integrations_secrets','stripe_events','stripe_customers')
     and g.grantee in ('anon','authenticated','public') and g.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
$f$;
select * from pg_temp.sec_audit() order by severity, chk, object;
