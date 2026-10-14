-- Waitlist, cancellations, check-in, housekeeping.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');   -- Monday 8am. s_early = Wed 21 Oct 6:00am, 2 spots.

create function test.status(p_client text, p_session text) returns text language sql security definer as $$
  select status from public.bookings where client_id = test.id(p_client || '_client') and session_id = test.id(p_session)
  order by (status in ('booked','waitlisted','checked_in','no_show')) desc, created_at desc, updated_at desc limit 1
$$;
create function test.bid(p_client text, p_session text) returns uuid language sql security definer as $$
  select id from public.bookings where client_id = test.id(p_client || '_client') and session_id = test.id(p_session)
  order by (status in ('booked','waitlisted','checked_in','no_show')) desc, created_at desc, updated_at desc limit 1
$$;
grant execute on function test.status, test.bid to authenticated;

select test.login('alice'); select public.book_class(test.id('s_early'));
select test.login('bob');   select public.book_class(test.id('s_early')); select public.book_class(test.id('s_next'));
select test.login('cara');
select test.eq(public.book_class(test.id('s_early')) ->> 'outcome', 'waitlisted', 'full class -> waitlist, even without a credit');
select test.throws($$select public.book_class(test.id('s_early'))$$, 'ALREADY_BOOKED', 'can''t join the waitlist twice');
select test.login('fay');
select test.eq(public.book_class(test.id('s_early')) -> 'booking' ->> 'waitlist_position', '2', 'second on the waitlist');
select test.login('dan');
select test.eq(public.book_class(test.id('s_early')) -> 'booking' ->> 'waitlist_position', '3', 'third on the waitlist');
select test.admin();
select test.eq((select credits_used from public.passes where id = test.id('fay_old_pass')), 1, 'joining the waitlist takes no credit');
select test.eq((select waitlist_count from public.sessions_with_counts where id = test.id('s_early')), 3, 'waitlist count');

-- ---------------------------------------------------------------- early cancel: credit back + promote (skipping no-credit client)
select test.login('alice');
create temp table r as select public.cancel_booking(test.bid('alice', 's_early')) as j;
select test.admin();
select test.eq((select j -> 'booking' ->> 'status' from r), 'cancelled', 'cancel more than 3h before -> cancelled');
select test.eq((select (j ->> 'creditReturned')::boolean from r), true, '...credit returned');
select test.eq((select (j ->> 'lateCancel')::boolean from r), false, '...not a late cancel');
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 0, '...pack credit is back');
select test.eq((select j -> 'promoted' ->> 'client_id' from r), test.id('fay_client')::text, 'waitlist promotion skips Cara (no credit) and books Fay');
select test.eq(test.status('fay', 's_early'), 'booked', 'Fay is booked');
select test.eq(test.status('cara', 's_early'), 'waitlisted', 'Cara stays on the waitlist');
select test.eq((select credits_used from public.passes where id = test.id('fay_old_pass')), 2, 'Fay''s credit is taken on promotion');
select test.ok((select promoted_from_waitlist_at is not null from public.bookings where id = test.bid('fay', 's_early')), 'promotion time recorded');
select test.ok(exists (select 1 from public.notifications where kind = 'waitlist_promoted' and to_email = 'fay@example.test'), 'Fay gets a "you''re in" email');
drop table r;

-- ---------------------------------------------------------------- late cancel (inside 3h, outside 1h cutoff): credit lost, promote still happens
select test.at('2026-10-21 04:00+11');  -- 2h before class
select test.login('bob');
create temp table r as select public.cancel_booking(test.bid('bob', 's_early')) as j;
select test.admin();
select test.eq((select j -> 'booking' ->> 'status' from r), 'late_cancelled', 'cancel within 3h -> late_cancelled');
select test.eq((select (j ->> 'creditReturned')::boolean from r), false, '...credit lost');
select test.eq((select j -> 'promoted' ->> 'client_id' from r), test.id('dan_client')::text, '2h before class the waitlist still auto-books (Dan)');
drop table r;
select test.login('bob');
select test.eq(public.credit_summary(test.id('bob_client'), test.id('s_thu')) -> 0 ->> 'label', '1 of 2 left this week', 'a late cancel still counts towards the membership week');

-- ---------------------------------------------------------------- inside the 1h cutoff: spot stays open, waitlist untouched
select test.at('2026-10-21 05:30+11');
select test.login('fay');
create temp table r as select public.cancel_booking(test.bid('fay', 's_early')) as j;
select test.admin();
select test.ok((select j -> 'promoted' = 'null'::jsonb or j -> 'promoted' is null from r), 'no auto-booking inside 1h of class');
select test.eq(test.status('cara', 's_early'), 'waitlisted', 'waitlist stays as it is');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('s_early')), 1, 'the spot stays open');
drop table r;
select test.login('alice');
select test.eq(public.book_class(test.id('s_early')) ->> 'outcome', 'booked', 'anyone can grab the open spot');
select test.login('cara');
select public.leave_waitlist(test.bid('cara', 's_early'));
select test.eq(test.status('cara', 's_early'), 'removed', 'leaving the waitlist -> removed');
select test.throws($$select public.leave_waitlist(test.bid('alice', 's_early'))$$, 'NOT_FOUND', 'can''t touch someone else''s booking');

