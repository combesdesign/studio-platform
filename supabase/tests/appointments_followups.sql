-- Appointments follow-ups (1104+): the event waitlist, moving an appointment, and the reminder lead time.
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney (AEDT, UTC+11). Same cases as tests/appointments.test.ts where they overlap.
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

-- ================================================================ waitlist
select test.login('mia');
select (public.appointments_upsert_event(jsonb_build_object('kind', 'workshop', 'title', 'Hips workshop', 'capacity', 2, 'priceCents', 4500,
        'refundCutoffHours', 48, 'published', true, 'hostStaffId', test.id('libby_staff'),
        'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-25T23:00:00Z', 'endsAt', '2026-10-26T01:00:00Z'))))) ->> 'id' as ev \gset
select (public.appointments_upsert_event(jsonb_build_object('kind', 'event', 'title', 'Tiny social', 'capacity', 3, 'priceCents', 0,
        'refundCutoffHours', 0, 'published', true,
        'sessions', jsonb_build_array(jsonb_build_object('startsAt', '2026-10-30T07:00:00Z', 'endsAt', '2026-10-30T09:00:00Z'))))) ->> 'id' as social \gset
select test.eq((public.appointments_update_settings(30, 4, 28) ->> 'waitlistClaimHours')::int, 12, 'offers stay open for 12 hours unless the studio says otherwise');

select test.login('fran');
select public.appointments_register(:'ev', test.id('alice_client'), 'cash') as r1 \gset
select public.appointments_register(:'ev', test.id('bob_client'), 'cash') as r2 \gset

-- you can only queue for something that's full, once, with a waiver
select test.login('cara');
select test.throws(format($$select public.appointments_join_waitlist(%L)$$, :'social'), 'NOT_FULL', 'places left: just sign up');
select public.appointments_join_waitlist(:'ev') as w1 \gset
select test.eq(:'w1'::jsonb ->> 'status', 'waiting', 'Cara joins the line');
select test.eq((:'w1'::jsonb ->> 'position')::int, 1, 'first');
select test.throws(format($$select public.appointments_join_waitlist(%L)$$, :'ev'), 'ALREADY_BOOKED', 'once');
select test.at('2026-10-19 08:01+11');
select test.login('dan');
select public.appointments_join_waitlist(:'ev') as w2 \gset
select test.eq((:'w2'::jsonb ->> 'position')::int, 2, 'Dan is second');
select test.at('2026-10-19 08:02+11');
select test.login('gus');
select public.appointments_join_waitlist(:'ev') as w3 \gset
select test.login('erin');
select test.throws(format($$select public.appointments_join_waitlist(%L)$$, :'ev'), 'WAIVER_REQUIRED', 'the waiver comes first');
select test.login('alice');
select test.throws(format($$select public.appointments_join_waitlist(%L)$$, :'ev'), 'ALREADY_BOOKED', 'registered people don''t queue');

select test.login('gus');
select test.eq((public.appointments_get_event(:'ev') ->> 'waitlisted')::int, 3, 'the event shows how many are waiting');
select test.eq((public.appointments_get_event(:'ev') -> 'myWaitlist' ->> 'position')::int, 3, 'and your place in line');
select test.eq(public.appointments_get_event(:'ev') ->> 'spotsLeft', '0', 'still full');
select test.eq(jsonb_array_length(public.appointments_list_waitlist()), 1, 'clients list their own place in line');
select test.throws(format($$select public.appointments_list_waitlist(null, %L)$$, :'ev'), 'NOT_ALLOWED', 'but not the whole line');
select test.eq(test.count_rows('studio_event_waitlist'), 1, '(table too: only your own row)');
select test.throws(format($$insert into public.studio_event_waitlist (event_id, client_id) values (%L, %L)$$, :'ev', test.id('gus_client')), '42501', 'and clients can''t write it');

-- the studio gives people a shorter window; Alice cancels in time: Cara (first in line) is offered the place
select test.login('mia');
select test.eq((public.appointments_update_settings(30, 4, 28, 6) ->> 'waitlistClaimHours')::int, 6, 'the studio sets the claim window');
select test.throws($$select public.appointments_update_settings(30, 4, 28, 0)$$, 'INVALID', 'between 1 and 72 hours');
select test.login('alice');
select public.appointments_cancel_registration((:'r1'::jsonb -> 'registration' ->> 'id')::uuid);
select test.admin();
select test.eq((select status from public.studio_event_waitlist where id = (:'w1'::jsonb ->> 'id')::uuid), 'offered', 'the first in line is offered the place');
select test.eq((select status from public.studio_event_waitlist where id = (:'w2'::jsonb ->> 'id')::uuid), 'waiting', 'the second keeps waiting');
select test.ok((select offer_expires_at = '2026-10-19 08:02+11'::timestamptz + interval '6 hours' from public.studio_event_waitlist where id = (:'w1'::jsonb ->> 'id')::uuid),
               'for the claim window (set when the cancel happened)') ;
