-- =============================================================================
-- 0007: one database, many studios (ROADMAP Phase A1).
--
--   * public.studios (slug, name, timezone, currency, locale, contact, tax, status, branding) and
--     public.platform_admins (Pete). Every studio-owned table gets studio_id, backfilled to the default
--     studio 'snowy', so the Snowy single-studio deployment is simply a platform with one studio.
--   * Which studio a request is for: the x-studio request header (the apps send the bound studio's id or
--     slug), else app.studio (internal: set_config by our own functions and the tests), else the studio
--     marked is_default (Snowy's deployment). app.current_studio_id() answers it.
--   * A person (auth user) can be a client at several studios and staff at others: clients and staff
--     rows are per studio, unique per (studio_id, user_id).
--   * Row level security now checks membership IN THE ROW'S STUDIO (app.has_role_in(studio_id, ...)), and
--     a restrictive policy narrows everything to the requested studio when the x-studio header is sent.
--     Realtime (which sends no header) still only delivers rows you belong to.
--   * Cross-studio mix-ups are impossible at the table level: composite foreign keys (studio_id, x_id)
--     and a guard trigger that refuses writes outside the current studio.
--   * RPCs are studio-scoped: each checks that the class / booking / client / pass / sale it was given
--     belongs to the current studio (else NOT_FOUND) and uses that studio's settings and timezone.
--     Service-role calls (Stripe webhook, cron) switch to the entity's studio themselves.
--   * Platform admin RPCs: create a studio, update it, suspend it, invite its owner, stats.
--   * Owners: update_my_studio() (details, branding, go live). Clients: join_studio().
-- =============================================================================

-- Helpers below are created before the columns they read exist; Postgres checks them when they run.
set check_function_bodies = off;

-- ----------------------------------------------------------------------------- studios + platform admins

create table public.studios (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name text not null,
  timezone text not null default 'Australia/Sydney',
  currency text not null default 'AUD' check (currency ~ '^[A-Z]{3}$'),
  locale text not null default 'en-AU',
  email text not null default '',
  phone text,
  address text not null default '',
  website text,
  tax_id text,
  tax_id_label text not null default 'ABN',
  tax_name text not null default 'GST',
  tax_rate numeric(6,4) not null default 0.1 check (tax_rate >= 0 and tax_rate < 1),
  tax_registered boolean not null default true,
  status text not null default 'onboarding' check (status in ('onboarding','live','suspended')),
  branding jsonb not null default '{}'::jsonb,
  custom_domains text[] not null default '{}',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index studios_one_default on public.studios (is_default) where is_default;
create index studios_domains_idx on public.studios using gin (custom_domains);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Snowy: studio #1 and the default studio of this database (seed.sql fills in its branding).
insert into public.studios (id, slug, name, timezone, email, address, tax_id, tax_registered, status, is_default)
select '57d10000-0000-4000-8000-000000000001', 'snowy', coalesce(s.name, 'Snowy Pilates Club'), coalesce(s.timezone, 'Australia/Sydney'),
       coalesce(s.email, ''), coalesce(s.address, ''), s.abn, coalesce(s.gst_registered, true), 'live', true
  from (select 1) one left join public.studio_settings s on s.id = 1;

-- ----------------------------------------------------------------------------- which studio is this request for?

-- The studio named by the request (x-studio header: id or slug), or app.studio set internally. Null if neither.
create or replace function app.requested_studio() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text; r uuid;
begin
  v := nullif(current_setting('app.studio', true), '');
  if v is null then
    begin
      v := nullif(nullif(current_setting('request.headers', true), '')::json ->> 'x-studio', '');
    exception when others then v := null;
    end;
  end if;
  if v is null then return null; end if;
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into r from public.studios where id = v::uuid;
  else
    select id into r from public.studios where slug = lower(v);
  end if;
  -- An unknown studio scopes to nothing (never silently to the default studio).
  return coalesce(r, '00000000-0000-0000-0000-000000000000'::uuid);
end $$;

create or replace function app.default_studio() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.studios where is_default
$$;

create or replace function app.current_studio_id() returns uuid
language sql stable as $$
  select coalesce(app.requested_studio(), app.default_studio())
$$;

-- Restrictive RLS: with an x-studio header only that studio's rows; without one, no narrowing (membership decides).
create or replace function app.in_scope(p_studio uuid) returns boolean
language sql stable as $$
  select app.requested_studio() is null or p_studio = app.requested_studio()
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- Membership in a given studio (the row's studio, in RLS policies).
create or replace function app.staff_role_in(p_studio uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.staff where user_id = auth.uid() and studio_id = p_studio and active
$$;
create or replace function app.has_role_in(p_studio uuid, variadic roles text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = any(roles) from public.staff where user_id = auth.uid() and studio_id = p_studio and active), false)
$$;
create or replace function app.is_staff_of(p_studio uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and studio_id = p_studio and active)
$$;
create or replace function app.client_id_in(p_studio uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.clients where user_id = auth.uid() and studio_id = p_studio
$$;
create or replace function app.staff_id_in(p_studio uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.staff where user_id = auth.uid() and studio_id = p_studio and active
$$;
create or replace function app.is_member_of(p_studio uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and studio_id = p_studio and active)
      or exists (select 1 from public.clients where user_id = auth.uid() and studio_id = p_studio and not archived)
$$;

-- The old helpers now mean "in the current studio" (every RPC is written against them).
create or replace function public.current_staff_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id()
$$;
create or replace function public.current_client_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.clients where user_id = auth.uid() and studio_id = app.current_studio_id()
$$;
create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id()
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id())
$$;
create or replace function public.has_role(variadic roles text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = any(roles) from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id()), false)
$$;

-- Timezone of the current studio.
create or replace function app.tz() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select timezone from public.studios where id = app.current_studio_id()), 'Australia/Sydney')
$$;
create or replace function app.studio_tz(p_studio uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select timezone from public.studios where id = p_studio), 'Australia/Sydney')
$$;

