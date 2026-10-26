-- Family accounts (0010): a guardian reads, writes and books for their dependants, and nobody else can, in any studio.
-- Snowy (default studio): Alice (4 pack, shareable), Bob (weekly membership, not shareable), Cara (no pass), Libby owner, Gus (single).
-- Harbour: Hank owner, Hana client.
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

-- ---------------------------------------------------------------- studio B (Harbour) with an owner and a client
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));
select test.login('pete');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test', 'Australia/Sydney', 'AUD', 'en-AU', null, '12 Bay St', '{}'::jsonb) ->> 'id') as harbour_id \gset
select test.admin();
insert into test.ids values ('harbour', :'harbour_id');
select test.login('pete');
select public.platform_invite_owner(test.id('harbour'), 'Hank', 'hank@harbour.test');
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'hana@harbour.test', '{"first_name":"Hana","studio":"harbour"}', now());
insert into test.ids select 'hana', id from auth.users where email = 'hana@harbour.test';
insert into test.ids select 'hana_client', id from public.clients where email = 'hana@harbour.test';

\o
select test.studio('snowy');

-- ---------------------------------------------------------------- adding a dependant
select test.login('alice');
select (public.save_dependant(test.id('alice_client'), null, 'Ally', null, '2021-03-02', 'Asthma, has a puffer') ->> 'id') as ally \gset
select test.admin();
insert into test.ids values ('ally', :'ally');
select test.eq((select guardian_client_id from public.clients where id = test.id('ally')), test.id('alice_client'), 'dependant is a client row under the parent');
select test.eq((select last_name from public.clients where id = test.id('ally')), 'Test', 'last name defaults to the parent''s');
select test.eq((select email from public.clients where id = test.id('ally')), '', 'no email, no login');
select test.throws($$select public.save_dependant(test.id('alice_client'), null, 'Ally')$$, 'INVALID', 'same name twice in one family is refused');
select test.throws($$select public.save_dependant(test.id('alice_client'), null, '  ')$$, 'INVALID', 'a first name is required');
select test.login('alice');
select public.save_dependant(test.id('alice_client'), test.id('ally'), 'Ally', 'Archer', '2021-03-02', 'Asthma');
select test.eq((select last_name from public.clients where id = test.id('ally')), 'Archer', 'parent can edit a dependant');

-- ---------------------------------------------------------------- RLS: who can see and change them
select test.eq(test.count($$select 1 from public.clients where id = test.id('ally')$$), 1, 'parent reads their dependant');
select test.login('cara');
select test.eq(test.count($$select 1 from public.clients where id = test.id('ally')$$), 0, 'another client cannot read the dependant');
select test.throws($$select public.save_dependant(test.id('alice_client'), null, 'Sneaky')$$, 'NOT_ALLOWED', 'another client cannot add to Alice''s family');
select test.throws($$select public.save_dependant(test.id('alice_client'), test.id('ally'), 'Hacked')$$, 'NOT_ALLOWED', 'another client cannot edit the dependant');
select test.throws($$select public.remove_dependant(test.id('ally'))$$, 'NOT_ALLOWED', 'another client cannot remove the dependant');
update public.clients set first_name = 'Hacked' where id = test.id('ally');
select test.admin();
select test.eq((select first_name from public.clients where id = test.id('ally')), 'Ally', 'direct UPDATE by another client changes nothing');
insert into test.ids select 'snowy_studio', studio_id from public.clients where id = test.id('alice_client');
select test.login('alice');
-- direct inserts are limited to "a dependant of mine, no login, no self-declared waiver"
insert into public.clients (studio_id, first_name, guardian_client_id) values (test.id('snowy_studio'), 'Direct', test.id('alice_client'));
select test.throws($$insert into public.clients (studio_id, first_name, guardian_client_id) values (test.id('snowy_studio'), 'Stolen', test.id('bob_client'))$$,
                   '42501', 'cannot insert a dependant under someone else');
select test.throws($$insert into public.clients (studio_id, first_name, guardian_client_id, waiver_signed_at) values (test.id('snowy_studio'), 'Fast', test.id('alice_client'), now())$$,
                   '42501', 'cannot self-declare a dependant''s waiver');
update public.clients set guardian_client_id = test.id('bob_client') where id = test.id('ally');
select test.admin();
select test.eq((select guardian_client_id from public.clients where id = test.id('ally')), test.id('alice_client'), 'a parent cannot hand a dependant to another family');
delete from public.clients where first_name = 'Direct';

