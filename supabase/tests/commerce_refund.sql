-- Commerce: a fully refunded sale puts the stock back and returns the gift card amount (once, however often it is told).
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney. Socks cost 2000.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

select test.login('libby');
select public.commerce_adjust_stock(jsonb_build_object('product_id', test.id('p_socks'), 'set_to', 10, 'reason', 'count')) ->> 'stock' as s0 \gset
select (public.commerce_sell_gift_card('{"amount_cents":5000,"method":"cash"}') -> 'card' ->> 'id') as card \gset
select test.admin();
select code as the_code from public.commerce_gift_cards where id = :'card' \gset

-- two pairs of socks ($40) paid entirely with the card, through the till
select test.login('fran');
select public.commerce_hold_codes(jsonb_build_object('client_id', test.id('gus_client'), 'items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2)),
                                                    'gift_codes', jsonb_build_array(:'the_code'))) ->> 'token' as tok \gset
select (public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2)), 'card_reader', 4000, 'Gift card · ref ' || :'tok') -> 'sale' ->> 'id') as sale \gset
select public.commerce_settle_hold(:'tok');
select test.admin();
select test.eq((select stock from public.products where id = test.id('p_socks')), 8, 'the sale took 2 off the shelf');
select test.eq(app.commerce_balance(:'card'::uuid), 1000, '...and $40 off the card');

-- refunding the whole sale
select test.login('fran');
select public.refund_sale(:'sale'::uuid, null, false, 'Wrong size');
select test.admin();
select test.eq((select stock from public.products where id = test.id('p_socks')), 10, 'a full refund puts the socks back');
select test.eq(app.commerce_balance(:'card'::uuid), 5000, '...and the $40 back on the gift card');
select test.eq((select count(*)::int from public.commerce_stock_log where product_id = test.id('p_socks') and reason = 'returned' and delta = 2), 1, '...with a stock log line');
select test.eq((select count(*)::int from public.commerce_gift_entries where card_id = :'card'::uuid and kind = 'refund' and sale_id = :'sale'::uuid), 1, '...and one refund entry on the card');

-- telling it again (the sale is already refunded; Stripe repeats its news) changes nothing
select test.login('fran');
select test.throws(format('select public.refund_sale(%L)', :'sale'), 'INVALID', 'a second refund of the same sale is refused');
select test.admin();
select app.commerce_unwind_sale(:'sale'::uuid);
select test.eq((select stock from public.products where id = test.id('p_socks')), 10, 'unwinding twice leaves the stock alone');
select test.eq(app.commerce_balance(:'card'::uuid), 5000, '...and the card balance');

rollback;
