import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, asClient, baseState, harness, JULIA, mkClient, mkSession, OWNER, rejects } from './helpers';
import { STAFF } from '../src/data/demo/fixtures';

const NOW = at('2026-10-12', '08:00'); // Monday

function state(extra: { capacity?: number } = {}) {
  return baseState({
    clients: [mkClient('a', 'Amy'), mkClient('b', 'Bea'), mkClient('c', 'Cat'), mkClient('d', 'Dee'), mkClient('nw', 'Newbie', { waiverSignedAt: undefined })],
    sessions: [
      mkSession('mon18', '2026-10-12', '18:00', { capacity: extra.capacity ?? 14 }),
      mkSession('wed18', '2026-10-14', '18:00'),
      mkSession('sun09', '2026-10-18', '09:00'),
      mkSession('mon19', '2026-10-19', '06:00'),
      mkSession('far', '2026-12-28', '06:00'),
    ],
  });
}

test('booking takes the best credit and activates it on first use', async () => {
  const h = await harness(state(), NOW);
  const pack = await h.give('a', 'pr_p4');
  h.setNow(at('2026-10-12', '09:00'));
  const unl = await h.give('a', 'pr_mu');
  await h.as(asClient('a'));
  const r = await h.store.bookClass('a', 'mon18');
  assert.equal(r.outcome, 'booked');
  assert.equal(r.pass?.id, unl, 'unlimited membership is used before a pack');
  assert.equal(r.pass?.activatedAt, at('2026-10-12', '09:00').toISOString());
  const passes = await h.store.listPasses('a');
  const p4 = passes.find((p) => p.id === pack)!;
  assert.equal(p4.activatedAt, undefined, 'pack untouched');
  // client can pick a specific pass
  const r2 = await h.store.bookClass('a', 'wed18', { passId: pack });
  assert.equal(r2.pass?.id, pack);
  assert.equal(r2.pass?.creditsUsed, 1);
  assert.equal(r2.pass?.expiresAt, new Date(at('2026-10-12', '09:00').getTime() + 61 * 86_400_000).toISOString());
  const summary = await h.store.getCreditSummary('a');
  assert.deepEqual(summary.map((s) => s.label), ['Unlimited', '3 of 4 left']);
});

test('expiry runs from first use, not purchase', async () => {
  const h = await harness(state(), at('2026-08-01', '08:00'));
  const id = await h.give('a', 'pr_drop'); // bought 1 Aug, 61 day validity
  h.setNow(NOW);
  await h.as(asClient('a'));
  const r = await h.store.bookClass('a', 'mon18');
  assert.equal(r.pass?.id, id);
  assert.equal(r.pass?.activatedAt, NOW.toISOString());
  assert.equal(r.pass?.expiresAt, new Date(NOW.getTime() + 61 * 86_400_000).toISOString());
  // a pack can't be used for a class after its expiry
  const h2 = await harness(state(), NOW);
  await h2.give('b', 'pr_intro');
  await h2.as(asClient('b'));
  await rejects(h2.store.bookClass('b', 'far'), 'TOO_EARLY');
  await h2.as(OWNER);
  await rejects(h2.store.bookClass('b', 'far'), 'NO_CREDITS'); // intro would have expired by 28 Dec
});

test('membership weekly credits reset on Monday (studio week)', async () => {
  const h = await harness(state(), NOW);
  await h.give('a', 'pr_m1');
  await h.as(asClient('a'));
  await h.store.bookClass('a', 'sun09');
  await rejects(h.store.bookClass('a', 'wed18'), 'NO_CREDITS');
  const next = await h.store.bookClass('a', 'mon19');
  assert.equal(next.outcome, 'booked');
  const s = await h.store.getCreditSummary('a', 'mon19');
  assert.equal(s.length, 0, 'week of 19 Oct now used up');
  const thisWeek = await h.store.getCreditSummary('a');
  assert.equal(thisWeek[0]!.label, '0 of 1 left this week');
  // cancelling in time frees the week's credit again
  const bookings = await h.store.listClientBookings('a', { when: 'upcoming' });
  await h.store.cancelBooking(bookings.find((b) => b.sessionId === 'sun09')!.id);
  assert.equal((await h.store.bookClass('a', 'wed18')).outcome, 'booked');
});

