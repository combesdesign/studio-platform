-- Payroll (B4): cover requests, pay rules, timesheets, pay runs, and studio isolation.
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney. Snowy: Libby owner, Mia manager, Julia + Grace T instructors, Fran front desk.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create or replace function test.count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
grant execute on function test.studio(text), test.count(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- cover requests
select test.login('gracet');
select test.throws($$select public.payroll_request_cover(test.id('s_thu'), 'x')$$, 'NOT_ALLOWED', 'an instructor can''t ask for cover on someone else''s class');
select test.login('julia');
select test.throws($$select public.payroll_request_cover(test.id('s_past'))$$, 'TOO_LATE', 'no cover for a class that has started');
select (public.payroll_request_cover(test.id('s_thu'), '  Dentist  ') ->> 'id') as cover1 \gset
select test.admin();
insert into test.ids values ('cover1', :'cover1');
select test.login('julia');
select test.eq((select reason from public.payroll_cover_requests where id = test.id('cover1')), 'Dentist', 'the reason is kept (trimmed)');
select test.throws($$select public.payroll_request_cover(test.id('s_thu'))$$, 'ALREADY_REQUESTED', 'one live request per class');
select test.ok((select test.id('gracet_staff') = any(notified) and test.id('libby_staff') = any(notified) and not (test.id('julia_staff') = any(notified))
                  and not (test.id('fran_staff') = any(notified)) from public.payroll_cover_requests where id = test.id('cover1')),
               'teachers are notified (Grace T, Libby), not the requester or the front desk');
select test.admin();
select test.eq(test.count($$select 1 from public.payroll_outbox where kind = 'cover_requested' and payload ->> 'request_id' = test.id('cover1')::text$$),
               (select cardinality(notified) from public.payroll_cover_requests where id = test.id('cover1')),
               'an email is queued for each notified teacher');

select test.login('fran');
select test.eq((select (v ->> 'can_claim')::boolean from jsonb_array_elements(public.payroll_list_cover()) v where v ->> 'id' = test.id('cover1')::text), false,
               'front desk sees the request but can''t claim it');
select test.throws(format('select public.payroll_claim_cover(%L)', test.id('cover1')), 'NOT_ALLOWED', 'front desk claim refused');
select test.login('gracet');
select test.eq((select (v ->> 'can_claim')::boolean from jsonb_array_elements(public.payroll_list_cover()) v where v ->> 'id' = test.id('cover1')::text), true,
               'Grace T can claim');
select test.eq(public.payroll_claim_cover(test.id('cover1')) ->> 'status', 'claimed', 'Grace T claims it');
select test.throws(format('select public.payroll_decide_cover(%L, ''approve'')', test.id('cover1')), 'NOT_ALLOWED', 'instructors can''t approve');
select test.login('libby');
select test.throws(format('select public.payroll_claim_cover(%L)', test.id('cover1')), 'ALREADY_CLAIMED', 'only one claim at a time');
select test.login('mia');
select test.eq(public.payroll_decide_cover(test.id('cover1'), 'decline', 'Need a mat teacher') ->> 'status', 'open', 'the manager declines: open again');
select test.login('gracet');
select test.throws(format('select public.payroll_claim_cover(%L)', test.id('cover1')), 'NOT_ALLOWED', 'a declined claimer can''t claim again');
select test.login('libby');
select test.eq(public.payroll_claim_cover(test.id('cover1')) ->> 'status', 'claimed', 'Libby claims it');
select test.login('mia');
select test.eq(public.payroll_decide_cover(test.id('cover1'), 'approve') ->> 'status', 'approved', 'the manager approves');
select test.eq((select instructor_id from public.class_sessions where id = test.id('s_thu')), test.id('libby_staff'), 'approval changes the class''s instructor');
select test.throws(format('select public.payroll_cancel_cover(%L)', test.id('cover1')), 'ALREADY_COVERED', 'an approved request is done');
select test.eq(public.payroll_cover_for_session(test.id('s_thu')) ->> 'status', 'approved', 'cover for the class: the approved request');

-- settings + auto-approve
select test.login('julia');
select test.throws($$select public.payroll_update_settings('{"cover_auto_approve":true}')$$, 'NOT_ALLOWED', 'instructors can''t switch on auto-approve');
select test.login('mia');
select test.throws($$select public.payroll_update_settings('{"frequency":"fortnightly"}')$$, 'NOT_ALLOWED', 'only the owner sets the pay period');
select test.eq((public.payroll_update_settings('{"cover_auto_approve":true}') ->> 'cover_auto_approve')::boolean, true, 'a manager switches on auto-approve');
select test.login('gracet');
select (public.payroll_request_cover(test.id('s_eve')) ->> 'id') as cover2 \gset
select test.login('julia');
select test.eq(public.payroll_claim_cover(:'cover2') ->> 'status', 'approved', 'with auto-approve a claim goes straight through');
select test.eq((select instructor_id from public.class_sessions where id = test.id('s_eve')), test.id('julia_staff'), '...and Julia teaches it now');
select test.eq((select auto_approved from public.payroll_cover_requests where id = :'cover2'), true, '...recorded as auto-approved');
select test.login('gracet');
select (public.payroll_request_cover(test.id('s_cancel')) ->> 'id') as cover3 \gset
select test.eq(public.payroll_cancel_cover(:'cover3') ->> 'status', 'cancelled', 'the requester cancels their own request');
select test.throws($$update public.payroll_cover_requests set status = 'approved'$$, '42501', 'no direct writes to cover requests');

-- ---------------------------------------------------------------- pay rules (owner only)
select test.login('mia');
select test.throws($$select public.payroll_save_rule(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'flat', 'rate_cents', 9000))$$,
                   'NOT_ALLOWED', 'a manager can''t set pay rules');
