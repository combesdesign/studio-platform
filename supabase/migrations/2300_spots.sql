-- =============================================================================
-- Spot (mat / reformer) selection (ROADMAP B1). Optional, per class, off by default.
--
--   * rooms.spot_layout: a grid of numbered spots (jsonb { rows, cols, cells: [{ label, kind }] }, row by row). A cell is a
--     'spot' (bookable, its label is its id), the 'instructor' or 'unavailable'. Only owners and managers can change a room (0013 RLS).
--   * class_types.spot_picking: the "Let clients pick a spot" toggle. A class uses spots only when its class type has it on AND it is in
--     a room with a layout (no room = the studio's only room at the default location). Everything else behaves exactly as before.
--   * bookings.spot: the spot a booked or checked-in booking holds. UNIQUE (session_id, spot): two people can't hold the same spot.
--     A trigger clears it as soon as a booking stops being booked/checked-in (cancelling frees the spot) and gives one to any booking
--     that becomes booked without one: new bookings, waitlist promotions, undo, staff walk-ins, partner bookings, moved bookings.
--     It picks the first free spot, or the free one nearest a parent / dependant already in the class. Fewer spots than people: no spot.
--   * RPCs: session_spots (layout + which spots are taken, never by whom), choose_spot (pick or move; clients until the class starts,
--     staff until it ends; spot null = "pick for me").
--   * Capacity is untouched. Spots never decide who is booked or waitlisted; held-back partner spots (1703) work as before.
--
-- Ordering: this is numbered 2300 on purpose, not 0014. book_class is redefined by 1703 (the 0007 version with the guardian edits of 0010
-- folded in and the held-back-spots lines); promote_waitlist by 1703 too; sessions_with_counts by 1703 then 2200; 0013 redefines
-- gen_sessions and report. A 0014 file would run BEFORE 1703 and its book_class would be overwritten, so this file runs last and builds
-- on 1703's book_class. promote_waitlist, cancel_booking and move_booking need no change: they only change bookings.status / session_id
-- and the trigger below does the rest. sessions_with_counts (2200) is not touched.
-- =============================================================================

-- ----------------------------------------------------------------------------- layout check
-- Called from a CHECK constraint, so the people who write rooms need to be able to run it.
create or replace function app.valid_spot_layout(p jsonb) returns boolean
language plpgsql immutable as $$
declare v_rows int; v_cols int; c jsonb; v_labels text[] := '{}'; v_label text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if jsonb_typeof(p -> 'rows') <> 'number' or jsonb_typeof(p -> 'cols') <> 'number' or jsonb_typeof(p -> 'cells') <> 'array' then return false; end if;
  v_rows := (p ->> 'rows')::numeric::int; v_cols := (p ->> 'cols')::numeric::int;
  if (p ->> 'rows')::numeric <> v_rows or (p ->> 'cols')::numeric <> v_cols then return false; end if;
  if v_rows < 1 or v_rows > 10 or v_cols < 1 or v_cols > 12 then return false; end if;
  if jsonb_array_length(p -> 'cells') <> v_rows * v_cols then return false; end if;
  for c in select * from jsonb_array_elements(p -> 'cells') loop
    if jsonb_typeof(c) <> 'object' or jsonb_typeof(c -> 'label') <> 'string' then return false; end if;
    if (c ->> 'kind') not in ('spot', 'instructor', 'unavailable') then return false; end if;
    if c ->> 'kind' = 'spot' then
      v_label := lower(trim(c ->> 'label'));
      if v_label = '' or length(v_label) > 8 or v_label = any(v_labels) then return false; end if;
      v_labels := v_labels || v_label;
    end if;
  end loop;
  return coalesce(array_length(v_labels, 1), 0) > 0;   -- at least one bookable spot
end $$;
grant execute on function app.valid_spot_layout(jsonb) to anon, authenticated, service_role;

alter table public.rooms add column spot_layout jsonb;
alter table public.rooms add constraint rooms_spot_layout_valid check (spot_layout is null or app.valid_spot_layout(spot_layout));
alter table public.class_types add column spot_picking boolean not null default false;
alter table public.bookings add column spot text check (spot is null or length(trim(spot)) between 1 and 8);

-- two people can't hold the same spot in a class (a booking that isn't booked or checked in holds none: see the trigger)
create unique index bookings_session_spot_key on public.bookings (session_id, spot) where spot is not null;

