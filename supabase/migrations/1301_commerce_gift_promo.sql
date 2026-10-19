-- Commerce RPCs, part 1: helpers, shop settings, gift cards, promo codes, pricing a cart with codes, till holds and
-- client purchases. Same rules and error codes as the demo store (src/features/commerce/demo.ts + logic.ts).
-- Rows go back as jsonb in snake_case; src/features/commerce/live.ts maps them.
-- Every function is security definer, so it filters by the current studio itself (app.current_studio_id()).

-- ---------------------------------------------------------------- internal helpers (not callable by users)

-- The caller's staff id if their role may do this action; otherwise NOT_ALLOWED.
create or replace function app.commerce_need(p_action text) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role text := public.staff_role();
begin
  if v_role is null then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  if not (v_role = any (case p_action
        when 'view' then array['owner','manager','front_desk']
        when 'sell' then array['owner','manager','front_desk','instructor']
        when 'manage' then array['owner','manager']
        when 'stock' then array['owner','manager','front_desk']
        else array[]::text[] end)) then
    perform app.fail('NOT_ALLOWED', 'You don’t have permission to do that.');
  end if;
  return public.current_staff_id();
end $$;

-- The signed-in client in this studio, or NOT_ALLOWED.
create or replace function app.commerce_client() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid := public.current_client_id();
begin
  if v is null then perform app.fail('NOT_ALLOWED', 'Sign in as a client to do that.'); end if;
  return v;
end $$;

create or replace function app.commerce_today() returns date
language sql stable security definer set search_path = public, pg_temp as $$ select (app.now() at time zone app.tz())::date $$;

-- '$20', '$20.50' (always with cents when p_cents). Other currencies get their code in front.
create or replace function app.commerce_money(p_cents bigint, p_with_cents boolean default false) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select (case when c in ('AUD','NZD','USD','CAD','SGD') then '$' else c || ' ' end)
         || case when p_cents % 100 = 0 and not p_with_cents then (p_cents / 100)::text else to_char(p_cents / 100.0, 'FM999999990.00') end
    from (select coalesce((select currency from public.studios where id = app.current_studio_id()), 'AUD') c) x
$$;

create or replace function app.commerce_settings_row() returns public.commerce_settings
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.commerce_settings;
begin
  select * into r from public.commerce_settings where studio_id = app.current_studio_id();
  if r.studio_id is null then
    r := row(app.current_studio_id(), '{5000,10000,15000}'::integer[], 2000, 50000, 36, true, 'credit', 1000, 5, now())::public.commerce_settings;
  end if;
  return r;
end $$;

create or replace function app.commerce_settings_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('gift_card_amounts', to_jsonb(s.gift_card_amounts), 'gift_card_min_cents', s.gift_card_min_cents,
    'gift_card_max_cents', s.gift_card_max_cents, 'gift_card_expiry_months', s.gift_card_expiry_months,
    'referral_enabled', s.referral_enabled, 'referral_reward_kind', s.referral_reward_kind,
    'referral_reward_cents', s.referral_reward_cents, 'low_stock_default', s.low_stock_default)
    from (select * from app.commerce_settings_row()) s
$$;

-- 12 random characters as XXXX-XXXX-XXXX (no I, L, O or U). Random bytes come from gen_random_uuid(), which is cryptographically strong.
create or replace function app.commerce_make_code() returns text
language plpgsql volatile as $$
declare alpha constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; b bytea := uuid_send(gen_random_uuid()); s text := ''; i int;
begin
  foreach i in array array[0,1,2,3,4,5,7,9,10,11,12,13] loop s := s || substr(alpha, (get_byte(b, i) % 32) + 1, 1); end loop;
  return substr(s, 1, 4) || '-' || substr(s, 5, 4) || '-' || substr(s, 9, 4);
end $$;

-- What someone typed -> the stored code ('' if it can't be one). Forgives case, spaces, dashes, O/0 and I/L/1 mix-ups.
create or replace function app.commerce_norm_gift(p text) returns text
language sql immutable as $$
  select case when length(s) = 12 and s !~ 'U' then substr(s, 1, 4) || '-' || substr(s, 5, 4) || '-' || substr(s, 9, 4) else '' end
    from (select translate(regexp_replace(upper(coalesce(p, '')), '[^0-9A-Z]', '', 'g'), 'OIL', '011') s) x
$$;
create or replace function app.commerce_mask(p_code text) returns text
language sql immutable as $$ select '••••-••••-' || right(p_code, 4) $$;

create or replace function app.commerce_balance(p_card uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(cents), 0)::int from public.commerce_gift_entries where card_id = p_card and studio_id = app.current_studio_id()
$$;

create or replace function app.commerce_card_state(c public.commerce_gift_cards, p_balance integer) returns text
language sql stable as $$
  select case when c.status = 'void' then 'void' when c.status = 'pending' then 'pending'
              when c.expires_at is not null and c.expires_at <= app.now() then 'expired'
              when p_balance <= 0 then 'used' else 'active' end
$$;

create or replace function app.commerce_card_json(c public.commerce_gift_cards) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', c.id, 'code', c.code, 'status', c.status, 'state', app.commerce_card_state(c, b.bal), 'kind', c.kind,
    'source', c.source, 'initial_cents', c.initial_cents, 'balance_cents', b.bal, 'recipient_name', c.recipient_name,
    'recipient_email', c.recipient_email, 'message', c.message, 'from_name', c.from_name, 'purchaser_client_id', c.purchaser_client_id,
    'purchaser_name', (select nullif(btrim(first_name || ' ' || last_name), '') from public.clients where id = c.purchaser_client_id),
    'owner_client_id', c.owner_client_id, 'send_on', c.send_on, 'sent_at', c.sent_at, 'created_at', c.created_at,
    'expires_at', c.expires_at, 'sale_id', c.sale_id)
    from (select app.commerce_balance(c.id) bal) b
$$;

