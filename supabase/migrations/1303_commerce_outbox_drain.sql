-- =============================================================================
-- Commerce: draining commerce_outbox (gift card e-cards), for the send-email edge function (service role only).
--   commerce_send_due()          queue the cards whose send date has come (each studio's own timezone/today)
--   commerce_claim_outbox(n)     hand out pending rows with SKIP LOCKED (so the webhook and the sweep can't double-send)
--   commerce_finish_outbox(id)   mark sent, or record the error (retried up to 5 times)
-- =============================================================================

alter table public.commerce_outbox add column if not exists claimed_at timestamptz;

-- Scheduled gift cards ("send on 14 Feb") are queued here, not only when someone opens the shop screens.
create or replace function public.commerce_send_due() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; c record; n int := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for s in select id from public.studios where status <> 'suspended' loop
    perform app.use_studio(s.id);
    for c in select id from public.commerce_gift_cards
              where studio_id = s.id and status = 'active' and recipient_email is not null and sent_at is null
                and coalesce(send_on, app.commerce_today()) <= app.commerce_today()
              for update skip locked
    loop
      perform app.commerce_send(c.id);
      n := n + 1;
    end loop;
  end loop;
  perform app.use_studio(null);
  return n;
end $$;

create or replace function public.commerce_claim_outbox(p_limit integer default 25) returns setof public.commerce_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  return query
  update public.commerce_outbox o
     set claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from public.commerce_outbox
      where sent_at is null and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      order by created_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning o.*;
end $$;

create or replace function public.commerce_finish_outbox(p_id uuid, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  update public.commerce_outbox
     set sent_at = case when p_error is null then now() end, error = p_error
   where id = p_id;
end $$;

revoke execute on function public.commerce_send_due(), public.commerce_claim_outbox(integer), public.commerce_finish_outbox(uuid, text)
  from public, anon, authenticated;
grant execute on function public.commerce_send_due(), public.commerce_claim_outbox(integer), public.commerce_finish_outbox(uuid, text) to service_role;
