-- Commerce (B3): two studios in one database can't see or change each other's gift cards, promo codes, referrals,
-- stock or settings, whoever asks and however they ask (tables, RPCs, ids, codes).
-- Snowy (default studio): Libby owner, Fran front desk, Alice client. Harbour: Hank owner, Hana client.
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

-- ---------------------------------------------------------------- set up studio B (Harbour) with an owner, a client and a product
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));
select test.login('pete');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test', 'Australia/Sydney', 'AUD', 'en-AU', null, '12 Bay St', '{}'::jsonb) ->> 'id') as harbour_id \gset
select test.admin();
insert into test.ids values ('harbour', :'harbour_id');
select test.login('pete');
select public.platform_invite_owner(test.id('harbour'), 'Hank', 'hank@harbour.test');
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'hana@harbour.test', '{"first_name":"Hana","studio":"harbour"}', now());
insert into test.ids select 'hana', id from auth.users where email = 'hana@harbour.test';
insert into test.ids select 'hana_client', id from public.clients where email = 'hana@harbour.test';
insert into public.products (studio_id, kind, name, price_cents, credits, validity_days) values (test.id('harbour'), 'pack', 'Harbour 5 pack', 19500, 5, 90) returning id as h_pack \gset
insert into public.products (studio_id, kind, name, price_cents, stock) values (test.id('harbour'), 'retail', 'Harbour tote', 3000, 8) returning id as h_tote \gset
insert into test.ids values ('h_pack', :'h_pack'), ('h_tote', :'h_tote');
insert into test.ids select 'hank_staff', id from public.staff where email = 'hank@harbour.test';
insert into public.products (kind, name, price_cents, stock) values ('retail', 'Snowy bottle', 3500, 6) returning id as s_bottle \gset
insert into test.ids values ('s_bottle', :'s_bottle');

-- each studio makes a gift card, a promo code and a stock detail with the SAME names
select test.studio('snowy');
select test.login('libby');
select (public.commerce_sell_gift_card('{"amount_cents":10000,"method":"cash"}') -> 'card' ->> 'id') as s_card \gset
select (public.commerce_upsert_promo('{"code":"WELCOME10","kind":"percent","value":10}') ->> 'id') as s_promo \gset
select public.commerce_update_retail(test.id('s_bottle'), '{"sku":"TOTE","barcode":"1111111111111","low_stock_at":2}');
select public.commerce_update_settings('{"referral_reward_cents":2500}');
select test.login('alice');
select (public.commerce_my_referral() ->> 'code') as s_refcode \gset
select test.studio('harbour');
select test.login('hank');
select (public.commerce_sell_gift_card('{"amount_cents":10000,"method":"cash"}') -> 'card' ->> 'id') as h_card \gset
select (public.commerce_upsert_promo('{"code":"WELCOME10","kind":"percent","value":50}') ->> 'id') as h_promo \gset
select public.commerce_update_retail(test.id('h_tote'), '{"sku":"TOTE","barcode":"1111111111111","low_stock_at":1}');
select test.admin();
insert into test.ids values ('s_card', :'s_card'), ('s_promo', :'s_promo'), ('h_card', :'h_card'), ('h_promo', :'h_promo');
select code as s_code from public.commerce_gift_cards where id = test.id('s_card') \gset
select code as h_code from public.commerce_gift_cards where id = test.id('h_card') \gset

select test.eq((select studio_id from public.commerce_gift_cards where id = test.id('h_card')), test.id('harbour'), 'a card sold with the Harbour header belongs to Harbour');
select test.eq((select studio_id from public.commerce_gift_cards where id = test.id('s_card')), app.default_studio(), 'a card sold in Snowy belongs to Snowy');
select test.eq(test.count($$select 1 from public.commerce_promos where code = 'WELCOME10'$$), 2, 'both studios can have a WELCOME10 (codes are unique per studio)');
select test.eq(test.count($$select 1 from public.commerce_retail where sku = 'TOTE'$$), 2, '...and a SKU / barcode that the other studio also uses');
select test.eq((select referral_reward_cents from public.commerce_settings where studio_id = test.id('harbour')), null, 'Harbour never saved settings, and Snowy''s change didn''t create any for it');
select test.eq((select referral_reward_cents from public.commerce_settings where studio_id = app.default_studio()), 2500, 'Snowy''s settings are saved');