-- Switch this transaction to a studio (our own functions only: set_config isn't reachable through the API).
create or replace function app.use_studio(p_studio uuid) returns void
language sql as $$ select set_config('app.studio', coalesce(p_studio::text, ''), true) $$;

-- The thing an RPC was given must be in the current studio. Privileged callers (SQL editor, service role:
-- Stripe webhook, cron) switch to its studio instead. Missing rows are left for the RPC's own NOT_FOUND.
create or replace function app.assert_in_studio(p_table text, p_id uuid, p_msg text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  if p_id is null then return; end if;
  execute format('select studio_id from public.%I where id = $1', p_table) into v using p_id;
  if v is null then return; end if;
  if app.is_privileged() then perform app.use_studio(v); return; end if;
  if v is distinct from app.current_studio_id() then perform app.fail('NOT_FOUND', p_msg); end if;
end $$;

-- Clients can't use a suspended studio (staff still can read; writes are refused for everyone but us).
create or replace function app.assert_studio_open(p_studio uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if app.is_privileged() or app.is_platform_admin() then return; end if;
  if exists (select 1 from public.studios where id = p_studio and status = 'suspended') then
    perform app.fail('STUDIO_SUSPENDED', 'This studio is paused on the platform right now. Please contact the studio.');
  end if;
end $$;

-- ----------------------------------------------------------------------------- studio_id on every studio-owned table

-- studio_settings: one row per studio now (id stays, the "id = 1" rule goes).
alter table public.studio_settings drop constraint if exists studio_settings_id_check;
create sequence if not exists public.studio_settings_id_seq start 2 owned by public.studio_settings.id;
alter table public.studio_settings alter column id set default nextval('public.studio_settings_id_seq');
select setval('public.studio_settings_id_seq', greatest(2, coalesce((select max(id) + 1 from public.studio_settings), 2)), false);

do $$
declare t text;
begin
  foreach t in array array['studio_settings','staff','staff_pay','clients','client_notes','class_types','schedule_templates',
                           'class_sessions','products','passes','pass_adjustments','bookings','sales','sale_items',
                           'stripe_customers','notifications','audit_log','class_interest']
  loop
    execute format('alter table public.%I add column studio_id uuid', t);
    execute format('update public.%I set studio_id = %L', t, '57d10000-0000-4000-8000-000000000001');
    execute format('alter table public.%I alter column studio_id set default app.current_studio_id()', t);
    execute format('alter table public.%I alter column studio_id set not null', t);
    execute format('alter table public.%I add constraint %I foreign key (studio_id) references public.studios(id) on delete restrict', t, t || '_studio_fk');
    execute format('create index %I on public.%I (studio_id)', t || '_studio_idx', t);
  end loop;
end $$;

alter table public.studio_settings add constraint studio_settings_studio_key unique (studio_id);
alter table public.class_types add column if not exists image_url text;

-- Per-studio uniqueness (one login can be staff at several studios and a client at several).
alter table public.staff drop constraint if exists staff_user_id_key;
create unique index staff_studio_user_key on public.staff (studio_id, user_id) where user_id is not null;
drop index if exists public.staff_email_key;
create unique index staff_email_key on public.staff (studio_id, lower(email)) where email is not null and email <> '';
alter table public.clients drop constraint if exists clients_user_id_key;
create unique index clients_studio_user_key on public.clients (studio_id, user_id) where user_id is not null;
alter table public.clients drop constraint if exists clients_momence_id_key;
create unique index clients_momence_id_key on public.clients (studio_id, momence_id) where momence_id is not null;
create index clients_user_idx on public.clients (user_id);
create index staff_user_idx on public.staff (user_id);

-- Composite keys so a row can only point at things in its own studio.
alter table public.staff add constraint staff_studio_id_key unique (studio_id, id);
alter table public.clients add constraint clients_studio_id_key unique (studio_id, id);
alter table public.class_types add constraint class_types_studio_id_key unique (studio_id, id);
alter table public.schedule_templates add constraint templates_studio_id_key unique (studio_id, id);
alter table public.class_sessions add constraint sessions_studio_id_key unique (studio_id, id);
alter table public.products add constraint products_studio_id_key unique (studio_id, id);
alter table public.passes add constraint passes_studio_id_key unique (studio_id, id);
alter table public.sales add constraint sales_studio_id_key unique (studio_id, id);

alter table public.staff_pay add constraint staff_pay_same_studio foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade;
alter table public.client_notes add constraint client_notes_same_studio foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade;
alter table public.schedule_templates add constraint templates_type_same_studio foreign key (studio_id, class_type_id) references public.class_types (studio_id, id);
alter table public.schedule_templates add constraint templates_staff_same_studio foreign key (studio_id, instructor_id) references public.staff (studio_id, id);
alter table public.class_sessions add constraint sessions_type_same_studio foreign key (studio_id, class_type_id) references public.class_types (studio_id, id);
alter table public.class_sessions add constraint sessions_staff_same_studio foreign key (studio_id, instructor_id) references public.staff (studio_id, id);
alter table public.class_sessions add constraint sessions_template_same_studio foreign key (studio_id, template_id) references public.schedule_templates (studio_id, id) on delete set null (template_id);
alter table public.passes add constraint passes_client_same_studio foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade;
alter table public.passes add constraint passes_product_same_studio foreign key (studio_id, product_id) references public.products (studio_id, id) on delete set null (product_id);
alter table public.pass_adjustments add constraint adjustments_same_studio foreign key (studio_id, pass_id) references public.passes (studio_id, id) on delete cascade;
alter table public.bookings add constraint bookings_session_same_studio foreign key (studio_id, session_id) references public.class_sessions (studio_id, id) on delete cascade;
alter table public.bookings add constraint bookings_client_same_studio foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade;
alter table public.bookings add constraint bookings_pass_same_studio foreign key (studio_id, pass_id) references public.passes (studio_id, id) on delete set null (pass_id);
alter table public.sales add constraint sales_client_same_studio foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete set null (client_id);
alter table public.sale_items add constraint sale_items_same_studio foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete cascade;
alter table public.sale_items add constraint sale_items_product_same_studio foreign key (studio_id, product_id) references public.products (studio_id, id) on delete set null (product_id);
alter table public.stripe_customers add constraint stripe_customers_same_studio foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade;
alter table public.class_interest add constraint interest_client_same_studio foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade;
alter table public.class_interest add constraint interest_type_same_studio foreign key (studio_id, class_type_id) references public.class_types (studio_id, id) on delete cascade;

-- Children take their parent's studio when inserted without one (e.g. by service-role code), and no write
-- may land outside the current studio unless it's us (migrations, SQL editor, service role).
create or replace function app.guard_studio() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if not app.is_privileged() and old.studio_id is distinct from app.current_studio_id() then
      perform app.fail('NOT_FOUND', 'We couldn''t find that.');
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' and new.studio_id is null then new.studio_id := app.current_studio_id(); end if;
  if tg_op = 'UPDATE' and new.studio_id is distinct from old.studio_id then
    perform app.fail('NOT_ALLOWED', 'Records can''t move between studios.');
  end if;
  if not app.is_privileged() and new.studio_id is distinct from app.current_studio_id() then
    perform app.fail('NOT_ALLOWED', 'That belongs to another studio.');
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['studio_settings','staff','staff_pay','clients','client_notes','class_types','schedule_templates',
                           'class_sessions','products','passes','pass_adjustments','bookings','sales','sale_items',
                           'stripe_customers','notifications','class_interest']
  loop
    execute format('create trigger aa_guard_studio before insert or update or delete on public.%I for each row execute function app.guard_studio()', t);
  end loop;
end $$;

-- Rows written by service-role code (webhooks) without a studio: take the parent's.
create or replace function app.inherit_studio() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'sale_items' then select studio_id into new.studio_id from public.sales where id = new.sale_id;
  elsif tg_table_name = 'pass_adjustments' then select studio_id into new.studio_id from public.passes where id = new.pass_id;
  elsif tg_table_name in ('passes','sales','stripe_customers','client_notes','notifications') and new.client_id is not null then
    select studio_id into new.studio_id from public.clients where id = new.client_id;
  elsif tg_table_name = 'bookings' then select studio_id into new.studio_id from public.class_sessions where id = new.session_id;
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['sale_items','pass_adjustments','passes','sales','stripe_customers','client_notes','notifications','bookings']
  loop
    execute format('create trigger a0_inherit_studio before insert on public.%I for each row when (new.studio_id is null) execute function app.inherit_studio()', t);
  end loop;
end $$;
-- The column default (current studio) would hide a missing studio from the trigger above: children decide.
do $$
declare t text;
begin
  foreach t in array array['sale_items','pass_adjustments','passes','sales','stripe_customers','client_notes','notifications','bookings']
  loop
    execute format('alter table public.%I alter column studio_id drop default', t);
  end loop;
end $$;

-- Settings changes keep the studio record in step (name, contact, tax), so receipts and the directory agree.
create or replace function app.settings_to_studio() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.studios set name = new.name, timezone = new.timezone, address = new.address, email = new.email,
         phone = new.phone, tax_id = new.abn, tax_registered = new.gst_registered
   where id = new.studio_id
     and (name, timezone, address, email, phone, tax_id, tax_registered) is distinct from
         (new.name, new.timezone, new.address, new.email, new.phone, new.abn, new.gst_registered);
  return null;
end $$;
create trigger settings_to_studio after insert or update on public.studio_settings for each row execute function app.settings_to_studio();

-- The settings row for a studio.
create or replace function app.settings_of(p_studio uuid) returns public.studio_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.studio_settings where studio_id = p_studio
$$;

-- ----------------------------------------------------------------------------- views (owner rights, so filter here)

drop view if exists public.sessions_with_counts;
create view public.sessions_with_counts as
select s.id, s.class_type_id, s.template_id, s.starts_at, s.ends_at, s.instructor_id, s.capacity,
       s.status, s.note, s.cancel_reason, s.updated_at, s.studio_id,
       coalesce(c.booked, 0)::int as booked_count,
       coalesce(c.waitlisted, 0)::int as waitlist_count,
       greatest(0, s.capacity - coalesce(c.booked, 0))::int as spots_left
  from public.class_sessions s
  left join lateral (
    select count(*) filter (where b.status in ('booked','checked_in')) as booked,
           count(*) filter (where b.status = 'waitlisted') as waitlisted
      from public.bookings b where b.session_id = s.id
  ) c on true
 where s.studio_id = app.current_studio_id();

drop view if exists public.staff_public;
create view public.staff_public as
select id, name, role, bio, photo_url, active, studio_id from public.staff where studio_id = app.current_studio_id();
grant select on public.sessions_with_counts, public.staff_public to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- RLS: membership in the row's studio

alter table public.studios enable row level security;
alter table public.platform_admins enable row level security;

-- Directory: live studios are public; members see their own studio in any status; platform admins see all.
create policy studios_read on public.studios for select to anon, authenticated
  using (status = 'live' or app.is_member_of(id) or app.is_platform_admin());
-- Changes go through update_my_studio() / platform_* functions.
revoke insert, update, delete on public.studios from anon, authenticated;
create policy platform_admins_read on public.platform_admins for select to authenticated
  using (user_id = auth.uid() or app.is_platform_admin());
revoke insert, update, delete on public.platform_admins from anon, authenticated;

-- Restrictive scope: with an x-studio header only that studio.
do $$
declare t text;
begin
  foreach t in array array['studio_settings','staff','staff_pay','clients','client_notes','class_types','schedule_templates',
                           'class_sessions','products','passes','pass_adjustments','bookings','sales','sale_items',
                           'audit_log','class_interest']
  loop
    execute format('create policy studio_scope on public.%I as restrictive for all to anon, authenticated using (app.in_scope(studio_id)) with check (app.in_scope(studio_id))', t);
  end loop;
end $$;

drop policy if exists settings_write on public.studio_settings;
create policy settings_write on public.studio_settings for update to authenticated
  using (app.has_role_in(studio_id, 'owner','manager')) with check (app.has_role_in(studio_id, 'owner','manager'));

drop policy if exists staff_read on public.staff;
drop policy if exists staff_insert on public.staff;
drop policy if exists staff_update on public.staff;
drop policy if exists staff_delete on public.staff;
create policy staff_read on public.staff for select to authenticated using (app.is_staff_of(studio_id));
create policy staff_insert on public.staff for insert to authenticated with check (app.has_role_in(studio_id, 'owner','manager'));
create policy staff_update on public.staff for update to authenticated
  using (app.has_role_in(studio_id, 'owner','manager')) with check (app.has_role_in(studio_id, 'owner','manager'));
create policy staff_delete on public.staff for delete to authenticated using (app.has_role_in(studio_id, 'owner'));

drop policy if exists staff_pay_read on public.staff_pay;
drop policy if exists staff_pay_insert on public.staff_pay;
drop policy if exists staff_pay_update on public.staff_pay;
drop policy if exists staff_pay_delete on public.staff_pay;
create policy staff_pay_read on public.staff_pay for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
create policy staff_pay_insert on public.staff_pay for insert to authenticated with check (app.has_role_in(studio_id, 'owner'));
create policy staff_pay_update on public.staff_pay for update to authenticated
  using (app.has_role_in(studio_id, 'owner')) with check (app.has_role_in(studio_id, 'owner'));
create policy staff_pay_delete on public.staff_pay for delete to authenticated using (app.has_role_in(studio_id, 'owner'));

drop policy if exists clients_read_own on public.clients;
drop policy if exists clients_update_own on public.clients;
drop policy if exists clients_staff_insert on public.clients;
drop policy if exists clients_staff_update on public.clients;
create policy clients_read_own on public.clients for select to authenticated
  using (user_id = auth.uid() or app.is_staff_of(studio_id));
create policy clients_update_own on public.clients for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy clients_staff_insert on public.clients for insert to authenticated
  with check (app.has_role_in(studio_id, 'owner','manager','front_desk'));
create policy clients_staff_update on public.clients for update to authenticated
  using (app.has_role_in(studio_id, 'owner','manager','front_desk')) with check (app.has_role_in(studio_id, 'owner','manager','front_desk'));

drop policy if exists client_notes_staff on public.client_notes;
create policy client_notes_staff on public.client_notes for all to authenticated
  using (app.has_role_in(studio_id, 'owner','manager','front_desk')) with check (app.has_role_in(studio_id, 'owner','manager','front_desk'));

drop policy if exists class_types_read on public.class_types;
drop policy if exists class_types_write on public.class_types;
create policy class_types_read on public.class_types for select to anon, authenticated
  using (active or app.is_staff_of(studio_id));
create policy class_types_write on public.class_types for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk')) with check (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));

drop policy if exists templates_read on public.schedule_templates;
drop policy if exists templates_write on public.schedule_templates;
create policy templates_read on public.schedule_templates for select to authenticated using (app.is_staff_of(studio_id));
create policy templates_write on public.schedule_templates for all to authenticated
  using (app.has_role_in(studio_id, 'owner','manager','front_desk')) with check (app.has_role_in(studio_id, 'owner','manager','front_desk'));

drop policy if exists sessions_insert on public.class_sessions;
drop policy if exists sessions_update on public.class_sessions;
create policy sessions_insert on public.class_sessions for insert to authenticated
  with check (app.has_role_in(studio_id, 'owner','manager','front_desk') and status = 'scheduled');
create policy sessions_update on public.class_sessions for update to authenticated
  using (app.has_role_in(studio_id, 'owner','manager','front_desk')) with check (app.has_role_in(studio_id, 'owner','manager','front_desk'));

drop policy if exists products_read on public.products;
drop policy if exists products_write on public.products;
create policy products_read on public.products for select to anon, authenticated
  using (active or app.is_staff_of(studio_id));
create policy products_write on public.products for all to authenticated
  using (app.has_role_in(studio_id, 'owner','manager')) with check (app.has_role_in(studio_id, 'owner','manager'));

drop policy if exists passes_read on public.passes;
create policy passes_read on public.passes for select to authenticated
  using (client_id = app.client_id_in(studio_id) or app.is_staff_of(studio_id));
drop policy if exists pass_adjustments_read on public.pass_adjustments;
create policy pass_adjustments_read on public.pass_adjustments for select to authenticated
  using (app.is_staff_of(studio_id)
         or exists (select 1 from public.passes p where p.id = pass_id and p.client_id = app.client_id_in(p.studio_id)));

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated
  using (
    client_id = app.client_id_in(studio_id)
    or app.has_role_in(studio_id, 'owner','manager','front_desk')
    or (app.has_role_in(studio_id, 'instructor') and exists (
          select 1 from public.class_sessions s where s.id = session_id and s.instructor_id = app.staff_id_in(studio_id)))
  );

drop policy if exists sales_read on public.sales;
drop policy if exists sale_items_read on public.sale_items;
create policy sales_read on public.sales for select to authenticated
  using (client_id = app.client_id_in(studio_id) or app.has_role_in(studio_id, 'owner','manager','front_desk'));
create policy sale_items_read on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id
                 and (s.client_id = app.client_id_in(s.studio_id) or app.has_role_in(s.studio_id, 'owner','manager','front_desk'))));

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (app.has_role_in(studio_id, 'owner','manager'));

drop policy if exists class_interest_own on public.class_interest;
drop policy if exists class_interest_insert on public.class_interest;
drop policy if exists class_interest_delete on public.class_interest;
create policy class_interest_own on public.class_interest for select to authenticated
  using (client_id = app.client_id_in(studio_id) or app.is_staff_of(studio_id));
create policy class_interest_insert on public.class_interest for insert to authenticated
  with check (client_id = app.client_id_in(studio_id) or app.has_role_in(studio_id, 'owner','manager','front_desk'));
create policy class_interest_delete on public.class_interest for delete to authenticated
  using (client_id = app.client_id_in(studio_id) or app.has_role_in(studio_id, 'owner','manager','front_desk'));

-- Avatars: a client writes their own folder; staff write folders of their own studio's clients.
create or replace function app.can_write_avatar(p_folder text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.clients c
                  where c.id::text = p_folder and (c.user_id = auth.uid() or app.is_staff_of(c.studio_id)))
$$;
drop policy if exists spc_avatars_insert on storage.objects;
drop policy if exists spc_avatars_update on storage.objects;
drop policy if exists spc_avatars_delete on storage.objects;
create policy spc_avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and app.can_write_avatar((storage.foldername(name))[1]));
create policy spc_avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and app.can_write_avatar((storage.foldername(name))[1]))
  with check (bucket_id = 'avatars' and app.can_write_avatar((storage.foldername(name))[1]));
