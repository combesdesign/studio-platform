import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, asClient, baseState, harness, mkClient, mkSession, OWNER, rejects } from './helpers';
import { isFamilyShareable } from '../src/domain';
import { kioskPeople } from '../src/features/kiosk/logic';
import { createDemoStore, memoryStorage } from '../src/data/demo';

const NOW = at('2026-10-12', '08:00'); // Monday

/** Sarah (parent), Mia (her child, waiver signed), Ollie (her child, no waiver yet), and Tom (someone else). */
function state(capacity = 14) {
  return baseState({
    clients: [
      mkClient('sarah', 'Sarah', { phone: '0400 000 000' }),
      mkClient('mia', 'Mia', { guardianClientId: 'sarah', email: '', lastName: 'Test' }),
      mkClient('ollie', 'Ollie', { guardianClientId: 'sarah', email: '', waiverSignedAt: undefined }),
      mkClient('tom', 'Tom'),
    ],
    sessions: [
      mkSession('mon18', '2026-10-12', '18:00', { capacity }),
      mkSession('wed18', '2026-10-14', '18:00', { capacity }),
      mkSession('fri06', '2026-10-16', '06:00', { capacity }),
    ],
  });
}

test('a pass is family-shareable by default for packs and drop-ins, not memberships or intro offers', () => {
  assert.equal(isFamilyShareable({ kind: 'pack' }), true);
  assert.equal(isFamilyShareable({ kind: 'dropin' }), true);
  assert.equal(isFamilyShareable({ kind: 'membership' }), false);
  assert.equal(isFamilyShareable({ kind: 'intro' }), false);
  assert.equal(isFamilyShareable({ kind: 'membership', familyShareable: true }), true);
  assert.equal(isFamilyShareable({ kind: 'pack', familyShareable: false }), false);
});

test('a parent books a dependant: they take a spot, and the credit comes from the parent’s pack', async () => {
  const h = await harness(state(), NOW);
  const pack = await h.give('sarah', 'pr_p4');
  await h.as(asClient('sarah'));
  const r = await h.store.bookAttendees!('mon18', ['sarah', 'mia']);
  assert.deepEqual(r.map((x) => [x.booking.clientId, x.outcome, x.pass?.id]), [['sarah', 'booked', pack], ['mia', 'booked', pack]]);
  assert.equal((await h.store.getSession('mon18')).bookedCount, 2, 'each attendee takes a spot');
  const [p] = await h.store.listPasses('sarah');
  assert.equal(p!.creditsUsed, 2);
  // the dependant's own bookings are readable by the parent, and show on the roster as their own name via the parent
  assert.equal((await h.store.listClientBookings('mia', { when: 'upcoming' })).length, 1);
  await h.as(OWNER);
  const roster = await h.store.getRoster('mon18');
  const mia = roster.find((e) => e.clientId === 'mia')!;
  assert.equal(mia.client.firstName, 'Mia');
  assert.equal(mia.client.guardianName, 'Sarah Test');
  assert.equal(roster.find((e) => e.clientId === 'sarah')!.client.guardianName, undefined);
  // the kiosk treats them as an attendee like anyone else
  assert.deepEqual(kioskPeople(roster).map((k) => k.firstName), ['Mia', 'Sarah']);
  // staff check them in like anyone
  assert.equal((await h.store.checkIn(mia.id)).status, 'checked_in');
});

test('memberships are personal unless their product is flagged family-shareable', async () => {
  const h = await harness(state(), NOW);
  await h.give('sarah', 'pr_m2');
  await h.as(asClient('sarah'));
  await rejects(h.store.bookClass('mia', 'mon18'), 'NO_CREDITS');
  await h.as(OWNER);
  // the studio flags the product; passes bought after that carry the flag
  const prod = (await h.store.listProducts()).find((p) => p.id === 'pr_m2')!;
  await h.store.upsertProduct({ ...prod, familyShareable: true });
  const shared = await h.give('sarah', 'pr_m2');
  await h.as(asClient('sarah'));
  const r = await h.store.bookClass('mia', 'mon18');
  assert.equal(r.pass?.id, shared);
  assert.equal(r.pass?.familyShareable, true);
  assert.equal(r.pass?.clientId, 'sarah');
});

test('a dependant’s own pass is used before the parent’s shared one', async () => {
  const h = await harness(state(), NOW);
  const parentPack = await h.give('sarah', 'pr_p8');
  const miaPack = await h.give('mia', 'pr_p4');
  await h.as(asClient('sarah'));
  const r = await h.store.bookClass('mia', 'mon18');
  assert.equal(r.pass?.id, miaPack);
  const summary = await h.store.getCreditSummary('mia', 'wed18');
  assert.deepEqual(summary.map((c) => c.pass.id), [miaPack, parentPack]);
  // a parent can choose the shared pack explicitly
  const r2 = await h.store.bookClass('mia', 'wed18', { passId: parentPack });
  assert.equal(r2.pass?.id, parentPack);
});

