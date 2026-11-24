-- Round 3 (random-sequence invariant tests and permissions matrix): fixes found by them.
-- Each fix has a regression assertion in supabase/tests/invariants_random.sql or supabase/tests/permissions_matrix.sql.

-- 1. Undoing a no-show could put a client back into a class that had since filled up (a no-show doesn't hold a spot, so someone else may
--    have booked it), leaving the class over capacity, or when the client had booked the class again (a raw unique-key error instead of a clear
--    message). Same rules as undo_cancel_booking: if the class is full or they're already booked again, they can't be put back.
create or replace function public.undo_no_show(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id); s public.class_sessions;
begin
  perform app.assert_studio_open(b.studio_id);
  if b.status <> 'no_show' then perform app.fail('INVALID', 'This booking is no longer marked as a no-show.'); end if;
  select * into s from public.class_sessions where id = b.session_id for update;
  if (select count(*) from public.bookings where session_id = s.id and status in ('booked','checked_in')) >= s.capacity then
    perform app.fail('CLASS_FULL', 'Someone else has taken that spot, so they can''t be put back.');
  end if;
  if exists (select 1 from public.bookings x where x.session_id = s.id and x.client_id = b.client_id and x.id <> b.id and x.status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'They have been booked into this class again already.');
  end if;
  update public.bookings set status = 'booked' where id = b.id;
  perform app.audit('undo_no_show', 'bookings', b.id::text, jsonb_build_object('client_id', b.client_id));
  return app.booking_json(b.id);
end $$;

-- 1b. Checking in a no-show who has booked the class again hit the same raw unique-key error. A clear message instead.
create or replace function public.check_in(p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings := app.staff_booking_for_update(p_booking_id);
begin
  if b.status = 'waitlisted' then perform app.fail('INVALID', 'They''re on the waitlist. Book them in first.'); end if;
  if b.status not in ('booked','no_show','checked_in') then perform app.fail('INVALID', 'This booking was cancelled.'); end if;
  if b.status = 'no_show' and exists (select 1 from public.bookings x where x.session_id = b.session_id and x.client_id = b.client_id and x.id <> b.id
                                        and x.status in ('booked','waitlisted','checked_in')) then
    perform app.fail('ALREADY_BOOKED', 'They have been booked into this class again already.');
  end if;
  update public.bookings set status = 'checked_in', checked_in_at = coalesce(checked_in_at, app.now()) where id = b.id;
  return app.booking_json(b.id);
end $$;

-- 2. A client who cancelled late (credit forfeited) kept losing that credit when the studio then cancelled the class, which never ran.
--    The demo engine already gave it back; the database did not. Now the late cancel becomes a plain cancel and the credit returns
--    (the same thing "waive penalty" does). It is not marked 'removed', so restoring the class doesn't put them back in.
create or replace function app.cancel_session_impl(p_session_id uuid, p_reason text default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.class_sessions; b record; n int := 0;
begin
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if not (app.is_privileged() or public.has_role('owner','manager','front_desk')) then
    perform app.fail('NOT_ALLOWED', 'You don''t have permission to cancel classes.');
  end if;
  if s.status = 'cancelled' then return 0; end if;
  update public.class_sessions set status = 'cancelled', cancel_reason = p_reason where id = s.id;
  for b in select * from public.bookings where session_id = s.id and status in ('booked','checked_in','waitlisted','no_show') for update loop
    perform 1 from public.passes where client_id = b.client_id for update;
    if b.status <> 'waitlisted' and b.pass_id is not null then perform app.return_credit(b.pass_id); end if;
    update public.bookings set status = 'removed', cancelled_at = app.now(), waitlist_position = null where id = b.id;
    perform app.notify(b.id, 'class_cancelled');
    n := n + 1;
  end loop;
  for b in select * from public.bookings where session_id = s.id and status = 'late_cancelled' for update loop
    perform 1 from public.passes where client_id = b.client_id for update;
    if b.pass_id is not null then perform app.return_credit(b.pass_id); end if;
    update public.bookings set status = 'cancelled' where id = b.id;
  end loop;
  perform app.audit('cancel_session', 'class_sessions', s.id::text, jsonb_build_object('reason', p_reason, 'bookings', n));
  return n;
end $$;
