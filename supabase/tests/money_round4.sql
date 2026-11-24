-- Testing round 4 (money flows): regression checks for 3300_round4_money.sql, plus invariants on refunds, codes and gift cards.
-- Obviously fake data only. "Now" is Monday 19 Oct 2026, 8:00am Sydney.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- ============================================================ 1. Stripe-paid sales are refunded through Stripe, never by the staff RPC
select test.service();
select (public.create_pass_from_purchase(test.id('gus_client'), test.id('p_pack4'), 10000, 'card_online', 'cs_r4_1', 'pi_r4_1') -> 'sale' ->> 'id') as sale \gset
select (public.create_pass_from_purchase(test.id('gus_client'), test.id('p_pack4'), 10000, 'card_online', 'cs_r4_1', 'pi_r4_1') ->> 'duplicate')::boolean as dup \gset
select test.ok(:'dup', 'the same checkout delivered twice makes no second sale');
select test.eq((select count(*)::int from public.sales where stripe_checkout_session_id = 'cs_r4_1'), 1, '...one sale');
select test.eq((select count(*)::int from public.passes where sale_id = :'sale'::uuid), 1, '...and one pass');
select test.admin();

select test.login('fran');
select test.throws(format('select public.refund_sale(%L)', :'sale'), 'INVALID', 'front desk can''t record a refund on a card payment made through Stripe');
select test.throws(format('select public.refund_sale(%L, 500)', :'sale'), 'INVALID', '...not a part refund either');
select test.throws(format('select public.void_sale(%L)', :'sale'), 'INVALID', '...nor void it');
select test.login('libby');
select test.throws(format('select public.refund_sale(%L)', :'sale'), 'INVALID', 'the owner can''t either');
select test.admin();
select test.eq((select refunded_cents from public.sales where id = :'sale'::uuid), 0, 'nothing was recorded as refunded');

-- the payment system records what Stripe says: running total, never above what was paid, never going down, safe to repeat
select test.service();
select test.eq((public.record_stripe_refund('pi_r4_1', 3000) ->> 'refunded_cents')::int, 3000, 'Stripe: $30 refunded');
select test.eq((public.record_stripe_refund('pi_r4_1', 3000) ->> 'refunded_cents')::int, 3000, 'the same news again changes nothing');
select test.eq((public.record_stripe_refund('pi_r4_1', 1000) ->> 'refunded_cents')::int, 3000, 'an older (smaller) total arriving late doesn''t reduce it');
select test.eq((public.record_stripe_refund('pi_r4_1', -50) ->> 'refunded_cents')::int, 3000, 'a negative total is ignored');
select test.eq((public.record_stripe_refund('pi_r4_1', 99999) ->> 'refunded_cents')::int, 10000, 'never more than was paid');
select test.ok(public.record_stripe_refund('pi_unknown_r4', 100) is null, 'an unknown payment is ignored');
select test.admin();

-- a desk sale with no Stripe ids (cash, or an old card sale) is still refundable by staff, once, and not above the total
select test.login('fran');
select (public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'cash') -> 'sale' ->> 'id') as cashsale \gset
select test.throws(format('select public.refund_sale(%L, 99999)', :'cashsale'), 'INVALID', 'can''t refund more than was paid');
select test.throws(format('select public.refund_sale(%L, -5)', :'cashsale'), 'INVALID', 'can''t refund a negative amount');
select test.eq((public.refund_sale(:'cashsale'::uuid, 1000, false, 'part') ->> 'refunded_cents')::int, 1000, 'part refund of a cash sale');
select test.throws(format('select public.refund_sale(%L, 2500)', :'cashsale'), 'INVALID', 'a second part refund can''t take it over the total');
select test.eq((public.refund_sale(:'cashsale'::uuid, 2000, false, 'rest') ->> 'refunded_cents')::int, 3000, 'the rest');
select test.throws(format('select public.refund_sale(%L, 1)', :'cashsale'), 'INVALID', 'nothing left to refund');
select test.admin();

