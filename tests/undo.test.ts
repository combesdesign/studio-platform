import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, asClient, baseState, harness, JULIA, mkClient, mkSession, OWNER, rejects } from './helpers';

const NOW = at('2026-10-12', '08:00'); // Monday, class is Monday 18:00

function state(cap = 14, fees = false) {
  const s = baseState({
    clients: ['a', 'b', 'c', 'd', 'e'].map((id) => mkClient(id, id.toUpperCase())),
    sessions: [mkSession('mon18', '2026-10-12', '18:00', { capacity: cap }), mkSession('mon18b', '2026-10-12', '18:00'), mkSession('wed18', '2026-10-14', '18:00')],
  });
  if (fees) { s.settings.noShowFeeCents = 500; s.settings.lateCancelFeeCents = 700; }
  return s;
}
const used = async (h: Awaited<ReturnType<typeof harness>>, c: string) => (await h.store.listPasses(c)).reduce((n, p) => n + p.creditsUsed, 0);
const spots = async (h: Awaited<ReturnType<typeof harness>>, id: string) => (await h.store.getSession(id)).bookedCount;

test('undo no-show: back to booked, spot and credit exactly as before, fee taken off', async () => {
  const h = await harness(state(2, true), NOW);
  await h.give('a', 'pr_p4'); await h.give('b', 'pr_p4');
  const a = await h.store.bookClass('a', 'mon18', { asStaff: true });
  await h.store.bookClass('b', 'mon18', { asStaff: true });
  h.setNow(at('2026-10-12', '18:30'));
  await h.store.markNoShow(a.booking.id);
  assert.equal(await spots(h, 'mon18'), 1);
  assert.equal(await used(h, 'a'), 1, 'a no-show still uses the credit');
  assert.equal((await h.store.listSales({ from: '2026-10-12', to: '2026-10-12', clientId: 'a' })).filter((s) => s.note === 'No-show fee').length, 1);
  const u = await h.store.undoNoShow!(a.booking.id);
  assert.equal(u.status, 'booked');
  assert.equal(await spots(h, 'mon18'), 2);
  assert.equal(await used(h, 'a'), 1);
  assert.equal((await h.store.listSales({ from: '2026-10-12', to: '2026-10-12', clientId: 'a' })).filter((s) => s.note === 'No-show fee').length, 0, 'fee is gone');
  await rejects(h.store.undoNoShow!(a.booking.id), 'INVALID');
  await h.as(asClient('a'));
  await rejects(h.store.undoNoShow!(a.booking.id), 'NOT_ALLOWED');
});

test('undo a staff cancel: credit taken again, and the waitlist person who got the spot goes back to their place', async () => {
  const h = await harness(state(2), NOW);
  for (const c of ['a', 'b', 'c', 'd']) await h.give(c, 'pr_p4');
  const a = await h.store.bookClass('a', 'mon18');
  await h.store.bookClass('b', 'mon18');
  const wc = await h.store.bookClass('c', 'mon18'); const wd = await h.store.bookClass('d', 'mon18');
  assert.equal(wc.booking.waitlistPosition, 1); assert.equal(wd.booking.waitlistPosition, 2);
  const cancel = await h.store.cancelBooking(a.booking.id, { asStaff: true });
  assert.equal(cancel.creditReturned, true);
  assert.equal(cancel.promoted?.clientId, 'c');
  assert.equal(await used(h, 'a'), 0); assert.equal(await used(h, 'c'), 1);

  // without sorting out the promoted person the spot is gone: don't squeeze anyone in silently
  await rejects(h.store.undoCancelBooking!(a.booking.id), 'CLASS_FULL');
  assert.equal(await used(h, 'a'), 0, 'a failed undo changes nothing');
  assert.equal((await h.store.getRoster('mon18')).find((e) => e.clientId === 'c')!.status, 'booked');

  const u = await h.store.undoCancelBooking!(a.booking.id, { demotePromotedId: cancel.promoted!.id });
  assert.equal(u.booking.status, 'booked'); assert.equal(u.creditTaken, true); assert.equal(u.demoted?.clientId, 'c');
  assert.equal(await used(h, 'a'), 1); assert.equal(await used(h, 'c'), 0, 'c gets their credit back');
  assert.equal(await spots(h, 'mon18'), 2);
  const wl = (await h.store.getRoster('mon18')).filter((e) => e.status === 'waitlisted').sort((x, y) => (x.waitlistPosition ?? 0) - (y.waitlistPosition ?? 0));
  assert.deepEqual(wl.map((e) => [e.clientId, e.waitlistPosition, e.passId]), [['c', 1, undefined], ['d', 2, undefined]]);
  await rejects(h.store.undoCancelBooking!(a.booking.id), 'INVALID');
});

