// Libby's feedback (27 Oct): the health step before confirming a booking, and owner/manager membership edits (demo store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthNoteLine, healthPolicy, healthStepFor, membershipChangeCents, renewalDateProblem } from '../src/domain';
import { at, asClient, baseState, harness, JULIA, mkClient, mkSession, OWNER, rejects } from './helpers';

const NOW = at('2026-10-27', '08:00'); // Tuesday
const DAY = 86_400_000;

function state() {
  return baseState({
    clients: [
      mkClient('first', 'First', { waiverSignedAt: undefined }),
      mkClient('back', 'Back', { healthForm: { answers: {}, submittedAt: '2026-08-01T00:00:00.000Z' }, waiverSignedAt: '2026-08-01T00:00:00.000Z' }),
    ],
    sessions: [mkSession('past', '2026-10-20', '09:00'), mkSession('next', '2026-10-28', '09:00'), mkSession('later', '2026-10-29', '09:00')],
  });
}

test('health step: no waiver = full; attended before = quick (once every N days); signed but never attended = none', () => {
  const settings = baseState().settings;
  const old = { waiverSignedAt: '2026-08-01T00:00:00.000Z' };
  assert.equal(healthStepFor({ client: {}, settings, attended: false, now: NOW }), 'full');
  assert.equal(healthStepFor({ client: {}, settings, attended: true, now: NOW }), 'full', 'no waiver is always the full form');
  assert.equal(healthStepFor({ client: old, settings, attended: false, now: NOW }), 'none');
  assert.equal(healthStepFor({ client: old, settings, attended: true, now: NOW }), 'quick');
  const recent = { ...old, healthCheckedAt: new Date(NOW.getTime() - 10 * DAY).toISOString() };
  assert.equal(healthStepFor({ client: recent, settings, attended: true, now: NOW }), 'none', 'checked 10 days ago, default is 30');
  assert.equal(healthStepFor({ client: recent, settings: { ...settings, quickHealthCheckDays: 7 }, attended: true, now: NOW }), 'quick');
  assert.equal(healthStepFor({ client: recent, settings: { ...settings, quickHealthCheckDays: 10 }, attended: true, now: NOW }), 'quick', 'exactly N days counts');
  assert.equal(healthStepFor({ client: old, settings: { ...settings, quickHealthCheck: false }, attended: true, now: NOW }), 'none');
  // the full waiver counts as a health check too
  assert.equal(healthStepFor({ client: { waiverSignedAt: new Date(NOW.getTime() - 3 * DAY).toISOString() }, settings, attended: true, now: NOW }), 'none');
});

test('health policy defaults when the settings predate it', () => {
  assert.deepEqual(healthPolicy(undefined), { longFormFirstTimers: true, quickCheck: true, quickCheckDays: 30 });
  assert.deepEqual(healthPolicy({ longHealthFormFirstTimers: false, quickHealthCheck: false, quickHealthCheckDays: 14 }), { longFormFirstTimers: false, quickCheck: false, quickCheckDays: 14 });
  assert.equal(healthPolicy({ quickHealthCheckDays: 0 }).quickCheckDays, 30);
});

test('quick check: No just stamps the date; Yes saves a dated note to injuries and flags the roster until they are next checked in', async () => {
  const h = await harness(state(), NOW);
  await h.give('back', 'pr_p8');
  await h.as(asClient('back'));
  const c1 = await h.store.submitHealthCheck('back', { changes: false });
  assert.ok(c1.healthCheckedAt && c1.healthCheckedAt.startsWith('2026-10-26') || c1.healthCheckedAt?.startsWith('2026-10-27'));
  assert.equal(c1.injuries, undefined);
  assert.equal(c1.healthUpdate, undefined);
  await rejects(h.store.submitHealthCheck('back', { changes: true, note: '   ' }), 'INVALID');
  const c2 = await h.store.submitHealthCheck('back', { changes: true, note: 'sore left knee' });
  assert.equal(c2.injuries, '27 Oct 2026: sore left knee');
  assert.equal(c2.healthUpdate?.note, 'sore left knee');
  const c3 = await h.store.submitHealthCheck('back', { changes: true, note: 'and a tight hip' });
  assert.equal(c3.injuries, '27 Oct 2026: sore left knee\n27 Oct 2026: and a tight hip', 'notes pile up, newest last');
  await h.store.bookClass('back', 'next');
  await h.store.bookClass('back', 'later');
  await h.as(JULIA);
  const flags = async (id: string) => (await h.store.getRoster(id)).find((e) => e.clientId === 'back')!.flags;
  assert.ok((await flags('next')).includes('health_update') && (await flags('next')).includes('injury'));
  // once they have been checked in to a class after telling us, the flag goes
  h.setNow(at('2026-10-28', '09:10'));
  await h.as(OWNER);
  const roster = await h.store.getRoster('next');
  await h.store.checkIn(roster.find((e) => e.clientId === 'back')!.id);
  await h.as(JULIA);
  assert.ok(!(await flags('later')).includes('health_update'), 'seen by an instructor already');
  assert.ok((await flags('later')).includes('injury'), 'the note stays on their profile');
  // a stranger can't write someone else's health check
  await h.as(asClient('first'));
  await rejects(h.store.submitHealthCheck('back', { changes: false }), 'NOT_ALLOWED');
});

