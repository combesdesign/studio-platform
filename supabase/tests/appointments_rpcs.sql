-- Appointments (1100-1102): types, hours, slots, booking + cancelling, packs, workshops / courses, online orders,
-- row level security and studio isolation. Same cases as tests/appointments.test.ts where they overlap.
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney (AEDT, UTC+11). Libby teaches the 6:00am mat class on Friday 23 Oct.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create function test.ap_has_slot(p_slots jsonb, p_at text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(p_slots) s where (s ->> 'startsAt')::timestamptz = p_at::timestamptz)
$$;
create function test.ap_studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create function test.count_rows(p_table text) returns int language plpgsql as $$
declare n int;
begin execute format('select count(*) from public.%I', p_table) into n; return n; end $$;
grant execute on all functions in schema test to anon, authenticated, service_role;

-- ---------------------------------------------------------------- catalogue: owner / manager only (Libby is the owner, Julia an instructor)
select test.login('julia');
select test.throws($$select public.appointments_upsert_type('{"name":"Nope","durationMin":55,"priceCents":9500,"capacity":1,"bufferMin":0,"staffIds":[]}')$$,
                   'NOT_ALLOWED', 'instructors can''t create appointment types');
select test.login('mia');
select test.throws($$select public.appointments_upsert_type('{"name":"Trio","durationMin":55,"priceCents":9500,"capacity":3,"bufferMin":0,"staffIds":[]}')$$,
                   'INVALID', 'appointments are for 1 or 2 people');
select (public.appointments_upsert_type(jsonb_build_object('name', 'Private reformer', 'durationMin', 55, 'priceCents', 9500, 'capacity', 1, 'bufferMin', 5,
        'staffIds', jsonb_build_array(test.id('libby_staff'))))) ->> 'id' as t_private \gset
select (public.appointments_upsert_type(jsonb_build_object('name', 'Duet', 'durationMin', 55, 'priceCents', 6000, 'capacity', 2, 'bufferMin', 5,
        'staffIds', jsonb_build_array(test.id('libby_staff'))))) ->> 'id' as t_duet \gset
select test.admin();
insert into test.ids values ('t_private', :'t_private'), ('t_duet', :'t_duet');
select test.login('mia');
select test.eq(jsonb_array_length(public.appointments_upsert_type(jsonb_build_object('id', test.id('t_duet'), 'name', 'Duet', 'durationMin', 55,
  'priceCents', 6000, 'capacity', 2, 'bufferMin', 5, 'staffIds', jsonb_build_array(test.id('libby_staff'), gen_random_uuid()))) -> 'staffIds'), 1,
  'unknown staff ids are dropped');
select (public.appointments_upsert_pack(jsonb_build_object('name', '5 privates', 'credits', 5, 'priceCents', 42500, 'validityDays', 90,
        'typeIds', jsonb_build_array(test.id('t_private'), test.id('t_duet'))))) ->> 'id' as pk5 \gset
select test.admin();
insert into test.ids values ('pk5', :'pk5');

select test.login('alice');
select test.eq(jsonb_array_length(public.appointments_list_types()), 2, 'clients see active types');
select test.eq(test.count_rows('appointment_packs'), 1, 'clients can read active packs');
select test.throws($$insert into public.appointment_types (name, duration_min, price_cents) values ('x', 30, 0)$$, '42501', 'clients can''t write types');

-- ---------------------------------------------------------------- hours: staff their own, managers anyone
select test.login('julia');
select test.throws(format($$select public.appointments_set_availability(%L, '[{"weekday":5,"start":"05:00","end":"12:00"}]')$$, test.id('libby_staff')),
                   'NOT_ALLOWED', 'instructors can only set their own hours');
select test.login('libby');
select test.throws(format($$select public.appointments_set_availability(%L, '[{"weekday":5,"start":"05:00","end":"09:00"},{"weekday":5,"start":"08:00","end":"12:00"}]')$$, test.id('libby_staff')),
                   'INVALID', 'overlapping windows are refused');