-- ----------------------------------------------------------------------------- which layout does a class use?
create or replace function app.session_layout(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.class_sessions; v_room uuid; v_layout jsonb;
begin
  select * into s from public.class_sessions where id = p_session_id;
  if s.id is null then return null; end if;
  if not exists (select 1 from public.class_types where id = s.class_type_id and spot_picking) then return null; end if;
  v_room := s.room_id;
  if v_room is null then
    -- no room chosen: the studio's only active room at its default location, if it is only one
    select r.id into v_room from public.rooms r join public.locations l on l.id = r.location_id
     where l.studio_id = s.studio_id and l.is_default and r.active
       and (select count(*) from public.rooms r2 where r2.location_id = l.id and r2.active) = 1;
  end if;
  if v_room is null then return null; end if;
  select spot_layout into v_layout from public.rooms where id = v_room;
  return v_layout;
end $$;

-- "Pick for me": the first free spot in reading order, or the free one nearest the spots in p_near (a family sits together).
create or replace function app.pick_spot(p_layout jsonb, p_taken text[], p_near text[] default '{}') returns text
language sql stable security definer set search_path = public, pg_temp as $$
  with cols as (select (p_layout ->> 'cols')::int as n),
       cells as (select (ord - 1)::int as i, c ->> 'label' as label, c ->> 'kind' as kind
                   from jsonb_array_elements(p_layout -> 'cells') with ordinality t(c, ord)),
       anchors as (select i from cells where kind = 'spot' and label = any(coalesce(p_near, '{}'))),
       free as (select i, label from cells where kind = 'spot' and not (label = any(coalesce(p_taken, '{}'))))
  select f.label
    from free f, cols
   order by coalesce((select min(abs(a.i / cols.n - f.i / cols.n) * 2 + abs(a.i % cols.n - f.i % cols.n)) from anchors a), 0), f.i
   limit 1
$$;

create or replace function app.taken_spots(p_session_id uuid, p_except uuid default null) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(spot), '{}') from public.bookings
   where session_id = p_session_id and spot is not null and status in ('booked', 'checked_in') and id is distinct from p_except
$$;

-- Raises SPOT_TAKEN / INVALID unless the spot is a bookable one in this class and nobody else holds it. Returns the layout.
create or replace function app.assert_spot_free(p_session_id uuid, p_spot text, p_except uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_layout jsonb := app.session_layout(p_session_id);
begin
  if v_layout is null then perform app.fail('INVALID', 'This class doesn''t use spots.'); end if;
  if not exists (select 1 from jsonb_array_elements(v_layout -> 'cells') c where c ->> 'kind' = 'spot' and c ->> 'label' = p_spot) then
    perform app.fail('INVALID', 'That spot isn''t available in this class.');
  end if;
  if p_spot = any(app.taken_spots(p_session_id, p_except)) then
    perform app.fail('SPOT_TAKEN', 'That spot has just been taken. Please pick another.');
  end if;
  return v_layout;
end $$;

-- ----------------------------------------------------------------------------- the booking trigger
create or replace function app.booking_spot() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_layout jsonb; v_near text[];
begin
  if new.status not in ('booked', 'checked_in') then new.spot := null; return new; end if;   -- cancelling frees the spot
  if tg_op = 'UPDATE' and old.session_id is distinct from new.session_id then new.spot := null; end if;   -- moved: a spot in the new class
  if new.spot is not null then return new; end if;   -- chosen on purpose (book_class, choose_spot); the unique index is the backstop
  v_layout := app.session_layout(new.session_id);
  if v_layout is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('spot:' || new.session_id::text, 0));   -- two bookings at once can't be given the same one
  select coalesce(array_agg(o.spot), '{}') into v_near
    from public.bookings o
    join public.clients oc on oc.id = o.client_id
    join public.clients nc on nc.id = new.client_id
   where o.session_id = new.session_id and o.id is distinct from new.id and o.spot is not null and o.status in ('booked', 'checked_in')
     and (oc.id = nc.guardian_client_id or oc.guardian_client_id = nc.id
          or (nc.guardian_client_id is not null and oc.guardian_client_id = nc.guardian_client_id));
  new.spot := app.pick_spot(v_layout, app.taken_spots(new.session_id, new.id), v_near);   -- null when there are fewer spots than people
  return new;
