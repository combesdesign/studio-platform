-- Row level security: who can see and change what.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- Give Alice and Bob a booking each, plus a staff note on Alice, so there's something to hide.
select test.login('alice'); select public.book_class(test.id('s_eve'));
select test.login('bob');   select public.book_class(test.id('s_eve'));
select test.admin();
insert into public.client_notes (client_id, notes) values (test.id('alice_client'), 'Paid cash, owes $10');
update public.clients set injuries = 'Dodgy left knee' where id = test.id('alice_client');

-- ---------------------------------------------------------------- client isolation
select test.login('alice');
select test.eq((select count(*) from public.clients)::int, 1, 'client sees only their own client row');
select test.eq((select id from public.clients), test.id('alice_client'), '...and it is their own');
select test.eq((select count(*) from public.bookings)::int, 1, 'client sees only their own bookings');
select test.eq((select count(*) from public.passes where client_id <> test.id('alice_client'))::int, 0, 'client sees no one else''s passes');
select test.eq((select count(*) from public.sales where client_id <> test.id('alice_client'))::int, 0, 'client sees no one else''s sales');
select test.eq((select count(*) from public.sales)::int, 1, 'client sees their own sale');
select test.eq((select count(*) from public.sale_items)::int, 1, 'client sees their own sale items');
select test.eq((select count(*) from public.client_notes)::int, 0, 'client cannot read staff notes');
select test.eq((select count(*) from public.staff)::int, 0, 'client cannot read staff table (emails, phones)');
select test.eq((select count(*) from public.staff_pay)::int, 0, 'client cannot read pay rates');
select test.ok((select count(*) from public.staff_public) >= 5, 'client can read public staff profiles');
select test.eq((select count(*) from public.audit_log)::int, 0, 'client cannot read the audit log');

-- writes
select test.throws($$insert into public.passes (client_id, kind, name, credits) values (test.id('alice_client'), 'pack', 'Free pack', 100)$$,
                   '42501', 'client cannot insert a pass');
select test.throws($$update public.passes set credits = 100$$, '42501', 'client cannot edit passes');
select test.throws($$insert into public.sales (client_id, total_cents, method) values (test.id('alice_client'), 0, 'cash')$$,
                   '42501', 'client cannot insert a sale');
select test.throws($$insert into public.bookings (session_id, client_id, status) values (test.id('s_thu'), test.id('alice_client'), 'booked')$$,
                   '42501', 'client cannot insert a booking directly');
select test.throws($$select public.checkout_cart(test.id('alice_client'), '[{"product_id":"9a0d0000-0000-4000-8000-000000000013"}]', 'comp')$$,
                   'NOT_ALLOWED', 'client cannot use the till to give themselves a pack');
select test.throws($$select public.create_pass_from_purchase(test.id('alice_client'), test.id('p_pack8'), 0)$$,
                   '42501', 'client cannot call the Stripe purchase hook');
select test.throws($$select public.adjust_pass((select id from public.passes limit 1), 10, null, false, 'free credits')$$,
                   'NOT_ALLOWED', 'client cannot adjust their own pass');
select test.throws($$select public.refund_sale((select id from public.sales limit 1))$$, 'NOT_ALLOWED', 'client cannot refund');

update public.clients set first_name = 'Bobby' where id = test.id('bob_client');
update public.clients set phone = '0400 000 000', archived = true, intro_ineligible = true, waiver_signed_at = null
 where id = test.id('alice_client');
select test.admin();
select test.eq((select first_name from public.clients where id = test.id('bob_client')), 'Bob', 'client cannot edit another client');
select test.eq((select phone from public.clients where id = test.id('alice_client')), '0400 000 000', 'client can edit their own phone');
select test.ok((select not archived and not intro_ineligible and waiver_signed_at is not null from public.clients where id = test.id('alice_client')),
               'client cannot change staff-controlled fields on their row');

select test.login('alice');
select test.throws($$select public.cancel_booking((select id from public.bookings b where b.client_id = test.id('bob_client')))$$,
                   'NOT_FOUND', 'client cannot cancel someone else''s booking (sees NOT_FOUND)');