select test.throws(format($$select public.appointments_set_availability(%L, '[{"weekday":5,"start":"9am","end":"12:00"}]')$$, test.id('libby_staff')),
                   'INVALID', 'times must look like 09:00');
select test.eq(jsonb_array_length(public.appointments_set_availability(test.id('libby_staff'),
  '[{"weekday":5,"start":"05:00","end":"12:00"},{"weekday":6,"start":"07:00","end":"09:00"}]')), 2, 'Libby sets her Friday and Saturday hours');

-- ---------------------------------------------------------------- slots
select test.login('alice');
select public.appointments_list_slots(test.id('t_private'), '2026-10-23', '2026-10-23') as fri \gset
select test.ok(test.ap_has_slot(:'fri', '2026-10-23 05:00+11'), '05:00 fits before her 6:00 class (session + buffer ends as the class starts)');
select test.ok(not test.ap_has_slot(:'fri', '2026-10-23 05:30+11'), '05:30 would run into the class');
select test.ok(not test.ap_has_slot(:'fri', '2026-10-23 06:00+11'), 'no slot while she teaches');
select test.ok(test.ap_has_slot(:'fri', '2026-10-23 11:00+11'), '11:00 is the last start that fits the window');
select test.ok(not test.ap_has_slot(:'fri', '2026-10-23 11:30+11'), '11:30 would finish after 12:00');
select test.eq(jsonb_array_length(public.appointments_list_slots(test.id('t_private'), '2026-10-20', '2026-10-22')), 0, 'no hours, no slots');

select test.login('mia');
select public.appointments_update_settings(30, 4, 3);
select test.login('alice');
select test.eq(jsonb_array_length(public.appointments_list_slots(test.id('t_private'), '2026-10-23', '2026-10-23')), 0, 'clients can''t book past the horizon');
select test.login('fran');
select test.ok(jsonb_array_length(public.appointments_list_slots(test.id('t_private'), '2026-10-23', '2026-10-23')) > 0, 'the front desk can');
select test.login('mia');
select public.appointments_update_settings(30, 4, 28);

select test.login('libby');
select (public.appointments_add_time_off(test.id('libby_staff'), '2026-10-23 10:00+11', '2026-10-23 11:00+11', 'Physio')) ->> 'id' as off1 \gset
select test.login('alice');
select public.appointments_list_slots(test.id('t_private'), '2026-10-23', '2026-10-23') as fri \gset
select test.ok(not test.ap_has_slot(:'fri', '2026-10-23 10:00+11') and not test.ap_has_slot(:'fri', '2026-10-23 09:30+11'), 'time off blocks overlapping slots');
select test.ok(test.ap_has_slot(:'fri', '2026-10-23 11:00+11'), 'and nothing after it');

-- ---------------------------------------------------------------- booking
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 08:00+11', 1, null, null, 'card_online')$$, test.id('t_private'), test.id('libby_staff')),
                   'NOT_ALLOWED', 'clients can''t record a card payment themselves (checkout does)');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 08:00+11', 1, null, null, 'pack')$$, test.id('t_private'), test.id('libby_staff')),
                   'NO_CREDITS', 'no pack, no booking');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 08:00+11', 1, %L, null, 'pack')$$, test.id('t_private'), test.id('libby_staff'), test.id('bob_client')),
                   'NOT_ALLOWED', 'clients only book for themselves');
select test.login('erin');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 08:00+11', 1, null, null, 'pack')$$, test.id('t_private'), test.id('libby_staff')),
                   'WAIVER_REQUIRED', 'the waiver comes first');

select test.login('fran');
select test.throws(format($$select public.appointments_buy_pack(%L, %L, 'card_online')$$, test.id('pk5'), test.id('alice_client')),
                   'NOT_ALLOWED', 'the desk takes cards on the reader');
select public.appointments_buy_pack(test.id('pk5'), test.id('alice_client'), 'card_reader') as bought \gset
select test.eq((:'bought'::jsonb -> 'sale' ->> 'total_cents')::int, 42500, 'buying a pack is a core sale');
select test.eq((:'bought'::jsonb -> 'credit' ->> 'remaining')::int, 5, 'with 5 credits');

