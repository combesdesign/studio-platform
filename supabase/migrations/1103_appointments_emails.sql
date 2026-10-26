-- Appointments: confirmation, cancellation and reminder emails.
-- Same shape as commerce_outbox / payroll_outbox: a studio-scoped outbox, claimed with SKIP LOCKED by the send-email edge function
-- (_shared/email.ts › drainFeatureOutboxes), which sends each email as its own studio. Rows are queued by triggers on the
-- appointments and registrations tables (so every path that books or cancels is covered: the RPCs, the Stripe webhook, staff), and
-- by appointments_queue_reminders() for "see you tomorrow" emails.

create table public.appointments_outbox (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  kind text not null check (kind in ('appointment_confirmed', 'appointment_cancelled', 'appointment_reminder',
                                     'event_registered', 'event_cancelled', 'event_reminder')),
  client_id uuid,
  to_email text,
  payload jsonb not null default '{}'::jsonb,
  -- one email per thing per kind (a reminder is queued once even if the sweep runs every few minutes)
  dedupe_key text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  error text,
  claimed_at timestamptz,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
select app.scope_table('appointments_outbox');
create unique index appointments_outbox_dedupe on public.appointments_outbox (studio_id, dedupe_key) where dedupe_key is not null;
create index appointments_outbox_pending_idx on public.appointments_outbox (created_at) where sent_at is null;
create policy appointments_outbox_read on public.appointments_outbox for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.appointments_outbox to authenticated;
revoke insert, update, delete on public.appointments_outbox from anon, authenticated;
grant all on public.appointments_outbox to service_role;

-- ----------------------------------------------------------------------------- queueing

-- The fields every appointment email shares. The studio's own name, colours and address are added when it is sent.
create or replace function app.ap_queue_appointment(p_appt_id uuid, p_kind text, p_dedupe text default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n int;
begin
  select a.id, a.studio_id, a.client_id, a.starts_at, a.ends_at, a.type_name, a.people, a.note, a.status, a.pay_method, a.amount_cents,
         c.email, c.first_name, st.name as staff_name, sd.timezone, ss.cancellation_policy_text, ss.cancel_window_hours
    into r
    from public.appointments a
    join public.clients c on c.id = a.client_id
    join public.studios sd on sd.id = a.studio_id
    left join public.staff st on st.id = a.staff_id
    left join public.studio_settings ss on ss.studio_id = a.studio_id
   where a.id = p_appt_id;
  if r.id is null or coalesce(r.email, '') = '' then return false; end if;
  insert into public.appointments_outbox (studio_id, kind, client_id, to_email, dedupe_key, payload)
  values (r.studio_id, p_kind, r.client_id, r.email, p_dedupe, jsonb_strip_nulls(jsonb_build_object(
    'appointment_id', r.id, 'first_name', r.first_name, 'title', r.type_name, 'starts_at', r.starts_at,
    'when', app.fmt_when_tz(r.starts_at, r.timezone), 'staff', r.staff_name, 'people', r.people, 'note', r.note,
    'cancellation_policy', r.cancellation_policy_text, 'cancel_window_hours', r.cancel_window_hours,
    'late', r.status = 'late_cancelled',
    'credit_returned', r.status = 'cancelled' and r.pay_method = 'pack',
    'refund_due', r.status = 'cancelled' and r.pay_method <> 'pack' and r.amount_cents > 0,
    'amount_cents', r.amount_cents, 'paid_by', r.pay_method)))
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function app.ap_queue_registration(p_reg_id uuid, p_kind text, p_dedupe text default null, p_session timestamptz default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n int;
begin
  select g.id, g.studio_id, g.client_id, g.status, g.amount_cents, g.refund_due, c.email, c.first_name,
         e.title, e.kind as event_kind, e.location, e.cancel_reason, e.cancelled, e.refund_cutoff_hours,
         sd.timezone, ss.cancellation_policy_text,
         (select count(*) from public.studio_event_sessions s where s.event_id = e.id) as session_count,
         (select min(s.starts_at) from public.studio_event_sessions s where s.event_id = e.id) as first_at
    into r
    from public.studio_event_registrations g
    join public.studio_events e on e.id = g.event_id
    join public.clients c on c.id = g.client_id
    join public.studios sd on sd.id = g.studio_id
    left join public.studio_settings ss on ss.studio_id = g.studio_id
   where g.id = p_reg_id;
  if r.id is null or coalesce(r.email, '') = '' then return false; end if;
  insert into public.appointments_outbox (studio_id, kind, client_id, to_email, dedupe_key, payload)
  values (r.studio_id, p_kind, r.client_id, r.email, p_dedupe, jsonb_strip_nulls(jsonb_build_object(
    'registration_id', r.id, 'first_name', r.first_name, 'title', r.title, 'event_kind', r.event_kind, 'location', r.location,
    'starts_at', coalesce(p_session, r.first_at), 'when', app.fmt_when_tz(coalesce(p_session, r.first_at), r.timezone),
    'sessions', r.session_count, 'amount_cents', r.amount_cents,
    'cancellation_policy', r.cancellation_policy_text, 'refund_cutoff_hours', r.refund_cutoff_hours,
    'late', r.status = 'late_cancelled', 'refund_due', coalesce(r.refund_due, false),
    'cancelled_by_studio', coalesce(r.cancelled, false), 'reason', case when r.cancelled then r.cancel_reason end)))
  on conflict (studio_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function app.ap_appt_email_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'booked' then perform app.ap_queue_appointment(new.id, 'appointment_confirmed', 'confirmed:' || new.id); end if;
  elsif old.status is distinct from new.status then
    if new.status = 'booked' and old.status = 'pending_payment' then
      perform app.ap_queue_appointment(new.id, 'appointment_confirmed', 'confirmed:' || new.id);
    elsif new.status in ('cancelled', 'late_cancelled') and old.status = 'booked' then
      perform app.ap_queue_appointment(new.id, 'appointment_cancelled', 'cancelled:' || new.id);
    end if;
  end if;
  return null;
end $$;
create trigger ap_appt_email after insert or update of status on public.appointments
  for each row execute function app.ap_appt_email_trigger();

create or replace function app.ap_reg_email_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'registered' then perform app.ap_queue_registration(new.id, 'event_registered', 'registered:' || new.id); end if;
  elsif old.status is distinct from new.status then
    if new.status = 'registered' and old.status = 'pending_payment' then
      perform app.ap_queue_registration(new.id, 'event_registered', 'registered:' || new.id);
    elsif new.status in ('cancelled', 'late_cancelled') and old.status = 'registered' then
      perform app.ap_queue_registration(new.id, 'event_cancelled', 'cancelled:' || new.id);
    end if;
  end if;
  return null;
end $$;
create trigger ap_reg_email after insert or update of status, refund_due on public.studio_event_registrations
  for each row execute function app.ap_reg_email_trigger();

-- ----------------------------------------------------------------------------- reminders

-- Queue "see you soon" emails for appointments and event sessions starting within the next p_hours (each queued once).
-- Called by the drain every few minutes, for every studio.
create or replace function public.appointments_queue_reminders(p_hours numeric default 24) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; r record; v_now timestamptz := app.now(); n int := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for s in select id from public.studios where status <> 'suspended' loop
    perform app.use_studio(s.id);
    for r in select a.id from public.appointments a
              where a.studio_id = s.id and a.status = 'booked' and a.starts_at > v_now and a.starts_at <= v_now + make_interval(secs => p_hours * 3600)
    loop
      if app.ap_queue_appointment(r.id, 'appointment_reminder', 'reminder:' || r.id) then n := n + 1; end if;
    end loop;
    for r in select g.id, es.starts_at from public.studio_event_registrations g
              join public.studio_event_sessions es on es.event_id = g.event_id
              join public.studio_events e on e.id = g.event_id
              where g.studio_id = s.id and g.status = 'registered' and not e.cancelled
                and es.starts_at > v_now and es.starts_at <= v_now + make_interval(secs => p_hours * 3600)
    loop
      if app.ap_queue_registration(r.id, 'event_reminder', 'reminder:' || r.id || ':' || extract(epoch from r.starts_at)::bigint, r.starts_at) then n := n + 1; end if;
    end loop;
  end loop;
  perform app.use_studio(null);
  return n;
end $$;

-- ----------------------------------------------------------------------------- draining (service role only)

create or replace function public.appointments_claim_outbox(p_limit integer default 25) returns setof public.appointments_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  return query
  update public.appointments_outbox o
     set claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from public.appointments_outbox
      where sent_at is null and attempts < 5
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      order by created_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning o.*;
end $$;

create or replace function public.appointments_finish_outbox(p_id uuid, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Email sender only.'); end if;
  update public.appointments_outbox set sent_at = case when p_error is null then now() end, error = p_error where id = p_id;
end $$;

revoke execute on function public.appointments_queue_reminders(numeric), public.appointments_claim_outbox(integer), public.appointments_finish_outbox(uuid, text)
  from public, anon, authenticated;
grant execute on function public.appointments_queue_reminders(numeric), public.appointments_claim_outbox(integer), public.appointments_finish_outbox(uuid, text) to service_role;