test('undo a cancel: refuses when their credit has gone elsewhere, or they have been rebooked', async () => {
  const h = await harness(state(), NOW);
  await h.give('a', 'pr_drop');
  const a = await h.store.bookClass('a', 'mon18');
  await h.store.cancelBooking(a.booking.id, { asStaff: true });
  await h.store.bookClass('a', 'wed18');                       // spends the only credit
  await rejects(h.store.undoCancelBooking!(a.booking.id), 'NO_CREDITS');
  assert.equal(await spots(h, 'mon18'), 0);
  await h.give('a', 'pr_p4');
  await h.store.bookClass('a', 'mon18');                      // rebooked by hand
  await rejects(h.store.undoCancelBooking!(a.booking.id), 'ALREADY_BOOKED');
});

test('undo a late cancel: no credit to take, fee gone; undo a waitlist removal: same place in line', async () => {
  const h = await harness(state(2, true), NOW);
  for (const c of ['a', 'b', 'c', 'd']) await h.give(c, 'pr_p4');
  const a = await h.store.bookClass('a', 'mon18');
  await h.store.bookClass('b', 'mon18'); const wc = await h.store.bookClass('c', 'mon18'); const wd = await h.store.bookClass('d', 'mon18');
  assert.deepEqual([wc.booking.waitlistPosition, wd.booking.waitlistPosition], [1, 2]);
  // remove the first person from the waitlist, then put them back
  await h.store.leaveWaitlist(wc.booking.id);
  assert.equal((await h.store.getRoster('mon18')).find((e) => e.clientId === 'd')!.waitlistPosition, 1);
  const back = await h.store.undoCancelBooking!(wc.booking.id);
  assert.equal(back.booking.status, 'waitlisted'); assert.equal(back.creditTaken, false);
  const pos = Object.fromEntries((await h.store.getRoster('mon18')).filter((e) => e.status === 'waitlisted').map((e) => [e.clientId, e.waitlistPosition]));
  assert.deepEqual(pos, { c: 1, d: 2 });
  // late cancel (inside 3h), no waitlist promotion possible past cutoff: credit is lost and a fee is charged
  h.setNow(at('2026-10-12', '17:30'));
  const lc = await h.store.cancelBooking(a.booking.id, { asStaff: true });
  assert.equal(lc.lateCancel, true);
  assert.equal(await used(h, 'a'), 1);
  assert.equal((await h.store.listSales({ from: '2026-10-12', to: '2026-10-12', clientId: 'a' })).filter((s) => s.note === 'Late cancellation fee').length, 1);
  const u = await h.store.undoCancelBooking!(a.booking.id);
  assert.equal(u.booking.status, 'booked'); assert.equal(u.creditTaken, false);
  assert.equal(await used(h, 'a'), 1, 'credit untouched');
  assert.equal((await h.store.listSales({ from: '2026-10-12', to: '2026-10-12', clientId: 'a' })).filter((s) => s.note === 'Late cancellation fee').length, 0);
});

