-- Appointments (ROADMAP B1): private + duet appointments, appointment packs, workshops / courses / events.
-- Tables + row level security. The rules live in 1101 (RPCs) and the Stripe order flow in 1102.
--
-- Every table has a studio_id and goes through app.scope_table(): RLS on, guard trigger, restrictive x-studio policy,
-- unique (studio_id, id) so same-studio foreign keys work. The permissive policies below decide who sees what inside a studio.
-- Staff actions (mirrors src/features/appointments/permissions.ts):
--   view    any active staff        book    owner, manager, front_desk        manage   owner, manager
--   own     any staff edits their own weekly hours and time off
-- Clients read the catalogue (active types / packs, published events) and only ever their own appointments, credits, sign-ups.
-- Writes that need rules (booking, paying, cancelling) are RPCs, so those tables are select-only for the API roles.

-- ----------------------------------------------------------------------------- settings (one row per studio, optional: defaults apply)
create table public.appointment_settings (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete restrict,
  slot_step_min integer not null default 30 check (slot_step_min between 5 and 120),
  min_notice_hours integer not null default 4 check (min_notice_hours between 0 and 336),
  horizon_days integer not null default 28 check (horizon_days between 1 and 365)
);
select app.scope_table('appointment_settings');

-- ----------------------------------------------------------------------------- catalogue
create table public.appointment_types (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  duration_min integer not null check (duration_min between 5 and 480),
  -- per person
  price_cents integer not null check (price_cents >= 0),
  -- 1 = private, 2 = duet
  capacity smallint not null default 1 check (capacity in (1, 2)),
  buffer_min integer not null default 0 check (buffer_min between 0 and 120),
  booking_note text,
  image_url text,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default app.now()
);
select app.scope_table('appointment_types');

-- which staff offer which type
create table public.appointment_type_staff (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  type_id uuid not null,
  staff_id uuid not null,
  primary key (type_id, staff_id),
  foreign key (studio_id, type_id) references public.appointment_types (studio_id, id) on delete cascade,
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade
);
select app.scope_table('appointment_type_staff');

create table public.appointment_packs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  credits integer not null check (credits >= 1),
  price_cents integer not null check (price_cents >= 0),
  -- counted from first use, like class packs. null = no expiry.
  validity_days integer check (validity_days >= 1),
  -- empty = any appointment type (no foreign key on an array; the RPCs only accept ids from this studio)
  type_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default app.now()
);
select app.scope_table('appointment_packs');

-- ----------------------------------------------------------------------------- staff hours
create table public.appointment_availability (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  staff_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = Sunday, studio timezone
  start_time time not null,
  end_time time not null,
  check (end_time > start_time),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade
);
create index appointment_availability_staff_idx on public.appointment_availability (staff_id, weekday);
select app.scope_table('appointment_availability');

create table public.appointment_time_off (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text,
  check (ends_at > starts_at),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade
);
create index appointment_time_off_staff_idx on public.appointment_time_off (staff_id, starts_at);
select app.scope_table('appointment_time_off');

-- ----------------------------------------------------------------------------- appointments
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  type_id uuid not null,
  type_name text not null,
  staff_id uuid not null,
  client_id uuid not null,
  people smallint not null default 1 check (people in (1, 2)),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_min integer not null default 0,
  -- pending_payment = a slot held for a few minutes while the client pays at Stripe (hold_expires_at)
  status text not null default 'booked' check (status in ('booked','completed','cancelled','late_cancelled','no_show','pending_payment')),
  pay_method text not null check (pay_method in ('pack','card_online','card_reader','cash','comp')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  -- [{ "creditId": uuid, "n": int }] for pack payments
  credit_uses jsonb not null default '[]'::jsonb,
  sale_id uuid,
  note text,
  source text not null default 'client' check (source in ('client','staff')),
  booked_by_staff_id uuid,
  created_at timestamptz not null default app.now(),
  cancelled_at timestamptz,
  -- cancelled in time after paying money: the studio still has to refund it
  refund_due boolean not null default false,
  hold_expires_at timestamptz,
  check (ends_at > starts_at),
  foreign key (studio_id, type_id) references public.appointment_types (studio_id, id) on delete restrict,
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete restrict,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete restrict,
  foreign key (studio_id, booked_by_staff_id) references public.staff (studio_id, id) on delete set null (booked_by_staff_id),
  foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete set null (sale_id)
);
create index appointments_staff_idx on public.appointments (staff_id, starts_at);
create index appointments_client_idx on public.appointments (client_id, starts_at desc);
-- the same instructor can't have two active appointments starting at the same moment, whatever the race
create unique index appointments_one_start_per_staff on public.appointments (staff_id, starts_at) where status in ('booked','completed','no_show','pending_payment');
select app.scope_table('appointments');

-- ----------------------------------------------------------------------------- appointment packs bought by clients
create table public.appointment_credits (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  pack_id uuid,
  name text not null,
  credits_total integer not null check (credits_total >= 1),
  used integer not null default 0,
  validity_days integer,
  type_ids uuid[] not null default '{}',
  purchased_at timestamptz not null default app.now(),
  activated_at timestamptz,
  expires_at timestamptz,
  sale_id uuid,
  check (used >= 0 and used <= credits_total),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete set null (sale_id)
);
create index appointment_credits_client_idx on public.appointment_credits (client_id, purchased_at);
select app.scope_table('appointment_credits');