end $$;
create trigger bookings_spot before insert or update of status, session_id on public.bookings
  for each row execute function app.booking_spot();

-- Switching a class type on later (or giving a room its first layout): give everyone already booked a spot.
create or replace function app.fill_spots(p_session_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b record;
begin
  for b in select id from public.bookings where session_id = p_session_id and status in ('booked', 'checked_in') and spot is null order by created_at, id loop
    update public.bookings set status = status where id = b.id;   -- the trigger fills the spot
  end loop;
end $$;

create or replace function app.class_type_spots_on() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  if new.spot_picking and not old.spot_picking then
    for s in select id from public.class_sessions where class_type_id = new.id and status = 'scheduled' and ends_at > app.now() loop
      perform app.fill_spots(s.id);
    end loop;
  end if;
  return null;
end $$;
create trigger class_types_spots_on after update of spot_picking on public.class_types
  for each row execute function app.class_type_spots_on();

create or replace function app.room_spots_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  if new.spot_layout is not null and old.spot_layout is distinct from new.spot_layout then
    for s in select id from public.class_sessions where (room_id = new.id or (room_id is null and app.session_layout(id) = new.spot_layout))
                and status = 'scheduled' and ends_at > app.now() loop
      perform app.fill_spots(s.id);
    end loop;
  end if;
  return null;
end $$;
create trigger rooms_spots_changed after update of spot_layout on public.rooms
  for each row execute function app.room_spots_changed();

-- ----------------------------------------------------------------------------- RPCs
-- What the picker needs: is the class using spots, the layout, and which spots are taken. Never who holds them.
create or replace function public.session_spots(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_layout jsonb;
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  v_layout := app.session_layout(p_session_id);
  if v_layout is null then return jsonb_build_object('enabled', false, 'layout', null, 'taken', '[]'::jsonb); end if;
  return jsonb_build_object('enabled', true, 'layout', v_layout, 'taken', to_jsonb(app.taken_spots(p_session_id)));
end $$;

-- Pick or move a booking's spot. p_spot null = "pick for me". Clients (and a parent for their dependants) until the class starts;
-- staff (p_as_staff) until it ends, for anyone, including checked-in clients and walk-ins.
create or replace function public.choose_spot(p_booking_id uuid, p_spot text default null, p_as_staff boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := app.now();
  v_sid uuid;
  b public.bookings;
  s public.class_sessions;
  v_layout jsonb;
  v_spot text := nullif(trim(p_spot), '');
begin
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that booking.');
  select session_id into v_sid from public.bookings where id = p_booking_id;
  if v_sid is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into s from public.class_sessions where id = v_sid for update;   -- one at a time per class
  select * into b from public.bookings where id = p_booking_id for update;
  perform app.assert_studio_open(s.studio_id);

  if p_as_staff then
    if not app.can_staff_session(s) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to change this booking.'); end if;
  elsif b.client_id is distinct from public.current_client_id() and not app.is_guardian_of(b.client_id) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that booking.');
  end if;

  if b.status not in ('booked', 'checked_in') then perform app.fail('INVALID', 'Only booked clients have a spot.'); end if;
  if s.status = 'cancelled' then perform app.fail('CLASS_CANCELLED', 'This class has been cancelled.'); end if;
  if p_as_staff then
    if v_now >= s.ends_at then perform app.fail('TOO_LATE', 'This class has finished.'); end if;
  elsif v_now >= s.starts_at then
    perform app.fail('TOO_LATE', 'This class has already started, so the spot can''t be changed.');
  end if;

  v_layout := app.session_layout(s.id);
  if v_layout is null then perform app.fail('INVALID', 'This class doesn''t use spots.'); end if;
  if v_spot is null then
    v_spot := app.pick_spot(v_layout, app.taken_spots(s.id, b.id));
    if v_spot is null then perform app.fail('SPOT_TAKEN', 'Every spot is taken.'); end if;
  else
    perform app.assert_spot_free(s.id, v_spot, b.id);
  end if;

  begin
    update public.bookings set spot = v_spot where id = b.id;
  exception when unique_violation then
    perform app.fail('SPOT_TAKEN', 'That spot has just been taken. Please pick another.');
  end;
  if p_as_staff then
    perform app.audit('choose_spot', 'bookings', b.id::text, jsonb_build_object('from', b.spot, 'to', v_spot));
  end if;
  return app.booking_json(b.id);
end $$;

-- ----------------------------------------------------------------------------- book_class: take a spot
-- 1703's version (guardians from 0010, held-back spots) with a seventh argument, p_spot. The old six-argument function goes (its default
-- arguments keep every existing call, in SQL and from the apps, working). Without p_spot the trigger gives a booked client the
-- first free spot; a waitlisted booking holds none until it is promoted.
drop function public.book_class(uuid, uuid, uuid, boolean, boolean, boolean);
create or replace function public.book_class(
  p_session_id uuid,
  p_pass_id uuid default null,
  p_client_id uuid default null,
  p_as_staff boolean default false,
  p_allow_over_capacity boolean default false,
  p_skip_credit boolean default false,
  p_spot text default null
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
  v_spot text := nullif(trim(p_spot), '');   -- spots
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

  -- spots: a chosen spot must be real and free before any credit is taken (the class row is locked, so nobody slips in)
  if v_spot is not null then perform app.assert_spot_free(s.id, v_spot); end if;

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

  insert into public.bookings (studio_id, session_id, client_id, status, pass_id, source, booked_by_staff_id, spot)
  values (s.studio_id, s.id, v_client, 'booked', p.id, case when p_as_staff then 'staff' else 'client' end,
          case when p_as_staff then v_staff end, v_spot)   -- spot null: the trigger gives one if the class uses spots
  returning id into b_id;

  perform app.notify(b_id, 'booking_confirmed');
  if p_as_staff then
    perform app.audit('book_class', 'bookings', b_id::text,
      jsonb_build_object('over_capacity', p_allow_over_capacity, 'skip_credit', p_skip_credit));
  end if;

  return jsonb_build_object('outcome', 'booked', 'booking', app.booking_json(b_id),
                            'pass', case when p.id is not null then app.pass_json(p.id) end);
end $$;

-- ----------------------------------------------------------------------------- grants
revoke all on function app.session_layout(uuid), app.pick_spot(jsonb, text[], text[]), app.taken_spots(uuid, uuid),
  app.assert_spot_free(uuid, text, uuid), app.booking_spot(), app.fill_spots(uuid), app.class_type_spots_on(), app.room_spots_changed()
  from public, anon, authenticated;
grant execute on function app.session_layout(uuid), app.pick_spot(jsonb, text[], text[]), app.taken_spots(uuid, uuid), app.assert_spot_free(uuid, text, uuid)
  to service_role;
revoke all on function public.session_spots(uuid), public.choose_spot(uuid, text, boolean),
  public.book_class(uuid, uuid, uuid, boolean, boolean, boolean, text) from public, anon;
grant execute on function public.session_spots(uuid), public.choose_spot(uuid, text, boolean),
  public.book_class(uuid, uuid, uuid, boolean, boolean, boolean, text) to authenticated, service_role;