test('cancel at 3h01m returns the credit; 2h59m is a late cancel; staff can waive', async () => {
  const h = await harness(state(), NOW);
  const pid = await h.give('a', 'pr_p4');
  await h.as(asClient('a'));
  const b1 = await h.store.bookClass('a', 'mon18');
  h.setNow(new Date(at('2026-10-12', '18:00').getTime() - (3 * 60 + 1) * 60_000));
  const c1 = await h.store.cancelBooking(b1.booking.id);
  assert.equal(c1.booking.status, 'cancelled');
  assert.equal(c1.creditReturned, true);
  assert.equal((await h.store.listPasses('a'))[0]!.creditsUsed, 0);

  const b2 = await h.store.bookClass('a', 'mon18');
  h.setNow(new Date(at('2026-10-12', '18:00').getTime() - (2 * 60 + 59) * 60_000));
  const c2 = await h.store.cancelBooking(b2.booking.id);
  assert.equal(c2.booking.status, 'late_cancelled');
  assert.equal(c2.lateCancel, true);
  assert.equal(c2.creditReturned, false);
  assert.equal((await h.store.listPasses('a')).find((p) => p.id === pid)!.creditsUsed, 1);
  await rejects(h.store.cancelBooking(b2.booking.id, { waivePenalty: true }), 'NOT_ALLOWED');

  // staff waive inside the window
  const b3 = await h.store.bookClass('a', 'mon18');
  await h.as(OWNER);
  const c3 = await h.store.cancelBooking(b3.booking.id, { asStaff: true, waivePenalty: true });
  assert.equal(c3.booking.status, 'cancelled');
  assert.equal(c3.creditReturned, true);
  assert.equal((await h.store.listPasses('a')).find((p) => p.id === pid)!.creditsUsed, 1);
  // clients can't cancel once class has started
  await h.as(asClient('a'));
  const b4 = await h.store.bookClass('a', 'wed18');
  h.setNow(at('2026-10-14', '18:05'));
  await rejects(h.store.cancelBooking(b4.booking.id), 'TOO_LATE');
});

test('waitlist: promotes the first waitlisted client with a credit, stops at the 1h cutoff', async () => {
  const h = await harness(state({ capacity: 2 }), NOW);
  for (const c of ['a', 'b', 'd']) await h.give(c, 'pr_p4');
  await h.as(asClient('a')); const ba = await h.store.bookClass('a', 'mon18');
  await h.as(asClient('b')); const bb = await h.store.bookClass('b', 'mon18');
  await h.as(asClient('c')); const wc = await h.store.bookClass('c', 'mon18'); // no credit at all
  assert.equal(wc.outcome, 'waitlisted');
  assert.equal(wc.booking.waitlistPosition, 1);
  await h.as(asClient('d')); const wd = await h.store.bookClass('d', 'mon18');
  assert.equal(wd.outcome, 'waitlisted');
  assert.equal(wd.booking.waitlistPosition, 2);
  assert.equal(wd.pass, undefined, 'no credit taken while waitlisted');
  await rejects(h.store.bookClass('d', 'mon18'), 'ALREADY_BOOKED');

  let fired = 0;
  const unsub = h.store.subscribe(() => { fired++; });
  await h.as(asClient('a'));
  const res = await h.store.cancelBooking(ba.booking.id);
  assert.ok(fired > 0, 'subscribers notified');
  unsub();
  assert.equal(res.promoted?.clientId, 'd', 'Cat has no credit, so Dee is promoted');
  assert.equal(res.promoted?.status, 'booked');
  assert.ok(res.promoted?.promotedFromWaitlistAt);
  assert.ok(res.promoted?.passId);
  const s = await h.store.getSession('mon18');
  assert.equal(s.bookedCount, 2);
  assert.equal(s.waitlistCount, 1);
  await h.as(OWNER);
  const roster = await h.store.getRoster('mon18');
  assert.deepEqual(roster.map((r) => [r.client.firstName, r.status, r.waitlistPosition ?? null]), [['Bea', 'booked', null], ['Dee', 'booked', null], ['Cat', 'waitlisted', 1]]);

  // Cat buys a pack, then a spot opens 50 min before class: past the cutoff, nothing happens.
  await h.give('c', 'pr_p4');
  h.setNow(new Date(at('2026-10-12', '18:00').getTime() - 50 * 60_000));
  await h.as(asClient('b'));
  const late = await h.store.cancelBooking(bb.booking.id);
  assert.equal(late.promoted, undefined);
  assert.equal((await h.store.getSession('mon18')).spotsLeft, 1);
  // when class starts the waitlist is cleared (lazily on read)
  h.setNow(at('2026-10-12', '18:00'));
  await h.as(OWNER);
  const after = await h.store.getRoster('mon18');
  assert.equal(after.some((r) => r.status === 'waitlisted'), false);
  assert.equal((await h.store.getSession('mon18')).waitlistCount, 0);
});

