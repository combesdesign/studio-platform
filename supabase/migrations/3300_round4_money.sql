-- Testing round 4: money flows. Four fixes, each with regression assertions in supabase/tests/money_round4.sql
-- (and platform-webhook ordering in supabase/tests/functions.test.mjs).
--
-- 1. billing_apply: a late "cancelled" event for a subscription the studio no longer uses (it cancelled, then subscribed again)
--    wiped the NEW subscription's id and marked the studio cancelled. A cancelled status now only applies to the subscription
--    the studio is currently on (or when it has none stored).
-- 2. refund_sale: staff could "refund" a card payment that went through Stripe (online, or the card reader) by calling the
--    RPC directly. That recorded a refund with no money moving, and then the real refund was refused as "nothing left".
--    Stripe-paid sales now refuse the staff RPC; the refund-payment function (service role, record_stripe_refund) is the only way.
-- 3. terminal_quote: didn't apply the rules the sale applies later (intro / new-client products, two lines for one product's
--    stock, suspended studio), so the card could be charged and the sale then fail to record (paid_unrecorded).
-- 4. commerce_purchase_with_codes: a membership could be "bought" with a gift card or 100% code, giving a membership that is
--    never billed and never ends (no Stripe subscription, no renewal date). The client app never offers it; the RPC now refuses it.

-- 1 ------------------------------------------------------------------------------------------------------------------
create or replace function public.billing_apply(p_studio uuid, p_plan uuid, p_status text, p_customer text default null, p_subscription text default null,
  p_period_end timestamptz default null, p_cancel_at_period_end boolean default null, p_trial_end timestamptz default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_current text;
begin
  if p_status not in ('trialing','active','past_due','cancelled') then perform app.fail('INVALID', 'Unknown billing status.'); end if;
  if p_plan is not null and not exists (select 1 from public.plans where id = p_plan) then perform app.fail('NOT_FOUND', 'That plan could not be found.'); end if;
  if p_status = 'cancelled' and p_subscription is not null then
    select stripe_subscription_id into v_current from public.studio_billing where studio_id = p_studio;
    if v_current is not null and v_current <> p_subscription then return; end if;   -- an old subscription ending, not the current one
  end if;
  update public.studios set
    plan_id = coalesce(p_plan, plan_id), billing_status = p_status, billing_comped = false,
    past_due_since = case when p_status = 'past_due' then coalesce(past_due_since, now()) else null end,
    trial_ends_at = case when p_status = 'trialing' then coalesce(p_trial_end, trial_ends_at) else null end
   where id = p_studio;
  if not found then perform app.fail('NOT_FOUND', 'That studio could not be found.'); end if;
  insert into public.studio_billing (studio_id, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end)
  values (p_studio, p_customer, p_subscription, p_period_end, coalesce(p_cancel_at_period_end, false))
  on conflict (studio_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, public.studio_billing.stripe_customer_id),
    stripe_subscription_id = case when p_status = 'cancelled' then null else coalesce(excluded.stripe_subscription_id, public.studio_billing.stripe_subscription_id) end,
    current_period_end = coalesce(excluded.current_period_end, public.studio_billing.current_period_end),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, public.studio_billing.cancel_at_period_end),
    updated_at = now();
end $$;