select test.login('libby');
select test.eq((public.payroll_save_rule(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'tiered',
          'tiers', '[{"minAttendees":8,"payCents":6500},{"minAttendees":0,"payCents":5500}]'::jsonb)) -> 'tiers' -> 0 ->> 'minAttendees')::int, 0,
       'a tiered rule is saved with tiers in order');
select test.throws($$select public.payroll_save_rule(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'flat', 'rate_cents', 6000))$$,
                   'DUPLICATE_RULE', 'one all-classes rule per person');
select test.ok(public.payroll_save_rule(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'flat', 'rate_cents', 7000, 'class_type_id', test.id('mums')))
               ? 'id', 'a rule for one class type sits beside it');
select test.eq(public.payroll_save_rule(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'session', 'session_type', 'Private Duet!', 'rate_cents', 9000))
               ->> 'session_type', 'private_duet', 'session-type keys are cleaned');
select test.throws($$select public.payroll_save_rule(jsonb_build_object('staff_id', test.id('fran_staff'), 'kind', 'hourly', 'rate_cents', 0))$$,
                   'INVALID', 'an hourly rule needs a rate');
select test.ok(public.payroll_save_rule(jsonb_build_object('staff_id', test.id('fran_staff'), 'kind', 'hourly', 'rate_cents', 3000, 'earnings_rate', 'Front desk hours'))
               ? 'id', 'front desk hourly rule');
select test.throws($$insert into public.payroll_pay_rules (staff_id, kind, rate_cents) values (test.id('julia_staff'), 'hourly', 1)$$, '42501', 'no direct writes to rules');
select test.eq(test.count($$select 1 from public.payroll_pay_rules$$), 4, 'the owner reads every rule');
select test.login('mia');
select test.eq(test.count($$select 1 from public.payroll_pay_rules$$), 4, 'a manager reads pay rules');
select test.login('julia');
select test.eq(test.count($$select 1 from public.payroll_pay_rules$$), 0, 'an instructor can''t read pay rules');
select test.login('alice');
select test.eq(test.count($$select 1 from public.payroll_pay_rules$$), 0, 'a client can''t read pay rules');
select test.eq(test.count($$select 1 from public.payroll_cover_requests$$), 0, 'a client can''t read cover requests');
select test.throws($$select public.payroll_list_cover()$$, 'NOT_ALLOWED', 'a client can''t list cover');