select test.login('alice');
select public.appointments_book(test.id('t_private'), test.id('libby_staff'), '2026-10-23 08:00+11', 1, null, 'First time on a reformer', 'pack') as b1 \gset
select test.eq(:'b1'::jsonb -> 'appointment' ->> 'status', 'booked', 'Alice books a private with a pack credit');
select test.eq(:'b1'::jsonb -> 'appointment' ->> 'staffName', 'Libby', 'with Libby');
select test.eq((select used from public.appointment_credits where client_id = test.id('alice_client')), 1, 'one credit used');
select test.ok((select expires_at = '2026-10-19 08:00+11'::timestamptz + interval '90 days' from public.appointment_credits where client_id = test.id('alice_client')),
               'the pack starts on first use');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 08:00+11', 1, null, null, 'pack')$$, test.id('t_private'), test.id('libby_staff')),
                   'SLOT_TAKEN', 'the same slot can''t be booked twice');

select test.login('fran');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 08:30+11', 1, %L, null, 'cash')$$, test.id('t_private'), test.id('libby_staff'), test.id('bob_client')),
                   'SLOT_TAKEN', 'overlapping slots are gone too');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 09:00+11', 3, %L, null, 'cash')$$, test.id('t_duet'), test.id('libby_staff'), test.id('bob_client')),
                   'INVALID', 'a duet is for 2 at most');
select public.appointments_book(test.id('t_duet'), test.id('libby_staff'), '2026-10-23 09:00+11', 2, test.id('bob_client'), null, 'cash') as b2 \gset
select test.eq((:'b2'::jsonb -> 'sale' ->> 'total_cents')::int, 12000, 'a duet for two costs two places');
select test.eq(:'b2'::jsonb -> 'appointment' ->> 'source', 'staff', 'booked by the front desk');
select test.login('julia');
select test.throws(format($$select public.appointments_book(%L, %L, '2026-10-23 07:00+11', 1, %L, null, 'cash')$$, test.id('t_private'), test.id('libby_staff'), test.id('cara_client')),
                   'NOT_ALLOWED', 'instructors don''t book on behalf of clients');

-- ---------------------------------------------------------------- who sees what
select test.login('libby');
select test.eq(jsonb_array_length(public.appointments_list()), 2, 'Libby sees her sessions');
select test.login('julia');
select test.eq(jsonb_array_length(public.appointments_list()), 0, 'other instructors don''t');
select test.eq(test.count_rows('appointments'), 0, '(table too)');
select test.login('bob');
select test.eq(jsonb_array_length(public.appointments_list()), 1, 'Bob sees only his own');
select test.eq(test.count_rows('appointments'), 1, '(table too)');
select test.eq(test.count_rows('appointment_credits'), 0, 'and not Alice''s pack');
select test.throws(format($$select public.appointments_cancel(%L)$$, (:'b1'::jsonb -> 'appointment' ->> 'id')), 'NOT_FOUND', 'or cancel her session');

-- ---------------------------------------------------------------- cancelling (studio cancel window)
select test.login('alice');
select public.appointments_cancel((:'b1'::jsonb -> 'appointment' ->> 'id')::uuid) as c1 \gset
select test.eq(:'c1'::jsonb ->> 'late', 'false', 'cancelling days ahead is in time');
select test.eq((:'c1'::jsonb ->> 'creditsReturned')::int, 1, 'the credit goes back');
select test.eq((select used from public.appointment_credits where client_id = test.id('alice_client')), 0, '(on the pack)');
select public.appointments_book(test.id('t_private'), test.id('libby_staff'), '2026-10-23 08:00+11', 1, null, null, 'pack') as b3 \gset
select test.ok(:'b3'::jsonb -> 'appointment' ->> 'status' = 'booked', 'a cancelled slot can be booked again');
select set_config('test.window', (select cancel_window_hours::text from public.studio_settings where studio_id = app.default_studio()), false);
select test.at(('2026-10-23 08:00+11'::timestamptz - (current_setting('test.window')::numeric / 2) * interval '1 hour')::text);
select public.appointments_cancel((:'b3'::jsonb -> 'appointment' ->> 'id')::uuid) as c2 \gset
select test.eq(:'c2'::jsonb ->> 'late', 'true', 'inside the cancel window it''s a late cancel');
select test.eq((:'c2'::jsonb ->> 'creditsReturned')::int, 0, 'and the credit is kept');
select test.eq(:'c2'::jsonb -> 'appointment' ->> 'status', 'late_cancelled', '(status)');
select test.at('2026-10-19 08:00+11');

