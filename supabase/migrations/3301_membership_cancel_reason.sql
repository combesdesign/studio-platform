-- Cancelling a membership now needs a reason (picked from a short list, or "Other: ..." typed). It's stored on the pass
-- (cancel_reason, cancelled_at) and shown to the studio on the client's membership. Clients and staff both go through
-- cancel_membership, so the rule lives here: no reason, no cancel.

alter table public.passes add column cancel_reason text check (cancel_reason is null or char_length(cancel_reason) between 1 and 300);
alter table public.passes add column cancelled_at timestamptz;

drop function public.cancel_membership(uuid);
create or replace function public.cancel_membership(p_pass_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true); v_end timestamptz; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p.kind <> 'membership' then perform app.fail('INVALID', 'Only memberships can be cancelled this way.'); end if;
  if p.status = 'cancelled' then return app.pass_json(p.id); end if;
  if v_reason = '' then perform app.fail('INVALID', 'Please tell us why you''re cancelling.'); end if;
  if char_length(v_reason) > 300 then perform app.fail('INVALID', 'Please keep the reason to 300 characters or fewer.'); end if;
  v_end := case
    when p.stripe_subscription_id is not null then coalesce(p.next_billing_at, app.now())
    when p.activated_at is null then app.now()
    else coalesce(p.next_billing_at, p.activated_at + interval '7 days') end;
  update public.passes set cancel_at_period_end = true, status = 'cancelled', next_billing_at = v_end,
         cancel_reason = v_reason, cancelled_at = app.now() where id = p.id;
  perform app.cancel_pass_bookings(p.id, v_end);
  perform app.audit('cancel_membership', 'passes', p.id::text, jsonb_build_object('ends', v_end, 'reason', v_reason));
  return app.pass_json(p.id);
end $$;
revoke execute on function public.cancel_membership(uuid, text) from public, anon;
grant execute on function public.cancel_membership(uuid, text) to authenticated, service_role;
