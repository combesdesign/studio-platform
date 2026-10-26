-- =============================================================================
-- Urgent support alert: a platform-level outbox. When a studio sends an urgent request (public.support_send with p_urgent),
-- a row is queued here; the edge-function sweep (send-reminders / send-email) emails SUPPORT_ALERT_EMAIL and, if set, POSTs
-- JSON to SUPPORT_ALERT_SMS_WEBHOOK. Same shape as commerce_outbox / payroll_outbox, but with no studio scope: it is
-- the platform's own queue, so no client or staff login can read or write it (service role only, via the RPCs below).
-- =============================================================================
create table public.support_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.support_requests(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0,
  error text
);
alter table public.support_alert_outbox enable row level security; -- no policies: nobody but the service role
create index support_alert_outbox_pending_idx on public.support_alert_outbox (created_at) where sent_at is null;
revoke all on public.support_alert_outbox from anon, authenticated;
grant all on public.support_alert_outbox to service_role;

-- Queue one alert per urgent request (the request row is written by support_send, a security definer function).
create or replace function app.queue_support_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.support_alert_outbox (request_id, payload)
  values (new.id, jsonb_build_object(
    'studio_id', new.studio_id, 'studio_name', new.studio_name, 'person', new.staff_name, 'role', new.staff_role,
    'message', new.body, 'page', new.route, 'app_version', new.app_version));
  return new;
end $$;
create trigger support_requests_urgent_alert after insert on public.support_requests
  for each row when (new.urgent) execute function app.queue_support_alert();

create or replace function public.support_alert_claim_outbox(p_limit integer default 25) returns setof public.support_alert_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  return query
  update public.support_alert_outbox o
     set claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from public.support_alert_outbox
      where sent_at is null and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      order by created_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning o.*;
end $$;

create or replace function public.support_alert_finish_outbox(p_id uuid, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  update public.support_alert_outbox
     set sent_at = case when p_error is null then now() end, error = p_error
   where id = p_id;
end $$;

revoke execute on function public.support_alert_claim_outbox(integer), public.support_alert_finish_outbox(uuid, text) from public, anon, authenticated;
grant execute on function public.support_alert_claim_outbox(integer), public.support_alert_finish_outbox(uuid, text) to service_role;
