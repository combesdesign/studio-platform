-- Undo for staff mistakes: no-show, cancel / late cancel / waitlist removal, "Return credit", restore a cancelled class, void a desk sale.
-- "Now" is Monday 19 Oct 2026, 8:00am Sydney. s_early = Wed 21 Oct 6:00am (2 spots), s_cancel = Fri 23 Oct 9:30am (mums).
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create or replace function test.studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on function test.studio(text) to anon, authenticated, service_role;

create function test.bk(p_client text, p_session text) returns uuid language sql security definer as $$
  select id from public.bookings where client_id = test.id(p_client || '_client') and session_id = test.id(p_session) order by created_at desc, updated_at desc limit 1
$$;
create function test.st(p_client text, p_session text) returns text language sql security definer as $$
  select status from public.bookings where id = test.bk(p_client, p_session)
$$;
create function test.used(p_client text) returns bigint language sql security definer as $$
  select coalesce(sum(credits_used), 0) from public.passes where client_id = test.id(p_client || '_client')
$$;
grant execute on function test.bk, test.st, test.used to authenticated;

-- ---------------------------------------------------------------- set up: Alice and Bob fill s_early, Cara / Fay / Dan wait (Cara has no credit)
select test.login('alice'); select public.book_class(test.id('s_early'));
select test.login('bob');   select public.book_class(test.id('s_early'));
select test.login('cara');  select public.book_class(test.id('s_early'));
select test.login('fay');   select public.book_class(test.id('s_early'));
select test.login('dan');   select public.book_class(test.id('s_early'));
select test.admin();
select test.eq(test.used('alice'), 1::bigint, 'Alice used a credit');
select test.eq(test.used('fay'), 1::bigint, 'Fay has her one old credit used, nothing for the waitlist');

-- ---------------------------------------------------------------- no-show -> undo
select test.at('2026-10-21 06:30+11');
select test.login('fran');
select public.mark_no_show(test.bk('bob', 's_early'));
select test.eq(test.st('bob', 's_early'), 'no_show', 'Bob marked as a no-show');
select test.eq((select prior_status from public.bookings where id = test.bk('bob', 's_early')), 'booked', 'the booking remembers it was booked');
select test.eq(public.undo_no_show(test.bk('bob', 's_early')) ->> 'status', 'booked', 'undo no-show puts Bob back to booked');
select test.throws($$select public.undo_no_show(test.bk('bob', 's_early'))$$, 'INVALID', 'undo only works on a no-show');
select test.login('alice');
select test.throws($$select public.undo_no_show(test.bk('bob', 's_early'))$$, 'NOT_ALLOWED', 'a client can''t undo');
select test.login('gracet');
select test.throws($$select public.undo_no_show(test.bk('bob', 's_early'))$$, 'NOT_ALLOWED', 'an instructor can''t undo a no-show on someone else''s class (same as marking it)');

