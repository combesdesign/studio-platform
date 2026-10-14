-- 0006: client self-edits, profile photos, register interest, front desk who teaches (Grace P),
-- permissions vs src/domain/permissions.ts, classes from the timetable, report shape.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- client edits their own record
select test.login('erin');
select test.eq((public.submit_waiver(test.id('erin_client'), '{"answers":{"Any injuries?":"No"},"injuries":"Sore wrist"}'::jsonb)
                ->> 'waiver_signed_at') is not null, true, 'client can sign their own waiver (submit_waiver is trusted)');
select test.admin();
select test.ok((select waiver_signed_at is not null and health_form ->> 'injuries' = 'Sore wrist' and injuries = 'Sore wrist'
                  from public.clients where id = test.id('erin_client')), '...and it is saved with the health form');

select test.login('alice');
update public.clients
   set first_name = 'Alicia', email = 'hacker@example.test', waiver_signed_at = null, health_form = '{"hacked":true}',
       source = 'import', archived = true, intro_ineligible = true, momence_id = 'm-999', created_at = '2020-01-01'
 where id = test.id('alice_client');
select test.throws($$insert into public.client_notes (client_id, notes) values (test.id('alice_client'), 'VIP, never charge')$$,
                   '42501', 'client cannot write staff notes');
select test.admin();
select test.ok((select first_name = 'Alicia' and email = 'alice@example.test' and waiver_signed_at is not null and health_form is null
                       and source = 'app' and not archived and not intro_ineligible and momence_id is null
                       and created_at > '2026-01-01' from public.clients where id = test.id('alice_client')),
               'client edits: name saved; email, waiver, health form, source, archived and other staff fields unchanged');

-- ---------------------------------------------------------------- profile photos (Storage bucket 'avatars')
select test.ok((select public from storage.buckets where id = 'avatars'), 'avatars bucket exists and is public');
select test.login('alice');
insert into storage.objects (bucket_id, name) values ('avatars', test.id('alice_client') || '/1760000000000.jpg');
select test.throws($$insert into storage.objects (bucket_id, name) values ('avatars', test.id('bob_client') || '/1.jpg')$$,
                   '42501', 'client cannot upload into someone else''s photo folder');
select test.throws($$insert into storage.objects (bucket_id, name) values ('avatars', 'loose.jpg')$$,
                   '42501', 'client cannot upload outside a folder');
update public.clients set photo_url = 'https://abc.supabase.co/storage/v1/object/public/avatars/' || test.id('alice_client') || '/1760000000000.jpg'
 where id = test.id('alice_client');
select test.throws($$update public.clients set photo_url = 'https://evil.example/x.jpg' where id = test.id('alice_client')$$,
                   'INVALID', 'client cannot point their photo somewhere else');
select test.login('bob');
delete from storage.objects where name like test.id('alice_client') || '/%';
select test.anon();
select test.eq((select count(*) from storage.objects where bucket_id = 'avatars')::int, 1, 'photos are public (anon can read)...');
select test.admin();
select test.ok((select photo_url like '%/avatars/' || test.id('alice_client') || '/%' from public.clients where id = test.id('alice_client')),
               '...the client saved their photo URL, and bob could not delete alice''s photo');
select test.throws($$update public.clients set photo_url = 'data:image/jpeg;base64,AAAA' where id = test.id('bob_client')$$,
                   '23514', 'data: URLs are never stored in Postgres');
select test.login('fran');
insert into storage.objects (bucket_id, name) values ('avatars', test.id('bob_client') || '/2.jpg');
update public.clients set photo_url = 'https://abc.supabase.co/storage/v1/object/public/avatars/' || test.id('bob_client') || '/2.jpg'
 where id = test.id('bob_client');
select test.admin();
select test.ok((select photo_url is not null from public.clients where id = test.id('bob_client')), 'front desk can set any client''s photo');