test('return credit later: a no-show or late cancel becomes a normal cancel, credit back, fee refunded', async () => {
  const h = await harness(state(14, true), NOW);
  await h.give('a', 'pr_p4'); await h.give('b', 'pr_p4');
  const a = await h.store.bookClass('a', 'mon18'); const b = await h.store.bookClass('b', 'mon18');
  h.setNow(at('2026-10-12', '17:00'));
  await h.store.cancelBooking(a.booking.id, { asStaff: true });   // late
  h.setNow(at('2026-10-12', '19:00'));
  await h.store.markNoShow(b.booking.id);
  assert.deepEqual([await used(h, 'a'), await used(h, 'b')], [1, 1]);
  h.setNow(at('2026-10-14', '09:00'));                            // days later, class long over
  for (const x of [a, b]) assert.equal((await h.store.waivePenalty!(x.booking.id)).status, 'cancelled');
  assert.deepEqual([await used(h, 'a'), await used(h, 'b')], [0, 0]);
  const fees = (await h.store.listSales({ from: '2026-10-12', to: '2026-10-14' })).filter((s) => /fee/i.test(s.note ?? ''));
  assert.equal(fees.length, 2); assert.ok(fees.every((f) => f.refundedCents === f.totalCents), 'fees refunded');
  assert.equal(await spots(h, 'mon18'), 0);
  await rejects(h.store.waivePenalty!(a.booking.id), 'INVALID');
});

test('restore a cancelled class: rebooks who it can, lists the rest', async () => {
  const h = await harness(state(3), NOW);
  for (const c of ['a', 'c', 'd']) await h.give(c, 'pr_p4');
  await h.give('b', 'pr_drop');
  const bks: Record<string, string> = {};
  for (const c of ['a', 'b', 'c']) bks[c] = (await h.store.bookClass(c, 'mon18')).booking.id;
  const w = await h.store.bookClass('d', 'mon18'); assert.equal(w.outcome, 'waitlisted');
  await h.store.cancelSession('mon18', 'Instructor unwell');
  assert.deepEqual([await used(h, 'a'), await used(h, 'b'), await used(h, 'c'), await used(h, 'd')], [0, 0, 0, 0]);
  await h.store.bookClass('a', 'mon18b');                         // A booked the other 6pm class
  await h.store.bookClass('b', 'wed18');                          // B spent their single credit
  const r = await h.store.restoreSession!('mon18');
  assert.equal(r.session.status, 'scheduled');
  assert.deepEqual(r.needsAttention.map((x) => [x.name, x.reason]).sort(), [['A Test', 'Took another class at the same time'], ['B Test', 'No credit left on their Single class']]);
  const st = Object.fromEntries(r.restored.map((x) => [x.clientId, x.status]));
  assert.deepEqual(st, { c: 'booked', d: 'booked' }, 'C rebooked, and D (waitlisted) takes a spare spot');
  assert.equal(await used(h, 'c'), 1); assert.equal(await used(h, 'd'), 1);
  assert.equal(await used(h, 'a'), 1, 'A only has the credit from the other class');
  assert.equal(await spots(h, 'mon18'), 2);
  const sess = await h.store.getSession('mon18');
  assert.ok(sess.bookedCount <= sess.capacity);
  await rejects(h.store.restoreSession!('mon18'), 'INVALID');
  await h.as(JULIA);
  await rejects(h.store.restoreSession!('mon18b'), 'NOT_ALLOWED');
});

