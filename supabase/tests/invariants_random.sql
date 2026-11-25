-- Round 3: random-sequence invariant test (database level).
-- A few hundred random operations (book, cancel inside and outside the window, waitlist, promotion, studio cancel and restore, refund, late cancel,
-- no-show, waive, undo, move, check-in, capacity change, buy packs and memberships, adjust credits, clock moves) on 7 classes and 6 fake
-- clients. After EVERY step the invariants below are checked, and the run stops with the seed, the step number and the operation if one breaks.
--
--   capacity     booked + checked in never exceeds capacity; spots are unique, real, and given to everyone who holds a place
--   one booking  a client never has two live bookings (booked, waitlisted, checked in) in one class
--   credits      pack credits_used = starting use + bookings that consume a credit (booked, checked in, no-show, late cancel);
--                credits = purchased credits + adjustments; remaining is never negative; used_up only when it is used up
--   membership   never more bookings in a week than the weekly allowance
--   waitlist     positions are exactly 1..n, nobody outside the waitlist has one, a booking is promoted at most once, and a cancellation
--                before the cutoff always gives a free spot to the first waitlisted person who holds a usable pass
--   cancelled    a class the studio cancelled has no live bookings and no booking still holding a credit
--   money        refunds never exceed what was paid
--
-- Seeds: three by default. Reproduce or add one:  psql ... -v inv_seeds='7,99' -v inv_steps=300 -f supabase/tests/invariants_random.sql
-- (after the usual shim, migrations, seed and fixtures). The seed is fed to setseed() and nothing else is random, so a failure replays exactly.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

-- ---------------------------------------------------------------- helpers
create table test.rnd_base (pass_id uuid primary key, base_used int not null, base_credits int not null);
create table test.rnd_stats (seed int, k text, v int, primary key (seed, k));

create function test.rnd_pick(n int) returns int language sql as $$ select 1 + floor(random() * n)::int $$;

-- credit-consuming booking statuses
create function test.rnd_consumes(s text) returns boolean language sql immutable as $$ select s in ('booked','checked_in','no_show','late_cancelled') $$;

create function test.rnd_note_passes() returns void language sql as $$
  insert into test.rnd_base
  select p.id,
         p.credits_used - (select count(*)::int from public.bookings b where b.pass_id = p.id and test.rnd_consumes(b.status)),
         coalesce(p.credits, 0) - coalesce((select sum(delta)::int from public.pass_adjustments a where a.pass_id = p.id), 0)
    from public.passes p where p.kind in ('pack','dropin') and p.credits is not null
  on conflict do nothing
$$;

create function test.rnd_fail(p_seed int, p_step int, p_op text, p_what text) returns void language plpgsql as $$
begin
  raise exception 'INVARIANT BROKEN (seed %, step %, after "%"): %', p_seed, p_step, p_op, p_what;
end $$;

