-- Studio cancels a class, schedule generation, POS, Stripe hooks, refunds, reports, sign-up linking.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- studio cancels a class (s_cancel: 2 spots)
select test.login('alice'); select public.book_class(test.id('s_cancel'));    -- pack
select test.login('dan');   select public.book_class(test.id('s_cancel'));    -- unlimited
select test.login('fay');   select public.book_class(test.id('s_cancel'));    -- waitlisted
select test.admin();
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, 'Alice used a credit');
select test.login('fran');
select test.eq(public.cancel_session(test.id('s_cancel'), 'Instructor unwell'), 3, 'cancel_session touches all 3 bookings');
select test.admin();
select test.eq((select status from public.class_sessions where id = test.id('s_cancel')), 'cancelled', 'class is cancelled');
select test.eq((select count(*) from public.bookings where session_id = test.id('s_cancel') and status <> 'removed')::int, 0, 'every booking is removed');
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 0, 'Alice''s credit is refunded');
select test.eq((select credits_used from public.passes where id = test.id('fay_old_pass')), 1, 'waitlisted Fay was never charged');
select test.eq((select count(*) from public.notifications where kind = 'class_cancelled')::int, 3, 'everyone is told the class is cancelled');
select test.eq((select payload ->> 'cancel_reason' from public.notifications where kind = 'class_cancelled' limit 1), 'Instructor unwell', 'email includes the reason');
select test.login('alice');
select test.throws($$select public.book_class(test.id('s_cancel'))$$, 'CLASS_CANCELLED', 'can''t book a cancelled class');
select test.admin();
select test.eq(public.cancel_session(test.id('s_cancel'), 'again'), 0, 'cancelling twice is harmless');

-- ---------------------------------------------------------------- generate_sessions (timezone + DST + idempotent)
insert into public.schedule_templates (id, class_type_id, weekday, start_time, instructor_id, starts_on)
values ('7e000000-0000-4000-8000-000000000001', test.id('mat'), 1, '06:00', test.id('julia_staff'), '2026-09-01');
select test.login('fran');
select test.eq(public.generate_sessions('2026-09-28', '2026-10-11'), 2, 'two Mondays generated');
select test.eq(public.generate_sessions('2026-09-28', '2026-10-11'), 0, 'running again creates nothing (idempotent)');
select test.admin();
select test.eq((select starts_at from public.class_sessions where template_id = '7e000000-0000-4000-8000-000000000001' and template_date = '2026-09-28'),
               '2026-09-27 20:00+00'::timestamptz, 'Mon 28 Sep 6:00am AEST = 20:00 UTC Sunday');
select test.eq((select starts_at from public.class_sessions where template_id = '7e000000-0000-4000-8000-000000000001' and template_date = '2026-10-05'),
               '2026-10-04 19:00+00'::timestamptz, 'Mon 5 Oct 6:00am AEDT (after DST starts) = 19:00 UTC Sunday');
select test.eq((select ends_at - starts_at from public.class_sessions where template_date = '2026-10-05'), interval '55 minutes', 'duration from class type');
select test.eq((select capacity from public.class_sessions where template_date = '2026-10-05'), 14, 'capacity from class type default');
-- moving a generated class doesn't make generate_sessions create a duplicate
update public.class_sessions set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where template_date = '2026-10-05';
select test.eq(public.generate_sessions('2026-10-05', '2026-10-05'), 0, 'moved class is not re-created');
select test.login('julia');
select test.throws($$select public.generate_sessions('2026-10-12', '2026-10-18')$$, 'NOT_ALLOWED', 'instructors can''t generate the schedule');
select test.admin();

-- ---------------------------------------------------------------- POS cart
select test.login('fran');
create temp table cart as select public.checkout_cart(test.id('cara_client'),
  jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4')), jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2)),
  'card_reader', 500, 'Birthday discount') as j;
select test.admin();
select test.eq((select (j -> 'sale' ->> 'total_cents')::int from cart), 10000 + 4000 - 500, 'cart total with discount');
select test.eq((select jsonb_array_length(j -> 'passes') from cart), 1, 'cart created one pass');
select test.eq((select jsonb_array_length(j -> 'sale' -> 'items') from cart), 3, 'cart lines: pack, socks, discount');
select test.eq((select (j -> 'sale' ->> 'staff_id')::uuid from cart), test.id('fran_staff'), 'sale records the staff member');
select test.login('fran');
select test.throws($$select public.checkout_cart(null, jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'cash')$$,
                   'INVALID', 'class passes need a client');
