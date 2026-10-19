-- Commerce (B3): gift cards (balance, partial redemption, holds, void, expiry, online purchase), promo codes
-- (limits, expiry, new clients only, per product), referral rewards, retail stock with barcodes, and who may do what.
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney. Snowy: Libby owner, Mia manager, Fran front desk, Julia instructor.
-- Clients: Alice, Bob, Dan, Fay, Gus have passes; Cara and Erin are new. Prices: single 3000, 4 pack 10000, socks 2000.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create or replace function test.count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
grant execute on function test.studio(text), test.count(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- shop settings
select test.login('alice');
select test.eq((public.commerce_get_settings() ->> 'gift_card_expiry_months')::int, 36, 'any client can read the shop settings (defaults: 36 months)');
select test.throws($$select public.commerce_update_settings('{"referral_reward_cents":2500}')$$, 'NOT_ALLOWED', 'a client can''t change the shop settings');
select test.login('fran');
select test.throws($$select public.commerce_update_settings('{"referral_reward_cents":2500}')$$, 'NOT_ALLOWED', 'front desk can''t change the shop settings');
select test.login('mia');
select test.throws($$select public.commerce_update_settings('{"gift_card_amounts":[1000,10000]}')$$, 'INVALID', 'amount buttons must sit between the smallest and largest card');
select test.throws($$select public.commerce_update_settings('{"gift_card_expiry_months":200}')$$, 'INVALID', 'expiry is capped at 120 months');
select test.eq((public.commerce_update_settings('{"gift_card_amounts":[10000,5000,5000,15000]}') ->> 'gift_card_amounts'), '[5000, 10000, 15000]', 'a manager saves the amounts (sorted, no repeats)');

-- ---------------------------------------------------------------- gift card: sell at the till, balance, partial redemption
select test.login('fran');
select test.throws($$select public.commerce_sell_gift_card('{"amount_cents":500,"method":"cash"}')$$, 'INVALID', 'a gift card below the minimum is refused');
select test.throws($$select public.commerce_sell_gift_card('{"amount_cents":5000,"method":"comp"}')$$, 'NOT_ALLOWED', 'front desk can''t comp a card');
select test.throws($$select public.commerce_sell_gift_card('{"amount_cents":5000,"method":"cash","recipient_email":"nope"}')$$, 'INVALID', 'a bad email is refused');
select (public.commerce_sell_gift_card('{"amount_cents":5000,"method":"cash"}') -> 'card' ->> 'id') as carda \gset
select test.admin();
insert into test.ids values ('cardA', :'carda');
select code as codeA from public.commerce_gift_cards where id = test.id('cardA') \gset
select test.ok(:'codea' ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$', 'codes are 12 characters, XXXX-XXXX-XXXX, with no I, L, O or U');
select test.eq((select total_cents from public.sales where id = (select sale_id from public.commerce_gift_cards where id = test.id('cardA'))), 5000, 'selling a card records a sale for its value');
select test.eq(app.commerce_balance(test.id('cardA')), 5000, 'the new card has its full balance');
select test.eq((select expires_at::date from public.commerce_gift_cards where id = test.id('cardA')), date '2029-10-19', 'it expires 36 months out');

select test.login('julia');
select test.eq((public.commerce_lookup_gift_card(lower(replace(:'codea', '-', ''))) ->> 'balance_cents')::int, 5000, 'an instructor at the till can check a balance (lower case, no dashes is fine)');
select test.throws($$select public.commerce_list_gift_cards()$$, 'NOT_ALLOWED', '...but instructors can''t list every card');
select test.throws($$select public.commerce_lookup_gift_card('ZZZZ-ZZZZ-ZZZZ')$$, 'NOT_FOUND', 'an unknown code is NOT_FOUND');

-- partial redemption at the till: a $30 single class takes $30 off the $50 card; $20 is left
select test.login('libby');
select public.commerce_hold_codes(jsonb_build_object('client_id', test.id('gus_client'), 'items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'), 'qty', 1)),
                                                    'gift_codes', jsonb_build_array(:'codea'))) ->> 'token' as tok1 \gset