create function test.rnd_check(p_seed int, p_step int, p_op text) returns void language plpgsql as $$
declare r record; v_spots text[];
begin
  perform test.admin();
  -- capacity
  for r in select s.id, s.capacity, count(*) n from public.class_sessions s join public.bookings b on b.session_id = s.id and b.status in ('booked','checked_in')
            group by s.id having count(*) > s.capacity loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('class %s has %s booked, capacity %s', r.id, r.n, r.capacity));
  end loop;
  -- spots: everyone with a place in a spot class holds a real, unique spot
  for r in select b.session_id, b.client_id, b.spot from public.bookings b join public.class_sessions s on s.id = b.session_id
            join public.class_types ct on ct.id = s.class_type_id
           where b.status in ('booked','checked_in') and ct.spot_picking and (b.spot is null or b.spot not in ('1','2','3','4')) loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('booking in class %s holds spot "%s"', r.session_id, r.spot));
  end loop;
  for r in select session_id, spot from public.bookings where spot is not null and status in ('booked','checked_in','waitlisted')
            group by 1, 2 having count(*) > 1 loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('spot %s of class %s is held twice', r.spot, r.session_id));
  end loop;
  -- one live booking per client per class
  for r in select session_id, client_id, count(*) n from public.bookings where status in ('booked','waitlisted','checked_in')
            group by 1, 2 having count(*) > 1 loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('client %s has %s live bookings in class %s', r.client_id, r.n, r.session_id));
  end loop;
  -- credits
  for r in select p.*, base.base_used, base.base_credits,
                  (select count(*)::int from public.bookings b where b.pass_id = p.id and test.rnd_consumes(b.status)) as uses,
                  coalesce((select sum(delta)::int from public.pass_adjustments a where a.pass_id = p.id), 0) as adj
             from public.passes p join test.rnd_base base on base.pass_id = p.id loop
    if r.credits_used < 0 then perform test.rnd_fail(p_seed, p_step, p_op, format('pass %s credits_used negative', r.id)); end if;
    if r.credits_used <> r.base_used + r.uses then
      perform test.rnd_fail(p_seed, p_step, p_op, format('pass %s (%s) credits_used %s but %s start + %s consuming bookings', r.id, r.name, r.credits_used, r.base_used, r.uses));
    end if;
    if r.credits <> r.base_credits + r.adj then
      perform test.rnd_fail(p_seed, p_step, p_op, format('pass %s credits %s but %s bought + %s adjustments', r.id, r.credits, r.base_credits, r.adj));
    end if;
    if r.credits - r.credits_used < 0 then perform test.rnd_fail(p_seed, p_step, p_op, format('pass %s balance negative (%s of %s)', r.id, r.credits_used, r.credits)); end if;
    if r.status = 'used_up' and r.credits_used < r.credits then perform test.rnd_fail(p_seed, p_step, p_op, format('pass %s marked used_up with %s of %s used', r.id, r.credits_used, r.credits)); end if;
    if r.status = 'active' and r.credits_used >= r.credits then perform test.rnd_fail(p_seed, p_step, p_op, format('pass %s active with no credit left', r.id)); end if;
  end loop;
  -- membership weekly allowance
  for r in select p.id, p.credits, app.week_start(s.starts_at) wk, count(*) n
             from public.passes p join public.bookings b on b.pass_id = p.id and test.rnd_consumes(b.status) join public.class_sessions s on s.id = b.session_id
            where p.kind = 'membership' and p.credits is not null group by 1, 2, 3 having count(*) > p.credits loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('membership %s has %s bookings in a week with an allowance of %s', r.id, r.n, r.credits));
  end loop;
  -- waitlist: positions are exactly 1..n, and only waitlisted bookings have one
  for r in select session_id, count(*) n, count(distinct waitlist_position) d, min(waitlist_position) lo, max(waitlist_position) hi
             from public.bookings where status = 'waitlisted' group by 1
            having count(*) <> count(distinct waitlist_position) or min(waitlist_position) is distinct from 1 or max(waitlist_position) <> count(*) loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('waitlist of class %s is not 1..n (n=%s, distinct=%s, min=%s, max=%s)', r.session_id, r.n, r.d, r.lo, r.hi));
  end loop;
  for r in select id, session_id, status from public.bookings where status <> 'waitlisted' and waitlist_position is not null loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('%s booking in class %s still has a waitlist position', r.status, r.session_id));
  end loop;
  -- a booking is promoted at most once
  for r in select entity_id, count(*) n from public.audit_log where action = 'promote_waitlist' group by 1 having count(*) > 1 loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('booking %s was promoted %s times', r.entity_id, r.n));
  end loop;
  for r in select id from public.bookings where promoted_from_waitlist_at is not null and status in ('booked','checked_in') and pass_id is null loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('promoted booking %s took no credit', r.id));
  end loop;
  -- a class the studio cancelled holds nobody and no credit
  for r in select b.id, b.status from public.bookings b join public.class_sessions s on s.id = b.session_id
            where s.status = 'cancelled' and (b.status in ('booked','waitlisted','checked_in') or (b.pass_id is not null and test.rnd_consumes(b.status))) loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('cancelled class still has a %s booking (%s)', r.status, r.id));
  end loop;
  -- money
  for r in select id, total_cents, refunded_cents from public.sales where refunded_cents > total_cents or refunded_cents < 0 loop
    perform test.rnd_fail(p_seed, p_step, p_op, format('sale %s refunded %s of %s', r.id, r.refunded_cents, r.total_cents));
  end loop;
