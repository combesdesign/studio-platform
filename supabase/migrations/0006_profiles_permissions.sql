-- =============================================================================
-- 0006: profile photos, client self-edit rules, register interest, permissions that match
-- src/domain/permissions.ts (the matrix the apps use), reports shaped like the demo's,
-- and classes kept in step with the weekly timetable.
--
--   * clients.photo_url + Storage bucket 'avatars' (public read; a client writes only
--     avatars/<their client id>/..., staff write anything). Never data: URLs in Postgres.
--   * guard_client: runs as the caller, so our own SECURITY DEFINER functions (submit_waiver,
--     sign-up linking) are trusted. Before this, a client's own submit_waiver was silently undone.
--   * Permissions, role by role, now match can():
--       manager    reads pay rates (reports_pay) but only the owner changes them (staff_pay)
--       front desk edits class types (schedule)
--       everyone on staff reads passes (clients_view: client profiles show passes)
--       only the owner changes GST registration (settings_financial)
--   * report(): pay by the class's instructor_id whatever their role (Grace P is front desk and
--     teaches), sorted and counted like buildReport() in src/domain/report.ts.
--   * register_interest() / list_class_interest() for coming-soon classes.
--   * ensure_sessions(), refresh_template_sessions(), delete_template(): the live store's
--     equivalent of the demo making classes from the timetable as you look at dates.
--   * Grace P is front desk (and still teaches Mums + Bubs).
-- =============================================================================

-- ----------------------------------------------------------------------------- profile photos

alter table public.clients add column if not exists photo_url text;
alter table public.clients drop constraint if exists clients_photo_url_check;
alter table public.clients add constraint clients_photo_url_check
  check (photo_url is null or (length(photo_url) <= 1024 and photo_url !~* '^data:'));

-- Supabase Storage bucket for profile photos. Public = anyone with the link can view the image.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists spc_avatars_read on storage.objects;
drop policy if exists spc_avatars_insert on storage.objects;
drop policy if exists spc_avatars_update on storage.objects;
drop policy if exists spc_avatars_delete on storage.objects;
create policy spc_avatars_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'avatars');
create policy spc_avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (public.is_staff()
              or (storage.foldername(name))[1] = public.current_client_id()::text));
create policy spc_avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (public.is_staff()
         or (storage.foldername(name))[1] = public.current_client_id()::text))
  with check (bucket_id = 'avatars' and (public.is_staff()
              or (storage.foldername(name))[1] = public.current_client_id()::text));
create policy spc_avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (public.is_staff()
         or (storage.foldername(name))[1] = public.current_client_id()::text));

-- ----------------------------------------------------------------------------- client self-edits

-- Runs as the CALLER (not security definer): a client updating through the API is 'authenticated';
-- our SECURITY DEFINER functions run as their owner and are trusted (they apply their own checks).
-- Clients can change their name, phone, birthday, injuries, emergency contact, news opt-in and photo.
-- Never: email (that goes through Supabase Auth), waiver, health form, source, archived, staff notes
-- (a separate table only owner/manager/front desk can touch), intro eligibility, Momence id.
create or replace function app.guard_client() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if public.has_role('owner', 'manager', 'front_desk') then return new; end if;  -- clients_edit
  new.id := old.id;
  new.user_id := old.user_id;
  new.email := old.email;
  new.created_at := old.created_at;
  new.source := old.source;
  new.archived := old.archived;
  new.intro_ineligible := old.intro_ineligible;
  new.momence_id := old.momence_id;
  new.waiver_signed_at := old.waiver_signed_at;  -- use submit_waiver()
  new.health_form := old.health_form;
  if new.photo_url is distinct from old.photo_url and new.photo_url is not null
     and position('/avatars/' || old.id::text || '/' in new.photo_url) = 0 then
    raise exception 'INVALID: Please upload your photo through the app.' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- When someone changes their login email (Supabase Auth, after confirming it), keep their profile in step.
create or replace function app.sync_auth_email() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(new.email, '') <> '' and new.email is distinct from old.email then
    update public.clients set email = lower(new.email) where user_id = new.id;
    update public.staff set email = lower(new.email) where user_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function app.sync_auth_email();

