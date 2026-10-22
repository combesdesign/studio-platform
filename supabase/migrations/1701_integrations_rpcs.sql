-- Integrations RPCs. Same rules and error codes as the demo store (src/features/integrations/demo.ts).
-- The two partner_* functions are for the partner-webhook edge function (service role) only.

create or replace function public.integrations_require(p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null or not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

-- Both partners, always (a studio that never saved anything gets "off, no ID, no key").
create or replace function public.integrations_list_partners() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.integrations_require(array['owner','manager']);
  return (select jsonb_agg(jsonb_build_object('partner', p.partner, 'enabled', coalesce(r.enabled, false), 'partner_studio_id', coalesce(r.partner_studio_id, ''),
                                                'key_set', coalesce(r.key_set, false)) order by p.partner)
            from (values ('classpass'), ('gympass')) p(partner)
            left join public.integrations_partners r on r.partner = p.partner and r.studio_id = app.current_studio_id());
end $$;

-- p_partner_studio_id / p_enabled null = leave alone. p_api_key: null = leave alone, '' = remove it. Keys: owner only.
create or replace function public.integrations_save_partner(p_partner text, p_enabled boolean default null, p_partner_studio_id text default null, p_api_key text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id text := btrim(p_partner_studio_id);
  v_key text := btrim(p_api_key);
  r public.integrations_partners;
begin
  perform public.integrations_require(array['owner','manager']);
  if p_api_key is not null then perform public.integrations_require(array['owner']); end if;
  perform app.assert_studio_open(app.current_studio_id());
  if p_partner not in ('classpass','gympass') then perform app.fail('INVALID', 'Choose ClassPass or Gympass.'); end if;
  if v_id is not null and length(v_id) > 80 then perform app.fail('INVALID', 'That ID is too long.'); end if;
  if v_key is not null and length(v_key) > 400 then perform app.fail('INVALID', 'That key is too long.'); end if;
  if v_id is not null and v_id <> '' and exists (select 1 from public.integrations_partners where partner = p_partner and partner_studio_id = v_id and studio_id <> app.current_studio_id()) then
    perform app.fail('INVALID', 'That ID is already linked to another studio.');
  end if;
  insert into public.integrations_partners (studio_id, partner, enabled, partner_studio_id)
    values (app.current_studio_id(), p_partner, coalesce(p_enabled, false), coalesce(v_id, ''))
    on conflict (studio_id, partner) do update
      set enabled = coalesce(p_enabled, public.integrations_partners.enabled),
          partner_studio_id = coalesce(v_id, public.integrations_partners.partner_studio_id),
          updated_at = now();
  if v_key is not null then
    if v_key = '' then
      delete from public.integrations_secrets where studio_id = app.current_studio_id() and partner = p_partner;
    else
      insert into public.integrations_secrets (studio_id, partner, api_key) values (app.current_studio_id(), p_partner, v_key)
        on conflict (studio_id, partner) do update set api_key = excluded.api_key, updated_at = now();
    end if;
    update public.integrations_partners set key_set = (v_key <> '') where studio_id = app.current_studio_id() and partner = p_partner;
  end if;
  select * into r from public.integrations_partners where studio_id = app.current_studio_id() and partner = p_partner;
  if r.enabled and r.partner_studio_id = '' then perform app.fail('INVALID', 'Add your partner ID before switching this on.'); end if;
  return jsonb_build_object('partner', r.partner, 'enabled', r.enabled, 'partner_studio_id', r.partner_studio_id, 'key_set', r.key_set);
end $$;

-- p_spots 0 clears it.
create or replace function public.integrations_set_reserved(p_class_type_id uuid, p_partner text, p_spots int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.integrations_require(array['owner','manager']);
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('class_types', p_class_type_id, 'We couldn''t find that class type.');
  if p_partner not in ('classpass','gympass') then perform app.fail('INVALID', 'Choose ClassPass or Gympass.'); end if;
  if p_spots is null or p_spots < 0 or p_spots > 200 then perform app.fail('INVALID', 'Spots can be 0 to 200.'); end if;
  if not exists (select 1 from public.class_types where id = p_class_type_id) then perform app.fail('NOT_FOUND', 'We couldn''t find that class type.'); end if;
  if p_spots = 0 then
    delete from public.integrations_reserved where studio_id = app.current_studio_id() and class_type_id = p_class_type_id and partner = p_partner;
  else
    insert into public.integrations_reserved (studio_id, class_type_id, partner, spots) values (app.current_studio_id(), p_class_type_id, p_partner, p_spots)
      on conflict (studio_id, class_type_id, partner) do update set spots = excluded.spots;
  end if;
end $$;

-- ---------------------------------------------------------------- webhook side (service role only)
-- Creates (or finds) the partner's member as a client and books them into the class. Never takes a credit.
-- Safe to call twice with the same partner_booking_id. Refuses when the partner isn't switched on, the class is full or
-- cancelled or over, or the partner has no spots held for this class type (or they are all taken).
create or replace function public.integrations_partner_book(
  p_partner text, p_partner_studio_id text, p_session_id uuid, p_partner_booking_id text, p_member_ref text, p_first_name text default '', p_last_name text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid; s public.class_sessions; v_client uuid; v_booking uuid; v_held int; v_used int; v_booked int;
  v_first text := left(btrim(coalesce(p_first_name, '')), 80); v_last text := left(btrim(coalesce(p_last_name, '')), 80);
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the partner webhook can do that.'); end if;
  if p_partner not in ('classpass','gympass') or coalesce(btrim(p_partner_booking_id), '') = '' or coalesce(btrim(p_member_ref), '') = '' then perform app.fail('INVALID', 'That booking is missing details.'); end if;
  select studio_id into v_studio from public.integrations_partners where partner = p_partner and partner_studio_id = p_partner_studio_id and partner_studio_id <> '' and enabled;
  if v_studio is null then perform app.fail('NOT_FOUND', 'No studio has that partner switched on.'); end if;
  perform app.use_studio(v_studio);
  select * into s from public.class_sessions where id = p_session_id and studio_id = v_studio for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  -- already booked (the partner retries): hand back the same booking
  select booking_id into v_booking from public.integrations_partner_bookings where studio_id = v_studio and source = p_partner and partner_booking_id = p_partner_booking_id;
  if v_booking is not null then return jsonb_build_object('booking_id', v_booking, 'duplicate', true); end if;
  if s.status = 'cancelled' then perform app.fail('CLASS_CANCELLED', 'This class has been cancelled.'); end if;
  if s.starts_at <= app.now() then perform app.fail('TOO_LATE', 'This class has already started.'); end if;
  select spots into v_held from public.integrations_reserved where studio_id = v_studio and class_type_id = s.class_type_id and partner = p_partner;
  if coalesce(v_held, 0) = 0 then perform app.fail('NO_PARTNER_SPOTS', 'No spots are held for this partner in that class.'); end if;
  select count(*) into v_used from public.integrations_partner_bookings pb join public.bookings b on b.id = pb.booking_id
   where pb.session_id = s.id and pb.source = p_partner and b.status in ('booked','checked_in');
  if v_used >= v_held then perform app.fail('NO_PARTNER_SPOTS', 'The spots held for this partner are all taken.'); end if;
  select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');
  if v_booked >= s.capacity then perform app.fail('CLASS_FULL', 'This class is full.'); end if;

  select client_id into v_client from public.integrations_partner_clients where studio_id = v_studio and partner = p_partner and member_ref = p_member_ref;
  if v_client is null then
    insert into public.clients (studio_id, first_name, last_name, email, source, marketing_opt_in, intro_ineligible)
      values (v_studio, case when v_first = '' then initcap(p_partner) else v_first end, case when v_last = '' then 'member' else v_last end, '', 'import', false, true)
      returning id into v_client;
    insert into public.integrations_partner_clients (studio_id, partner, member_ref, client_id) values (v_studio, p_partner, p_member_ref, v_client);
  end if;
  -- the same member twice in one class: one spot
  if exists (select 1 from public.bookings where session_id = s.id and client_id = v_client and status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'That member is already booked into this class.');
  end if;
  insert into public.bookings (studio_id, session_id, client_id, status, source) values (v_studio, s.id, v_client, 'booked', 'staff') returning id into v_booking;
  insert into public.integrations_partner_bookings (studio_id, booking_id, session_id, source, partner_booking_id, member_name)
    values (v_studio, v_booking, s.id, p_partner, p_partner_booking_id, btrim(v_first || ' ' || v_last));
  perform app.audit('partner_booking', 'bookings', v_booking::text, jsonb_build_object('partner', p_partner, 'partner_booking_id', p_partner_booking_id));
  return jsonb_build_object('booking_id', v_booking, 'duplicate', false);
end $$;

create or replace function public.integrations_partner_cancel(p_partner text, p_partner_studio_id text, p_partner_booking_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid; v_booking uuid; b public.bookings;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Only the partner webhook can do that.'); end if;
  select studio_id into v_studio from public.integrations_partners where partner = p_partner and partner_studio_id = p_partner_studio_id and partner_studio_id <> '' and enabled;
  if v_studio is null then perform app.fail('NOT_FOUND', 'No studio has that partner switched on.'); end if;
  perform app.use_studio(v_studio);
  select booking_id into v_booking from public.integrations_partner_bookings where studio_id = v_studio and source = p_partner and partner_booking_id = p_partner_booking_id;
  if v_booking is null then perform app.fail('NOT_FOUND', 'We couldn''t find that booking.'); end if;
  select * into b from public.bookings where id = v_booking for update;
  if b.status = 'booked' then
    update public.bookings set status = 'cancelled', cancelled_at = app.now() where id = b.id;
    perform app.promote_waitlist(b.session_id);
  end if;
  return jsonb_build_object('booking_id', v_booking, 'status', (select status from public.bookings where id = v_booking));
end $$;

revoke all on function public.integrations_require(text[]) from public, anon, authenticated;
revoke all on function public.integrations_list_partners(), public.integrations_save_partner(text, boolean, text, text), public.integrations_set_reserved(uuid, text, int) from public, anon;
grant execute on function public.integrations_list_partners(), public.integrations_save_partner(text, boolean, text, text), public.integrations_set_reserved(uuid, text, int) to authenticated;
revoke all on function public.integrations_partner_book(text, text, uuid, text, text, text, text), public.integrations_partner_cancel(text, text, text) from public, anon, authenticated;
grant execute on function public.integrations_partner_book(text, text, uuid, text, text, text, text), public.integrations_partner_cancel(text, text, text) to service_role;