end $$;

-- After a cancellation before the cutoff, the first waitlisted client with a usable pass must have been given any free spot.
create function test.rnd_check_promotion(p_seed int, p_step int, p_op text, p_session uuid, p_now timestamptz) returns void language plpgsql as $$
declare s public.class_sessions; w record; v_booked int;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.status <> 'scheduled' or p_now >= s.starts_at - interval '1 hour' then return; end if;
  select count(*) into v_booked from public.bookings where session_id = s.id and status in ('booked','checked_in');
  if v_booked >= s.capacity then return; end if;
  for w in select * from public.bookings where session_id = s.id and status = 'waitlisted' loop
    if (app.best_pass(w.client_id, s.starts_at, s.class_type_id, p_now)).id is not null then
      perform test.rnd_fail(p_seed, p_step, p_op, format('class %s has a free spot and waitlisted client %s holds a usable pass', s.id, w.client_id));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- the run
create function test.rnd_run(p_seed int, p_steps int) returns text language plpgsql as $$
declare
  v_now timestamptz := '2026-10-19 08:00+11';
  v_names text[] := array['alice','bob','cara','dan','fay','gus'];
  v_sessions text[] := array['r1','r2','r3','r4','r5','r6','r7'];
  v_prod text[] := array['p_pack4','p_single','p_week1','p_week2','p_unlimited','p_pack8'];
  i int; v_roll int; v_op text; v_desc text := 'start'; v_cl text; v_ss text;
  v_b record; v_p record; v_sale uuid; v_sid uuid; v_res jsonb; v_code text;
  v_ops int := 0; v_refused int := 0; v_bookings int := 0; v_cancels int := 0; v_promos int := 0; v_wait int := 0; v_studio_cancels int := 0; v_refunds int := 0; v_buys int := 0;
  v_state text; v_msg text; v_use_pass boolean; v_skipped int := 0;
  v_known text[] := array['ALREADY_BOOKED','NO_CREDITS','CLASS_FULL','TOO_LATE','TOO_EARLY','INVALID','NOT_FOUND','CLASS_CANCELLED','NOT_BOOKABLE','SPOT_TAKEN','WAIVER_REQUIRED','NOT_ALLOWED'];
