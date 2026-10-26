-- =============================================================================
-- Held spots are not for direct clients.
-- Core hook (feature-agnostic): app.capacity_hooks lists functions (session id -> int) that say how many spots a feature
-- keeps back from direct client bookings. app.held_back_spots(session) is their sum. book_class (clients only, staff keep the
-- real capacity), the waitlist promotion and the client-facing spots_left in sessions_with_counts all consult it.
-- Integrations registers app.integrations_held_back: for each switched-on partner, spots held minus partner bookings
-- already in the class. Partner bookings (integrations_partner_book) are unchanged and can still use the held spots.
-- With no hooks registered every number is exactly what it was before.
-- book_class and app.promote_waitlist below are the 0007 versions with only the lines marked "held" changed.
-- =============================================================================

create table app.capacity_hooks (
  feature text primary key,
  fn regproc not null          -- function(uuid session id) returns int
);
alter table app.capacity_hooks enable row level security;   -- no policies, no grants: only the definer functions below read it

create or replace function app.register_capacity_hook(p_feature text, p_fn regproc) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into app.capacity_hooks (feature, fn) values (p_feature, p_fn)
  on conflict (feature) do update set fn = excluded.fn
$$;

create or replace function app.held_back_spots(p_session_id uuid) returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare h record; v_n int; v_total int := 0;
begin
  for h in select fn from app.capacity_hooks order by feature loop
    execute format('select %s($1)', h.fn) into v_n using p_session_id;
    v_total := v_total + greatest(0, coalesce(v_n, 0));
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------- integrations: unfilled held spots
create or replace function app.integrations_held_back(p_session_id uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(greatest(0, r.spots - u.used)), 0)::int
    from public.class_sessions s
    join public.integrations_reserved r on r.studio_id = s.studio_id and r.class_type_id = s.class_type_id
    join public.integrations_partners p on p.studio_id = r.studio_id and p.partner = r.partner and p.enabled
    cross join lateral (
      select count(*) as used from public.integrations_partner_bookings pb join public.bookings b on b.id = pb.booking_id
       where pb.session_id = s.id and pb.source = r.partner and b.status in ('booked','checked_in')) u
   where s.id = p_session_id
$$;
select app.register_capacity_hook('integrations', 'app.integrations_held_back'::regproc);

revoke all on function app.register_capacity_hook(text, regproc), app.held_back_spots(uuid), app.integrations_held_back(uuid) from public, anon, authenticated;
-- the view below calls app.held_back_spots as whoever is reading it, so that one (only) is executable; it is a definer function and runs the hooks as the owner
grant execute on function app.held_back_spots(uuid) to anon, authenticated, service_role;
grant execute on function app.register_capacity_hook(text, regproc), app.integrations_held_back(uuid) to service_role;

-- ---------------------------------------------------------------- the client-facing count (staff keep the real number)
create or replace view public.sessions_with_counts as
select s.id, s.class_type_id, s.template_id, s.starts_at, s.ends_at, s.instructor_id, s.capacity,
       s.status, s.note, s.cancel_reason, s.updated_at, s.studio_id,
       coalesce(c.booked, 0)::int as booked_count,
       coalesce(c.waitlisted, 0)::int as waitlist_count,
       greatest(0, s.capacity - coalesce(c.booked, 0)
                   - case when public.current_staff_id() is null then app.held_back_spots(s.id) else 0 end)::int as spots_left   -- held
  from public.class_sessions s
  left join lateral (
    select count(*) filter (where b.status in ('booked','checked_in')) as booked,
           count(*) filter (where b.status = 'waitlisted') as waitlisted
      from public.bookings b where b.session_id = s.id
  ) c on true
 where s.studio_id = app.current_studio_id();

