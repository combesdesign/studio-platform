-- Integrations (ROADMAP B5): ClassPass / Gympass partner hooks, and the Xero export settings.
-- Permission map (mirrors src/features/integrations/permissions.ts):
--   integrations.view         any active staff      see which roster rows are partner bookings, spots held for partners
--   integrations.manage       owner, manager        partner on/off + partner studio IDs, spots held per class type
--   integrations.keys         owner                 partner API keys (write-only: nobody can read one back)
-- REAL USE OF CLASSPASS OR GYMPASS NEEDS A PARTNER AGREEMENT with that company (they give the studio its partner ID,
-- API key, webhook format and signature scheme). Until then the webhook is a disabled stub: see docs/features/integrations.md.

-- ---------------------------------------------------------------- partner settings (one row per studio and partner)
create table public.integrations_partners (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  partner text not null check (partner in ('classpass','gympass')),
  enabled boolean not null default false,
  -- the studio's own ID at the partner: how an incoming webhook says which studio it is for
  partner_studio_id text not null default '' check (length(partner_studio_id) <= 80),
  key_set boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (studio_id, partner)
);
select app.scope_table('integrations_partners');
-- one studio per partner ID, across the platform, or a webhook couldn't tell whose it is
create unique index integrations_partner_id_unique on public.integrations_partners (partner, partner_studio_id) where partner_studio_id <> '';
create policy integrations_partners_read on public.integrations_partners for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.integrations_partners to authenticated;

-- API keys live here and nowhere else. RLS on, no policy, no grant: only the service role (the webhook function) and
-- the security-definer RPCs reach it. A key can be replaced or cleared but never read back through the app.
create table public.integrations_secrets (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  partner text not null check (partner in ('classpass','gympass')),
  api_key text not null check (length(api_key) between 1 and 400),
  updated_at timestamptz not null default now(),
  primary key (studio_id, partner),
  foreign key (studio_id, partner) references public.integrations_partners (studio_id, partner) on delete cascade
);
select app.scope_table('integrations_secrets');
revoke all on public.integrations_secrets from anon, authenticated;

-- ---------------------------------------------------------------- spots held for a partner, per class type
create table public.integrations_reserved (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  class_type_id uuid not null,
  partner text not null check (partner in ('classpass','gympass')),
  spots integer not null check (spots between 1 and 200),
  primary key (studio_id, class_type_id, partner),
  foreign key (studio_id, class_type_id) references public.class_types (studio_id, id) on delete cascade
);
select app.scope_table('integrations_reserved');
create policy integrations_reserved_read on public.integrations_reserved for select to authenticated using (app.is_staff_of(studio_id));
grant select on public.integrations_reserved to authenticated;

-- ---------------------------------------------------------------- partner members and their bookings
-- A "partner client" is an ordinary client row (so rosters, check-in and reports just work) linked to the partner's member id.
create table public.integrations_partner_clients (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  partner text not null check (partner in ('classpass','gympass')),
  member_ref text not null check (length(member_ref) between 1 and 120),
  client_id uuid not null,
  primary key (studio_id, partner, member_ref),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
select app.scope_table('integrations_partner_clients');
revoke all on public.integrations_partner_clients from anon, authenticated;

-- The booking itself is a normal bookings row (status booked, source 'staff', no pass: the partner pays the studio,
-- not the client). This table says which partner it came from; its `source` is what the roster badge shows.
create table public.integrations_partner_bookings (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  session_id uuid not null,
  source text not null check (source in ('classpass','gympass')),
  partner_booking_id text not null check (length(partner_booking_id) between 1 and 120),
  member_name text not null default '',
  created_at timestamptz not null default now(),
  foreign key (studio_id, session_id) references public.class_sessions (studio_id, id) on delete cascade,
  unique (studio_id, source, partner_booking_id)
);
select app.scope_table('integrations_partner_bookings');
create index integrations_partner_bookings_session_idx on public.integrations_partner_bookings (session_id);
create policy integrations_partner_bookings_read on public.integrations_partner_bookings for select to authenticated using (app.is_staff_of(studio_id));
grant select on public.integrations_partner_bookings to authenticated;