select test.login('fran');
select public.appointments_cancel((:'b2'::jsonb -> 'appointment' ->> 'id')::uuid) as c3 \gset
select test.eq(:'c3'::jsonb ->> 'refundDue', 'true', 'cancelling a paid session in time leaves a refund due');
select public.appointments_mark_refunded((:'b2'::jsonb -> 'appointment' ->> 'id')::uuid, null);
select test.ok(not (public.appointments_list(null, null, null, test.id('bob_client'), true) -> 0 ? 'refundDue'), 'marked refunded');

-- ---------------------------------------------------------------- marking sessions
select test.login('fran');
select public.appointments_book(test.id('t_private'), test.id('libby_staff'), '2026-10-24 07:00+11', 1, test.id('dan_client'), null, 'comp') as b4 \gset
select test.eq((:'b4'::jsonb -> 'sale' ->> 'total_cents')::int, 0, 'a comp is a $0 sale');
select test.login('libby');
select test.throws(format($$select public.appointments_set_status(%L, 'completed')$$, :'b4'::jsonb -> 'appointment' ->> 'id'), 'INVALID', 'not before it starts');
select test.at('2026-10-24 08:00+11');
select test.eq(public.appointments_set_status((:'b4'::jsonb -> 'appointment' ->> 'id')::uuid, 'completed') ->> 'status', 'completed', 'Libby marks it done');
select test.login('julia');
select test.throws(format($$select public.appointments_set_status(%L, 'no_show')$$, :'b4'::jsonb -> 'appointment' ->> 'id'), 'NOT_ALLOWED', 'other instructors can''t');
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- workshops and courses
select test.login('mia');
select test.throws($$select public.appointments_upsert_event('{"kind":"workshop","title":"Two days","capacity":5,"priceCents":0,"refundCutoffHours":48,
  "sessions":[{"startsAt":"2026-10-25T23:00:00Z","endsAt":"2026-10-26T01:00:00Z"},{"startsAt":"2026-11-01T23:00:00Z","endsAt":"2026-11-02T01:00:00Z"}]}')$$,
  'INVALID', 'a workshop is one date');
select (public.appointments_upsert_event(jsonb_build_object('kind', 'workshop', 'title', 'Sunday hips workshop', 'capacity', 2, 'priceCents', 4500,
        'refundCutoffHours', 48, 'published', true, 'hostStaffId', test.id('libby_staff'),
        'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-25T23:00:00Z', 'endsAt', '2026-10-26T01:00:00Z'))))) ->> 'id' as ev \gset
select (public.appointments_upsert_event(jsonb_build_object('kind', 'course', 'title', 'Mat Pilates Foundations', 'capacity', 8, 'priceCents', 9900,
        'refundCutoffHours', 48, 'published', true,
        'sessions', jsonb_build_array(
          jsonb_build_object('startsAt', '2026-10-28T07:00:00Z', 'endsAt', '2026-10-28T08:00:00Z'),
          jsonb_build_object('startsAt', '2026-11-04T07:00:00Z', 'endsAt', '2026-11-04T08:00:00Z'),
          jsonb_build_object('startsAt', '2026-11-11T07:00:00Z', 'endsAt', '2026-11-11T08:00:00Z'))))) ->> 'id' as course \gset
select (public.appointments_upsert_event(jsonb_build_object('kind', 'event', 'title', 'Studio social', 'capacity', 20, 'priceCents', 0,
        'refundCutoffHours', 0, 'published', true,
        'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-30T07:00:00Z', 'endsAt', '2026-10-30T09:00:00Z'))))) ->> 'id' as social \gset