begin
  perform setseed(sin(p_seed));   -- any integer seed, mapped into setseed's range
  perform test.at(v_now::text);
  for i in 1..p_steps loop
    v_roll := test.rnd_pick(100);
    v_sid := null;
    perform test.admin();
    begin
      if v_roll <= 28 then                                           -- client books (auto pass, or one of their own)
        v_op := 'book'; v_cl := v_names[test.rnd_pick(6)]; v_ss := v_sessions[test.rnd_pick(7)];
        v_desc := format('%s books %s', v_cl, v_ss); v_sid := test.id(v_ss);
        v_use_pass := test.rnd_pick(10) <= 3;
        select p.id into v_p from public.passes p where p.client_id = test.id(v_cl || '_client') and v_use_pass
         order by p.purchased_at, p.name, p.ctid limit 1;
        perform test.login(v_cl);
        v_res := public.book_class(test.id(v_ss), v_p.id);
        v_bookings := v_bookings + 1;
        if v_res ->> 'outcome' = 'waitlisted' then v_wait := v_wait + 1; end if;
      elsif v_roll <= 42 then                                        -- client cancels (booked or waitlisted)
        v_op := 'cancel'; v_cl := v_names[test.rnd_pick(6)];
        select b.id, b.session_id, b.status into v_b from public.bookings b where b.client_id = test.id(v_cl || '_client') and b.status in ('booked','waitlisted')
         order by b.created_at, b.ctid limit 1;
        v_desc := format('%s cancels %s', v_cl, coalesce(v_b.status, 'nothing')); v_sid := case when v_b.status = 'booked' then v_b.session_id end;   -- (leaving the waitlist frees nothing)
        perform test.login(v_cl);
        if v_b.id is null then raise exception 'SKIP'; end if;
        v_res := public.cancel_booking(v_b.id);
        v_cancels := v_cancels + 1;
        if v_res -> 'promoted' is not null and v_res -> 'promoted' <> 'null'::jsonb then v_promos := v_promos + 1; end if;
      elsif v_roll <= 46 then                                        -- front desk cancels (maybe waiving the late penalty)
        v_op := 'staff_cancel';
        select b.id, b.session_id, b.status into v_b from public.bookings b where b.status in ('booked','checked_in','no_show')
         order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid offset test.rnd_pick(greatest(1, (select count(*)::int from public.bookings where status in ('booked','checked_in','no_show')))) - 1 limit 1;
        v_desc := format('front desk cancels a %s booking', coalesce(v_b.status, 'nothing')); v_sid := v_b.session_id;
        perform test.login('fran');
        if v_b.id is null then raise exception 'SKIP'; end if;
        v_res := public.cancel_booking(v_b.id, test.rnd_pick(2) = 1, true);
        v_cancels := v_cancels + 1;
        if v_res -> 'promoted' is not null and v_res -> 'promoted' <> 'null'::jsonb then v_promos := v_promos + 1; end if;
      elsif v_roll <= 50 then                                        -- client leaves the waitlist
        v_op := 'leave_waitlist'; v_cl := v_names[test.rnd_pick(6)];
        select b.id into v_b from public.bookings b where b.client_id = test.id(v_cl || '_client') and b.status = 'waitlisted' limit 1;
        v_desc := format('%s leaves the waitlist', v_cl);
        perform test.login(v_cl);
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.leave_waitlist(v_b.id);
      elsif v_roll <= 51 then                                        -- the studio cancels a class
        v_op := 'cancel_session'; v_ss := v_sessions[test.rnd_pick(7)];
        v_desc := format('studio cancels %s', v_ss);
        perform test.login(case when test.rnd_pick(2) = 1 then 'fran' else 'libby' end);
        perform public.cancel_session(test.id(v_ss), 'invariant test');
        v_studio_cancels := v_studio_cancels + 1;
      elsif v_roll <= 54 then                                        -- ...and more often puts it back puts it back
        v_op := 'restore_session'; v_ss := v_sessions[test.rnd_pick(7)];
        v_desc := format('studio restores %s', v_ss);
        perform test.login('libby');
        perform public.restore_session(test.id(v_ss));
      elsif v_roll <= 62 then                                        -- someone buys a pass at the desk
        v_op := 'buy'; v_cl := v_names[test.rnd_pick(6)]; v_ss := v_prod[test.rnd_pick(6)];
        v_desc := format('%s buys %s', v_cl, v_ss);
        perform test.login('fran');
        perform public.checkout_cart(test.id(v_cl || '_client'), jsonb_build_array(jsonb_build_object('product_id', test.id(v_ss))), 'cash');
        v_buys := v_buys + 1;
      elsif v_roll <= 65 then                                        -- refund a sale (sometimes cancelling the pass)
        v_op := 'refund';
        select s.id into v_sale from public.sales s where s.refunded_at is null and s.total_cents > 0
         order by s.created_at, (select email from public.clients c where c.id = s.client_id), s.total_cents, s.ctid offset test.rnd_pick(greatest(1, (select count(*)::int from public.sales where refunded_at is null and total_cents > 0))) - 1 limit 1;
        v_desc := 'refund a sale';
        perform test.login(case when test.rnd_pick(2) = 1 then 'fran' else 'libby' end);
        if v_sale is null then raise exception 'SKIP'; end if;
        perform public.refund_sale(v_sale, null, test.rnd_pick(2) = 1, 'invariant test');
        v_refunds := v_refunds + 1;
      elsif v_roll <= 69 then                                        -- no-show
        v_op := 'no_show';
        select b.id, b.session_id into v_b from public.bookings b where b.status = 'booked'
         order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid offset test.rnd_pick(greatest(1, (select count(*)::int from public.bookings where status = 'booked'))) - 1 limit 1;
        v_desc := 'mark a booking as no-show';
        perform test.login('libby');
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.mark_no_show(v_b.id);
      elsif v_roll <= 73 then                                        -- waive a late cancel or no-show
        v_op := 'waive';
        select b.id into v_b from public.bookings b where b.status in ('late_cancelled','no_show')
         order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid limit 1;
        v_desc := 'waive a penalty';
        perform test.login('libby');
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.waive_penalty(v_b.id);
      elsif v_roll <= 75 then
        v_op := 'undo_no_show';
        select b.id into v_b from public.bookings b where b.status = 'no_show' order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid limit 1;
        v_desc := 'undo a no-show';
        perform test.login('libby');
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.undo_no_show(v_b.id);
      elsif v_roll <= 79 then                                        -- put a cancelled booking back
        v_op := 'undo_cancel';
        select b.id, b.session_id into v_b from public.bookings b where b.status in ('cancelled','late_cancelled','removed')
         order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid
         offset test.rnd_pick(greatest(1, (select count(*)::int from public.bookings where status in ('cancelled','late_cancelled','removed')))) - 1 limit 1;
        v_desc := 'undo a cancellation'; v_sid := v_b.session_id;
        perform test.login('libby');
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.undo_cancel_booking(v_b.id);
      elsif v_roll <= 83 then                                        -- staff move a booking
        v_op := 'move'; v_ss := v_sessions[test.rnd_pick(7)];
        select b.id into v_b from public.bookings b where b.status = 'booked'
         order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid offset test.rnd_pick(greatest(1, (select count(*)::int from public.bookings where status = 'booked'))) - 1 limit 1;
        v_desc := format('staff move a booking to %s', v_ss);
        perform test.login('libby');
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.move_booking(v_b.id, test.id(v_ss));
      elsif v_roll <= 86 then                                        -- staff book a client in
        v_op := 'staff_book'; v_cl := v_names[test.rnd_pick(6)]; v_ss := v_sessions[test.rnd_pick(7)];
        v_desc := format('staff book %s into %s', v_cl, v_ss); v_sid := test.id(v_ss);
        perform test.login('fran');
        perform public.book_class(test.id(v_ss), null, test.id(v_cl || '_client'), true);
      elsif v_roll <= 89 then                                        -- check in
        v_op := 'check_in';
        select b.id into v_b from public.bookings b where b.status = 'booked'
         order by (select email from public.clients c where c.id = b.client_id), b.created_at, b.ctid offset test.rnd_pick(greatest(1, (select count(*)::int from public.bookings where status = 'booked'))) - 1 limit 1;
        v_desc := 'check someone in';
        perform test.login('libby');
        if v_b.id is null then raise exception 'SKIP'; end if;
        perform public.check_in(v_b.id);
      elsif v_roll <= 92 then                                        -- adjust a pack's credits
        v_op := 'adjust';
        select p.id into v_p from public.passes p where p.kind in ('pack','dropin') and p.credits is not null
         order by (select email from public.clients c where c.id = p.client_id), p.purchased_at, p.name, p.ctid
         offset test.rnd_pick(greatest(1, (select count(*)::int from public.passes where kind in ('pack','dropin') and credits is not null))) - 1 limit 1;
        v_desc := 'adjust a pack';
        perform test.login('libby');
        if v_p.id is null then raise exception 'SKIP'; end if;
        perform public.adjust_pass(v_p.id, (array[-2,-1,1,2])[test.rnd_pick(4)], null, false, 'invariant test');
      elsif v_roll <= 94 then                                        -- change a class size (never below who is already in)
        v_op := 'capacity'; v_ss := v_sessions[test.rnd_pick(7)];
        v_desc := format('resize %s', v_ss);
        perform test.login('libby');
        update public.class_sessions set capacity = greatest(
            (select count(*)::int from public.bookings where session_id = class_sessions.id and status in ('booked','checked_in')), test.rnd_pick(4))
         where id = test.id(v_ss);
      elsif v_roll <= 95 then                                        -- a member cancels their membership
        v_op := 'cancel_membership'; v_cl := v_names[test.rnd_pick(6)];
        select p.id into v_p from public.passes p where p.client_id = test.id(v_cl || '_client') and p.kind = 'membership' and p.status = 'active' limit 1;
        v_desc := format('%s cancels a membership', v_cl);
        perform test.login(v_cl);
        if v_p.id is null then raise exception 'SKIP'; end if;
        perform public.cancel_membership(v_p.id, 'Taking a break');
      else                                                           -- time passes
        v_op := 'time'; v_now := v_now + make_interval(mins => 5 + test.rnd_pick(55));
        v_desc := 'clock moves to ' || to_char(v_now at time zone 'Australia/Sydney', 'Dy DD HH24:MI');
        perform test.at(v_now::text);
      end if;
      v_ops := v_ops + 1;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_state := sqlstate;
      v_code := split_part(v_msg, ':', 1);
      if v_msg = 'SKIP' then
        v_skipped := v_skipped + 1; v_sid := null;
      elsif v_state = 'P0001' and v_code = any (v_known) then
        v_refused := v_refused + 1; v_ops := v_ops + 1;
        v_desc := v_desc || ' -> refused ' || v_code; v_sid := null;
        insert into test.rnd_stats values (p_seed, 'refused_' || v_code, 1) on conflict (seed, k) do update set v = test.rnd_stats.v + 1;
      elsif v_msg like 'INVARIANT%' then raise;
      else
        raise exception 'seed %, step %, "%": unexpected error % %', p_seed, i, v_desc, v_state, v_msg;
      end if;
    end;
    perform test.admin();
    if v_op in ('cancel', 'staff_cancel') and v_sid is not null then
      perform test.rnd_check_promotion(p_seed, i, v_desc, v_sid, v_now);
    end if;
    perform test.rnd_note_passes();
    perform test.rnd_check(p_seed, i, v_desc);
  end loop;
  return format('seed %s: %s steps (%s had nothing to act on), %s refused as expected, %s bookings/joins, %s waitlisted, %s cancels, %s promotions, %s studio cancels, %s refunds, %s purchases',
                p_seed, v_ops + v_skipped, v_skipped, v_refused, v_bookings, v_wait, v_cancels, v_promos, v_studio_cancels, v_refunds, v_buys);
