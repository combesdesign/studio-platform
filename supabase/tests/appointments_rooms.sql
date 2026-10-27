-- Appointments and events in rooms (2700, on top of 2200's clash triggers): staff can hold a room when booking, events carry a room,
-- a busy room is refused for both (and for a move), a client's booking never takes one, and a room from nowhere is refused.
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney (AEDT, UTC+11). Friday 23 Oct is the day.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- a second room at the default location (the studio already has "Main room")
select test.login('libby');
insert into public.rooms (location_id, name) values ((select id from public.locations where studio_id = app.default_studio() and is_default), 'Studio 2') returning id as r2 \gset
insert into public.rooms (location_id, name) values ((select id from public.locations where studio_id = app.default_studio() and is_default), 'Studio 3') returning id as r3 \gset
select (public.appointments_upsert_type(jsonb_build_object('name', 'Private reformer', 'durationMin', 55, 'priceCents', 9500, 'capacity', 1, 'bufferMin', 5,
        'staffIds', jsonb_build_array(test.id('libby_staff'))))) ->> 'id' as t_private \gset
select public.appointments_set_availability(test.id('libby_staff'), '[{"weekday":5,"start":"05:00","end":"13:00"}]');

-- staff book into a room: the appointment says which
select public.appointments_book(:'t_private', test.id('libby_staff'), '2026-10-23 09:00+11', 1, test.id('alice_client'), null, 'comp', null, :'r2') as b1 \gset
select test.eq(:'b1'::jsonb -> 'appointment' ->> 'roomId', :'r2', 'the appointment carries its room');
select test.ok((:'b1'::jsonb -> 'appointment' ->> 'locationId') is not null, '...and the room''s location');

-- an event in the same room at an overlapping time is refused; another room, or back to back, is fine
select test.throws(format($$select public.appointments_upsert_event(jsonb_build_object('kind', 'workshop', 'title', 'Hips', 'capacity', 8, 'priceCents', 0, 'refundCutoffHours', 0,
  'roomId', %L, 'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-22T22:30:00Z', 'endsAt', '2026-10-22T23:30:00Z'))))$$, :'r2'),
  'ROOM_BUSY', 'an event can''t take a room an appointment holds');
select (public.appointments_upsert_event(jsonb_build_object('kind', 'workshop', 'title', 'Hips', 'capacity', 8, 'priceCents', 0, 'refundCutoffHours', 0, 'published', true,
  'roomId', :'r3', 'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-22T22:30:00Z', 'endsAt', '2026-10-22T23:30:00Z'))))) as e1 \gset
select test.eq(:'e1'::jsonb ->> 'roomId', :'r3', 'another room is fine and the event carries it');
select test.ok((:'e1'::jsonb ->> 'locationId') is not null, '...with its location');
select (public.appointments_upsert_event(jsonb_build_object('kind', 'event', 'title', 'Social', 'capacity', 8, 'priceCents', 0, 'refundCutoffHours', 0, 'published', true,
  'roomId', :'r2', 'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-22T22:55:00Z', 'endsAt', '2026-10-23T00:00:00Z'))))) ->> 'id' as e2 \gset
select test.ok(:'e2' is not null, 'starting as the appointment ends is fine (back to back)');

-- the same event can be edited without clashing with itself
select test.eq(public.appointments_upsert_event(jsonb_build_object('id', (:'e1'::jsonb ->> 'id'), 'kind', 'workshop', 'title', 'Hips and hamstrings', 'capacity', 8, 'priceCents', 0,
  'refundCutoffHours', 0, 'roomId', :'r3', 'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-22T22:30:00Z', 'endsAt', '2026-10-23T00:00:00Z')))) ->> 'title',
  'Hips and hamstrings', 'editing an event is not a clash with itself');

-- moving an appointment into a taken room time is refused
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 09:00+11', 1, %L, null, 'comp', null, %L)$$, :'t_private', test.id('libby_staff'), test.id('bob_client'), :'r2'),
  'SLOT_TAKEN', 'the instructor is busy anyway, so the slot rule answers first');
select (public.appointments_upsert_event(jsonb_build_object('kind', 'event', 'title', 'Late social', 'capacity', 8, 'priceCents', 0, 'refundCutoffHours', 0, 'published', true,
  'roomId', :'r2', 'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-23T01:00:00Z', 'endsAt', '2026-10-23T02:00:00Z'))))) ->> 'id' as e3 \gset
select test.throws(format($$select public.appointments_move(%L, '2026-10-23 12:00+11')$$, (:'b1'::jsonb -> 'appointment' ->> 'id')),
  'ROOM_BUSY', 'moving an appointment into a busy room time is refused');
select test.eq(public.appointments_move((:'b1'::jsonb -> 'appointment' ->> 'id')::uuid, '2026-10-23 11:00+11') ->> 'roomId', :'r2', 'a free time keeps the room');

-- rooms from nowhere, and clients
select test.throws($$select public.appointments_upsert_event(jsonb_build_object('kind', 'event', 'title', 'X', 'capacity', 8, 'priceCents', 0, 'refundCutoffHours', 0,
  'roomId', gen_random_uuid(), 'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-30T00:30:00Z', 'endsAt', '2026-10-30T01:30:00Z'))))$$,
  'NOT_FOUND', 'an unknown room is refused');
rollback;