create policy spc_avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and app.can_write_avatar((storage.foldername(name))[1]));

-- Branding uploads (logos, photos): public read; '<studio id>/...' written by that studio's owner/manager or a platform admin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create or replace function app.can_write_branding(p_folder text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_platform_admin() or exists (select 1 from public.studios s where s.id::text = p_folder and app.has_role_in(s.id, 'owner', 'manager'))
$$;
drop policy if exists platform_branding_read on storage.objects;
drop policy if exists platform_branding_write on storage.objects;
drop policy if exists platform_branding_update on storage.objects;
drop policy if exists platform_branding_delete on storage.objects;
create policy platform_branding_read on storage.objects for select to anon, authenticated using (bucket_id = 'branding');
create policy platform_branding_write on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and app.can_write_branding((storage.foldername(name))[1]));
create policy platform_branding_update on storage.objects for update to authenticated
  using (bucket_id = 'branding' and app.can_write_branding((storage.foldername(name))[1]))
  with check (bucket_id = 'branding' and app.can_write_branding((storage.foldername(name))[1]));
create policy platform_branding_delete on storage.objects for delete to authenticated
  using (bucket_id = 'branding' and app.can_write_branding((storage.foldername(name))[1]));

-- ----------------------------------------------------------------------------- triggers that need the studio

-- Staff: managers can't create/modify owners; platform admins can (inviting a new studio's owner).
create or replace function app.guard_staff() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.is_privileged() or app.is_platform_admin() or app.has_role_in(coalesce(new.studio_id, old.studio_id), 'owner') then return coalesce(new, old); end if;
  if tg_op in ('UPDATE','DELETE') and old.role = 'owner' then
    perform app.fail('NOT_ALLOWED', 'Only the owner can change an owner account.');
  end if;
  if tg_op in ('INSERT','UPDATE') and new.role = 'owner' then
    perform app.fail('NOT_ALLOWED', 'Only the owner can make someone an owner.');
  end if;
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    perform app.fail('NOT_ALLOWED', 'Only the owner can relink a staff login.');
  end if;
  return coalesce(new, old);
end $$;

-- A staff row whose login already exists (same email, confirmed) links straight away, per studio.
create or replace function app.link_staff_login() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is null and coalesce(new.email, '') <> '' then
    select u.id into new.user_id from auth.users u
     where lower(u.email) = lower(new.email) and u.email_confirmed_at is not null
       and not exists (select 1 from public.staff s where s.user_id = u.id and s.studio_id = new.studio_id and s.id <> new.id);
  end if;
  return new;
end $$;

-- Client self-edits (0006 rules), with "staff" meaning staff of that client's studio.
create or replace function app.guard_client() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if app.has_role_in(old.studio_id, 'owner', 'manager', 'front_desk') then return new; end if;
  new.id := old.id;
  new.user_id := old.user_id;
  new.email := old.email;
  new.created_at := old.created_at;
  new.source := old.source;
  new.archived := old.archived;
  new.intro_ineligible := old.intro_ineligible;
  new.momence_id := old.momence_id;
  new.waiver_signed_at := old.waiver_signed_at;
  new.health_form := old.health_form;
  if new.photo_url is distinct from old.photo_url and new.photo_url is not null
     and position('/avatars/' || old.id::text || '/' in new.photo_url) = 0 then
    raise exception 'INVALID: Please upload your photo through the app.' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ABN and GST registration: the studio's owner only.
create or replace function app.guard_settings() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() and not app.is_platform_admin() and not app.has_role_in(new.studio_id, 'owner')
     and (new.abn is distinct from old.abn or new.gst_registered is distinct from old.gst_registered) then
    perform app.fail('NOT_ALLOWED', 'Only the owner can change the ABN and GST settings.');
  end if;
  return new;
end $$;

-- Audit rows belong to the studio of what changed.
create or replace function app.audit(p_action text, p_entity text, p_entity_id text, p_details jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (studio_id, actor_user_id, actor_staff_id, action, entity, entity_id, details)
  values (coalesce(app.current_studio_id(), (select id from public.studios order by created_at limit 1)),
          auth.uid(), public.current_staff_id(), p_action, p_entity, p_entity_id, p_details)
$$;
create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_studio uuid := (rec ->> 'studio_id')::uuid;
begin
  insert into public.audit_log (studio_id, actor_user_id, actor_staff_id, action, entity, entity_id, details)
  values (coalesce(v_studio, app.current_studio_id()), auth.uid(), app.staff_id_in(v_studio), lower(tg_op), tg_table_name,
          rec ->> case when tg_table_name = 'staff_pay' then 'staff_id' else 'id' end,
          case when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) else rec end);
  return null;
