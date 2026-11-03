-- 3002: who can read client health notes. Default is "owner, managers and the instructor of a class they're booked into".
-- Snowy: Libby owner, Mia manager, Fran front desk, Julia instructor (teaches s_thu), Alice (booked into s_thu), Bob (not booked into any of Julia's classes).
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');
select test.login('alice');
select public.book_class(test.id('s_thu'));
select test.admin();
update public.clients set injuries = 'Bad knee', health_form = '{"injuries":"Bad knee"}' where id = test.id('alice_client');
update public.clients set injuries = 'Torn shoulder', health_form = '{"injuries":"Torn shoulder"}' where id = test.id('bob_client');
\o

select test.eq((select health_notes_visibility from public.studio_settings), 'class_instructor', 'the default is owner, managers and the class instructor');

-- Julia (instructor): Alice yes, Bob no
select test.login('julia');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client'), test.id('bob_client')]))), 1, 'instructor gets health for one of the two');
select test.eq((public.client_health(array[test.id('alice_client'), test.id('bob_client')]) -> 0 ->> 'injuries'), 'Bad knee', 'it is the client booked into her class');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('bob_client')]))), 0, 'instructor can NOT read health notes for a client who is not in one of her classes');
select test.throws($$select injuries from public.clients$$, '42501', 'the table no longer hands out the injuries column');
select test.throws($$select health_form from public.clients$$, '42501', 'nor the health form');
select test.ok((select count(*) from public.clients) > 0, 'other client columns still read fine');
select test.eq((select e -> 'client' ->> 'injuries' from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e where e ->> 'client_id' = test.id('alice_client')::text), 'Bad knee', 'roster of her class shows Alice''s injuries');
select test.ok((select e -> 'flags' ? 'injury' from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e where e ->> 'client_id' = test.id('alice_client')::text), 'and the injury flag');

-- Fran (front desk): nobody under the default
select test.login('fran');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client'), test.id('bob_client')]))), 0, 'front desk sees no health notes under the default');
select test.ok(not (select e -> 'flags' ? 'injury' from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e where e ->> 'client_id' = test.id('alice_client')::text), 'roster flag hidden from front desk');
select test.ok((select (e -> 'client') ? 'injuries' from jsonb_array_elements(public.get_roster(test.id('s_thu'))) e where e ->> 'client_id' = test.id('alice_client')::text) is not true, 'roster client has no injuries key for front desk');
update public.clients set injuries = 'overwritten' where id = test.id('bob_client');
select test.admin();
select test.eq((select injuries from public.clients where id = test.id('bob_client')), 'Torn shoulder', 'front desk can''t overwrite notes they can''t read');

-- Owner, manager: everyone
select test.login('libby');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client'), test.id('bob_client')]))), 2, 'owner sees both');
select test.login('mia');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client'), test.id('bob_client')]))), 2, 'manager sees both');

-- A client sees their own, not someone else's
select test.login('alice');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client'), test.id('bob_client')]))), 1, 'a client reads only their own');

-- Owner and managers only
select test.login('libby');
update public.studio_settings set health_notes_visibility = 'owner_manager';
select test.login('julia');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client')]))), 0, 'owner_manager: even her own class''s client is hidden from the instructor');
select test.login('mia');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client')]))), 1, 'owner_manager: manager still sees');

-- All staff
select test.login('libby');
update public.studio_settings set health_notes_visibility = 'all_staff';
select test.login('fran');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('alice_client'), test.id('bob_client')]))), 2, 'all_staff: front desk sees both');
select test.login('julia');
select test.eq((select jsonb_array_length(public.client_health(array[test.id('bob_client')]))), 1, 'all_staff: instructor sees a client outside her classes');
select test.login('libby');
select test.throws($$update public.studio_settings set health_notes_visibility = 'everyone'$$, '23514', 'only the three values are allowed');
select test.login('julia');
update public.studio_settings set health_notes_visibility = 'owner_manager';   -- RLS: an instructor can't see the row to update
select test.eq((select health_notes_visibility from public.studio_settings), 'all_staff', 'an instructor can''t change the setting');
rollback;
