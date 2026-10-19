-- Commerce feature (ROADMAP B3): gift cards, promo codes, referral rewards and retail stock with barcodes.
-- Everything is per studio (app.scope_table). Reads go through RLS (staff only: a gift card code is a bearer secret, so
-- clients never read these tables, they use the RPCs in 1301/1302). Every change goes through those RPCs, which mirror
-- src/features/commerce/permissions.ts:
--   commerce.view    owner, manager, front_desk               gift cards, promo codes, referral stats
--   commerce.sell    owner, manager, front_desk, instructor    sell/redeem gift cards, use promo codes at the till, barcode lookup
--   commerce.manage  owner, manager                            void/adjust gift cards, promo codes, shop settings
--   commerce.stock   owner, manager, front_desk                see and adjust retail stock

-- ---------------------------------------------------------------- shop settings (one row per studio, made on first save)
create table public.commerce_settings (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete cascade,
  gift_card_amounts integer[] not null default '{5000,10000,15000}',
  gift_card_min_cents integer not null default 2000 check (gift_card_min_cents > 0),
  gift_card_max_cents integer not null default 50000,
  gift_card_expiry_months integer not null default 36 check (gift_card_expiry_months between 0 and 120),
  referral_enabled boolean not null default true,
  referral_reward_kind text not null default 'credit' check (referral_reward_kind in ('credit','gift_card')),
  referral_reward_cents integer not null default 1000 check (referral_reward_cents >= 0),
  low_stock_default integer not null default 5 check (low_stock_default >= 0),
  updated_at timestamptz not null default now(),
  check (gift_card_max_cents >= gift_card_min_cents)
);
select app.scope_table('commerce_settings');
create policy commerce_settings_read on public.commerce_settings for select to authenticated using (app.is_member_of(studio_id));
create trigger audit_commerce_settings after insert or update on public.commerce_settings for each row execute function app.audit_trigger();

-- ---------------------------------------------------------------- gift cards (and referral credit)
create table public.commerce_gift_cards (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  code text not null check (code ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  -- pending = bought online, not paid yet
  status text not null default 'active' check (status in ('pending','active','void')),
  -- credit = account credit owned by one client (referral rewards)
  kind text not null default 'gift_card' check (kind in ('gift_card','credit')),
  source text not null check (source in ('purchase','pos','referral','studio')),
  initial_cents integer not null check (initial_cents > 0),
  recipient_name text,
  recipient_email text,
  message text check (message is null or length(message) <= 400),
  from_name text,
  purchaser_client_id uuid,
  owner_client_id uuid,
  send_on date,
  sent_at timestamptz,
  created_at timestamptz not null default app.now(),
  expires_at timestamptz,
  sale_id uuid,
  foreign key (studio_id, purchaser_client_id) references public.clients (studio_id, id) on delete set null (purchaser_client_id),
  foreign key (studio_id, owner_client_id) references public.clients (studio_id, id) on delete set null (owner_client_id),
  foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete set null (sale_id),
  check (kind <> 'credit' or owner_client_id is not null)
);
select app.scope_table('commerce_gift_cards');
create unique index commerce_gift_cards_code_key on public.commerce_gift_cards (studio_id, code);
create index commerce_gift_cards_buyer_idx on public.commerce_gift_cards (studio_id, purchaser_client_id);
create index commerce_gift_cards_owner_idx on public.commerce_gift_cards (studio_id, owner_client_id);
create index commerce_gift_cards_due_idx on public.commerce_gift_cards (studio_id, send_on) where status = 'active' and sent_at is null and recipient_email is not null;
create policy commerce_gift_cards_read on public.commerce_gift_cards for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create trigger audit_commerce_gift_cards after insert or update or delete on public.commerce_gift_cards for each row execute function app.audit_trigger();

-- The balance ledger. A card's balance is the sum of its posted + held entries (redeem is negative).
-- held = reserved by a till that hasn't finished yet (hold_token matches "ref <token>" in the sale's note).
create table public.commerce_gift_entries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  card_id uuid not null,
  at timestamptz not null default app.now(),
  kind text not null check (kind in ('issue','redeem','adjust','void','refund')),
  cents integer not null,
  state text not null default 'posted' check (state in ('posted','held')),
  note text,
  sale_id uuid,
  staff_id uuid,
  client_id uuid,
  hold_token text check (hold_token is null or hold_token ~ '^h[a-z0-9]{6,12}$'),
  foreign key (studio_id, card_id) references public.commerce_gift_cards (studio_id, id) on delete cascade,
  foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete set null (sale_id),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete set null (staff_id),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete set null (client_id),
  check (state = 'posted' or hold_token is not null)
);
select app.scope_table('commerce_gift_entries');
create index commerce_gift_entries_card_idx on public.commerce_gift_entries (card_id, at);
create index commerce_gift_entries_held_idx on public.commerce_gift_entries (studio_id, hold_token) where state = 'held';
create policy commerce_gift_entries_read on public.commerce_gift_entries for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));

