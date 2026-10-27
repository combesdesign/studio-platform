-- Room picker for appointments and events (the columns, FKs and the clash triggers came with 2200):
--   * app.ap_room_place(room): the room's location for this studio, or NOT_FOUND
--   * appointments_book takes p_room_id (staff only; a client's booking never holds a room)
--   * appointments_upsert_event reads roomId from the event JSON
--   * ap_appt_json / ap_event_json return locationId and roomId
-- The clash itself is the existing trigger: two things can't hold one room at overlapping times (ROOM_BUSY).

-- A throwaway helper: rewrite part of an existing function, failing loudly if the text isn't found.
create function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;

create or replace function app.ap_room_place(p_room uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_loc uuid;
begin
  select r.location_id into v_loc from public.rooms r where r.id = p_room and r.studio_id = app.current_studio_id();
  if v_loc is null then perform app.fail('NOT_FOUND', 'That room could not be found.'); end if;
  return v_loc;
end $$;

-- ----------------------------------------------------------------------------- JSON
select app.patch_function('app.ap_appt_json(uuid)'::regprocedure,
  $q$'note', a.note, 'source', a.source,$q$,
  $q$'note', a.note, 'source', a.source, 'locationId', a.location_id, 'roomId', a.room_id,$q$);
select app.patch_function('app.ap_event_json(uuid, uuid)'::regprocedure,
  $q$'hostStaffId', e.host_staff_id, 'location', e.location,$q$,
  $q$'hostStaffId', e.host_staff_id, 'location', e.location, 'locationId', e.location_id, 'roomId', e.room_id,$q$);

-- ----------------------------------------------------------------------------- events
select app.patch_function('public.appointments_upsert_event(jsonb)'::regprocedure,
  $q$  v_sessions jsonb := coalesce(p -> 'sessions', '[]'::jsonb);$q$,
  $q$  v_sessions jsonb := coalesce(p -> 'sessions', '[]'::jsonb);
  v_room uuid := nullif(p ->> 'roomId', '')::uuid;
  v_loc uuid;$q$);
select app.patch_function('public.appointments_upsert_event(jsonb)'::regprocedure,
  $q$  if v_id is not null then
    perform app.assert_in_studio('studio_events', v_id,$q$,
  $q$  if v_room is not null then v_loc := app.ap_room_place(v_room); end if;
  if v_id is not null then
    perform app.assert_in_studio('studio_events', v_id,$q$);
select app.patch_function('public.appointments_upsert_event(jsonb)'::regprocedure,
  $q$host_staff_id, location, published, refund_cutoff_hours)$q$,
  $q$host_staff_id, location, published, refund_cutoff_hours, location_id, room_id)$q$);
select app.patch_function('public.appointments_upsert_event(jsonb)'::regprocedure,
  $q$coalesce((p ->> 'published')::boolean, false), v_cutoff)$q$,
  $q$coalesce((p ->> 'published')::boolean, false), v_cutoff, v_loc, v_room)$q$);
select app.patch_function('public.appointments_upsert_event(jsonb)'::regprocedure,
  $q$published = coalesce((p ->> 'published')::boolean, published), refund_cutoff_hours = v_cutoff$q$,
  $q$published = coalesce((p ->> 'published')::boolean, published), refund_cutoff_hours = v_cutoff, location_id = v_loc, room_id = v_room$q$);

-- ----------------------------------------------------------------------------- booking (a new argument, so the old signature goes)
do $$
declare d text := pg_get_functiondef('public.appointments_book(uuid, uuid, timestamptz, integer, uuid, text, text, uuid)'::regprocedure);
  procedure_text text;
  pairs text[][] := array[
    array['p_credit_id uuid DEFAULT NULL::uuid)', 'p_credit_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid)'],
    array['  v_id uuid;
begin', '  v_id uuid;
  v_loc uuid;
begin'],
    array['  perform app.ap_check_method(v, p_method, true);', '  -- only staff hold a room; a client''s booking is left without one
  if p_room_id is not null and v.as_staff then v_loc := app.ap_room_place(p_room_id); else p_room_id := null; end if;
  perform app.ap_check_method(v, p_method, true);'],
    array['amount_cents, credit_uses, sale_id, note, source, booked_by_staff_id)', 'amount_cents, credit_uses, sale_id, note, source, booked_by_staff_id, location_id, room_id)'],
    array['case when v.as_staff then ''staff'' else ''client'' end, case when v.as_staff then v.staff_id end)', 'case when v.as_staff then ''staff'' else ''client'' end, case when v.as_staff then v.staff_id end, v_loc, p_room_id)']
  ];
  i int;
begin
  for i in 1 .. array_length(pairs, 1) loop
    if position(pairs[i][1] in d) = 0 then raise exception 'appointments_book patch % not found', i; end if;
    d := replace(d, pairs[i][1], pairs[i][2]);
  end loop;
  drop function public.appointments_book(uuid, uuid, timestamptz, integer, uuid, text, text, uuid);
  execute d;
end $$;
revoke execute on function public.appointments_book(uuid, uuid, timestamptz, integer, uuid, text, text, uuid, uuid) from public, anon;
grant execute on function public.appointments_book(uuid, uuid, timestamptz, integer, uuid, text, text, uuid, uuid) to authenticated, service_role;

drop function app.patch_function(regprocedure, text, text);
