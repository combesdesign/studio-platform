-- =============================================================================
-- Help assistant (supabase/functions/support-assist): one row per question a staff member asks, used for the daily cap
-- (30 per person per rolling 24 hours). Platform-level, service role only (the edge function writes and counts it).
-- Holds who asked and when, never the question or the answer.
-- =============================================================================
create table public.support_assist_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  studio_id uuid not null references public.studios(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.support_assist_log enable row level security; -- no policies: nobody but the service role
create index support_assist_log_user_idx on public.support_assist_log (user_id, created_at desc);
revoke all on public.support_assist_log from anon, authenticated;
grant all on public.support_assist_log to service_role;
