-- Commerce RPCs, part 2: referrals and retail stock (SKU, barcode, counts, log, report), then who can call what.
-- Same rules and error codes as src/features/commerce/demo.ts.

-- ---------------------------------------------------------------- referrals

-- A client's own code, made on first use: FIRSTNAME-XXXX (same alphabet as gift cards).
create or replace function app.commerce_ref_code(p_client uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid := app.current_studio_id(); v_code text; v_base text;
begin
  select code into v_code from public.commerce_ref_codes where studio_id = sid and client_id = p_client;
  if v_code is not null then return v_code; end if;
  select coalesce(nullif(left(regexp_replace(upper(first_name), '[^A-Z]', '', 'g'), 8), ''), 'FRIEND') into v_base from public.clients where id = p_client and studio_id = sid;
  loop
    v_code := v_base || '-' || left(app.commerce_make_code(), 4);
    begin
      insert into public.commerce_ref_codes (studio_id, client_id, code) values (sid, p_client, v_code);
      return v_code;
    exception when unique_violation then
      select code into v_code from public.commerce_ref_codes where studio_id = sid and client_id = p_client;
      if v_code is not null then return v_code; end if;
    end;
  end loop;
end $$;

create or replace function public.commerce_my_referral() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); v_me uuid := app.commerce_client(); st public.commerce_settings := app.commerce_settings_row();
begin
  perform app.commerce_tick();
  return jsonb_build_object(
    'enabled', st.referral_enabled, 'code', app.commerce_ref_code(v_me), 'reward_kind', st.referral_reward_kind, 'reward_cents', st.referral_reward_cents,
    'referrals', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(nullif(c.first_name, ''), 'A friend'), 'status', r.status, 'at', r.created_at) order by r.created_at desc)
                             from public.commerce_referrals r join public.clients c on c.id = r.referred_client_id
                            where r.studio_id = sid and r.referrer_client_id = v_me), '[]'::jsonb),
    'earned_cents', coalesce((select sum(reward_cents) from public.commerce_referrals where studio_id = sid and referrer_client_id = v_me), 0)::int,
    'referred_by', (select nullif(c.first_name, '') from public.commerce_referrals r join public.clients c on c.id = r.referrer_client_id
                     where r.studio_id = sid and r.referred_client_id = v_me));
end $$;

-- Client: join with a friend's code. Only new clients, once.
create or replace function public.commerce_claim_referral(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); v_me uuid := app.commerce_client(); st public.commerce_settings := app.commerce_settings_row();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g')); v_ref uuid;
begin
  perform app.assert_studio_open(sid);
  perform app.commerce_tick();
  if not st.referral_enabled then perform app.fail('INVALID', 'Referrals aren’t running at the moment.'); end if;
  select client_id into v_ref from public.commerce_ref_codes where studio_id = sid and code = v_code and v_code <> '';
  if v_ref is null then perform app.fail('NOT_FOUND', 'We couldn’t find that referral code. Check it with your friend.'); end if;
  if v_ref = v_me then perform app.fail('INVALID', 'That’s your own code. Share it with a friend instead.'); end if;
  if exists (select 1 from public.commerce_referrals where studio_id = sid and referred_client_id = v_me) then
    perform app.fail('INVALID', 'You’ve already joined with a friend’s code.');
  end if;
  if not app.commerce_is_new(v_me) then perform app.fail('INVALID', 'Referral codes are for new clients, and you’ve already had a pass.'); end if;
  insert into public.commerce_referrals (studio_id, referrer_client_id, referred_client_id) values (sid, v_ref, v_me);
  return jsonb_build_object('referrer_name', coalesce((select nullif(first_name, '') from public.clients where id = v_ref), 'your friend'));
end $$;