end $$;

-- ---------------------------------------------------------------- the world: 7 classes, spots on for the mat class
select test.login('libby');
update public.rooms set spot_layout = '{"rows":2,"cols":3,"cells":[{"label":"Instructor","kind":"instructor"},{"label":"1","kind":"spot"},{"label":"2","kind":"spot"},{"label":"","kind":"unavailable"},{"label":"3","kind":"spot"},{"label":"4","kind":"spot"}]}'
 where location_id in (select id from public.locations where is_default);
update public.class_types set spot_picking = true where id = test.id('mat');
select test.admin();
select test.mk_session('r1', 'mat',  '2026-10-19 12:00+11', 1, 'julia');
select test.mk_session('r2', 'mat',  '2026-10-19 18:00+11', 2, 'gracet');
select test.mk_session('r3', 'mat',  '2026-10-20 10:00+11', 3, 'libby');
select test.mk_session('r4', 'mat',  '2026-10-20 14:00+11', 4, 'julia');
select test.mk_session('r5', 'mums', '2026-10-20 17:00+11', 2, 'gracet');
select test.mk_session('r6', 'mat',  '2026-10-21 09:00+11', 2, 'libby');
select test.mk_session('r7', 'mums', '2026-10-21 12:00+11', 3, 'julia');
-- Cara has no pass, Erin never signed the waiver (not used). Everyone else starts with what the fixtures gave them.
select test.rnd_note_passes();

