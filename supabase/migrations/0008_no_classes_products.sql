-- =============================================================================
-- Products and passes that give no studio class access (the Online membership, on-demand video only).
-- products.no_classes is copied onto the pass at purchase. Such a pass is never usable for a class, so the booking
-- functions skip it, and it never reads as "Unlimited" (credit_summary_impl says "Online only").
-- Core change (the 0xxx range); the three functions below are the earlier ones (0002, 0003) plus the no_classes lines.
-- =============================================================================
alter table public.products add column no_classes boolean not null default false;
alter table public.passes add column no_classes boolean not null default false;

create or replace function app.pass_usable(p public.passes, p_starts timestamptz, p_class_type uuid, p_now timestamptz)
returns boolean language sql stable as $$
  select (p.status in ('active','paused')
          or (p.status = 'cancelled' and p.kind = 'membership' and p.next_billing_at is not null
              and p_starts < p.next_billing_at and p_now < p.next_billing_at))
     and not coalesce(p.no_classes, false)
     and (p.class_type_ids is null or cardinality(p.class_type_ids) = 0 or p_class_type = any(p.class_type_ids))
     and (app.effective_expiry(p, p_now) is null
          or (app.effective_expiry(p, p_now) > p_starts and app.effective_expiry(p, p_now) > p_now))
     and not (p.paused_from is not null
              and app.local_date(p_starts) >= p.paused_from
              and (p.paused_until is null or app.local_date(p_starts) <= p.paused_until))
$$;

create or replace function app.create_pass(
  p_client uuid, p_product uuid, p_sale uuid, p_price_cents int,
  p_stripe_subscription_id text default null, p_next_billing_at timestamptz default null
) returns public.passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr public.products; p public.passes;
begin
  select * into pr from public.products where id = p_product;
  if pr.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that product.'); end if;
  if pr.kind = 'retail' then return null; end if;
  if p_client is null then perform app.fail('NOT_FOUND', 'Class passes need a client.'); end if;
  if (pr.kind = 'intro' or pr.new_clients_only) and not public.is_intro_eligible(p_client) then
    perform app.fail('INTRO_NOT_ELIGIBLE', 'The intro offer is for new clients only.');
  end if;
  insert into public.passes (client_id, product_id, kind, name, status, purchased_at, validity_days, credits,
                             billing_interval, next_billing_at, price_cents, class_type_ids, no_classes, sale_id, stripe_subscription_id)
  values (p_client, pr.id, pr.kind, pr.name, 'active', app.now(),
          pr.validity_days,
          case when pr.kind = 'dropin' then coalesce(pr.credits, 1) else pr.credits end,
          case when pr.kind = 'membership' then coalesce(pr.billing_interval, 'week') end,
          p_next_billing_at, coalesce(p_price_cents, pr.price_cents), pr.class_type_ids, pr.no_classes, p_sale, p_stripe_subscription_id)
  returning * into p;
  return p;
end $$;

create or replace function app.credit_summary_impl(p_client_id uuid, p_session_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  s public.class_sessions;
  v_at timestamptz;
  p public.passes;
  v_rem int;
  v_out jsonb := '[]'::jsonb;
  v_label text;
begin
  if not (app.is_privileged() or p_client_id = public.current_client_id() or public.has_role('owner','manager','front_desk','instructor')) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  if p_session_id is not null then
    select * into s from public.class_sessions where id = p_session_id;
    if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  end if;
  v_at := coalesce(s.starts_at, v_now);

  for p in select * from public.passes where client_id = p_client_id
              and (status in ('active','paused')
                   or (status = 'cancelled' and kind = 'membership' and next_billing_at > v_now))
           order by case when credits is null then 0 when kind = 'membership' then 1 else 2 end,
                    (activated_at is null), expires_at nulls last, purchased_at
  loop
    if s.id is not null then
      continue when not app.pass_usable(p, s.starts_at, s.class_type_id, v_now);
    else
      continue when app.effective_expiry(p, v_now) is not null and app.effective_expiry(p, v_now) <= v_now;
    end if;
    v_rem := app.pass_remaining(p, v_at);
    continue when s.id is not null and v_rem is not null and v_rem <= 0;
    continue when s.id is null and p.kind <> 'membership' and v_rem is not null and v_rem <= 0;
    v_label := case
      when s.id is null and p.paused_from is not null and p.paused_from <= app.local_date(v_now)
           and (p.paused_until is null or p.paused_until >= app.local_date(v_now))
        then 'Paused' || coalesce(' until ' || to_char(p.paused_until, 'Dy FMDD Mon'), '')
      when p.no_classes then 'Online only'
      when v_rem is null then 'Unlimited'
      when p.kind = 'membership' then format('%s of %s left this week', greatest(v_rem, 0), p.credits)
      else format('%s of %s left', v_rem, p.credits) end;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'pass', app.pass_json(p.id), 'remaining', case when v_rem is null then null else greatest(v_rem, 0) end,
      'label', v_label,
      'expiresAt', case when p.status = 'cancelled' and p.kind = 'membership' then p.next_billing_at else p.expires_at end));
  end loop;
  return v_out;
end $$;