select (public.appointments_upsert_event(jsonb_build_object('kind', 'event', 'title', 'Draft', 'capacity', 20, 'priceCents', 0, 'refundCutoffHours', 0,
        'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-30T07:00:00Z', 'endsAt', '2026-10-30T09:00:00Z'))))) ->> 'id' as draft \gset

select test.login('alice');
select test.eq(jsonb_array_length(public.appointments_list_events()), 3, 'clients see published events');
select test.eq(jsonb_array_length(public.appointments_get_event(:'course') -> 'sessions'), 3, 'a course has all its dates');
select test.throws(format($$select public.appointments_get_event(%L)$$, :'draft'), 'NOT_FOUND', 'drafts are hidden');
select test.throws(format($$select public.appointments_register(%L)$$, :'ev'), 'NOT_ALLOWED', 'paid sign-ups go through checkout');
select test.eq(public.appointments_register(:'social') -> 'registration' ->> 'status', 'registered', 'free events: just register');

select test.login('fran');
select public.appointments_register(:'ev', test.id('alice_client'), 'cash') as r1 \gset
select test.eq((:'r1'::jsonb -> 'sale' ->> 'total_cents')::int, 4500, 'the desk takes cash for a workshop');
select public.appointments_register(:'ev', test.id('bob_client'), 'card_reader') as r2 \gset
select test.throws(format($$select public.appointments_register(%L, %L, 'cash')$$, :'ev', test.id('cara_client')), 'EVENT_FULL', 'capacity holds');
select test.throws(format($$select public.appointments_register(%L, %L, 'cash')$$, :'ev', test.id('alice_client')), 'ALREADY_BOOKED', 'once per person');
select test.login('julia');
select test.throws(format($$select public.appointments_list_registrations(null, %L)$$, :'ev'), 'NOT_ALLOWED', 'only the host and the desk see who''s coming');
select test.login('libby');
select test.eq(jsonb_array_length(public.appointments_list_registrations(null, :'ev')), 2, 'the host sees the attendee list');
select test.eq(jsonb_array_length(public.appointments_set_attendance((:'r1'::jsonb -> 'registration' ->> 'id')::uuid, '2026-10-25T23:00:00Z', true) -> 'attended'), 1,
               'the host marks attendance');
select test.throws(format($$select public.appointments_set_attendance(%L, '2026-10-20T23:00:00Z', true)$$, :'r1'::jsonb -> 'registration' ->> 'id'), 'INVALID', 'only on its dates');

select test.login('bob');
select test.at('2026-10-25 08:00+11');   -- 18h before: inside the 48h refund cut-off
select public.appointments_cancel_registration((:'r2'::jsonb -> 'registration' ->> 'id')::uuid) as rc \gset
select test.eq(:'rc'::jsonb ->> 'late', 'true', 'inside the event''s cut-off: no refund');
select test.at('2026-10-19 08:00+11');

select test.login('mia');
select test.throws(format($$select public.appointments_upsert_event(jsonb_set(public.appointments_get_event(%L) - 'registered' - 'spotsLeft', '{capacity}', '0'))$$, :'ev'),
                   'INVALID', 'capacity can''t go below 1');
select public.appointments_cancel_event(:'ev', 'Instructor unwell');
select test.ok((select bool_and(status = 'cancelled') from public.studio_event_registrations where event_id = :'ev' and client_id = test.id('alice_client')),
               'cancelling an event cancels its sign-ups');
select test.ok((select refund_due from public.studio_event_registrations where event_id = :'ev' and client_id = test.id('alice_client')), 'and paid ones are due a refund');

