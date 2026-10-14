-- Booking rules: which credit gets used, activation, limits, errors.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');   -- Monday 8am

-- ---------------------------------------------------------------- errors
select test.login('erin');
select test.throws($$select public.book_class(test.id('s_eve'))$$, 'WAIVER_REQUIRED', 'no waiver -> WAIVER_REQUIRED');
select test.login('cara');
select test.throws($$select public.book_class(test.id('s_eve'))$$, 'NO_CREDITS', 'no pass -> NO_CREDITS');
select test.login('alice');
select test.throws($$select public.book_class(test.id('s_past'))$$, 'TOO_LATE', 'class already started -> TOO_LATE');
select test.throws($$select public.book_class(test.id('s_far'))$$, 'NOT_ALLOWED', 'beyond the 14 day booking window -> NOT_ALLOWED');
select test.throws($$select public.book_class(test.id('s_sculpt'))$$, 'NOT_ALLOWED', 'coming-soon class type is not bookable');
select test.throws($$select public.book_class(gen_random_uuid())$$, 'NOT_FOUND', 'unknown class -> NOT_FOUND');
select test.throws($$select public.book_class(test.id('s_eve'), null, test.id('bob_client'))$$, 'NOT_ALLOWED', 'client cannot book for someone else');
select test.throws($$select public.book_class(test.id('s_eve'), null, null, false, true)$$, 'NOT_ALLOWED', 'client cannot squeeze in over capacity');
select test.throws($$select public.book_class(test.id('s_eve'), null, null, true)$$, 'NOT_ALLOWED', 'client cannot pretend to be staff');

-- ---------------------------------------------------------------- pack: activation + one per class
select test.eq(public.book_class(test.id('s_eve')) ->> 'outcome', 'booked', 'pack holder books');
select test.admin();
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, 'pack: 1 credit used');
select test.eq((select activated_at from public.passes where client_id = test.id('alice_client')), '2026-10-19 08:00+11'::timestamptz, 'pack activates on first booking');
select test.eq((select expires_at from public.passes where client_id = test.id('alice_client')), '2026-12-19 08:00+11'::timestamptz, 'pack expires 61 days from first use');
select test.login('alice');
select test.throws($$select public.book_class(test.id('s_eve'))$$, 'ALREADY_BOOKED', 'one booking per class');
select test.admin();
select test.throws($$insert into public.bookings (session_id, client_id, status) values (test.id('s_eve'), test.id('alice_client'), 'waitlisted')$$,
                   '23505', 'unique index also blocks a second active booking at the database level');

-- ---------------------------------------------------------------- priority: unlimited before pack
select test.login('dan');
select public.book_class(test.id('s_eve'));
select test.admin();
select test.eq((select p.name from public.bookings b join public.passes p on p.id = b.pass_id
                 where b.client_id = test.id('dan_client') and b.session_id = test.id('s_eve')), 'Unlimited', 'unlimited membership is used before a pack');
select test.eq((select credits_used from public.passes where client_id = test.id('dan_client') and kind = 'pack'), 0, '...and the pack is untouched');

-- ...but the client can choose a specific pass
select test.login('dan');
select public.book_class(test.id('s_thu'), (select id from public.passes where client_id = test.id('dan_client') and kind = 'pack'));
select test.admin();
select test.eq((select credits_used from public.passes where client_id = test.id('dan_client') and kind = 'pack'), 1, 'client can pick a specific pass');

-- ---------------------------------------------------------------- priority: soonest expiring pack first
select test.login('fay');
select public.book_class(test.id('s_eve'));
select test.admin();
select test.eq((select pass_id from public.bookings where client_id = test.id('fay_client') and session_id = test.id('s_eve')),
               test.id('fay_old_pass'), 'pack expiring soonest is used first (unactivated pack last)');
-- Fay's old pack expires 27 Oct, so a class on 4 Nov can't use it -> new pack instead.
select test.admin();
update public.studio_settings set booking_window_days = 30;
select test.login('fay');
select public.book_class(test.id('s_far'));
select test.admin();
select test.eq((select pass_id from public.bookings where client_id = test.id('fay_client') and session_id = test.id('s_far')),
               test.id('fay_new_pass'), 'a pack that expires before the class is skipped');
select test.ok((select activated_at is not null from public.passes where id = test.id('fay_new_pass')), 'the new pack activates');
update public.studio_settings set booking_window_days = 14;

-- ---------------------------------------------------------------- membership: weekly credits (Mon-Sun Sydney)
select test.login('bob');   -- 2 classes per week
select test.eq(public.book_class(test.id('s_eve')) ->> 'outcome', 'booked', 'membership: 1st class this week');
select test.eq(public.book_class(test.id('s_thu')) ->> 'outcome', 'booked', 'membership: 2nd class this week');
select test.throws($$select public.book_class(test.id('s_fri'))$$, 'NO_CREDITS', 'membership: 3rd class in the same week -> NO_CREDITS');
select test.eq(public.book_class(test.id('s_next')) ->> 'outcome', 'booked', 'membership: next week has fresh credits');
select test.eq((public.credit_summary(test.id('bob_client'), test.id('s_fri')))::text, '[]', 'credit summary for a full week shows nothing usable');
select test.eq(public.credit_summary(test.id('bob_client'), test.id('s_next')) -> 0 ->> 'label', '1 of 2 left this week', 'credit summary label for next week');
select test.eq(public.credit_summary(test.id('bob_client')) -> 0 ->> 'label', '0 of 2 left this week', 'credit summary for this week');