-- Archived clients can't use the app (same as the demo store).
create or replace function public.whoami() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object('kind', 'staff', 'staff_id', id, 'email', coalesce(email, ''), 'name', name, 'role', role)
       from public.staff where user_id = auth.uid() and active),
    (select jsonb_build_object('kind', 'client', 'client_id', id, 'email', email, 'name', trim(first_name || ' ' || last_name))
       from public.clients where user_id = auth.uid() and not archived))
$$;

-- ----------------------------------------------------------------------------- permissions = can()

-- Pay rates: owner and manager can see them (reports_pay); only the owner changes them (staff_pay).
drop policy if exists staff_pay_owner on public.staff_pay;
drop policy if exists staff_pay_read on public.staff_pay;
drop policy if exists staff_pay_insert on public.staff_pay;
drop policy if exists staff_pay_update on public.staff_pay;
drop policy if exists staff_pay_delete on public.staff_pay;
create policy staff_pay_read on public.staff_pay for select to authenticated using (public.has_role('owner', 'manager'));
create policy staff_pay_insert on public.staff_pay for insert to authenticated with check (public.has_role('owner'));
create policy staff_pay_update on public.staff_pay for update to authenticated
  using (public.has_role('owner')) with check (public.has_role('owner'));
create policy staff_pay_delete on public.staff_pay for delete to authenticated using (public.has_role('owner'));

-- Class types belong to the schedule (front desk runs it).
drop policy if exists class_types_write on public.class_types;
create policy class_types_write on public.class_types for all to authenticated
  using (public.has_role('owner', 'manager', 'front_desk')) with check (public.has_role('owner', 'manager', 'front_desk'));

-- Passes are part of a client profile (clients_view = every staff role). Sales stay POS-only.
drop policy if exists passes_read on public.passes;
create policy passes_read on public.passes for select to authenticated
  using (client_id = public.current_client_id() or public.is_staff());
drop policy if exists pass_adjustments_read on public.pass_adjustments;
create policy pass_adjustments_read on public.pass_adjustments for select to authenticated
  using (public.is_staff()
         or exists (select 1 from public.passes p where p.id = pass_id and p.client_id = public.current_client_id()));

-- ABN and GST registration: owner only (settings_financial). Bank and Stripe live in Stripe itself.
create or replace function app.guard_settings() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() and not public.has_role('owner')
     and (new.abn is distinct from old.abn or new.gst_registered is distinct from old.gst_registered) then
    perform app.fail('NOT_ALLOWED', 'Only the owner can change the ABN and GST settings.');
  end if;
  return new;
end $$;

-- Grace P: front desk who also teaches (RULES.md). New projects get this from seed.sql.
update public.staff set role = 'front_desk' where id = '5aff0000-0000-4000-8000-000000000004' and role = 'instructor';

-- ----------------------------------------------------------------------------- register interest

-- Client registers for a coming-soon class (or front desk does it for them). Safe to repeat.
create or replace function public.register_interest(p_class_type_id uuid, p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid := coalesce(p_client_id, public.current_client_id()); r public.class_interest;
begin
  if v_client is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  if not (app.is_privileged() or v_client = public.current_client_id() or public.has_role('owner', 'manager', 'front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You can only register interest for yourself.');
  end if;
  if not exists (select 1 from public.class_types where id = p_class_type_id) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that class.');
  end if;
  if not exists (select 1 from public.clients where id = v_client) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  insert into public.class_interest (client_id, class_type_id, created_at) values (v_client, p_class_type_id, app.now())
  on conflict (client_id, class_type_id) do nothing;
  select * into r from public.class_interest where client_id = v_client and class_type_id = p_class_type_id;
  return jsonb_build_object('client_id', r.client_id, 'class_type_id', r.class_type_id, 'created_at', r.created_at);
end $$;

-- Staff: who's keen on which class (newest first), with contact details for the launch email.
create or replace function public.list_class_interest(p_class_type_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_privileged() or public.is_staff()) then perform app.fail('NOT_ALLOWED', 'Only studio staff can see this.'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'client_id', c.id, 'class_type_id', i.class_type_id, 'class_name', ct.name, 'created_at', i.created_at,
             'first_name', c.first_name, 'last_name', c.last_name, 'email', c.email, 'phone', c.phone,
             'marketing_opt_in', c.marketing_opt_in) order by i.created_at desc)
      from public.class_interest i
      join public.clients c on c.id = i.client_id
      join public.class_types ct on ct.id = i.class_type_id
     where p_class_type_id is null or i.class_type_id = p_class_type_id), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- classes from the timetable

