-- 3100_terminal.sql: Stripe Terminal card readers at the studio desk (POS).
--
-- Server-driven: the iPad can't talk Bluetooth, so a smart reader (S700 / WisePOS E) on wifi is driven from the edge
-- functions (terminal-readers, terminal-pay). Nothing here is readable or writable from the apps: the three tables are
-- service role only, and the app asks the edge functions.
--
--   studio_terminal   one Stripe Terminal Location per studio (made on first reader registration)
--   terminal_readers  which readers belong to which studio (so one studio can never drive another's reader)
--   terminal_payments one row per card-present attempt: the cart is saved at the start (the amount is worked out here, from
--                     the cart, never taken from the app) and the sale is recorded once, by terminal_record_sale, whichever of
--                     the poll or the webhook gets there first.

create table public.studio_terminal (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  location_id text not null check (location_id ~ '^tml_[A-Za-z0-9]+$'),
  created_at timestamptz not null default now()
);

create table public.terminal_readers (
  reader_id text primary key check (reader_id ~ '^tmr_[A-Za-z0-9]+$'),
  studio_id uuid not null references public.studios(id) on delete cascade,
  label text not null default '',
  created_at timestamptz not null default now()
);
create index terminal_readers_studio on public.terminal_readers (studio_id);

create table public.terminal_payments (
  payment_intent_id text primary key check (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  studio_id uuid not null references public.studios(id) on delete cascade,
  reader_id text not null,
  client_id uuid,
  cart jsonb not null,
  discount_cents integer not null default 0,
  note text,
  staff_id uuid,
  amount_cents integer not null check (amount_cents > 0),
  -- paid_unrecorded: the card was charged but the cart could no longer be sold (e.g. the last one went): needs a human.
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'declined', 'canceled', 'failed', 'paid_unrecorded')),
  failure text,
  sale_id uuid references public.sales(id) on delete set null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index terminal_payments_studio on public.terminal_payments (studio_id, created_at desc);

alter table public.studio_terminal enable row level security;
alter table public.terminal_readers enable row level security;
alter table public.terminal_payments enable row level security;
revoke all on public.studio_terminal, public.terminal_readers, public.terminal_payments from anon, authenticated;
-- No policy lets anyone in (service role bypasses RLS), and the standard restrictive studio scope is on too.
create policy studio_scope on public.studio_terminal as restrictive for all to anon, authenticated using (app.in_scope(studio_id)) with check (app.in_scope(studio_id));
create policy studio_scope on public.terminal_readers as restrictive for all to anon, authenticated using (app.in_scope(studio_id)) with check (app.in_scope(studio_id));
create policy studio_scope on public.terminal_payments as restrictive for all to anon, authenticated using (app.in_scope(studio_id)) with check (app.in_scope(studio_id));
grant all on public.studio_terminal, public.terminal_readers, public.terminal_payments to service_role;

-- What the cart costs, worked out the same way checkout_cart does (retail + passes, discount capped at the subtotal).
-- Staff in the current studio only. The edge function charges exactly this and never a number from the app.
create or replace function public.terminal_quote(p_client_id uuid, p_items jsonb, p_discount_cents integer default 0)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare it record; pr public.products; v_total int := 0;
begin
  if not (app.is_privileged() or public.is_staff()) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to use the till.'); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform app.fail('INVALID', 'The cart is empty.'); end if;
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
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
    if pr.kind = 'retail' and pr.stock is not null and pr.stock < it.qty then
      perform app.fail('OUT_OF_STOCK', format('Only %s %s left in stock.', pr.stock, pr.name));
    end if;
    v_total := v_total + it.qty * pr.price_cents;
  end loop;
  v_total := v_total - least(greatest(coalesce(p_discount_cents, 0), 0), v_total);
  return v_total;
end $$;

-- Record the sale for a card-present payment, once. Service role only. Called by the status poll and by the webhook;
-- the row lock makes whichever comes second a no-op that returns the same sale. Null = not one of ours.
create or replace function public.terminal_record_sale(p_payment_intent text, p_paid_cents integer default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.terminal_payments; res jsonb; v_sale uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  select * into r from public.terminal_payments where payment_intent_id = p_payment_intent for update;
  if r.payment_intent_id is null then return null; end if;
  if r.sale_id is not null then return r.result || jsonb_build_object('duplicate', true); end if;
  perform app.use_studio(r.studio_id);
  begin
    res := app.checkout_cart_impl(r.client_id, r.cart, 'card_reader', r.discount_cents, r.note);
  exception when others then
    update public.terminal_payments set status = 'paid_unrecorded', failure = left(sqlerrm, 300), updated_at = now() where payment_intent_id = r.payment_intent_id;
    perform app.audit('terminal_paid_unrecorded', 'terminal_payments', r.payment_intent_id, jsonb_build_object('error', left(sqlerrm, 300)));
    return jsonb_build_object('unrecorded', true, 'message', left(sqlerrm, 300));
  end;
  v_sale := (res -> 'sale' ->> 'id')::uuid;
  update public.sales set stripe_payment_intent_id = r.payment_intent_id, staff_id = coalesce(staff_id, r.staff_id) where id = v_sale;
  res := jsonb_set(res, '{sale}', app.sale_json(v_sale));
  if (res -> 'sale' ->> 'total_cents')::int <> coalesce(p_paid_cents, r.amount_cents) then
    perform app.audit('terminal_amount_mismatch', 'sales', v_sale::text,
      jsonb_build_object('sale_cents', (res -> 'sale' ->> 'total_cents')::int, 'paid_cents', coalesce(p_paid_cents, r.amount_cents)));
  end if;
  update public.terminal_payments set status = 'succeeded', failure = null, sale_id = v_sale, result = res, updated_at = now()
   where payment_intent_id = r.payment_intent_id;
  return res || jsonb_build_object('duplicate', false);
end $$;

-- Mark an attempt declined / canceled / failed. Never touches one that already has a sale. Returns the final status.
create or replace function public.terminal_mark(p_payment_intent text, p_status text, p_failure text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the payment system can do that.'); end if;
  if p_status not in ('declined', 'canceled', 'failed') then perform app.fail('INVALID', 'Unknown status.'); end if;
  update public.terminal_payments set status = p_status, failure = left(p_failure, 300), updated_at = now()
   where payment_intent_id = p_payment_intent and sale_id is null and status in ('pending', 'declined', 'canceled', 'failed')
   returning status into v;
  return coalesce(v, (select status from public.terminal_payments where payment_intent_id = p_payment_intent));
end $$;

revoke execute on function public.terminal_record_sale, public.terminal_mark from public, anon, authenticated;
grant execute on function public.terminal_record_sale, public.terminal_mark to service_role;
revoke execute on function public.terminal_quote from public, anon;
grant execute on function public.terminal_quote to authenticated;