-- ---------------------------------------------------------------- staff cancel (credit back, waitlist promoted) -> undo with the promoted person moved back
select test.at('2026-10-19 09:00+11');
select test.login('libby');
create temp table r as select public.cancel_booking(test.bk('alice', 's_early'), false, true) as j;
select test.admin();
select test.eq((select j -> 'promoted' ->> 'client_id' from r), test.id('fay_client')::text, 'cancelling Alice books Fay (Cara has no credit)');
select test.eq(test.used('alice'), 0::bigint, 'Alice''s credit is back');
select test.eq(test.used('fay'), 2::bigint, 'Fay''s credit is taken');
select (j -> 'promoted' ->> 'id') as fay_bk from r \gset
drop table r;
select test.login('libby');
select test.throws($$select public.undo_cancel_booking(test.bk('alice', 's_early'))$$, 'CLASS_FULL', 'full class: won''t squeeze her back in silently');
select test.eq(test.used('alice'), 0::bigint, '...and a failed undo changes nothing');
select test.throws($$select public.undo_cancel_booking(test.bk('alice', 's_early'), test.bk('bob', 's_early'))$$, 'INVALID', 'only someone the waitlist auto-booked can be moved back');
create temp table r as select public.undo_cancel_booking(test.bk('alice', 's_early'), :'fay_bk'::uuid) as j;
select test.admin();
select test.eq((select j -> 'booking' ->> 'status' from r), 'booked', 'Alice is booked again');
select test.eq((select (j ->> 'creditTaken')::boolean from r), true, '...her credit is taken again');
select test.eq(test.used('alice'), 1::bigint, '...credits_used is back to 1');
select test.eq(test.used('fay'), 1::bigint, 'Fay''s credit goes back');
select test.eq(test.st('fay', 's_early'), 'waitlisted', 'Fay is back on the waitlist');
select test.eq((select array_agg(c.first_name order by b.waitlist_position) from public.bookings b join public.clients c on c.id = b.client_id
                 where b.session_id = test.id('s_early') and b.status = 'waitlisted'), array['Cara','Fay','Dan'], 'waitlist order is as it was');
select test.eq((select array_agg(waitlist_position order by waitlist_position) from public.bookings where session_id = test.id('s_early') and status = 'waitlisted'), array[1,2,3], '...numbered 1 to 3');
select test.eq((select count(*)::int from public.bookings where session_id = test.id('s_early') and status in ('booked','checked_in')), 2, 'capacity: still 2 booked');
select test.ok((select pass_id is null and promoted_from_waitlist_at is null from public.bookings where id = :'fay_bk'::uuid), 'Fay''s booking has no pass and no promotion mark');
select test.ok(exists (select 1 from public.audit_log where action = 'undo_cancel_booking' and entity_id = test.bk('alice', 's_early')::text), 'audit log entry');
drop table r;

-- ---------------------------------------------------------------- late cancel by staff -> undo (credit was never returned) ; "Return credit" later
select test.at('2026-10-21 04:00+11');   -- 2h before class
select test.login('libby');
select public.cancel_booking(test.bk('alice', 's_early'), false, true);
select test.eq(test.st('alice', 's_early'), 'late_cancelled', 'inside 3h: late cancel');
select test.eq(test.used('alice'), 1::bigint, 'credit lost');
select test.eq((select count(*)::int from public.bookings where session_id = test.id('s_early') and status in ('booked','checked_in')), 2, 'the waitlist filled the spot (Fay)');
select test.eq(test.st('fay', 's_early'), 'booked', 'Fay got it');
select test.throws($$select public.undo_cancel_booking(test.bk('alice', 's_early'))$$, 'CLASS_FULL', 'spot taken: refuses');
select public.undo_cancel_booking(test.bk('alice', 's_early'), test.bk('fay', 's_early'));
select test.eq(test.st('alice', 's_early'), 'booked', 'undo a late cancel: booked again');
select test.eq(test.used('alice'), 1::bigint, '...and no second credit is taken');
select test.eq(test.st('fay', 's_early'), 'waitlisted', '...Fay is back in line');
-- cancel again late, leave it, and waive the penalty afterwards
select public.cancel_booking(test.bk('alice', 's_early'), false, true);
select test.at('2026-10-22 09:00+11');
select test.eq(public.waive_penalty(test.bk('alice', 's_early')) ->> 'status', 'cancelled', 'Return credit: late cancel becomes a plain cancel');
select test.eq(test.used('alice'), 0::bigint, '...credit is back on the pack');
select test.throws($$select public.waive_penalty(test.bk('alice', 's_early'))$$, 'INVALID', 'nothing left to waive');
select test.eq(test.st('bob', 's_early'), 'booked', 'Bob (booked, no penalty) is untouched');
select test.throws($$select public.waive_penalty(test.bk('bob', 's_early'))$$, 'INVALID', 'can''t "return" a credit on a normal booking');
select public.mark_no_show(test.bk('bob', 's_early'));
select test.eq(public.waive_penalty(test.bk('bob', 's_early')) ->> 'status', 'cancelled', 'a no-show can be waived later too');
select test.ok(exists (select 1 from public.audit_log where action = 'waive_penalty'), 'audit log entry for the waiver');