select test.eq((public.checkout_cart(null, jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'))), 'cash') -> 'sale' ->> 'total_cents')::int,
               2000, 'walk-in retail sale without a client');
select test.login('libby');
update public.products set stock = 1 where id = test.id('p_socks');
select test.login('fran');
select test.throws($$select public.checkout_cart(null, jsonb_build_array(jsonb_build_object('product_id', test.id('p_socks'), 'qty', 3)), 'cash')$$,
                   'OUT_OF_STOCK', 'can''t sell more than in stock');

-- refunds
select test.eq((public.refund_sale((select (j -> 'sale' ->> 'id')::uuid from cart), 2000, false, 'Socks too small') ->> 'refunded_cents')::int, 2000, 'partial refund');
select test.throws($$select public.refund_sale((select (j -> 'sale' ->> 'id')::uuid from cart), 99999)$$, 'INVALID', 'can''t refund more than the sale');
select public.refund_sale((select (j -> 'sale' ->> 'id')::uuid from cart), null, true, 'Changed mind');
select test.admin();
select test.eq((select refunded_cents from public.sales where id = (select (j -> 'sale' ->> 'id')::uuid from cart)), 13500, 'refund the rest');
select test.eq((select status from public.passes where sale_id = (select (j -> 'sale' ->> 'id')::uuid from cart)), 'cancelled', 'refund can cancel the pass');

-- ---------------------------------------------------------------- adjust pass
select test.login('fran');
select public.adjust_pass((select id from public.passes where client_id = test.id('alice_client')), 2, null, false, 'Goodwill for cancelled class');
select test.throws($$select public.adjust_pass((select id from public.passes where client_id = test.id('alice_client')), 1, null, false, '')$$,
                   'INVALID', 'adjustments need a reason');
select test.admin();
select test.eq((select credits from public.passes where client_id = test.id('alice_client')), 6, 'credits added');
select test.eq((select reason from public.pass_adjustments limit 1), 'Goodwill for cancelled class', 'adjustment logged');

-- ---------------------------------------------------------------- Stripe webhook hooks (service role)
select test.service();
create temp table buy as select public.create_pass_from_purchase(test.id('erin_client'), test.id('p_intro'), 4900, 'card_online', 'cs_test_1', 'pi_test_1') as j;
select test.eq((select j -> 'pass' ->> 'kind' from buy), 'intro', 'Stripe purchase creates the pass');
select test.eq((select (j ->> 'duplicate')::boolean from buy), false, '...first time');
select test.eq((public.create_pass_from_purchase(test.id('erin_client'), test.id('p_intro'), 4900, 'card_online', 'cs_test_1', 'pi_test_1') ->> 'duplicate')::boolean,
               true, 'webhook retry is idempotent');
select test.eq((select count(*) from public.passes where client_id = test.id('erin_client'))::int, 1, '...still one pass');
-- membership via subscription
select public.create_pass_from_purchase(test.id('gus_client'), test.id('p_week1'), 2200, 'card_online', 'cs_test_2', null, 'in_test_1', 'sub_test_1', '2026-10-26 08:00+11');
select test.eq((select next_billing_at from public.passes where stripe_subscription_id = 'sub_test_1'), '2026-10-26 08:00+11'::timestamptz, 'subscription pass has next billing date');
select public.record_membership_payment('sub_test_1', 'in_test_2', 2200, '2026-11-02 08:00+11', 'pi_test_2');
select public.record_membership_payment('sub_test_1', 'in_test_2', 2200, '2026-11-02 08:00+11', 'pi_test_2');
select test.eq((select count(*) from public.sales where stripe_invoice_id = 'in_test_2')::int, 1, 'renewal recorded once');
select test.eq((select next_billing_at from public.passes where stripe_subscription_id = 'sub_test_1'), '2026-11-02 08:00+11'::timestamptz, 'renewal extends the membership');
select public.record_stripe_refund('pi_test_1', 2000, false, 'part');
select public.record_stripe_refund('pi_test_1', 4900, true, 'rest');
select public.record_stripe_refund('pi_test_1', 4900);   -- webhook arriving after: no double count
select test.eq((select refunded_cents from public.sales where stripe_payment_intent_id = 'pi_test_1'), 4900, 'Stripe refund recorded once (absolute total)');
select test.eq((select status from public.passes where client_id = test.id('erin_client')), 'cancelled', 'Stripe refund can cancel the pass');
select public.end_membership_subscription('sub_test_1');
select test.eq((select status from public.passes where stripe_subscription_id = 'sub_test_1'), 'cancelled', 'subscription deleted -> pass cancelled');
select test.admin();

-- cancel membership: usable until next billing date
select test.login('bob');
select public.book_class(test.id('s_eve'));  -- activates; next_billing_at = now + 7 days
select public.cancel_membership((select id from public.passes where client_id = test.id('bob_client')));
select test.admin();
select test.ok((select cancel_at_period_end and status = 'cancelled' and next_billing_at = '2026-10-26 08:00+11' from public.passes where client_id = test.id('bob_client')),
               'cancelled membership: status cancelled, runs until the next billing date');
select test.login('bob');
select test.eq(public.book_class(test.id('s_thu')) ->> 'outcome', 'booked', 'cancelled membership can still book before the next billing date');
select test.eq(public.credit_summary(test.id('bob_client')) -> 0 ->> 'expiresAt', '2026-10-26T08:00:00+11:00', 'credit summary shows when it ends');
select test.admin();
update public.studio_settings set booking_window_days = 30;
select test.login('bob');
select test.throws($$select public.book_class(test.id('s_far'))$$, 'NO_CREDITS', '...and can''t be used after it');
select test.admin();
update public.studio_settings set booking_window_days = 14;

-- ---------------------------------------------------------------- report
-- Put some attendance on the books: a past class with check-ins.
select test.at('2026-10-19 05:00+11');
select test.login('alice'); select public.book_class(test.id('s_past'));
select test.login('dan');   select public.book_class(test.id('s_past'));
select test.login('julia');
select test.at('2026-10-19 06:05+11');
select public.check_in(x.bid) from (select id as bid from public.bookings where session_id = test.id('s_past') and client_id = test.id('alice_client')) x;
select public.mark_rest_no_show(test.id('s_past'));
select test.at('2026-10-19 08:00+11');
select test.login('libby');
create temp table rep as select public.report('2026-10-12', '2026-10-25') as j;
select test.admin();
select test.ok((select (j ->> 'revenue_cents')::int > 0 from rep), 'report: revenue');
select test.eq((select (j ->> 'classes_run')::int from rep), 1, 'report: classes run (past, not cancelled)');
select test.eq((select (j ->> 'attended')::int from rep), 1, 'report: attended');
select test.eq((select (j ->> 'no_shows')::int from rep), 1, 'report: no-shows');
select test.eq((select (j ->> 'total_bookings')::int from rep), 2, 'report: total bookings');
select test.eq((select (j ->> 'avg_fill_pct')::numeric from rep), 14.3, 'report: fill % (2 of 14)');
select test.eq((select j -> 'by_instructor' -> 0 ->> 'name' from rep), 'Julia', 'report: by instructor');
select test.eq((select (j -> 'by_instructor' -> 0 ->> 'pay_cents')::int from rep), 6000, 'report: owner sees pay');
select test.eq((select j -> 'top_slots' -> 0 ->> 'label' from rep), 'Mon 6:00am', 'report: top slot label in Sydney time');
select test.ok((select (j -> 'revenue_by_method' ->> 'cash')::int > 0 from rep), 'report: revenue by method');
select test.ok((select (j -> 'revenue_by_kind' ->> 'pack')::int > 0 from rep), 'report: revenue by kind');
select test.ok((select (j ->> 'refunds_cents')::int = 4900 + 13500 from rep), 'report: refunds');
select test.ok((select (j ->> 'active_memberships')::int >= 1 from rep), 'report: active memberships');

-- ---------------------------------------------------------------- sign-up linking
insert into public.clients (first_name, last_name, email, source, momence_id) values ('Imogen', 'Imported', 'imogen@example.test', 'import', 'm-1');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-4000-8000-0000000000aa', 'imogen@example.test', '{"first_name":"Imo"}');
select test.eq((select count(*) from public.clients where lower(email) = 'imogen@example.test')::int, 1, 'unconfirmed sign-up with an imported email doesn''t duplicate');
select test.ok((select user_id is null from public.clients where email = 'imogen@example.test'), '...and doesn''t link until the email is confirmed');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000aa';
select test.eq((select user_id from public.clients where email = 'imogen@example.test'), '00000000-0000-4000-8000-0000000000aa'::uuid, 'confirmed -> linked to the imported client (history kept)');
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-4000-8000-0000000000bb', 'new@example.test', '{"first_name":"Nina","last_name":"New","phone":"0400 111 222"}');
select test.eq((select first_name || ' ' || last_name || ' ' || phone from public.clients where user_id = '00000000-0000-4000-8000-0000000000bb'),
               'Nina New 0400 111 222', 'brand new sign-up creates a client from the sign-up details');
-- staff row first, then the login
insert into public.staff (name, email, role) values ('Newt', 'newt@example.test', 'instructor');
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000cc', 'newt@example.test', null);
select test.eq((select count(*) from public.clients where user_id = '00000000-0000-4000-8000-0000000000cc')::int, 0, 'no client row is made for a staff email');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000cc';
select test.ok((select user_id = '00000000-0000-4000-8000-0000000000cc' from public.staff where email = 'newt@example.test'), 'staff login links to the staff row by email on confirmation');
-- login first, then the staff row
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-4000-8000-0000000000dd', 'otto@example.test', now());
insert into public.staff (name, email, role) values ('Otto', 'Otto@Example.test', 'front_desk');
select test.ok((select user_id = '00000000-0000-4000-8000-0000000000dd' from public.staff where name = 'Otto'), 'adding a staff row links an existing login');
select test.login('fran');
select test.eq(public.whoami() ->> 'role', 'front_desk', 'whoami for staff');
select test.login('alice');
select test.eq(public.whoami() ->> 'kind', 'client', 'whoami for clients');
select test.admin();

-- ---------------------------------------------------------------- demo-parity behaviours (0005)
select test.at('2026-10-19 08:00+11');
select test.login('dan'); select public.book_class(test.id('s_next'));         -- unlimited membership, Mon 26 Oct
select public.pause_pass((select id from public.passes where client_id = test.id('dan_client') and kind = 'membership'), '2026-10-26', '2026-11-01');
select test.admin();
select test.eq((select status from public.bookings where client_id = test.id('dan_client') and session_id = test.id('s_next')), 'cancelled',
               'pausing cancels bookings inside the pause');
select test.login('fran');
select test.throws($$select public.adjust_pass((select id from public.passes where client_id = test.id('fay_client') and activated_at is not null), -4, null, false, 'oops')$$,
                   'INVALID', 'can''t adjust below credits already used');
select test.admin();
select test.login('fay'); select public.book_class(test.id('s_next'));
select test.login('fran');
select public.refund_sale((select sale_id from public.passes where id = test.id('fay_old_pass')), null, true, 'moving away');
select test.admin();
select test.eq((select status from public.bookings where client_id = test.id('fay_client') and session_id = test.id('s_next')), 'cancelled',
               'refund + cancel pass cancels upcoming bookings on it');
select test.login('cara');
insert into public.class_interest (client_id, class_type_id) values (test.id('cara_client'), test.id('sculpt'));
select test.throws($$insert into public.class_interest (client_id, class_type_id) values (test.id('alice_client'), test.id('sculpt'))$$, '42501', 'can''t register interest for someone else');
select test.login('mia');
select test.eq((select count(*) from public.class_interest)::int, 1, 'staff see who registered interest');
select test.admin();

-- ---------------------------------------------------------------- email outbox claiming
select test.login('alice');
select test.throws($$select * from public.claim_notifications()$$, '42501', 'clients can''t read the email outbox');
select test.service();
create temp table c1 as select * from public.claim_notifications(5);
select test.eq((select count(*) from c1)::int, 5, 'claim hands out pending emails');
select test.eq((select count(*) from public.claim_notifications(100) where id in (select id from c1))::int, 0, 'claimed emails aren''t handed out twice');
select public.finish_notification((select id from c1 order by id asc limit 1));
select public.finish_notification((select id from c1 order by id desc limit 1), 'Resend said no');
select test.admin();
select test.eq((select count(*) from public.notifications where sent_at is not null)::int, 1, 'sent email marked');
select test.ok((select error = 'Resend said no' and claimed_at is null from public.notifications where id = (select id from c1 order by id desc limit 1)),
               'failed email is released for a retry');

rollback;