create or replace function public.commerce_referral_stats() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid := app.current_studio_id(); st public.commerce_settings := app.commerce_settings_row();
begin
  perform app.commerce_need('view');
  perform app.commerce_tick();
  return jsonb_build_object(
    'enabled', st.referral_enabled, 'reward_kind', st.referral_reward_kind, 'reward_cents', st.referral_reward_cents,
    'referrals', (select count(*) from public.commerce_referrals where studio_id = sid),
    'rewarded', (select count(*) from public.commerce_referrals where studio_id = sid and status = 'rewarded'),
    'pending', (select count(*) from public.commerce_referrals where studio_id = sid and status = 'pending'),
    'reward_cents_paid', coalesce((select sum(reward_cents) from public.commerce_referrals where studio_id = sid), 0)::int,
    'top', coalesce((select jsonb_agg(t) from (
        select r.referrer_client_id client_id, coalesce(nullif(btrim(c.first_name || ' ' || c.last_name), ''), 'Former client') name,
               count(*)::int referrals, (count(*) filter (where r.status = 'rewarded'))::int rewarded
          from public.commerce_referrals r left join public.clients c on c.id = r.referrer_client_id
         where r.studio_id = sid group by r.referrer_client_id, c.first_name, c.last_name
         order by 4 desc, 3 desc limit 5) t), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(t) from (
        select r.id, r.referrer_client_id, coalesce(nullif(btrim(a.first_name || ' ' || a.last_name), ''), 'Former client') referrer_name,
               r.referred_client_id, coalesce(nullif(btrim(b.first_name || ' ' || b.last_name), ''), 'Former client') referred_name,
               r.status, r.created_at, r.rewarded_at, r.reward_cents
          from public.commerce_referrals r left join public.clients a on a.id = r.referrer_client_id left join public.clients b on b.id = r.referred_client_id
         where r.studio_id = sid order by r.created_at desc limit 12) t), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- retail stock

create or replace function app.commerce_item_json(p public.products) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('product_id', p.id, 'name', p.name, 'price_cents', p.price_cents, 'active', p.active, 'stock', p.stock,
    'sku', m.sku, 'barcode', m.barcode, 'low_at', l.low_at, 'low_stock_at', m.low_stock_at,
    'status', case when p.stock is null then 'untracked' when p.stock <= 0 then 'out' when p.stock <= l.low_at then 'low' else 'ok' end)
    from (select 1) o
    left join public.commerce_retail m on m.studio_id = p.studio_id and m.product_id = p.id
    cross join lateral (select coalesce(m.low_stock_at, (app.commerce_settings_row()).low_stock_default) low_at) l
$$;

create or replace function app.commerce_retail_product(p_id uuid, p_lock boolean default false) returns public.products
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.products;
begin
  perform app.assert_in_studio('products', p_id, 'We couldn’t find that product.');
  if p_lock then select * into p from public.products where id = p_id and studio_id = app.current_studio_id() and kind = 'retail' for update;
  else select * into p from public.products where id = p_id and studio_id = app.current_studio_id() and kind = 'retail'; end if;
  if p.id is null then perform app.fail('NOT_FOUND', 'We couldn’t find that product.'); end if;
  return p;
end $$;

create or replace function public.commerce_list_retail() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.commerce_need('stock');
  return coalesce((select jsonb_agg(app.commerce_item_json(p) order by lower(p.name), p.id)
                     from public.products p where p.studio_id = app.current_studio_id() and p.kind = 'retail'), '[]'::jsonb);
end $$;

-- Change a product's SKU, barcode or own low-stock level. A key that is present and null/blank clears it.
create or replace function public.commerce_update_retail(p_product_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); p public.products; m public.commerce_retail; f text; v text; v_low int;
begin
  perform app.commerce_need('stock');
  perform app.assert_studio_open(sid);
  p := app.commerce_retail_product(p_product_id, true);
  select * into m from public.commerce_retail where studio_id = sid and product_id = p.id;
  if m.product_id is null then
    insert into public.commerce_retail (studio_id, product_id) values (sid, p.id);
    select * into m from public.commerce_retail where studio_id = sid and product_id = p.id;
  end if;
  foreach f in array array['sku','barcode'] loop
    if not (p_patch ? f) then continue; end if;
    v := nullif(btrim(coalesce(p_patch ->> f, '')), '');
    if v is not null and length(v) > 40 then perform app.fail('INVALID', 'Keep that under 40 characters.'); end if;
    if v is not null and exists (select 1 from public.commerce_retail x where x.studio_id = sid and x.product_id <> p.id and lower(case f when 'sku' then x.sku else x.barcode end) = lower(v)) then
      perform app.fail('INVALID', 'Another product already has that ' || case f when 'sku' then 'SKU' else 'barcode' end || '.');
    end if;
    if f = 'sku' then m.sku := v; else m.barcode := v; end if;
  end loop;
  if p_patch ? 'low_stock_at' then
    if jsonb_typeof(p_patch -> 'low_stock_at') = 'null' then m.low_stock_at := null;
    else
      v_low := (p_patch ->> 'low_stock_at')::int;
      if v_low is null or v_low < 0 then perform app.fail('INVALID', 'The low-stock level is a whole number, 0 or more.'); end if;
      m.low_stock_at := v_low;
    end if;
  end if;
  update public.commerce_retail set sku = m.sku, barcode = m.barcode, low_stock_at = m.low_stock_at where studio_id = sid and product_id = p.id;
  return app.commerce_item_json(p);
end $$;

-- Add (delta) or set (set_to, a stocktake) the count, with a reason, and log it.
create or replace function public.commerce_adjust_stock(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sid uuid := app.current_studio_id(); v_staff uuid := app.commerce_need('stock'); p public.products;
  v_reason text := p_input ->> 'reason'; v_delta int := (p_input ->> 'delta')::int; v_set int := (p_input ->> 'set_to')::int; v_after int; v_before int;
begin
  perform app.assert_studio_open(sid);
  p := app.commerce_retail_product((p_input ->> 'product_id')::uuid, true);
  if v_reason is null or v_reason not in ('received','count','damaged','lost','returned','other') then perform app.fail('INVALID', 'Choose a reason.'); end if;
  if (v_delta is null) = (v_set is null) then perform app.fail('INVALID', 'Enter how many to add or take off, or the new count.'); end if;
  if v_set is not null then
    if v_set < 0 then perform app.fail('INVALID', 'The count is a whole number, 0 or more.'); end if;
    v_after := v_set;
  else
    if p.stock is null then perform app.fail('INVALID', 'Stock isn’t tracked for this product yet. Do a stocktake to set the first count.'); end if;
    if v_delta = 0 then perform app.fail('INVALID', 'Enter how many to add or take off.'); end if;
    v_after := p.stock + v_delta;
    if v_after < 0 then perform app.fail('INVALID', 'There are only ' || p.stock || ' in stock.'); end if;
  end if;
  v_before := coalesce(p.stock, 0);
  if v_after is not distinct from p.stock then perform app.fail('INVALID', 'That’s the same as the current count.'); end if;
  update public.products set stock = v_after where id = p.id returning * into p;
  insert into public.commerce_stock_log (studio_id, product_id, product_name, delta, before_count, after_count, reason, note, staff_id, staff_name)
  values (sid, p.id, p.name, v_after - v_before, v_before, v_after, v_reason, nullif(btrim(p_input ->> 'note'), ''), v_staff, (select name from public.staff where id = v_staff));
  return app.commerce_item_json(p);
end $$;

create or replace function public.commerce_stock_log(p_product_id uuid default null, p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.commerce_need('stock');
  perform app.assert_in_studio('products', p_product_id, 'We couldn’t find that product.');
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'product_id', x.product_id, 'product_name', x.product_name, 'delta', x.delta,
           'before', x.before_count, 'after', x.after_count, 'reason', x.reason, 'note', x.note, 'staff_id', x.staff_id, 'staff_name', x.staff_name, 'at', x.at) order by x.at desc, x.id)
      from (select * from public.commerce_stock_log l
             where l.studio_id = app.current_studio_id() and (p_product_id is null or l.product_id = p_product_id)
             order by l.at desc, l.id limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

-- Till: the active retail item whose barcode or SKU is exactly this (null if none). Instructors can run the till.
create or replace function public.commerce_find_retail(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := lower(btrim(regexp_replace(coalesce(p_code, ''), '[\x00-\x1f\x7f]', '', 'g'))); p public.products;
begin
  perform app.commerce_need('sell');
  if v = '' then return null; end if;
  select p2.* into p from public.products p2 join public.commerce_retail m on m.studio_id = p2.studio_id and m.product_id = p2.id
   where p2.studio_id = app.current_studio_id() and p2.kind = 'retail' and p2.active and (lower(m.barcode) = v or lower(m.sku) = v) limit 1;
  if p.id is null then return null; end if;
  return app.commerce_item_json(p);
end $$;

create or replace function public.commerce_stock_report(p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid := app.current_studio_id(); tz text := app.tz();
begin
  perform app.commerce_need('stock');
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', coalesce((select jsonb_agg(r order by lower(r.name)) from (
    select p.id product_id, p.name, m.sku, p.stock on_hand, (coalesce(p.stock, 0) * p.price_cents)::int value_cents,
           coalesce((select sum(i.qty) from public.sale_items i join public.sales s on s.id = i.sale_id
                      where i.studio_id = sid and i.product_id = p.id and (s.created_at at time zone tz)::date between p_from and p_to), 0)::int sold,
           coalesce((select sum(l.delta) from public.commerce_stock_log l where l.studio_id = sid and l.product_id = p.id and l.reason = 'received' and l.delta > 0
                      and (l.at at time zone tz)::date between p_from and p_to), 0)::int received,
           coalesce((select -sum(l.delta) from public.commerce_stock_log l where l.studio_id = sid and l.product_id = p.id and l.reason in ('damaged','lost') and l.delta < 0
                      and (l.at at time zone tz)::date between p_from and p_to), 0)::int written_off,
           (app.commerce_item_json(p) ->> 'status') status
      from public.products p left join public.commerce_retail m on m.studio_id = p.studio_id and m.product_id = p.id
     where p.studio_id = sid and p.kind = 'retail') r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- who can call what
-- Internal helpers: only our own security definer RPCs (and the service role) use them.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'commerce\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'commerce\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    if f.proname = 'commerce_activate_gift_card' then
      execute format('grant execute on function %s to service_role', f.sig);   -- the Stripe webhook only
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;