-- Sunday night vs Monday morning are different weeks (Sydney time, not UTC).
select test.admin();
select test.mk_session('s_sun', 'mat', '2026-10-25 18:00+11', 14, 'julia'); -- Sunday 6pm AEDT = Sunday 07:00 UTC
select test.mk_session('s_mon_early', 'mat', '2026-10-26 00:30+11', 14, 'julia'); -- Monday 00:30 Sydney = Sunday 13:30 UTC
select test.ok(app.week_start('2026-10-25 18:00+11') = '2026-10-19' and app.week_start('2026-10-26 00:30+11') = '2026-10-26',
               'membership weeks are Mon-Sun in Sydney time');

-- ---------------------------------------------------------------- single class: used up
select test.login('gus');
select public.book_class(test.id('s_eve'));
select test.admin();
select test.eq((select status from public.passes where client_id = test.id('gus_client')), 'used_up', 'single class credit is used up');
select test.ok((select activated_at is not null and expires_at = activated_at + interval '61 days' from public.passes where client_id = test.id('gus_client')),
               'single class expires 61 days from first use');
select test.login('gus');
select test.throws($$select public.book_class(test.id('s_thu'))$$, 'NO_CREDITS', 'used up -> NO_CREDITS');
select test.admin();

-- ---------------------------------------------------------------- paused membership can't book
select test.login('bob');
select public.pause_pass((select id from public.passes where client_id = test.id('bob_client')), '2026-11-02', '2026-11-15');
select test.throws($$select public.pause_pass((select id from public.passes where client_id = test.id('bob_client')), '2026-11-02', '2026-11-04')$$,
                   'NOT_ALLOWED', 'pause must be at least a week');
select test.admin();
select test.mk_session('s_paused', 'mat', '2026-11-03 06:00+11', 14, 'julia');
update public.studio_settings set booking_window_days = 30;
select test.login('bob');
select test.throws($$select public.book_class(test.id('s_paused'))$$, 'NO_CREDITS', 'no booking while paused');
select public.resume_pass((select id from public.passes where client_id = test.id('bob_client')));
select test.eq(public.book_class(test.id('s_paused')) ->> 'outcome', 'booked', 'can book again after resuming');
select test.admin();
update public.studio_settings set booking_window_days = 14;

-- ---------------------------------------------------------------- staff bookings
select test.login('fran');
select test.eq(public.book_class(test.id('s_eve'), null, test.id('erin_client'), true, false, true) ->> 'outcome', 'booked',
               'staff can comp-book a client without a waiver or credit');
select test.ok(exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_eve'))) e
                        where e ->> 'client_id' = test.id('erin_client')::text and e -> 'flags' ? 'no_waiver'),
               'roster flags no_waiver');
select test.ok(exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_eve'))) e
                        where e ->> 'client_id' = test.id('erin_client')::text and e -> 'flags' ? 'first_class'),
               'roster flags first_class');
select test.ok(exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_eve'))) e
                        where e ->> 'client_id' = test.id('gus_client')::text and e -> 'flags' ? 'last_credit'),
               'roster flags last_credit');
select test.ok(exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_eve'))) e
                        where e ->> 'client_id' = test.id('fay_client')::text and e -> 'flags' ? 'pass_expiring'),
               'roster flags pass_expiring');
select test.at('2026-10-19 06:30+11');
select test.eq(public.book_class(test.id('s_past'), null, test.id('cara_client'), true, false, true) ->> 'outcome', 'booked',
               'staff can add someone during class');
select test.at('2026-10-19 08:00+11');
select test.throws($$select public.book_class(test.id('s_past'), null, test.id('dan_client'), true)$$, 'TOO_LATE', 'not after the class has finished');
select test.login('julia');
select test.throws($$select public.book_class(test.id('s_eve'), null, test.id('cara_client'), true, false, true)$$, 'NOT_ALLOWED',
                   'instructor cannot book into someone else''s class');
select test.admin();

-- ---------------------------------------------------------------- intro offer eligibility
select test.ok(public.is_intro_eligible(test.id('cara_client')), 'client with no passes is intro eligible');
select test.ok(not public.is_intro_eligible(test.id('alice_client')), 'client with a pass is not intro eligible');
select test.throws($$select public.checkout_cart(test.id('alice_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro'))), 'cash')$$,
                   'INTRO_NOT_ELIGIBLE', 'intro offer refused for existing clients');
select public.checkout_cart(test.id('cara_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_intro'))), 'cash');
select test.ok(not public.is_intro_eligible(test.id('cara_client')), 'intro offer is once only');
select test.login('cara');
select public.book_class(test.id('s_thu'));
select test.admin();
select test.ok((select expires_at = activated_at + interval '14 days' and credits is null from public.passes
                 where client_id = test.id('cara_client') and kind = 'intro'), 'intro: unlimited for 14 days from first booking');

-- notifications queued
select test.ok((select count(*) from public.notifications where kind = 'booking_confirmed') >= 8, 'booking confirmation emails are queued');
select test.ok((select payload ->> 'cancellation_policy' like 'If you cancel more than 3 hours%' from public.notifications where kind = 'booking_confirmed' limit 1),
               'confirmation email includes the cancellation policy');
select test.ok((select payload ->> 'when' from public.notifications n where kind = 'booking_confirmed' and payload ->> 'class_name' = 'Mat Essentials'
                 and (payload ->> 'starts_at')::timestamptz = '2026-10-21 18:00+11' limit 1) = '6:00pm Wed 21 Oct', 'email time formatted in Sydney time');

rollback;
