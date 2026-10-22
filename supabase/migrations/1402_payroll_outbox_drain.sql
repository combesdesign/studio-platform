-- =============================================================================
-- Payroll: draining payroll_outbox (cover request emails to staff), for the send-email edge function (service role only).
-- Same shape as commerce_claim_outbox / public.claim_notifications.
-- =============================================================================

alter table public.payroll_outbox add column if not exists claimed_at timestamptz;

create or replace function public.payroll_claim_outbox(p_limit integer default 25) returns setof public.payroll_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  return query
  update public.payroll_outbox o
     set claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from public.payroll_outbox
      where sent_at is null and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      order by created_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning o.*;
end $$;

-- Mark an outbox row sent, or record the error (retried up to 5 times).
create or replace function public.payroll_finish_outbox(p_id uuid, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  update public.payroll_outbox
     set sent_at = case when p_error is null then now() end, error = p_error
   where id = p_id;
end $$;

revoke execute on function public.payroll_claim_outbox(integer), public.payroll_finish_outbox(uuid, text) from public, anon, authenticated;
grant execute on function public.payroll_claim_outbox(integer), public.payroll_finish_outbox(uuid, text) to service_role;