select test.eq((select count(*)::int from public.appointments_outbox where kind = 'waitlist_offer' and client_id = test.id('cara_client')
                  and payload ->> 'title' = 'Hips workshop' and payload ? 'claim_by' and (payload ->> 'amount_cents')::int = 4500), 1, 'Cara gets an offer email');
select test.eq((select count(*)::int from public.appointments_outbox where kind = 'waitlist_offer'), 1, 'and nobody else');

-- the place is held: nobody else can take it, and it isn't free
select test.login('dan');
select test.eq(public.appointments_get_event(:'ev') ->> 'spotsLeft', '0', 'a held place isn''t free');
select test.throws(format($$select public.appointments_hold_order('event', null, null, null, 1, null, null, %L)$$, :'ev'), 'EVENT_FULL', 'the next in line has to wait their turn');
select test.login('fran');
select test.throws(format($$select public.appointments_register(%L, %L, 'cash')$$, :'ev', test.id('erin_client')), 'EVENT_FULL', 'the desk can''t take it either');

-- Cara claims by paying: the Stripe hold goes through even though her offer is a held place
select test.at('2026-10-19 09:00+11');
select test.login('cara');
select public.appointments_hold_order('event', null, null, null, 1, null, null, :'ev') as o1 \gset
select test.eq(public.appointments_get_event(:'ev') -> 'myWaitlist' ->> 'status', 'offered', 'still offered while she is at Stripe');
select test.service();
select public.appointments_complete_order((:'o1'::jsonb ->> 'orderId')::uuid, 'cs_wl_1', 'pi_wl_1', 4500) as done1 \gset
select test.eq(:'done1'::jsonb ->> 'booked', 'true', 'paid: she is in');
select test.admin();
select test.eq((select status from public.studio_event_waitlist where id = (:'w1'::jsonb ->> 'id')::uuid), 'claimed', 'and her turn in line is done');

-- Bob cancels: Dan is offered. He doesn't claim, so after the window the sweep lapses it and offers the place to Gus
select test.at('2026-10-19 09:10+11');
select test.login('bob');
select public.appointments_cancel_registration((:'r2'::jsonb -> 'registration' ->> 'id')::uuid);
select test.admin();
select test.eq((select status from public.studio_event_waitlist where id = (:'w2'::jsonb ->> 'id')::uuid), 'offered', 'Dan is offered Bob''s place');
select test.at('2026-10-19 15:00+11');   -- inside the 6 hour window (it ends 15:10)
select test.service();
select public.appointments_waitlist_sweep();
select test.admin();
select test.eq((select status from public.studio_event_waitlist where id = (:'w2'::jsonb ->> 'id')::uuid), 'offered', 'not before the window ends');
select test.at('2026-10-19 15:11+11');
select test.service();
select public.appointments_waitlist_sweep();
select test.admin();
select test.eq((select status from public.studio_event_waitlist where id = (:'w2'::jsonb ->> 'id')::uuid), 'expired', 'an unclaimed offer lapses');
select test.eq((select status from public.studio_event_waitlist where id = (:'w3'::jsonb ->> 'id')::uuid), 'offered', 'and goes to the next person');
select test.eq((select count(*)::int from public.appointments_outbox where kind = 'waitlist_offer' and client_id = test.id('gus_client')), 1, 'Gus is emailed');
select test.login('dan');
select test.throws(format($$select public.appointments_hold_order('event', null, null, null, 1, null, null, %L)$$, :'ev'), 'EVENT_FULL', 'Dan''s place has gone');

-- giving a place back passes it on; with nobody left it simply becomes free
select test.login('gus');
select public.appointments_leave_waitlist((:'w3'::jsonb ->> 'id')::uuid);
select test.eq(public.appointments_get_event(:'ev') ->> 'spotsLeft', '1', 'nobody left in line: the place is free');
select test.login('dan');
select test.throws(format($$select public.appointments_leave_waitlist(%L)$$, :'w3'::jsonb ->> 'id'), 'NOT_FOUND', 'you can only leave your own');

