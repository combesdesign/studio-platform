-- 0012_platform_billing.sql: plans + platform billing (docs/PLATFORM.md, "Plans and billing").
--
-- Studios on the platform pay Pete a monthly plan; each plan switches features on or off. Plans are DATA, edited in the admin:
--   public.plans                     name, monthly price (cents, AUD), Stripe price id, feature keys. Anyone may read (it is a price list);
--                                    only platform admins write, through platform_save_plan().
--   public.platform_billing_settings one row: free trial length (14 or 30 days) and the past-due grace period (default 14 days).
--   public.studios                   gains plan_id, billing_status (trialing / active / past_due / cancelled), trial_ends_at,
--                                    past_due_since, billing_comped. The studio list is public, so these are public too: they say which
--                                    features a studio has (the client app needs that), not what it pays or how.
--   public.studio_billing            the private part (Stripe customer / subscription ids, renewal date): the studio's OWNER reads it
--                                    (my_billing()); nobody writes it from an app. The platform-subscribe / platform-portal /
--                                    platform-webhook edge functions (service role) write it through billing_apply().
--
-- Gating: app.studio_has_feature(studio, key) is the one SQL helper (the TypeScript twin is hasFeature in src/shared/plans.ts). A
-- studio that is not on a plan has everything on. Past due: after the grace period the studio is read-only for STAFF
-- (app.studio_read_only + a guard trigger on the staff-written tables); clients can still book. Feature RPCs call
-- app.require_feature from 2100_plan_gating.sql (it has to come after the feature migrations).

-- ----------------------------------------------------------------------------- plans + settings
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (length(trim(name)) > 0),
  price_cents integer not null default 0 check (price_cents >= 0),
  stripe_price_id text check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  features text[] not null default array['core'],
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plans enable row level security;
revoke all on public.plans from anon, authenticated;
grant select on public.plans to anon, authenticated;
grant all on public.plans to service_role;
create policy plans_read on public.plans for select to anon, authenticated using (true);

create table public.platform_billing_settings (
  id boolean primary key default true check (id),
  trial_days integer not null default 14 check (trial_days in (14, 30)),
  grace_days integer not null default 14 check (grace_days between 0 and 90),
  updated_at timestamptz not null default now()
);
alter table public.platform_billing_settings enable row level security;
revoke all on public.platform_billing_settings from anon, authenticated;
grant select on public.platform_billing_settings to anon, authenticated;
grant all on public.platform_billing_settings to service_role;
create policy platform_billing_settings_read on public.platform_billing_settings for select to anon, authenticated using (true);
insert into public.platform_billing_settings (id) values (true) on conflict do nothing;

-- The draft plans (Pete edits them in the admin; Stripe price ids are filled in there once the Stripe products exist).
insert into public.plans (id, key, name, price_cents, features, sort_order) values
  ('9c000000-0000-4000-8000-000000000001', 'studio', 'Studio', 9900,
    array['core','kiosk','reviews','marketing','support','family'], 10),
  ('9c000000-0000-4000-8000-000000000002', 'studio_plus', 'Studio Plus', 17900,
    array['core','kiosk','reviews','marketing','support','family','appointments','ondemand','commerce','payroll','integrations'], 20),
  ('9c000000-0000-4000-8000-000000000003', 'signature', 'Signature', 29900,
    array['core','kiosk','reviews','marketing','support','family','appointments','ondemand','commerce','payroll','integrations','branded_app','custom_domain','multi_location'], 30)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------- studios: plan + status
alter table public.studios
  add column plan_id uuid references public.plans(id) on delete restrict,
  add column billing_status text check (billing_status in ('trialing','active','past_due','cancelled')),
  add column trial_ends_at timestamptz,
  add column past_due_since timestamptz,
  add column billing_comped boolean not null default false;

-- Snowy is studio #1: Signature, comped (it is Pete's own studio, there is nothing to pay).
update public.studios set plan_id = '9c000000-0000-4000-8000-000000000003', billing_status = 'active', billing_comped = true
 where is_default and plan_id is null;

-- A studio created through platform_create_studio starts on the first (cheapest) active plan, on a free trial (redefined at the end of this file).
-- (Studios inserted some other way have no plan and nothing locked, so the isolation tests that insert bare studios keep working.)