-- ---------------------------------------------------------------- leave the waitlist -> undo keeps the place
select test.at('2026-10-19 10:00+11');
select test.admin();
select test.mk_session('s_small', 'mat', '2026-10-24 06:00+11', 1, 'julia');
select test.login('libby');
select public.book_class(test.id('s_small'), null, test.id('alice_client'), true);
select public.book_class(test.id('s_small'), null, test.id('dan_client'), true);
select public.book_class(test.id('s_small'), null, test.id('fay_client'), true);
select test.eq((select waitlist_position from public.bookings where id = test.bk('dan', 's_small')), 1, 'Dan waits 1st');
select test.eq((select waitlist_position from public.bookings where id = test.bk('fay', 's_small')), 2, 'Fay waits 2nd');
select public.leave_waitlist(test.bk('dan', 's_small'));
select test.eq((select waitlist_position from public.bookings where id = test.bk('fay', 's_small')), 1, 'Fay moves up');
select test.eq(public.undo_cancel_booking(test.bk('dan', 's_small')) -> 'booking' ->> 'status', 'waitlisted', 'undo: Dan is waitlisted again');
select test.eq((select waitlist_position from public.bookings where id = test.bk('dan', 's_small')), 1, '...first again');
select test.eq((select waitlist_position from public.bookings where id = test.bk('fay', 's_small')), 2, '...and Fay is back to 2nd');

-- ---------------------------------------------------------------- restore a cancelled class
select test.admin();
update public.class_sessions set capacity = 3 where id = test.id('s_cancel');
select test.mk_session('s_clash', 'mums', '2026-10-23 09:30+11', 3, 'gracet');
select test.login('libby');
select public.book_class(test.id('s_cancel'), null, test.id('alice_client'), true);
select public.book_class(test.id('s_cancel'), null, test.id('dan_client'), true);
select public.book_class(test.id('s_cancel'), null, test.id('gus_client'), true);
select public.book_class(test.id('s_cancel'), null, test.id('fay_client'), true);
select test.eq(test.st('fay', 's_cancel'), 'waitlisted', 'Fay is waitlisted for the mums class');
select test.admin();
select test.used('alice') as alice_before, test.used('gus') as gus_before, test.used('fay') as fay_before \gset
select test.login('libby');
select public.cancel_session(test.id('s_cancel'), 'Instructor unwell');
select test.admin();
select test.eq((select cancelled_at is not null from public.class_sessions where id = test.id('s_cancel')), true, 'the cancel time is remembered');
select test.eq(test.used('gus'), (:gus_before - 1)::bigint, 'Gus''s credit came back when the class was cancelled');
-- Dan books the other 9:30 class; Gus spends his single credit on a different class
select test.login('libby');
select public.book_class(test.id('s_clash'), null, test.id('dan_client'), true);
select public.book_class(test.id('s_thu'), null, test.id('gus_client'), true);
select test.login('fran');
select test.throws($$select public.restore_session(test.id('s_eve'))$$, 'INVALID', 'can''t restore a class that is not cancelled');
select test.login('gracet');
select test.throws($$select public.restore_session(test.id('s_cancel'))$$, 'NOT_ALLOWED', 'instructors can''t restore classes (same as cancelling)');
select test.login('fran');
create temp table r as select public.restore_session(test.id('s_cancel')) as j;
select test.admin();
select test.eq((select status from public.class_sessions where id = test.id('s_cancel')), 'scheduled', 'class is back on');
select test.eq((select cancelled_at is null from public.class_sessions where id = test.id('s_cancel')), true, '...cancel time cleared');
select test.eq((select array_agg(x ->> 'name' order by x ->> 'name') from r, jsonb_array_elements(j -> 'needsAttention') x), array['Dan Test','Gus Test'], 'Dan and Gus are listed for staff');
select test.eq((select array_agg(x ->> 'reason' order by x ->> 'name') from r, jsonb_array_elements(j -> 'needsAttention') x), array['Took another class at the same time','No credit left on their Single class'], '...with the reasons');
select test.eq((select array_agg(x ->> 'name' order by x ->> 'name') from r, jsonb_array_elements(j -> 'restored') x), array['Alice Test','Fay Test'], 'Alice rebooked, and Fay (waitlisted) takes a spare spot');
select test.eq(test.st('alice', 's_cancel'), 'booked', 'Alice is booked');
select test.eq(test.used('alice'), :alice_before::bigint, 'Alice''s credit was taken again');
select test.eq(test.st('fay', 's_cancel'), 'booked', 'Fay was promoted into a spare spot');
select test.eq(test.used('fay'), (:fay_before + 1)::bigint, 'Fay''s credit taken when promoted');
select test.ok(test.st('dan', 's_cancel') = 'removed' and test.st('gus', 's_cancel') = 'removed', 'Dan and Gus stay removed');
select test.ok((select (j -> 'restored' -> 0 ->> 'status') is not null from r), 'restored entries carry a status');
select test.eq((select count(*)::int from public.bookings where session_id = test.id('s_cancel') and status in ('booked','checked_in')), 2, 'capacity: 2 of 3 booked');
select test.ok(exists (select 1 from public.notifications where kind = 'booking_confirmed' and to_email = 'alice@example.test' and created_at >= now() - interval '1 minute'), 'Alice is emailed that she is booked');
select test.login('fran');
select test.throws($$select public.restore_session(test.id('s_cancel'))$$, 'INVALID', 'restoring twice is refused');
drop table r;

