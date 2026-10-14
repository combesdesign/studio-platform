-- =============================================================================
-- Matches the demo store's behaviour (see NOTES.md, engine section):
--   * pausing a membership cancels its bookings inside the pause (credit back)
--   * cancelling a membership cancels its bookings on/after the end date
--   * refunding with "cancel pass" cancels that pass's upcoming bookings
--   * adjust_pass can't take credits below what's already been used
-- Plus "register interest" for coming-soon classes (client app asks for it).
-- =============================================================================

-- Cancel this pass's 'booked' bookings for classes starting in [p_from, p_to). Credits back,
-- waitlists get a chance at the freed spots. Returns how many were cancelled.
create or replace function app.cancel_pass_bookings(p_pass_id uuid, p_from timestamptz, p_to timestamptz default 'infinity')
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select b.id, b.session_id from public.bookings b join public.class_sessions s on s.id = b.session_id
            where b.pass_id = p_pass_id and b.status = 'booked' and s.starts_at >= p_from and s.starts_at < p_to
            order by s.id
  loop
    update public.bookings set status = 'cancelled', cancelled_at = app.now() where id = r.id;
    perform app.return_credit(p_pass_id);
    perform app.promote_waitlist(r.session_id, app.now());
    n := n + 1;
  end loop;
  return n;
end $$;

-- pause: same as before, plus cancel bookings inside the pause
create or replace function public.pause_pass(p_pass_id uuid, p_from date, p_until date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true); v_today date := app.local_date(app.now()); v_tz text := app.tz();
begin
  if p.kind <> 'membership' and not (app.is_privileged() or public.is_staff()) then
    perform app.fail('INVALID', 'Only memberships can be paused.');
  end if;
  if p.status not in ('active','paused') then perform app.fail('INVALID', 'This pass isn''t active.'); end if;
  if p_from is null or p_until is null or p_until < p_from + 6 then
    perform app.fail('INVALID', 'A pause needs to be at least 1 week.');
  end if;
  if p_from < v_today and not (app.is_privileged() or public.is_staff()) then
    perform app.fail('INVALID', 'A pause can''t start in the past.');
  end if;
  update public.passes set paused_from = p_from, paused_until = p_until,
         status = case when p_from <= v_today then 'paused' else 'active' end
   where id = p.id;
  perform app.cancel_pass_bookings(p.id, (p_from::timestamp) at time zone v_tz, ((p_until + 1)::timestamp) at time zone v_tz);
  perform app.audit('pause_pass', 'passes', p.id::text, jsonb_build_object('from', p_from, 'until', p_until));
  return app.pass_json(p.id);
end $$;

create or replace function public.cancel_membership(p_pass_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes := app.pass_for_change(p_pass_id, true); v_end timestamptz;
begin
  if p.kind <> 'membership' then perform app.fail('INVALID', 'Only memberships can be cancelled this way.'); end if;
  if p.status = 'cancelled' then return app.pass_json(p.id); end if;
  -- never activated = nothing paid-for to run out, so it ends now (like the demo)
  v_end := case when p.activated_at is null then app.now()
                else coalesce(p.next_billing_at, p.activated_at + interval '7 days') end;
  update public.passes set cancel_at_period_end = true, status = 'cancelled', next_billing_at = v_end where id = p.id;
  perform app.cancel_pass_bookings(p.id, v_end);
  perform app.audit('cancel_membership', 'passes', p.id::text, jsonb_build_object('ends', v_end));
  return app.pass_json(p.id);
end $$;

-- adjust: don't allow fewer credits than already used
create or replace function app.guard_pass_credits() returns trigger language plpgsql as $$
begin
  if new.credits is not null and new.credits < new.credits_used and new.credits is distinct from old.credits then
    perform app.fail('INVALID', 'That would take the pass below the credits already used.');
  end if;
  return new;
end $$;
create trigger guard_pass_credits before update of credits on public.passes
  for each row execute function app.guard_pass_credits();

-- refunds that cancel the pass also cancel its upcoming bookings
create or replace function app.cancel_bookings_for_cancelled_passes(p_sale uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select id from public.passes where sale_id = p_sale and status = 'cancelled' loop
    perform app.cancel_pass_bookings(r.id, app.now());
  end loop;
end $$;

create or replace function app.after_pass_cancelled() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Refund-cancellations set next_billing_at <= now (or have none); membership cancels are handled
  -- by cancel_membership itself, which keeps bookings until the paid-up date.
  if new.status = 'cancelled' and old.status <> 'cancelled'
     and (new.kind <> 'membership' or new.next_billing_at is null or new.next_billing_at <= app.now()) then
    perform app.cancel_pass_bookings(new.id, app.now());
  end if;
  return null;
end $$;
create trigger after_pass_cancelled after update of status on public.passes
  for each row execute function app.after_pass_cancelled();

-- ----------------------------------------------------------------------------- register interest
create table if not exists public.class_interest (
  client_id uuid not null references public.clients(id) on delete cascade,
  class_type_id uuid not null references public.class_types(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (client_id, class_type_id)
);
alter table public.class_interest enable row level security;
create policy class_interest_own on public.class_interest for select to authenticated
  using (client_id = public.current_client_id() or public.is_staff());
create policy class_interest_insert on public.class_interest for insert to authenticated
  with check (client_id = public.current_client_id() or public.has_role('owner','manager','front_desk'));
create policy class_interest_delete on public.class_interest for delete to authenticated
  using (client_id = public.current_client_id() or public.has_role('owner','manager','front_desk'));
revoke all on public.class_interest from anon;

revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.now(), app.tz(), app.is_privileged() to anon, authenticated;