create or replace function app.studio_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) - 'is_default' || jsonb_build_object('plan',
           (select jsonb_build_object('id', p.id, 'name', p.name, 'price_cents', p.price_cents, 'features', p.features) from public.plans p where p.id = s.plan_id))
    from public.studios s where s.id = p_id
$$;

-- The private part: Stripe ids and the renewal date. The studio's owner reads it; only the edge functions write it.
create table public.studio_billing (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.studio_billing enable row level security;
revoke all on public.studio_billing from anon, authenticated;
grant select on public.studio_billing to authenticated;
grant all on public.studio_billing to service_role;
create policy studio_billing_owner_read on public.studio_billing for select to authenticated
  using (app.has_role_in(studio_id, 'owner'));
create policy studio_scope on public.studio_billing as restrictive for all to anon, authenticated
  using (app.in_scope(studio_id)) with check (app.in_scope(studio_id));

-- ----------------------------------------------------------------------------- the rules
-- Is `p_key` switched on for this studio? 'core' (and no key) always. A studio that is not on a plan has everything on.
create or replace function app.studio_has_feature(p_studio uuid, p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select case when p_key is null or p_key = 'core' or s.plan_id is null then true else p_key = any (pl.features) end
      from public.studios s left join public.plans pl on pl.id = s.plan_id
     where s.id = p_studio), false)
$$;

-- For feature RPC entry points: the current studio's plan must include the feature. Our own scheduled jobs (service role) are not gated.
create or replace function app.require_feature(p_key text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if app.is_privileged() then return; end if;
  if not app.studio_has_feature(app.current_studio_id(), p_key) then
    perform app.fail('FEATURE_LOCKED', 'That isn''t part of this studio''s plan yet.');
  end if;
end $$;

-- Past due for longer than the grace period, trial over for longer than the grace period, or cancelled: staff can look, not change.
create or replace function app.studio_read_only(p_studio uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select case s.billing_status
      when 'cancelled' then true
      when 'past_due' then now() >= coalesce(s.past_due_since, now()) + make_interval(days => g.grace_days)
      when 'trialing' then s.trial_ends_at is not null and now() >= s.trial_ends_at + make_interval(days => g.grace_days)
      else false end
      from public.studios s cross join public.platform_billing_settings g
     where s.id = p_studio), false)
$$;

-- Staff writes in a read-only studio are refused (clients still book: they are not staff, or they are writing their own client row).
create or replace function app.billing_read_only_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_studio uuid := (rec ->> 'studio_id')::uuid;
  v_self text := coalesce(rec ->> 'client_id', case when tg_table_name = 'clients' then rec ->> 'id' end);
begin
  if app.is_privileged() or app.is_platform_admin() or auth.uid() is null or v_studio is null then return coalesce(new, old); end if;
  if app.is_staff_of(v_studio) and app.studio_read_only(v_studio)
     and (v_self is null or v_self is distinct from app.client_id_in(v_studio)::text) then
    perform app.fail('READ_ONLY', 'This studio is read-only until its plan payment is sorted out. Clients can still book.');
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['studio_settings','staff','staff_pay','clients','client_notes','class_types','schedule_templates',
                           'products','passes','pass_adjustments','bookings','sales','sale_items']
  loop
    execute format('create trigger zz_billing_read_only before insert or update or delete on public.%I for each row execute function app.billing_read_only_guard()', t);
  end loop;
end $$;
-- Sessions: generating the week's classes is housekeeping that runs whoever opens the app, so only changes and deletes are guarded.
create trigger zz_billing_read_only before update or delete on public.class_sessions for each row execute function app.billing_read_only_guard();

-- ----------------------------------------------------------------------------- functions the apps call
-- The signed-in owner's view of their own billing (Settings > Plan & billing). Anyone else: NOT_ALLOWED.
create or replace function public.my_billing() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_sid uuid := app.current_studio_id(); s public.studios; b public.studio_billing; g public.platform_billing_settings;
begin
  if not app.has_role_in(v_sid, 'owner') then perform app.fail('NOT_ALLOWED', 'Only the studio owner can see plan and billing.'); end if;
  select * into s from public.studios where id = v_sid;
  select * into b from public.studio_billing where studio_id = v_sid;
  select * into g from public.platform_billing_settings;
  return jsonb_build_object(
    'planId', s.plan_id, 'status', coalesce(s.billing_status, 'active'), 'trialEndsAt', s.trial_ends_at, 'pastDueSince', s.past_due_since,
    'comped', s.billing_comped, 'hasSubscription', b.stripe_subscription_id is not null, 'cancelAtPeriodEnd', coalesce(b.cancel_at_period_end, false),
    'currentPeriodEnd', b.current_period_end, 'enabled', s.billing_status is not null,
    'trialDays', g.trial_days, 'graceDays', g.grace_days);