-- 2 ------------------------------------------------------------------------------------------------------------------
create or replace function public.refund_sale(p_sale_id uuid, p_amount_cents integer default null, p_cancel_pass boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales; r jsonb;
begin
  perform app.assert_in_studio('sales', p_sale_id, 'We couldn''t find that sale.');
  select * into s from public.sales where id = p_sale_id;
  if (s.stripe_payment_intent_id is not null or s.stripe_checkout_session_id is not null or s.stripe_invoice_id is not null)
     and not app.is_privileged() and public.has_role('owner','manager','front_desk') then
    perform app.fail('INVALID', 'That was paid by card through Stripe, so the refund has to go back through Stripe. Use Refund on the sale.');
  end if;
  if s.total_cents = 0 and s.refunded_at is null and coalesce(p_amount_cents, 0) = 0 and (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    -- paid with codes only: nothing to give back in money, but the stock and the gift card amount can still go back
    update public.sales set refunded_at = app.now(), note = concat_ws(' | ', note, 'Refund: ' || coalesce(nullif(p_reason, ''), 'no reason given')) where id = s.id;
    if p_cancel_pass then
      update public.passes set status = 'cancelled',
             next_billing_at = case when kind = 'membership' then least(coalesce(next_billing_at, app.now()), app.now()) end
       where sale_id = s.id and status <> 'cancelled';
    end if;
    perform app.audit('refund_sale', 'sales', s.id::text, jsonb_build_object('amount', 0, 'cancel_pass', p_cancel_pass, 'reason', p_reason));
    r := app.sale_json(s.id);
  else
    r := app.refund_sale_impl(p_sale_id, p_amount_cents, p_cancel_pass, p_reason);
  end if;
  perform app.commerce_unwind_sale(p_sale_id);
  return r;
end $$;

-- 3 ------------------------------------------------------------------------------------------------------------------
create or replace function public.terminal_quote(p_client_id uuid, p_items jsonb, p_discount_cents integer default 0) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare it record; pr public.products; v_total int := 0; v_limited int := 0;
begin
  if not (app.is_privileged() or public.is_staff()) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to use the till.'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform app.fail('INVALID', 'The cart is empty.'); end if;
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  perform app.assert_studio_open(app.current_studio_id());
  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  for it in select (x ->> 'product_id')::uuid as product_id, greatest(coalesce((x ->> 'qty')::int, 1), 1) as qty
              from jsonb_array_elements(p_items) x
  loop
    perform app.assert_in_studio('products', it.product_id, 'We couldn''t find one of the products.');
    select * into pr from public.products where id = it.product_id;
    if pr.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find one of the products.'); end if;
    if pr.kind <> 'retail' and p_client_id is null then perform app.fail('INVALID', 'Choose a client for class passes.'); end if;
    if pr.kind = 'intro' and it.qty > 1 then perform app.fail('INTRO_NOT_ELIGIBLE', 'The intro offer is one per client.'); end if;
    -- the same rule the sale applies once the card goes through: new-client offers only for someone who is one, and only once
    if pr.kind = 'intro' or pr.new_clients_only then
      v_limited := v_limited + it.qty;
      if p_client_id is not null and not public.is_intro_eligible(p_client_id) then
        perform app.fail('INTRO_NOT_ELIGIBLE', 'The intro offer is for new clients only.');
      end if;
    end if;
    v_total := v_total + it.qty * pr.price_cents;
  end loop;
  if v_limited > 1 then perform app.fail('INTRO_NOT_ELIGIBLE', 'The intro offer is one per client.'); end if;
  -- stock, counting a product that is in the cart on more than one line once
  for it in select (x ->> 'product_id')::uuid as product_id, sum(greatest(coalesce((x ->> 'qty')::int, 1), 1))::int as qty
              from jsonb_array_elements(p_items) x group by 1
  loop
    select * into pr from public.products where id = it.product_id;
    if pr.kind = 'retail' and pr.stock is not null and pr.stock < it.qty then
      perform app.fail('OUT_OF_STOCK', format('Only %s %s left in stock.', pr.stock, pr.name));
    end if;
  end loop;
  v_total := v_total - least(greatest(coalesce(p_discount_cents, 0), 0), v_total);
  return v_total;
end $$;

-- 4 ------------------------------------------------------------------------------------------------------------------
create or replace function public.commerce_purchase_with_codes(p_product_id uuid, p_promo_code text default null, p_gift_codes text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); v_me uuid := app.commerce_client(); q jsonb; pr public.products; v_sale uuid;
  v_off int; v_note text; g jsonb; v_pass public.passes;
begin
  perform app.assert_studio_open(sid);
  perform app.assert_in_studio('products', p_product_id, 'We couldn’t find that product.');
  if (select kind from public.products where id = p_product_id) = 'membership' then
    perform app.fail('INVALID', 'A membership can’t be paid for with codes alone, because nothing would bill it after the first week. Ask the studio to set it up at the desk.');
  end if;
  perform app.commerce_tick();
  q := app.commerce_quote(v_me, jsonb_build_array(jsonb_build_object('product_id', p_product_id, 'qty', 1)), null, p_promo_code, coalesce(p_gift_codes, '{}'), 'client', true);
  if q ->> 'promo_error' is not null then perform app.fail('INVALID', q ->> 'promo_error'); end if;
  if jsonb_array_length(q -> 'gift_errors') > 0 then perform app.fail('INVALID', q #>> '{gift_errors,0,message}'); end if;
  if coalesce(p_promo_code, '') = '' and cardinality(coalesce(p_gift_codes, '{}')) = 0 then perform app.fail('INVALID', 'Add a promo code or a gift card first.'); end if;
  if (q ->> 'total_cents')::int > 0 then
    perform app.fail('PAYMENT_REQUIRED', 'Your codes don’t cover the whole price yet, and paying the rest online isn’t switched on. Ask the studio to take payment at the desk, or use a gift card that covers it.');
  end if;
  select * into pr from public.products where id = p_product_id and studio_id = sid for update;
  if pr.id is null or not pr.active then perform app.fail('NOT_FOUND', 'We couldn’t find that product.'); end if;
  if pr.kind = 'retail' and pr.stock is not null then
    if pr.stock < 1 then perform app.fail('OUT_OF_STOCK', format('Only %s %s left in stock.', pr.stock, pr.name)); end if;
    update public.products set stock = stock - 1 where id = pr.id;
  end if;
  v_off := (q ->> 'promo_cents')::int + (q ->> 'gift_cents')::int;
  v_note := concat_ws(' · ',
    case when (q ->> 'promo_cents')::int > 0 then 'Promo ' || (q #>> '{promo,code}') || ' −' || app.commerce_money((q ->> 'promo_cents')::int, true) end,
    (select string_agg(case when x ->> 'kind' = 'credit' then 'Credit ' else 'Gift card ' end || app.commerce_mask(x ->> 'code') || ' −' || app.commerce_money((x ->> 'applied_cents')::int, true), ' · ')
       from jsonb_array_elements(q -> 'gifts') x));
  insert into public.sales (studio_id, client_id, total_cents, method, note) values (sid, v_me, 0, 'card_online', v_note) returning id into v_sale;
  insert into public.sale_items (studio_id, sale_id, product_id, name, qty, unit_cents, kind) values (sid, v_sale, pr.id, pr.name, 1, pr.price_cents, pr.kind);
  if v_off > 0 then insert into public.sale_items (studio_id, sale_id, name, qty, unit_cents, kind) values (sid, v_sale, 'Discount', 1, -v_off, 'discount'); end if;
  if pr.kind <> 'retail' then v_pass := app.create_pass(v_me, pr.id, v_sale, pr.price_cents); end if;
  perform app.commerce_record(q, v_me, 'posted', null, v_sale, 'Used on ' || pr.name, null);
  perform app.commerce_settle_referrals();
  return jsonb_build_object('sale', app.sale_json(v_sale), 'quote', q);
end $$;