-- ---------------------------------------------------------------- staff notes need client_staff_notes
select test.login('julia');
select test.eq((select count(*) from public.client_notes)::int, 0, 'instructor cannot read staff notes');
update public.clients set first_name = 'Changed' where id = test.id('bob_client');
select test.admin();
select test.eq((select first_name from public.clients where id = test.id('bob_client')), 'Bob', 'instructor cannot edit client details (no clients_edit)');
select test.login('fran');
insert into public.client_notes (client_id, notes) values (test.id('bob_client'), 'Prefers the back row');
select test.admin();
select test.eq((select notes from public.client_notes where client_id = test.id('bob_client')), 'Prefers the back row', 'front desk can write staff notes');

-- ---------------------------------------------------------------- login email changes flow through
update auth.users set email = 'gus.new@example.test' where id = test.id('gus');
select test.eq((select email from public.clients where id = test.id('gus_client')), 'gus.new@example.test', 'changing the login email updates the client');
update public.clients set archived = true where id = test.id('gus_client');
select test.login('gus');
select test.ok(public.whoami() is null, 'archived clients are signed out (whoami is empty)');
select test.admin();

-- ---------------------------------------------------------------- register interest
select test.login('cara');
select test.eq(public.register_interest(test.id('sculpt')) ->> 'class_type_id', test.id('sculpt')::text, 'client registers interest');
select test.eq(public.register_interest(test.id('sculpt')) ->> 'client_id', test.id('cara_client')::text, 'registering twice is fine');
select test.throws($$select public.register_interest(test.id('sculpt'), test.id('alice_client'))$$, 'NOT_ALLOWED', 'client cannot register someone else');
select test.throws($$select public.register_interest(gen_random_uuid())$$, 'NOT_FOUND', 'unknown class');
select test.throws($$select public.list_class_interest()$$, 'NOT_ALLOWED', 'clients cannot see the interest list');
select test.eq((select count(*) from public.class_interest)::int, 1, 'client sees only their own interest row');
select test.login('alice');
select test.eq((select count(*) from public.class_interest)::int, 0, '...and other clients see none of it');
select test.anon();
select test.throws($$select public.register_interest(test.id('sculpt'))$$, '42501', 'anon cannot register interest');
select test.login('fran');
select public.register_interest(test.id('sculpt'), test.id('dan_client'));
select test.eq(jsonb_array_length(public.list_class_interest(test.id('sculpt'))), 2, 'front desk can register a client and see the list');
select test.login('julia');
select test.eq(public.list_class_interest() -> 0 ->> 'class_name', 'Strength + Sculpt', 'any staff can read who is interested');
select test.admin();

-- ---------------------------------------------------------------- Grace P: front desk who teaches
update public.staff set email = 'gracep@example.test' where name = 'Grace P';
insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ('gracep@example.test', '{"first_name":"Grace"}', now());
insert into test.ids select 'gracep', id from auth.users where email = 'gracep@example.test';
insert into test.ids select 'gracep_staff', id from public.staff where name = 'Grace P';
insert into public.staff_pay (staff_id, pay_per_class_cents) values (test.id('gracep_staff'), 5500);
select test.eq((select role from public.staff where name = 'Grace P'), 'front_desk', 'Grace P is front desk');
select test.ok((select user_id = test.id('gracep') from public.staff where name = 'Grace P'), 'Grace P''s login linked to her staff row');

select test.at('2026-10-19 05:00+11');
select test.mk_session('s_mums_past', 'mums', '2026-10-19 07:00+11', 10, 'gracep');
select test.login('alice'); select public.book_class(test.id('s_mums_past'));
select test.login('dan');   select public.book_class(test.id('s_past'));
select test.at('2026-10-19 08:00+11');
select test.login('gracep');
select public.check_in(b.id) from public.bookings b where b.session_id = test.id('s_mums_past');
select test.eq(public.check_in((select id from public.bookings where session_id = test.id('s_past'))) ->> 'status', 'checked_in',
               'front desk checks in on someone else''s class (roster_all)');
