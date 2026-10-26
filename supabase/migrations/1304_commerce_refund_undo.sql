-- =============================================================================
-- Commerce: a refunded sale puts things back.
-- When a sale is refunded IN FULL (staff refund, or Stripe's charge.refunded):
--   * retail items go back on the shelf (tracked stock only), logged as "returned"
--   * any gift card / credit used on the sale gets that amount back (a 'refund' entry on the card)
-- Both are safe to run again (Stripe tells us the running refund total more than once): the stock log and the
-- card entries are the memory. Partial refunds change nothing here. Promo redemptions are left as they are.
-- A sale paid entirely with codes has a $0 total, so refund_sale marks it refunded without moving any money.
-- =============================================================================

create or replace function app.commerce_unwind_sale(p_sale uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales; e record; it record; v_before int;
begin
  select * into s from public.sales where id = p_sale;
  if s.id is null or s.refunded_at is null or s.refunded_cents < s.total_cents then return; end if;
  perform app.commerce_reconcile();   -- a till hold for this sale becomes a real redemption before we look for it

  for e in select x.card_id, -x.cents as back from public.commerce_gift_entries x
            join public.commerce_gift_cards c on c.id = x.card_id and c.studio_id = x.studio_id
           where x.studio_id = s.studio_id and x.sale_id = s.id and x.kind = 'redeem' and x.state = 'posted' and x.cents < 0 and c.status <> 'void'
             and not exists (select 1 from public.commerce_gift_entries r where r.studio_id = x.studio_id and r.card_id = x.card_id and r.sale_id = s.id and r.kind = 'refund')
  loop
    insert into public.commerce_gift_entries (studio_id, card_id, kind, cents, note, sale_id)
    values (s.studio_id, e.card_id, 'refund', e.back, 'Put back: sale refunded', s.id);
  end loop;

  for it in select i.product_id, sum(i.qty)::int qty from public.sale_items i
             where i.sale_id = s.id and i.kind = 'retail' and i.product_id is not null group by i.product_id
  loop
    v_before := null;
    continue when exists (select 1 from public.commerce_stock_log l where l.studio_id = s.studio_id and l.product_id = it.product_id and l.reason = 'returned' and l.note = 'Sale refunded ' || s.id);
    update public.products set stock = stock + it.qty where id = it.product_id and stock is not null returning stock - it.qty into v_before;
    if v_before is not null then
      insert into public.commerce_stock_log (studio_id, product_id, product_name, delta, before_count, after_count, reason, note)
      select s.studio_id, p.id, p.name, it.qty, v_before, p.stock, 'returned', 'Sale refunded ' || s.id from public.products p where p.id = it.product_id;
    end if;
  end loop;
end $$;

-- Staff refund (same signature as 0007's wrapper).
create or replace function public.refund_sale(p_sale_id uuid, p_amount_cents integer default null, p_cancel_pass boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales; r jsonb;
begin
  perform app.assert_in_studio('sales', p_sale_id, 'We couldn''t find that sale.');
  select * into s from public.sales where id = p_sale_id;
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

-- Stripe told us how much of a payment is refunded (charge.refunded, or right after refund-payment).
create or replace function public.record_stripe_refund(
  p_payment_intent_id text, p_refunded_cents integer, p_cancel_pass boolean default false, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  perform app.use_studio((select studio_id from public.sales where stripe_payment_intent_id = p_payment_intent_id));
  r := app.record_stripe_refund_impl(p_payment_intent_id, p_refunded_cents, p_cancel_pass, p_reason);
  if r is not null then perform app.commerce_unwind_sale((r ->> 'id')::uuid); end if;
  return r;
end $$;

revoke execute on function app.commerce_unwind_sale(uuid) from public, anon, authenticated;