-- ---------------------------------------------------------------- void a desk sale
select test.at('2026-10-19 11:00+11');
select test.login('libby');
select public.commerce_adjust_stock(jsonb_build_object('product_id', test.id('p_socks'), 'set_to', 10, 'reason', 'count')) ->> 'stock' as s0 \gset
select test.login('fran');
select (public.checkout_cart(test.id('erin_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4')), jsonb_build_object('product_id', test.id('p_socks'), 'qty', 2)), 'cash') -> 'sale' ->> 'id') as sale \gset
select test.eq((select stock from public.products where id = test.id('p_socks')), 8, 'the sale took 2 pairs of socks off the shelf');
select test.eq(public.void_sale(:'sale'::uuid, null, true) ->> 'voided', 'false', 'dry run describes, changes nothing');
select test.eq(public.void_sale(:'sale'::uuid, null, true) -> 'passes' -> 0 ->> 'name', '4 class pack', '...and names the pass');
select test.ok((public.void_sale(:'sale'::uuid, null, true) ->> 'blocked') is null, '...nothing blocks it');
select test.eq((select refunded_cents from public.sales where id = :'sale'::uuid), 0, 'dry run refunded nothing');
select test.login('alice');
select test.throws($$select public.void_sale('$$ || :'sale' || $$'::uuid)$$, 'NOT_ALLOWED', 'clients can''t void');
select test.login('julia');
select test.throws($$select public.void_sale('$$ || :'sale' || $$'::uuid)$$, 'NOT_ALLOWED', 'instructors can''t void (same as refund)');
select test.login('fran');
create temp table r as select public.void_sale(:'sale'::uuid, 'wrong client') as j;
select test.admin();
select test.eq((select (j ->> 'voided')::boolean from r), true, 'voided');
select test.eq((select refunded_cents from public.sales where id = :'sale'::uuid), (select total_cents from public.sales where id = :'sale'::uuid), 'the whole sale is taken back');
select test.ok((select note like '%Refund: Voided: wrong client%' from public.sales where id = :'sale'::uuid), 'the note says it was voided and why');
select test.eq((select status from public.passes where sale_id = :'sale'::uuid), 'cancelled', 'the pass is cancelled');
select test.eq((select stock from public.products where id = test.id('p_socks')), 10, 'the socks are back on the shelf');
select test.ok(exists (select 1 from public.audit_log where action = 'void_sale' and entity_id = :'sale'), 'audit log entry');
drop table r;
select test.login('fran');
select test.throws($$select public.void_sale('$$ || :'sale' || $$'::uuid)$$, 'INVALID', 'can''t void twice');