select test.ok((select (j ->> 'revenue_cents')::int = 0 and not exists (select 1 from jsonb_array_elements(j -> 'by_instructor') x where (x ->> 'pay_cents')::int <> 0)
                  from (select public.report('2026-10-12', '2026-10-25') j) r), 'front desk report: no revenue, no pay');
select test.eq((select count(*) from public.staff_pay)::int, 0, 'front desk cannot read pay rates');
select test.eq((select count(*) from public.client_notes where client_id = test.id('bob_client'))::int, 1, 'front desk reads staff notes');
select test.ok((public.adjust_pass((select id from public.passes where client_id = test.id('alice_client') limit 1), 1, null, false, 'goodwill') ->> 'credits')::int = 5,
               'front desk can adjust passes (passes_manage)');
insert into public.class_types (name, duration_min) values ('Reformer taster', 45);
select test.ok(exists (select 1 from public.class_types where name = 'Reformer taster'), 'front desk can add class types (schedule)');
select test.throws($$insert into public.products (kind, name, price_cents) values ('retail', 'Mat', 5000)$$, '42501', 'front desk cannot add products');
update public.products set price_cents = 1 where id = test.id('p_week1');
update public.studio_settings set cancel_window_hours = 0;
select test.throws($$insert into public.staff (name, email, role) values ('Pal', 'pal@example.test', 'instructor')$$, '42501', 'front desk cannot add staff');
select test.admin();
select test.ok((select price_cents = 2200 from public.products where id = test.id('p_week1')), 'front desk''s product change was ignored');
select test.ok((select cancel_window_hours = 3 from public.studio_settings), 'front desk''s settings change was ignored');

select test.login('libby');
create temp table rep as select public.report('2026-10-12', '2026-10-25') as j;
select test.admin();
select test.ok((select exists (select 1 from jsonb_array_elements(j -> 'by_instructor') x
                               where x ->> 'staff_id' = test.id('gracep_staff')::text and (x ->> 'classes')::int = 1
                                 and (x ->> 'attendees')::int = 1 and (x ->> 'pay_cents')::int = 5500) from rep),
               'report pays Grace P for the class she taught (by instructor_id, not role)');
select test.ok((select (j ->> 'classes_run')::int = 2 and (j -> 'by_instructor' -> 0 ->> 'classes')::int = 1 from rep), 'report: two classes run');
select test.login('mia');
select test.ok((select (x ->> 'pay_cents')::int = 5500 from jsonb_array_elements(public.report('2026-10-12', '2026-10-25') -> 'by_instructor') x
                 where x ->> 'staff_id' = test.id('gracep_staff')::text), 'manager sees pay in reports (reports_pay)');
select test.admin();

-- revenue by kind adds up to revenue, discounts and all (like allocateSale)
select public.checkout_cart(test.id('cara_client'),
  jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack8')), jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2)),
  'card_reader', 2300);
select test.login('libby');
select test.ok((select (j ->> 'revenue_cents')::int = (select sum(v::int) from jsonb_each_text(j -> 'revenue_by_kind') e(k, v))
                  from (select public.report('2026-10-12', '2026-10-25') j) x), 'report: revenue by kind adds up to revenue (discount spread)');
select test.ok((select (j -> 'revenue_by_kind' ->> 'retail')::int = 3600
                  from (select public.report('2026-10-19', '2026-10-19') j) x), 'report: discount spread in proportion (socks 4000 -> 3600)');
select test.admin();