-- ---------------------------------------------------------------- promo codes
create table public.commerce_promos (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  code text not null check (code ~ '^[0-9A-Z_-]{3,20}$'),
  description text check (description is null or length(description) <= 120),
  kind text not null check (kind in ('percent','amount')),
  -- percent: 1-100. amount: cents.
  value integer not null check (value > 0),
  -- empty = every product
  product_ids uuid[] not null default '{}',
  starts_on date,
  ends_on date,
  max_uses integer check (max_uses is null or max_uses >= 1),
  max_uses_per_client integer check (max_uses_per_client is null or max_uses_per_client >= 1),
  new_clients_only boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default app.now(),
  check (kind <> 'percent' or value <= 100),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
select app.scope_table('commerce_promos');
create unique index commerce_promos_code_key on public.commerce_promos (studio_id, code);
create policy commerce_promos_read on public.commerce_promos for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create trigger audit_commerce_promos after insert or update or delete on public.commerce_promos for each row execute function app.audit_trigger();

create table public.commerce_redemptions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  promo_id uuid not null,
  code text not null,
  client_id uuid,
  sale_id uuid,
  discount_cents integer not null check (discount_cents > 0),
  at timestamptz not null default app.now(),
  state text not null default 'posted' check (state in ('posted','held')),
  hold_token text check (hold_token is null or hold_token ~ '^h[a-z0-9]{6,12}$'),
  foreign key (studio_id, promo_id) references public.commerce_promos (studio_id, id) on delete cascade,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete set null (client_id),
  foreign key (studio_id, sale_id) references public.sales (studio_id, id) on delete set null (sale_id),
  check (state = 'posted' or hold_token is not null)
);
select app.scope_table('commerce_redemptions');
create index commerce_redemptions_promo_idx on public.commerce_redemptions (promo_id, client_id);
create index commerce_redemptions_held_idx on public.commerce_redemptions (studio_id, hold_token) where state = 'held';
create policy commerce_redemptions_read on public.commerce_redemptions for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));

-- ---------------------------------------------------------------- referrals
create table public.commerce_ref_codes (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  code text not null check (code ~ '^[A-Z]{1,8}-[0-9A-HJKMNP-TV-Z]{4}$'),
  created_at timestamptz not null default app.now(),
  primary key (studio_id, client_id),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
select app.scope_table('commerce_ref_codes');
create unique index commerce_ref_codes_code_key on public.commerce_ref_codes (studio_id, code);

create table public.commerce_referrals (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  referrer_client_id uuid not null,
  referred_client_id uuid not null,
  status text not null default 'pending' check (status in ('pending','rewarded')),
  created_at timestamptz not null default app.now(),
  rewarded_at timestamptz,
  reward_cents integer,
  card_id uuid,
  foreign key (studio_id, referrer_client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, referred_client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, card_id) references public.commerce_gift_cards (studio_id, id) on delete set null (card_id),
  check (referrer_client_id <> referred_client_id)
);
select app.scope_table('commerce_referrals');
-- A client can only join with one friend's code, once.
create unique index commerce_referrals_once on public.commerce_referrals (studio_id, referred_client_id);
create index commerce_referrals_referrer_idx on public.commerce_referrals (studio_id, referrer_client_id);
create policy commerce_referrals_read on public.commerce_referrals for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));

-- ---------------------------------------------------------------- retail: SKU + barcode + own low-stock level, and the stock log
-- (the stock count itself is products.stock, which checkout_cart already counts down)
create table public.commerce_retail (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  product_id uuid not null,
  sku text check (sku is null or length(sku) between 1 and 40),
  barcode text check (barcode is null or length(barcode) between 1 and 40),
  low_stock_at integer check (low_stock_at is null or low_stock_at >= 0),
  primary key (studio_id, product_id),
  foreign key (studio_id, product_id) references public.products (studio_id, id) on delete cascade
);
select app.scope_table('commerce_retail');
create unique index commerce_retail_sku_key on public.commerce_retail (studio_id, lower(sku)) where sku is not null;
create unique index commerce_retail_barcode_key on public.commerce_retail (studio_id, lower(barcode)) where barcode is not null;
create policy commerce_retail_read on public.commerce_retail for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));

create table public.commerce_stock_log (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  product_id uuid not null,
  product_name text not null,
  delta integer not null,
  before_count integer not null,
  after_count integer not null check (after_count >= 0),
  reason text not null check (reason in ('received','count','damaged','lost','returned','other')),
  note text check (note is null or length(note) <= 300),
  staff_id uuid,
  staff_name text,
  at timestamptz not null default app.now(),
  foreign key (studio_id, product_id) references public.products (studio_id, id) on delete cascade,
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete set null (staff_id)
);
select app.scope_table('commerce_stock_log');
create index commerce_stock_log_product_idx on public.commerce_stock_log (studio_id, product_id, at desc);
create policy commerce_stock_log_read on public.commerce_stock_log for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));

-- ---------------------------------------------------------------- gift card emails for a sender (edge function / cron) to drain
create table public.commerce_outbox (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  kind text not null check (kind in ('gift_card')),
  card_id uuid not null,
  to_email text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  error text,
  foreign key (studio_id, card_id) references public.commerce_gift_cards (studio_id, id) on delete cascade
);
select app.scope_table('commerce_outbox');
create index commerce_outbox_pending_idx on public.commerce_outbox (created_at) where sent_at is null;
create policy commerce_outbox_read on public.commerce_outbox for select to authenticated using (app.has_role_in(studio_id, 'owner'));

-- ---------------------------------------------------------------- writes only through the RPCs
do $$
declare t text;
begin
  foreach t in array array['commerce_settings','commerce_gift_cards','commerce_gift_entries','commerce_promos','commerce_redemptions',
                           'commerce_ref_codes','commerce_referrals','commerce_retail','commerce_stock_log','commerce_outbox']
  loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
