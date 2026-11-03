-- Account deletion, round 2 (3000 left these out):
--   * future appointments and event registrations are cancelled (the spot is free again, pack credits go back, a paid one is marked
--     "refund due" for the studio, like a normal in-time cancel)
--   * queued emails for the person are cleared from every outbox: commerce (gift cards), payroll, marketing, appointments, support
-- 3000's function keeps doing the rest, so it's renamed and wrapped: this runs before it (cancellations, while the rows are still
-- the person's) and after it (outboxes: 3000 has blanked the marketing addresses by then). Safe to repeat.

alter function public.account_delete_apply(uuid, uuid, text) set schema app;
alter function app.account_delete_apply(uuid, uuid, text) rename to account_delete_apply_core;

create function public.account_delete_apply(p_client_id uuid, p_actor_user_id uuid default null, p_by text default 'self') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.clients;
  v_ids uuid[];
  v_emails text[];
  v_now timestamptz := app.now();
  v_result jsonb;
  r record;
  v_appts int := 0;
  v_regs int := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Not allowed.'); end if;
  select * into c from public.clients where id = p_client_id;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that account.'); end if;
  if c.deleted_at is not null then return app.account_delete_apply_core(p_client_id, p_actor_user_id, p_by); end if;   -- already done
  perform app.use_studio(c.studio_id);
  select array_agg(x.id), array_remove(array_agg(distinct nullif(lower(trim(x.email)), '')), null)
    into v_ids, v_emails from public.clients x where x.id = c.id or x.guardian_client_id = c.id;

  -- Future appointments: cancel (credits back for packs; money paid is flagged for the studio to refund)
  for r in select a.id, a.status, a.pay_method, a.amount_cents, a.credit_uses from public.appointments a
            where a.client_id = any (v_ids) and a.status in ('booked', 'pending_payment') and a.starts_at >= v_now order by a.id loop
    update public.appointments set status = 'cancelled', cancelled_at = v_now, hold_expires_at = null,
           refund_due = (r.status = 'booked' and r.pay_method <> 'pack' and r.amount_cents > 0)
     where id = r.id;
    if r.status = 'booked' and r.pay_method = 'pack' then perform app.ap_return_credits(r.credit_uses); end if;
    v_appts := v_appts + 1;
  end loop;

  -- Future event registrations: cancel; the capacity trigger offers the place to the next person on the waitlist
  for r in select g.id, g.status, g.amount_cents from public.studio_event_registrations g
            where g.client_id = any (v_ids) and g.status in ('registered', 'pending_payment')
              and exists (select 1 from public.studio_event_sessions s where s.event_id = g.event_id and s.starts_at >= v_now) order by g.id loop
    update public.studio_event_registrations set status = 'cancelled', cancelled_at = v_now, hold_expires_at = null,
           refund_due = (r.status = 'registered' and r.amount_cents > 0)
     where id = r.id;
    v_regs := v_regs + 1;
  end loop;

  v_result := app.account_delete_apply_core(p_client_id, p_actor_user_id, p_by);

  -- Queued emails: marketing (3000 blanked the address, so it must not be attempted), commerce gift cards, payroll, support alerts
  update public.marketing_messages set status = 'skipped', error = 'Account deleted' where client_id = any (v_ids) and status = 'queued';
  delete from public.appointments_outbox where client_id = any (v_ids) and sent_at is null;
  delete from public.commerce_outbox o where o.sent_at is null
     and (lower(trim(o.to_email)) = any (v_emails)
          or exists (select 1 from public.commerce_gift_cards k where k.id = o.card_id and (k.purchaser_client_id = any (v_ids) or k.owner_client_id = any (v_ids))));
  delete from public.payroll_outbox where sent_at is null and lower(trim(coalesce(to_email, ''))) = any (v_emails);
  if c.user_id is not null and coalesce((v_result ->> 'delete_auth_user')::boolean, false) then
    delete from public.support_alert_outbox o using public.support_requests q where o.request_id = q.id and o.sent_at is null and q.created_by = c.user_id;
  end if;

  update public.audit_log set details = details || jsonb_build_object('appointmentsCancelled', v_appts, 'registrationsCancelled', v_regs)
   where studio_id = c.studio_id and action = 'account.delete' and entity = 'client' and entity_id = c.id::text;
  return v_result;
end $$;
revoke all on function public.account_delete_apply(uuid, uuid, text) from public, anon, authenticated;
revoke all on function app.account_delete_apply_core(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.account_delete_apply(uuid, uuid, text), app.account_delete_apply_core(uuid, uuid, text) to service_role;