-- ---------------------------------------------------------------- classes from the weekly timetable
select test.login('fran');
insert into public.schedule_templates (id, class_type_id, weekday, start_time, instructor_id, starts_on)
values ('7e000000-0000-4000-8000-000000000001', test.id('mat'), 2, '06:00', test.id('gracep_staff'), '2026-10-19');
select test.eq(public.ensure_sessions('2026-10-19', '2026-11-08'), 3, 'front desk: classes made from the new weekly slot');
select test.login('alice');
select test.eq(public.ensure_sessions('2026-10-01', '2026-11-15'), 1, 'client looking further ahead fills in the next week (never the past)');
select test.eq(public.ensure_sessions('2026-10-01', '2026-11-15'), 0, '...and it is idempotent');
select test.eq(public.book_class((select id from public.class_sessions where template_id = '7e000000-0000-4000-8000-000000000001'
                                   and template_date = '2026-10-20')) ->> 'outcome', 'booked', 'book the first one');
select test.login('fran');
update public.schedule_templates set start_time = '07:00' where id = '7e000000-0000-4000-8000-000000000001';
select public.refresh_template_sessions('7e000000-0000-4000-8000-000000000001');
select test.admin();
select test.eq((select array_agg(to_char(starts_at at time zone 'Australia/Sydney', 'MM-DD HH24:MI') order by starts_at)
                  from public.class_sessions where template_id = '7e000000-0000-4000-8000-000000000001'),
               array['10-20 06:00', '10-27 07:00', '11-03 07:00', '11-10 07:00'], 'editing a slot moves unbooked future classes; booked ones keep their time');
select test.login('julia');
select test.throws($$select public.refresh_template_sessions('7e000000-0000-4000-8000-000000000001')$$, 'NOT_ALLOWED', 'instructors cannot change the timetable');
select test.login('fran');
select public.delete_template('7e000000-0000-4000-8000-000000000001');
select test.admin();
select test.eq((select count(*) from public.class_sessions where starts_at > '2026-10-19' and starts_at::date between '2026-10-20' and '2026-10-21'
                  and instructor_id = test.id('gracep_staff') and template_id is null)::int, 1,
               'deleting a slot keeps the booked class as a one-off');
select test.eq((select count(*) from public.class_sessions where instructor_id = test.id('gracep_staff') and starts_at > '2026-10-21')::int, 0,
               '...and removes the unbooked future ones');

-- ---------------------------------------------------------------- Stripe membership cancelled before first use
insert into public.passes (client_id, kind, name, credits, billing_interval, stripe_subscription_id, next_billing_at)
values (test.id('gus_client'), 'membership', '1 class per week', 1, 'week', 'sub_gus', '2026-10-25 09:00+11');
update public.clients set archived = false where id = test.id('gus_client');
select test.login('gus');
select public.cancel_membership((select id from public.passes where stripe_subscription_id = 'sub_gus'));
select test.eq(public.book_class(test.id('s_thu')) ->> 'outcome', 'booked', 'paid-up Stripe membership still works after cancelling (never used)');
select test.admin();
select test.eq((select next_billing_at from public.passes where stripe_subscription_id = 'sub_gus'), '2026-10-25 09:00+11'::timestamptz,
               '...until the end of the week already paid for');

-- ---------------------------------------------------------------- reminders
select test.login('dan'); select public.book_class(test.id('s_eve'));     -- booked days ahead
select test.at('2026-10-21 04:30+11');
select test.login('bob'); select public.book_class(test.id('s_early'));   -- booked 1.5h before a 6am class: no reminder
select test.admin();
select test.eq(public.queue_class_reminders(2), 0, 'no reminder for a booking made inside the 2 hours');
select test.at('2026-10-21 16:30+11');
select test.login('cara'); select public.book_class(test.id('s_eve'));   -- s_eve 6pm; booked 1.5h before
select test.admin();
select test.at('2026-10-21 16:31+11');
select test.ok(public.queue_class_reminders(2) >= 1, 'reminders go out for earlier bookings about 2 hours before');
select test.ok((select payload ->> 'cancellation_policy' like 'If you cancel%' from public.notifications where kind = 'class_reminder' limit 1),
               'reminder email carries the cancellation policy');
select test.ok(not exists (select 1 from public.notifications n where kind = 'class_reminder' and n.client_id = test.id('cara_client')),
               '...but not for the person who just booked');

rollback;
