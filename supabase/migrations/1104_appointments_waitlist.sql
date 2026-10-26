-- Appointments: a waitlist for full workshops, courses and events.
--
-- A client joins the line for an event that is full. When a place opens (someone cancels, a hold lapses, the studio adds places) the
-- first person waiting is OFFERED it: the place is held for them for the studio's claim window (appointment_settings.waitlist_claim_hours,
-- never past the start of the event) and they get an email through appointments_outbox. They claim it the way anyone signs up: free
-- events by registering, paid events by paying (Stripe Checkout). Their own offer never counts against them. If they don't claim in time
-- the offer lapses and the next person is offered it.
--
-- Nothing here is a cron-only thing: app.ap_waitlist_advance() runs from triggers on registrations / events (so every path that frees or
-- takes a place is covered), and appointments_waitlist_sweep() (called by the email drain every few minutes) lapses offers by the clock.

-- ----------------------------------------------------------------------------- settings: the claim window
alter table public.appointment_settings
  add column waitlist_claim_hours integer not null default 12 check (waitlist_claim_hours between 1 and 72);

create or replace function app.ap_settings(p_studio uuid) returns public.appointment_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select s from public.appointment_settings s where s.studio_id = p_studio),
    row(p_studio, 30, 4, 28, 12)::public.appointment_settings)
$$;