-- the front desk sees the line and can remove someone; the host can see it, other instructors can't
select test.login('cara');
select test.throws(format($$select public.appointments_list_waitlist(null, %L)$$, :'ev'), 'NOT_ALLOWED', 'clients can''t see the line');
select test.login('julia');
select test.throws(format($$select public.appointments_list_waitlist(null, %L)$$, :'ev'), 'NOT_ALLOWED', 'other instructors can''t');
select test.login('libby');
select test.eq(jsonb_array_length(public.appointments_list_waitlist(null, :'ev')), 0, 'the host sees an empty line');

-- the event starting or being cancelled lets everyone go
select test.login('fran');
select public.appointments_register(:'ev', test.id('erin_client'), 'cash');
select test.login('dan');
select public.appointments_join_waitlist(:'ev') as w4 \gset
select test.login('mia');
select public.appointments_cancel_event(:'ev', 'Instructor unwell');
select test.admin();
select test.eq((select status from public.studio_event_waitlist where id = (:'w4'::jsonb ->> 'id')::uuid), 'expired', 'a cancelled event clears its line');

-- ================================================================ moving an appointment
select test.at('2026-10-19 08:00+11');
select test.login('mia');
select (public.appointments_upsert_type(jsonb_build_object('name', 'Private move', 'durationMin', 55, 'priceCents', 9500, 'capacity', 1, 'bufferMin', 5,
        'staffIds', jsonb_build_array(test.id('libby_staff'), test.id('julia_staff'))))) ->> 'id' as tm \gset
select (public.appointments_upsert_pack(jsonb_build_object('name', '3 privates', 'credits', 3, 'priceCents', 27000, 'validityDays', 30,
        'typeIds', jsonb_build_array(:'tm')))) ->> 'id' as pkm \gset
select test.login('libby');
select public.appointments_set_availability(test.id('libby_staff'), '[{"weekday":6,"start":"07:00","end":"12:00"}]');
select test.login('julia');
select public.appointments_set_availability(test.id('julia_staff'), '[{"weekday":6,"start":"07:00","end":"12:00"}]');
select test.login('fran');
select public.appointments_buy_pack(:'pkm', test.id('alice_client'), 'card_reader');
select public.appointments_book(:'tm', test.id('libby_staff'), '2026-10-24 10:00+11', 1, test.id('bob_client'), null, 'cash') as bobs \gset

select test.login('alice');
select public.appointments_book(:'tm', test.id('libby_staff'), '2026-10-24 08:00+11', 1, null, null, 'pack') -> 'appointment' ->> 'id' as ap1 \gset
select test.ok(not test.ap_has_slot(public.appointments_list_slots(:'tm', '2026-10-24', '2026-10-24', test.id('libby_staff')), '2026-10-24 08:30+11'),
               'her own session blocks the slot list as usual');
select test.ok(test.ap_has_slot(public.appointments_list_slots(:'tm', '2026-10-24', '2026-10-24', test.id('libby_staff'), :'ap1'::uuid), '2026-10-24 08:30+11'),
               'but not when moving it');
select test.ok(not test.ap_has_slot(public.appointments_list_slots(:'tm', '2026-10-24', '2026-10-24', test.id('libby_staff'), (:'bobs'::jsonb -> 'appointment' ->> 'id')::uuid), '2026-10-24 10:00+11'),
               'and someone else''s session still blocks (it only leaves out your own)');

-- one step: the same appointment, a new time, the same credit
select public.appointments_move(:'ap1'::uuid, '2026-10-24 08:30+11') as mv \gset
select test.eq(:'mv'::jsonb ->> 'id', :'ap1', 'the same appointment');
select test.ok((select starts_at = '2026-10-24 08:30+11' and ends_at = '2026-10-24 09:25+11' and status = 'booked' from public.appointments where id = :'ap1'::uuid), 'at the new time');
select test.eq((select used from public.appointment_credits where client_id = test.id('alice_client')), 1, 'the credit is not given back and taken again');
select test.eq((select count(*)::int from public.appointments where client_id = test.id('alice_client')), 1, 'not a cancel and a rebook');
select test.eq(:'mv'::jsonb -> 'payment' ->> 'method', 'pack', 'still paid by credit');
select test.throws(format($$select public.appointments_move(%L, '2026-10-24 08:30+11')$$, :'ap1'), 'INVALID', 'to the time it already has');
select test.throws(format($$select public.appointments_move(%L, '2026-10-24 10:00+11')$$, :'ap1'), 'SLOT_TAKEN', 'onto someone else''s');
select test.throws(format($$select public.appointments_move(%L, '2026-10-24 06:00+11')$$, :'ap1'), 'SLOT_TAKEN', 'or outside the hours');
select test.throws(format($$select public.appointments_move(%L, '2026-10-24 09:00+11', %L)$$, :'ap1', test.id('fran_staff')), 'SLOT_TAKEN', 'or with someone who doesn''t offer it');

