-- =============================================================================
-- Snowy Pilates Club: schema, helper functions, row level security.
-- Mirrors src/shared/types.ts (snake_case columns, uuid ids, timestamptz, integer cents).
-- Booking rules live in 0002_booking.sql; money/reports in 0003_money.sql.
--
-- Security model in one paragraph:
--   * Every table has RLS on. Clients only ever see their own rows.
--   * Nobody writes bookings, passes or sales directly through the API. All of that goes
--     through SECURITY DEFINER functions (supabase.rpc) that apply RULES.md in one
--     transaction with row locks.
--   * Staff permissions come from staff.role (owner, manager, front_desk, instructor).
--   * Internal helpers live in schema "app", which is not exposed by the API.
-- =============================================================================

create extension if not exists pgcrypto;

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- "Now", overridable in tests only (set_config('app.now', ...) can't be reached through the API).
create or replace function app.now() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())
$$;
grant execute on function app.now() to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- tables

create table public.studio_settings (
  id smallint primary key default 1 check (id = 1),
  name text not null default 'Snowy Pilates Club',
  timezone text not null default 'Australia/Sydney',
  address text not null default '',
  email text not null default '',
  phone text,
  abn text,
  gst_registered boolean not null default true,
  cancel_window_hours numeric(5,2) not null default 3 check (cancel_window_hours >= 0),
  waitlist_cutoff_hours numeric(5,2) not null default 1 check (waitlist_cutoff_hours >= 0),
  late_cancel_fee_cents integer not null default 0 check (late_cancel_fee_cents >= 0),
  no_show_fee_cents integer not null default 0 check (no_show_fee_cents >= 0),
  booking_window_days integer not null default 14 check (booking_window_days between 1 and 365),
  default_capacity integer not null default 14 check (default_capacity > 0),
  waiver_text text not null default '',
  health_questions text[] not null default '{}',
  cancellation_policy_text text not null default '',
  waitlist_policy_text text not null default '',
  updated_at timestamptz not null default now()
);

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text,
  phone text,
  role text not null check (role in ('owner','manager','instructor','front_desk')),
  bio text,
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index staff_email_key on public.staff (lower(email)) where email is not null and email <> '';

-- Pay rates are owner-only, so they live in their own table (RLS can't hide one column).
create table public.staff_pay (
  staff_id uuid primary key references public.staff(id) on delete cascade,
  pay_per_class_cents integer not null default 0 check (pay_per_class_cents >= 0),
  updated_at timestamptz not null default now()
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone text,
  birthday date,
  created_at timestamptz not null default app.now(),
  injuries text,
  emergency_contact_name text,
  emergency_contact_phone text,
  waiver_signed_at timestamptz,
  health_form jsonb,
  marketing_opt_in boolean not null default false,
  source text not null default 'app' check (source in ('app','staff','import')),
  archived boolean not null default false,
  -- Set on import when someone already bought from the studio before (so no intro offer).
  intro_ineligible boolean not null default false,
  momence_id text unique
);
create index clients_email_idx on public.clients (lower(email));
create index clients_name_idx on public.clients (lower(first_name), lower(last_name));

-- Staff-only notes (may mention payments), hidden from clients and instructors.
create table public.client_notes (
  client_id uuid primary key references public.clients(id) on delete cascade,
  notes text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff(id) on delete set null
);

create table public.class_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  duration_min integer not null check (duration_min between 5 and 600),
  color text not null default '#5069AC',
  default_capacity integer not null default 14 check (default_capacity > 0),
  level text,
  booking_note text,
  bookable boolean not null default true,
  active boolean not null default true,
  sort_order integer not null default 0
);

create table public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  class_type_id uuid not null references public.class_types(id),
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_time time not null,
  instructor_id uuid not null references public.staff(id),
  capacity integer check (capacity > 0),
  starts_on date not null default current_date,
  ends_on date,
  active boolean not null default true,
  check (ends_on is null or ends_on >= starts_on)
);