end $$;

-- Platform admin: add or edit a plan.
create or replace function public.platform_save_plan(
  p_id uuid, p_name text, p_price_cents integer default null, p_stripe_price_id text default null, p_features text[] default null,
  p_sort_order integer default null, p_active boolean default null, p_key text default null, p_clear_price_id boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.plans; v_key text;
begin
  perform app.require_platform_admin();
  if coalesce(trim(p_name), '') = '' then perform app.fail('INVALID', 'Please give the plan a name.'); end if;
  if p_features is not null and exists (select 1 from unnest(p_features) f where f !~ '^[a-z_]{2,30}$') then
    perform app.fail('INVALID', 'One of those features isn''t recognised.');
  end if;
  if p_stripe_price_id is not null and p_stripe_price_id !~ '^price_[A-Za-z0-9]+$' then
    perform app.fail('INVALID', 'A Stripe price id looks like price_1AbC...');
  end if;
  if p_id is null then
    v_key := coalesce(nullif(p_key, ''), trim(both '_' from regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g')), 'plan');
    if exists (select 1 from public.plans where key = v_key) then perform app.fail('INVALID', 'There is already a plan with that name.'); end if;
    insert into public.plans (key, name, price_cents, stripe_price_id, features, sort_order, active)
    values (v_key, trim(p_name), coalesce(p_price_cents, 0), p_stripe_price_id,
            case when p_features is null then array['core'] when 'core' = any (p_features) then p_features else array['core'] || p_features end,
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 10 from public.plans)), coalesce(p_active, true))
    returning * into v;
  else
    update public.plans set
      name = trim(p_name), price_cents = coalesce(p_price_cents, price_cents),
      stripe_price_id = case when p_clear_price_id then null else coalesce(p_stripe_price_id, stripe_price_id) end,
      features = case when p_features is null then features when 'core' = any (p_features) then p_features else array['core'] || p_features end,
      sort_order = coalesce(p_sort_order, sort_order), active = coalesce(p_active, active), updated_at = now()
     where id = p_id returning * into v;
    if v.id is null then perform app.fail('NOT_FOUND', 'That plan could not be found.'); end if;
  end if;
  perform app.audit('platform_save_plan', 'plans', v.id::text, to_jsonb(v));
  return to_jsonb(v);
end $$;

create or replace function public.platform_save_billing_settings(p_trial_days integer default null, p_grace_days integer default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.platform_billing_settings;
begin
  perform app.require_platform_admin();
  if p_trial_days is not null and p_trial_days not in (14, 30) then perform app.fail('INVALID', 'The free trial is 14 or 30 days.'); end if;
  if p_grace_days is not null and (p_grace_days < 0 or p_grace_days > 90) then perform app.fail('INVALID', 'The grace period is 0 to 90 days.'); end if;
  update public.platform_billing_settings set trial_days = coalesce(p_trial_days, trial_days), grace_days = coalesce(p_grace_days, grace_days), updated_at = now()
   returning * into g;
  return to_jsonb(g);
end $$;

-- Platform admin: put a studio on a plan by hand (comp / free), or correct its status.
create or replace function public.platform_set_studio_plan(p_studio uuid, p_plan uuid, p_status text default 'active', p_comped boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.studios;
begin
  perform app.require_platform_admin();
  if p_status not in ('trialing','active','past_due','cancelled') then perform app.fail('INVALID', 'Unknown billing status.'); end if;
  if not exists (select 1 from public.plans where id = p_plan) then perform app.fail('NOT_FOUND', 'That plan could not be found.'); end if;
  update public.studios set
    plan_id = p_plan, billing_status = p_status, billing_comped = p_comped,
    past_due_since = case when p_status = 'past_due' then coalesce(past_due_since, now()) else null end,
    trial_ends_at = case when p_status = 'trialing'
      then case when trial_ends_at > now() then trial_ends_at else now() + make_interval(days => (select trial_days from public.platform_billing_settings)) end
      else null end
   where id = p_studio returning * into s;
  if s.id is null then perform app.fail('NOT_FOUND', 'That studio could not be found.'); end if;
  perform app.audit('platform_set_studio_plan', 'studios', p_studio::text, jsonb_build_object('plan', p_plan, 'status', p_status, 'comped', p_comped));
  return app.studio_json(p_studio);
end $$;

-- Service role only (platform-subscribe / platform-webhook): apply what Stripe says about a studio's subscription.
-- Null arguments keep what is stored; a real subscription replaces a comp.
create or replace function public.billing_apply(
  p_studio uuid, p_plan uuid, p_status text, p_customer text default null, p_subscription text default null,
  p_period_end timestamptz default null, p_cancel_at_period_end boolean default null, p_trial_end timestamptz default null
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('trialing','active','past_due','cancelled') then perform app.fail('INVALID', 'Unknown billing status.'); end if;
  if p_plan is not null and not exists (select 1 from public.plans where id = p_plan) then perform app.fail('NOT_FOUND', 'That plan could not be found.'); end if;
  update public.studios set
    plan_id = coalesce(p_plan, plan_id), billing_status = p_status, billing_comped = false,
    past_due_since = case when p_status = 'past_due' then coalesce(past_due_since, now()) else null end,
    trial_ends_at = case when p_status = 'trialing' then coalesce(p_trial_end, trial_ends_at) else null end
   where id = p_studio;
  if not found then perform app.fail('NOT_FOUND', 'That studio could not be found.'); end if;
  insert into public.studio_billing (studio_id, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end)
  values (p_studio, p_customer, p_subscription, p_period_end, coalesce(p_cancel_at_period_end, false))
  on conflict (studio_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, public.studio_billing.stripe_customer_id),
    stripe_subscription_id = case when p_status = 'cancelled' then null else coalesce(excluded.stripe_subscription_id, public.studio_billing.stripe_subscription_id) end,
    current_period_end = coalesce(excluded.current_period_end, public.studio_billing.current_period_end),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, public.studio_billing.cancel_at_period_end),
    updated_at = now();
end $$;

-- Service role only (platform-subscribe): remember the studio's Stripe customer before Checkout, without touching its plan or status.
create or replace function public.billing_save_customer(p_studio uuid, p_customer text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.studios where id = p_studio) then perform app.fail('NOT_FOUND', 'That studio could not be found.'); end if;
  insert into public.studio_billing (studio_id, stripe_customer_id) values (p_studio, p_customer)
  on conflict (studio_id) do update set stripe_customer_id = excluded.stripe_customer_id, updated_at = now();
end $$;

-- Service role only: the edge functions ask these.
create or replace function public.studio_read_only(p_studio uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select app.studio_read_only(p_studio) $$;
create or replace function public.studio_has_feature(p_studio uuid, p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select app.studio_has_feature(p_studio, p_key) $$;

revoke execute on function public.billing_apply(uuid, uuid, text, text, text, timestamptz, boolean, timestamptz), public.billing_save_customer(uuid, text),
  public.studio_read_only(uuid), public.studio_has_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_apply(uuid, uuid, text, text, text, timestamptz, boolean, timestamptz), public.billing_save_customer(uuid, text),
  public.studio_read_only(uuid), public.studio_has_feature(uuid, text) to service_role;
revoke execute on function public.my_billing(), public.platform_save_plan(uuid, text, integer, text, text[], integer, boolean, text, boolean),
  public.platform_save_billing_settings(integer, integer), public.platform_set_studio_plan(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.my_billing(), public.platform_save_plan(uuid, text, integer, text, text[], integer, boolean, text, boolean),
  public.platform_save_billing_settings(integer, integer), public.platform_set_studio_plan(uuid, uuid, text, boolean) to authenticated, service_role;

-- Same function as 0007, plus the starting plan and trial.
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
  -- A new studio starts on the first (cheapest) active plan with a free trial (the plan and its trial length are data, see below).
  update public.studios set plan_id = (select id from public.plans where active order by sort_order, price_cents limit 1),
         billing_status = 'trialing', trial_ends_at = now() + make_interval(days => (select trial_days from public.platform_billing_settings))
   where id = v_id and exists (select 1 from public.plans where active);
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