drop function public.appointments_update_settings(int, int, int);
create or replace function public.appointments_update_settings(
  p_slot_step_min int, p_min_notice_hours int, p_horizon_days int, p_waitlist_claim_hours int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t := app.ap_actor(); v_claim int;
begin
  perform app.ap_require(v, 'manage');
  v_claim := coalesce(p_waitlist_claim_hours, (app.ap_settings(v.studio)).waitlist_claim_hours);
  if not (p_slot_step_min between 5 and 120) then perform app.fail('INVALID', 'Slots can start every 5 to 120 minutes.'); end if;
  if not (p_min_notice_hours between 0 and 336) then perform app.fail('INVALID', 'Minimum notice can be 0 to 336 hours.'); end if;
  if not (p_horizon_days between 1 and 365) then perform app.fail('INVALID', 'Clients can book 1 to 365 days ahead.'); end if;
  if not (v_claim between 1 and 72) then perform app.fail('INVALID', 'A waitlist offer can be open for 1 to 72 hours.'); end if;
  insert into public.appointment_settings (studio_id, slot_step_min, min_notice_hours, horizon_days, waitlist_claim_hours)
  values (v.studio, p_slot_step_min, p_min_notice_hours, p_horizon_days, v_claim)
  on conflict (studio_id) do update set slot_step_min = excluded.slot_step_min, min_notice_hours = excluded.min_notice_hours,
    horizon_days = excluded.horizon_days, waitlist_claim_hours = excluded.waitlist_claim_hours;
  return jsonb_build_object('slotStepMin', p_slot_step_min, 'minNoticeHours', p_min_notice_hours, 'horizonDays', p_horizon_days, 'waitlistClaimHours', v_claim);
end $$;

-- ----------------------------------------------------------------------------- the waitlist
create table public.studio_event_waitlist (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  event_id uuid not null,
  client_id uuid not null,
  -- waiting = in line; offered = a place is held until offer_expires_at; claimed = they took it; expired = didn't claim in time
  -- (or the event closed); left = they (or the front desk) took them off
  status text not null default 'waiting' check (status in ('waiting', 'offered', 'claimed', 'expired', 'left')),
  created_at timestamptz not null default app.now(),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  foreign key (studio_id, event_id) references public.studio_events (studio_id, id) on delete cascade,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
create unique index studio_event_waitlist_one_active on public.studio_event_waitlist (event_id, client_id) where status in ('waiting', 'offered');
create index studio_event_waitlist_line_idx on public.studio_event_waitlist (event_id, created_at, id) where status in ('waiting', 'offered');
create index studio_event_waitlist_client_idx on public.studio_event_waitlist (client_id);
select app.scope_table('studio_event_waitlist');

-- your own place in line; the front desk and above; the host of the event. Writes: RPCs and triggers only.
create policy waitlist_read on public.studio_event_waitlist for select to authenticated
  using (client_id = app.client_id_in(studio_id)
         or app.has_role_in(studio_id, 'owner', 'manager', 'front_desk')
         or exists (select 1 from public.studio_events e where e.id = event_id and e.host_staff_id = app.staff_id_in(studio_id)));
revoke all on public.studio_event_waitlist from anon;
revoke insert, update, delete on public.studio_event_waitlist from authenticated;
grant select on public.studio_event_waitlist to authenticated;
grant all on public.studio_event_waitlist to service_role;

-- ----------------------------------------------------------------------------- emails: the offer
alter table public.appointments_outbox drop constraint appointments_outbox_kind_check;
alter table public.appointments_outbox add constraint appointments_outbox_kind_check
  check (kind in ('appointment_confirmed', 'appointment_cancelled', 'appointment_reminder',
                  'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer'));

create or replace function app.ap_queue_waitlist_offer(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n int;
begin
  select w.id, w.studio_id, w.client_id, w.offer_expires_at, c.email, c.first_name,
         e.id as event_id, e.title, e.kind as event_kind, e.location, e.price_cents, e.refund_cutoff_hours,
         sd.timezone, ss.cancellation_policy_text,
         (select count(*) from public.studio_event_sessions s where s.event_id = e.id) as session_count,
         (select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id) as first_at
    into r
    from public.studio_event_waitlist w
    join public.studio_events e on e.id = w.event_id
    join public.clients c on c.id = w.client_id
    join public.studios sd on sd.id = w.studio_id
    left join public.studio_settings ss on ss.studio_id = w.studio_id
   where w.id = p_id;
  if r.id is null or coalesce(r.email, '') = '' then return false; end if;
  insert into public.appointments_outbox (studio_id, kind, client_id, to_email, dedupe_key, payload)
  values (r.studio_id, 'waitlist_offer', r.client_id, r.email, 'waitlist:' || r.id, jsonb_strip_nulls(jsonb_build_object(
    'waitlist_id', r.id, 'event_id', r.event_id, 'first_name', r.first_name, 'title', r.title, 'event_kind', r.event_kind, 'location', r.location,
    'starts_at', r.first_at, 'when', app.fmt_when_tz(r.first_at, r.timezone), 'sessions', r.session_count, 'amount_cents', r.price_cents,
    'claim_by', app.fmt_when_tz(r.offer_expires_at, r.timezone), 'claim_by_at', r.offer_expires_at,
    'cancellation_policy', r.cancellation_policy_text, 'refund_cutoff_hours', r.refund_cutoff_hours)))
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- ----------------------------------------------------------------------------- places and offers

-- Places nobody has and nobody is being held for. p_client's own live offer isn't held against them.
create or replace function app.ap_event_free(p_event uuid, p_client uuid default null) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(0, e.capacity
    - (select count(*) from public.studio_event_registrations r where r.event_id = e.id and r.status in ('registered', 'pending_payment'))
    - (select count(*) from public.studio_event_waitlist w
        where w.event_id = e.id and w.status = 'offered' and w.offer_expires_at > app.now() and w.client_id is distinct from p_client
          and not exists (select 1 from public.studio_event_registrations r
                           where r.event_id = w.event_id and r.client_id = w.client_id and r.status in ('registered', 'pending_payment'))))::int
    from public.studio_events e where e.id = p_event
$$;

-- Let lapsed offers go and offer free places to whoever is next (planWaitlist() in logic.ts is the same rule, kept in step by tests).
--  * event cancelled, or its first session has started: everyone in line is let go
--  * an offer past its window lapses (unless they are part-way through paying)
--  * each free place goes to the next person waiting, first come first served; the offer lasts the claim window but never past the start
create or replace function app.ap_waitlist_advance(p_event uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.studio_events; v_now timestamptz := app.now(); v_start timestamptz; v_hours int; v_free int; w record; v_exp timestamptz;
begin
  select * into e from public.studio_events where id = p_event;
  if e.id is null then return; end if;
  if not exists (select 1 from public.studio_event_waitlist where event_id = p_event and status in ('waiting', 'offered')) then return; end if;
  perform 1 from public.studio_events where id = p_event for update;   -- one at a time per event
  select min(starts_at) into v_start from public.studio_event_sessions where event_id = p_event;
  if e.cancelled or v_start is null or v_now >= v_start then
    update public.studio_event_waitlist set status = 'expired', offer_expires_at = null where event_id = p_event and status in ('waiting', 'offered');
    return;
  end if;
  update public.studio_event_waitlist x set status = 'expired', offer_expires_at = null
   where x.event_id = p_event and x.status = 'offered' and x.offer_expires_at <= v_now
     and not exists (select 1 from public.studio_event_registrations r where r.event_id = x.event_id and r.client_id = x.client_id and r.status = 'pending_payment');
  v_hours := (app.ap_settings(e.studio_id)).waitlist_claim_hours;
  v_free := app.ap_event_free(p_event, null);
  for w in select id, client_id from public.studio_event_waitlist where event_id = p_event and status = 'waiting' order by created_at, id loop
    exit when v_free <= 0;
    if exists (select 1 from public.studio_event_registrations r where r.event_id = p_event and r.client_id = w.client_id and r.status in ('registered', 'pending_payment')) then
      update public.studio_event_waitlist set status = 'claimed' where id = w.id;   -- they got in another way
      continue;
    end if;
    v_exp := least(v_now + make_interval(hours => v_hours), v_start);
    update public.studio_event_waitlist set status = 'offered', offered_at = v_now, offer_expires_at = v_exp where id = w.id;
    perform app.ap_queue_waitlist_offer(w.id);
    v_free := v_free - 1;
  end loop;
end $$;

-- A new sign-up (or paid hold) can't take a place that is being held for someone's offer.
create or replace function app.ap_reg_capacity_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status not in ('registered', 'pending_payment') then return new; end if;
  perform 1 from public.studio_events where id = new.event_id for update;
  perform app.ap_waitlist_advance(new.event_id);   -- lapse old offers first, so the next person in line gets their turn before a newcomer
  if app.ap_event_free(new.event_id, new.client_id) <= 0 then perform app.fail('EVENT_FULL', 'Sorry, that one is full.'); end if;
  return new;
end $$;
create trigger ap_reg_capacity before insert on public.studio_event_registrations
  for each row execute function app.ap_reg_capacity_trigger();

create or replace function app.ap_reg_waitlist_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'registered' and (tg_op = 'INSERT' or old.status is distinct from 'registered') then
    -- they have a place now: their turn in line is done
    update public.studio_event_waitlist set status = 'claimed', offer_expires_at = null
     where event_id = new.event_id and client_id = new.client_id and status in ('waiting', 'offered');
  elsif tg_op = 'UPDATE' and old.status in ('registered', 'pending_payment') and new.status in ('cancelled', 'late_cancelled') then
    perform app.ap_waitlist_advance(new.event_id);   -- a place opened
  end if;
  return null;
end $$;
create trigger ap_reg_waitlist after insert or update of status on public.studio_event_registrations
  for each row execute function app.ap_reg_waitlist_trigger();

create or replace function app.ap_event_waitlist_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.ap_waitlist_advance(new.id);   -- more places, or the event was cancelled
  return null;
end $$;
create trigger ap_event_waitlist after update of capacity, cancelled on public.studio_events
  for each row execute function app.ap_event_waitlist_trigger();

-- ----------------------------------------------------------------------------- JSON

create or replace function app.ap_wait_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', w.id, 'eventId', w.event_id, 'eventTitle', e.title, 'clientId', w.client_id,
    'clientName', coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'Client'),
    'status', w.status,
    'position', greatest(1, (select count(*) from public.studio_event_waitlist x
                              where x.event_id = w.event_id and x.status in ('waiting', 'offered') and (x.created_at, x.id) <= (w.created_at, w.id))),
    'joinedAt', app.ap_iso(w.created_at),
    'offeredAt', case when w.offered_at is not null then app.ap_iso(w.offered_at) end,
    'offerExpiresAt', case when w.status = 'offered' then app.ap_iso(w.offer_expires_at) end))
  from public.studio_event_waitlist w
  join public.studio_events e on e.id = w.event_id
  left join public.clients c on c.id = w.client_id
  where w.id = p_id
$$;

-- ap_event_json again: spotsLeft leaves out places held for offers, and the line is included.
create or replace function app.ap_event_json(p_id uuid, p_client uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', e.id, 'kind', e.kind, 'title', e.title, 'description', e.description, 'imageUrl', e.image_url, 'priceCents', e.price_cents,
    'capacity', e.capacity, 'hostStaffId', e.host_staff_id, 'location', e.location, 'published', e.published,
    'cancelled', case when e.cancelled then true end, 'cancelReason', e.cancel_reason, 'refundCutoffHours', e.refund_cutoff_hours,
    'createdAt', app.ap_iso(e.created_at),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('startsAt', app.ap_iso(s.starts_at), 'endsAt', app.ap_iso(s.ends_at)) order by s.starts_at)
                            from public.studio_event_sessions s where s.event_id = e.id), '[]'::jsonb),
    'registered', n.reg,
    'spotsLeft', greatest(0, e.capacity - n.reg - n.held - n.offered),
    'waitlisted', n.line,
    'mine', case when p_client is not null then
              (select app.ap_reg_json(r.id) from public.studio_event_registrations r
                where r.event_id = e.id and r.client_id = p_client and r.status = 'registered' limit 1) end,
    'myWaitlist', case when p_client is not null then
              (select app.ap_wait_json(w.id) from public.studio_event_waitlist w
                where w.event_id = e.id and w.client_id = p_client and w.status in ('waiting', 'offered') limit 1) end))
  from public.studio_events e
  cross join lateral (
    select count(*) filter (where r.status = 'registered')::int as reg,
           count(*) filter (where r.status = 'pending_payment' and r.hold_expires_at > app.now())::int as held,
           (select count(*) from public.studio_event_waitlist w
             where w.event_id = e.id and w.status = 'offered' and w.offer_expires_at > app.now()
               and not exists (select 1 from public.studio_event_registrations x
                                where x.event_id = w.event_id and x.client_id = w.client_id and x.status in ('registered', 'pending_payment')))::int as offered,
           (select count(*) from public.studio_event_waitlist w where w.event_id = e.id and w.status in ('waiting', 'offered'))::int as line
      from public.studio_event_registrations r where r.event_id = e.id) n
  where e.id = p_id