-- card, old and used sales are refused with a plain reason
select test.admin();
insert into public.sales (client_id, total_cents, method, stripe_payment_intent_id) values (test.id('erin_client'), 3000, 'card_online', 'pi_undo_test') returning id as card_sale \gset
insert into public.sales (client_id, total_cents, method, created_at) values (test.id('erin_client'), 2000, 'cash', '2026-10-18 10:00+11') returning id as old_sale \gset
select test.login('fran');
select (public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'card_reader') -> 'sale' ->> 'id') as used_sale \gset
select test.admin();
select id as gus_pack from public.passes where sale_id = :'used_sale'::uuid \gset
select test.login('fran');
select public.book_class(test.id('s_fri'), :'gus_pack'::uuid, test.id('gus_client'), true);
select test.ok((public.void_sale(:'card_sale'::uuid, null, true) ->> 'blocked') like 'Card payments%', 'card payments: use Refund');
select test.throws($$select public.void_sale('$$ || :'card_sale' || $$'::uuid)$$, 'INVALID', 'card sale refused');
select test.ok((public.void_sale(:'old_sale'::uuid, null, true) ->> 'blocked') like 'Only sales made today%', 'yesterday''s sale: use Refund');
select test.ok((public.void_sale(:'used_sale'::uuid, null, true) ->> 'blocked') like '4 class pack has already been used for 1 class%', 'a pass already used for a class can''t be voided');
select test.throws($$select public.void_sale('$$ || :'used_sale' || $$'::uuid)$$, 'INVALID', 'used pass: refused');
select test.eq((select status from public.passes where id = :'gus_pack'::uuid), 'active', '...and the pass is untouched');

-- ---------------------------------------------------------------- another studio can't touch any of it
select test.admin();
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@platform.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'hank@harbour.test', '{"first_name":"Hank"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@platform.test', 'hank@harbour.test');
insert into public.platform_admins (user_id) values (test.id('pete'));
select test.login('pete');
select (public.platform_create_studio('Harbour Reformer Co.', 'harbour', 'hello@harbour.test', 'Australia/Sydney', 'AUD', 'en-AU', null, '12 Bay St', '{}'::jsonb) ->> 'id') as harbour_id \gset
select public.platform_invite_owner(:'harbour_id'::uuid, 'Hank', 'hank@harbour.test');
select test.admin();
select test.studio('harbour');
select test.login('hank');
select test.throws($$select public.undo_no_show(test.bk('bob', 's_early'))$$, 'NOT_FOUND', 'Harbour can''t undo a Snowy no-show');
select test.throws($$select public.undo_cancel_booking(test.bk('alice', 's_early'))$$, 'NOT_FOUND', 'Harbour can''t put back a Snowy booking');
select test.throws($$select public.waive_penalty(test.bk('alice', 's_early'))$$, 'NOT_FOUND', 'Harbour can''t waive a Snowy penalty');
select test.throws($$select public.restore_session(test.id('s_cancel'))$$, 'NOT_FOUND', 'Harbour can''t restore a Snowy class');
select test.throws($$select public.void_sale('$$ || :'used_sale' || $$'::uuid)$$, 'NOT_FOUND', 'Harbour can''t void a Snowy sale');
select test.studio('snowy');

rollback;