create or replace function app.commerce_card_detail(c public.commerce_gift_cards) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select app.commerce_card_json(c) || jsonb_build_object('entries', coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'cents', e.cents, 'state', e.state, 'note', e.note,
             'sale_id', e.sale_id, 'staff_id', e.staff_id, 'staff_name', st.name, 'client_id', e.client_id) order by e.at desc, e.id)
      from public.commerce_gift_entries e left join public.staff st on st.id = e.staff_id
     where e.card_id = c.id and e.studio_id = c.studio_id), '[]'::jsonb))
$$;

-- Queue the gift card email (a sender drains commerce_outbox) and mark the card sent.
create or replace function app.commerce_send(p_card uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.commerce_gift_cards; sd public.studios;
begin
  select * into c from public.commerce_gift_cards where id = p_card and studio_id = app.current_studio_id();
  if c.id is null or c.recipient_email is null then return; end if;
  select * into sd from public.studios where id = c.studio_id;
  update public.commerce_gift_cards set sent_at = app.now() where id = c.id;
  insert into public.commerce_outbox (studio_id, kind, card_id, to_email, payload)
  values (c.studio_id, 'gift_card', c.id, c.recipient_email, jsonb_build_object(
    'studio_name', sd.name, 'studio_email', sd.email, 'currency', sd.currency, 'code', c.code, 'amount_cents', c.initial_cents,
    'recipient_name', c.recipient_name, 'from_name', c.from_name, 'message', c.message, 'expires_at', c.expires_at));
end $$;

-- Create a card with its first ledger entry. A pending card (bought online, not paid) has no entry until it's paid.
create or replace function app.commerce_issue(
  p_source text, p_kind text, p_cents integer, p_note text, p_status text default 'active',
  p_recipient_name text default null, p_recipient_email text default null, p_message text default null, p_from_name text default null,
  p_purchaser uuid default null, p_owner uuid default null, p_send_on date default null, p_sale uuid default null, p_staff uuid default null
) returns public.commerce_gift_cards
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id();
  st public.commerce_settings := app.commerce_settings_row();
  c public.commerce_gift_cards;
begin
  loop
    insert into public.commerce_gift_cards (studio_id, code, status, kind, source, initial_cents, recipient_name, recipient_email, message, from_name,
                                            purchaser_client_id, owner_client_id, send_on, expires_at, sale_id)
    values (sid, app.commerce_make_code(), p_status, p_kind, p_source, p_cents, nullif(btrim(p_recipient_name), ''), nullif(btrim(p_recipient_email), ''),
            nullif(btrim(p_message), ''), nullif(btrim(p_from_name), ''), p_purchaser, p_owner,
            case when nullif(btrim(p_recipient_email), '') is not null then coalesce(p_send_on, app.commerce_today()) end,
            case when st.gift_card_expiry_months > 0 then app.now() + make_interval(months => st.gift_card_expiry_months) end, p_sale)
    on conflict (studio_id, code) do nothing
    returning * into c;
    exit when c.id is not null;
  end loop;
  if p_status = 'active' then
    insert into public.commerce_gift_entries (studio_id, card_id, kind, cents, state, note, sale_id, staff_id)
    values (sid, c.id, 'issue', p_cents, 'posted', p_note, p_sale, p_staff);
    if c.recipient_email is not null and c.send_on <= app.commerce_today() then
      perform app.commerce_send(c.id);
      select * into c from public.commerce_gift_cards where id = c.id;
    end if;
  end if;
  return c;
end $$;

create or replace function app.commerce_validate_card(p_amount integer, p_email text, p_send_on date, p_message text, p_recipient_required boolean, p_recipient_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare st public.commerce_settings := app.commerce_settings_row(); t date := app.commerce_today();
begin
  if p_amount is null or p_amount < st.gift_card_min_cents or p_amount > st.gift_card_max_cents then
    perform app.fail('INVALID', 'Gift cards are ' || app.commerce_money(st.gift_card_min_cents) || ' to ' || app.commerce_money(st.gift_card_max_cents) || '.');
  end if;
  if p_recipient_required and nullif(btrim(coalesce(p_recipient_name, '')), '') is null then perform app.fail('INVALID', 'Who is the gift card for?'); end if;
  if nullif(btrim(coalesce(p_email, '')), '') is not null and btrim(p_email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    perform app.fail('INVALID', 'That email address doesn’t look right.');
  end if;
  if p_recipient_required and nullif(btrim(coalesce(p_email, '')), '') is null then perform app.fail('INVALID', 'Add the email address to send it to.'); end if;
  if p_send_on is not null and p_send_on < t then perform app.fail('INVALID', 'The send date can’t be in the past.'); end if;
  if p_send_on is not null and p_send_on > t + 365 then perform app.fail('INVALID', 'Choose a send date within the next year.'); end if;
  if length(coalesce(p_message, '')) > 400 then perform app.fail('INVALID', 'Keep the message under 400 characters.'); end if;
end $$;

create or replace function app.commerce_is_new(p_client uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_client is not null
     and not exists (select 1 from public.clients where id = p_client and intro_ineligible)
     and not exists (select 1 from public.passes where client_id = p_client and studio_id = app.current_studio_id())
$$;

-- Holds become real once their sale exists (the sale's note carries "ref <token>"), and are dropped if nothing claims
-- them in time or when the till says it's done with them (p_drop). Comp sales spend nothing.
create or replace function app.commerce_reconcile(p_drop text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid := app.current_studio_id();
begin
  update public.commerce_gift_entries e set state = 'posted', sale_id = s.id, hold_token = null
    from public.sales s
   where e.studio_id = sid and e.state = 'held' and s.studio_id = sid and s.method <> 'comp' and s.created_at >= e.at
     and position('ref ' || e.hold_token in coalesce(s.note, '')) > 0;
  update public.commerce_redemptions r set state = 'posted', sale_id = s.id, hold_token = null
    from public.sales s
   where r.studio_id = sid and r.state = 'held' and s.studio_id = sid and s.method <> 'comp' and s.created_at >= r.at
     and position('ref ' || r.hold_token in coalesce(s.note, '')) > 0;
  delete from public.commerce_gift_entries e
   where e.studio_id = sid and e.state = 'held'
     and (exists (select 1 from public.sales s where s.studio_id = sid and s.method = 'comp' and s.created_at >= e.at and position('ref ' || e.hold_token in coalesce(s.note, '')) > 0)
          or e.hold_token = p_drop or e.at < app.now() - interval '30 minutes');
  delete from public.commerce_redemptions r
   where r.studio_id = sid and r.state = 'held'
     and (exists (select 1 from public.sales s where s.studio_id = sid and s.method = 'comp' and s.created_at >= r.at and position('ref ' || r.hold_token in coalesce(s.note, '')) > 0)
          or r.hold_token = p_drop or r.at < app.now() - interval '30 minutes');
end $$;

-- A referred friend's first paid pass earns the referrer their reward.
create or replace function app.commerce_settle_referrals() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id();
  st public.commerce_settings := app.commerce_settings_row();
  r public.commerce_referrals; c public.commerce_gift_cards; v_friend text;
begin
  if not st.referral_enabled then return; end if;
  for r in select * from public.commerce_referrals x
            where x.studio_id = sid and x.status = 'pending'
              and exists (select 1 from public.passes p left join public.sales s on s.id = p.sale_id
                           where p.studio_id = sid and p.client_id = x.referred_client_id and p.purchased_at >= x.created_at
                             and p.price_cents > 0 and (s.id is null or s.method <> 'comp'))
            for update
  loop
    select btrim(first_name || ' ' || last_name) into v_friend from public.clients where id = r.referred_client_id;
    c := app.commerce_issue('referral', case when st.referral_reward_kind = 'credit' then 'credit' else 'gift_card' end, st.referral_reward_cents,
           'Referral reward: ' || coalesce(nullif(v_friend, ''), 'a friend') || ' bought a first pass', 'active',
           (select btrim(first_name || ' ' || last_name) from public.clients where id = r.referrer_client_id), null,
           'Thanks for introducing ' || coalesce(nullif(split_part(coalesce(v_friend, ''), ' ', 1), ''), 'a friend') || '.', null, null, r.referrer_client_id);
    update public.commerce_referrals set status = 'rewarded', rewarded_at = app.now(), reward_cents = st.referral_reward_cents, card_id = c.id where id = r.id;
  end loop;
end $$;

-- Housekeeping at the start of every call: holds, scheduled gift card emails, unpaid online cards, referral rewards.
create or replace function app.commerce_tick(p_drop text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid := app.current_studio_id(); c record;
begin
  perform app.commerce_reconcile(p_drop);
  delete from public.commerce_gift_cards where studio_id = sid and status = 'pending' and created_at < app.now() - interval '1 day';
  for c in select id from public.commerce_gift_cards
            where studio_id = sid and status = 'active' and recipient_email is not null and sent_at is null and coalesce(send_on, app.commerce_today()) <= app.commerce_today()
            for update skip locked
  loop perform app.commerce_send(c.id); end loop;
  perform app.commerce_settle_referrals();
end $$;

-- ---------------------------------------------------------------- shop settings

create or replace function public.commerce_get_settings() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_member_of(app.current_studio_id()) then perform app.fail('NOT_ALLOWED', 'Sign in to see that.'); end if;
  return app.commerce_settings_json();
end $$;

create or replace function public.commerce_update_settings(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cur public.commerce_settings := app.commerce_settings_row();
  v_amounts integer[]; v_min int; v_max int; v_exp int; v_en boolean; v_kind text; v_rew int; v_low int;
begin
  perform app.commerce_need('manage');
  perform app.assert_studio_open(app.current_studio_id());
  v_amounts := coalesce((select array_agg(distinct a order by a) from jsonb_array_elements_text(coalesce(p_patch -> 'gift_card_amounts', to_jsonb(cur.gift_card_amounts))) x, lateral (select round(x.value::numeric)::int a) y where a > 0), '{}');
  v_min := coalesce((p_patch ->> 'gift_card_min_cents')::int, cur.gift_card_min_cents);
  v_max := coalesce((p_patch ->> 'gift_card_max_cents')::int, cur.gift_card_max_cents);
  v_exp := coalesce((p_patch ->> 'gift_card_expiry_months')::int, cur.gift_card_expiry_months);
  v_en := coalesce((p_patch ->> 'referral_enabled')::boolean, cur.referral_enabled);
  v_kind := coalesce(p_patch ->> 'referral_reward_kind', cur.referral_reward_kind);
  v_rew := coalesce((p_patch ->> 'referral_reward_cents')::int, cur.referral_reward_cents);
  v_low := coalesce(round((p_patch ->> 'low_stock_default')::numeric)::int, cur.low_stock_default);
  if cardinality(v_amounts) = 0 or cardinality(v_amounts) > 6 then perform app.fail('INVALID', 'Add between one and six gift card amounts.'); end if;
  if not (v_min > 0) or v_max < v_min then perform app.fail('INVALID', 'The smallest gift card must be less than the largest.'); end if;
  if exists (select 1 from unnest(v_amounts) a where a < v_min or a > v_max) then perform app.fail('INVALID', 'The amount buttons must sit between the smallest and largest gift card.'); end if;
  if not (v_exp between 0 and 120) then perform app.fail('INVALID', 'Expiry is between 0 (never) and 120 months.'); end if;
  if not (v_rew >= 0) then perform app.fail('INVALID', 'The referral reward can’t be negative.'); end if;
  if v_en and v_rew <= 0 then perform app.fail('INVALID', 'Set a referral reward above $0, or turn referrals off.'); end if;
  if v_kind not in ('credit','gift_card') then perform app.fail('INVALID', 'Choose how referral rewards are paid.'); end if;
  if not (v_low >= 0) then perform app.fail('INVALID', 'The low-stock level can’t be negative.'); end if;
  insert into public.commerce_settings (studio_id, gift_card_amounts, gift_card_min_cents, gift_card_max_cents, gift_card_expiry_months,
                                        referral_enabled, referral_reward_kind, referral_reward_cents, low_stock_default, updated_at)
  values (app.current_studio_id(), v_amounts, v_min, v_max, v_exp, v_en, v_kind, v_rew, v_low, now())
  on conflict (studio_id) do update set gift_card_amounts = excluded.gift_card_amounts, gift_card_min_cents = excluded.gift_card_min_cents,
    gift_card_max_cents = excluded.gift_card_max_cents, gift_card_expiry_months = excluded.gift_card_expiry_months,
    referral_enabled = excluded.referral_enabled, referral_reward_kind = excluded.referral_reward_kind,
    referral_reward_cents = excluded.referral_reward_cents, low_stock_default = excluded.low_stock_default, updated_at = now();
  return app.commerce_settings_json();
end $$;

-- ---------------------------------------------------------------- gift cards

create or replace function public.commerce_list_gift_cards() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.commerce_need('view');
  perform app.commerce_tick();
  return coalesce((select jsonb_agg(app.commerce_card_json(c) order by c.created_at desc, c.id)
                     from public.commerce_gift_cards c where c.studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

create or replace function public.commerce_get_gift_card(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.commerce_gift_cards;
begin
  perform app.commerce_need('view');
  perform app.assert_in_studio('commerce_gift_cards', p_id, 'We couldn’t find that gift card.');
  perform app.commerce_tick();
  select * into c from public.commerce_gift_cards where id = p_id and studio_id = app.current_studio_id();
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that gift card.'); end if;
  return app.commerce_card_detail(c);
end $$;

-- Balance check by code: staff at the till, or a signed-in client. Credit is only visible to its owner.
create or replace function public.commerce_lookup_gift_card(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_code text := app.commerce_norm_gift(p_code); c public.commerce_gift_cards; v_me uuid; b int;
begin
  if public.is_staff() then perform app.commerce_need('sell');
  else v_me := app.commerce_client(); end if;
  perform app.commerce_tick();
  select * into c from public.commerce_gift_cards where studio_id = app.current_studio_id() and code = v_code and v_code <> '';
  if c.id is null or (c.kind = 'credit' and c.owner_client_id is distinct from v_me) then
    perform app.fail('NOT_FOUND', 'We couldn’t find a gift card with that code.');
  end if;
  b := app.commerce_balance(c.id);
  return jsonb_build_object('code', c.code, 'state', app.commerce_card_state(c, b), 'balance_cents', b, 'kind', c.kind, 'expires_at', c.expires_at);
end $$;

-- A client's cards: bought, owned as credit, or received on their email (once sent).
create or replace function public.commerce_my_gift_cards() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid := app.commerce_client(); v_email text;
begin
  perform app.commerce_tick();
  select lower(email) into v_email from public.clients where id = v_me;
  return coalesce((select jsonb_agg(app.commerce_card_json(c) order by c.created_at desc, c.id)
    from public.commerce_gift_cards c
   where c.studio_id = app.current_studio_id()
     and (c.purchaser_client_id = v_me or c.owner_client_id = v_me
          or (coalesce(v_email, '') <> '' and lower(c.recipient_email) = v_email and c.status = 'active' and c.sent_at is not null))), '[]'::jsonb);
end $$;

-- Client: buy a gift card online. Makes a pending card; it turns active when payment lands (commerce_activate_gift_card).
create or replace function public.commerce_buy_gift_card(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := app.commerce_client(); c public.commerce_gift_cards;
  v_send date := coalesce(nullif(p_input ->> 'send_on', '')::date, app.commerce_today());
  v_from text;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.commerce_tick();
  perform app.commerce_validate_card((p_input ->> 'amount_cents')::int, p_input ->> 'recipient_email', v_send, p_input ->> 'message', true, p_input ->> 'recipient_name');
  v_from := coalesce(nullif(btrim(p_input ->> 'from_name'), ''), (select first_name from public.clients where id = v_me));
  c := app.commerce_issue('purchase', 'gift_card', (p_input ->> 'amount_cents')::int, 'Bought in the app', 'pending',
         p_input ->> 'recipient_name', p_input ->> 'recipient_email', p_input ->> 'message', v_from, v_me, null, v_send);
  return jsonb_build_object('card', app.commerce_card_json(c));
end $$;

-- Service role (the Stripe webhook): the payment landed, so record the sale and switch the card on. Safe to repeat.
create or replace function public.commerce_activate_gift_card(p_card_id uuid, p_payment_intent text default null, p_checkout_session text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.commerce_gift_cards; v_sale uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment webhook can do that.'); end if;
  select * into c from public.commerce_gift_cards where id = p_card_id for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that gift card.'); end if;
  perform app.use_studio(c.studio_id);
  if c.status = 'active' then return jsonb_build_object('card', app.commerce_card_json(c), 'sale_id', c.sale_id); end if;
  if c.status <> 'pending' then perform app.fail('INVALID', 'That gift card isn’t waiting for payment.'); end if;
  if p_checkout_session is not null then select id into v_sale from public.sales where studio_id = c.studio_id and stripe_checkout_session_id = p_checkout_session; end if;
  if v_sale is null then
    insert into public.sales (studio_id, client_id, total_cents, method, note, stripe_payment_intent_id, stripe_checkout_session_id)
    values (c.studio_id, c.purchaser_client_id, c.initial_cents, 'card_online', 'Gift card ' || app.commerce_mask(c.code), p_payment_intent, p_checkout_session)
    returning id into v_sale;
    insert into public.sale_items (studio_id, sale_id, name, qty, unit_cents) values (c.studio_id, v_sale, 'Gift card', 1, c.initial_cents);
    if c.purchaser_client_id is not null then perform app.queue_receipt(v_sale); end if;
  end if;
  update public.commerce_gift_cards
     set status = 'active', sale_id = v_sale,
         expires_at = case when (app.commerce_settings_row()).gift_card_expiry_months > 0 then app.now() + make_interval(months => (app.commerce_settings_row()).gift_card_expiry_months) end
   where id = c.id returning * into c;
  insert into public.commerce_gift_entries (studio_id, card_id, kind, cents, note, sale_id)
  values (c.studio_id, c.id, 'issue', c.initial_cents, 'Bought in the app', v_sale);
  if c.recipient_email is not null and coalesce(c.send_on, app.commerce_today()) <= app.commerce_today() then
    perform app.commerce_send(c.id);
    select * into c from public.commerce_gift_cards where id = c.id;
  end if;
  return jsonb_build_object('card', app.commerce_card_json(c), 'sale_id', v_sale);
end $$;

-- Till: sell a card (or comp one: owner and manager only).
create or replace function public.commerce_sell_gift_card(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_staff uuid := app.commerce_need('sell');
  v_amount int := (p_input ->> 'amount_cents')::int; v_method text := p_input ->> 'method';
  v_client uuid := nullif(p_input ->> 'client_id', '')::uuid; v_send date := nullif(p_input ->> 'send_on', '')::date;
  v_sale uuid; c public.commerce_gift_cards;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('clients', v_client, 'We couldn’t find that client.');
  perform app.commerce_tick();
  if v_method is null or v_method not in ('card_reader','cash','card_online','comp') then perform app.fail('INVALID', 'Unknown payment method.'); end if;
  if v_method = 'comp' then perform app.commerce_need('manage'); end if;
  perform app.commerce_validate_card(v_amount, p_input ->> 'recipient_email', v_send, p_input ->> 'message', false, null);
  if v_client is not null and not exists (select 1 from public.clients where id = v_client and studio_id = app.current_studio_id()) then
    perform app.fail('NOT_FOUND', 'We couldn’t find that client.');
  end if;
  if v_method <> 'comp' then
    insert into public.sales (studio_id, client_id, total_cents, method, staff_id, note)
    values (app.current_studio_id(), v_client, v_amount, v_method, v_staff, 'Gift card') returning id into v_sale;
    insert into public.sale_items (studio_id, sale_id, name, qty, unit_cents) values (app.current_studio_id(), v_sale, 'Gift card', 1, v_amount);
  end if;
  c := app.commerce_issue(case when v_method = 'comp' then 'studio' else 'pos' end, 'gift_card', v_amount,
         case when v_method = 'comp' then 'Complimentary card from the studio' else 'Sold at the front desk (' || case when v_method = 'cash' then 'cash' else 'card' end || ')' end,
         'active', p_input ->> 'recipient_name', p_input ->> 'recipient_email', p_input ->> 'message', p_input ->> 'from_name', v_client, null, v_send, v_sale, v_staff);
  if v_sale is not null then
    update public.sales set note = 'Gift card ' || app.commerce_mask(c.code) where id = v_sale;
    if v_client is not null then perform app.queue_receipt(v_sale); end if;
  end if;
  return jsonb_build_object('card', app.commerce_card_json(c), 'sale', case when v_sale is not null then app.sale_json(v_sale) end);
end $$;

create or replace function public.commerce_void_gift_card(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_staff uuid := app.commerce_need('manage'); c public.commerce_gift_cards; bal int;
begin
  perform app.assert_in_studio('commerce_gift_cards', p_id, 'We couldn’t find that gift card.');
  perform app.assert_studio_open(app.current_studio_id());
  perform app.commerce_tick();
  select * into c from public.commerce_gift_cards where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that gift card.'); end if;
  if c.status = 'void' then perform app.fail('INVALID', 'That gift card is already voided.'); end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then perform app.fail('INVALID', 'Add a reason so there’s a record of why.'); end if;
  bal := app.commerce_balance(c.id);
  update public.commerce_gift_cards set status = 'void' where id = c.id returning * into c;
  insert into public.commerce_gift_entries (studio_id, card_id, kind, cents, note, staff_id)
  values (c.studio_id, c.id, 'void', -greatest(0, bal), 'Voided: ' || btrim(p_reason), v_staff);
  return app.commerce_card_detail(c);
end $$;

create or replace function public.commerce_adjust_gift_card(p_id uuid, p_delta_cents integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_staff uuid := app.commerce_need('manage'); c public.commerce_gift_cards; bal int;
begin
  perform app.assert_in_studio('commerce_gift_cards', p_id, 'We couldn’t find that gift card.');
  perform app.assert_studio_open(app.current_studio_id());
  perform app.commerce_tick();
  select * into c from public.commerce_gift_cards where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that gift card.'); end if;
  if c.status <> 'active' then perform app.fail('INVALID', 'Only active gift cards can be adjusted.'); end if;
  if p_delta_cents is null or p_delta_cents = 0 then perform app.fail('INVALID', 'Enter an amount to add or take off.'); end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then perform app.fail('INVALID', 'Add a reason so there’s a record of why.'); end if;
  bal := app.commerce_balance(c.id);
  if bal + p_delta_cents < 0 then
    perform app.fail('INVALID', 'That would take the balance below $0. There’s ' || app.commerce_money(bal, true) || ' on it.');
  end if;
  insert into public.commerce_gift_entries (studio_id, card_id, kind, cents, note, staff_id)
  values (c.studio_id, c.id, 'adjust', p_delta_cents, btrim(p_reason), v_staff);
  return app.commerce_card_detail(c);
end $$;

create or replace function public.commerce_resend_gift_card(p_id uuid, p_email text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.commerce_gift_cards; v_to text;
begin
  perform app.commerce_need('sell');
  perform app.assert_in_studio('commerce_gift_cards', p_id, 'We couldn’t find that gift card.');
  perform app.assert_studio_open(app.current_studio_id());
  perform app.commerce_tick();
  select * into c from public.commerce_gift_cards where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that gift card.'); end if;
  if c.status <> 'active' then perform app.fail('INVALID', 'Only active gift cards can be sent.'); end if;
  v_to := btrim(coalesce(nullif(btrim(p_email), ''), c.recipient_email, ''));
  if v_to !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then perform app.fail('INVALID', 'Add an email address to send it to.'); end if;
  update public.commerce_gift_cards set recipient_email = v_to, send_on = coalesce(send_on, app.commerce_today()) where id = c.id;
  perform app.commerce_send(c.id);
  select * into c from public.commerce_gift_cards where id = c.id;
  return app.commerce_card_json(c);
end $$;

-- ---------------------------------------------------------------- promo codes

create or replace function app.commerce_promo_status(p public.commerce_promos, p_today date, p_claimed integer) returns text
language sql immutable as $$
  select case when not p.active then 'paused' when p.ends_on is not null and p_today > p.ends_on then 'expired'
              when p.starts_on is not null and p_today < p.starts_on then 'scheduled'
              when p.max_uses is not null and p_claimed >= p.max_uses then 'used_up' else 'live' end
$$;

create or replace function public.commerce_list_promos() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.commerce_need('view');
  perform app.commerce_tick();
  return coalesce((
    select jsonb_agg(to_jsonb(p) || jsonb_build_object('status', app.commerce_promo_status(p, app.commerce_today(), u.claimed), 'uses', u.uses,
             'discount_cents', u.disc, 'last_used_at', u.last_at)
           order by (app.commerce_promo_status(p, app.commerce_today(), u.claimed) = 'live') desc, p.created_at desc, p.id)
      from public.commerce_promos p
      cross join lateral (select count(*)::int claimed, (count(*) filter (where r.state = 'posted'))::int uses,
                                 coalesce(sum(r.discount_cents) filter (where r.state = 'posted'), 0)::int disc,
                                 max(r.at) filter (where r.state = 'posted') last_at
                            from public.commerce_redemptions r where r.promo_id = p.id and r.studio_id = p.studio_id) u
     where p.studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

create or replace function public.commerce_upsert_promo(p_promo jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id();
  v_id uuid := nullif(p_promo ->> 'id', '')::uuid;
  v_code text := upper(regexp_replace(coalesce(p_promo ->> 'code', ''), '[^0-9A-Za-z_-]', '', 'g'));
  v_kind text := p_promo ->> 'kind'; v_value int := (p_promo ->> 'value')::int;
  v_starts date := nullif(p_promo ->> 'starts_on', '')::date; v_ends date := nullif(p_promo ->> 'ends_on', '')::date;
  v_max int := (p_promo ->> 'max_uses')::int; v_per int := (p_promo ->> 'max_uses_per_client')::int;
  v_products uuid[] := coalesce((select array_agg(distinct x::uuid) from jsonb_array_elements_text(coalesce(p_promo -> 'product_ids', '[]'::jsonb)) x), '{}');
  p public.commerce_promos;
begin
  perform app.commerce_need('manage');
  perform app.assert_studio_open(sid);
  perform app.assert_in_studio('commerce_promos', v_id, 'We couldn’t find that promo code.');
  if length(v_code) < 3 or length(v_code) > 20 then perform app.fail('INVALID', 'Codes are 3 to 20 letters or numbers, like WELCOME10.'); end if;
  if exists (select 1 from public.commerce_promos where studio_id = sid and code = v_code and id is distinct from v_id) then
    perform app.fail('INVALID', 'There’s already a code with that name.');
  end if;
  if v_kind not in ('percent','amount') or v_value is null or v_value < 1 or (v_kind = 'percent' and v_value > 100) then
    perform app.fail('INVALID', case when v_kind = 'percent' then 'Percent off is between 1 and 100.' else 'Enter a dollar amount above $0.' end);
  end if;
  if v_starts is not null and v_ends is not null and v_ends < v_starts then perform app.fail('INVALID', 'The end date is before the start date.'); end if;
  if (v_max is not null and v_max < 1) or (v_per is not null and v_per < 1) then perform app.fail('INVALID', 'Limits need to be a whole number of 1 or more.'); end if;
  if (select count(*) from public.products where studio_id = sid and id = any (v_products)) <> cardinality(v_products) then
    perform app.fail('NOT_FOUND', 'One of those products no longer exists.');
  end if;
  if v_id is not null then
    select * into p from public.commerce_promos where id = v_id and studio_id = sid for update;
    if p.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that promo code.'); end if;
    update public.commerce_promos set code = v_code, description = nullif(btrim(p_promo ->> 'description'), ''), kind = v_kind, value = v_value,
           product_ids = v_products, starts_on = v_starts, ends_on = v_ends, max_uses = v_max, max_uses_per_client = v_per,
           new_clients_only = coalesce((p_promo ->> 'new_clients_only')::boolean, false), active = coalesce((p_promo ->> 'active')::boolean, true)
     where id = v_id returning * into p;
    update public.commerce_redemptions set code = v_code where promo_id = v_id and studio_id = sid;
  else
    insert into public.commerce_promos (studio_id, code, description, kind, value, product_ids, starts_on, ends_on, max_uses, max_uses_per_client, new_clients_only, active)
    values (sid, v_code, nullif(btrim(p_promo ->> 'description'), ''), v_kind, v_value, v_products, v_starts, v_ends, v_max, v_per,
            coalesce((p_promo ->> 'new_clients_only')::boolean, false), coalesce((p_promo ->> 'active')::boolean, true))
    returning * into p;
  end if;
  return to_jsonb(p);
end $$;

create or replace function public.commerce_promo_redemptions(p_promo_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.commerce_need('view');
  perform app.assert_in_studio('commerce_promos', p_promo_id, 'We couldn’t find that promo code.');
  perform app.commerce_tick();
  return coalesce((select jsonb_agg(x order by x.at desc) from (
    select r.id, r.promo_id, r.code, r.client_id, nullif(btrim(c.first_name || ' ' || c.last_name), '') client_name, r.sale_id, r.discount_cents, r.at
      from public.commerce_redemptions r left join public.clients c on c.id = r.client_id
     where r.studio_id = app.current_studio_id() and r.state = 'posted' and (p_promo_id is null or r.promo_id = p_promo_id)
     order by r.at desc limit 200) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- pricing a cart with a promo code and gift cards
-- p_who: 'client' (p_client is the signed-in client) or 'staff' (p_client is optional). p_lock: lock the promo and cards
-- so two tills can't spend the same balance. Never raises for a bad code: the reason is in the result.
create or replace function app.commerce_quote(p_client uuid, p_items jsonb, p_subtotal integer, p_promo text, p_gifts text[], p_who text, p_lock boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); today date := app.commerce_today();
  v_has_lines boolean := false; v_lines jsonb := '[]'::jsonb; v_sub int := 0;
  it record; pr public.products;
  v_code text := upper(regexp_replace(coalesce(p_promo, ''), '[^0-9A-Za-z_-]', '', 'g'));
  pm public.commerce_promos; v_msg text; v_disc int := 0; v_elig int; v_tot int; v_cli int;
  v_promo jsonb; v_promo_err text;
  v_due int; v_raw text; v_norm text; c public.commerce_gift_cards; v_bal int; v_err text; v_take int;
  v_gifts jsonb := '[]'::jsonb; v_errs jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_gift_total int := 0;
begin
  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    v_has_lines := true;
    for it in select (x ->> 'product_id')::uuid pid, least(greatest(coalesce((x ->> 'qty')::int, 1), 1), 100) q from jsonb_array_elements(p_items) x loop
      select * into pr from public.products where id = it.pid and studio_id = sid;
      if pr.id is null or not pr.active then perform app.fail('NOT_FOUND', 'One of those products isn’t available.'); end if;
      v_lines := v_lines || jsonb_build_object('product_id', pr.id, 'cents', pr.price_cents * it.q);
      v_sub := v_sub + pr.price_cents * it.q;
    end loop;
  else
    v_sub := greatest(0, coalesce(p_subtotal, 0));
  end if;

  if v_code <> '' then
    if p_lock then select * into pm from public.commerce_promos where studio_id = sid and code = v_code for update;
    else select * into pm from public.commerce_promos where studio_id = sid and code = v_code; end if;
    if pm.id is not null then
      select count(*)::int, (count(*) filter (where client_id = p_client))::int into v_tot, v_cli from public.commerce_redemptions where promo_id = pm.id and studio_id = sid;
    end if;
    if pm.id is null or not pm.active then v_msg := 'That code isn’t valid.';
    elsif pm.ends_on is not null and today > pm.ends_on then v_msg := 'That code has expired.';
    elsif pm.starts_on is not null and today < pm.starts_on then v_msg := 'That code starts on ' || to_char(pm.starts_on, 'FMDD Mon') || '.';
    elsif pm.max_uses is not null and v_tot >= pm.max_uses then v_msg := 'That code has been fully claimed.';
    elsif (pm.new_clients_only or pm.max_uses_per_client is not null) and p_client is null then
      v_msg := case when p_who = 'staff' then 'Add a client to use this code.' else 'Sign in to use this code.' end;
    elsif pm.new_clients_only and not app.commerce_is_new(p_client) then
      v_msg := case when p_who = 'staff' then 'That code is for new clients only.' else 'That code is for new clients only. Thanks for being part of the club!' end;
    elsif pm.max_uses_per_client is not null and v_cli >= pm.max_uses_per_client then
      v_msg := case when p_who = 'staff' then 'This client has already used that code.' else 'You’ve already used that code.' end;
    else
      if cardinality(pm.product_ids) = 0 then
        v_elig := v_sub;
      elsif v_has_lines then
        select coalesce(sum((l ->> 'cents')::int), 0) into v_elig from jsonb_array_elements(v_lines) l where (l ->> 'product_id')::uuid = any (pm.product_ids);
        if v_elig <= 0 then v_msg := 'That code doesn’t apply to anything in this cart.'; end if;
      else
        v_msg := 'That code only applies to certain products. Add them to the cart first.';
      end if;
      if v_msg is null then
        if v_elig <= 0 then v_msg := 'There’s nothing to take this off yet.';
        else
          v_disc := case pm.kind when 'percent' then round(v_elig * least(100, greatest(0, pm.value)) / 100.0)::int else least(v_elig, greatest(0, pm.value)) end;
          if v_disc <= 0 then v_msg := 'There’s nothing to take this off yet.'; end if;
        end if;
      end if;
    end if;
    if v_msg is null then
      v_disc := least(v_sub, v_disc);
      v_promo := jsonb_build_object('id', pm.id, 'code', pm.code, 'kind', pm.kind, 'value', pm.value, 'discount_cents', v_disc);
    else
      v_promo_err := v_msg; v_disc := 0;
    end if;
  end if;

  v_due := v_sub - v_disc;
  foreach v_raw in array coalesce(p_gifts, '{}') loop
    v_norm := app.commerce_norm_gift(v_raw);
    v_err := null; v_bal := 0;
    if v_norm = '' then
      v_norm := upper(btrim(coalesce(v_raw, '')));
      v_err := 'That doesn’t look like a gift card code. They’re 12 letters and numbers.';
    else
      if p_lock then select * into c from public.commerce_gift_cards where studio_id = sid and code = v_norm for update;
      else select * into c from public.commerce_gift_cards where studio_id = sid and code = v_norm; end if;
      if c.id is null or (c.kind = 'credit' and c.owner_client_id is distinct from p_client) then
        v_err := 'We couldn’t find a gift card with that code.'; c := null;
      else
        v_bal := app.commerce_balance(c.id);
        case app.commerce_card_state(c, v_bal)
          when 'void' then v_err := 'That gift card has been voided.';
          when 'expired' then v_err := 'That gift card has expired.';
          when 'used' then v_err := 'That gift card has no balance left.';
          when 'pending' then v_err := 'That gift card isn’t active yet.';
          else null;
        end case;
      end if;
    end if;
    if v_norm = any (v_seen) then continue; end if;
    v_seen := v_seen || v_norm;
    if v_err is not null then v_errs := v_errs || jsonb_build_object('code', v_norm, 'message', v_err); continue; end if;
    if v_due <= 0 then v_errs := v_errs || jsonb_build_object('code', v_norm, 'message', 'Nothing left to pay, so this card wasn’t used.'); continue; end if;
    v_take := least(v_due, v_bal);
    v_due := v_due - v_take;
    v_gift_total := v_gift_total + v_take;
    v_gifts := v_gifts || jsonb_build_object('code', v_norm, 'applied_cents', v_take, 'balance_cents', v_bal, 'kind', c.kind);
  end loop;

  return jsonb_build_object('subtotal_cents', v_sub, 'promo', v_promo, 'promo_error', v_promo_err, 'gifts', v_gifts, 'gift_errors', v_errs,
    'promo_cents', v_disc, 'gift_cents', v_gift_total, 'total_cents', v_sub - v_disc - v_gift_total);
end $$;

-- Who is asking, and which client is the cart for?
create or replace function app.commerce_cart_client(p_who text, p_client uuid, out o_client uuid, out o_who text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_who = 'client' then o_client := app.commerce_client(); o_who := 'client';
  else
    perform app.commerce_need('sell');
    perform app.assert_in_studio('clients', p_client, 'We couldn’t find that client.');
    if p_client is not null and not exists (select 1 from public.clients where id = p_client and studio_id = app.current_studio_id()) then
      perform app.fail('NOT_FOUND', 'We couldn’t find that client.');
    end if;
    o_client := p_client; o_who := 'staff';
  end if;
end $$;

create or replace function public.commerce_quote(p_input jsonb, p_who text default 'staff') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare w record;
begin
  select * into w from app.commerce_cart_client(p_who, nullif(p_input ->> 'client_id', '')::uuid);
  perform app.commerce_tick();
  return app.commerce_quote(w.o_client, p_input -> 'items', (p_input ->> 'subtotal_cents')::int, p_input ->> 'promo_code',
           coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_input -> 'gift_codes', '[]'::jsonb)) x), '{}'), w.o_who);
end $$;

-- Take the redemptions for a priced cart. state 'held' (till) or 'posted' (sale already made).
create or replace function app.commerce_record(p_quote jsonb, p_client uuid, p_state text, p_token text, p_sale uuid, p_note text, p_staff uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g jsonb; v_card uuid;
begin
  if (p_quote #>> '{promo,id}') is not null and (p_quote ->> 'promo_cents')::int > 0 then
    insert into public.commerce_redemptions (studio_id, promo_id, code, client_id, sale_id, discount_cents, state, hold_token)
    values (app.current_studio_id(), (p_quote #>> '{promo,id}')::uuid, p_quote #>> '{promo,code}', p_client, p_sale, (p_quote ->> 'promo_cents')::int, p_state, p_token);
  end if;
  for g in select * from jsonb_array_elements(p_quote -> 'gifts') loop
    select id into v_card from public.commerce_gift_cards where studio_id = app.current_studio_id() and code = g ->> 'code';
    insert into public.commerce_gift_entries (studio_id, card_id, kind, cents, state, note, sale_id, staff_id, client_id, hold_token)
    values (app.current_studio_id(), v_card, 'redeem', -(g ->> 'applied_cents')::int, p_state, p_note, p_sale, p_staff, p_client, p_token);
  end loop;
end $$;

-- Till: reserve the codes for a cart. Call again with the same token when the cart changes.
create or replace function public.commerce_hold_codes(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w record; v_staff uuid; v_token text := nullif(p_input ->> 'token', ''); v_quote jsonb; b bytea := uuid_send(gen_random_uuid()); i int;
begin
  select * into w from app.commerce_cart_client('staff', nullif(p_input ->> 'client_id', '')::uuid);
  v_staff := public.current_staff_id();
  perform app.assert_studio_open(app.current_studio_id());
  if v_token is not null and v_token !~ '^h[a-z0-9]{6,12}$' then perform app.fail('INVALID', 'That till reference isn’t valid.'); end if;
  perform app.commerce_tick(v_token);
  if v_token is null then
    v_token := 'h';
    for i in 0..6 loop v_token := v_token || substr('abcdefghjkmnpqrstvwxyz23456789', (get_byte(b, i) % 30) + 1, 1); end loop;
  end if;
  v_quote := app.commerce_quote(w.o_client, p_input -> 'items', (p_input ->> 'subtotal_cents')::int, p_input ->> 'promo_code',
               coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_input -> 'gift_codes', '[]'::jsonb)) x), '{}'), 'staff', true);
  perform app.commerce_record(v_quote, w.o_client, 'held', v_token, null, 'Held at the till', v_staff);
  return jsonb_build_object('token', v_token, 'quote', v_quote);
end $$;

-- Till: the cart is done. If the sale went through the holds become real, otherwise they're released.
create or replace function public.commerce_settle_hold(p_token text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.commerce_need('sell');
  if p_token is null or p_token !~ '^h[a-z0-9]{6,12}$' then perform app.fail('INVALID', 'That till reference isn’t valid.'); end if;
  perform app.commerce_tick(p_token);
end $$;

-- Client: buy a product using a promo code and/or gift cards. Recorded on the server; the codes must cover the whole price
-- (paying the rest by card goes through Stripe Checkout, which isn't wired to codes yet: PAYMENT_REQUIRED).
create or replace function public.commerce_purchase_with_codes(p_product_id uuid, p_promo_code text default null, p_gift_codes text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); v_me uuid := app.commerce_client(); q jsonb; pr public.products; v_sale uuid;
  v_off int; v_note text; g jsonb; v_pass public.passes;
begin
  perform app.assert_studio_open(sid);
  perform app.assert_in_studio('products', p_product_id, 'We couldn’t find that product.');
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