-- ============================================================ 2. Till card payments are quoted by the rules the sale will apply
-- erin has no passes yet, so the intro offer is hers once
select test.ok(not exists (select 1 from public.passes where client_id = test.id('erin_client')), 'erin is a new client');
select test.login('fran');
select test.eq(public.terminal_quote(test.id('erin_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro'))), 0), 4900, 'a new client is quoted the intro price');
select test.throws(format('select public.terminal_quote(%L, %L::jsonb, 0)', test.id('erin_client'),
  jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro')), jsonb_build_object('product_id', test.id('p_intro')))::text),
  'INTRO_NOT_ELIGIBLE', 'the intro offer on two lines is refused before the card is charged');
select test.throws(format('select public.terminal_quote(%L, %L::jsonb, 0)', test.id('alice_client'),
  jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro')))::text),
  'INTRO_NOT_ELIGIBLE', 'a client who already has a pass can''t be charged for the intro offer');
select test.throws(format('select public.terminal_quote(%L, %L::jsonb, 0)', test.id('alice_client'),
  jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro')), jsonb_build_object('product_id', test.id('p_pack4')))::text),
  'INTRO_NOT_ELIGIBLE', '...also inside a bigger cart');
select test.admin();
update public.products set stock = 3 where id = test.id('p_socks');
select test.login('fran');
select test.throws(format('select public.terminal_quote(null, %L::jsonb, 0)', jsonb_build_array(
  jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2), jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2))::text),
  'OUT_OF_STOCK', 'two lines of the same product are counted together for stock');
select test.eq(public.terminal_quote(null, jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'), 'qty', 3)), 0), 6000, 'three pairs at $20');
select test.eq(public.terminal_quote(null, jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'), 'qty', 1)), 999999), 0, 'a discount can''t take the amount below zero');
select test.eq(public.terminal_quote(null, jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'), 'qty', 1)), -500), 2000, 'a negative discount adds nothing');
select test.throws($$select public.terminal_quote(null, '[]'::jsonb, 0)$$, 'INVALID', 'an empty cart');
select test.throws(format('select public.terminal_quote(null, %L::jsonb, 0)', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4')))::text), 'INVALID', 'a pass needs a client');
select test.login('cara');
select test.throws(format('select public.terminal_quote(null, %L::jsonb, 0)', jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks')))::text), 'NOT_ALLOWED', 'a client can''t use the till');
select test.admin();

-- ============================================================ 3. Codes can't buy a membership that nothing will ever bill
select test.login('libby');
select public.commerce_upsert_promo('{"code":"FREEWEEK","kind":"percent","value":100,"max_uses":2}') is not null as made \gset
select test.admin();
select test.login('alice');
select test.throws(format('select public.commerce_purchase_with_codes(%L, %L)', test.id('p_week1'), 'FREEWEEK'), 'INVALID', 'a 100% code can''t buy a membership');
select test.eq((select count(*)::int from public.passes where client_id = test.id('alice_client') and kind = 'membership'), 0, '...no membership was made');
select test.admin();
select test.login('libby');
select (public.commerce_sell_gift_card('{"amount_cents":9000,"method":"cash"}') -> 'card' ->> 'id') as gcard \gset
select test.admin();
select code as gcode from public.commerce_gift_cards where id = :'gcard' \gset
select test.login('alice');
select test.throws(format('select public.commerce_purchase_with_codes(%L, null, array[%L])', test.id('p_unlimited'), :'gcode'), 'INVALID', 'a gift card that covers it can''t buy a membership either');
select test.admin();
select test.eq(app.commerce_balance(:'gcard'::uuid), 9000, '...and the card is untouched');

-- a $90 card doesn't cover a $100 pack, and a refused purchase takes nothing
select test.login('alice');
select test.throws(format('select public.commerce_purchase_with_codes(%L, null, array[%L])', test.id('p_pack4'), :'gcode'), 'PAYMENT_REQUIRED', 'a card with less than the price doesn''t cover a pack');
select test.admin();
select test.eq(app.commerce_balance(:'gcard'::uuid), 9000, 'a refused purchase takes nothing off the card');
select test.login('libby');
select test.throws(format('select public.commerce_adjust_gift_card(%L, -9001, ''too much'')', :'gcard'), 'INVALID', 'a card can''t be taken below $0');
select test.eq((public.commerce_adjust_gift_card(:'gcard'::uuid, -9000, 'close it') ->> 'balance_cents')::int, 0, 'but down to exactly $0');
select test.admin();
select test.login('alice');
select test.throws(format('select public.commerce_purchase_with_codes(%L, null, array[%L])', test.id('p_single'), :'gcode'), 'INVALID', 'a card with no balance can''t be spent');
select test.admin();

-- a promo with max uses can't be claimed past it (the third try is refused), and a sale can't go below $0
select test.login('alice');
select test.eq((public.commerce_purchase_with_codes(test.id('p_single'), 'FREEWEEK') -> 'sale' ->> 'total_cents')::int, 0, 'FREEWEEK: first use');
select test.admin();
select test.login('bob');
select test.eq((public.commerce_purchase_with_codes(test.id('p_single'), 'FREEWEEK') -> 'sale' ->> 'total_cents')::int, 0, 'FREEWEEK: second use');
select test.admin();
select test.login('dan');
select test.throws(format('select public.commerce_purchase_with_codes(%L, %L)', test.id('p_single'), 'FREEWEEK'), 'INVALID', 'FREEWEEK: the third use is refused (fully claimed)');
select test.admin();
select test.ok(not exists (select 1 from public.sales where total_cents < 0), 'no sale anywhere has a negative total');

-- ============================================================ 4. A subscription that ended long ago can't switch off the current one
select id as plan1 from public.plans order by sort_order limit 1 \gset
select id as snowy from public.studios where slug = 'snowy' \gset
select public.billing_apply(:'snowy'::uuid, :'plan1'::uuid, 'active', 'cus_r4', 'sub_r4_old', now() + interval '7 days', false, null);
select public.billing_apply(:'snowy'::uuid, :'plan1'::uuid, 'cancelled', 'cus_r4', 'sub_r4_old', null, false, null);
select test.eq((select billing_status from public.studios where id = :'snowy'::uuid), 'cancelled', 'the first subscription ends: cancelled');
select public.billing_apply(:'snowy'::uuid, :'plan1'::uuid, 'active', 'cus_r4', 'sub_r4_new', now() + interval '30 days', false, null);
select test.eq((select stripe_subscription_id from public.studio_billing where studio_id = :'snowy'::uuid), 'sub_r4_new', 'they subscribe again');
select public.billing_apply(:'snowy'::uuid, null, 'cancelled', 'cus_r4', 'sub_r4_old', null, false, null);   -- the old one's delete event arrives late
select test.eq((select billing_status from public.studios where id = :'snowy'::uuid), 'active', 'a late "cancelled" for the old subscription changes nothing');
select test.eq((select stripe_subscription_id from public.studio_billing where studio_id = :'snowy'::uuid), 'sub_r4_new', '...and the current subscription id is kept');
select public.billing_apply(:'snowy'::uuid, null, 'cancelled', 'cus_r4', 'sub_r4_new', null, false, null);
select test.eq((select billing_status from public.studios where id = :'snowy'::uuid), 'cancelled', 'the current subscription ending does cancel');

rollback;