-- ----------------------------------------------------------------------------- workshops, courses, events
create table public.studio_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  kind text not null check (kind in ('workshop','course','event')),
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  image_url text,
  -- per person, for the whole thing (all sessions of a course). 0 = free.
  price_cents integer not null default 0 check (price_cents >= 0),
  capacity integer not null check (capacity >= 1),
  host_staff_id uuid,
  location text,
  published boolean not null default false,
  cancelled boolean not null default false,
  cancel_reason text,
  -- cancel at least this many hours before the first session for a refund
  refund_cutoff_hours integer not null default 48 check (refund_cutoff_hours >= 0),
  created_at timestamptz not null default app.now(),
  foreign key (studio_id, host_staff_id) references public.staff (studio_id, id) on delete set null (host_staff_id)
);
select app.scope_table('studio_events');

create table public.studio_event_sessions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  event_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at),
  foreign key (studio_id, event_id) references public.studio_events (studio_id, id) on delete cascade
);
create index studio_event_sessions_event_idx on public.studio_event_sessions (event_id, starts_at);
select app.scope_table('studio_event_sessions');

create table public.studio_event_registrations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  event_id uuid not null,
  client_id uuid not null,
  status text not null default 'registered' check (status in ('registered','cancelled','late_cancelled','pending_payment')),
  pay_method text not null check (pay_method in ('card_online','card_reader','cash','comp')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  sale_id uuid,
  created_at timestamptz not null default app.now(),
  cancelled_at timestamptz,
  -- session start times the client was marked present for
  attended timestamptz[] not null default '{}',
  refund_due boolean not null default false,
  hold_expires_at timestamptz,
  foreign key (studio_id, event_id) references public.studio_events (studio_id, id) on delete cascade,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete restrict,
  foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete set null (sale_id)
);
create unique index studio_event_one_per_client on public.studio_event_registrations (event_id, client_id) where status in ('registered','pending_payment');
create index studio_event_registrations_client_idx on public.studio_event_registrations (client_id, created_at desc);
select app.scope_table('studio_event_registrations');

-- ----------------------------------------------------------------------------- online orders (Stripe Checkout)
-- Written only by the RPCs and the edge functions (service role). No policies: the API roles can't touch it.
create table public.appointment_orders (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  kind text not null check (kind in ('appointment','pack','event')),
  -- the held appointment or registration, or the pack being bought
  appointment_id uuid,
  registration_id uuid,
  pack_id uuid,
  title text not null,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending','paid','expired','failed')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default app.now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  result jsonb,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
select app.scope_table('appointment_orders');

-- ----------------------------------------------------------------------------- row level security
alter table public.appointment_orders enable row level security;
revoke all on public.appointment_orders from anon, authenticated;

-- settings, catalogue: members read (clients: active / published only), owner + manager write
create policy settings_read on public.appointment_settings for select to authenticated using (app.is_member_of(studio_id));
create policy settings_write on public.appointment_settings for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));

create policy types_read on public.appointment_types for select to authenticated
  using (app.is_staff_of(studio_id) or (active and app.is_member_of(studio_id)));
create policy types_write on public.appointment_types for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));

create policy type_staff_read on public.appointment_type_staff for select to authenticated using (app.is_member_of(studio_id));
create policy type_staff_write on public.appointment_type_staff for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));

create policy packs_read on public.appointment_packs for select to authenticated
  using (app.is_staff_of(studio_id) or (active and app.is_member_of(studio_id)));
create policy packs_write on public.appointment_packs for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));

-- hours + time off: staff read; owner / manager write for anyone, everyone else for themselves
create policy availability_read on public.appointment_availability for select to authenticated using (app.is_staff_of(studio_id));
create policy availability_write on public.appointment_availability for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager') or staff_id = app.staff_id_in(studio_id))
  with check (app.has_role_in(studio_id, 'owner', 'manager') or staff_id = app.staff_id_in(studio_id));
create policy time_off_read on public.appointment_time_off for select to authenticated using (app.is_staff_of(studio_id));
create policy time_off_write on public.appointment_time_off for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager') or staff_id = app.staff_id_in(studio_id))
  with check (app.has_role_in(studio_id, 'owner', 'manager') or staff_id = app.staff_id_in(studio_id));

-- appointments + credits: the client's own, or staff (instructors: only their own sessions). Writes: RPCs only.
create policy appointments_read on public.appointments for select to authenticated
  using (client_id = app.client_id_in(studio_id)
         or app.has_role_in(studio_id, 'owner', 'manager', 'front_desk')
         or staff_id = app.staff_id_in(studio_id));
create policy credits_read on public.appointment_credits for select to authenticated
  using (client_id = app.client_id_in(studio_id) or app.is_staff_of(studio_id));

-- events: clients see published ones; staff see all; owner + manager write
create policy events_read on public.studio_events for select to authenticated
  using (app.is_staff_of(studio_id) or (published and app.is_member_of(studio_id)));
create policy events_write on public.studio_events for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));
create policy event_sessions_read on public.studio_event_sessions for select to authenticated
  using (app.is_staff_of(studio_id) or app.is_member_of(studio_id));
create policy event_sessions_write on public.studio_event_sessions for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));
-- sign-ups: your own; the front desk and above; the host instructor for their event. Writes: RPCs only.
create policy registrations_read on public.studio_event_registrations for select to authenticated
  using (client_id = app.client_id_in(studio_id)
         or app.has_role_in(studio_id, 'owner', 'manager', 'front_desk')
         or exists (select 1 from public.studio_events e where e.id = event_id and e.host_staff_id = app.staff_id_in(studio_id)));

-- ----------------------------------------------------------------------------- grants
revoke insert, update, delete on public.appointments, public.appointment_credits, public.studio_event_registrations from anon, authenticated;
revoke all on public.appointment_settings, public.appointment_types, public.appointment_type_staff, public.appointment_packs,
  public.appointment_availability, public.appointment_time_off, public.appointments, public.appointment_credits,
  public.studio_events, public.studio_event_sessions, public.studio_event_registrations from anon;
grant all on all tables in schema public to service_role;