-- ---------------------------------------------------------------- timesheets
select test.login('julia');
select test.eq((public.payroll_clock_status() ->> 'eligible')::boolean, false, 'an instructor without an hourly rule doesn''t clock in');
select test.throws($$select public.payroll_clock_in()$$, 'NOT_ALLOWED', '...and can''t');
select test.login('fran');
select test.eq((public.payroll_clock_status() ->> 'eligible')::boolean, true, 'front desk clocks in');
select test.eq(public.payroll_clock_in('Opening') ->> 'status', 'pending', 'Fran clocks in');
select test.throws($$select public.payroll_clock_in()$$, 'ALREADY_CLOCKED_IN', 'not twice');
select test.at('2026-10-19 12:30+11');
select test.ok((public.payroll_clock_out() ->> 'ended_at') is not null, 'Fran clocks out');
select test.eq((public.payroll_clock_status() ->> 'today_minutes')::int, 270, 'four and a half hours today');
select test.throws($$select public.payroll_clock_out()$$, 'NOT_CLOCKED_IN', 'not clocked in any more');
select test.throws($$select public.payroll_save_timesheet('{"started_at":"2026-10-20 09:00+11","ended_at":"2026-10-20 13:00+11"}')$$, 'INVALID', 'no future hours');
select test.throws($$select public.payroll_save_timesheet('{"started_at":"2026-10-13 09:00+11","ended_at":"2026-10-13 10:00+11","break_min":60}')$$, 'INVALID', 'break shorter than the shift');
select (public.payroll_save_timesheet('{"started_at":"2026-10-13 09:00+11","ended_at":"2026-10-13 13:00+11","break_min":30}') ->> 'id') as ts1 \gset
select test.throws($$select public.payroll_save_timesheet('{"started_at":"2026-10-13 12:00+11","ended_at":"2026-10-13 14:00+11"}')$$, 'OVERLAP', 'shifts can''t overlap');
select test.throws(format('select public.payroll_save_timesheet(%L)', jsonb_build_object('staff_id', test.id('julia_staff'), 'started_at', '2026-10-13 09:00+11', 'ended_at', '2026-10-13 10:00+11')),
                   'NOT_ALLOWED', 'front desk can''t add someone else''s hours');
select test.throws($$select public.payroll_save_timesheet('{"kind":"session","session_type":"private","started_at":"2026-10-14 09:00+11","ended_at":"2026-10-14 10:00+11"}')$$,
                   'NOT_ALLOWED', 'front desk can''t log private sessions');
select test.throws($$select public.payroll_review_timesheets(array[test.id('fran_staff')], 'approve')$$, 'NOT_ALLOWED', 'front desk can''t approve');
select test.login('libby');
select test.eq(public.payroll_save_timesheet(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'session', 'session_type', 'Private',
                 'started_at', '2026-10-14 12:00+11', 'ended_at', '2026-10-14 12:50+11')) ->> 'status', 'approved', 'the owner logs a private session (approved)');
select test.eq(test.count($$select 1 from public.payroll_timesheets$$), 3, 'the owner sees every entry');
select test.login('fran');
select test.eq(test.count($$select 1 from public.payroll_timesheets$$), 2, 'front desk sees only their own entries');
select test.throws(format('select public.payroll_list_timesheets(%L, %L, %L)', '2026-10-12', '2026-10-25', test.id('julia_staff')), 'NOT_ALLOWED', '...and can''t ask for anyone else''s');
select test.login('mia');
select test.throws(format('select public.payroll_review_timesheets(array[%L]::uuid[], ''approve'')', :'ts1'), 'NOT_ALLOWED', 'a manager can''t approve hours');
select test.eq(jsonb_array_length(public.payroll_list_timesheets('2026-10-12', '2026-10-25')), 3, 'a manager lists everyone''s hours');

-- ---------------------------------------------------------------- pay runs
select test.login('julia');
select test.throws($$select public.payroll_period_inputs('2026-10-12', '2026-10-18')$$, 'NOT_ALLOWED', 'instructors don''t see pay');
select test.login('mia');
select test.ok(public.payroll_period_inputs('2026-10-12', '2026-10-18') ? 'classes', 'a manager reads the period inputs');
select test.throws($$select public.payroll_add_adjustment('2026-10-12', '2026-10-18', test.id('fran_staff'), 'Bonus', 5000, 'Great week')$$, 'NOT_ALLOWED', 'a manager can''t adjust pay');
select test.login('libby');
select test.throws($$select public.payroll_add_adjustment('2026-10-12', '2026-10-18', test.id('fran_staff'), 'Bonus', 5000, '  ')$$, 'INVALID', 'adjustments need a reason');
select test.ok(public.payroll_add_adjustment('2026-10-12', '2026-10-18', test.id('fran_staff'), 'Reimbursement', 4200, 'Cleaning supplies') ? 'id', 'the owner adds an adjustment');
select test.throws($$select public.payroll_mark_paid('2026-10-19', '2026-10-25', 0, '{}')$$, 'PERIOD_OPEN', 'can''t pay a period that hasn''t finished');
select test.throws($$select public.payroll_mark_paid('2026-10-12', '2026-10-18', 0, '{}')$$, 'TIMESHEETS_PENDING', 'pending hours block paying');
select test.eq(jsonb_array_length(public.payroll_review_timesheets(array[:'ts1']::uuid[], 'approve')), 1, 'the owner approves Fran''s shift');
select test.eq((public.payroll_mark_paid('2026-10-12', '2026-10-18', 16525, '{"staff":[]}') ->> 'total_cents')::int, 16525, 'marked as paid');
select test.throws($$select public.payroll_mark_paid('2026-10-12', '2026-10-18', 0, '{}')$$, 'ALREADY_PAID', 'not twice');
select test.throws(format('select public.payroll_save_timesheet(%L)', jsonb_build_object('id', :'ts1', 'started_at', '2026-10-13 09:00+11', 'ended_at', '2026-10-13 12:00+11')),
                   'PERIOD_PAID', 'a paid period''s hours are frozen');
