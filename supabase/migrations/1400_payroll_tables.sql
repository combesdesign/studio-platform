-- Payroll feature (ROADMAP B4): cover requests, pay rules, timesheets, adjustments and paid pay runs.
-- Everything is per studio (app.scope_table). Reads go through RLS; every change goes through the RPCs in
-- 1401_payroll_rpcs.sql, which mirror src/features/payroll/permissions.ts:
--   payroll.cover               any active staff     see cover requests, ask for cover on your own class, claim
--   payroll.cover_approve       owner, manager       approve / decline claims, post for anyone, auto-approve setting
--   payroll.clock               any active staff     your own timesheet and the clock
--   payroll.timesheets          owner, manager       everyone's timesheets (entries stay pending)
--   payroll.timesheets_approve  owner                approve / reject hours
--   payroll.view                owner, manager       pay periods and pay rules (read)
--   payroll.rules / .manage     owner                pay rules, adjustments, mark paid, reopen, export, pay period

-- ---------------------------------------------------------------- settings (one row per studio, made on first save)
create table public.payroll_settings (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete cascade,
  frequency text not null default 'weekly' check (frequency in ('weekly','fortnightly')),
  period_anchor date not null default date '2024-01-01',
  cover_auto_approve boolean not null default false,
  updated_at timestamptz not null default now()
);
select app.scope_table('payroll_settings');
create policy payroll_settings_read on public.payroll_settings for select to authenticated using (app.is_staff_of(studio_id));
grant select on public.payroll_settings to authenticated;

-- ---------------------------------------------------------------- pay rules
create table public.payroll_pay_rules (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  staff_id uuid not null,
  kind text not null check (kind in ('flat','per_head','tiered','hourly','session')),
  earnings_rate text check (earnings_rate is null or length(earnings_rate) <= 60),
  class_type_id uuid,
  session_type text check (session_type is null or session_type ~ '^[a-z0-9_]{1,40}$'),
  rate_cents integer check (rate_cents is null or rate_cents between 0 and 10000000),
  per_hour boolean not null default false,
  base_cents integer check (base_cents is null or base_cents between 0 and 10000000),
  per_head_cents integer check (per_head_cents is null or per_head_cents between 0 and 10000000),
  above_n integer check (above_n is null or above_n between 0 and 10000),
  tiers jsonb check (tiers is null or jsonb_typeof(tiers) = 'array'),
  active boolean not null default true,
  -- one active rule per person per slot (all classes / one class type / hourly / a session type)
  slot text generated always as (case kind when 'hourly' then 'hourly' when 'session' then 'session:' || coalesce(session_type, '')
                                         else 'class:' || coalesce(class_type_id::text, '*') end) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'session' or session_type is not null),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade,
  foreign key (studio_id, class_type_id) references public.class_types (studio_id, id) on delete cascade
);
select app.scope_table('payroll_pay_rules');
create unique index payroll_pay_rules_one_per_slot on public.payroll_pay_rules (studio_id, staff_id, slot) where active;
create policy payroll_pay_rules_read on public.payroll_pay_rules for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.payroll_pay_rules to authenticated;
create trigger audit_payroll_pay_rules after insert or update or delete on public.payroll_pay_rules for each row execute function app.audit_trigger();

-- ---------------------------------------------------------------- cover (sub) requests
create table public.payroll_cover_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  session_id uuid not null,
  requested_by uuid not null,          -- the class's instructor when it was posted
  posted_by uuid not null,             -- them, or an owner/manager on their behalf
  reason text check (reason is null or length(reason) <= 300),
  status text not null default 'open' check (status in ('open','claimed','approved','cancelled')),
  claimed_by uuid,
  claimed_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 300),
  auto_approved boolean not null default false,
  declined_by uuid[] not null default '{}',
  notified uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  check (status <> 'claimed' or claimed_by is not null),
  foreign key (studio_id, session_id) references public.class_sessions (studio_id, id) on delete cascade,
  foreign key (studio_id, requested_by) references public.staff (studio_id, id) on delete cascade,
  foreign key (studio_id, posted_by) references public.staff (studio_id, id) on delete cascade,
  foreign key (studio_id, claimed_by) references public.staff (studio_id, id) on delete set null (claimed_by),
  foreign key (studio_id, decided_by) references public.staff (studio_id, id) on delete set null (decided_by)
);
select app.scope_table('payroll_cover_requests');
create unique index payroll_cover_one_live on public.payroll_cover_requests (session_id) where status in ('open','claimed');
create index payroll_cover_session_idx on public.payroll_cover_requests (studio_id, session_id);
create policy payroll_cover_read on public.payroll_cover_requests for select to authenticated using (app.is_staff_of(studio_id));
grant select on public.payroll_cover_requests to authenticated;