create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  class_type_id uuid not null references public.class_types(id),
  template_id uuid references public.schedule_templates(id) on delete set null,
  -- Studio-local date the template generated this for (keeps generate_sessions idempotent
  -- even after a class is moved to another time).
  template_date date,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  instructor_id uuid not null references public.staff(id),
  capacity integer not null check (capacity >= 0),
  status text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  note text,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index class_sessions_starts_idx on public.class_sessions (starts_at);
create index class_sessions_instructor_idx on public.class_sessions (instructor_id, starts_at);
create unique index class_sessions_template_date_key on public.class_sessions (template_id, template_date)
  where template_id is not null and template_date is not null;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('membership','pack','intro','dropin','retail')),
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  active boolean not null default true,
  highlight text,
  sort_order integer not null default 0,
  credits integer check (credits is null or credits > 0),
  validity_days integer check (validity_days is null or validity_days > 0),
  billing_interval text check (billing_interval in ('week','month')),
  new_clients_only boolean not null default false,
  class_type_ids uuid[],
  stock integer,
  -- Optional: a pre-made Stripe Price. If empty, checkout sends the price inline.
  stripe_price_id text,
  check (kind <> 'membership' or billing_interval is not null)
);

create table public.passes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  kind text not null check (kind in ('membership','pack','intro','dropin')),
  name text not null,
  status text not null default 'active' check (status in ('active','paused','expired','cancelled','used_up')),
  purchased_at timestamptz not null default app.now(),
  activated_at timestamptz,
  expires_at timestamptz,
  validity_days integer,           -- copied from the product at purchase
  credits integer,                 -- pack/dropin total; membership per week; null = unlimited
  credits_used integer not null default 0 check (credits_used >= 0),
  billing_interval text check (billing_interval in ('week','month')),
  next_billing_at timestamptz,
  paused_from date,
  paused_until date,
  cancel_at_period_end boolean not null default false,
  price_cents integer not null default 0,
  class_type_ids uuid[],
  sale_id uuid,
  stripe_subscription_id text unique,
  momence_id text,
  created_at timestamptz not null default now()
);
create index passes_client_idx on public.passes (client_id, status);

create table public.pass_adjustments (
  id uuid primary key default gen_random_uuid(),
  pass_id uuid not null references public.passes(id) on delete cascade,
  at timestamptz not null default app.now(),
  staff_id uuid references public.staff(id) on delete set null,
  delta integer not null default 0,
  new_expires_at timestamptz,
  reason text not null
);
create index pass_adjustments_pass_idx on public.pass_adjustments (pass_id, at);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null check (status in ('booked','waitlisted','checked_in','cancelled','late_cancelled','no_show','removed')),
  pass_id uuid references public.passes(id) on delete set null,
  created_at timestamptz not null default app.now(),
  waitlist_position integer,
  promoted_from_waitlist_at timestamptz,
  cancelled_at timestamptz,
  checked_in_at timestamptz,
  source text not null default 'client' check (source in ('client','staff')),
  booked_by_staff_id uuid references public.staff(id) on delete set null,
  reminder_sent_at timestamptz,
  updated_at timestamptz not null default now()
);
-- One active booking (booked, waitlisted or checked in) per client per class.
create unique index bookings_one_active_per_client
  on public.bookings (session_id, client_id) where status in ('booked','waitlisted','checked_in');
create index bookings_session_idx on public.bookings (session_id, status);
create index bookings_client_idx on public.bookings (client_id, created_at desc);
create index bookings_pass_idx on public.bookings (pass_id) where pass_id is not null;

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  total_cents integer not null,
  method text not null check (method in ('card_online','card_reader','cash','comp','imported')),
  staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default app.now(),
  stripe_payment_intent_id text unique,
  stripe_checkout_session_id text unique,
  stripe_invoice_id text unique,
  refunded_at timestamptz,
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  note text
);
create index sales_created_idx on public.sales (created_at);
create index sales_client_idx on public.sales (client_id, created_at desc);

alter table public.passes add constraint passes_sale_fk foreign key (sale_id) references public.sales(id) on delete set null;

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name text not null,
  qty integer not null default 1,
  unit_cents integer not null,
  kind text check (kind in ('membership','pack','intro','dropin','retail','discount'))
);
create index sale_items_sale_idx on public.sale_items (sale_id);