select test.eq((public.commerce_lookup_gift_card(:'codea') ->> 'balance_cents')::int, 2000, 'a hold reserves the money straight away (balance $20 while the sale is open)');
select public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'card_reader', 3000, 'Gift card ••••-••••-' || right(:'codea', 4) || ' · ref ' || :'tok1');
select public.commerce_settle_hold(:'tok1');
select test.admin();
select test.eq((select count(*)::int from public.commerce_gift_entries where card_id = test.id('cardA') and kind = 'redeem' and state = 'posted' and sale_id is not null), 1, 'once the sale exists the hold becomes a posted redemption linked to it');
select test.eq(app.commerce_balance(test.id('cardA')), 2000, '...and the balance stays $20');

-- the rest of the card is taken for a $100 pack: partial again, $80 left to pay; then the till walks away and the hold is released
select test.login('libby');
select (public.commerce_hold_codes(jsonb_build_object('client_id', test.id('gus_client'), 'items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)),
                                                      'gift_codes', jsonb_build_array(:'codea'))) -> 'quote') as q2 \gset
select test.eq((:'q2'::jsonb -> 'gifts' -> 0 ->> 'applied_cents')::int, 2000, 'the card covers what it has: $20 of the $100 pack');
select test.eq((:'q2'::jsonb ->> 'total_cents')::int, 8000, '...and $80 is left to pay');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'), 'qty', 1)), 'gift_codes', jsonb_build_array(:'codea'))) -> 'gift_errors' -> 0 ->> 'message'),
               'That gift card has no balance left.', 'a second till can''t spend what the first has held');
select test.admin();
update public.commerce_gift_entries set at = at - interval '31 minutes' where card_id = test.id('cardA') and state = 'held';
select test.login('libby');
select test.eq((public.commerce_lookup_gift_card(:'codea') ->> 'balance_cents')::int, 2000, 'a hold nobody claims is dropped after 30 minutes and the money is back');