-- ---------------------------------------------------------------- staff: each studio's tables show only their own rows
select test.studio('snowy');
select test.login('libby');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 1, 'Libby (header: snowy) sees Snowy''s one card');
select test.eq(test.count($$select 1 from public.commerce_promos$$), 1, '...and Snowy''s one promo');
select test.eq(jsonb_array_length(public.commerce_list_gift_cards()), 1, 'the card list RPC agrees');
select test.eq(public.commerce_list_promos() -> 0 ->> 'value', '10', '...Snowy''s WELCOME10 is 10%');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 0, 'Libby asking as Harbour sees no cards (she isn''t on its staff)');
select test.eq(test.count($$select 1 from public.commerce_promos$$), 0, '...no promo codes');
select test.eq(test.count($$select 1 from public.commerce_retail$$), 0, '...no stock details');
select test.throws($$select public.commerce_list_gift_cards()$$, 'NOT_ALLOWED', '...and the RPCs refuse her');
select test.throws($$select public.commerce_list_promos()$$, 'NOT_ALLOWED', '...every one of them');
select test.throws($$select public.commerce_list_retail()$$, 'NOT_ALLOWED', 'stock too');
select test.throws($$select public.commerce_sell_gift_card('{"amount_cents":5000,"method":"cash"}')$$, 'NOT_ALLOWED', 'she can''t sell a Harbour card');
select test.throws($$select public.commerce_referral_stats()$$, 'NOT_ALLOWED', 'or read its referrals');
select test.studio('snowy');
select test.login('hank');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 0, 'Hank asking as Snowy sees nothing either');
select test.throws($$select public.commerce_list_gift_cards()$$, 'NOT_ALLOWED', '...and is refused');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 1, 'Hank (header: harbour) sees Harbour''s one card');
select test.eq(public.commerce_list_promos() -> 0 ->> 'value', '50', '...and Harbour''s WELCOME10 is 50%');
select test.eq((public.commerce_get_settings() ->> 'referral_reward_cents')::int, 1000, 'Harbour has its own settings (defaults), not Snowy''s $25');
select test.eq(public.commerce_list_retail() -> 0 ->> 'name', 'Harbour tote', 'Harbour''s stock list is Harbour''s');

