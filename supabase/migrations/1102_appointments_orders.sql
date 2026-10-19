-- Appointments: paying online (Stripe Checkout).
--
-- 1. The client app calls the appointments-checkout edge function, which calls appointments_hold_order AS THE CLIENT:
--    the slot (or workshop place) is held as 'pending_payment' for 30 minutes (Stripe's shortest Checkout lifetime) and an
--    appointment_orders row records what is being bought and for how much. Packs aren't held, they never run out.
-- 2. The function creates the Checkout Session (metadata.appointments_order_id) and attaches its id (appointments_attach_checkout).
-- 3. The appointments-stripe-webhook calls appointments_complete_order (service role) when Stripe says it's paid: the sale is
--    recorded and the hold becomes a booking / registration, or the pack credits are created. Idempotent.
--    If the hold had already lapsed and someone else took the slot in the meantime, the money is still recorded and the
--    appointment is marked refund_due so the front desk sees it.
-- 4. checkout.session.expired (or appointments_release_holds from a cron) lets the slot go.

create or replace function public.appointments_hold_order(
  p_kind text,
  p_type_id uuid default null, p_staff_id uuid default null, p_starts_at timestamptz default null, p_people int default 1, p_note text default null,
  p_pack_id uuid default null,
  p_event_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor();
  v_now timestamptz := app.now();
  v_exp timestamptz := app.now() + interval '30 minutes';
  t public.appointment_types;
  pk public.appointment_packs;
  e public.studio_events;
  v_title text;
  v_amount int;
  v_appt uuid;
  v_reg uuid;
  v_order uuid;
  v_start timestamptz;
  v_taken int;
begin
  if v.as_staff or v.client_id is null then perform app.fail('NOT_ALLOWED', 'Online checkout is for client accounts. Use the till in the studio app.'); end if;
  perform app.assert_studio_open(v.studio);
  if p_kind not in ('appointment', 'pack', 'event') then perform app.fail('INVALID', 'Choose what you''re paying for.'); end if;

  if p_kind = 'appointment' then
    perform app.assert_in_studio('appointment_types', p_type_id, 'We couldn''t find that session.');
    if (select waiver_signed_at from public.clients where id = v.client_id) is null then
      perform app.fail('WAIVER_REQUIRED', 'Please complete your waiver and health form before booking.');
    end if;
    t := app.ap_check_slot(v.studio, p_type_id, p_staff_id, p_starts_at, coalesce(p_people, 1), v.client_id, false);
    v_amount := coalesce(p_people, 1) * t.price_cents;
    if v_amount <= 0 then perform app.fail('INVALID', 'This session is free: book it without paying.'); end if;
    v_title := case when coalesce(p_people, 1) = 2 then t.name || ' (2 people)' else t.name end;
    begin
      insert into public.appointments (studio_id, type_id, type_name, staff_id, client_id, people, starts_at, ends_at, buffer_min, status, pay_method,
                                       amount_cents, note, source, hold_expires_at)
      values (v.studio, t.id, t.name, p_staff_id, v.client_id, coalesce(p_people, 1), p_starts_at, p_starts_at + make_interval(mins => t.duration_min),
              t.buffer_min, 'pending_payment', 'card_online', v_amount, nullif(trim(coalesce(p_note, '')), ''), 'client', v_exp)
      returning id into v_appt;
    exception when unique_violation then
      perform app.fail('SLOT_TAKEN', 'That time isn''t available any more. Please pick another.');
    end;

  elsif p_kind = 'pack' then
    perform app.assert_in_studio('appointment_packs', p_pack_id, 'That pack isn''t available.');
    select * into pk from public.appointment_packs where id = p_pack_id and studio_id = v.studio and active;
    if pk.id is null then perform app.fail('NOT_FOUND', 'That pack isn''t available.'); end if;
    if pk.price_cents <= 0 then perform app.fail('INVALID', 'That pack can''t be bought online.'); end if;
    v_title := pk.name; v_amount := pk.price_cents;

  else
    perform app.assert_in_studio('studio_events', p_event_id, 'We couldn''t find that event.');
    select * into e from public.studio_events where id = p_event_id and studio_id = v.studio for update;
    if e.id is null or e.cancelled or not e.published then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
    if e.price_cents <= 0 then perform app.fail('INVALID', 'This one is free: just register.'); end if;
    select min(starts_at) into v_start from public.studio_event_sessions where event_id = e.id;
    if v_now >= v_start then perform app.fail('TOO_LATE', 'Sign-up closed when it started.'); end if;
    if (select waiver_signed_at from public.clients where id = v.client_id) is null then
      perform app.fail('WAIVER_REQUIRED', 'Please complete your waiver and health form before booking.');
    end if;
    perform app.ap_release_holds(v.studio);
    if exists (select 1 from public.studio_event_registrations where event_id = e.id and client_id = v.client_id and status in ('registered', 'pending_payment')) then
      perform app.fail('ALREADY_BOOKED', 'You''re already registered.');
    end if;
    select count(*) into v_taken from public.studio_event_registrations where event_id = e.id and status in ('registered', 'pending_payment');
    if v_taken >= e.capacity then perform app.fail('EVENT_FULL', 'Sorry, that one is full.'); end if;
    v_title := e.title; v_amount := e.price_cents;
    insert into public.studio_event_registrations (studio_id, event_id, client_id, status, pay_method, amount_cents, hold_expires_at)
    values (v.studio, e.id, v.client_id, 'pending_payment', 'card_online', v_amount, v_exp)
    returning id into v_reg;
  end if;

  insert into public.appointment_orders (studio_id, client_id, kind, appointment_id, registration_id, pack_id, title, amount_cents, expires_at)
  values (v.studio, v.client_id, p_kind, v_appt, v_reg, case when p_kind = 'pack' then pk.id end, v_title, v_amount, v_exp)
  returning id into v_order;
  return jsonb_build_object('orderId', v_order, 'clientId', v.client_id, 'studioId', v.studio, 'kind', p_kind, 'title', v_title,
                            'amountCents', v_amount, 'expiresAt', app.ap_iso(v_exp),
                            'currency', (select lower(currency) from public.studios where id = v.studio),
                            'studioName', (select name from public.studios where id = v.studio));
end $$;

create or replace function public.appointments_attach_checkout(p_order_id uuid, p_session_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Orders are updated by the payment system.'); end if;
  perform app.assert_in_studio('appointment_orders', p_order_id, 'We couldn''t find that order.');
  update public.appointment_orders set stripe_checkout_session_id = p_session_id where id = p_order_id;
end $$;

create or replace function public.appointments_complete_order(
  p_order_id uuid, p_session_id text default null, p_payment_intent_id text default null, p_amount_cents int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.appointment_orders;
  pk public.appointment_packs;
  v_sale uuid;
  v_credit uuid;
  v_total int;
  v_ok boolean := true;
  v_result jsonb;
  v_cap int; v_taken int;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Orders are completed by the payment system.'); end if;
  perform app.assert_in_studio('appointment_orders', p_order_id, 'We couldn''t find that order.');
  select * into o from public.appointment_orders where id = p_order_id for update;
  if o.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that order.'); end if;
  if o.status = 'paid' then return o.result; end if;   -- Stripe can send the same event twice
  perform app.use_studio(o.studio_id);
  v_total := coalesce(p_amount_cents, o.amount_cents);

  if o.kind = 'pack' then
    select * into pk from public.appointment_packs where id = o.pack_id;
    v_sale := app.ap_make_sale(o.studio_id, o.client_id, null, o.title, 1, v_total, 'card_online', 'Appointment pack', coalesce(p_session_id, o.stripe_checkout_session_id), p_payment_intent_id, v_total);
    insert into public.appointment_credits (studio_id, client_id, pack_id, name, credits_total, validity_days, type_ids, sale_id)
    values (o.studio_id, o.client_id, pk.id, o.title, pk.credits, pk.validity_days, pk.type_ids, v_sale) returning id into v_credit;
    v_result := jsonb_build_object('kind', 'pack', 'creditId', v_credit, 'saleId', v_sale);

  elsif o.kind = 'appointment' then
    v_sale := app.ap_make_sale(o.studio_id, o.client_id, null,
                               (select case when people = 2 then type_name || ' (2 people)' else type_name end from public.appointments where id = o.appointment_id),
                               (select people from public.appointments where id = o.appointment_id),
                               (select amount_cents / people from public.appointments where id = o.appointment_id),
                               'card_online', 'Appointment', coalesce(p_session_id, o.stripe_checkout_session_id), p_payment_intent_id, v_total);
    begin
      update public.appointments set status = 'booked', sale_id = v_sale, amount_cents = v_total, hold_expires_at = null, cancelled_at = null
       where id = o.appointment_id and status in ('pending_payment', 'cancelled');
      if not found then v_ok := false; end if;
    exception when unique_violation then
      v_ok := false;   -- the hold lapsed and someone else booked the slot
    end;
    if not v_ok then
      update public.appointments set sale_id = v_sale, amount_cents = v_total, refund_due = true, status = 'cancelled',
             cancelled_at = coalesce(cancelled_at, app.now()), hold_expires_at = null
       where id = o.appointment_id;
    end if;
    v_result := jsonb_build_object('kind', 'appointment', 'appointmentId', o.appointment_id, 'saleId', v_sale, 'booked', v_ok);

  else
    v_sale := app.ap_make_sale(o.studio_id, o.client_id, null, o.title, 1, v_total, 'card_online',
                               (select case when e.kind = 'course' then 'Course' else 'Workshop / event' end
                                  from public.studio_events e join public.studio_event_registrations r on r.event_id = e.id where r.id = o.registration_id),
                               coalesce(p_session_id, o.stripe_checkout_session_id), p_payment_intent_id, v_total);
    select e.capacity, (select count(*) from public.studio_event_registrations x where x.event_id = e.id and x.status = 'registered' and x.id <> o.registration_id)
      into v_cap, v_taken
      from public.studio_events e join public.studio_event_registrations r on r.event_id = e.id
     where r.id = o.registration_id and not e.cancelled
       for update of e;
    v_ok := v_cap is not null and v_taken < v_cap
            and exists (select 1 from public.studio_event_registrations where id = o.registration_id and status in ('pending_payment', 'cancelled'));
    if v_ok then
      update public.studio_event_registrations set status = 'registered', sale_id = v_sale, amount_cents = v_total, hold_expires_at = null, cancelled_at = null
       where id = o.registration_id;
    else
      update public.studio_event_registrations set sale_id = v_sale, amount_cents = v_total, refund_due = true, hold_expires_at = null,
             status = case when status = 'registered' then status else 'cancelled' end, cancelled_at = coalesce(cancelled_at, app.now())
       where id = o.registration_id;
    end if;
    v_result := jsonb_build_object('kind', 'event', 'registrationId', o.registration_id, 'saleId', v_sale, 'booked', v_ok);
  end if;

  update public.appointment_orders
     set status = 'paid', completed_at = app.now(), result = v_result, stripe_payment_intent_id = p_payment_intent_id,
         stripe_checkout_session_id = coalesce(p_session_id, stripe_checkout_session_id)
   where id = o.id;
  return v_result;
end $$;

-- Checkout abandoned / expired: let the slot go now rather than waiting for the hold to lapse.
create or replace function public.appointments_expire_order(p_order_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.appointment_orders;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Orders are updated by the payment system.'); end if;
  perform app.assert_in_studio('appointment_orders', p_order_id, 'We couldn''t find that order.');
  select * into o from public.appointment_orders where id = p_order_id for update;
  if o.id is null or o.status <> 'pending' then return; end if;
  update public.appointment_orders set status = 'expired' where id = o.id;
  update public.appointments set status = 'cancelled', cancelled_at = app.now() where id = o.appointment_id and status = 'pending_payment';
  update public.studio_event_registrations set status = 'cancelled', cancelled_at = app.now() where id = o.registration_id and status = 'pending_payment';
end $$;

-- Cron / housekeeping (service role): lapse every studio's expired holds. Bookings also do this for their own studio.
create or replace function public.appointments_release_holds() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s uuid;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'This runs on a schedule.'); end if;
  for s in select id from public.studios loop
    perform app.use_studio(s);
    perform app.ap_release_holds(s);
  end loop;
  perform app.use_studio(null);
end $$;

-- Our app.ap_* helpers are internal: only the security-definer RPCs (and the service role) call them.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname like 'ap\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

revoke execute on function public.appointments_hold_order, public.appointments_attach_checkout, public.appointments_complete_order,
  public.appointments_expire_order, public.appointments_release_holds from public, anon;
revoke execute on function public.appointments_attach_checkout, public.appointments_complete_order, public.appointments_expire_order,
  public.appointments_release_holds from authenticated;
grant execute on function public.appointments_hold_order to authenticated;
grant execute on all functions in schema public to service_role;