test('policy settings are per studio and validated', async () => {
  const h = await harness(state(), NOW);
  const s = await h.store.updateSettings({ longHealthFormFirstTimers: false, quickHealthCheck: true, quickHealthCheckDays: 14 });
  assert.deepEqual(healthPolicy(s), { longFormFirstTimers: false, quickCheck: true, quickCheckDays: 14 });
  await rejects(h.store.updateSettings({ quickHealthCheckDays: 0 }), 'INVALID');
  await rejects(h.store.updateSettings({ quickHealthCheckDays: 400 }), 'INVALID');
  await h.as(JULIA);
  await rejects(h.store.updateSettings({ quickHealthCheck: false }), 'NOT_ALLOWED');
});

test('note line format matches the database (D Mon YYYY: note)', () => {
  assert.equal(healthNoteLine(' tweaked shoulder ', at('2026-03-05', '10:00')), '5 Mar 2026: tweaked shoulder');
});

// ---------------------------------------------------------------- membership edits
async function member(h: Awaited<ReturnType<typeof harness>>, clientId = 'back', product = 'pr_m2') {
  return h.give(clientId, product);
}

test('renewal date: moves nextBillingAt, no sale, history entry, owner/manager only, date must be after today and within 60 days', async () => {
  const h = await harness(state(), NOW);
  const id = await member(h);
  await h.store.bookClass('back', 'next');           // activates it: next billing a week after first booking
  const before = (await h.store.listPasses('back')).find((p) => p.id === id)!;
  const sales = (await h.store.listSales({ from: '2026-10-01', to: '2026-12-31', clientId: 'back' })).length;
  const p = await h.store.changeRenewalDate(id, '2026-11-09');
  assert.ok(before.nextBillingAt && p.nextBillingAt?.startsWith('2026-11-08T13:00'), `Sydney midnight on the 9th, got ${p.nextBillingAt}`);
  assert.equal((await h.store.listSales({ from: '2026-10-01', to: '2026-12-31', clientId: 'back' })).length, sales, 'nothing charged for moving the date');
  assert.match(p.adjustments!.at(-1)!.reason, /Renewal date moved .* to 2026-11-09/);
  assert.equal(p.adjustments!.at(-1)!.staffId, 'st_libby', 'the audit entry names who did it');
  await rejects(h.store.changeRenewalDate(id, '2026-10-27'), 'INVALID');
  await rejects(h.store.changeRenewalDate(id, '2027-03-01'), 'INVALID');
  await rejects(h.store.changeRenewalDate(id, 'next week'), 'INVALID');
  await h.as(JULIA);
  await rejects(h.store.changeRenewalDate(id, '2026-11-10'), 'NOT_ALLOWED');
  await h.as(asClient('back'));
  await rejects(h.store.changeRenewalDate(id, '2026-11-10'), 'NOT_ALLOWED');
});

