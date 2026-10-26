-- Integrations: spots held for ClassPass / Gympass are not for direct clients (migration 1703).
-- Direct clients get capacity minus the unfilled held spots (book_class, waitlist promotion, spots_left); partners can
-- still use the held spots; staff keep the real capacity.
-- Snowy: Mia manager, Julia instructor; clients Alice, Bob, Dan (all have a pass), Gus.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

select test.admin();
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity) values
  (test.id('mat'), '2026-10-22 10:00+11', '2026-10-22 10:50+11', test.id('julia_staff'), 3) returning id as sa \gset
insert into public.class_sessions (class_type_id, starts_at, ends_at, instructor_id, capacity) values
  (test.id('mat'), '2026-10-22 14:00+11', '2026-10-22 14:50+11', test.id('julia_staff'), 2) returning id as sb \gset
insert into test.ids values ('hs_a', :'sa'), ('hs_b', :'sb');

-- nothing held yet: the number is the plain capacity
select test.login('alice');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_a')), 3, 'nothing held: clients see all 3 spots');

-- ClassPass on, 2 spots held for Mat Essentials
select test.login('mia');
select public.integrations_save_partner('classpass', true, 'CP-1');
select public.integrations_set_reserved(test.id('mat'), 'classpass', 2);

-- what people see
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_a')), 3, 'staff still see the real 3 spots');
select test.login('alice');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_a')), 1, 'a client sees capacity minus the unfilled held spots: 3 - 2 = 1');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_b')), 0, 'a class where every spot is held shows full to clients');
select test.eq((select capacity from public.sessions_with_counts where id = test.id('hs_a')), 3, '...and the capacity itself is untouched');

-- direct booking: one spot, then the rest are held
select test.eq(public.book_class(test.id('hs_a')) ->> 'outcome', 'booked', 'Alice books the one spot left for direct clients');
select test.login('bob');
select test.eq(public.book_class(test.id('hs_a')) ->> 'outcome', 'waitlisted', 'Bob is waitlisted: only held spots remain, though the class is not full');
select test.login('dan');
select test.eq(public.book_class(test.id('hs_a')) ->> 'outcome', 'waitlisted', 'Dan too');
select test.admin();
select test.eq((select count(*)::int from public.bookings where session_id = test.id('hs_a') and status = 'booked'), 1, 'only Alice holds a spot');
select test.eq((select count(*)::int from public.bookings where session_id = test.id('hs_a') and status = 'waitlisted'), 2, 'Bob and Dan are waiting');

-- a partner can still use a held spot
select test.service();
select test.eq(public.integrations_partner_book('classpass', 'CP-1', test.id('hs_a'), 'H-1', 'hm-1', 'Maya', 'Singh') ->> 'duplicate', 'false', 'ClassPass books a held spot into the same class');
select test.login('alice');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_a')), 0, 'booked 2 + 1 still held: clients see 0 spots');

-- a cancellation frees a spot for the waitlist, but never one of the held spots
select test.admin();
insert into test.ids select 'hs_alice_bk', id from public.bookings where session_id = test.id('hs_a') and client_id = test.id('alice_client');
select test.login('alice');
select public.cancel_booking(test.id('hs_alice_bk'));
select test.admin();
select test.eq((select status from public.bookings where session_id = test.id('hs_a') and client_id = test.id('bob_client')), 'booked', 'Alice cancels: Bob is promoted into the spot that is not held');
select test.eq((select status from public.bookings where session_id = test.id('hs_a') and client_id = test.id('dan_client')), 'waitlisted', 'Dan stays waitlisted: the last spot is still held');
select test.eq((select count(*)::int from public.bookings where session_id = test.id('hs_a') and status = 'booked'), 2, 'the class has 2 of 3 booked');

-- the partner takes the last held spot; a second booking by the same partner is still bound by its 2 held spots
select test.service();
select public.integrations_partner_book('classpass', 'CP-1', test.id('hs_a'), 'H-2', 'hm-2', 'Tom', 'Alvarez');
select test.admin();
select test.eq((select count(*)::int from public.bookings where session_id = test.id('hs_a') and status = 'booked'), 3, 'the class is now full: both held spots were used by ClassPass');
select test.service();
select test.throws(format('select public.integrations_partner_book(''classpass'', ''CP-1'', %L, ''H-3'', ''hm-3'', ''Ben'', ''Cho'')', test.id('hs_a')), 'NO_PARTNER_SPOTS', 'a third partner booking is refused: only 2 are held');

-- a partner cancelling hands the spot back to the held pool, not to the waitlist
select public.integrations_partner_cancel('classpass', 'CP-1', 'H-2');
select test.admin();
select test.eq((select status from public.bookings where session_id = test.id('hs_a') and client_id = test.id('dan_client')), 'waitlisted', 'a partner cancellation does not promote a direct client into a held spot');
select test.login('dan');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_a')), 0, 'the freed spot is held again, so clients still see 0');

-- staff see and use the real capacity
select test.login('mia');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_b')), 2, 'staff see 2 real spots in the small class');
select test.eq(public.book_class(test.id('hs_b'), null, test.id('gus_client'), true, false, true) ->> 'outcome', 'booked', 'staff can book into a held spot (the roster uses the real number)');

-- switching the partner off releases the held spots
select public.integrations_save_partner('classpass', false);
select test.login('alice');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('hs_a')), 1, 'partner off: nothing is held, clients see the plain count again (3 - 2)');

rollback;