-- staff corrections and voiding
select test.login('fran');
select test.throws(format('select public.commerce_adjust_gift_card(%L, 500, ''Goodwill'')', test.id('cardA')), 'NOT_ALLOWED', 'front desk can''t adjust a card');
select test.login('mia');
select test.throws(format('select public.commerce_adjust_gift_card(%L, -2500, ''Oops'')', test.id('cardA')), 'INVALID', 'an adjustment can''t take a balance below zero');
select test.throws(format('select public.commerce_adjust_gift_card(%L, 500, '' '')', test.id('cardA')), 'INVALID', 'an adjustment needs a reason');
select test.eq((public.commerce_adjust_gift_card(test.id('cardA'), -500, 'Typo at the till') ->> 'balance_cents')::int, 1500, 'a manager takes $5 off with a reason');
select test.eq(jsonb_array_length(public.commerce_get_gift_card(test.id('cardA')) -> 'entries'), 3, 'the card''s ledger: issue, redeem, adjust');
select test.throws(format('select public.commerce_void_gift_card(%L, '''')', test.id('cardA')), 'INVALID', 'voiding needs a reason');
select test.eq(public.commerce_void_gift_card(test.id('cardA'), 'Lost by the buyer, replaced') ->> 'state', 'void', 'a manager voids the card');
select test.eq((select cents from public.commerce_gift_entries where card_id = test.id('cardA') and kind = 'void'), -1500, '...which writes off the balance');
select test.throws(format('select public.commerce_void_gift_card(%L, ''again'')', test.id('cardA')), 'INVALID', 'a voided card can''t be voided twice');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'gift_codes', jsonb_build_array(:'codea'))) -> 'gift_errors' -> 0 ->> 'message'),
               'That gift card has been voided.', 'a voided card can''t pay for anything');

-- expiry
select test.login('mia');
select (public.commerce_sell_gift_card('{"amount_cents":2500,"method":"comp"}') -> 'card' ->> 'id') as cardb \gset
select test.admin();
insert into test.ids values ('cardB', :'cardb');
select code as codeB from public.commerce_gift_cards where id = test.id('cardB') \gset
select test.ok((select sale_id is null from public.commerce_gift_cards where id = test.id('cardB')), 'a comp card is free: no sale');
select test.at('2029-10-20 08:00+11');
select test.login('mia');
select test.eq(public.commerce_lookup_gift_card(:'codeb') ->> 'state', 'expired', 'after 36 months the card has expired');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 1000, 'gift_codes', jsonb_build_array(:'codeb'))) -> 'gift_errors' -> 0 ->> 'message'), 'That gift card has expired.', '...and can''t be spent');
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- gift card: bought online (pending until paid)
select test.login('cara');
select test.throws($$select public.commerce_buy_gift_card('{"amount_cents":5000,"recipient_name":"Mel","recipient_email":"mel@example.test","send_on":"2026-10-01"}')$$, 'INVALID', 'a send date in the past is refused');
select test.throws($$select public.commerce_buy_gift_card('{"amount_cents":5000,"recipient_name":"","recipient_email":"mel@example.test"}')$$, 'INVALID', 'a card needs a recipient name');
select (public.commerce_buy_gift_card('{"amount_cents":10000,"recipient_name":"Mel","recipient_email":"mel@example.test","message":"Happy birthday","from_name":"Cara"}') -> 'card' ->> 'id') as cardc \gset
select (public.commerce_buy_gift_card('{"amount_cents":3000,"recipient_name":"Tom","recipient_email":"tom@example.test","send_on":"2026-10-20"}') -> 'card' ->> 'id') as cardd \gset
select test.admin();
insert into test.ids values ('cardC', :'cardc'), ('cardD', :'cardd');
select code as codeC from public.commerce_gift_cards where id = test.id('cardC') \gset
select test.eq((select status from public.commerce_gift_cards where id = test.id('cardC')), 'pending', 'an online card waits for payment');
select test.eq(test.count($$select 1 from public.commerce_outbox$$), 0, '...and nothing is emailed yet');
select test.login('cara');
select test.eq(jsonb_array_length(public.commerce_my_gift_cards()), 2, 'the buyer sees both cards');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 1000, 'gift_codes', jsonb_build_array(:'codec')), 'client') -> 'gift_errors' -> 0 ->> 'message'), 'That gift card isn’t active yet.', 'a pending card can''t be spent');
select test.throws(format('select public.commerce_activate_gift_card(%L, ''pi_1'', ''cs_1'')', test.id('cardC')), '42501', 'a signed-in user can''t switch a card on');
select test.service();
select test.eq((public.commerce_activate_gift_card(test.id('cardC'), 'pi_1', 'cs_1') -> 'card' ->> 'state'), 'active', 'the webhook switches the paid card on');
select test.eq((public.commerce_activate_gift_card(test.id('cardC'), 'pi_1', 'cs_1') ->> 'sale_id') = (select sale_id::text from public.commerce_gift_cards where id = test.id('cardC')), true, '...and repeating it changes nothing');
select public.commerce_activate_gift_card(test.id('cardD'), 'pi_2', 'cs_2');
select test.admin();
select test.eq((select total_cents from public.sales where stripe_checkout_session_id = 'cs_1'), 10000, 'the sale is the card''s price, paid online');
select test.eq(test.count($$select 1 from public.sales where stripe_checkout_session_id = 'cs_1'$$), 1, '...recorded once');
select test.eq(app.commerce_balance(test.id('cardC')), 10000, 'the paid card has its full balance');
select test.eq(test.count($$select 1 from public.commerce_outbox where card_id = (select id from public.commerce_gift_cards where recipient_email = 'mel@example.test')$$), 1, 'a card for today is emailed straight away');
select test.ok((select sent_at is null from public.commerce_gift_cards where id = test.id('cardD')), 'a card scheduled for tomorrow waits');
select test.at('2026-10-20 08:00+11');
select test.login('mia');
select public.commerce_list_gift_cards();
select test.admin();
select test.ok((select sent_at is not null from public.commerce_gift_cards where id = test.id('cardD')), 'the next day it goes out');
select test.eq(test.count($$select 1 from public.commerce_outbox where to_email = 'tom@example.test'$$), 1, '...with one email queued');
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- promo codes
select test.login('fran');
select test.throws($$select public.commerce_upsert_promo('{"code":"NOPE","kind":"percent","value":10}')$$, 'NOT_ALLOWED', 'front desk can''t create a promo code');
select test.login('mia');
select test.throws($$select public.commerce_upsert_promo('{"code":"X","kind":"percent","value":10}')$$, 'INVALID', 'a code needs 3 or more characters');
select test.throws($$select public.commerce_upsert_promo('{"code":"TOOMUCH","kind":"percent","value":150}')$$, 'INVALID', 'percent off is 1 to 100');
select test.throws($$select public.commerce_upsert_promo('{"code":"BACKWARDS","kind":"percent","value":10,"starts_on":"2026-11-02","ends_on":"2026-11-01"}')$$, 'INVALID', 'the end date can''t be before the start');
select (public.commerce_upsert_promo(jsonb_build_object('code', ' welcome10 ', 'description', 'New client welcome', 'kind', 'percent', 'value', 10,
          'product_ids', jsonb_build_array(test.id('p_pack4')), 'ends_on', '2026-12-31', 'max_uses_per_client', 1, 'new_clients_only', true, 'active', true)) ->> 'id') as pmw \gset
select (public.commerce_upsert_promo('{"code":"FIRST1","kind":"amount","value":500,"max_uses":1}') ->> 'id') as pmf \gset
select (public.commerce_upsert_promo('{"code":"REPEAT1","kind":"percent","value":20,"max_uses_per_client":1}') ->> 'id') as pmr \gset
select (public.commerce_upsert_promo('{"code":"BIGSAVE","kind":"amount","value":99999,"product_ids":[]}') ->> 'id') as pmb \gset
select (public.commerce_upsert_promo('{"code":"LATER","kind":"percent","value":10,"starts_on":"2026-11-05"}') ->> 'id') as pml \gset
select (public.commerce_upsert_promo('{"code":"OFFLINE","kind":"percent","value":10,"active":false}') ->> 'id') as pmo \gset
select test.throws($$select public.commerce_upsert_promo('{"code":"welcome10","kind":"percent","value":5}')$$, 'INVALID', 'two codes can''t share a name (any case)');
select test.admin();
insert into test.ids values ('pmW', :'pmw'), ('pmF', :'pmf'), ('pmR', :'pmr');
select test.eq((select code from public.commerce_promos where id = test.id('pmW')), 'WELCOME10', 'codes are stored upper case, trimmed');

select test.login('cara');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'welcome10'), 'client') ->> 'promo_cents')::int, 1000, 'WELCOME10 takes 10% off a new client''s 4 pack');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'welcome10'), 'client') ->> 'total_cents')::int, 9000, '...leaving $90');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'), 'qty', 1)), 'promo_code', 'WELCOME10'), 'client') ->> 'promo_error'),
               'That code doesn’t apply to anything in this cart.', 'a code limited to one product doesn''t apply to other products');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 10000, 'promo_code', 'WELCOME10'), 'client') ->> 'promo_error'),
               'That code only applies to certain products. Add them to the cart first.', 'a product-limited code needs the cart lines');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'promo_code', 'BIGSAVE'), 'client') ->> 'promo_cents')::int, 3000, 'a $ off code can''t take off more than the cart');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'promo_code', 'LATER'), 'client') ->> 'promo_error'), 'That code starts on 5 Nov.', 'a code that hasn''t started says when');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'promo_code', 'OFFLINE'), 'client') ->> 'promo_error'), 'That code isn’t valid.', 'a paused code is not valid');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'promo_code', 'NOSUCH'), 'client') ->> 'promo_error'), 'That code isn’t valid.', 'an unknown code is not valid');
select test.login('alice');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'WELCOME10'), 'client') ->> 'promo_error'),
               'That code is for new clients only. Thanks for being part of the club!', 'WELCOME10 is for new clients only: Alice has a pass already');
select test.login('libby');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'WELCOME10')) ->> 'promo_error'),
               'Add a client to use this code.', 'at the till a client-only code needs a client');
select test.eq((public.commerce_quote(jsonb_build_object('client_id', test.id('alice_client'), 'items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'WELCOME10')) ->> 'promo_error'),
               'That code is for new clients only.', '...and says so in staff words');
select test.at('2027-01-05 09:00+11');
select test.eq((public.commerce_quote(jsonb_build_object('client_id', test.id('erin_client'), 'items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'WELCOME10')) ->> 'promo_error'),
               'That code has expired.', 'after its end date WELCOME10 has expired');
select test.at('2026-10-19 08:00+11');

-- total and per-client limits are counted from what was actually redeemed
select public.commerce_hold_codes(jsonb_build_object('client_id', test.id('alice_client'), 'subtotal_cents', 3000, 'promo_code', 'FIRST1')) ->> 'token' as tokf \gset
select public.checkout_cart(test.id('alice_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'cash', 500, 'Promo FIRST1 · ref ' || :'tokf');
select public.commerce_settle_hold(:'tokf');
select test.eq((public.commerce_quote(jsonb_build_object('client_id', test.id('bob_client'), 'subtotal_cents', 3000, 'promo_code', 'FIRST1')) ->> 'promo_error'),
               'That code has been fully claimed.', 'a code with 1 use is fully claimed after one sale');
select public.commerce_hold_codes(jsonb_build_object('client_id', test.id('alice_client'), 'subtotal_cents', 3000, 'promo_code', 'REPEAT1')) ->> 'token' as tokr \gset
select public.checkout_cart(test.id('alice_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'cash', 600, 'Promo REPEAT1 · ref ' || :'tokr');
select public.commerce_settle_hold(:'tokr');
select test.eq((public.commerce_quote(jsonb_build_object('client_id', test.id('alice_client'), 'subtotal_cents', 3000, 'promo_code', 'REPEAT1')) ->> 'promo_error'),
               'This client has already used that code.', 'one use per client: Alice can''t use REPEAT1 twice');
select test.eq((public.commerce_quote(jsonb_build_object('client_id', test.id('bob_client'), 'subtotal_cents', 3000, 'promo_code', 'REPEAT1')) ->> 'promo_cents')::int, 600, '...but Bob still can');
-- a till that abandons its cart doesn't use up a code
select public.commerce_hold_codes(jsonb_build_object('client_id', test.id('bob_client'), 'subtotal_cents', 3000, 'promo_code', 'REPEAT1')) ->> 'token' as tokr2 \gset
select public.commerce_settle_hold(:'tokr2');
select test.eq((public.commerce_quote(jsonb_build_object('client_id', test.id('bob_client'), 'subtotal_cents', 3000, 'promo_code', 'REPEAT1')) ->> 'promo_cents')::int, 600, 'an abandoned cart gives the use back');
select test.eq((select uses from jsonb_to_recordset(public.commerce_list_promos()) as x(id uuid, uses int) where id = test.id('pmR')), 1, 'the promo list counts only real redemptions');
select test.eq(jsonb_array_length(public.commerce_promo_redemptions(test.id('pmF'))), 1, 'redemptions: FIRST1 was used once');

-- the till can't lie about prices: the quote prices from the products, not the caller
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 2)))) ->> 'subtotal_cents')::int, 20000, 'a quote prices the cart from the product list');

-- ---------------------------------------------------------------- client checks out with codes (server side)
select test.login('cara');
select test.throws(format('select public.commerce_purchase_with_codes(%L, ''WELCOME10'')', test.id('p_pack4')), 'PAYMENT_REQUIRED', 'codes that don''t cover the whole price need a payment first');
select test.throws(format('select public.commerce_purchase_with_codes(%L)', test.id('p_pack4')), 'INVALID', 'no codes, nothing to do');
select test.throws(format('select public.commerce_purchase_with_codes(%L, ''NOSUCH'')', test.id('p_pack4')), 'INVALID', 'a bad code is refused with its reason');
select (public.commerce_purchase_with_codes(test.id('p_pack4'), 'welcome10', array[:'codec']) -> 'sale' ->> 'id') as salecara \gset
select test.admin();
select test.eq((select total_cents from public.sales where id = :'salecara'), 0, 'WELCOME10 plus a gift card covers the pack: nothing to pay');
select test.eq((select sum(unit_cents * qty)::int from public.sale_items where sale_id = :'salecara' and kind = 'discount'), -10000, '...shown as a discount line of $100');
select test.eq((select count(*)::int from public.passes where client_id = test.id('cara_client') and sale_id = :'salecara'), 1, 'Cara gets her pass');
select test.eq(app.commerce_balance(test.id('cardC')), 1000, 'the gift card was charged $90 (10 000 - 9 000)');
select test.eq((select count(*)::int from public.commerce_redemptions where promo_id = test.id('pmW') and client_id = test.id('cara_client') and state = 'posted' and sale_id = :'salecara'), 1, 'the promo use is recorded against the sale');
select test.login('cara');
select test.throws(format('select public.commerce_purchase_with_codes(%L, ''WELCOME10'', array[%L])', test.id('p_pack4'), :'codec'), 'INVALID', 'Cara can''t use WELCOME10 again');

-- ---------------------------------------------------------------- referral rewards
select test.login('alice');
select (public.commerce_my_referral() ->> 'code') as alicecode \gset
select test.ok(:'alicecode' ~ '^ALICE-[0-9A-HJKMNP-TV-Z]{4}$', 'a referral code is FIRSTNAME-XXXX');
select test.eq(public.commerce_my_referral() ->> 'code', :'alicecode', 'it stays the same');
select test.throws(format('select public.commerce_claim_referral(%L)', :'alicecode'), 'INVALID', 'you can''t refer yourself');
select test.login('bob');
select test.throws(format('select public.commerce_claim_referral(%L)', :'alicecode'), 'INVALID', 'only new clients can join with a code: Bob has a pass');
select test.login('erin');
select test.throws($$select public.commerce_claim_referral('NOBODY-0000')$$, 'NOT_FOUND', 'an unknown code is refused');
select test.eq(public.commerce_claim_referral(lower(:'alicecode')) ->> 'referrer_name', 'Alice', 'Erin joins with Alice''s code (any case)');
select test.throws(format('select public.commerce_claim_referral(%L)', :'alicecode'), 'INVALID', 'only once');
select test.login('alice');
select test.eq(public.commerce_my_referral() -> 'referrals' -> 0 ->> 'status', 'pending', 'Alice sees Erin as pending');
select test.eq((public.commerce_my_referral() ->> 'earned_cents')::int, 0, '...and has earned nothing yet');
select test.eq(jsonb_array_length(public.commerce_my_gift_cards()), 0, '...and has no credit');
-- Erin buys her first pass at the till (with WELCOME10): Alice earns the reward
select test.login('libby');
select public.commerce_hold_codes(jsonb_build_object('client_id', test.id('erin_client'), 'items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)), 'promo_code', 'WELCOME10')) ->> 'token' as toke \gset
select public.checkout_cart(test.id('erin_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'card_reader', 1000, 'Promo WELCOME10 −$10.00 · ref ' || :'toke');
select public.commerce_settle_hold(:'toke');
select test.login('alice');
select test.eq(public.commerce_my_referral() -> 'referrals' -> 0 ->> 'status', 'rewarded', 'once Erin''s first pass is paid for the referral is rewarded');
select test.eq((public.commerce_my_referral() ->> 'earned_cents')::int, 1000, 'Alice earned the $10 reward');
select test.eq(public.commerce_my_gift_cards() -> 0 ->> 'kind', 'credit', '...as account credit');
select test.eq((public.commerce_my_gift_cards() -> 0 ->> 'balance_cents')::int, 1000, '...with $10 on it');
select public.commerce_my_referral();
select test.admin();
select test.eq(test.count($$select 1 from public.commerce_gift_cards where source = 'referral' and owner_client_id = (select id from public.clients where email = 'alice@example.test')$$), 1, 'the reward is paid once, however often anyone looks');
select test.login('alice');
select (public.commerce_my_gift_cards() -> 0 ->> 'code') as creditcode \gset
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'gift_codes', jsonb_build_array(:'creditcode')), 'client') ->> 'gift_cents')::int, 1000, 'Alice can spend her credit');
select test.login('bob');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 3000, 'gift_codes', jsonb_build_array(:'creditcode')), 'client') -> 'gift_errors' -> 0 ->> 'message'),
               'We couldn’t find a gift card with that code.', 'credit belongs to one client: Bob can''t see or spend it');
select test.throws(format('select public.commerce_lookup_gift_card(%L)', :'creditcode'), 'NOT_FOUND', '...or look it up');
select test.login('mia');
select test.eq((public.commerce_referral_stats() ->> 'rewarded')::int, 1, 'staff see one rewarded referral');
select test.eq((public.commerce_referral_stats() ->> 'reward_cents_paid')::int, 1000, '...and $10 paid out');
select test.eq(public.commerce_update_settings('{"referral_enabled":false}') ->> 'referral_enabled', 'false', 'a manager turns referrals off');
select test.login('cara');
select test.throws($$select public.commerce_claim_referral('ALICE-0000')$$, 'INVALID', 'no joining while referrals are off');
select test.login('mia');
select public.commerce_update_settings('{"referral_enabled":true}');

-- ---------------------------------------------------------------- retail stock and barcodes
select test.admin();
insert into public.products (kind, name, price_cents, stock, sort_order) values ('retail', 'Steel bottle', 3500, 4, 101) returning id as bottle \gset
insert into public.products (kind, name, price_cents, stock, active, sort_order) values ('retail', 'Old tote', 2800, 3, false, 102) returning id as tote \gset
insert into test.ids values ('bottle', :'bottle'), ('tote', :'tote');
select test.login('julia');
select test.throws($$select public.commerce_list_retail()$$, 'NOT_ALLOWED', 'instructors can''t see the stock list');
select test.login('fran');
select test.ok(jsonb_array_length(public.commerce_list_retail()) >= 3 and public.commerce_list_retail()::text like '%Steel bottle%', 'front desk sees the retail items');
select test.eq(public.commerce_update_retail(test.id('bottle'), '{"sku":"BOTTLE-INS","barcode":"9300600010023","low_stock_at":5}') ->> 'barcode', '9300600010023', 'a barcode and SKU are saved');
select public.commerce_update_retail(test.id('p_socks'), '{"sku":"GRIP-SOCK","barcode":"9300600010016"}');
select public.commerce_update_retail(test.id('tote'), '{"barcode":"9300600010030"}');
select test.throws(format('select public.commerce_update_retail(%L, ''{"barcode":"9300600010016"}'')', test.id('bottle')), 'INVALID', 'two products can''t share a barcode');
select test.throws(format('select public.commerce_update_retail(%L, ''{"sku":"grip-sock"}'')', test.id('bottle')), 'INVALID', '...or a SKU (any case)');
select test.throws(format('select public.commerce_update_retail(%L, ''{"low_stock_at":-1}'')', test.id('bottle')), 'INVALID', 'the low-stock level can''t be negative');
select test.throws(format('select public.commerce_update_retail(%L, ''{"sku":"X"}'')', test.id('p_pack4')), 'NOT_FOUND', 'only retail products have stock details');
select test.login('julia');
select test.eq(public.commerce_find_retail(E'9300600010023\r\n') ->> 'name', 'Steel bottle', 'an instructor''s scan finds the item by barcode (scanner control characters dropped)');
select test.eq(public.commerce_find_retail('bottle-ins') ->> 'product_id', test.id('bottle')::text, '...or by SKU, any case');
select test.eq(public.commerce_find_retail('0000000000000'), null, 'an unknown barcode finds nothing');
select test.eq(public.commerce_find_retail('9300600010030'), null, 'an inactive item isn''t sold');
select test.eq(public.commerce_find_retail(''), null, 'an empty scan finds nothing');
select test.login('fran');
select test.eq(public.commerce_find_retail('9300600010023') ->> 'status', 'low', 'the bottle is low: 4 left at a level of 5');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('p_socks'), 'delta', 5, 'reason', 'received')), 'INVALID', 'socks aren''t tracked yet: add/remove needs a first count');
select test.eq(public.commerce_adjust_stock(jsonb_build_object('product_id', test.id('p_socks'), 'set_to', 12, 'reason', 'count', 'note', 'First count')) ->> 'stock', '12', 'a stocktake sets the first count');
select test.at('2026-10-19 08:01+11');
select test.eq(public.commerce_adjust_stock(jsonb_build_object('product_id', test.id('p_socks'), 'delta', -9, 'reason', 'damaged')) ->> 'status', 'low', 'writing off 9 leaves 3: low (default level 5)');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('p_socks'), 'delta', -10, 'reason', 'lost')), 'INVALID', 'you can''t take off more than there is');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('p_socks'), 'set_to', 3, 'reason', 'count')), 'INVALID', 'a stocktake to the same number is refused');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('p_socks'), 'reason', 'count')), 'INVALID', 'a change needs a number');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('p_socks'), 'delta', 1, 'set_to', 4, 'reason', 'count')), 'INVALID', '...but not both');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('p_socks'), 'delta', 1, 'reason', 'because')), 'INVALID', 'the reason must be one of the list');
select test.at('2026-10-19 08:02+11');
select test.eq(public.commerce_adjust_stock(jsonb_build_object('product_id', test.id('p_socks'), 'delta', 20, 'reason', 'received', 'note', 'Order #7')) ->> 'status', 'ok', 'receiving 20 more makes it OK again');
select test.eq(jsonb_array_length(public.commerce_stock_log(test.id('p_socks'))), 3, 'the log has the stocktake, the write-off and the delivery');
select test.eq(public.commerce_stock_log(test.id('p_socks')) -> 0 ->> 'reason', 'received', '...newest first');
select test.eq((public.commerce_stock_log(test.id('p_socks')) -> 1 ->> 'delta')::int, -9, '...with signed changes');
-- selling retail counts the stock down (core checkout), and the report adds it up
select test.login('libby');
select public.checkout_cart(null, jsonb_build_array(jsonb_build_object('product_id', test.id('bottle'), 'qty', 3)), 'cash');
select test.eq(public.commerce_find_retail('9300600010023') ->> 'status', 'low', 'selling 3 of 4 leaves 1: still low');
select public.checkout_cart(null, jsonb_build_array(jsonb_build_object('product_id', test.id('bottle'))), 'cash');
select test.eq(public.commerce_find_retail('9300600010023') ->> 'status', 'out', '...and the last one makes it out of stock');
select test.throws(format('select public.checkout_cart(null, %L::jsonb, ''cash'')', jsonb_build_array(jsonb_build_object('product_id', test.id('bottle')))), 'OUT_OF_STOCK', 'the till refuses an out-of-stock sale');
select test.login('mia');
select test.eq((select (r ->> 'sold')::int from jsonb_array_elements(public.commerce_stock_report('2026-10-01', '2026-10-31') -> 'rows') r where r ->> 'product_id' = test.id('bottle')::text), 4, 'the stock report counts what was sold');
select test.eq((select (r ->> 'written_off')::int from jsonb_array_elements(public.commerce_stock_report('2026-10-01', '2026-10-31') -> 'rows') r where r ->> 'product_id' = test.id('p_socks')::text), 9, '...what was written off');
select test.eq((select (r ->> 'received')::int from jsonb_array_elements(public.commerce_stock_report('2026-10-01', '2026-10-31') -> 'rows') r where r ->> 'product_id' = test.id('p_socks')::text), 20, '...and what was received');
select test.eq((select (r ->> 'value_cents')::int from jsonb_array_elements(public.commerce_stock_report('2026-10-01', '2026-10-31') -> 'rows') r where r ->> 'product_id' = test.id('p_socks')::text), 23 * 2000, '...with the value on hand');

-- ---------------------------------------------------------------- nobody reads or writes the tables directly
select test.login('alice');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 0, 'a client can''t read gift card codes straight from the table');
select test.eq(test.count($$select 1 from public.commerce_promos$$), 0, '...or promo codes');
select test.eq(test.count($$select 1 from public.commerce_gift_entries$$), 0, '...or the ledger');
select test.eq(test.count($$select 1 from public.commerce_referrals$$), 0, '...or referrals');
select test.throws($$insert into public.commerce_promos (code, kind, value) values ('FREE', 'percent', 100)$$, '42501', 'a client can''t write a promo code');
select test.login('mia');
select test.throws($$insert into public.commerce_promos (code, kind, value) values ('FREE', 'percent', 100)$$, '42501', 'even a manager goes through the RPCs');
select test.throws(format('update public.commerce_gift_entries set cents = 99999 where card_id = %L', test.id('cardC')), '42501', '...so the ledger can''t be edited by hand');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$) > 0, true, 'staff with commerce.view read the cards');
select test.login('julia');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 0, 'instructors don''t read the card list');
select test.anon();
select test.throws($$select public.commerce_get_settings()$$, '42501', 'signed-out visitors can''t call any commerce function');
select test.throws($$select public.commerce_find_retail('123')$$, '42501', '...including barcode lookup');

select test.admin();
select test.studio(null);
rollback;
