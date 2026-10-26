-- 0011_stripe_connect.sql: Stripe Connect per studio (docs/PLATFORM.md, "Card payments: Stripe Connect").
--
-- On the multi-studio platform each studio is paid into its own Stripe account (a Standard connected account: the studio owns
-- the account, its dashboard and its disputes). This holds the studio -> account link and the account's status flags.
--
-- Why not columns on public.studios? That table is readable by everyone (it's the studio directory, even before sign-in), and the
-- account id should be seen by the studio's owner only. So it lives in its own table, one row per studio:
--   * the owner of that studio can read their own row (and public.my_stripe_status());
--   * nobody can write it from the apps: the connect-onboard / connect-status edge functions and stripe-webhook (service role) do,
--     through public.stripe_connect_save(). The owner "sets" it by running the onboarding flow, not by editing a row.
-- The single-studio Snowy deployment never uses this (it runs on its own Stripe keys); the table just stays empty there.

create table public.studio_stripe (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  stripe_account_id text unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_stripe enable row level security;
revoke all on public.studio_stripe from anon, authenticated;
grant select on public.studio_stripe to authenticated;
grant all on public.studio_stripe to service_role;
create policy studio_stripe_owner_read on public.studio_stripe for select to authenticated
  using (app.has_role_in(studio_id, 'owner'));
create policy studio_scope on public.studio_stripe as restrictive for all to anon, authenticated
  using (app.in_scope(studio_id)) with check (app.in_scope(studio_id));

-- The signed-in owner's view of their studio's payments (the studio app's Settings -> Payments). Anyone else: NOT_ALLOWED.
create or replace function public.my_stripe_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_sid uuid := app.current_studio_id(); r public.studio_stripe;
begin
  if not app.has_role_in(v_sid, 'owner') then
    perform app.fail('NOT_ALLOWED', 'Only the studio owner can see payment settings.');
  end if;
  select * into r from public.studio_stripe where studio_id = v_sid;
  return jsonb_build_object(
    'connected', coalesce(r.stripe_account_id is not null, false),
    'accountId', r.stripe_account_id,
    'chargesEnabled', coalesce(r.charges_enabled, false),
    'payoutsEnabled', coalesce(r.payouts_enabled, false),
    'detailsSubmitted', coalesce(r.details_submitted, false));
end $$;

-- Service role only (edge functions): create or update a studio's link and flags. Null arguments keep the stored value.
create or replace function public.stripe_connect_save(
  p_studio uuid, p_account text, p_charges boolean default null, p_payouts boolean default null, p_details boolean default null
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.studios where id = p_studio) then
    perform app.fail('NOT_FOUND', 'That studio could not be found.');
  end if;
  insert into public.studio_stripe (studio_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted)
  values (p_studio, p_account, coalesce(p_charges, false), coalesce(p_payouts, false), coalesce(p_details, false))
  on conflict (studio_id) do update set
    stripe_account_id = coalesce(excluded.stripe_account_id, public.studio_stripe.stripe_account_id),
    charges_enabled = coalesce(p_charges, public.studio_stripe.charges_enabled),
    payouts_enabled = coalesce(p_payouts, public.studio_stripe.payouts_enabled),
    details_submitted = coalesce(p_details, public.studio_stripe.details_submitted),
    updated_at = now();
end $$;

revoke execute on function public.stripe_connect_save(uuid, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.stripe_connect_save(uuid, text, boolean, boolean, boolean) to service_role;
revoke execute on function public.my_stripe_status() from public, anon;
grant execute on function public.my_stripe_status() to authenticated, service_role;