-- one level only
select test.throws($$update public.clients set guardian_client_id = test.id('bob_client') where id = test.id('alice_client')$$, 'INVALID', 'a parent cannot become a dependant');
select test.throws($$insert into public.clients (studio_id, first_name, guardian_client_id) select studio_id, 'Grand', id from public.clients where id = test.id('ally')$$,
                   'INVALID', 'a dependant cannot have dependants');
select test.throws($$insert into public.clients (studio_id, first_name, guardian_client_id) values (test.id('harbour'), 'Cross', test.id('alice_client'))$$,
                   'INVALID', 'a guardian must be in the same studio');

-- ---------------------------------------------------------------- waiver, then booking
select test.login('alice');
select test.throws($$select public.book_class(test.id('s_thu'), null, test.id('ally'))$$, 'WAIVER_REQUIRED', 'a dependant needs a waiver before booking');
select test.login('cara');
select test.throws($$select public.submit_waiver(test.id('ally'), '{"injuries":"x"}')$$, 'NOT_FOUND', 'another client cannot sign the waiver');
select test.login('alice');
select public.submit_waiver(test.id('ally'), '{"injuries":"Asthma","pregnantOrPostnatal":false}');
select test.admin();
select test.ok((select waiver_signed_at is not null from public.clients where id = test.id('ally')), 'the parent signs the dependant''s waiver');

-- credits come from Alice's pack (shareable by default)
select test.login('alice');
select test.eq(public.book_class(test.id('s_thu'), null, test.id('ally')) ->> 'outcome', 'booked', 'parent books the dependant, using the parent''s pack');
select test.admin();
select test.eq((select client_id from public.bookings where session_id = test.id('s_thu') and client_id = test.id('ally')), test.id('ally'), 'the booking belongs to the dependant');
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, 'it took one credit from the parent''s pack');
select test.login('alice');
select test.eq(test.count($$select 1 from public.bookings where client_id = test.id('ally')$$), 1, 'parent reads the dependant''s bookings');
select test.eq(test.count($$select 1 from public.passes where client_id = test.id('alice_client')$$), 1, 'parent still reads their own pass');
select jsonb_array_length(public.list_client_bookings(test.id('ally'), 'upcoming')) as n \gset
select test.eq(:n, 1, 'parent lists the dependant''s upcoming classes');
select test.eq(jsonb_array_length(public.credit_summary(test.id('ally'))), 1, 'the dependant''s credits show the parent''s pack');
select test.eq((public.credit_summary(test.id('ally')) -> 0 ->> 'shared')::boolean, true, '...marked as shared');
select test.login('cara');
select test.eq(test.count($$select 1 from public.bookings where client_id = test.id('ally')$$), 0, 'another client cannot read the dependant''s bookings');
select test.throws($$select public.book_class(test.id('s_fri'), null, test.id('ally'))$$, 'NOT_ALLOWED', 'another client cannot book for the dependant');
select test.throws($$select public.credit_summary(test.id('ally'))$$, 'NOT_FOUND', 'another client cannot see the dependant''s credits');
select test.throws($$select public.cancel_booking((select id from public.bookings where client_id = test.id('ally') limit 1))$$, 'NOT_FOUND', 'another client cannot cancel their booking');

-- ---------------------------------------------------------------- credits: not shareable, own pass first
select test.login('bob');
select (public.save_dependant(test.id('bob_client'), null, 'Bobby') ->> 'id') as bobby \gset
select test.admin();
insert into test.ids values ('bobby', :'bobby');
update public.clients set waiver_signed_at = '2026-10-01 09:00+10' where id = test.id('bobby');
select test.login('bob');
select test.throws($$select public.book_class(test.id('s_eve'), null, test.id('bobby'))$$, 'NO_CREDITS', 'a membership is not family-shareable by default: the dependant needs their own pass');
select test.throws($$select public.book_attendees(test.id('s_eve'), array[test.id('bob_client'), test.id('bobby')])$$, 'NO_CREDITS', 'booking the family fails if one person has no credit...');
select test.admin();
select test.eq(test.count($$select 1 from public.bookings where session_id = test.id('s_eve') and client_id = test.id('bob_client')$$), 0, '...and nobody is booked (all or nothing)');
-- the studio flags Bob's membership as family-shareable
update public.passes set family_shareable = true where client_id = test.id('bob_client');
select test.login('bob');
select test.eq(jsonb_array_length(public.book_attendees(test.id('s_eve'), array[test.id('bob_client'), test.id('bobby')])), 2, 'flagged shareable: the whole family books in one go');
select test.admin();
select test.eq(test.count($$select 1 from public.bookings where session_id = test.id('s_eve') and client_id in (test.id('bob_client'), test.id('bobby')) and status = 'booked'$$), 2, 'each attendee takes one spot');