create or replace function public.book_class(
  p_session_id uuid,
  p_pass_id uuid default null,
  p_client_id uuid default null,
  p_as_staff boolean default false,
  p_allow_over_capacity boolean default false,
  p_skip_credit boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  v_client uuid;
  v_staff uuid;
  s public.class_sessions;
  ct public.class_types;
  c public.clients;
  st public.studio_settings;
  p public.passes;
  v_booked int;
  v_held int := 0;
  v_pos int;
  b_id uuid;
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  v_staff := public.current_staff_id();
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  perform app.assert_studio_open(s.studio_id);
  select * into st from public.studio_settings where studio_id = s.studio_id;
  select * into ct from public.class_types where id = s.class_type_id;

  if p_as_staff then
    if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to book clients into this class.'); end if;
    v_client := p_client_id;
    if v_client is null then perform app.fail('NOT_FOUND', 'Choose a client to book.'); end if;
  else
    v_client := public.current_client_id();
    if v_client is null then perform app.fail('AUTH_REQUIRED', 'Please sign in to book.'); end if;
    if p_client_id is not null and p_client_id <> v_client then
      -- family accounts (0010_family.sql): a parent books for their dependants
      if app.is_guardian_of(p_client_id) then v_client := p_client_id;
      else perform app.fail('NOT_ALLOWED', 'You can only book for yourself and your family.'); end if;
    end if;
    if p_allow_over_capacity or p_skip_credit then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  end if;

  select * into c from public.clients where id = v_client and studio_id = s.studio_id;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;

  if s.status = 'cancelled' then perform app.fail('CLASS_CANCELLED', 'This class has been cancelled.'); end if;

  if p_as_staff then
    if v_now >= s.ends_at then perform app.fail('TOO_LATE', 'This class has already finished.'); end if;
  else
    if v_now >= s.starts_at then perform app.fail('TOO_LATE', 'This class has already started.'); end if;
    if not ct.bookable or not ct.active then perform app.fail('NOT_BOOKABLE', 'This class isn''t open for booking yet.'); end if;
    if app.local_date(s.starts_at) > app.local_date(v_now) + st.booking_window_days then
      perform app.fail('TOO_EARLY', format('Bookings open %s days before class.', st.booking_window_days));
    end if;
    if c.waiver_signed_at is null then
      perform app.fail('WAIVER_REQUIRED', 'Please sign the waiver and health form before your first booking.');
    end if;
  end if;

  if exists (select 1 from public.bookings where session_id = s.id and client_id = v_client
               and status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'You''re already booked into this class.');
  end if;

  select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');
  -- spots a feature keeps back (e.g. unfilled ClassPass spots) are not for direct clients; staff see and use the real capacity
  if not p_as_staff then v_held := app.held_back_spots(s.id); end if;

  if v_booked >= s.capacity - v_held and not p_allow_over_capacity then
    select coalesce(max(waitlist_position), 0) + 1 into v_pos from public.bookings
     where session_id = s.id and status = 'waitlisted';
    insert into public.bookings (studio_id, session_id, client_id, status, waitlist_position, source, booked_by_staff_id)
    values (s.studio_id, s.id, v_client, 'waitlisted', v_pos, case when p_as_staff then 'staff' else 'client' end,
            case when p_as_staff then v_staff end)
    returning id into b_id;
    return jsonb_build_object('outcome', 'waitlisted', 'booking', app.booking_json(b_id), 'pass', null);
  end if;

  perform 1 from public.passes where client_id in (v_client, coalesce(app.guardian_of(v_client), v_client)) for update;

  if p_skip_credit then
    p := null;
  elsif p_pass_id is not null then
    select * into p from public.passes where id = p_pass_id
       and (client_id = v_client or (client_id = app.guardian_of(v_client) and app.pass_family_shareable(passes)));
    if p.id is null or not app.pass_usable(p, s.starts_at, s.class_type_id, v_now)
       or coalesce(app.pass_remaining(p, s.starts_at), 1) <= 0 then
      perform app.fail('NO_CREDITS', 'That pass can''t be used for this class.');
    end if;
  else
    p := app.best_pass(v_client, s.starts_at, s.class_type_id, v_now);
    if p.id is null then perform app.fail('NO_CREDITS', 'You need a class pass to book this class.'); end if;
  end if;

  if p.id is not null then p := app.apply_credit(p.id, v_now); end if;

  insert into public.bookings (studio_id, session_id, client_id, status, pass_id, source, booked_by_staff_id)
  values (s.studio_id, s.id, v_client, 'booked', p.id, case when p_as_staff then 'staff' else 'client' end,
          case when p_as_staff then v_staff end)
  returning id into b_id;

  perform app.notify(b_id, 'booking_confirmed');
  if p_as_staff then
    perform app.audit('book_class', 'bookings', b_id::text,
      jsonb_build_object('over_capacity', p_allow_over_capacity, 'skip_credit', p_skip_credit));
  end if;

  return jsonb_build_object('outcome', 'booked', 'booking', app.booking_json(b_id),
                            'pass', case when p.id is not null then app.pass_json(p.id) end);
end $$;

create or replace function app.promote_waitlist(p_session_id uuid, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, app.now());
  s public.class_sessions;
  v_cutoff numeric;
  v_booked int;
  v_held int;
  w record;
  p public.passes;
  v_out jsonb := '[]'::jsonb;
begin
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null or s.status <> 'scheduled' then return v_out; end if;
  select waitlist_cutoff_hours into v_cutoff from public.studio_settings where studio_id = s.studio_id;
  if v_now >= s.starts_at - make_interval(secs => coalesce(v_cutoff, 1) * 3600) then return v_out; end if;

  for w in select * from public.bookings
            where session_id = s.id and status = 'waitlisted'
            order by waitlist_position nulls last, created_at
            for update
  loop
    select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');
    v_held := app.held_back_spots(s.id);   -- the waitlist is direct clients: unfilled held spots stay held
    exit when v_booked >= s.capacity - v_held;
    perform 1 from public.passes where client_id = w.client_id for update;
    p := app.best_pass(w.client_id, s.starts_at, s.class_type_id, v_now);
    continue when p.id is null;
    p := app.apply_credit(p.id, v_now);
    update public.bookings set status = 'booked', pass_id = p.id, promoted_from_waitlist_at = v_now,
           waitlist_position = null
     where id = w.id;
    perform app.notify(w.id, 'waitlist_promoted');
    perform app.audit('promote_waitlist', 'bookings', w.id::text, jsonb_build_object('pass_id', p.id));
    v_out := v_out || jsonb_build_array(app.booking_json(w.id));
  end loop;
  if jsonb_array_length(v_out) > 0 then perform app.renumber_waitlist(s.id); end if;
  return v_out;
end $$;