end $$;

-- ----------------------------------------------------------------------------- booking engine (0002), studio-scoped

create or replace function app.fmt_when_tz(p_at timestamptz, p_tz text) returns text
language sql stable as $$
  select lower(to_char(p_at at time zone p_tz, 'FMHH12:MIam')) || ' ' || to_char(p_at at time zone p_tz, 'Dy FMDD Mon')
$$;

create or replace function app.notify(p_booking_id uuid, p_kind text, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select b.id as booking_id, b.studio_id, c.id as client_id, c.email, c.first_name, ct.name as class_name, ct.booking_note,
         s.starts_at, s.cancel_reason, st.name as instructor_name, ss.name as studio_name, ss.address,
         ss.cancellation_policy_text, ss.waitlist_policy_text, sd.timezone, sd.slug, sd.email as studio_email
    into r
    from public.bookings b
    join public.clients c on c.id = b.client_id
    join public.class_sessions s on s.id = b.session_id
    join public.class_types ct on ct.id = s.class_type_id
    join public.studios sd on sd.id = b.studio_id
    left join public.staff st on st.id = s.instructor_id
    left join public.studio_settings ss on ss.studio_id = b.studio_id
   where b.id = p_booking_id;
  if r.booking_id is null or coalesce(r.email, '') = '' then return; end if;
  insert into public.notifications (studio_id, client_id, kind, to_email, payload)
  values (r.studio_id, r.client_id, p_kind, r.email, jsonb_build_object(
    'booking_id', r.booking_id, 'first_name', r.first_name, 'class_name', r.class_name,
    'starts_at', r.starts_at, 'when', app.fmt_when_tz(r.starts_at, r.timezone), 'instructor', r.instructor_name,
    'studio_name', r.studio_name, 'studio_slug', r.slug, 'studio_email', r.studio_email, 'address', r.address, 'booking_note', r.booking_note,
    'cancellation_policy', r.cancellation_policy_text, 'waitlist_policy', r.waitlist_policy_text,
    'cancel_reason', r.cancel_reason) || p_extra);
end $$;

create or replace function app.can_staff_session(p_session public.class_sessions) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_privileged()
      or (p_session.studio_id = app.current_studio_id() and (
            public.has_role('owner','manager','front_desk')
         or (public.has_role('instructor') and p_session.instructor_id = public.current_staff_id())))
$$;

create or replace function app.promote_waitlist(p_session_id uuid, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, app.now());
  s public.class_sessions;
  v_cutoff numeric;
  v_booked int;
  w record;
  p public.passes;
  v_out jsonb := '[]'::jsonb;
begin
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null or s.status <> 'scheduled' then return v_out; end if;
  select waitlist_cutoff_hours into v_cutoff from public.studio_settings where studio_id = s.studio_id;
  if v_now >= s.starts_at - make_interval(secs => coalesce(v_cutoff, 1) * 3600) then return v_out; end if;

  for w in select * from public.bookings
            where session_id = s.id and status = 'waitlisted'
            order by waitlist_position nulls last, created_at
            for update
  loop
    select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');
    exit when v_booked >= s.capacity;
    perform 1 from public.passes where client_id = w.client_id for update;
    p := app.best_pass(w.client_id, s.starts_at, s.class_type_id, v_now);
    continue when p.id is null;
    p := app.apply_credit(p.id, v_now);
    update public.bookings set status = 'booked', pass_id = p.id, promoted_from_waitlist_at = v_now,
           waitlist_position = null
     where id = w.id;
    perform app.notify(w.id, 'waitlist_promoted');
    perform app.audit('promote_waitlist', 'bookings', w.id::text, jsonb_build_object('pass_id', p.id));
    v_out := v_out || jsonb_build_array(app.booking_json(w.id));
  end loop;
  if jsonb_array_length(v_out) > 0 then perform app.renumber_waitlist(s.id); end if;
  return v_out;
end $$;

create or replace function public.book_class(
  p_session_id uuid,
  p_pass_id uuid default null,
  p_client_id uuid default null,
  p_as_staff boolean default false,
  p_allow_over_capacity boolean default false,
  p_skip_credit boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  v_client uuid;
  v_staff uuid;
  s public.class_sessions;
  ct public.class_types;
  c public.clients;
  st public.studio_settings;
  p public.passes;
  v_booked int;
  v_pos int;
  b_id uuid;
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  v_staff := public.current_staff_id();
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  perform app.assert_studio_open(s.studio_id);
  select * into st from public.studio_settings where studio_id = s.studio_id;
  select * into ct from public.class_types where id = s.class_type_id;

  if p_as_staff then
    if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to book clients into this class.'); end if;
    v_client := p_client_id;
    if v_client is null then perform app.fail('NOT_FOUND', 'Choose a client to book.'); end if;
  else
    v_client := public.current_client_id();
    if v_client is null then perform app.fail('AUTH_REQUIRED', 'Please sign in to book.'); end if;
    if p_client_id is not null and p_client_id <> v_client then perform app.fail('NOT_ALLOWED', 'You can only book for yourself.'); end if;
    if p_allow_over_capacity or p_skip_credit then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  end if;

  select * into c from public.clients where id = v_client and studio_id = s.studio_id;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;

  if s.status = 'cancelled' then perform app.fail('CLASS_CANCELLED', 'This class has been cancelled.'); end if;

  if p_as_staff then
    if v_now >= s.ends_at then perform app.fail('TOO_LATE', 'This class has already finished.'); end if;
  else
    if v_now >= s.starts_at then perform app.fail('TOO_LATE', 'This class has already started.'); end if;
    if not ct.bookable or not ct.active then perform app.fail('NOT_BOOKABLE', 'This class isn''t open for booking yet.'); end if;
    if app.local_date(s.starts_at) > app.local_date(v_now) + st.booking_window_days then
      perform app.fail('TOO_EARLY', format('Bookings open %s days before class.', st.booking_window_days));
    end if;
    if c.waiver_signed_at is null then
      perform app.fail('WAIVER_REQUIRED', 'Please sign the waiver and health form before your first booking.');
    end if;
  end if;

  if exists (select 1 from public.bookings where session_id = s.id and client_id = v_client
               and status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'You''re already booked into this class.');
  end if;

  select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');

  if v_booked >= s.capacity and not p_allow_over_capacity then
    select coalesce(max(waitlist_position), 0) + 1 into v_pos from public.bookings
     where session_id = s.id and status = 'waitlisted';
    insert into public.bookings (studio_id, session_id, client_id, status, waitlist_position, source, booked_by_staff_id)
    values (s.studio_id, s.id, v_client, 'waitlisted', v_pos, case when p_as_staff then 'staff' else 'client' end,
            case when p_as_staff then v_staff end)
    returning id into b_id;
    return jsonb_build_object('outcome', 'waitlisted', 'booking', app.booking_json(b_id), 'pass', null);
  end if;

  perform 1 from public.passes where client_id = v_client for update;

  if p_skip_credit then
    p := null;
  elsif p_pass_id is not null then
    select * into p from public.passes where id = p_pass_id and client_id = v_client;
    if p.id is null or not app.pass_usable(p, s.starts_at, s.class_type_id, v_now)
       or coalesce(app.pass_remaining(p, s.starts_at), 1) <= 0 then
      perform app.fail('NO_CREDITS', 'That pass can''t be used for this class.');
    end if;
  else
    p := app.best_pass(v_client, s.starts_at, s.class_type_id, v_now);
    if p.id is null then perform app.fail('NO_CREDITS', 'You need a class pass to book this class.'); end if;
  end if;

  if p.id is not null then p := app.apply_credit(p.id, v_now); end if;

  insert into public.bookings (studio_id, session_id, client_id, status, pass_id, source, booked_by_staff_id)
  values (s.studio_id, s.id, v_client, 'booked', p.id, case when p_as_staff then 'staff' else 'client' end,
          case when p_as_staff then v_staff end)
  returning id into b_id;

  perform app.notify(b_id, 'booking_confirmed');
  if p_as_staff then
    perform app.audit('book_class', 'bookings', b_id::text,
      jsonb_build_object('over_capacity', p_allow_over_capacity, 'skip_credit', p_skip_credit));
  end if;

  return jsonb_build_object('outcome', 'booked', 'booking', app.booking_json(b_id),
                            'pass', case when p.id is not null then app.pass_json(p.id) end);
end $$;

create or replace function public.cancel_booking(
  p_booking_id uuid,
  p_waive_penalty boolean default false,
  p_as_staff boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  b public.bookings;
  s public.class_sessions;
  v_window numeric;
  v_late boolean;
  v_returned boolean := false;
  v_promoted jsonb;
  v_sid uuid;
begin
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that booking.');
  select session_id into v_sid from public.bookings where id = p_booking_id;
  if v_sid is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into s from public.class_sessions where id = v_sid for update;
  select * into b from public.bookings where id = p_booking_id for update;
  perform app.assert_studio_open(s.studio_id);

  if p_as_staff then
    if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to change this booking.'); end if;
  else
    if b.client_id is distinct from public.current_client_id() then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
    if p_waive_penalty then perform app.fail('NOT_ALLOWED', 'Only staff can waive the cancellation policy.'); end if;
  end if;

  if b.status = 'waitlisted' then
    update public.bookings set status = 'removed', cancelled_at = v_now, waitlist_position = null where id = b.id;
    perform app.renumber_waitlist(s.id);
    return jsonb_build_object('booking', app.booking_json(b.id), 'creditReturned', false, 'lateCancel', false, 'promoted', null);
  end if;

  if not (b.status = 'booked' or (p_as_staff and b.status in ('checked_in','no_show'))) then
    perform app.fail('INVALID', 'This booking can''t be cancelled.');
  end if;
  if not p_as_staff and v_now >= s.starts_at then
    perform app.fail('TOO_LATE', 'This class has already started.');
  end if;

  select cancel_window_hours into v_window from public.studio_settings where studio_id = s.studio_id;
  v_late := v_now > s.starts_at - make_interval(secs => coalesce(v_window, 3) * 3600);

  if v_late and not p_waive_penalty then
    update public.bookings set status = 'late_cancelled', cancelled_at = v_now where id = b.id;
  else
    update public.bookings set status = 'cancelled', cancelled_at = v_now where id = b.id;
    if b.pass_id is not null then perform app.return_credit(b.pass_id); end if;
    v_returned := true;
  end if;

  if p_as_staff then
    perform app.audit('cancel_booking', 'bookings', b.id::text,
      jsonb_build_object('waived', p_waive_penalty, 'late', v_late, 'from_status', b.status));
  end if;

  v_promoted := app.promote_waitlist(s.id, v_now);

  return jsonb_build_object('booking', app.booking_json(b.id), 'creditReturned', v_returned,
    'lateCancel', v_late and not p_waive_penalty, 'promoted', v_promoted -> 0);
end $$;

create or replace function app.staff_booking_for_update(p_booking_id uuid) returns public.bookings
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; s public.class_sessions;
begin
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that booking.');
  select * into b from public.bookings where id = p_booking_id for update;
  if b.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into s from public.class_sessions where id = b.session_id;
  if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to check in this class.'); end if;
  return b;
end $$;

-- ----------------------------------------------------------------------------- money (0003/0006), studio-scoped

create or replace function app.queue_receipt(p_sale uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales; c public.clients; st public.studio_settings; sd public.studios;
begin
  select * into s from public.sales where id = p_sale;
  select * into c from public.clients where id = s.client_id;
  select * into st from public.studio_settings where studio_id = s.studio_id;
  select * into sd from public.studios where id = s.studio_id;
  if c.id is null or coalesce(c.email, '') = '' or s.total_cents <= 0 then return; end if;
  insert into public.notifications (studio_id, client_id, kind, to_email, payload)
  values (s.studio_id, c.id, 'receipt', c.email, jsonb_build_object(
    'first_name', c.first_name, 'studio_name', st.name, 'abn', st.abn, 'address', st.address,
    'tax_id_label', sd.tax_id_label, 'tax_name', sd.tax_name, 'currency', sd.currency, 'studio_email', sd.email,
    'sale_id', s.id, 'created_at', s.created_at, 'total_cents', s.total_cents,
    'gst_cents', case when st.gst_registered then round(s.total_cents * sd.tax_rate / (1 + sd.tax_rate))::int else 0 end,
    'method', s.method, 'items', app.sale_json(s.id) -> 'items'));
end $$;

create or replace function app.pass_for_change(p_pass_id uuid, p_client_may boolean) returns public.passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
  perform app.assert_in_studio('passes', p_pass_id, 'We couldn''t find that pass.');
  select * into p from public.passes where id = p_pass_id for update;
  if p.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that pass.'); end if;
  perform app.assert_studio_open(p.studio_id);
  if app.is_privileged() or public.has_role('owner','manager','front_desk') then return p; end if;
  if p_client_may and p.client_id = public.current_client_id() then return p; end if;
  perform app.fail('NOT_ALLOWED', 'You don''t have permission to change this pass.');
end $$;

create or replace function public.report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_sid uuid := app.current_studio_id();
  v_tz text := app.tz();
  v_now timestamptz := app.now();
  v_start timestamptz := (p_from::timestamp) at time zone v_tz;
  v_end timestamptz := ((p_to + 1)::timestamp) at time zone v_tz;
  v_pay boolean := app.is_privileged() or public.has_role('owner', 'manager');
  v_money boolean := app.is_privileged() or public.has_role('owner', 'manager');
  v jsonb;
begin
  if not (app.is_privileged() or public.is_staff()) then
    perform app.fail('NOT_ALLOWED', 'Reports are for staff.');
  end if;

  with
  sl as (select * from public.sales where studio_id = v_sid and created_at >= v_start and created_at < v_end),
  it as (
    select i.sale_id, i.id, coalesce(i.kind, 'retail') as kind, (i.qty * i.unit_cents)::numeric as g, sl.total_cents::numeric as t
      from public.sale_items i join sl on sl.id = i.sale_id
     where coalesce(i.kind, '') <> 'discount'),
  it2 as (
    select it.*, sum(g) over (partition by sale_id) as gs,
           row_number() over (partition by sale_id order by id) as rn, count(*) over (partition by sale_id) as n
      from it),
  it3 as (
    select sale_id, kind, rn, n, t, gs,
           case when gs <= 0 then case when rn = 1 then t else 0 end else floor(g * t / gs) end as a
      from it2),
  alloc as (
    select kind, a + case when gs > 0 and rn = n then t - sum(a) over (partition by sale_id) else 0 end as a from it3),
  ses as (
    select s.id, s.class_type_id, s.instructor_id, s.starts_at, s.capacity, ct.name as ct_name,
           count(b.id) filter (where b.status in ('booked','checked_in','no_show','late_cancelled')) as total_b,
           count(b.id) filter (where b.status = 'checked_in') as attended,
           count(b.id) filter (where b.status in ('booked','checked_in','no_show')) as filled,
           count(b.id) filter (where b.status = 'no_show') as no_shows,
           count(b.id) filter (where b.status = 'late_cancelled') as late_cancels
      from public.class_sessions s
      join public.class_types ct on ct.id = s.class_type_id
      left join public.bookings b on b.session_id = s.id
     where s.studio_id = v_sid and s.status = 'scheduled' and s.starts_at >= v_start and s.starts_at < v_end and s.starts_at <= v_now
     group by s.id, ct.name),
  ses2 as (
    select ses.*, case when capacity > 0 then least(100.0, filled * 100.0 / capacity) else 0 end as fill,
           to_char(starts_at at time zone v_tz, 'Dy') || ' ' || lower(to_char(starts_at at time zone v_tz, 'FMHH12:MIam')) as slot
      from ses)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'revenue_cents', coalesce((select sum(total_cents) from sl), 0),
    'refunds_cents', coalesce((select sum(refunded_cents) from public.sales where studio_id = v_sid and refunded_at >= v_start and refunded_at < v_end), 0),
    'revenue_by_method', coalesce((select jsonb_object_agg(method, c) from (select method, sum(total_cents) c from sl group by method) x), '{}'::jsonb),
    'revenue_by_kind', coalesce((select jsonb_object_agg(kind, c) from (select kind, sum(a)::bigint c from alloc group by kind) x), '{}'::jsonb),
    'sales_count', (select count(*) from sl),
    'classes_run', (select count(*) from ses2),
    'total_bookings', coalesce((select sum(total_b) from ses2), 0),
    'attended', coalesce((select sum(attended) from ses2), 0),
    'no_shows', coalesce((select sum(no_shows) from ses2), 0),
    'late_cancels', coalesce((select sum(late_cancels) from ses2), 0),
    'avg_fill_pct', coalesce((select round(avg(fill), 1) from ses2), 0),
    'new_clients', (select count(*) from public.clients where studio_id = v_sid and created_at >= v_start and created_at < v_end),
    'active_memberships', (select count(*) from public.passes p where p.studio_id = v_sid and p.kind = 'membership' and app.pass_status_now(p, v_now) = 'active'),
    'active_packs', (select count(*) from public.passes p where p.studio_id = v_sid and p.kind <> 'membership' and app.pass_status_now(p, v_now) = 'active'),
    'by_instructor', coalesce((
        select jsonb_agg(jsonb_build_object('staff_id', x.instructor_id, 'name', coalesce(st.name, 'Unknown'), 'classes', x.classes,
                 'attendees', x.att, 'pay_cents', case when v_pay then x.classes * coalesce(sp.pay_per_class_cents, 0) else 0 end)
               order by x.classes desc, coalesce(st.name, 'Unknown'))
          from (select instructor_id, count(*) classes, sum(attended) att from ses2 group by instructor_id) x
          left join public.staff st on st.id = x.instructor_id
          left join public.staff_pay sp on sp.staff_id = x.instructor_id), '[]'::jsonb),
    'by_class_type', coalesce((
        select jsonb_agg(jsonb_build_object('class_type_id', class_type_id, 'name', ct_name, 'classes', classes,
                 'attendees', att, 'avg_fill_pct', fill) order by classes desc, ct_name)
          from (select class_type_id, ct_name, count(*) classes, sum(attended) att, round(avg(fill), 1) fill
                  from ses2 group by class_type_id, ct_name) x), '[]'::jsonb),
    'top_slots', coalesce((
        select jsonb_agg(jsonb_build_object('label', slot, 'avg_attendees', avg_att) order by avg_att desc, slot)
          from (select slot, round(avg(attended), 1) as avg_att from ses2 group by slot order by 2 desc, 1 limit 5) x), '[]'::jsonb)
  ) into v;
  if not v_money then
    v := v || jsonb_build_object('revenue_cents', 0, 'refunds_cents', 0, 'revenue_by_method', '{}'::jsonb,
                                 'revenue_by_kind', '{}'::jsonb, 'sales_count', 0);
  end if;
  return v;
end $$;

-- Every 15 minutes, for every studio in its own timezone.
create or replace function public.housekeeping() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now(); v_today date; a int := 0; b int := 0; c int := 0; n int; sid uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for sid in select id from public.studios order by created_at loop
    perform app.use_studio(sid);
    v_today := app.local_date(v_now);
    update public.bookings bk set status = 'removed', waitlist_position = null
      from public.class_sessions s
     where s.id = bk.session_id and bk.studio_id = sid and bk.status = 'waitlisted' and s.starts_at <= v_now;
    get diagnostics n = row_count; a := a + n;
    update public.passes set status = 'expired'
     where studio_id = sid and status in ('active','paused') and expires_at is not null and expires_at <= v_now;
    get diagnostics n = row_count; b := b + n;
    update public.passes set status = 'paused'
     where studio_id = sid and status = 'active' and paused_from is not null and paused_from <= v_today and (paused_until is null or paused_until >= v_today);
    update public.passes set status = 'active', paused_from = null, paused_until = null
     where studio_id = sid and status = 'paused' and paused_until is not null and paused_until < v_today;
    get diagnostics n = row_count; c := c + n;
  end loop;
  perform app.use_studio(null);
  return jsonb_build_object('waitlist_removed', a, 'passes_expired', b, 'pauses_ended', c);
end $$;

-- ----------------------------------------------------------------------------- timetable (0006), studio-scoped

create or replace function app.gen_sessions(p_from date, p_to date, p_template uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_sid uuid := app.current_studio_id(); v_tz text := app.studio_tz(app.current_studio_id());
begin
  if p_to < p_from or v_sid is null then return 0; end if;
  insert into public.class_sessions (studio_id, class_type_id, template_id, template_date, starts_at, ends_at, instructor_id, capacity)
  select t.studio_id, t.class_type_id, t.id, d::date,
         ((d::date + t.start_time) at time zone v_tz),
         ((d::date + t.start_time) at time zone v_tz) + make_interval(mins => ct.duration_min),
         t.instructor_id, coalesce(t.capacity, ct.default_capacity)
    from public.schedule_templates t
    join public.class_types ct on ct.id = t.class_type_id
    cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
   where t.studio_id = v_sid and t.active and ct.active
     and (p_template is null or t.id = p_template)
     and extract(dow from d) = t.weekday
     and d::date >= t.starts_on
     and (t.ends_on is null or d::date <= t.ends_on)
  on conflict (template_id, template_date) where template_id is not null and template_date is not null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Staff: this studio. The weekly cron (privileged, no studio asked for): every studio.
create or replace function public.generate_sessions(p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; sid uuid;
begin
  if not (app.is_privileged() or public.has_role('owner', 'manager', 'front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to change the schedule.');
  end if;
  if p_to - p_from > 400 then perform app.fail('INVALID', 'Please generate at most about a year at a time.'); end if;
  if app.is_privileged() and app.requested_studio() is null then
    for sid in select id from public.studios where status <> 'suspended' loop
      perform app.use_studio(sid);
      n := n + app.gen_sessions(p_from, p_to);
    end loop;
    perform app.use_studio(null);
    return n;
  end if;
  return app.gen_sessions(p_from, p_to);
end $$;

-- ----------------------------------------------------------------------------- reads (0006), studio-scoped

create or replace function public.list_class_interest(p_class_type_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_privileged() or public.is_staff()) then perform app.fail('NOT_ALLOWED', 'Only studio staff can see this.'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'client_id', c.id, 'class_type_id', i.class_type_id, 'class_name', ct.name, 'created_at', i.created_at,
             'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email, 'phone', c.phone,
             'marketing_opt_in', c.marketing_opt_in) order by i.created_at desc)
      from public.class_interest i
      join public.clients c on c.id = i.client_id
      join public.class_types ct on ct.id = i.class_type_id
     where i.studio_id = app.current_studio_id() and (p_class_type_id is null or i.class_type_id = p_class_type_id)), '[]'::jsonb);
end $$;

-- Who am I here? (the current studio)
create or replace function public.whoami() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object('kind', 'staff', 'staff_id', id, 'email', coalesce(email, ''), 'name', name, 'role', role)
       from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id()),
    (select jsonb_build_object('kind', 'client', 'client_id', id, 'email', email, 'name', trim(first_name || ' ' || last_name))
       from public.clients where user_id = auth.uid() and not archived and studio_id = app.current_studio_id()))
$$;

-- ----------------------------------------------------------------------------- sign-up linking, per studio

-- When someone signs up (or confirms their email):
--   * confirmed: link every unlinked staff row and client row with that email, in every studio
--     (one login, many studios: staff here, client there).
--   * the studio they signed up from (raw_user_meta_data.studio = slug or id, sent by the client app)
--     gets a fresh client row if they aren't one there yet.
create or replace function app.link_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := lower(coalesce(new.email, ''));
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_confirmed boolean := new.email_confirmed_at is not null;
  v_studio uuid;
  v_key text := nullif(v_meta ->> 'studio', '');
  v_id uuid;
begin
  if v_email = '' then return new; end if;
  -- No studio named (older apps, imports, the Snowy deployment): the default studio. A studio that doesn't
  -- exist: none (no client row anywhere until they join one).
  if v_key is not null then
    select id into v_studio from public.studios where id::text = v_key or slug = lower(v_key);
  else
    v_studio := app.default_studio();
  end if;

  if v_confirmed then
    update public.staff s set user_id = new.id
     where lower(s.email) = v_email and s.user_id is null
       and not exists (select 1 from public.staff x where x.user_id = new.id and x.studio_id = s.studio_id);
    -- one client row per studio: the oldest unlinked one with that email
    update public.clients c set user_id = new.id, phone = coalesce(c.phone, nullif(v_meta ->> 'phone', ''))
     where c.id in (select distinct on (studio_id) id from public.clients
                     where lower(email) = v_email and user_id is null order by studio_id, created_at)
       and not exists (select 1 from public.clients x where x.user_id = new.id and x.studio_id = c.studio_id);
  end if;
  if v_studio is null then return new; end if;
  if exists (select 1 from public.staff where user_id = new.id and studio_id = v_studio)
     or exists (select 1 from public.clients where user_id = new.id and studio_id = v_studio) then
    return new;
  end if;
  if not v_confirmed and (exists (select 1 from public.staff where lower(email) = v_email and user_id is null and studio_id = v_studio)
       or exists (select 1 from public.clients where lower(email) = v_email and user_id is null and studio_id = v_studio)) then
    return new; -- wait for confirmation before linking to an existing record
  end if;
  insert into public.clients (studio_id, user_id, first_name, last_name, email, phone, marketing_opt_in, source)
  values (v_studio, new.id, coalesce(v_meta ->> 'first_name', ''), coalesce(v_meta ->> 'last_name', ''), coalesce(new.email, ''),
          nullif(v_meta ->> 'phone', ''), coalesce((v_meta ->> 'marketing_opt_in')::boolean, false), 'app');
  return new;
end $$;

-- ----------------------------------------------------------------------------- studio checks for the other RPCs
-- Each of these keeps its body (moved to app.*_impl) behind a wrapper with the same name and arguments that
-- checks what it was given belongs to the current studio (privileged callers switch to that studio instead).

alter function public.leave_waitlist(uuid) set schema app;
alter function app.leave_waitlist(uuid) rename to leave_waitlist_impl;
create function public.leave_waitlist(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that booking.');
  return app.leave_waitlist_impl(p_booking_id);
end $$;

alter function public.move_booking(uuid, uuid) set schema app;
alter function app.move_booking(uuid, uuid) rename to move_booking_impl;
create function public.move_booking(p_booking_id uuid, p_to_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that booking.');
  perform app.assert_in_studio('class_sessions', p_to_session_id, 'We couldn''t find that class.');
  return app.move_booking_impl(p_booking_id, p_to_session_id);
end $$;

alter function public.mark_rest_no_show(uuid) set schema app;
alter function app.mark_rest_no_show(uuid) rename to mark_rest_no_show_impl;
create function public.mark_rest_no_show(p_session_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  return app.mark_rest_no_show_impl(p_session_id);
end $$;

alter function public.cancel_session(uuid, text) set schema app;
alter function app.cancel_session(uuid, text) rename to cancel_session_impl;
create function public.cancel_session(p_session_id uuid, p_reason text default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  return app.cancel_session_impl(p_session_id, p_reason);
end $$;

alter function public.credit_summary(uuid, uuid) set schema app;
alter function app.credit_summary(uuid, uuid) rename to credit_summary_impl;
create function public.credit_summary(p_client_id uuid, p_session_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  return app.credit_summary_impl(p_client_id, p_session_id);
end $$;

alter function public.is_intro_eligible(uuid) set schema app;
alter function app.is_intro_eligible(uuid) rename to is_intro_eligible_impl;
create function public.is_intro_eligible(p_client_id uuid default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  return app.is_intro_eligible_impl(p_client_id);
end $$;

alter function public.get_roster(uuid) set schema app;
alter function app.get_roster(uuid) rename to get_roster_impl;
create function public.get_roster(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  return app.get_roster_impl(p_session_id);
end $$;

alter function public.list_client_bookings(uuid, text, text[]) set schema app;
alter function app.list_client_bookings(uuid, text, text[]) rename to list_client_bookings_impl;
create function public.list_client_bookings(p_client_id uuid, p_when text default 'all', p_statuses text[] default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  return app.list_client_bookings_impl(p_client_id, p_when, p_statuses);
end $$;

alter function public.submit_waiver(uuid, jsonb) set schema app;
alter function app.submit_waiver(uuid, jsonb) rename to submit_waiver_impl;
create function public.submit_waiver(p_client_id uuid, p_health jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  return app.submit_waiver_impl(p_client_id, p_health);
end $$;

alter function public.checkout_cart(uuid, jsonb, text, integer, text) set schema app;
alter function app.checkout_cart(uuid, jsonb, text, integer, text) rename to checkout_cart_impl;
create function public.checkout_cart(
  p_client_id uuid, p_items jsonb, p_method text, p_discount_cents integer default 0, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare it record;
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  for it in select (x ->> 'product_id')::uuid as product_id from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x loop
    perform app.assert_in_studio('products', it.product_id, 'We couldn''t find one of the products.');
  end loop;
  perform app.assert_studio_open(app.current_studio_id());
  return app.checkout_cart_impl(p_client_id, p_items, p_method, p_discount_cents, p_note);
end $$;

alter function public.refund_sale(uuid, integer, boolean, text) set schema app;
alter function app.refund_sale(uuid, integer, boolean, text) rename to refund_sale_impl;
create function public.refund_sale(p_sale_id uuid, p_amount_cents integer default null, p_cancel_pass boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('sales', p_sale_id, 'We couldn''t find that sale.');
  return app.refund_sale_impl(p_sale_id, p_amount_cents, p_cancel_pass, p_reason);
end $$;

alter function public.register_interest(uuid, uuid) set schema app;
alter function app.register_interest(uuid, uuid) rename to register_interest_impl;
create function public.register_interest(p_class_type_id uuid, p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('class_types', p_class_type_id, 'We couldn''t find that class.');
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  return app.register_interest_impl(p_class_type_id, p_client_id);
end $$;

alter function public.refresh_template_sessions(uuid) set schema app;
alter function app.refresh_template_sessions(uuid) rename to refresh_template_sessions_impl;
create function public.refresh_template_sessions(p_template_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('schedule_templates', p_template_id, 'That timetable slot could not be found.');
  return app.refresh_template_sessions_impl(p_template_id);
end $$;

alter function public.delete_template(uuid) set schema app;
alter function app.delete_template(uuid) rename to delete_template_impl;
create function public.delete_template(p_template_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.assert_in_studio('schedule_templates', p_template_id, 'That timetable slot could not be found.');
  perform app.delete_template_impl(p_template_id);
end $$;

-- Stripe (service role): switch to the studio of what the event is about first.
alter function public.create_pass_from_purchase(uuid, uuid, integer, text, text, text, text, text, timestamptz) set schema app;
alter function app.create_pass_from_purchase(uuid, uuid, integer, text, text, text, text, text, timestamptz) rename to create_pass_from_purchase_impl;
create function public.create_pass_from_purchase(
  p_client_id uuid, p_product_id uuid, p_amount_cents integer, p_method text default 'card_online',
  p_stripe_checkout_session_id text default null, p_stripe_payment_intent_id text default null,
  p_stripe_invoice_id text default null, p_stripe_subscription_id text default null, p_next_billing_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client_studio uuid; v_product_studio uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Purchases are recorded by the payment system.'); end if;
  select studio_id into v_client_studio from public.clients where id = p_client_id;
  select studio_id into v_product_studio from public.products where id = p_product_id;
  if v_client_studio is distinct from v_product_studio then
    perform app.fail('INVALID', 'That product belongs to another studio.');
  end if;
  perform app.use_studio(v_client_studio);
  return app.create_pass_from_purchase_impl(p_client_id, p_product_id, p_amount_cents, p_method, p_stripe_checkout_session_id,
    p_stripe_payment_intent_id, p_stripe_invoice_id, p_stripe_subscription_id, p_next_billing_at);
end $$;

alter function public.record_membership_payment(text, text, integer, timestamptz, text) set schema app;
alter function app.record_membership_payment(text, text, integer, timestamptz, text) rename to record_membership_payment_impl;
create function public.record_membership_payment(
  p_stripe_subscription_id text, p_stripe_invoice_id text, p_amount_cents integer, p_period_end timestamptz, p_payment_intent_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Payments are recorded by the payment system.'); end if;
  perform app.use_studio((select studio_id from public.passes where stripe_subscription_id = p_stripe_subscription_id));
  return app.record_membership_payment_impl(p_stripe_subscription_id, p_stripe_invoice_id, p_amount_cents, p_period_end, p_payment_intent_id);
end $$;

alter function public.end_membership_subscription(text) set schema app;
alter function app.end_membership_subscription(text) rename to end_membership_subscription_impl;
create function public.end_membership_subscription(p_stripe_subscription_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  perform app.use_studio((select studio_id from public.passes where stripe_subscription_id = p_stripe_subscription_id));
  return app.end_membership_subscription_impl(p_stripe_subscription_id);
end $$;

alter function public.record_stripe_refund(text, integer, boolean, text) set schema app;
alter function app.record_stripe_refund(text, integer, boolean, text) rename to record_stripe_refund_impl;
create function public.record_stripe_refund(
  p_payment_intent_id text, p_refunded_cents integer, p_cancel_pass boolean default false, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  perform app.use_studio((select studio_id from public.sales where stripe_payment_intent_id = p_payment_intent_id));
  return app.record_stripe_refund_impl(p_payment_intent_id, p_refunded_cents, p_cancel_pass, p_reason);
end $$;

-- ----------------------------------------------------------------------------- people across studios

-- Studios the signed-in person belongs to.
create or replace function public.my_studios() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(m order by m ->> 'name', m ->> 'kind'), '[]'::jsonb) from (
    select jsonb_build_object('studio_id', sd.id, 'slug', sd.slug, 'name', sd.name, 'status', sd.status, 'kind', 'staff', 'role', s.role) m
      from public.staff s join public.studios sd on sd.id = s.studio_id where s.user_id = auth.uid() and s.active
    union all
    select jsonb_build_object('studio_id', sd.id, 'slug', sd.slug, 'name', sd.name, 'status', sd.status, 'kind', 'client')
      from public.clients c join public.studios sd on sd.id = c.studio_id where c.user_id = auth.uid() and not c.archived) x
$$;

-- A signed-in person becomes a client of the current studio (name and phone from their other studios / sign-up).
create or replace function public.join_studio() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sid uuid := app.current_studio_id(); u record; prev public.clients; v_id uuid;
begin
  if auth.uid() is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  if v_sid is null or not exists (select 1 from public.studios where id = v_sid and status = 'live') then
    perform app.fail('NOT_FOUND', 'That studio isn''t taking new clients right now.');
  end if;
  select id into v_id from public.clients where user_id = auth.uid() and studio_id = v_sid;
  if v_id is null then
    select * into u from auth.users where id = auth.uid();
    select * into prev from public.clients where user_id = auth.uid() order by created_at desc limit 1;
    insert into public.clients (studio_id, user_id, first_name, last_name, email, phone, marketing_opt_in, source)
    values (v_sid, auth.uid(), coalesce(prev.first_name, u.raw_user_meta_data ->> 'first_name', ''),
            coalesce(prev.last_name, u.raw_user_meta_data ->> 'last_name', ''), coalesce(u.email, ''),
            coalesce(prev.phone, nullif(u.raw_user_meta_data ->> 'phone', '')), false, 'app')
    returning id into v_id;
  end if;
  return public.whoami();
end $$;

-- ----------------------------------------------------------------------------- the studio itself

create or replace function app.studio_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) - 'is_default' from public.studios s where s.id = p_id
$$;

-- Owner / manager: details and branding of their own studio. Tax details owner only; 'live' ends onboarding (owner).
create or replace function public.update_my_studio(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sid uuid := app.current_studio_id(); s public.studios; k text;
  allowed text[] := array['name','timezone','currency','locale','email','phone','address','website','tax_id','tax_id_label','tax_name',
                          'tax_rate','tax_registered','branding','status'];
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can change the studio.'); end if;
  perform app.assert_studio_open(v_sid);
  select * into s from public.studios where id = v_sid for update;
  for k in select jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) loop
    if not k = any(allowed) then perform app.fail('INVALID', format('%s can''t be changed here.', k)); end if;
  end loop;
  if (p_patch ?| array['tax_id','tax_registered','tax_rate','tax_name','tax_id_label','currency']) and not public.has_role('owner') then
    perform app.fail('NOT_ALLOWED', 'Only the owner can change tax and currency details.');
  end if;
  if p_patch ? 'status' then
    if not public.has_role('owner') then perform app.fail('NOT_ALLOWED', 'Only the owner can open the studio.'); end if;
    if p_patch ->> 'status' <> 'live' or s.status <> 'onboarding' then perform app.fail('INVALID', 'Only a studio that is setting up can go live.'); end if;
  end if;
  if p_patch ? 'timezone' and not exists (select 1 from pg_timezone_names where name = p_patch ->> 'timezone') then
    perform app.fail('INVALID', 'That timezone isn''t recognised.');
  end if;
  if p_patch ? 'name' and coalesce(trim(p_patch ->> 'name'), '') = '' then perform app.fail('INVALID', 'Please enter the studio name.'); end if;
  update public.studios set
    name = coalesce(p_patch ->> 'name', name), timezone = coalesce(p_patch ->> 'timezone', timezone),
    currency = coalesce(p_patch ->> 'currency', currency), locale = coalesce(p_patch ->> 'locale', locale),
    email = coalesce(p_patch ->> 'email', email),
    phone = case when p_patch ? 'phone' then nullif(p_patch ->> 'phone', '') else phone end,
    address = coalesce(p_patch ->> 'address', address),
    website = case when p_patch ? 'website' then nullif(p_patch ->> 'website', '') else website end,
    tax_id = case when p_patch ? 'tax_id' then nullif(p_patch ->> 'tax_id', '') else tax_id end,
    tax_id_label = coalesce(p_patch ->> 'tax_id_label', tax_id_label), tax_name = coalesce(p_patch ->> 'tax_name', tax_name),
    tax_rate = coalesce((p_patch ->> 'tax_rate')::numeric, tax_rate),
    tax_registered = coalesce((p_patch ->> 'tax_registered')::boolean, tax_registered),
    branding = coalesce(p_patch -> 'branding', branding),
    status = coalesce(p_patch ->> 'status', status)
   where id = v_sid;
  select * into s from public.studios where id = v_sid;
  update public.studio_settings set name = s.name, timezone = s.timezone, address = s.address, email = s.email, phone = s.phone,
         abn = s.tax_id, gst_registered = s.tax_registered
   where studio_id = v_sid;
  perform app.audit('update_studio', 'studios', v_sid::text, p_patch - 'branding');
  return app.studio_json(v_sid);
end $$;

-- ----------------------------------------------------------------------------- platform admin (Pete)

create or replace function app.require_platform_admin() returns void
language plpgsql stable as $$
begin
  if not (app.is_privileged() or app.is_platform_admin()) then perform app.fail('NOT_ALLOWED', 'Only platform admins can do that.'); end if;
end $$;

create or replace function app.check_slug(p_slug text, p_except uuid default null) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text := lower(trim(coalesce(p_slug, '')));
begin
  if v !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then
    perform app.fail('INVALID', 'The web address can use lowercase letters, numbers and dashes (2 to 40 characters).');
  end if;
  if v = any(array['www','app','admin','studio','studios','api','platform','help','mail','s']) then
    perform app.fail('INVALID', format('"%s" is reserved. Try another web address.', v));
  end if;
  if exists (select 1 from public.studios where slug = v and id is distinct from p_except) then
    perform app.fail('SLUG_TAKEN', 'Another studio already uses that web address.');
  end if;
  return v;
end $$;

create or replace function public.platform_create_studio(
  p_name text, p_slug text, p_email text, p_timezone text default 'Australia/Sydney', p_currency text default 'AUD',
  p_locale text default 'en-AU', p_phone text default null, p_address text default '', p_branding jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_slug text; v_id uuid;
begin
  perform app.require_platform_admin();
  if coalesce(trim(p_name), '') = '' then perform app.fail('INVALID', 'Please enter the studio name.'); end if;
  if coalesce(p_email, '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then perform app.fail('INVALID', 'Please enter the studio''s email address.'); end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then perform app.fail('INVALID', 'That timezone isn''t recognised.'); end if;
  v_slug := app.check_slug(p_slug);
  insert into public.studios (slug, name, timezone, currency, locale, email, phone, address, branding, status)
  values (v_slug, trim(p_name), p_timezone, upper(p_currency), p_locale, trim(p_email), nullif(p_phone, ''), coalesce(p_address, ''),
          coalesce(p_branding, '{}'::jsonb), 'onboarding')
  returning id into v_id;
  perform app.use_studio(v_id);
  insert into public.studio_settings (studio_id, name, timezone, address, email, phone, gst_registered, cancel_window_hours,
    waitlist_cutoff_hours, booking_window_days, default_capacity, waiver_text, health_questions, cancellation_policy_text, waitlist_policy_text)
  values (v_id, trim(p_name), p_timezone, coalesce(p_address, ''), trim(p_email), nullif(p_phone, ''), true, 12, 1, 14, 10,
    format('I take part in classes at %s at my own risk and will work within my limits. I''ve told the studio about any injury, condition or pregnancy, and I agree to the booking and cancellation policies.', trim(p_name)),
    array['Do you have any current injuries or pain?', 'Are you pregnant, or have you had a baby in the last 12 months?', 'Is there anything else your instructor should know?'],
    'Cancel at least 12 hours before class to get your credit back. Later cancellations and no-shows lose the credit.',
    'If a class is full, join the waitlist. If a spot opens, the first person with a credit is booked in automatically.');
  perform app.audit('platform_create_studio', 'studios', v_id::text, jsonb_build_object('slug', v_slug));
  perform app.use_studio(null);
  return app.studio_json(v_id);
end $$;

create or replace function public.platform_update_studio(p_studio_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.studios;
begin
  perform app.require_platform_admin();
  select * into s from public.studios where id = p_studio_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'That studio could not be found.'); end if;
  if p_patch ? 'status' and p_patch ->> 'status' not in ('onboarding','live','suspended') then perform app.fail('INVALID', 'Unknown status.'); end if;
  update public.studios set
    slug = case when p_patch ? 'slug' then app.check_slug(p_patch ->> 'slug', p_studio_id) else slug end,
    name = coalesce(p_patch ->> 'name', name), timezone = coalesce(p_patch ->> 'timezone', timezone),
    currency = coalesce(p_patch ->> 'currency', currency), locale = coalesce(p_patch ->> 'locale', locale),
    email = coalesce(p_patch ->> 'email', email),
    phone = case when p_patch ? 'phone' then nullif(p_patch ->> 'phone', '') else phone end,
    address = coalesce(p_patch ->> 'address', address),
    website = case when p_patch ? 'website' then nullif(p_patch ->> 'website', '') else website end,
    tax_id = case when p_patch ? 'tax_id' then nullif(p_patch ->> 'tax_id', '') else tax_id end,
    tax_id_label = coalesce(p_patch ->> 'tax_id_label', tax_id_label), tax_name = coalesce(p_patch ->> 'tax_name', tax_name),
    tax_rate = coalesce((p_patch ->> 'tax_rate')::numeric, tax_rate),
    tax_registered = coalesce((p_patch ->> 'tax_registered')::boolean, tax_registered),
    branding = coalesce(p_patch -> 'branding', branding),
    custom_domains = case when p_patch ? 'custom_domains' then array(select jsonb_array_elements_text(p_patch -> 'custom_domains')) else custom_domains end,
    status = coalesce(p_patch ->> 'status', status)
   where id = p_studio_id;
  select * into s from public.studios where id = p_studio_id;
  perform app.use_studio(p_studio_id);
  update public.studio_settings set name = s.name, timezone = s.timezone, address = s.address, email = s.email, phone = s.phone,
         abn = s.tax_id, gst_registered = s.tax_registered
   where studio_id = p_studio_id;
  perform app.audit('platform_update_studio', 'studios', p_studio_id::text, p_patch - 'branding');
  perform app.use_studio(null);
  return app.studio_json(p_studio_id);
end $$;

create or replace function public.platform_set_studio_status(p_studio_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.platform_update_studio(p_studio_id, jsonb_build_object('status', p_status));
end $$;

-- Adds (or promotes) the studio's owner. The invite email itself is sent by the invite-user edge function.
create or replace function public.platform_invite_owner(p_studio_id uuid, p_name text, p_email text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform app.require_platform_admin();
  if not exists (select 1 from public.studios where id = p_studio_id) then perform app.fail('NOT_FOUND', 'That studio could not be found.'); end if;
  if coalesce(trim(p_name), '') = '' then perform app.fail('INVALID', 'Please enter the owner''s name.'); end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then perform app.fail('INVALID', 'Please enter the owner''s email address.'); end if;
  perform app.use_studio(p_studio_id);
  select id into v_id from public.staff where studio_id = p_studio_id and lower(email) = v_email;
  if v_id is null then
    insert into public.staff (studio_id, name, email, role, active) values (p_studio_id, trim(p_name), v_email, 'owner', true) returning id into v_id;
  else
    update public.staff set role = 'owner', active = true, name = trim(p_name) where id = v_id;
  end if;
  perform app.audit('platform_invite_owner', 'staff', v_id::text, jsonb_build_object('email', v_email));
  perform app.use_studio(null);
  return (select to_jsonb(s) - 'user_id' from public.staff s where id = v_id);
end $$;

create or replace function public.platform_studio_stats() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_platform_admin();
  return coalesce((select jsonb_object_agg(sd.id, jsonb_build_object(
      'clients', (select count(*) from public.clients c where c.studio_id = sd.id and not c.archived),
      'staff', (select count(*) from public.staff s where s.studio_id = sd.id and s.active),
      'classes_next_7_days', (select count(*) from public.class_sessions x where x.studio_id = sd.id and x.status = 'scheduled'
                                and x.starts_at >= app.now() and x.starts_at < app.now() + interval '7 days')))
    from public.studios sd), '{}'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- grants
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.now(), app.tz(), app.is_privileged(), app.current_studio_id(), app.requested_studio(),
  app.default_studio(), app.in_scope(uuid), app.is_platform_admin(), app.staff_role_in(uuid), app.has_role_in(uuid, text[]),
  app.is_staff_of(uuid), app.client_id_in(uuid), app.staff_id_in(uuid), app.is_member_of(uuid), app.fail(text, text),
  app.can_write_avatar(text), app.can_write_branding(text), app.guard_studio() to anon, authenticated;
-- The service role (edge functions) is fully trusted; our invoker-side triggers call these helpers as it.
grant execute on all functions in schema app to service_role;

revoke execute on function public.leave_waitlist, public.move_booking, public.mark_rest_no_show, public.cancel_session,
  public.credit_summary, public.is_intro_eligible, public.get_roster, public.list_client_bookings, public.submit_waiver,
  public.checkout_cart, public.refund_sale, public.register_interest, public.refresh_template_sessions, public.delete_template,
  public.my_studios, public.join_studio, public.update_my_studio, public.platform_create_studio, public.platform_update_studio,
  public.platform_set_studio_status, public.platform_invite_owner, public.platform_studio_stats
  from public, anon;
grant execute on function public.leave_waitlist, public.move_booking, public.mark_rest_no_show, public.cancel_session,
  public.credit_summary, public.is_intro_eligible, public.get_roster, public.list_client_bookings, public.submit_waiver,
  public.checkout_cart, public.refund_sale, public.register_interest, public.refresh_template_sessions, public.delete_template,
  public.my_studios, public.join_studio, public.update_my_studio, public.platform_create_studio, public.platform_update_studio,
  public.platform_set_studio_status, public.platform_invite_owner, public.platform_studio_stats
  to authenticated;
revoke execute on function public.create_pass_from_purchase, public.record_membership_payment, public.end_membership_subscription,
  public.record_stripe_refund from public, anon, authenticated;
grant execute on function public.is_intro_eligible to anon;
grant execute on all functions in schema public to service_role;
