-- 2100_plan_gating.sql: feature RPCs check the studio's plan (docs/PLATFORM.md, "Plans and billing").
--
-- Each feature already funnels its staff-facing RPCs through one small helper (a role check). We add app.require_feature(<key>) to
-- that helper, so every RPC that uses it is gated with one line, and a studio whose plan lacks the feature gets FEATURE_LOCKED.
-- Left out on purpose (listed in NOTES.md > plans): the client-facing commerce RPCs, on-demand viewing, reviews / marketing / kiosk
-- client calls, partner and Stripe-driven RPCs, and every scheduled job (service role is never gated).
-- This file has to come after the feature migrations: it replaces their helpers.

create or replace function app.ap_actor(p_client uuid default null) returns app.ap_actor_t
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t;
begin
  perform app.require_feature('appointments');
  v.studio := app.current_studio_id();
  v.staff_id := public.current_staff_id();
  v.role := public.staff_role();
  v.client_id := public.current_client_id();
  if v.staff_id is null and v.client_id is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  v.as_staff := v.staff_id is not null and (v.client_id is null or (p_client is not null and p_client <> v.client_id));
  return v;
end $$;

create or replace function app.commerce_need(p_action text) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role text := public.staff_role();
begin
  perform app.require_feature('commerce');
  if v_role is null then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  if not (v_role = any (case p_action
        when 'view' then array['owner','manager','front_desk']
        when 'sell' then array['owner','manager','front_desk','instructor']
        when 'manage' then array['owner','manager']
        when 'stock' then array['owner','manager','front_desk']
        else array[]::text[] end)) then
    perform app.fail('NOT_ALLOWED', 'You don’t have permission to do that.');
  end if;
  return public.current_staff_id();
end $$;

create or replace function app.marketing_need(p_action text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_feature('marketing');
  if p_action = 'manage' and public.has_role('owner', 'manager') then return; end if;
  if p_action in ('view', 'inbox') and public.has_role('owner', 'manager', 'front_desk') then return; end if;
  perform app.fail('NOT_ALLOWED', 'Your role doesn''t have access to that.');
end $$;

create or replace function public.payroll_me() returns public.staff
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  perform app.require_feature('payroll');
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  return v;
end $$;

create or replace function public.integrations_require(p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  perform app.require_feature('integrations');
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null or not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

create or replace function public.ondemand_require_manage() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_feature('ondemand');
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

create or replace function public.kiosk_require(p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  perform app.require_feature('kiosk');
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null or not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

create or replace function public.reviews_require(p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  perform app.require_feature('reviews');
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null or not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;