-- a pass bought for the dependant is used before the parent's
select test.eq(test.count($$select 1 from public.products where id = test.id('p_single') and family_shareable is null$$), 1, 'products default to "unset"');
select public.checkout_cart(test.id('ally'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'cash');
select test.login('alice');
select public.book_class(test.id('s_fri'), null, test.id('ally'));
select test.admin();
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, 'the dependant''s own pass is used first (parent''s pack untouched)');
select test.eq((select status from public.passes where client_id = test.id('ally')), 'used_up', '...and it is used up');

-- a product flag is copied onto the pass at purchase
update public.products set family_shareable = false where id = test.id('p_pack4');
select public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'cash');
select test.eq((select family_shareable from public.passes where client_id = test.id('gus_client') and kind = 'pack'), false, 'the product''s family flag is copied onto the new pass');
update public.passes set family_shareable = false where client_id = test.id('alice_client');
select test.login('alice');
select test.throws($$select public.book_class(test.id('s_next'), null, test.id('ally'))$$, 'NO_CREDITS', 'once the parent''s pass is not shareable, the dependant is out of credit');
select test.admin();
update public.passes set family_shareable = null where client_id = test.id('alice_client');

-- ---------------------------------------------------------------- staff see it too
select test.login('libby');
select test.eq(test.count($$select 1 from public.clients where guardian_client_id = test.id('alice_client')$$), 1, 'staff read dependants');
select test.eq(jsonb_array_length(public.get_roster(test.id('s_thu'))), 1, 'the dependant is on the roster');
select test.eq(public.get_roster(test.id('s_thu')) -> 0 -> 'client' ->> 'guardian_client_id', test.id('alice_client')::text, '...with their parent attached');
select test.eq(public.book_class(test.id('s_next'), null, test.id('ally'), true, false, true) ->> 'outcome', 'booked', 'staff can book a dependant (skipping credit)');
select public.check_in((select id from public.bookings where session_id = test.id('s_next') and client_id = test.id('ally')));
select test.eq((select status from public.bookings where session_id = test.id('s_next') and client_id = test.id('ally')), 'checked_in', 'staff can check a dependant in');
select public.save_dependant(test.id('cara_client'), null, 'Cleo');
select test.eq(test.count($$select 1 from public.clients where guardian_client_id = test.id('cara_client') and source = 'staff'$$), 1, 'staff can add a dependant to any client');

-- ---------------------------------------------------------------- cancelling and removing
select test.login('alice');
select test.eq(public.cancel_booking((select id from public.bookings where session_id = test.id('s_thu') and client_id = test.id('ally'))) ->> 'creditReturned', 'true', 'parent cancels the dependant''s booking and the credit goes back');
select test.throws($$select public.remove_dependant(test.id('ally'))$$, 'INVALID', 'cannot remove a dependant with upcoming classes');
select test.admin();
update public.bookings set status = 'cancelled' where client_id = test.id('ally') and status in ('booked', 'checked_in');
select test.login('alice');
select public.remove_dependant(test.id('ally'));
select test.admin();
select test.ok((select archived from public.clients where id = test.id('ally')), 'removing archives (history stays)');

-- ---------------------------------------------------------------- the other studio can't touch any of it
select test.studio('harbour');
select test.login('hank');
select test.eq(test.count($$select 1 from public.clients where guardian_client_id is not null$$), 0, 'Harbour''s owner sees none of Snowy''s dependants');
select test.throws($$select public.save_dependant(test.id('alice_client'), null, 'Cross')$$, 'NOT_FOUND', 'Harbour staff cannot add to a Snowy family');
select test.login('hana');
select test.throws($$select public.save_dependant(test.id('alice_client'), null, 'Cross')$$, 'NOT_FOUND', 'a Harbour client cannot add to a Snowy family');
select test.throws($$select public.book_attendees(test.id('s_thu'), array[test.id('bobby')])$$, 'NOT_FOUND', 'a Harbour client cannot book a Snowy class for a Snowy dependant');
select test.eq(test.count($$select 1 from public.clients where id in (test.id('bobby'), test.id('alice_client'))$$), 0, 'a Harbour client cannot read Snowy''s clients');
select test.studio('snowy');
select test.login('alice');
select test.eq(test.count($$select 1 from public.clients where guardian_client_id is not null$$), 1, 'Alice sees only her own dependants (the archived one)');

rollback;
\o