test('waiver, started classes and staff overrides', async () => {
  const h = await harness(state({ capacity: 1 }), NOW);
  await h.give('nw', 'pr_p4');
  await h.give('a', 'pr_p4');
  await h.as(asClient('nw'));
  await rejects(h.store.bookClass('nw', 'mon18'), 'WAIVER_REQUIRED');
  await rejects(h.store.bookClass('a', 'mon18'), 'NOT_ALLOWED');
  await h.as(OWNER);
  const staffBooked = await h.store.bookClass('nw', 'mon18', { asStaff: true });
  assert.equal(staffBooked.booking.source, 'staff');
  const roster = await h.store.getRoster('mon18');
  assert.ok(roster[0]!.flags.includes('no_waiver'));
  assert.ok(roster[0]!.flags.includes('first_class'));
  // full: staff can squeeze in and comp
  const squeezed = await h.store.bookClass('a', 'mon18', { asStaff: true, allowOverCapacity: true, skipCredit: true });
  assert.equal(squeezed.outcome, 'booked');
  assert.equal(squeezed.pass, undefined);
  // after start: clients can't book, staff can until the end
  h.setNow(at('2026-10-12', '18:10'));
  await h.as(asClient('b'));
  await rejects(h.store.bookClass('b', 'mon18'), 'TOO_LATE');
  await h.as(OWNER);
  await h.give('b', 'pr_drop');
  assert.equal((await h.store.bookClass('b', 'mon18', { asStaff: true, allowOverCapacity: true })).outcome, 'booked');
  h.setNow(at('2026-10-12', '19:00'));
  await rejects(h.store.bookClass('c', 'mon18', { asStaff: true, skipCredit: true }), 'TOO_LATE');
  // submit waiver unlocks client bookings
  await h.as(asClient('nw'));
  const c = await h.store.submitWaiver('nw', { answers: { Q: 'No' }, injuries: 'Sore wrist' });
  assert.ok(c.waiverSignedAt);
  assert.equal(c.injuries, 'Sore wrist');
  assert.equal((await h.store.bookClass('nw', 'wed18')).outcome, 'booked');
});

test('intro offer: new clients only, once', async () => {
  const h = await harness(state(), NOW);
  assert.equal(await h.store.isIntroEligible('a'), true);
  await h.as(asClient('a'));
  const r = await h.store.purchase({ productId: 'pr_intro', method: 'card_online' });
  assert.equal(r.pass?.kind, 'intro');
  assert.equal(r.sale.totalCents, 4900);
  assert.equal(await h.store.isIntroEligible('a'), false);
  await rejects(h.store.purchase({ productId: 'pr_intro', method: 'card_online' }), 'INTRO_NOT_ELIGIBLE');
  await rejects(h.store.purchase({ productId: 'pr_p4', method: 'cash' }), 'NOT_ALLOWED');
  await h.give('b', 'pr_drop');
  await h.as(OWNER);
  assert.equal(await h.store.isIntroEligible('b'), false);
  await rejects(h.store.purchase({ clientId: 'b', productId: 'pr_intro', method: 'cash' }), 'INTRO_NOT_ELIGIBLE');
});