$$;

-- ----------------------------------------------------------------------------- RPCs

create or replace function public.appointments_join_waitlist(p_event_id uuid, p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v app.ap_actor_t := app.ap_actor(p_client_id);
  v_client uuid; e public.studio_events; v_start timestamptz; v_id uuid;
begin
  perform app.assert_in_studio('studio_events', p_event_id, 'We couldn''t find that event.');
  perform app.assert_studio_open(v.studio);
  v_client := app.ap_resolve_client(v, p_client_id, 'join the waitlist');
  select * into e from public.studio_events where id = p_event_id and studio_id = v.studio for update;
  if e.id is null or e.cancelled or (not v.as_staff and not e.published) then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
  select min(starts_at) into v_start from public.studio_event_sessions where event_id = e.id;
  if app.now() >= v_start then perform app.fail('TOO_LATE', 'Sign-up closed when it started.'); end if;
  perform app.ap_release_holds(v.studio);
  perform app.ap_waitlist_advance(e.id);
  if exists (select 1 from public.studio_event_registrations where event_id = e.id and client_id = v_client and status in ('registered', 'pending_payment')) then
    perform app.fail('ALREADY_BOOKED', 'You''re already registered.');
  end if;
  if exists (select 1 from public.studio_event_waitlist where event_id = e.id and client_id = v_client and status in ('waiting', 'offered')) then
    perform app.fail('ALREADY_BOOKED', 'You''re already on the waitlist.');
  end if;
  if app.ap_event_free(e.id, null) > 0 then perform app.fail('NOT_FULL', 'There are places left, so you can sign up now.'); end if;
  if not v.as_staff and (select waiver_signed_at from public.clients where id = v_client) is null then
    perform app.fail('WAIVER_REQUIRED', 'Please complete your waiver and health form before booking.');
  end if;
  insert into public.studio_event_waitlist (studio_id, event_id, client_id) values (v.studio, e.id, v_client) returning id into v_id;
  return app.ap_wait_json(v_id);
end $$;

create or replace function public.appointments_leave_waitlist(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v app.ap_actor_t; w public.studio_event_waitlist;
begin
  perform app.assert_in_studio('studio_event_waitlist', p_id, 'We couldn''t find that waitlist spot.');
  select * into w from public.studio_event_waitlist where id = p_id for update;
  if w.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that waitlist spot.'); end if;
  v := app.ap_actor(w.client_id);
  if not v.as_staff then
    if w.client_id <> v.client_id and not app.is_guardian_of(w.client_id) then perform app.fail('NOT_FOUND', 'We couldn''t find that waitlist spot.'); end if;
  else
    perform app.ap_require(v, 'book');
  end if;
  if w.status not in ('waiting', 'offered') then return; end if;
  update public.studio_event_waitlist set status = 'left', offer_expires_at = null where id = w.id;
  perform app.ap_waitlist_advance(w.event_id);   -- an offer given back goes to the next in line
end $$;

-- An event's line (the host and the front desk) or a client's own places in line (their family's too).
create or replace function public.appointments_list_waitlist(p_client_id uuid default null, p_event_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
-- an event's line is for staff: someone who is staff and also a client acts as staff here (an unmatched client id says so)
declare v app.ap_actor_t := app.ap_actor(case when p_event_id is not null then gen_random_uuid() else p_client_id end); e public.studio_events; v_client uuid;
begin
  if p_event_id is not null then
    if not v.as_staff then perform app.fail('NOT_ALLOWED', 'Only staff can see the waitlist.'); end if;
    perform app.assert_in_studio('studio_events', p_event_id, 'We couldn''t find that event.');
    select * into e from public.studio_events where id = p_event_id and studio_id = v.studio;
    if e.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that event.'); end if;
    if not app.ap_can(v, 'book') and e.host_staff_id is distinct from v.staff_id then
      perform app.fail('NOT_ALLOWED', 'Only the host and the front desk can see the waitlist.');
    end if;
    perform app.ap_release_holds(v.studio);
    perform app.ap_waitlist_advance(p_event_id);
    return coalesce((select jsonb_agg(app.ap_wait_json(w.id) order by w.created_at, w.id)
                       from public.studio_event_waitlist w where w.event_id = p_event_id and w.status in ('waiting', 'offered')), '[]'::jsonb);
  end if;
  v_client := case when v.as_staff then p_client_id else v.client_id end;
  if v_client is null then perform app.fail('INVALID', 'Choose a client.'); end if;
  if not v.as_staff and p_client_id is not null and p_client_id <> v.client_id and not app.is_guardian_of(p_client_id) then
    perform app.fail('NOT_ALLOWED', 'You can only see your own waitlist spots.');
  end if;
  return coalesce((select jsonb_agg(app.ap_wait_json(w.id) order by w.created_at, w.id)
                     from public.studio_event_waitlist w
                    where w.studio_id = v.studio and w.status in ('waiting', 'offered')
                      and (w.client_id = v_client or (not v.as_staff and v_client = v.client_id and app.is_guardian_of(w.client_id)))), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- the clock (service role, from the email drain)

-- Lapse holds and offers by the clock and offer places on, for every studio. Safe to run every few minutes.
create or replace function public.appointments_waitlist_sweep() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; ev uuid; n int := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for s in select id from public.studios where status <> 'suspended' loop
    perform app.use_studio(s.id);
    perform app.ap_release_holds(s.id);
    for ev in select distinct event_id from public.studio_event_waitlist where studio_id = s.id and status in ('waiting', 'offered') loop
      perform app.ap_waitlist_advance(ev);
      n := n + 1;
    end loop;
  end loop;
  perform app.use_studio(null);
  return n;
end $$;

-- ----------------------------------------------------------------------------- grants
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

revoke execute on function public.appointments_update_settings, public.appointments_join_waitlist, public.appointments_leave_waitlist,
  public.appointments_list_waitlist, public.appointments_waitlist_sweep from public, anon;
revoke execute on function public.appointments_waitlist_sweep from authenticated;
grant execute on function public.appointments_update_settings, public.appointments_join_waitlist, public.appointments_leave_waitlist,
  public.appointments_list_waitlist to authenticated;
grant execute on all functions in schema public to service_role;