-- ---------------------------------------------------------------- staff waive
select test.at('2026-10-21 05:45+11');
select test.login('dan');
select test.throws($$select public.cancel_booking(test.bid('dan', 's_early'), true)$$, 'NOT_ALLOWED', 'clients can''t waive the policy');
select test.login('fran');
create temp table r as select public.cancel_booking(test.bid('dan', 's_early'), true, true) as j;
select test.admin();
select test.eq((select j -> 'booking' ->> 'status' from r), 'cancelled', 'staff waive -> cancelled');
select test.eq((select (j ->> 'creditReturned')::boolean from r), true, 'staff waive -> credit returned');
select test.ok(exists (select 1 from public.audit_log where action = 'cancel_booking'), 'staff cancellation is audited');
drop table r;

-- ---------------------------------------------------------------- check-in
select test.at('2026-10-21 06:05+11');
select test.login('alice');
select test.throws($$select public.cancel_booking(test.bid('alice', 's_early'))$$, 'TOO_LATE', 'client can''t cancel after class starts');
select test.throws($$select public.check_in(test.bid('alice', 's_early'))$$, 'NOT_ALLOWED', 'clients can''t check themselves in');
select test.login('gracet');
select test.throws($$select public.check_in(test.bid('alice', 's_early'))$$, 'NOT_ALLOWED', 'instructor can''t check in another instructor''s class');
select test.login('julia');
select test.eq(public.check_in(test.bid('alice', 's_early')) ->> 'status', 'checked_in', 'instructor checks in their own class');
select test.eq(public.undo_check_in(test.bid('alice', 's_early')) ->> 'status', 'booked', 'undo check-in');
select test.eq(public.mark_rest_no_show(test.id('s_early')), 1, 'mark rest as no-show');
select test.eq(test.status('alice', 's_early'), 'no_show', 'no-show recorded');
select test.eq(public.check_in(test.bid('alice', 's_early')) ->> 'status', 'checked_in', 'a no-show can still be checked in if they turn up late');
select test.throws($$select public.check_in(test.bid('fay', 's_early'))$$, 'NOT_ALLOWED', 'can''t check in a cancelled booking');
select test.admin();
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, 'no-show/check-in don''t double-charge');

-- ---------------------------------------------------------------- capacity increase promotes from the waitlist
select test.at('2026-10-19 08:00+11');
select test.mk_session('s_cap', 'mat', '2026-10-24 08:00+11', 1, 'libby');
select test.login('alice'); select public.book_class(test.id('s_cap'));
select test.login('cara');  select public.book_class(test.id('s_cap'));  -- no credit
select test.login('gus');   select public.book_class(test.id('s_cap'));  -- has a single class credit
select test.login('dan');   select public.book_class(test.id('s_cap'));
select test.login('fran');
update public.class_sessions set capacity = 3 where id = test.id('s_cap');
select test.admin();
select test.eq((select string_agg(c.first_name, ',' order by c.first_name) from public.bookings b join public.clients c on c.id = b.client_id
                 where b.session_id = test.id('s_cap') and b.status = 'booked'), 'Alice,Dan,Gus', 'bigger class fills from the waitlist (skipping no-credit)');

-- ---------------------------------------------------------------- move a booking
select test.login('alice'); select public.book_class(test.id('s_thu'));
select test.login('fran');
select test.eq(public.move_booking(test.bid('alice', 's_thu'), test.id('s_fri')) ->> 'outcome', 'booked', 'staff can move a booking');
select test.admin();
select test.eq(test.status('alice', 's_thu'), 'cancelled', 'old booking cancelled');
select test.eq((select pass_id from public.bookings where id = test.bid('alice', 's_fri')),
               (select id from public.passes where client_id = test.id('alice_client')), 'credit moves with it (same pass)');
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 3, 'no extra credit taken by a move');
select test.login('fran');
select test.throws($$select public.move_booking(test.bid('alice', 's_fri'), test.id('s_cap'))$$, 'CLASS_FULL', 'can''t move into a full class');
select test.admin();

-- ---------------------------------------------------------------- housekeeping
select test.at('2026-10-24 08:01+11');
select test.ok((public.housekeeping() ->> 'waitlist_removed')::int >= 1, 'housekeeping clears waitlists once class starts');
select test.eq(test.status('cara', 's_cap'), 'removed', '...Cara removed from the started class''s waitlist');
select test.at('2026-10-28 08:00+11');
select public.housekeeping();
select test.eq((select status from public.passes where id = test.id('fay_old_pass')), 'expired', 'housekeeping expires passes');

-- reminders: classes in the next 2 hours
select test.at('2026-10-26 04:30+11');  -- s_next is Mon 26 Oct 6:00am
select test.ok(public.queue_class_reminders() >= 1, 'reminders queued for classes in the next 2 hours');
select test.eq(public.queue_class_reminders(), 0, 'reminders only go once');

rollback;