test('cancelSession removes everyone and returns credits', async () => {
  const h = await harness(state({ capacity: 1 }), NOW);
  const pa = await h.give('a', 'pr_p4');
  await h.give('b', 'pr_p4');
  await h.as(asClient('a')); await h.store.bookClass('a', 'mon18');
  await h.as(asClient('b')); const w = await h.store.bookClass('b', 'mon18');
  assert.equal(w.outcome, 'waitlisted');
  await h.as(OWNER);
  await h.store.cancelSession('mon18', 'Instructor unwell');
  const s = await h.store.getSession('mon18');
  assert.equal(s.status, 'cancelled');
  assert.equal(s.bookedCount + s.waitlistCount, 0);
  assert.equal((await h.store.listPasses('a')).find((p) => p.id === pa)!.creditsUsed, 0);
  const ab = await h.store.listClientBookings('a');
  assert.equal(ab[0]!.status, 'removed');
  await rejects(h.store.bookClass('a', 'mon18'), 'CLASS_CANCELLED');
});

test('paused membership blocks bookings during the pause', async () => {
  const h = await harness(state(), NOW);
  const pid = await h.give('a', 'pr_m2');
  await h.as(asClient('a'));
  await h.store.bookClass('a', 'mon18'); // activates
  await rejects(h.store.pausePass(pid, '2026-10-13', '2026-10-15'), 'INVALID'); // < 1 week
  await h.store.bookClass('a', 'sun09');
  const paused = await h.store.pausePass(pid, '2026-10-13', '2026-10-19');
  assert.equal(paused.pausedFrom, '2026-10-13');
  const bk = await h.store.listClientBookings('a');
  assert.equal(bk.find((b) => b.sessionId === 'sun09')!.status, 'cancelled', 'bookings inside the pause are cancelled');
  await rejects(h.store.bookClass('a', 'wed18'), 'NO_CREDITS');
  await rejects(h.store.bookClass('a', 'mon19'), 'NO_CREDITS');
  await h.store.resumePass(pid);
  assert.equal((await h.store.bookClass('a', 'wed18')).outcome, 'booked');
});

test('cancelled membership stays usable until next billing; weekly billing creates sales', async () => {
  const h = await harness(state(), NOW);
  const pid = await h.give('a', 'pr_m2');
  await h.as(asClient('a'));
  await h.store.bookClass('a', 'mon18'); // activated 12 Oct 8am → bills 19 Oct 8am
  h.setNow(at('2026-10-20', '07:00'));
  await h.as(OWNER);
  const sales = await h.store.listSales({ from: '2026-10-01', to: '2026-10-31', clientId: 'a' });
  assert.equal(sales.length, 2, 'purchase + one weekly debit');
  await h.as(asClient('a'));
  const c = await h.store.cancelMembership(pid);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.nextBillingAt, at('2026-10-26', '08:00').toISOString());
  const passes = await h.store.listPasses('a');
  assert.equal(passes.length, 1, 'still current until next billing date');
});

test('moveBooking moves the credit; refunds, stock and adjustments', async () => {
  const h = await harness(state(), NOW);
  const pid = await h.give('a', 'pr_p4');
  await h.as(asClient('a'));
  const b = await h.store.bookClass('a', 'mon18');
  await h.as(OWNER);
  const moved = await h.store.moveBooking!(b.booking.id, 'wed18');
  assert.equal(moved.booking.sessionId, 'wed18');
  assert.equal(moved.pass?.id, pid);
  assert.equal(moved.pass?.creditsUsed, 1);
  assert.equal((await h.store.getSession('mon18')).bookedCount, 0);

  const adj = await h.store.adjustPass(pid, { creditsDelta: 2, reason: 'Goodwill' });
  assert.equal(adj.credits, 6);
  assert.equal(adj.adjustments?.[0]?.reason, 'Goodwill');
  await rejects(h.store.adjustPass(pid, { creditsDelta: -6, reason: 'oops' }), 'INVALID');

  const cart = await h.store.checkoutCart({ clientId: 'b', items: [{ productId: 'pr_socks', qty: 2 }, { productId: 'pr_p8', qty: 1 }], method: 'card_reader', discountCents: 1000 });
  assert.equal(cart.sale.totalCents, 2 * 2000 + 19000 - 1000);
  assert.equal(cart.passes.length, 1);
  const socks = (await h.store.listProducts({ kinds: ['retail'] })).find((p) => p.id === 'pr_socks')!;
  assert.equal(socks.stock, 22);
  await rejects(h.store.purchase({ productId: 'pr_socks', qty: 50, method: 'cash' }), 'OUT_OF_STOCK');
  await rejects(h.store.purchase({ productId: 'pr_p4', method: 'cash' }), 'INVALID'); // pass needs a client

  const refunded = await h.store.refundSale(cart.sale.id, { cancelPass: true, reason: 'Changed mind' });
  assert.equal(refunded.refundedCents, cart.sale.totalCents);
  assert.equal((await h.store.listPasses('b')).length, 0);
  await rejects(h.store.refundSale(cart.sale.id, { amountCents: 100 }), 'INVALID');
});

