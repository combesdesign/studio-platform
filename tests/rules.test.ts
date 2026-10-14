import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pass } from '../src/shared/types';
import {
  activatePass, birthdayInWeek, canAutoPromote, cancellationOutcome, checkPassForSession, comparePassPriority, computePassStatus,
  creditLabel, isIntroEligible, pickWaitlistPromotion, rosterFlags, selectBestPass, weeklyUsed, DAY_MS, can, csvCell, toCsv,
} from '../src/domain';
import { at } from './helpers';

const pass = (over: Partial<Pass>): Pass => ({
  id: 'p', clientId: 'c', productId: 'pr_p4', kind: 'pack', name: 'Pack', status: 'active', purchasedAt: '2026-10-01T00:00:00.000Z',
  credits: 4, creditsUsed: 0, priceCents: 10000, ...over,
});
const session = { startsAt: at('2026-10-15', '18:00').toISOString(), classTypeId: 'ct_mat' };
const now = at('2026-10-12', '08:00');

test('best pass: unlimited, then weekly membership, then soonest-expiring pack, unactivated last', () => {
  const unlimited = pass({ id: 'u', kind: 'membership', credits: null, activatedAt: '2026-10-01T00:00:00.000Z', expiresAt: null });
  const weekly = pass({ id: 'w', kind: 'membership', credits: 2, activatedAt: '2026-10-01T00:00:00.000Z', expiresAt: null });
  const packSoon = pass({ id: 'ps', activatedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' });
  const packLate = pass({ id: 'pl', activatedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z' });
  const fresh = pass({ id: 'pf', purchasedAt: '2026-08-01T00:00:00.000Z' });
  const intro = pass({ id: 'i', kind: 'intro', credits: null, activatedAt: '2026-10-10T00:00:00.000Z', expiresAt: '2026-10-24T00:00:00.000Z' });
  const all = [fresh, packLate, packSoon, weekly, unlimited, intro];
  const order = [...all].sort(comparePassPriority).map((p) => p.id);
  assert.deepEqual(order, ['i', 'u', 'w', 'ps', 'pl', 'pf']);
  const elig = (p: Pass) => checkPassForSession({ pass: p, validityDays: 61, session, uses: [], now });
  assert.equal(selectBestPass([fresh, packLate, packSoon].map((p) => ({ pass: p, eligibility: elig(p) })))?.id, 'ps');
  // ineligible passes are skipped
  const usedUp = pass({ id: 'x', creditsUsed: 4, activatedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(selectBestPass([usedUp, packLate].map((p) => ({ pass: p, eligibility: elig(p) })))?.id, 'pl');
});

test('eligibility: expiry at session time, pause, class type, credits', () => {
  const p = pass({ activatedAt: '2026-08-20T00:00:00.000Z', expiresAt: at('2026-10-15', '12:00').toISOString() });
  assert.equal(checkPassForSession({ pass: p, session, uses: [], now }).reason, 'expired');
  const unact = pass({});
  // projected expiry: now + 61 days covers the session
  assert.equal(checkPassForSession({ pass: unact, validityDays: 61, session, uses: [], now }).eligible, true);
  // intro bought now (14 days) can't cover a class 20 days out
  const far = { ...session, startsAt: new Date(now.getTime() + 20 * DAY_MS).toISOString() };
  assert.equal(checkPassForSession({ pass: pass({ kind: 'intro', credits: null }), validityDays: 14, session: far, uses: [], now }).reason, 'expired');
  const m = pass({ kind: 'membership', credits: 1, pausedFrom: '2026-10-12', pausedUntil: '2026-10-18' });
  assert.equal(checkPassForSession({ pass: m, session, uses: [], now }).reason, 'paused');
  assert.equal(checkPassForSession({ pass: pass({ classTypeIds: ['ct_mums'] }), session, uses: [], now }).reason, 'class_type');
  assert.equal(checkPassForSession({ pass: pass({ creditsUsed: 4 }), session, uses: [], now }).reason, 'no_credits');
  const cancelledMember = pass({ kind: 'membership', credits: 2, status: 'cancelled', nextBillingAt: at('2026-10-16', '00:00').toISOString() });
  assert.equal(checkPassForSession({ pass: cancelledMember, session, uses: [], now }).eligible, true);
  assert.equal(checkPassForSession({ pass: cancelledMember, session: { ...session, startsAt: at('2026-10-17', '08:00').toISOString() }, uses: [], now }).reason, 'cancelled');
});

test('membership weekly usage counts Mon–Sun studio weeks, ignoring cancelled', () => {
  const uses = [
    { bookingId: 'a', status: 'checked_in' as const, startsAt: at('2026-10-12', '06:00').toISOString() }, // Mon
    { bookingId: 'b', status: 'cancelled' as const, startsAt: at('2026-10-14', '06:00').toISOString() },
    { bookingId: 'c', status: 'late_cancelled' as const, startsAt: at('2026-10-18', '23:00').toISOString() }, // Sun night
    { bookingId: 'd', status: 'booked' as const, startsAt: at('2026-10-19', '06:00').toISOString() }, // next Mon
  ];
  assert.equal(weeklyUsed(uses, '2026-10-15'), 2);
  assert.equal(weeklyUsed(uses, '2026-10-19'), 1);
  assert.equal(weeklyUsed(uses, '2026-10-11'), 0);
});

test('activation sets activatedAt/expiresAt from first use; memberships start weekly billing', () => {
  const p = activatePass(pass({}), 61, now);
  assert.equal(p.activatedAt, now.toISOString());
  assert.equal(p.expiresAt, new Date(now.getTime() + 61 * DAY_MS).toISOString());
  const again = activatePass(p, 61, new Date(now.getTime() + DAY_MS));
  assert.equal(again.activatedAt, now.toISOString());
  const m = activatePass(pass({ kind: 'membership', credits: 2, billingInterval: 'week' }), null, now);
  assert.equal(m.expiresAt, null);
  assert.equal(m.nextBillingAt, new Date(now.getTime() + 7 * DAY_MS).toISOString());
});

test('cancellation window: 3h01m free, 2h59m late, staff can waive', () => {
  const start = at('2026-10-12', '18:00');
  const before = (mins: number) => new Date(start.getTime() - mins * 60_000);
  assert.deepEqual(cancellationOutcome({ startsAt: start.toISOString(), now: before(181), cancelWindowHours: 3 }), { status: 'cancelled', creditReturned: true, lateCancel: false });
  assert.deepEqual(cancellationOutcome({ startsAt: start.toISOString(), now: before(179), cancelWindowHours: 3 }), { status: 'late_cancelled', creditReturned: false, lateCancel: true });
  assert.equal(cancellationOutcome({ startsAt: start.toISOString(), now: before(30), cancelWindowHours: 3, waive: true }).status, 'cancelled');
});

test('waitlist: cutoff and first client with credit', () => {
  const start = at('2026-10-12', '18:00').toISOString();
  assert.equal(canAutoPromote(start, at('2026-10-12', '16:59'), 1), true);
  assert.equal(canAutoPromote(start, at('2026-10-12', '17:01'), 1), false);
  const wl = [
    { clientId: 'a', status: 'waitlisted' as const, waitlistPosition: 2, createdAt: '2026-10-01T00:00:00Z' },
    { clientId: 'b', status: 'waitlisted' as const, waitlistPosition: 1, createdAt: '2026-10-02T00:00:00Z' },
    { clientId: 'c', status: 'waitlisted' as const, waitlistPosition: 3, createdAt: '2026-10-03T00:00:00Z' },
  ];
  assert.equal(pickWaitlistPromotion(wl, () => true)?.clientId, 'b');
  assert.equal(pickWaitlistPromotion(wl, (c) => c !== 'b')?.clientId, 'a');
  assert.equal(pickWaitlistPromotion(wl, () => false), undefined);
});

test('intro eligibility, labels, status, roster flags', () => {
  assert.equal(isIntroEligible('c1', []), true);
  assert.equal(isIntroEligible('c1', [{ clientId: 'c1' }]), false);
  assert.equal(creditLabel({ kind: 'pack', credits: 4 }, 3), '3 of 4 left');
  assert.equal(creditLabel({ kind: 'membership', credits: null }, null), 'Unlimited');
  assert.equal(creditLabel({ kind: 'membership', credits: 2 }, 1), '1 of 2 left this week');
  assert.equal(computePassStatus(pass({ creditsUsed: 4 }), now), 'used_up');
  assert.equal(computePassStatus(pass({ expiresAt: '2026-10-01T00:00:00.000Z' }), now), 'expired');
  assert.equal(computePassStatus(pass({ status: 'cancelled' }), now), 'cancelled');
  assert.equal(birthdayInWeek('1990-10-18', '2026-10-12'), true);
  assert.equal(birthdayInWeek('1990-10-19', '2026-10-12'), false);
  const flags = rosterFlags({
    client: { injuries: 'Knee', birthday: '1990-10-14' }, booking: { status: 'booked' }, session,
    pass: pass({ creditsUsed: 4, expiresAt: at('2026-10-20', '00:00').toISOString() }), passRemaining: 0, priorCheckIns: 0,
  });
  assert.deepEqual(flags.sort(), ['birthday', 'first_class', 'injury', 'last_credit', 'no_waiver', 'pass_expiring']);
});

test('permissions + csv', () => {
  assert.equal(can('owner', 'staff_pay'), true);
  assert.equal(can('manager', 'staff_pay'), false);
  assert.equal(can('manager', 'reports_revenue'), true);
  assert.equal(can('front_desk', 'reports_revenue'), false);
  assert.equal(can('front_desk', 'pos_refund'), true);
  assert.equal(can('instructor', 'pos_refund'), false);
  assert.equal(can('instructor', 'roster_all'), false);
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(toCsv([['x', 1], [null, 'y']]), 'x,1\r\n,y\r\n');
});