-- Core of generate_sessions (no permission check; callers check). Optionally one template only.
create or replace function app.gen_sessions(p_from date, p_to date, p_template uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_tz text := app.tz();
begin
  if p_to < p_from then return 0; end if;
  insert into public.class_sessions (class_type_id, template_id, template_date, starts_at, ends_at, instructor_id, capacity)
  select t.class_type_id, t.id, d::date,
         ((d::date + t.start_time) at time zone v_tz),
         ((d::date + t.start_time) at time zone v_tz) + make_interval(mins => ct.duration_min),
         t.instructor_id, coalesce(t.capacity, ct.default_capacity)
    from public.schedule_templates t
    join public.class_types ct on ct.id = t.class_type_id
    cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
   where t.active and ct.active
     and (p_template is null or t.id = p_template)
     and extract(dow from d) = t.weekday
     and d::date >= t.starts_on
     and (t.ends_on is null or d::date <= t.ends_on)
  on conflict (template_id, template_date) where template_id is not null and template_date is not null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.generate_sessions(p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_privileged() or public.has_role('owner', 'manager', 'front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to change the schedule.');
  end if;
  if p_to - p_from > 400 then perform app.fail('INVALID', 'Please generate at most about a year at a time.'); end if;
  return app.gen_sessions(p_from, p_to);
end $$;

-- Anyone signed in: make sure classes exist for the dates being looked at (today .. 180 days ahead).
-- Idempotent and only ever adds classes from the timetable, like the demo store does on read.
create or replace function public.ensure_sessions(p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_today date := app.local_date(app.now()); v_from date; v_to date;
begin
  if auth.uid() is null and not app.is_privileged() then return 0; end if;
  v_from := greatest(p_from, v_today);
  v_to := least(p_to, v_today + 180);
  if v_to < v_from then return 0; end if;
  return app.gen_sessions(v_from, v_to);
end $$;

-- After a weekly slot is edited: drop its future classes that nobody has booked (any status) and
-- make them again from the new details. Booked classes keep their old details (same as the demo).
create or replace function public.refresh_template_sessions(p_template_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_today date := app.local_date(app.now()); v_last date;
begin
  if not (app.is_privileged() or public.has_role('owner', 'manager', 'front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to change the schedule.');
  end if;
  select max(template_date) into v_last from public.class_sessions where template_id = p_template_id and starts_at > app.now();
  delete from public.class_sessions s
   where s.template_id = p_template_id and s.starts_at > app.now()
     and not exists (select 1 from public.bookings b where b.session_id = s.id);
  return app.gen_sessions(v_today, greatest(coalesce(v_last, v_today), v_today + 28), p_template_id);
end $$;

-- Remove a weekly slot: its future unbooked classes go too; classes with bookings stay as one-offs.
create or replace function public.delete_template(p_template_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_privileged() or public.has_role('owner', 'manager', 'front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to change the schedule.');
  end if;
  if not exists (select 1 from public.schedule_templates where id = p_template_id) then
    perform app.fail('NOT_FOUND', 'That timetable slot could not be found.');
  end if;
  delete from public.class_sessions s
   where s.template_id = p_template_id and s.starts_at > app.now()
     and not exists (select 1 from public.bookings b where b.session_id = s.id);
  delete from public.schedule_templates where id = p_template_id;
end $$;

-- ----------------------------------------------------------------------------- reports

-- computePassStatus() from src/domain/rules.ts.
create or replace function app.pass_status_now(p public.passes, p_now timestamptz) returns text
language sql stable as $$
  select case
    when p.status = 'cancelled' then 'cancelled'
    when p.expires_at is not null and p_now >= p.expires_at then 'expired'
    when p.kind <> 'membership' and p.credits is not null and p.credits_used >= p.credits then 'used_up'
    when p.paused_from is not null and app.local_date(p_now) >= p.paused_from
         and (p.paused_until is null or app.local_date(p_now) <= p.paused_until) then 'paused'
    else 'active' end
$$;

-- Shaped like StudioReport and counted like buildReport() (src/domain/report.ts).
-- Revenue: owner/manager (reports_revenue). Pay: owner/manager (reports_pay). Attendance: all staff.
-- Instructor rows go by each class's instructor_id, whatever that person's role.
create or replace function public.report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text := app.tz();
  v_now timestamptz := app.now();
  v_start timestamptz := (p_from::timestamp) at time zone v_tz;
  v_end timestamptz := ((p_to + 1)::timestamp) at time zone v_tz;
  v_pay boolean := app.is_privileged() or public.has_role('owner', 'manager');
  v_money boolean := app.is_privileged() or public.has_role('owner', 'manager');
  v jsonb;
begin
  if not (app.is_privileged() or public.is_staff()) then
    perform app.fail('NOT_ALLOWED', 'Reports are for staff.');
  end if;

  with
  sl as (select * from public.sales where created_at >= v_start and created_at < v_end),
  -- Each sale's total split across its items in proportion (handles discounts and comps), like allocateSale().
  it as (
    select i.sale_id, i.id, coalesce(i.kind, 'retail') as kind, (i.qty * i.unit_cents)::numeric as g, sl.total_cents::numeric as t
      from public.sale_items i join sl on sl.id = i.sale_id
     where coalesce(i.kind, '') <> 'discount'),
  it2 as (
    select it.*, sum(g) over (partition by sale_id) as gs,
           row_number() over (partition by sale_id order by id) as rn, count(*) over (partition by sale_id) as n
      from it),
  it3 as (
    select sale_id, kind, rn, n, t, gs,
           case when gs <= 0 then case when rn = 1 then t else 0 end else floor(g * t / gs) end as a
      from it2),
  alloc as (
    select kind, a + case when gs > 0 and rn = n then t - sum(a) over (partition by sale_id) else 0 end as a from it3),
  ses as (
    select s.id, s.class_type_id, s.instructor_id, s.starts_at, s.capacity, ct.name as ct_name,
           count(b.id) filter (where b.status in ('booked','checked_in','no_show','late_cancelled')) as total_b,
           count(b.id) filter (where b.status = 'checked_in') as attended,
           count(b.id) filter (where b.status in ('booked','checked_in','no_show')) as filled,
           count(b.id) filter (where b.status = 'no_show') as no_shows,
           count(b.id) filter (where b.status = 'late_cancelled') as late_cancels
      from public.class_sessions s
      join public.class_types ct on ct.id = s.class_type_id
      left join public.bookings b on b.session_id = s.id
     where s.status = 'scheduled' and s.starts_at >= v_start and s.starts_at < v_end and s.starts_at <= v_now
     group by s.id, ct.name),
  ses2 as (
    select ses.*, case when capacity > 0 then least(100.0, filled * 100.0 / capacity) else 0 end as fill,
           to_char(starts_at at time zone v_tz, 'Dy') || ' ' || lower(to_char(starts_at at time zone v_tz, 'FMHH12:MIam')) as slot
      from ses)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'revenue_cents', coalesce((select sum(total_cents) from sl), 0),
    'refunds_cents', coalesce((select sum(refunded_cents) from public.sales where refunded_at >= v_start and refunded_at < v_end), 0),
    'revenue_by_method', coalesce((select jsonb_object_agg(method, c) from (select method, sum(total_cents) c from sl group by method) x), '{}'::jsonb),
    'revenue_by_kind', coalesce((select jsonb_object_agg(kind, c) from (select kind, sum(a)::bigint c from alloc group by kind) x), '{}'::jsonb),
    'sales_count', (select count(*) from sl),
    'classes_run', (select count(*) from ses2),
    'total_bookings', coalesce((select sum(total_b) from ses2), 0),
    'attended', coalesce((select sum(attended) from ses2), 0),
    'no_shows', coalesce((select sum(no_shows) from ses2), 0),
    'late_cancels', coalesce((select sum(late_cancels) from ses2), 0),
    'avg_fill_pct', coalesce((select round(avg(fill), 1) from ses2), 0),
    'new_clients', (select count(*) from public.clients where created_at >= v_start and created_at < v_end),
    'active_memberships', (select count(*) from public.passes p where p.kind = 'membership' and app.pass_status_now(p, v_now) = 'active'),
    'active_packs', (select count(*) from public.passes p where p.kind <> 'membership' and app.pass_status_now(p, v_now) = 'active'),
    'by_instructor', coalesce((
        select jsonb_agg(jsonb_build_object('staff_id', x.instructor_id, 'name', coalesce(st.name, 'Unknown'), 'classes', x.classes,
                 'attendees', x.att, 'pay_cents', case when v_pay then x.classes * coalesce(sp.pay_per_class_cents, 0) else 0 end)
               order by x.classes desc, coalesce(st.name, 'Unknown'))
          from (select instructor_id, count(*) classes, sum(attended) att from ses2 group by instructor_id) x
          left join public.staff st on st.id = x.instructor_id
          left join public.staff_pay sp on sp.staff_id = x.instructor_id), '[]'::jsonb),
    'by_class_type', coalesce((
        select jsonb_agg(jsonb_build_object('class_type_id', class_type_id, 'name', ct_name, 'classes', classes,
                 'attendees', att, 'avg_fill_pct', fill) order by classes desc, ct_name)
          from (select class_type_id, ct_name, count(*) classes, sum(attended) att, round(avg(fill), 1) fill
                  from ses2 group by class_type_id, ct_name) x), '[]'::jsonb),
    'top_slots', coalesce((
        select jsonb_agg(jsonb_build_object('label', slot, 'avg_attendees', avg_att) order by avg_att desc, slot)
          from (select slot, round(avg(attended), 1) as avg_att from ses2 group by slot order by 2 desc, 1 limit 5) x), '[]'::jsonb)
  ) into v;
  if not v_money then
    v := v || jsonb_build_object('revenue_cents', 0, 'refunds_cents', 0, 'revenue_by_method', '{}'::jsonb,
                                 'revenue_by_kind', '{}'::jsonb, 'sales_count', 0);
  end if;
  return v;
end $$;

-- ----------------------------------------------------------------------------- reminders + online retail

-- "See you soon" emails ~2 hours before class. Skips people who booked inside those 2 hours
-- (they've only just had a confirmation email).
create or replace function public.queue_class_reminders(p_hours numeric default 2) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now timestamptz := app.now(); r record; n int := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for r in select b.id from public.bookings b join public.class_sessions s on s.id = b.session_id
            where b.status = 'booked' and b.reminder_sent_at is null and s.status = 'scheduled'
              and s.starts_at > v_now and s.starts_at <= v_now + make_interval(secs => p_hours * 3600)
              and coalesce(b.promoted_from_waitlist_at, b.created_at) <= s.starts_at - make_interval(secs => p_hours * 3600)
            for update of b skip locked
  loop
    perform app.notify(r.id, 'class_reminder');
    update public.bookings set reminder_sent_at = v_now where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Same as 0003, plus: retail bought online takes one off the stock count.
create or replace function public.create_pass_from_purchase(
  p_client_id uuid,
  p_product_id uuid,
  p_amount_cents integer,
  p_method text default 'card_online',
  p_stripe_checkout_session_id text default null,
  p_stripe_payment_intent_id text default null,
  p_stripe_invoice_id text default null,
  p_stripe_subscription_id text default null,
  p_next_billing_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sale uuid; pr public.products; p public.passes;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Purchases are recorded by the payment system.'); end if;

  select id into v_sale from public.sales
   where (p_stripe_checkout_session_id is not null and stripe_checkout_session_id = p_stripe_checkout_session_id)
      or (p_stripe_payment_intent_id is not null and stripe_payment_intent_id = p_stripe_payment_intent_id)
   limit 1;
  if v_sale is not null then
    return jsonb_build_object('sale', app.sale_json(v_sale),
      'pass', (select app.pass_json(id) from public.passes where sale_id = v_sale limit 1), 'duplicate', true);
  end if;

  select * into pr from public.products where id = p_product_id;
  if pr.id is null then perform app.fail('NOT_FOUND', 'Unknown product.'); end if;

  insert into public.sales (client_id, total_cents, method, stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id)
  values (p_client_id, p_amount_cents, p_method, p_stripe_checkout_session_id, p_stripe_payment_intent_id, p_stripe_invoice_id)
  returning id into v_sale;
  insert into public.sale_items (sale_id, product_id, name, qty, unit_cents, kind)
  values (v_sale, pr.id, pr.name, 1, p_amount_cents, pr.kind);

  if pr.kind = 'retail' then
    update public.products set stock = greatest(0, stock - 1) where id = pr.id and stock is not null;
  else
    -- Already paid, so don't block on the intro rule here; it was checked before checkout.
    begin
      p := app.create_pass(p_client_id, pr.id, v_sale, p_amount_cents, p_stripe_subscription_id, p_next_billing_at);
    exception when others then
      if sqlerrm like 'INTRO_NOT_ELIGIBLE%' then
        insert into public.passes (client_id, product_id, kind, name, validity_days, credits, price_cents, sale_id)
        values (p_client_id, pr.id, pr.kind, pr.name, pr.validity_days, pr.credits, p_amount_cents, v_sale)
        returning * into p;
        perform app.audit('intro_rule_bypassed_after_payment', 'passes', p.id::text, null);
      else raise; end if;
    end;
  end if;
  perform app.queue_receipt(v_sale);
  return jsonb_build_object('sale', app.sale_json(v_sale), 'pass', case when p.id is not null then app.pass_json(p.id) end, 'duplicate', false);
end $$;

-- ----------------------------------------------------------------------------- memberships paid through Stripe

-- Stripe bills a membership from the day it's bought, so a cancelled one runs to the end of the
-- week already paid for (next_billing_at), even if it was never used. Otherwise as in 0005.
create or replace function public.cancel_membership(p_pass_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true); v_end timestamptz;
begin
  if p.kind <> 'membership' then perform app.fail('INVALID', 'Only memberships can be cancelled this way.'); end if;
  if p.status = 'cancelled' then return app.pass_json(p.id); end if;
  v_end := case
    when p.stripe_subscription_id is not null then coalesce(p.next_billing_at, app.now())
    when p.activated_at is null then app.now()  -- never used, nothing paid-for to run out (like the demo)
    else coalesce(p.next_billing_at, p.activated_at + interval '7 days') end;
  update public.passes set cancel_at_period_end = true, status = 'cancelled', next_billing_at = v_end where id = p.id;
  perform app.cancel_pass_bookings(p.id, v_end);
  perform app.audit('cancel_membership', 'passes', p.id::text, jsonb_build_object('ends', v_end));
  return app.pass_json(p.id);
end $$;

-- ----------------------------------------------------------------------------- grants
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.now(), app.tz(), app.is_privileged() to anon, authenticated;

revoke execute on function public.register_interest, public.list_class_interest, public.ensure_sessions,
  public.refresh_template_sessions, public.delete_template, public.generate_sessions, public.report,
  public.whoami, public.queue_class_reminders, public.create_pass_from_purchase from public, anon;
grant execute on function public.register_interest, public.list_class_interest, public.ensure_sessions,
  public.refresh_template_sessions, public.delete_template, public.generate_sessions, public.report,
  public.whoami to authenticated;
revoke execute on function public.queue_class_reminders, public.create_pass_from_purchase from authenticated;
grant execute on all functions in schema public to service_role;