test('permissions: instructors, front desk and clients', async () => {
  const st = state();
  st.staff.push({ id: 'st_fd', name: 'Desk', email: 'desk@example.com', role: 'front_desk', active: true });
  const h = await harness(st, NOW);
  await h.give('a', 'pr_p4');
  // instructor: own class roster only, no refunds, no revenue
  await h.as(JULIA);
  assert.ok(await h.store.getRoster('mon18')); // Julia teaches the fixture classes
  const sale = (await (async () => { await h.as(OWNER); return h.store.listSales({ from: '2026-10-01', to: '2026-10-31' }); })())[0]!;
  await h.as(JULIA);
  await rejects(h.store.refundSale(sale.id), 'NOT_ALLOWED');
  const r = await h.store.getReport({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.revenueCents, 0);
  const clients = await h.store.listClients();
  assert.ok(clients.every((c) => c.staffNotes === undefined));
  await h.as(OWNER);
  await h.store.upsertSession({ ...(await h.store.getSession('wed18')), instructorId: 'st_gracet' });
  await h.as(JULIA);
  await rejects(h.store.getRoster('wed18'), 'NOT_ALLOWED');
  await rejects(h.store.updateSettings({ cancelWindowHours: 4 }), 'NOT_ALLOWED');
  // front desk: POS + refunds, no revenue in reports, no settings
  await h.as({ kind: 'staff', staffId: 'st_fd', email: '', name: '', role: 'front_desk' });
  assert.ok(await h.store.getRoster('wed18'));
  assert.equal((await h.store.getReport({ from: '2026-10-01', to: '2026-10-31' })).revenueCents, 0);
  await rejects(h.store.exportSalesCsv({ from: '2026-10-01', to: '2026-10-31' }), 'NOT_ALLOWED');
  assert.match(await h.store.exportClientsCsv(), /^First name,Last name,Email/);
  // owner sees revenue and pay
  await h.as(OWNER);
  assert.equal((await h.store.getReport({ from: '2026-10-01', to: '2026-10-31' })).revenueCents, 10000);
  const staff = await h.store.listStaff();
  assert.equal(staff.find((s) => s.id === 'st_julia')!.payPerClassCents, 6000);
  // clients: own data only, no staff fields
  await h.as(asClient('b'));
  await rejects(h.store.getClient('a'), 'NOT_ALLOWED');
  await rejects(h.store.listClients(), 'NOT_ALLOWED');
  await rejects(h.store.listPasses('a'), 'NOT_ALLOWED');
  const publicStaff = await h.store.listStaff();
  assert.equal(publicStaff[0]!.payPerClassCents, undefined);
  assert.equal(publicStaff.length, STAFF.length + 1);
  // signed out
  await h.store.signOut();
  assert.equal(await h.store.currentUser(), null);
  await rejects(h.store.bookClass('a', 'mon18'), 'AUTH_REQUIRED');
});

test('auth: sign up, sign in, duplicate email', async () => {
  const h = await harness(state(), NOW);
  await h.store.signOut();
  await rejects(h.store.signIn('amy@example.com', 'x'), 'NOT_ALLOWED'); // studio app harness: clients can't sign in here
  const staff = await h.store.signIn('LIBBY@snowypilatesclub.com', 'anything');
  assert.equal(staff.kind, 'staff');
  await rejects(h.store.signUpClient({ firstName: 'Amy', lastName: 'Two', email: 'amy@example.com', password: 'secret1' }), 'EMAIL_TAKEN');
  const u = await h.store.signUpClient({ firstName: 'Zed', lastName: 'New', email: 'zed@example.com', password: 'secret1' });
  assert.equal(u.kind, 'client');
  assert.deepEqual(await h.store.currentUser(), u);
  await rejects(h.store.signIn('nobody@example.com', 'x'), 'INVALID_LOGIN');
});
