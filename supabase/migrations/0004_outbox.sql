-- =============================================================================
-- Email outbox helpers for the send-email edge function (service role only).
-- claim_notifications() hands out pending rows with SKIP LOCKED, so the database webhook and
-- the every-5-minutes sweep can run at the same time without emailing anyone twice.
-- =============================================================================

alter table public.notifications add column if not exists claimed_at timestamptz;

create or replace function public.claim_notifications(p_limit integer default 25, p_id uuid default null)
returns setof public.notifications
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  return query
  update public.notifications n
     set claimed_at = now(), attempts = n.attempts + 1
   where n.id in (
     select id from public.notifications
      where sent_at is null and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
        and (p_id is null or id = p_id)
      order by created_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning n.*;
end $$;

create or replace function public.finish_notification(p_id uuid, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  update public.notifications
     set sent_at = case when p_error is null then now() end,
         error = p_error,
         claimed_at = case when p_error is null then claimed_at end
   where id = p_id;
end $$;

-- Old sent emails aren't needed forever (keeps the free database small).
create or replace function public.prune_notifications(p_days integer default 90) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  delete from public.notifications where created_at < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.claim_notifications, public.finish_notification, public.prune_notifications
  from public, anon, authenticated;
grant execute on function public.claim_notifications, public.finish_notification, public.prune_notifications to service_role;