create table public.stripe_customers (
  client_id uuid primary key references public.clients(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

-- Stripe webhook events we've already processed (idempotency).
create table public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios','android','web')),
  created_at timestamptz not null default now()
);

-- Emails/pushes waiting to go out. The send-email edge function drains this.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  kind text not null check (kind in ('booking_confirmed','waitlist_promoted','class_cancelled','receipt','class_reminder','late_cancel')),
  to_email text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  error text
);
create index notifications_pending_idx on public.notifications (created_at) where sent_at is null;

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  actor_staff_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb
);
create index audit_log_at_idx on public.audit_log (at desc);

-- ----------------------------------------------------------------------------- helpers


create or replace function app.tz() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select timezone from public.studio_settings where id = 1), 'Australia/Sydney')
$$;

-- True for the SQL editor / psql, migrations and the service_role key (edge functions).
create or replace function app.is_privileged() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('role', true), ''), 'none') in ('none','postgres','service_role','supabase_admin')
$$;

create or replace function public.current_staff_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.staff where user_id = auth.uid() and active
$$;

create or replace function public.current_client_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.clients where user_id = auth.uid()
$$;

create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.staff where user_id = auth.uid() and active
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active)
$$;

create or replace function public.has_role(variadic roles text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = any(roles) from public.staff where user_id = auth.uid() and active), false)
$$;

-- Raise a StoreError-shaped exception: 'CODE: message'.
create or replace function app.fail(code text, msg text) returns void
language plpgsql as $$
begin
  raise exception '%: %', code, msg using errcode = 'P0001';
end $$;

create or replace function app.audit(p_action text, p_entity text, p_entity_id text, p_details jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (actor_user_id, actor_staff_id, action, entity, entity_id, details)
  values (auth.uid(), public.current_staff_id(), p_action, p_entity, p_entity_id, p_details)
$$;

-- Generic audit trigger for sensitive tables.
create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  perform app.audit(lower(tg_op), tg_table_name, rec ->> case when tg_table_name = 'studio_settings' then 'id' when tg_table_name = 'staff_pay' then 'staff_id' else 'id' end,
    case when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) else rec end);
  return null;
end $$;

create trigger audit_staff after insert or update or delete on public.staff for each row execute function app.audit_trigger();
create trigger audit_staff_pay after insert or update or delete on public.staff_pay for each row execute function app.audit_trigger();
create trigger audit_settings after update on public.studio_settings for each row execute function app.audit_trigger();
create trigger audit_products after insert or update or delete on public.products for each row execute function app.audit_trigger();
create trigger audit_passes after update or delete on public.passes for each row execute function app.audit_trigger();
create trigger audit_sales after update or delete on public.sales for each row execute function app.audit_trigger();

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger touch_settings before update on public.studio_settings for each row execute function app.touch_updated_at();
create trigger touch_sessions before update on public.class_sessions for each row execute function app.touch_updated_at();
create trigger touch_bookings before update on public.bookings for each row execute function app.touch_updated_at();

-- Any booking change bumps its class's updated_at, so realtime listeners on class_sessions
-- (which everyone may read) learn that spot counts changed without seeing other people's bookings.
create or replace function app.bump_session() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.class_sessions set updated_at = now()
   where id = coalesce(new.session_id, old.session_id);
  return null;
end $$;
create trigger bookings_bump_session after insert or update or delete on public.bookings
  for each row execute function app.bump_session();