-- ---------------------------------------------------------------- timesheets
create table public.payroll_timesheets (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  staff_id uuid not null,
  kind text not null default 'shift' check (kind in ('shift','session')),
  session_type text check (session_type is null or session_type ~ '^[a-z0-9_]{1,40}$'),
  started_at timestamptz not null,
  ended_at timestamptz,
  break_min integer not null default 0 check (break_min >= 0),
  units integer not null default 1 check (units between 1 and 1000),
  note text check (note is null or length(note) <= 200),
  source text not null default 'manual' check (length(source) <= 40),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at),
  check (kind <> 'session' or session_type is not null),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade,
  foreign key (studio_id, reviewed_by) references public.staff (studio_id, id) on delete set null (reviewed_by),
  foreign key (studio_id, created_by) references public.staff (studio_id, id) on delete set null (created_by)
);
select app.scope_table('payroll_timesheets');
create unique index payroll_timesheets_one_open on public.payroll_timesheets (staff_id) where kind = 'shift' and ended_at is null;
create index payroll_timesheets_staff_idx on public.payroll_timesheets (studio_id, staff_id, started_at);
create index payroll_timesheets_started_idx on public.payroll_timesheets (studio_id, started_at);
create policy payroll_timesheets_read on public.payroll_timesheets for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager') or staff_id = app.staff_id_in(studio_id));
grant select on public.payroll_timesheets to authenticated;
create trigger audit_payroll_timesheets after update or delete on public.payroll_timesheets for each row execute function app.audit_trigger();

-- ---------------------------------------------------------------- adjustments (per pay period)
create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  period_from date not null,
  period_to date not null,
  staff_id uuid not null,
  label text not null default 'Adjustment' check (length(label) between 1 and 60),
  amount_cents integer not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000),
  reason text not null check (length(reason) between 1 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (period_to >= period_from),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade,
  foreign key (studio_id, created_by) references public.staff (studio_id, id) on delete set null (created_by)
);
select app.scope_table('payroll_adjustments');
create index payroll_adjustments_period_idx on public.payroll_adjustments (studio_id, period_from, period_to);
create policy payroll_adjustments_read on public.payroll_adjustments for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.payroll_adjustments to authenticated;
create trigger audit_payroll_adjustments after insert or update or delete on public.payroll_adjustments for each row execute function app.audit_trigger();

-- ---------------------------------------------------------------- paid pay runs (a saved copy of what was paid)
create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  period_from date not null,
  period_to date not null,
  paid_at timestamptz not null default now(),
  paid_by uuid,
  total_cents integer not null,
  snapshot jsonb not null,
  check (period_to >= period_from),
  unique (studio_id, period_from, period_to),
  foreign key (studio_id, paid_by) references public.staff (studio_id, id) on delete set null (paid_by)
);
select app.scope_table('payroll_runs');
create policy payroll_runs_read on public.payroll_runs for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.payroll_runs to authenticated;
create trigger audit_payroll_runs after insert or delete on public.payroll_runs for each row execute function app.audit_trigger();

-- ---------------------------------------------------------------- staff emails (cover notices). The in-app list is
-- the cover table itself; these rows are for an email sender (edge function / cron) to drain, like public.notifications.
create table public.payroll_outbox (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  kind text not null check (kind in ('cover_requested','cover_claimed','cover_approved','cover_declined')),
  to_staff_id uuid not null,
  to_email text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  error text,
  foreign key (studio_id, to_staff_id) references public.staff (studio_id, id) on delete cascade
);
select app.scope_table('payroll_outbox');
create index payroll_outbox_pending_idx on public.payroll_outbox (created_at) where sent_at is null;
create policy payroll_outbox_read on public.payroll_outbox for select to authenticated using (app.has_role_in(studio_id, 'owner'));
grant select on public.payroll_outbox to authenticated;

-- Writes only through the RPCs.
revoke insert, update, delete on public.payroll_settings, public.payroll_pay_rules, public.payroll_cover_requests,
  public.payroll_timesheets, public.payroll_adjustments, public.payroll_runs, public.payroll_outbox from anon, authenticated;
grant all on public.payroll_settings, public.payroll_pay_rules, public.payroll_cover_requests, public.payroll_timesheets,
  public.payroll_adjustments, public.payroll_runs, public.payroll_outbox to service_role;