test('move membership: no proration by default, allowance switches at the next billing date; charged difference is optional', async () => {
  const h = await harness(state(), NOW);
  const id = await member(h);                          // 2 a week
  await h.store.bookClass('back', 'next');
  const before = (await h.store.listPasses('back')).find((p) => p.id === id)!;
  const sales = async () => (await h.store.listSales({ from: '2026-10-01', to: '2027-01-31', clientId: 'back' })).length;
  const n0 = await sales();
  let p = await h.store.changeMembership(id, { productId: 'pr_m3' });
  assert.equal(p.name, '2 classes per week', 'still the old plan until the next cycle');
  assert.equal(p.credits, 2);
  assert.equal(p.pendingChange?.productId, 'pr_m3');
  assert.equal(p.pendingChange?.effectiveAt, before.nextBillingAt);
  assert.equal(await sales(), n0, 'no proration: nothing charged');
  assert.match(p.adjustments!.at(-1)!.reason, /Moved from 2 classes per week to 3 classes per week, credits and allowance switch from .*no charge or credit/);
  // the next billing day passes: new plan, new price, charged at the new price
  h.setNow(new Date(Date.parse(before.nextBillingAt!) + 3600_000));
  p = (await h.store.listPasses('back')).find((x) => x.id === id)!;
  assert.equal(p.name, '3 classes per week');
  assert.equal(p.credits, 3);
  assert.equal(p.priceCents, 5500);
  assert.equal(p.pendingChange, undefined);
  const renewal = (await h.store.listSales({ from: '2026-10-01', to: '2027-01-31', clientId: 'back' })).find((s) => s.note === 'Weekly membership direct debit' && s.totalCents === 5500);
  assert.ok(renewal, 'the renewal is charged at the new price');
  assert.match(p.adjustments!.at(-1)!.reason, /^Now on 3 classes per week/);
});

test('move membership: immediately switches credits now; prorate charges the difference (or notes a credit); bad moves are refused', async () => {
  const h = await harness(state(), NOW);
  const id = await member(h);
  await h.store.bookClass('back', 'next');
  const p0 = (await h.store.listPasses('back')).find((p) => p.id === id)!;
  const left = Date.parse(p0.nextBillingAt!) - NOW.getTime();
  const diff = Math.round((5500 - 4000) * Math.min(left, 7 * DAY) / (7 * DAY));
  assert.equal(membershipChangeCents(p0, 5500, NOW), diff);
  const p = await h.store.changeMembership(id, { productId: 'pr_m3', immediately: true, prorate: true });
  assert.equal(p.name, '3 classes per week'); assert.equal(p.credits, 3); assert.equal(p.priceCents, 5500); assert.equal(p.pendingChange, undefined);
  const sale = (await h.store.listSales({ from: '2026-10-01', to: '2026-12-31', clientId: 'back' })).find((s) => s.note === 'Prorated difference');
  assert.equal(sale?.totalCents, diff);
  assert.match(p.adjustments!.at(-1)!.reason, new RegExp(`charged the \\$${(diff / 100).toFixed(2)} difference`));
  // down again: a credit is noted, not a sale
  const down = await h.store.changeMembership(id, { productId: 'pr_m1', immediately: true, prorate: true });
  assert.equal(down.credits, 1);
  assert.match(down.adjustments!.at(-1)!.reason, /credited to their account/);
  await rejects(h.store.changeMembership(id, { productId: 'pr_m1' }), 'INVALID');       // already on it
  await rejects(h.store.changeMembership(id, { productId: 'pr_p4' }), 'INVALID');       // not a membership
  const pack = await h.give('back', 'pr_p4');
  await rejects(h.store.changeMembership(pack, { productId: 'pr_m2' }), 'INVALID');     // not a membership pass
  await h.as(JULIA);
  await rejects(h.store.changeMembership(id, { productId: 'pr_m2' }), 'NOT_ALLOWED');
  await h.as(OWNER);
  await h.store.cancelMembership(id);
  await rejects(h.store.changeMembership(id, { productId: 'pr_m2' }), 'INVALID');
  await rejects(h.store.changeRenewalDate(id, '2026-11-09'), 'INVALID');
});

test('renewal date rules', () => {
  assert.equal(renewalDateProblem('2026-10-28', '2026-10-27'), null);
  assert.equal(renewalDateProblem('2026-10-27', '2026-10-27'), 'Pick a date after today.');
  assert.match(renewalDateProblem('2026-12-30', '2026-10-27')!, /within the next 60 days/);
});