-- ---------------------------------------------------------------- paying online: hold, Stripe, webhook
select test.login('cara');
select public.appointments_hold_order('appointment', test.id('t_private'), test.id('libby_staff'), '2026-10-23 11:00+11', 1) as o1 \gset
select test.eq((:'o1'::jsonb ->> 'amountCents')::int, 9500, 'the order carries the price');
select test.eq(:'o1'::jsonb ->> 'currency', (select lower(currency) from public.studios where is_default), 'and the studio''s currency');
select test.ok(not test.ap_has_slot(public.appointments_list_slots(test.id('t_private'), '2026-10-23', '2026-10-23'), '2026-10-23 11:00+11'), 'the slot is held');
select test.eq(jsonb_array_length(public.appointments_list()), 0, 'a hold isn''t a booking yet');
select test.throws(format($$select public.appointments_complete_order(%L)$$, :'o1'::jsonb ->> 'orderId'), '42501', 'clients can''t complete their own order');
select test.throws($$select test.count_rows('appointment_orders')$$, '42501', 'orders aren''t readable through the API');
select test.login('gus');
select test.throws(format($$select public.appointments_hold_order('appointment', %L, %L, '2026-10-23 11:00+11', 1)$$, test.id('t_private'), test.id('libby_staff')),
                   'SLOT_TAKEN', 'someone else can''t take a held slot');
select test.login('fran');
select test.throws($$select public.appointments_hold_order('pack', null, null, null, 1, null, test.id('pk5'))$$, 'NOT_ALLOWED', 'checkout is for clients');

select test.service();
select public.appointments_attach_checkout((:'o1'::jsonb ->> 'orderId')::uuid, 'cs_test_1');
select public.appointments_complete_order((:'o1'::jsonb ->> 'orderId')::uuid, 'cs_test_1', 'pi_test_1', 9500) as done1 \gset
select test.eq(:'done1'::jsonb ->> 'booked', 'true', 'paid: the hold becomes a booking');
select test.eq(public.appointments_complete_order((:'o1'::jsonb ->> 'orderId')::uuid, 'cs_test_1', 'pi_test_1', 9500), :'done1'::jsonb, 'completing twice is harmless');
select test.eq((select count(*)::int from public.sales where stripe_payment_intent_id = 'pi_test_1'), 1, 'one sale, with the Stripe payment');
select test.eq((select status from public.appointments where id = (:'done1'::jsonb ->> 'appointmentId')::uuid), 'booked', '(status)');

select test.login('cara');
select public.appointments_hold_order('pack', null, null, null, 1, null, test.id('pk5')) as o2 \gset
select test.service();
select public.appointments_complete_order((:'o2'::jsonb ->> 'orderId')::uuid, 'cs_test_2', 'pi_test_2', 42500);
select test.eq((select credits_total from public.appointment_credits where client_id = test.id('cara_client')), 5, 'a pack bought online arrives');

-- A hold that lapses, is taken by someone else, then gets paid: money recorded, refund due.
select test.login('cara');
select public.appointments_hold_order('appointment', test.id('t_private'), test.id('libby_staff'), '2026-10-24 08:00+11', 1) as o3 \gset
select test.at('2026-10-19 08:31+11');
select test.service();
select public.appointments_release_holds();
select test.eq((select status from public.appointment_orders where id = (:'o3'::jsonb ->> 'orderId')::uuid), 'expired', 'the cron lapses old holds');
select test.login('fran');
select public.appointments_book(test.id('t_private'), test.id('libby_staff'), '2026-10-24 08:00+11', 1, test.id('gus_client'), null, 'cash');
select test.service();
select public.appointments_complete_order((:'o3'::jsonb ->> 'orderId')::uuid, 'cs_test_3', 'pi_test_3', 9500) as done3 \gset
select test.eq(:'done3'::jsonb ->> 'booked', 'false', 'a late payment for a slot that has gone isn''t booked');
select test.ok((select refund_due and sale_id is not null and status = 'cancelled' from public.appointments
                 where id = (:'done3'::jsonb ->> 'appointmentId')::uuid), 'but recorded with a refund due');
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- emails: queued by triggers, reminders once, drained by the service role
select test.admin();
select test.ok(exists (select 1 from public.appointments_outbox where kind = 'appointment_confirmed' and client_id = test.id('alice_client')
                          and payload ->> 'title' = 'Private reformer' and payload ? 'when'), 'booking queues a confirmation email');