-- ---------------------------------------------------------------- other studio's ids and codes are not found
select test.throws(format('select public.commerce_get_gift_card(%L)', test.id('s_card')), 'NOT_FOUND', 'Hank can''t open a Snowy card by id');
select test.throws(format('select public.commerce_void_gift_card(%L, ''x'')', test.id('s_card')), 'NOT_FOUND', '...void it');
select test.throws(format('select public.commerce_adjust_gift_card(%L, 100, ''x'')', test.id('s_card')), 'NOT_FOUND', '...adjust it');
select test.throws(format('select public.commerce_resend_gift_card(%L, ''a@b.test'')', test.id('s_card')), 'NOT_FOUND', '...resend it');
select test.throws(format('select public.commerce_upsert_promo(%L)', jsonb_build_object('id', test.id('s_promo'), 'code', 'HACKED', 'kind', 'percent', 'value', 100)), 'NOT_FOUND', '...rewrite a Snowy promo');
select test.throws(format('select public.commerce_promo_redemptions(%L)', test.id('s_promo')), 'NOT_FOUND', '...read its redemptions');
select test.throws(format('select public.commerce_upsert_promo(%L)', jsonb_build_object('code', 'SNEAKY', 'kind', 'percent', 'value', 10, 'product_ids', jsonb_build_array(test.id('p_pack4')))), 'NOT_FOUND', '...aim a Harbour promo at a Snowy product');
select test.throws(format('select public.commerce_update_retail(%L, ''{"sku":"X"}'')', test.id('s_bottle')), 'NOT_FOUND', '...edit a Snowy product''s SKU');
select test.throws(format('select public.commerce_adjust_stock(%L)', jsonb_build_object('product_id', test.id('s_bottle'), 'delta', -1, 'reason', 'lost')), 'NOT_FOUND', '...change its stock');
select test.throws(format('select public.commerce_stock_log(%L)', test.id('s_bottle')), 'NOT_FOUND', '...read its stock log');
select test.throws(format('select public.commerce_quote(%L)', jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'), 'qty', 1)))), 'NOT_FOUND', '...price a Snowy product');
select test.throws(format('select public.commerce_sell_gift_card(%L)', jsonb_build_object('amount_cents', 5000, 'method', 'cash', 'client_id', test.id('alice_client'))), 'NOT_FOUND', '...sell a card to a Snowy client');
select test.throws(format('select public.commerce_hold_codes(%L)', jsonb_build_object('client_id', test.id('alice_client'), 'subtotal_cents', 1000)), 'NOT_FOUND', '...hold codes for a Snowy client');
select test.throws(format('select public.commerce_lookup_gift_card(%L)', :'s_code'), 'NOT_FOUND', 'Snowy''s gift card code isn''t a Harbour card');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 5000, 'gift_codes', jsonb_build_array(:'s_code'))) -> 'gift_errors' -> 0 ->> 'message'),
               'We couldn’t find a gift card with that code.', '...and can''t pay for anything there');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 5000, 'gift_codes', jsonb_build_array(:'h_code'))) -> 'gifts' -> 0 ->> 'applied_cents')::int, 5000, 'while Harbour''s own card works in Harbour');
select test.eq((public.commerce_quote(jsonb_build_object('subtotal_cents', 10000, 'promo_code', 'WELCOME10')) ->> 'promo_cents')::int, 5000, 'a code that exists in both studios is read in the asking studio only (Harbour''s is 50%)');
select test.eq(public.commerce_find_retail('1111111111111') ->> 'name', 'Harbour tote', 'the same barcode finds Harbour''s item in Harbour...');
select test.studio('snowy');
select test.login('libby');
select test.eq(public.commerce_find_retail('1111111111111') ->> 'name', 'Snowy bottle', '...and Snowy''s item in Snowy');
select test.eq((public.commerce_update_settings('{"referral_reward_cents":3000}') ->> 'referral_reward_cents')::int, 3000, 'Libby changes Snowy''s reward');
select test.studio('harbour');
select test.login('hank');
select test.eq((public.commerce_get_settings() ->> 'referral_reward_cents')::int, 1000, '...Harbour''s is untouched');
select test.eq((public.commerce_update_settings('{"gift_card_expiry_months":12}') ->> 'gift_card_expiry_months')::int, 12, 'Hank sets Harbour''s expiry to 12 months');
select test.studio('snowy');
select test.login('libby');
select test.eq((public.commerce_get_settings() ->> 'gift_card_expiry_months')::int, 36, '...Snowy keeps 36');