test('restore a cancelled class: full class keeps the waitlist, people removed earlier stay removed', async () => {
  const h = await harness(state(2), NOW);
  for (const c of ['a', 'b', 'c', 'd']) await h.give(c, 'pr_p4');
  const a = await h.store.bookClass('a', 'mon18'); await h.store.bookClass('b', 'mon18');
  const wc = await h.store.bookClass('c', 'mon18'); await h.store.bookClass('d', 'mon18');
  await h.store.leaveWaitlist(wc.booking.id);                     // C left earlier
  h.setNow(at('2026-10-12', '09:00'));
  await h.store.cancelSession('mon18', 'Oops');
  void a;
  const r = await h.store.restoreSession!('mon18');
  assert.deepEqual(r.needsAttention, []);
  assert.deepEqual(r.restored.map((x) => [x.clientId, x.status]).sort(), [['a', 'booked'], ['b', 'booked'], ['d', 'waitlisted']]);
  assert.equal((await h.store.listClientBookings('c', { when: 'all' })).find((x) => x.sessionId === 'mon18')!.status, 'removed');
  assert.equal(await used(h, 'a') + await used(h, 'b') + await used(h, 'd'), 2);
  assert.equal((await h.store.getRoster('mon18')).find((e) => e.clientId === 'd')!.waitlistPosition, 1);
});

test('void a desk sale: non-card only, today only, unused only; stock and pass go back', async () => {
  const h = await harness(state(), NOW);
  const cart = await h.store.checkoutCart({ clientId: 'a', items: [{ productId: 'pr_p4', qty: 1 }, { productId: 'pr_socks', qty: 2 }], method: 'cash' });
  const stock = async () => (await h.store.listProducts()).find((p) => p.id === 'pr_socks')!.stock;
  const bought = (await stock()) as number;
  const dry = await h.store.voidSale!(cart.sale.id, { dryRun: true });
  assert.equal(dry.voided, false); assert.equal(dry.blocked, undefined); assert.deepEqual(dry.passes.map((p) => p.name), ['4 class pack']);
  assert.equal((await h.store.listPasses('a'))[0]!.status, 'active', 'dry run changes nothing');
  await h.as(JULIA);
  await rejects(h.store.voidSale!(cart.sale.id), 'NOT_ALLOWED');
  await h.as(OWNER);
  const r = await h.store.voidSale!(cart.sale.id, { reason: 'wrong client' });
  assert.equal(r.voided, true); assert.equal(r.sale.refundedCents, cart.sale.totalCents);
  assert.match(r.sale.note ?? '', /Refund: Voided: wrong client/);
  assert.equal((await h.store.listPasses('a', { includeInactive: true })).find((p) => p.id === cart.passes[0]!.id)!.status, 'cancelled');
  assert.equal((await h.store.getReport({ from: '2026-10-12', to: '2026-10-12' })).revenueCents - (await h.store.getReport({ from: '2026-10-12', to: '2026-10-12' })).refundsCents, 0, 'takings are back to zero');
  assert.equal(await stock(), bought + 2, 'both pairs of socks are back on the shelf');
  await rejects(h.store.voidSale!(cart.sale.id), 'INVALID');
});

test('void refuses card sales, old sales and passes already used', async () => {
  const h = await harness(state(), NOW);
  const card = await h.store.checkoutCart({ clientId: 'a', items: [{ productId: 'pr_p4', qty: 1 }], method: 'card_online' });
  const d1 = await h.store.voidSale!(card.sale.id, { dryRun: true });
  assert.match(d1.blocked ?? '', /Use Refund/); await rejects(h.store.voidSale!(card.sale.id), 'INVALID');
  const reader = await h.store.checkoutCart({ clientId: 'b', items: [{ productId: 'pr_p4', qty: 1 }], method: 'card_reader' });
  await h.store.bookClass('b', 'wed18');
  const d2 = await h.store.voidSale!(reader.sale.id, { dryRun: true });
  assert.match(d2.blocked ?? '', /already been used for 1 class/);
  const cash = await h.store.checkoutCart({ clientId: 'c', items: [{ productId: 'pr_socks', qty: 1 }], method: 'cash' });
  h.setNow(at('2026-10-13', '09:00'));
  assert.match((await h.store.voidSale!(cash.sale.id, { dryRun: true })).blocked ?? '', /Only sales made today/);
});