-- A wrapper so each seed reports its own line.
create function test.rnd_report(p_seed int, p_steps int) returns void language plpgsql as $$
declare line text;
begin
  line := test.rnd_run(p_seed, p_steps);
  raise notice 'ok - %', line;
  raise notice '       refused as expected: %', (select coalesce(string_agg(replace(k, 'refused_', '') || ' x' || st.v, ', ' order by k), 'none') from test.rnd_stats st where st.seed = p_seed);
end $$;

-- The seeds: three by default; override with -v inv_seeds='1,2' and -v inv_steps=N. Each runs from the same clean slate.
\if :{?inv_seeds} \else \set inv_seeds '9,11,29' \endif
\if :{?inv_steps} \else \set inv_steps 300 \endif
savepoint world;

-- Regression (3200): undoing a no-show into a class that filled up in the meantime used to overbook it.
select test.login('alice'); select public.book_class(test.id('r1'));
select test.login('libby'); select public.mark_no_show((select id from public.bookings where session_id = test.id('r1') and status = 'booked'));
select test.login('bob'); select public.book_class(test.id('r1'));
select test.login('libby');
select test.throws($$select public.undo_no_show((select id from public.bookings where session_id = test.id('r1') and status = 'no_show'))$$, 'CLASS_FULL', 'undo no-show refuses when someone has taken the spot');
select test.admin();
rollback to savepoint world;