test('booking several people is all or nothing, and the error names who needs a pass', async () => {
  const h = await harness(state(), NOW);
  await h.give('sarah', 'pr_drop');   // one single-class credit between three of them
  await h.as(asClient('sarah'));
  await assert.rejects(h.store.bookAttendees!('mon18', ['sarah', 'mia']), (e: Error & { code?: string }) => e.code === 'NO_CREDITS' && /Mia needs a pass/.test(e.message));
  assert.equal((await h.store.getSession('mon18')).bookedCount, 0, 'nothing was booked');
  const [p] = await h.store.listPasses('sarah');
  assert.equal(p!.creditsUsed, 0, 'no credit taken');
  assert.equal((await h.store.bookAttendees!('mon18', ['mia']))[0]!.outcome, 'booked');
});

test('cancelling a dependant’s booking returns the credit to the parent’s pack', async () => {
  const h = await harness(state(), NOW);
  await h.give('sarah', 'pr_p4');
  await h.as(asClient('sarah'));
  const [r] = await h.store.bookAttendees!('wed18', ['mia']);
  assert.equal((await h.store.listPasses('sarah'))[0]!.creditsUsed, 1);
  const c = await h.store.cancelBooking(r!.booking.id);
  assert.equal(c.creditReturned, true);
  assert.equal((await h.store.listPasses('sarah'))[0]!.creditsUsed, 0);
});

test('a full class waitlists the dependant without taking a credit; the waitlist then uses the parent’s pack', async () => {
  const h = await harness(state(1), NOW);
  await h.give('sarah', 'pr_p4');
  await h.give('tom', 'pr_p4');
  await h.as(asClient('tom'));
  const tom = await h.store.bookClass('tom', 'mon18');
  await h.as(asClient('sarah'));
  const [w] = await h.store.bookAttendees!('mon18', ['mia']);
  assert.equal(w!.outcome, 'waitlisted');
  assert.equal((await h.store.listPasses('sarah'))[0]!.creditsUsed, 0);
  await h.as(asClient('tom'));
  await h.store.cancelBooking(tom.booking.id);
  await h.as(asClient('sarah'));
  const mine = (await h.store.listClientBookings('mia', { when: 'upcoming' }))[0]!;
  assert.equal(mine.status, 'booked');
  assert.equal(mine.passId, (await h.store.listPasses('sarah'))[0]!.id);
});

test('the parent signs the dependant’s waiver; until then they can’t book', async () => {
  const h = await harness(state(), NOW);
  await h.give('sarah', 'pr_p4');
  await h.as(asClient('sarah'));
  await rejects(h.store.bookClass('ollie', 'mon18'), 'WAIVER_REQUIRED');
  const c = await h.store.submitWaiver('ollie', { answers: {}, injuries: 'Asthma' });
  assert.ok(c.waiverSignedAt);
  assert.equal(c.injuries, 'Asthma');
  assert.equal((await h.store.bookClass('ollie', 'mon18')).outcome, 'booked');
  // someone else's waiver isn't theirs to sign
  await rejects(h.store.submitWaiver('tom', { answers: {} }), 'NOT_ALLOWED');
});

test('other clients can’t see, book or buy for someone else’s dependants', async () => {
  const h = await harness(state(), NOW);
  await h.give('tom', 'pr_p4');
  await h.as(asClient('tom'));
  await rejects(h.store.bookClass('mia', 'mon18'), 'NOT_ALLOWED');
  await rejects(h.store.bookAttendees!('mon18', ['mia']), 'NOT_ALLOWED');
  await rejects(h.store.listClientBookings('mia'), 'NOT_ALLOWED');
  await rejects(h.store.getClient('mia'), 'NOT_ALLOWED');
  await rejects(h.store.purchase({ clientId: 'mia', productId: 'pr_p4', method: 'card_online' }), 'NOT_ALLOWED');
  await rejects(h.store.saveDependant!('sarah', { firstName: 'Zed' }), 'NOT_ALLOWED');
  await rejects(h.store.removeDependant!('mia'), 'NOT_ALLOWED');
  assert.deepEqual(await h.store.listDependants!('tom'), []);
});

test('a parent buys a pass for a dependant, and sees the receipt', async () => {
  const h = await harness(state(), NOW);
  await h.as(asClient('sarah'));
  const r = await h.store.purchase({ clientId: 'mia', productId: 'pr_p4', method: 'card_online' });
  assert.equal(r.pass?.clientId, 'mia');
  assert.equal((await h.store.bookClass('mia', 'mon18')).pass?.id, r.pass?.id);
  assert.equal((await h.store.listSales({ from: '2026-01-01', to: '2026-12-31' })).some((s) => s.id === r.sale.id), true);
});

