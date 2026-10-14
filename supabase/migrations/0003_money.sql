-- =============================================================================
-- Passes, sales, POS, Stripe hooks, reports, housekeeping, sign-up linking.
-- =============================================================================

create or replace function app.sale_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) || jsonb_build_object('items', coalesce((
           select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.name, 'qty', i.qty,
                                               'unit_cents', i.unit_cents, 'kind', i.kind) order by i.id)
             from public.sale_items i where i.sale_id = s.id), '[]'::jsonb))
    from public.sales s where s.id = p_id
$$;

-- Create a pass for a class product. Enforces the intro offer rule.
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
                             billing_interval, next_billing_at, price_cents, class_type_ids, sale_id, stripe_subscription_id)
  values (p_client, pr.id, pr.kind, pr.name, 'active', app.now(),
          pr.validity_days,
          case when pr.kind = 'dropin' then coalesce(pr.credits, 1) else pr.credits end,
          case when pr.kind = 'membership' then coalesce(pr.billing_interval, 'week') end,
          p_next_billing_at, coalesce(p_price_cents, pr.price_cents), pr.class_type_ids, p_sale, p_stripe_subscription_id)
  returning * into p;
  return p;
end $$;

-- ----------------------------------------------------------------------------- POS

-- Studio POS cart: retail + passes in one sale. items = [{"product_id": "...", "qty": 1}, ...]
create or replace function public.checkout_cart(
  p_client_id uuid, p_items jsonb, p_method text,
  p_discount_cents integer default 0, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sale uuid;
  v_total int := 0;
  it record;
  pr public.products;
  p public.passes;
  v_passes jsonb := '[]'::jsonb;
  k int;
begin
  -- RULES: instructors can sell (but not refund).
  if not (app.is_privileged() or public.is_staff()) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to use the till.');
  end if;
  if p_method not in ('card_online','card_reader','cash','comp','imported') then
    perform app.fail('INVALID', 'Unknown payment method.');
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then perform app.fail('INVALID', 'The cart is empty.'); end if;
  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;

  insert into public.sales (client_id, total_cents, method, staff_id, note)
  values (p_client_id, 0, p_method, public.current_staff_id(), p_note) returning id into v_sale;

  for it in select (x ->> 'product_id')::uuid as product_id, greatest(coalesce((x ->> 'qty')::int, 1), 1) as qty
              from jsonb_array_elements(p_items) x
  loop
    select * into pr from public.products where id = it.product_id for update;
    if pr.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find one of the products.'); end if;
    if pr.kind <> 'retail' and p_client_id is null then
      perform app.fail('INVALID', 'Choose a client for class passes.');
    end if;
    if pr.kind = 'intro' and it.qty > 1 then perform app.fail('INTRO_NOT_ELIGIBLE', 'The intro offer is one per client.'); end if;
    if pr.kind = 'retail' and pr.stock is not null then
      if pr.stock < it.qty then perform app.fail('OUT_OF_STOCK', format('Only %s %s left in stock.', pr.stock, pr.name)); end if;
      update public.products set stock = stock - it.qty where id = pr.id;
    end if;
    insert into public.sale_items (sale_id, product_id, name, qty, unit_cents, kind)
    values (v_sale, pr.id, pr.name, it.qty, case when p_method = 'comp' then 0 else pr.price_cents end, pr.kind);
    v_total := v_total + it.qty * case when p_method = 'comp' then 0 else pr.price_cents end;
    if pr.kind <> 'retail' then
      for k in 1..it.qty loop
        p := app.create_pass(p_client_id, pr.id, v_sale, case when p_method = 'comp' then 0 else pr.price_cents end);
        v_passes := v_passes || jsonb_build_array(app.pass_json(p.id));
      end loop;
    end if;
  end loop;

  if coalesce(p_discount_cents, 0) > 0 and p_method <> 'comp' then
    insert into public.sale_items (sale_id, product_id, name, qty, unit_cents, kind)
    values (v_sale, null, 'Discount', 1, -least(p_discount_cents, v_total), 'discount');
    v_total := v_total - least(p_discount_cents, v_total);
  end if;
  update public.sales set total_cents = v_total where id = v_sale;
  if p_client_id is not null then perform app.queue_receipt(v_sale); end if;
  return jsonb_build_object('sale', app.sale_json(v_sale), 'passes', v_passes);
end $$;

create or replace function app.queue_receipt(p_sale uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales; c public.clients; st public.studio_settings;
begin
  select * into s from public.sales where id = p_sale;
  select * into c from public.clients where id = s.client_id;
  select * into st from public.studio_settings where id = 1;
  if c.id is null or coalesce(c.email, '') = '' or s.total_cents <= 0 then return; end if;
  insert into public.notifications (client_id, kind, to_email, payload)
  values (c.id, 'receipt', c.email, jsonb_build_object(
    'first_name', c.first_name, 'studio_name', st.name, 'abn', st.abn, 'address', st.address,
    'sale_id', s.id, 'created_at', s.created_at, 'total_cents', s.total_cents,
    'gst_cents', case when st.gst_registered then round(s.total_cents / 11.0)::int else 0 end,
    'method', s.method, 'items', app.sale_json(s.id) -> 'items'));
end $$;

-- ----------------------------------------------------------------------------- Stripe (service role only)

-- Called by the stripe-webhook edge function after checkout.session.completed.
-- Idempotent: a repeat of the same checkout session returns the existing sale + pass.
create or replace function public.create_pass_from_purchase(
  p_client_id uuid,
  p_product_id uuid,
  p_amount_cents integer,
  p_method text default 'card_online',
  p_stripe_checkout_session_id text default null,
  p_stripe_payment_intent_id text default null,
  p_stripe_invoice_id text default null,
  p_stripe_subscription_id text default null,
  p_next_billing_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sale uuid; pr public.products; p public.passes;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Purchases are recorded by the payment system.'); end if;

  select id into v_sale from public.sales
   where (p_stripe_checkout_session_id is not null and stripe_checkout_session_id = p_stripe_checkout_session_id)
      or (p_stripe_payment_intent_id is not null and stripe_payment_intent_id = p_stripe_payment_intent_id)
   limit 1;
  if v_sale is not null then
    return jsonb_build_object('sale', app.sale_json(v_sale),
      'pass', (select app.pass_json(id) from public.passes where sale_id = v_sale limit 1), 'duplicate', true);
  end if;

  select * into pr from public.products where id = p_product_id;
  if pr.id is null then perform app.fail('NOT_FOUND', 'Unknown product.'); end if;

  insert into public.sales (client_id, total_cents, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id)
  values (p_client_id, p_amount_cents, p_method, p_stripe_checkout_session_id, p_stripe_payment_intent_id, p_stripe_invoice_id)
  returning id into v_sale;
  insert into public.sale_items (sale_id, product_id, name, qty, unit_cents, kind)
  values (v_sale, pr.id, pr.name, 1, p_amount_cents, pr.kind);

  if pr.kind <> 'retail' then
    -- Already paid, so don't block on the intro rule here; it was checked before checkout.
    begin
      p := app.create_pass(p_client_id, pr.id, v_sale, p_amount_cents, p_stripe_subscription_id, p_next_billing_at);
    exception when others then
      if sqlerrm like 'INTRO_NOT_ELIGIBLE%' then
        insert into public.passes (client_id, product_id, kind, name, validity_days, credits, price_cents, sale_id)
        values (p_client_id, pr.id, pr.kind, pr.name, pr.validity_days, pr.credits, p_amount_cents, v_sale)
        returning * into p;
        perform app.audit('intro_rule_bypassed_after_payment', 'passes', p.id::text, null);
      else raise; end if;
    end;
  end if;
  perform app.queue_receipt(v_sale);
  return jsonb_build_object('sale', app.sale_json(v_sale), 'pass', case when p.id is not null then app.pass_json(p.id) end, 'duplicate', false);
end $$;

-- invoice.paid for a renewal (billing_reason = subscription_cycle). Idempotent per invoice.
create or replace function public.record_membership_payment(
  p_stripe_subscription_id text, p_stripe_invoice_id text, p_amount_cents integer,
  p_period_end timestamptz, p_payment_intent_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes; v_sale uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Payments are recorded by the payment system.'); end if;
  select * into p from public.passes where stripe_subscription_id = p_stripe_subscription_id for update;
  if p.id is null then perform app.fail('NOT_FOUND', 'No membership for that subscription yet.'); end if;
  update public.passes set next_billing_at = greatest(coalesce(next_billing_at, p_period_end), p_period_end),
         activated_at = coalesce(activated_at, app.now())
   where id = p.id;
  select id into v_sale from public.sales where stripe_invoice_id = p_stripe_invoice_id;
  if v_sale is null and p_amount_cents > 0 then
    insert into public.sales (client_id, total_cents, method, stripe_invoice_id, stripe_payment_intent_id, note)
    values (p.client_id, p_amount_cents, 'card_online', p_stripe_invoice_id, p_payment_intent_id, 'Membership renewal')
    returning id into v_sale;
    insert into public.sale_items (sale_id, product_id, name, qty, unit_cents, kind)
    values (v_sale, p.product_id, p.name, 1, p_amount_cents, 'membership');
    perform app.queue_receipt(v_sale);
  end if;
  return app.pass_json(p.id);
end $$;

-- customer.subscription.deleted: membership is over.
create or replace function public.end_membership_subscription(p_stripe_subscription_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  update public.passes set status = 'cancelled', cancel_at_period_end = true,
         next_billing_at = least(coalesce(next_billing_at, app.now()), app.now())
   where stripe_subscription_id = p_stripe_subscription_id returning * into p;
  if p.id is null then return null; end if;
  return app.pass_json(p.id);
end $$;

-- charge.refunded / refund-payment function: p_refunded_cents is Stripe's running total for the
-- payment, so this is absolute (safe to run twice, in any order).
create or replace function public.record_stripe_refund(
  p_payment_intent_id text, p_refunded_cents integer, p_cancel_pass boolean default false, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sale uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  update public.sales set refunded_cents = greatest(refunded_cents, least(total_cents, p_refunded_cents)),
         refunded_at = coalesce(refunded_at, app.now()),
         note = case when p_reason is not null and p_reason <> '' then concat_ws(' | ', note, 'Refund: ' || p_reason) else note end
   where stripe_payment_intent_id = p_payment_intent_id returning id into v_sale;
  if v_sale is null then return null; end if;
  if p_cancel_pass then
    update public.passes set status = 'cancelled',
           next_billing_at = case when kind = 'membership' then least(coalesce(next_billing_at, app.now()), app.now()) end
     where sale_id = v_sale and status <> 'cancelled';
  end if;
  perform app.audit('stripe_refund', 'sales', v_sale::text, jsonb_build_object('refunded_total', p_refunded_cents, 'cancel_pass', p_cancel_pass, 'reason', p_reason));
  return app.sale_json(v_sale);
end $$;

-- Staff refund (POS). For card_online sales the refund-payment edge function refunds in Stripe
-- first and then calls this. Cumulative: refunding twice adds up, capped at the total.
create or replace function public.refund_sale(
  p_sale_id uuid, p_amount_cents integer default null, p_cancel_pass boolean default false, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales; v_amt int;
begin
  if not (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to refund.');
  end if;
  select * into s from public.sales where id = p_sale_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that sale.'); end if;
  v_amt := coalesce(p_amount_cents, s.total_cents - s.refunded_cents);
  if v_amt <= 0 or s.refunded_cents + v_amt > s.total_cents then
    perform app.fail('INVALID', 'That''s more than is left to refund on this sale.');
  end if;
  update public.sales set refunded_cents = refunded_cents + v_amt, refunded_at = app.now(),
         note = concat_ws(' | ', note, 'Refund: ' || coalesce(nullif(p_reason, ''), 'no reason given'))
   where id = s.id;
  if p_cancel_pass then
    update public.passes set status = 'cancelled',
           next_billing_at = case when kind = 'membership' then least(coalesce(next_billing_at, app.now()), app.now()) end
     where sale_id = s.id and status <> 'cancelled';
  end if;
  perform app.audit('refund_sale', 'sales', s.id::text, jsonb_build_object('amount', v_amt, 'cancel_pass', p_cancel_pass, 'reason', p_reason));
  return app.sale_json(s.id);
end $$;

-- ----------------------------------------------------------------------------- memberships

create or replace function app.pass_for_change(p_pass_id uuid, p_client_may boolean) returns public.passes
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
  select * into p from public.passes where id = p_pass_id for update;
  if p.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that pass.'); end if;
  if app.is_privileged() or public.has_role('owner','manager','front_desk') then return p; end if;
  if p_client_may and p.client_id = public.current_client_id() then return p; end if;
  perform app.fail('NOT_ALLOWED', 'You don''t have permission to change this pass.');
end $$;

-- Pause (no booking, and Stripe billing paused by the manage-membership function). Minimum 1 week.
create or replace function public.pause_pass(p_pass_id uuid, p_from date, p_until date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true); v_today date := app.local_date(app.now());
begin
  if p.kind <> 'membership' and not (app.is_privileged() or public.is_staff()) then
    perform app.fail('INVALID', 'Only memberships can be paused.');
  end if;
  if p.status not in ('active','paused') then perform app.fail('INVALID', 'This pass isn''t active.'); end if;
  if p_from is null or p_until is null or p_until < p_from + 6 then
    perform app.fail('INVALID', 'A pause needs to be at least 1 week.');
  end if;
  if p_from < v_today and not (app.is_privileged() or public.is_staff()) then
    perform app.fail('INVALID', 'A pause can''t start in the past.');
  end if;
  update public.passes set paused_from = p_from, paused_until = p_until,
         status = case when p_from <= v_today then 'paused' else 'active' end
   where id = p.id;
  perform app.audit('pause_pass', 'passes', p.id::text, jsonb_build_object('from', p_from, 'until', p_until));
  return app.pass_json(p.id);
end $$;

create or replace function public.resume_pass(p_pass_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true);
begin
  update public.passes set paused_from = null, paused_until = null,
         status = case when status = 'paused' then 'active' else status end
   where id = p.id;
  perform app.audit('resume_pass', 'passes', p.id::text, null);
  return app.pass_json(p.id);
end $$;

-- Stop future billing. Status becomes 'cancelled' but the membership keeps working until
-- next_billing_at (the end of the period already paid for). The manage-membership edge function
-- also tells Stripe (cancel_at_period_end).
create or replace function public.cancel_membership(p_pass_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true);
begin
  if p.kind <> 'membership' then perform app.fail('INVALID', 'Only memberships can be cancelled this way.'); end if;
  if p.status = 'cancelled' then return app.pass_json(p.id); end if;
  update public.passes set cancel_at_period_end = true, status = 'cancelled',
         next_billing_at = coalesce(next_billing_at, case when activated_at is not null then activated_at + interval '7 days' end, app.now())
   where id = p.id;
  perform app.audit('cancel_membership', 'passes', p.id::text, null);
  return app.pass_json(p.id);
end $$;

-- Staff: add/remove pack credits and/or change expiry, with a reason.
create or replace function public.adjust_pass(
  p_pass_id uuid, p_credits_delta integer default 0, p_new_expires_at timestamptz default null,
  p_set_expiry boolean default false, p_reason text default ''
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, false); v_credits int; v_exp timestamptz;
begin
  if coalesce(trim(p_reason), '') = '' then perform app.fail('INVALID', 'Please add a reason.'); end if;
  v_credits := p.credits;
  if coalesce(p_credits_delta, 0) <> 0 then
    if p.credits is null then perform app.fail('INVALID', 'This pass is unlimited, so there are no credits to adjust.'); end if;
    if p.kind = 'membership' then perform app.fail('INVALID', 'Membership credits reset weekly. Book them in as a comp instead.'); end if;
    v_credits := p.credits + p_credits_delta;
    if v_credits < 0 then perform app.fail('INVALID', 'That would take the pass below zero credits.'); end if;
  end if;
  v_exp := case when p_set_expiry then p_new_expires_at else p.expires_at end;
  update public.passes set credits = v_credits, expires_at = v_exp,
         status = case
           when status in ('cancelled','paused') then status
           when v_exp is not null and v_exp <= app.now() then 'expired'
           when kind in ('pack','dropin') and v_credits is not null and credits_used >= v_credits then 'used_up'
           else 'active' end
   where id = p.id;
  insert into public.pass_adjustments (pass_id, staff_id, delta, new_expires_at, reason)
  values (p.id, public.current_staff_id(), coalesce(p_credits_delta, 0), case when p_set_expiry then p_new_expires_at end, p_reason);
  return app.pass_json(p.id);
end $$;

-- ----------------------------------------------------------------------------- reports

-- Shaped like StudioReport (snake_case keys are converted by the app). Owner/manager only.
-- payCents is only filled in for the owner (managers can't see pay rates).
create or replace function public.report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text := app.tz();
  v_now timestamptz := app.now();
  v_start timestamptz := (p_from::timestamp) at time zone v_tz;
  v_end timestamptz := ((p_to + 1)::timestamp) at time zone v_tz;
  v_pay boolean := app.is_privileged() or public.has_role('owner');
  v_money boolean := app.is_privileged() or public.has_role('owner','manager');
  v jsonb;
begin
  -- Attendance reports: all staff. Revenue: owner/manager only. Pay: owner only (RULES.md).
  if not (app.is_privileged() or public.is_staff()) then
    perform app.fail('NOT_ALLOWED', 'Reports are for staff.');
  end if;

  with
  sl as (select * from public.sales where created_at >= v_start and created_at < v_end),
  ses as (
    select s.*, ct.name as ct_name,
           count(b.*) filter (where b.status in ('booked','checked_in','no_show','late_cancelled')) as total_b,
           count(b.*) filter (where b.status = 'checked_in') as attended,
           count(b.*) filter (where b.status in ('booked','checked_in','no_show')) as filled,
           count(b.*) filter (where b.status = 'no_show') as no_shows,
           count(b.*) filter (where b.status = 'late_cancelled') as late_cancels
      from public.class_sessions s
      join public.class_types ct on ct.id = s.class_type_id
      left join public.bookings b on b.session_id = s.id
     where s.status = 'scheduled' and s.starts_at >= v_start and s.starts_at < v_end and s.starts_at < v_now
     group by s.id, ct.name)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'revenue_cents', coalesce((select sum(total_cents) from sl), 0),
    'refunds_cents', coalesce((select sum(refunded_cents) from public.sales where refunded_at >= v_start and refunded_at < v_end), 0),
    'revenue_by_method', coalesce((select jsonb_object_agg(method, c) from (select method, sum(total_cents) c from sl group by method) x), '{}'::jsonb),
    'revenue_by_kind', coalesce((select jsonb_object_agg(kind, c) from (
        select coalesce(i.kind, 'retail') as kind, sum(i.qty * i.unit_cents) c
          from public.sale_items i join sl on sl.id = i.sale_id
         where coalesce(i.kind, '') <> 'discount' group by 1) x), '{}'::jsonb),
    'sales_count', (select count(*) from sl),
    'classes_run', (select count(*) from ses),
    'total_bookings', coalesce((select sum(total_b) from ses), 0),
    'attended', coalesce((select sum(attended) from ses), 0),
    'no_shows', coalesce((select sum(no_shows) from ses), 0),
    'late_cancels', coalesce((select sum(late_cancels) from ses), 0),
    'avg_fill_pct', coalesce((select round(avg(least(100.0, filled * 100.0 / nullif(capacity, 0))), 1) from ses), 0),
    'new_clients', (select count(*) from public.clients where created_at >= v_start and created_at < v_end),
    'active_memberships', (select count(*) from public.passes where kind = 'membership' and status in ('active','paused')
                             and (expires_at is null or expires_at > v_now)),
    'active_packs', (select count(*) from public.passes where kind in ('pack','dropin','intro') and status = 'active'
                       and (expires_at is null or expires_at > v_now)),
    'by_instructor', coalesce((select jsonb_agg(jsonb_build_object('staff_id', st.id, 'name', st.name, 'classes', x.classes,
                        'attendees', x.att, 'pay_cents', case when v_pay then x.classes * coalesce(sp.pay_per_class_cents, 0) else 0 end) order by st.name)
        from (select instructor_id, count(*) classes, sum(attended) att from ses group by instructor_id) x
        join public.staff st on st.id = x.instructor_id
        left join public.staff_pay sp on sp.staff_id = st.id), '[]'::jsonb),
    'by_class_type', coalesce((select jsonb_agg(jsonb_build_object('class_type_id', class_type_id, 'name', ct_name, 'classes', classes,
                        'attendees', att, 'avg_fill_pct', fill) order by ct_name)
        from (select class_type_id, ct_name, count(*) classes, sum(attended) att,
                     round(avg(least(100.0, filled * 100.0 / nullif(capacity, 0))), 1) fill
                from ses group by class_type_id, ct_name) x), '[]'::jsonb),
    'top_slots', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'avg_attendees', avg_att) order by avg_att desc, label)
        from (select to_char(starts_at at time zone v_tz, 'Dy') || ' ' || lower(to_char(starts_at at time zone v_tz, 'FMHH12:MIam')) as label,
                     round(avg(attended + 0.0), 1) as avg_att
                from ses group by 1 order by 2 desc limit 5) x), '[]'::jsonb)
  ) into v;
  if not v_money then
    v := v || jsonb_build_object('revenue_cents', 0, 'refunds_cents', 0, 'revenue_by_method', '{}'::jsonb,
                                 'revenue_by_kind', '{}'::jsonb, 'sales_count', 0);
  end if;
  return v;
end $$;

-- ----------------------------------------------------------------------------- housekeeping (pg_cron)

-- Every 15 minutes: clear waitlists of started classes, expire passes, flip pause states.
create or replace function public.housekeeping() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now(); v_today date := app.local_date(app.now()); a int; b int; c int;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  update public.bookings bk set status = 'removed', waitlist_position = null
    from public.class_sessions s
   where s.id = bk.session_id and bk.status = 'waitlisted' and s.starts_at <= v_now;
  get diagnostics a = row_count;
  update public.passes set status = 'expired'
   where status in ('active','paused') and expires_at is not null and expires_at <= v_now;
  get diagnostics b = row_count;
  update public.passes set status = 'paused'
   where status = 'active' and paused_from is not null and paused_from <= v_today and (paused_until is null or paused_until >= v_today);
  update public.passes set status = 'active', paused_from = null, paused_until = null
   where status = 'paused' and paused_until is not null and paused_until < v_today;
  get diagnostics c = row_count;
  return jsonb_build_object('waitlist_removed', a, 'passes_expired', b, 'pauses_ended', c);
end $$;

-- Queue "see you soon" emails for classes starting in the next 2 hours. Run every 10-15 min.
create or replace function public.queue_class_reminders(p_hours numeric default 2) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now(); r record; n int := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for r in select b.id from public.bookings b join public.class_sessions s on s.id = b.session_id
            where b.status = 'booked' and b.reminder_sent_at is null and s.status = 'scheduled'
              and s.starts_at > v_now and s.starts_at <= v_now + make_interval(secs => p_hours * 3600)
            for update of b skip locked
  loop
    perform app.notify(r.id, 'class_reminder');
    update public.bookings set reminder_sent_at = v_now where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ----------------------------------------------------------------------------- sign-up linking

-- When someone signs up (or confirms their email):
--   1. already linked? nothing to do.
--   2. confirmed + a staff row has that email -> link the staff login.
--   3. confirmed + an imported/staff-created client has that email -> link it (keeps their history).
--   4. otherwise create a fresh client from the sign-up details (unless a matching unlinked
--      row exists and we're just waiting for the email to be confirmed).
create or replace function app.link_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := lower(coalesce(new.email, ''));
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_confirmed boolean := new.email_confirmed_at is not null;
  v_id uuid;
begin
  if exists (select 1 from public.staff where user_id = new.id) or exists (select 1 from public.clients where user_id = new.id) then
    return new;
  end if;
  if v_email = '' then return new; end if;

  if v_confirmed then
    update public.staff set user_id = new.id where lower(email) = v_email and user_id is null returning id into v_id;
    if v_id is not null then return new; end if;
    select id into v_id from public.clients where lower(email) = v_email and user_id is null order by created_at limit 1;
    if v_id is not null then
      update public.clients set user_id = new.id,
             phone = coalesce(phone, nullif(v_meta ->> 'phone', ''))
       where id = v_id;
      return new;
    end if;
  elsif exists (select 1 from public.staff where lower(email) = v_email and user_id is null)
     or exists (select 1 from public.clients where lower(email) = v_email and user_id is null) then
    return new; -- wait for confirmation before linking to an existing record
  end if;

  insert into public.clients (user_id, first_name, last_name, email, phone, marketing_opt_in, source)
  values (new.id, coalesce(v_meta ->> 'first_name', ''), coalesce(v_meta ->> 'last_name', ''), coalesce(new.email, ''),
          nullif(v_meta ->> 'phone', ''), coalesce((v_meta ->> 'marketing_opt_in')::boolean, false), 'app');
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users for each row execute function app.link_auth_user();
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function app.link_auth_user();

-- Who am I? One call for the app after sign-in.
create or replace function public.whoami() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object('kind', 'staff', 'staff_id', id, 'email', coalesce(email, ''), 'name', name, 'role', role)
       from public.staff where user_id = auth.uid() and active),
    (select jsonb_build_object('kind', 'client', 'client_id', id, 'email', email, 'name', trim(first_name || ' ' || last_name))
       from public.clients where user_id = auth.uid()))
$$;

-- ----------------------------------------------------------------------------- grants
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.now(), app.tz(), app.is_privileged() to anon, authenticated;

revoke execute on function public.checkout_cart, public.create_pass_from_purchase, public.record_membership_payment,
  public.end_membership_subscription, public.record_stripe_refund, public.refund_sale, public.pause_pass,
  public.resume_pass, public.cancel_membership, public.adjust_pass, public.report, public.housekeeping,
  public.queue_class_reminders from public, anon;
revoke execute on function public.create_pass_from_purchase, public.record_membership_payment,
  public.end_membership_subscription, public.record_stripe_refund, public.housekeeping,
  public.queue_class_reminders from authenticated;
grant execute on function public.checkout_cart, public.refund_sale, public.pause_pass, public.resume_pass,
  public.cancel_membership, public.adjust_pass, public.report, public.whoami to authenticated;
grant execute on all functions in schema public to service_role;