select test.admin();
select test.eq((select count(*)::int from public.appointments_outbox where kind = 'appointment_moved' and client_id = test.id('alice_client')
                  and payload ? 'previous_when' and payload ->> 'title' = 'Private move'), 1, 'she gets a moved email with the old time');
select test.login('bob');
select test.throws(format($$select public.appointments_move(%L, '2026-10-24 09:00+11')$$, :'ap1'), 'NOT_FOUND', 'only your own');

-- another instructor who offers the same session
select test.login('alice');
select test.eq(public.appointments_move(:'ap1'::uuid, '2026-10-24 09:00+11', test.id('julia_staff')) ->> 'staffName', 'Julia', 'with Julia instead');

-- a reminder already sent for the old time doesn't stop one for the new time
select test.at('2026-10-23 09:30+11');
select test.service();
select public.appointments_queue_reminders(24);
select test.admin();
select test.eq((select count(*)::int from public.appointments_outbox where kind = 'appointment_reminder' and payload ->> 'appointment_id' = :'ap1'), 1, 'reminded once');
select test.login('alice');
select public.appointments_move(:'ap1'::uuid, '2026-10-24 09:00+11', test.id('libby_staff'));
select test.service();
select public.appointments_queue_reminders(24);
select test.admin();
select test.eq((select count(*)::int from public.appointments_outbox where kind = 'appointment_reminder' and payload ->> 'appointment_id' = :'ap1'), 2, 'and reminded again for the new time');

-- inside the studio's cancellation window clients can't move it online; the front desk can; a credit that runs out first stops it
select set_config('test.window', (select cancel_window_hours::text from public.studio_settings where studio_id = app.default_studio()), false);
select test.at(('2026-10-24 09:00+11'::timestamptz - (current_setting('test.window')::numeric / 2) * interval '1 hour')::text);
select test.login('alice');
select test.throws(format($$select public.appointments_move(%L, '2026-10-24 11:30+11', %L)$$, :'ap1', test.id('julia_staff')), 'TOO_LATE', 'too close to move');
select test.login('fran');
select test.eq(public.appointments_move(:'ap1'::uuid, '2026-10-24 09:00+11', test.id('julia_staff')) ->> 'staffName', 'Julia', 'the front desk can');
select test.throws(format($$select public.appointments_move(%L, '2026-11-21 09:00+11', %L)$$, :'ap1', test.id('julia_staff')), 'CREDIT_EXPIRES', 'the pack would run out before the new time');
select test.at('2026-10-24 12:30+11');
select test.login('libby');
select public.appointments_set_status(:'ap1'::uuid, 'completed');
select test.login('fran');
select test.throws(format($$select public.appointments_move(%L, '2026-10-31 09:00+11')$$, :'ap1'), 'INVALID', 'a finished session can''t be moved');
select test.at('2026-10-19 08:00+11');

-- ================================================================ another studio can't see or use any of it
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
select test.eq(test.count_rows('studio_event_waitlist'), 0, 'studio B sees none of studio A''s waitlist');
select test.throws(format($$select public.appointments_join_waitlist(%L)$$, :'ev'), 'NOT_FOUND', 'or joins its events');
select test.throws(format($$select public.appointments_list_waitlist(null, %L)$$, :'ev'), 'NOT_FOUND', 'or reads its line');
select test.throws(format($$select public.appointments_leave_waitlist(%L)$$, :'w4'::jsonb ->> 'id'), 'NOT_FOUND', 'or removes its people');
select test.throws(format($$select public.appointments_move(%L, '2026-10-31 09:00+11')$$, :'ap1'), 'NOT_FOUND', 'or moves its appointments');
select test.ap_studio(null);

rollback;