select test.throws($$select public.payroll_add_adjustment('2026-10-12', '2026-10-18', test.id('fran_staff'), 'Bonus', 100, 'x')$$, 'PERIOD_PAID', 'no adjustments after paying');
select test.login('mia');
select test.eq(test.count($$select 1 from public.payroll_runs$$), 1, 'a manager sees pay runs');
select test.throws($$select public.payroll_reopen('2026-10-12', '2026-10-18')$$, 'NOT_ALLOWED', 'a manager can''t reopen');
select test.login('fran');
select test.eq(test.count($$select 1 from public.payroll_runs$$), 0, 'front desk can''t see pay runs');
select test.eq(test.count($$select 1 from public.payroll_adjustments$$), 0, 'front desk can''t see adjustments');
select test.login('libby');
select public.payroll_reopen('2026-10-12', '2026-10-18');
select test.eq(test.count($$select 1 from public.payroll_runs$$), 0, 'the owner reopens the period');

-- ---------------------------------------------------------------- isolation: a second studio
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pp@platform.test', '{"first_name":"P"}', now()),
  (gen_random_uuid(), 'howner@harbour.test', '{"first_name":"Hal","studio":"harbour"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pp@platform.test', 'howner@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pp'));
select test.login('pp');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test') ->> 'id') as harbour_id \gset
select public.platform_invite_owner(:'harbour_id', 'Hal', 'howner@harbour.test');
select test.login('howner');
select test.studio('harbour');
select test.eq(test.count($$select 1 from public.payroll_cover_requests$$), 0, 'B owner: no A cover requests');
select test.eq(test.count($$select 1 from public.payroll_pay_rules$$), 0, 'B owner: no A pay rules');
select test.eq(test.count($$select 1 from public.payroll_timesheets$$), 0, 'B owner: no A timesheets');
select test.eq(test.count($$select 1 from public.payroll_adjustments$$), 0, 'B owner: no A adjustments');
select test.eq(jsonb_array_length(public.payroll_list_cover()), 0, 'B owner: the cover list is B''s only');
select test.throws(format('select public.payroll_decide_cover(%L, ''decline'')', test.id('cover1')), 'NOT_FOUND', 'B owner: can''t decide an A request');
select test.throws(format('select public.payroll_cancel_cover(%L)', :'cover2'), 'NOT_FOUND', 'B owner: can''t cancel an A request');
select test.throws($$select public.payroll_request_cover(test.id('s_fri'))$$, 'NOT_FOUND', 'B owner: can''t ask for cover on an A class');
select test.throws($$select public.payroll_save_rule(jsonb_build_object('staff_id', test.id('julia_staff'), 'kind', 'flat', 'rate_cents', 1))$$, 'NOT_FOUND', 'B owner: can''t set an A person''s pay');
select test.throws(format('select public.payroll_review_timesheets(array[%L]::uuid[], ''reject'')', :'ts1'), 'NOT_FOUND', 'B owner: can''t review A hours');
select test.eq(jsonb_array_length(public.payroll_period_inputs('2026-10-12', '2026-10-18') -> 'classes'), 0, 'B owner: pay inputs are B''s only');
select test.ok(public.payroll_save_rule(jsonb_build_object('staff_id', (select id from public.staff where email = 'howner@harbour.test'), 'kind', 'flat', 'rate_cents', 0)) ? 'id',
               'B owner sets their own rule');
select test.login('libby');
select test.studio('harbour');
select test.throws($$select public.payroll_list_cover()$$, 'NOT_ALLOWED', 'A owner asking B: not staff there');
select test.studio('snowy');
select test.eq(test.count($$select 1 from public.payroll_pay_rules where studio_id <> app.default_studio()$$), 0, 'A owner: no B pay rules');
select test.studio(null);
select test.eq(test.count($$select 1 from public.payroll_pay_rules where studio_id <> app.default_studio()$$), 0, 'A owner without a header: no B rules');

select test.at('');
rollback;