-- Settings: only the owner may change the ABN (RULES: managers can't touch ABN/bank/Stripe).
create or replace function app.guard_settings() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() and new.abn is distinct from old.abn and not public.has_role('owner') then
    perform app.fail('NOT_ALLOWED', 'Only the owner can change the ABN.');
  end if;
  return new;
end $$;
create trigger guard_settings before update on public.studio_settings for each row execute function app.guard_settings();

-- Staff: managers can't create/modify owners or promote anyone to owner.
create or replace function app.guard_staff() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.is_privileged() or public.has_role('owner') then return coalesce(new, old); end if;
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
create trigger guard_staff before insert or update or delete on public.staff for each row execute function app.guard_staff();

-- Adding a staff member whose login already exists (same email, confirmed) links it straight away.
create or replace function app.link_staff_login() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is null and coalesce(new.email, '') <> '' then
    select u.id into new.user_id from auth.users u
     where lower(u.email) = lower(new.email) and u.email_confirmed_at is not null
       and not exists (select 1 from public.staff s where s.user_id = u.id and s.id <> new.id);
  end if;
  return new;
end $$;
create trigger link_staff_login before insert or update of email on public.staff for each row execute function app.link_staff_login();

-- Clients editing their own row can't touch staff-controlled fields.
create or replace function app.guard_client() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.is_privileged() or public.is_staff() then return new; end if;
  new.user_id := old.user_id;
  new.email := old.email;            -- changed through Supabase Auth, not here
  new.created_at := old.created_at;
  new.source := old.source;
  new.archived := old.archived;
  new.intro_ineligible := old.intro_ineligible;
  new.momence_id := old.momence_id;
  new.waiver_signed_at := old.waiver_signed_at;  -- use submit_waiver()
  new.health_form := old.health_form;
  return new;
end $$;
create trigger guard_client before update on public.clients for each row execute function app.guard_client();

-- ----------------------------------------------------------------------------- public views
-- These run with the owner's rights (bypassing RLS) on purpose, and expose only safe columns.

-- Timetable with live counts. Contains no client data, so anon may read it.
create or replace view public.sessions_with_counts as
select s.id, s.class_type_id, s.template_id, s.starts_at, s.ends_at, s.instructor_id, s.capacity,
       s.status, s.note, s.cancel_reason, s.updated_at,
       coalesce(c.booked, 0)::int as booked_count,
       coalesce(c.waitlisted, 0)::int as waitlist_count,
       greatest(0, s.capacity - coalesce(c.booked, 0))::int as spots_left
  from public.class_sessions s
  left join lateral (
    select count(*) filter (where b.status in ('booked','checked_in')) as booked,
           count(*) filter (where b.status = 'waitlisted') as waitlisted
      from public.bookings b where b.session_id = s.id
  ) c on true;

-- Staff public profile: no email, phone or pay.
create or replace view public.staff_public as
select id, name, role, bio, photo_url, active from public.staff;

grant select on public.sessions_with_counts, public.staff_public to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------- RLS

alter table public.studio_settings enable row level security;
alter table public.staff enable row level security;
alter table public.staff_pay enable row level security;
alter table public.clients enable row level security;
alter table public.client_notes enable row level security;
alter table public.class_types enable row level security;
alter table public.schedule_templates enable row level security;
alter table public.class_sessions enable row level security;
alter table public.products enable row level security;
alter table public.passes enable row level security;
alter table public.pass_adjustments enable row level security;
alter table public.bookings enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.stripe_events enable row level security;
alter table public.push_tokens enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;

-- settings: anyone can read (policies, waiver text); owner/manager edit.
create policy settings_read on public.studio_settings for select to anon, authenticated using (true);
create policy settings_write on public.studio_settings for update to authenticated
  using (public.has_role('owner','manager')) with check (public.has_role('owner','manager'));

-- staff: staff see the staff list (incl. email/phone). Everyone else uses staff_public.
create policy staff_read on public.staff for select to authenticated using (public.is_staff());
create policy staff_insert on public.staff for insert to authenticated with check (public.has_role('owner','manager'));
create policy staff_update on public.staff for update to authenticated
  using (public.has_role('owner','manager')) with check (public.has_role('owner','manager'));
create policy staff_delete on public.staff for delete to authenticated using (public.has_role('owner'));

-- pay: owner only.
create policy staff_pay_owner on public.staff_pay for all to authenticated
  using (public.has_role('owner')) with check (public.has_role('owner'));

-- clients: own row; staff read all; owner/manager/front desk edit.
create policy clients_read_own on public.clients for select to authenticated
  using (user_id = auth.uid() or public.is_staff());
create policy clients_update_own on public.clients for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy clients_staff_insert on public.clients for insert to authenticated
  with check (public.has_role('owner','manager','front_desk'));
create policy clients_staff_update on public.clients for update to authenticated
  using (public.has_role('owner','manager','front_desk')) with check (public.has_role('owner','manager','front_desk'));

create policy client_notes_staff on public.client_notes for all to authenticated
  using (public.has_role('owner','manager','front_desk')) with check (public.has_role('owner','manager','front_desk'));

-- class types: public read of active; owner/manager write.
create policy class_types_read on public.class_types for select to anon, authenticated
  using (active or public.is_staff());
create policy class_types_write on public.class_types for all to authenticated
  using (public.has_role('owner','manager')) with check (public.has_role('owner','manager'));

-- templates: staff read; owner/manager/front desk write (front desk runs the schedule).
create policy templates_read on public.schedule_templates for select to authenticated using (public.is_staff());
create policy templates_write on public.schedule_templates for all to authenticated
  using (public.has_role('owner','manager','front_desk')) with check (public.has_role('owner','manager','front_desk'));

-- sessions: public read (no personal data); schedule staff write. Cancelling goes via cancel_session().
create policy sessions_read on public.class_sessions for select to anon, authenticated using (true);
create policy sessions_insert on public.class_sessions for insert to authenticated
  with check (public.has_role('owner','manager','front_desk') and status = 'scheduled');
create policy sessions_update on public.class_sessions for update to authenticated
  using (public.has_role('owner','manager','front_desk')) with check (public.has_role('owner','manager','front_desk'));

-- products: public read of active; owner/manager write.
create policy products_read on public.products for select to anon, authenticated
  using (active or public.is_staff());
create policy products_write on public.products for all to authenticated
  using (public.has_role('owner','manager')) with check (public.has_role('owner','manager'));

-- passes: read own / staff (not instructors). No direct writes from the API at all.
create policy passes_read on public.passes for select to authenticated
  using (client_id = public.current_client_id() or public.has_role('owner','manager','front_desk'));
create policy pass_adjustments_read on public.pass_adjustments for select to authenticated
  using (public.has_role('owner','manager','front_desk')
         or exists (select 1 from public.passes p where p.id = pass_id and p.client_id = public.current_client_id()));

-- bookings: read own; staff read all, except instructors who see their own classes only.
create policy bookings_read on public.bookings for select to authenticated
  using (
    client_id = public.current_client_id()
    or public.has_role('owner','manager','front_desk')
    or (public.has_role('instructor') and exists (
          select 1 from public.class_sessions s where s.id = session_id and s.instructor_id = public.current_staff_id()))
  );

-- sales: read own; owner/manager/front desk (POS). Instructors never.
create policy sales_read on public.sales for select to authenticated
  using (client_id = public.current_client_id() or public.has_role('owner','manager','front_desk'));
create policy sale_items_read on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id
                 and (s.client_id = public.current_client_id() or public.has_role('owner','manager','front_desk'))));

-- push tokens: your own.
create policy push_tokens_own on public.push_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- audit log: owner/manager read.
create policy audit_read on public.audit_log for select to authenticated using (public.has_role('owner','manager'));

-- stripe_customers, stripe_events, notifications: no policies = service role / SQL only.

-- Belt and braces: the API roles can't write money tables directly even if a policy slips in later.
revoke insert, update, delete on public.passes, public.pass_adjustments, public.bookings, public.sales,
  public.sale_items, public.stripe_customers, public.stripe_events, public.notifications, public.audit_log
  from anon, authenticated;
revoke all on public.stripe_customers, public.stripe_events, public.notifications from anon, authenticated;
revoke insert, update, delete on public.studio_settings, public.staff, public.staff_pay, public.clients,
  public.client_notes, public.class_types, public.schedule_templates, public.class_sessions, public.products
  from anon;

-- Realtime (RLS applies to what each listener receives).
alter publication supabase_realtime add table public.bookings, public.class_sessions, public.passes;