test('managing dependants: add, edit, remove (blocked while they have upcoming classes)', async () => {
  const h = await harness(state(), NOW);
  await h.give('sarah', 'pr_p4');
  await h.as(asClient('sarah'));
  const bub = await h.store.saveDependant!('sarah', { firstName: ' Bubba ', birthday: '2026-05-01', injuries: ' Reflux ' });
  assert.equal(bub.guardianClientId, 'sarah');
  assert.equal(bub.lastName, 'Test', 'defaults to the parent’s surname');
  assert.equal(bub.email, '');
  assert.equal(bub.emergencyContactName, 'Sarah Test');
  assert.equal(bub.injuries, 'Reflux');
  const edited = await h.store.saveDependant!('sarah', { id: bub.id, firstName: 'Bubba', lastName: 'Test', birthday: undefined });
  assert.equal(edited.birthday, undefined);
  assert.equal(edited.injuries, undefined);
  await rejects(h.store.saveDependant!('sarah', { firstName: 'Mia' }), 'INVALID');
  await rejects(h.store.saveDependant!('sarah', { firstName: 'X', birthday: '2030-01-01' }), 'INVALID');
  await rejects(h.store.saveDependant!('mia', { firstName: 'Nested' }), 'NOT_ALLOWED');
  assert.deepEqual((await h.store.listDependants!('sarah')).map((d) => d.firstName), ['Mia', 'Ollie', 'Bubba']);
  // upcoming booking blocks removal; cancelling it unblocks
  await h.store.submitWaiver(bub.id, { answers: {} });
  const [b] = await h.store.bookAttendees!('wed18', [bub.id]);
  await rejects(h.store.removeDependant!(bub.id), 'INVALID');
  await h.store.cancelBooking(b!.booking.id);
  await h.store.removeDependant!(bub.id);
  assert.deepEqual((await h.store.listDependants!('sarah')).map((d) => d.firstName), ['Mia', 'Ollie']);
});

test('staff find dependants in Clients (by their name or their parent’s) and can link one to a parent', async () => {
  const h = await harness(state(), NOW);
  const byMia = await h.store.listClients({ search: 'mia' });
  assert.equal(byMia[0]!.guardianName, 'Sarah Test');
  assert.deepEqual((await h.store.listClients({ search: 'sarah' })).map((c) => c.firstName).sort(), ['Mia', 'Ollie', 'Sarah']);
  await rejects(h.store.upsertClient({ ...(await h.store.getClient('tom')), guardianClientId: 'mia' }), 'INVALID');
  await rejects(h.store.upsertClient({ ...(await h.store.getClient('sarah')), guardianClientId: 'tom' }), 'INVALID');
  const linked = await h.store.upsertClient({ ...(await h.store.getClient('tom')), guardianClientId: 'sarah' });
  assert.equal(linked.guardianClientId, 'sarah');
  assert.equal((await h.store.getClient('tom')).guardianName, 'Sarah Test');
  // staff can also book a dependant in; their credit comes from the parent's shareable pack
  await h.give('sarah', 'pr_p4');
  const r = await h.store.bookClass('mia', 'mon18', { asStaff: true });
  assert.equal(r.pass?.clientId, 'sarah');
});

test('the Snowy demo seed has a parent with a baby dependant booked into Mums + Bubs', async () => {
  const store = createDemoStore({ sampleBilling: false, now: () => new Date(), latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  await store.demoSignInAs!(OWNER);
  const sophie = (await store.listClients({ search: 'sophie archer' })).find((c) => c.firstName === 'Sophie')!;
  const [poppy] = await store.listDependants!(sophie.id);
  assert.equal(poppy!.firstName, 'Poppy');
  assert.ok(poppy!.waiverSignedAt);
  const bookings = await store.listClientBookings(poppy!.id, { when: 'upcoming' });
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0]!.classType.name, 'Mums + Bubs');
  assert.equal(bookings[0]!.passId, (await store.listClientBookings(sophie.id, { when: 'upcoming' }))[0]!.passId, 'one pack, two credits');
});

test('workshops: a parent registers and cancels for a dependant, and nobody else can', async () => {
  const store = createDemoStore({ sampleBilling: false, now: () => new Date(), latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  await store.demoSignInAs!(OWNER);
  const clients = await store.listClients();
  const sophie = clients.find((c) => c.firstName === 'Sophie' && c.lastName === 'Archer')!;
  const hannah = clients.find((c) => c.firstName === 'Hannah')!;
  const [poppy] = await store.listDependants!(sophie.id);
  const a = store.features.appointments!;
  const course = (await a.listEvents()).find((e) => e.kind === 'course')!;
  await store.demoSignInAs!(asClient(sophie.id));
  const r = await a.register({ eventId: course.id, clientId: poppy!.id, method: 'card_online' });
  assert.equal(r.registration.clientId, poppy!.id);
  assert.equal((await a.getEvent(course.id)).spotsLeft, course.spotsLeft - 1, 'a dependant takes one spot');
  assert.deepEqual((await a.listRegistrations({ clientId: sophie.id })).map((x) => x.clientId), [poppy!.id], 'the parent sees their dependant’s sign-ups');
  await store.demoSignInAs!(asClient(hannah.id));
  await rejects(a.register({ eventId: course.id, clientId: poppy!.id, method: 'card_online' }), 'NOT_ALLOWED');
  await rejects(a.cancelRegistration(r.registration.id), 'NOT_FOUND');
  await store.demoSignInAs!(asClient(sophie.id));
  await a.cancelRegistration(r.registration.id);
  assert.equal((await a.getEvent(course.id)).spotsLeft, course.spotsLeft);
});