select test.admin();

-- ---------------------------------------------------------------- anon (public timetable)
select test.anon();
select test.ok((select count(*) from public.sessions_with_counts) >= 9, 'anon can read the timetable');
select test.eq((select booked_count from public.sessions_with_counts where id = test.id('s_eve')), 2, 'anon sees spot counts');
select test.eq((select spots_left from public.sessions_with_counts where id = test.id('s_eve')), 12, 'anon sees spots left');
select test.eq((select count(*) from public.bookings)::int, 0, 'anon cannot read bookings');
select test.eq((select count(*) from public.clients)::int, 0, 'anon cannot read clients');
select test.eq((select count(*) from public.passes)::int, 0, 'anon cannot read passes');
select test.eq((select count(*) from public.sales)::int, 0, 'anon cannot read sales');
select test.eq((select count(*) from public.products where kind = 'membership')::int, 4, 'anon can read the price list');
select test.ok((select count(*) from public.class_types) = 3, 'anon can read class types');
select test.ok((select name = 'Snowy Pilates Club' from public.studio_settings), 'anon can read studio settings (policies)');
select test.throws($$select public.book_class(test.id('s_eve'))$$, '42501', 'anon cannot book');
select test.throws($$select public.get_roster(test.id('s_eve'))$$, '42501', 'anon cannot read a roster');
select test.throws($$update public.class_sessions set capacity = 99$$, '42501', 'anon cannot edit classes');
select test.admin();
update public.products set active = false where id = test.id('p_socks');
select test.anon();
select test.eq((select count(*) from public.products where id = test.id('p_socks'))::int, 0, 'anon cannot see inactive products');
select test.admin();

-- ---------------------------------------------------------------- instructor
select test.login('julia');
select test.eq((select count(*) from public.sales)::int, 0, 'instructor cannot read sales');
select test.eq((select count(*) from public.sale_items)::int, 0, 'instructor cannot read sale items');
select test.eq((select count(*) from public.staff_pay)::int, 0, 'instructor cannot read pay rates');
select test.eq((select count(*) from public.client_notes)::int, 0, 'instructor cannot read staff notes');
select test.ok((select count(*) from public.passes) > 0, 'instructor can read passes (client profiles show them: clients_view)');
select test.throws($$insert into public.client_notes (client_id, notes) values (test.id('bob_client'), 'sneaky')$$, '42501', 'instructor cannot write staff notes');
select test.ok((select (j ->> 'revenue_cents')::int = 0 and j -> 'revenue_by_method' = '{}'::jsonb and (j ->> 'sales_count')::int = 0
                  from (select public.report('2026-10-01', '2026-10-31') j) x), 'instructor report has no revenue figures');
select test.throws($$select public.refund_sale((select id from public.sales limit 1))$$, 'NOT_ALLOWED', 'instructor cannot refund');
select test.eq((public.checkout_cart(null, '[{"product_id":"9a0d0000-0000-4000-8000-000000000032"}]', 'cash') -> 'sale' ->> 'total_cents')::int, 1500,
               'instructor can sell at the till (RULES: no refunds)');
update public.studio_settings set cancel_window_hours = 0;
select test.ok((select count(*) from public.clients) = 7, 'instructor can read client profiles');
select test.eq((select injuries from public.clients where id = test.id('alice_client')), 'Dodgy left knee', 'instructor can read injuries');
select test.eq((select count(*) from public.bookings)::int, 0, 'instructor sees no bookings for classes they don''t teach');
select test.throws($$select public.get_roster(test.id('s_eve'))$$, 'NOT_ALLOWED', 'instructor cannot see another instructor''s roster');
select test.eq(jsonb_typeof(public.get_roster(test.id('s_early'))), 'array', 'instructor can see their own roster');
select test.throws($$select public.cancel_session(test.id('s_thu'), 'sick')$$, 'NOT_ALLOWED', 'instructor cannot cancel classes');
select test.admin();
select test.eq((select cancel_window_hours from public.studio_settings), 3.00, 'instructor''s settings update was ignored');