-- Regression (3200): a no-show who booked the class again can't be undone or checked in (it used to be a raw unique-key error).
select test.login('dan'); select public.book_class(test.id('r4'));
select test.login('libby'); select public.mark_no_show((select id from public.bookings where session_id = test.id('r4') and client_id = test.id('dan_client')));
select test.login('fran'); select public.book_class(test.id('r4'), null, test.id('dan_client'), true);
select test.login('libby');
select test.throws($$select public.undo_no_show((select id from public.bookings where session_id = test.id('r4') and client_id = test.id('dan_client') and status = 'no_show'))$$, 'ALREADY_BOOKED', 'undo no-show refuses when they are booked again');
select test.throws($$select public.check_in((select id from public.bookings where session_id = test.id('r4') and client_id = test.id('dan_client') and status = 'no_show'))$$, 'ALREADY_BOOKED', 'checking in the old no-show refuses when they are booked again');
select test.admin();
rollback to savepoint world;

-- Regression (3200): a late cancel followed by the studio cancelling the class gives the credit back (and restoring the class doesn't resurrect them).
select test.at('2026-10-19 10:30+11');
select test.login('alice'); select public.book_class(test.id('r1'));
select test.admin(); select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, 'alice has used a credit');
select test.at('2026-10-19 11:00+11');
select test.login('alice'); select public.cancel_booking((select id from public.bookings where session_id = test.id('r1') and client_id = test.id('alice_client')));
select test.admin();
select test.eq((select status from public.bookings where session_id = test.id('r1') and client_id = test.id('alice_client')), 'late_cancelled', 'cancelled inside the window');
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 1, '...credit forfeited');
select test.login('fran'); select public.cancel_session(test.id('r1'), 'instructor sick');
select test.admin();
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 0, 'studio cancels the class: the forfeited credit comes back');
select test.login('libby'); select public.restore_session(test.id('r1'));
select test.admin();
select test.eq((select count(*)::int from public.bookings where session_id = test.id('r1') and status in ('booked','checked_in')), 0, 'restoring the class does not put the late canceller back');
select test.eq((select credits_used from public.passes where client_id = test.id('alice_client')), 0, '...and takes no credit');
select test.at('2026-10-19 08:00+11');
rollback to savepoint world;
select format('select test.rnd_report(%s, %s); rollback to savepoint world;', s, :inv_steps) from unnest(string_to_array(:'inv_seeds', ',')) s \gexec
rollback;