-- ---------------------------------------------------------------- clients: their own studio only
select test.studio('harbour');
select test.login('hana');
select test.eq(test.count($$select 1 from public.commerce_gift_cards$$), 0, 'Hana can''t read gift card codes from the table');
select test.throws(format('select public.commerce_lookup_gift_card(%L)', :'s_code'), 'NOT_FOUND', 'she can''t check a Snowy card');
select test.eq(jsonb_array_length(public.commerce_my_gift_cards()), 0, 'she has no cards');
select test.throws(format('select public.commerce_claim_referral(%L)', :'s_refcode'), 'NOT_FOUND', 'Snowy referral codes mean nothing in Harbour');
select test.ok((public.commerce_my_referral() ->> 'code') ~ '^HANA-', 'she gets her own Harbour code');
select test.throws(format('select public.commerce_purchase_with_codes(%L, ''WELCOME10'')', test.id('p_pack4')), 'NOT_FOUND', 'she can''t buy a Snowy product');
select test.throws(format('select public.commerce_purchase_with_codes(%L, null, array[%L])', test.id('h_pack'), :'s_code'), 'INVALID', 'a Snowy gift card can''t pay for a Harbour pass');
select test.eq((public.commerce_quote(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', test.id('h_pack'), 'qty', 1)), 'promo_code', 'WELCOME10'), 'client') ->> 'promo_cents')::int, 9750,
               'Harbour''s WELCOME10 is Harbour''s 50%, not Snowy''s 10%');
select (public.commerce_buy_gift_card('{"amount_cents":7500,"recipient_name":"Ellie","recipient_email":"ellie@example.test"}') -> 'card' ->> 'id') as h_pending \gset
select test.studio('snowy');
select test.login('alice');
select test.eq(jsonb_array_length(public.commerce_my_gift_cards()), 0, 'Alice (a Snowy client) sees none of Hana''s cards');
select test.studio('harbour');
select test.throws($$select public.commerce_my_gift_cards()$$, 'NOT_ALLOWED', 'Alice asking as Harbour is refused: she isn''t a Harbour client');
select test.throws($$select public.commerce_my_referral()$$, 'NOT_ALLOWED', '...so is her referral screen');
select test.throws(format('select public.commerce_quote(%L, ''client'')', jsonb_build_object('subtotal_cents', 1000)), 'NOT_ALLOWED', '...and her quotes');

-- ---------------------------------------------------------------- the webhook lands a payment in the card's own studio
select test.admin();
insert into test.ids values ('h_pending', :'h_pending');
select test.service();
select test.studio('snowy');
select public.commerce_activate_gift_card(test.id('h_pending'), 'pi_h', 'cs_h');
select test.admin();
select test.eq((select studio_id from public.sales where stripe_checkout_session_id = 'cs_h'), test.id('harbour'), 'a Harbour card paid for through the webhook creates its sale in Harbour');
select test.eq((select studio_id from public.commerce_gift_entries where card_id = test.id('h_pending')), test.id('harbour'), '...and its ledger entry in Harbour');
select test.eq((select studio_id from public.commerce_outbox where card_id = test.id('h_pending')), test.id('harbour'), '...and its email in Harbour');

-- ---------------------------------------------------------------- the database itself refuses cross-studio links
select test.throws(format('insert into public.commerce_redemptions (studio_id, promo_id, code, discount_cents) values (%L, %L, ''X'', 100)', test.id('harbour'), test.id('s_promo')), '23503', 'a Harbour redemption can''t point at a Snowy promo');
select test.throws(format('insert into public.commerce_gift_entries (studio_id, card_id, kind, cents) values (%L, %L, ''adjust'', 100)', test.id('harbour'), test.id('s_card')), '23503', 'a Harbour ledger entry can''t point at a Snowy card');
select test.throws(format('insert into public.commerce_retail (studio_id, product_id, sku) values (%L, %L, ''Z'')', test.id('harbour'), test.id('s_bottle')), '23503', 'a Harbour stock detail can''t point at a Snowy product');
select test.throws(format('insert into public.commerce_referrals (studio_id, referrer_client_id, referred_client_id) values (%L, %L, %L)', test.id('harbour'), test.id('alice_client'), test.id('hana_client')), '23503', 'a Harbour referral can''t link a Snowy client');
select test.throws(format('update public.commerce_gift_cards set studio_id = %L where id = %L', test.id('harbour'), test.id('s_card')), 'NOT_ALLOWED', 'a card can''t be moved to another studio');

select test.admin();
select test.studio(null);
rollback;