-- ---------------------------------------------------------------- front desk
select test.login('fran');
select test.ok((select (j ->> 'revenue_cents')::int = 0 and (j ->> 'refunds_cents')::int = 0
                  from (select public.report('2026-10-01', '2026-10-31') j) x), 'front desk report has no revenue figures');
select test.eq((select count(*) from public.staff_pay)::int, 0, 'front desk cannot read pay rates');
select test.ok((select count(*) from public.sales) >= 5, 'front desk can see sales (POS)');
select test.eq((select notes from public.client_notes where client_id = test.id('alice_client')), 'Paid cash, owes $10', 'front desk can read staff notes');
select test.eq((select count(*) from public.bookings)::int, 2, 'front desk sees all bookings');
select test.eq(jsonb_array_length(public.get_roster(test.id('s_eve'))), 2, 'front desk can see any roster');
select test.ok((public.get_roster(test.id('s_eve')) -> 0 -> 'client' ->> 'staff_notes') is not null
            or (public.get_roster(test.id('s_eve')) -> 1 -> 'client' ->> 'staff_notes') is not null, 'front desk roster includes staff notes');
select test.admin();

select test.login('julia');
select test.ok(not exists (select 1 from jsonb_array_elements(public.get_roster(test.id('s_early'))) e where e -> 'client' ? 'staff_notes'),
               'instructor roster never includes staff notes');
select test.admin();

-- ---------------------------------------------------------------- manager vs owner
select test.login('mia');
select test.eq((select count(*) from public.staff_pay)::int, 3, 'manager can see pay rates (reports_pay)');
select test.throws($$insert into public.staff_pay (staff_id, pay_per_class_cents) values (test.id('fran_staff'), 9000)$$, '42501', 'manager cannot set pay rates (owner only)');
update public.staff_pay set pay_per_class_cents = 1 where staff_id = test.id('julia_staff');
select test.eq(jsonb_typeof(public.report('2026-10-01', '2026-10-31')), 'object', 'manager can run reports');
select test.throws($$update public.studio_settings set gst_registered = false$$, 'NOT_ALLOWED', 'manager cannot change GST registration');
select test.throws($$update public.studio_settings set abn = '12 345 678 901'$$, 'NOT_ALLOWED', 'manager cannot change the ABN');
update public.studio_settings set cancel_window_hours = 3, phone = '02 6452 0000';
select test.throws($$insert into public.staff (name, email, role) values ('Sneaky', 'sneaky@example.test', 'owner')$$, 'NOT_ALLOWED', 'manager cannot create an owner');
select test.throws($$update public.staff set role = 'manager' where role = 'owner'$$, 'NOT_ALLOWED', 'manager cannot demote the owner');
insert into public.staff (name, email, role) values ('New Teacher', 'newt@example.test', 'instructor');
select test.admin();
select test.eq((select phone from public.studio_settings), '02 6452 0000', 'manager can change normal settings');
select test.eq((select pay_per_class_cents from public.staff_pay where staff_id = test.id('julia_staff')), 6000, 'manager''s pay change was ignored');
select test.ok(exists (select 1 from public.staff where email = 'newt@example.test'), 'manager can add instructors');

select test.login('libby');
update public.studio_settings set abn = '12 345 678 901';
select test.eq((select count(*) from public.staff_pay)::int, 3, 'owner can read pay rates');
select test.ok(exists (select 1 from public.audit_log where entity = 'studio_settings'), 'owner can read the audit log');
select test.admin();
select test.eq((select abn from public.studio_settings), '12 345 678 901', 'owner can change the ABN');

-- ---------------------------------------------------------------- push tokens
select test.login('alice');
insert into public.push_tokens (user_id, token, platform) values (test.id('alice'), 'tok-alice', 'ios');
select test.throws($$insert into public.push_tokens (user_id, token, platform) values (test.id('bob'), 'tok-bob', 'ios')$$, '42501', 'cannot add a push token for someone else');
select test.login('bob');
select test.eq((select count(*) from public.push_tokens)::int, 0, 'cannot see other people''s push tokens');
select test.admin();

rollback;