select test.ok(exists (select 1 from public.appointments_outbox where kind = 'appointment_cancelled' and (payload ->> 'credit_returned')::boolean),
               'an in-time pack cancellation says the credit is back');
select test.ok(exists (select 1 from public.appointments_outbox where kind = 'appointment_cancelled' and (payload ->> 'late')::boolean),
               'a late cancellation says so');
select test.ok(exists (select 1 from public.appointments_outbox where kind = 'event_registered'), 'registering queues a confirmation');
select test.ok(exists (select 1 from public.appointments_outbox where kind = 'event_cancelled' and (payload ->> 'cancelled_by_studio')::boolean
                          and payload ->> 'reason' = 'Instructor unwell'), 'cancelling an event tells everyone why');
select test.service();
select test.ok((select count(*) from public.appointments_claim_outbox(100)) > 0, 'the sender can claim pending emails');
select test.admin();
select test.ok(exists (select 1 from public.appointments_outbox where sent_at is null and attempts = 1), 'claiming counts an attempt');
select test.service();
select public.appointments_finish_outbox(id) from public.appointments_outbox;
select test.eq((select count(*)::int from public.appointments_outbox where sent_at is null), 0, 'and mark them sent');
select test.at('2026-10-23 09:00+11');   -- the day before Gus's session on the 24th
select public.appointments_queue_reminders(24) as rem \gset
select test.at('2026-10-19 08:00+11');
select test.admin();
select test.ok(:'rem'::int > 0, 'reminders queue for sessions in the next 24 hours');
select test.ok((select count(*) from public.appointments_outbox where kind in ('appointment_reminder','event_reminder')) = :'rem'::int, 'one reminder per upcoming session');
select test.service();
select test.eq(public.appointments_queue_reminders(24), 0, 'and never twice');
select test.throws($$select public.appointments_claim_outbox(1)$$, '42501', 'nobody else can drain the outbox');

-- ---------------------------------------------------------------- another studio can't see or use any of it
select test.admin();
insert into public.studios (slug, name, timezone, currency) values ('bayside', 'Bayside Test', 'Australia/Sydney', 'AUD') returning id as bay \gset
insert into public.studio_settings (studio_id, name) values (:'bay', 'Bayside Test');
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'owen@bay.test', '{"first_name":"Owen","studio":"bayside"}', now());
insert into public.staff (studio_id, name, email, role, user_id) values (:'bay', 'Owen', 'owen@bay.test', 'owner', (select id from auth.users where email = 'owen@bay.test'))
  on conflict do nothing;
update public.staff set user_id = (select id from auth.users where email = 'owen@bay.test') where email = 'owen@bay.test' and studio_id = :'bay';
insert into test.ids select 'owen', id from auth.users where email = 'owen@bay.test';
select test.login('owen');
select test.ap_studio('bayside');
select test.eq(jsonb_array_length(public.appointments_list_types(true)), 0, 'studio B sees none of studio A''s types');
select test.eq(jsonb_array_length(public.appointments_list()), 0, 'or appointments');
select test.eq(jsonb_array_length(public.appointments_list_events(true)), 0, 'or events');
select test.eq(test.count_rows('appointment_types'), 0, '(tables too)');
select test.eq(test.count_rows('appointments_outbox'), 0, 'or its emails');
select test.throws(format($$select public.appointments_list_slots(%L, '2026-10-23', '2026-10-23')$$, test.id('t_private')), 'NOT_FOUND', 'studio A''s type can''t be used from B');
select test.throws(format($$select public.appointments_cancel_event(%L)$$, :'course'), 'NOT_FOUND', 'or its events cancelled');
select test.throws(format($$select public.appointments_set_availability(%L, '[]')$$, test.id('libby_staff')), 'NOT_FOUND', 'or its staff hours changed');
select test.ap_studio(null);
select test.login('libby');
select test.ap_studio('bayside');
select test.throws($$select public.appointments_list_types()$$, 'AUTH_REQUIRED', 'studio A staff aren''t members of B');
select test.ap_studio(null);

rollback;
