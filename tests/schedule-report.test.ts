import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Booking, Sale, ScheduleTemplate } from '../src/shared/types';
import { buildReport, generateSessions, salesCsv, templateSessionId } from '../src/domain';
import { CLASS_TYPES, PRODUCTS, STAFF } from '../src/data/demo/fixtures';
import { mkClient, mkSession } from './helpers';

const tpl = (id: string, weekday: number, startTime: string): ScheduleTemplate =>
  ({ id, classTypeId: 'ct_mat', weekday, startTime, instructorId: 'st_libby', startsOn: '2026-01-01', active: true });

test('schedule generation is DST-safe across the Oct 2026 change (AEST → AEDT)', () => {
  const templates = [tpl('sat', 6, '06:00'), tpl('sun', 0, '06:00'), tpl('mon', 1, '06:00'), tpl('sunEarly', 0, '02:30')];
  const out = generateSessions({ templates, classTypes: CLASS_TYPES, from: '2026-10-03', to: '2026-10-05', existingIds: new Set() });
  const by = Object.fromEntries(out.map((s) => [s.templateId, s.startsAt]));
  assert.equal(by.sat, '2026-10-02T20:00:00.000Z'); // Sat 3 Oct 6am AEST (+10)
  assert.equal(by.sun, '2026-10-03T19:00:00.000Z'); // Sun 4 Oct 6am AEDT (+11), the changeover day
  assert.equal(by.mon, '2026-10-04T19:00:00.000Z'); // Mon 5 Oct 6am AEDT
  assert.ok(by.sunEarly); // 2:30am doesn't exist on 4 Oct; still produces one session
  const mat = out.find((s) => s.templateId === 'mon');
  assert.equal(Date.parse(mat!.endsAt) - Date.parse(mat!.startsAt), 55 * 60_000);
  assert.equal(mat!.capacity, 14);
  // idempotent
  const again = generateSessions({ templates, classTypes: CLASS_TYPES, from: '2026-10-03', to: '2026-10-05', existingIds: new Set(out.map((s) => s.id)) });
  assert.equal(again.length, 0);
  assert.equal(out[0]!.id, templateSessionId(out[0]!.templateId!, '2026-10-03'));
});

test('schedule generation is DST-safe across the Apr 2026 change (AEDT → AEST)', () => {
  const templates = [tpl('sat', 6, '18:00'), tpl('sun', 0, '06:00'), tpl('mon', 1, '06:00')];
  const out = generateSessions({ templates, classTypes: CLASS_TYPES, from: '2026-04-04', to: '2026-04-06', existingIds: new Set() });
  const by = Object.fromEntries(out.map((s) => [s.templateId, s.startsAt]));
  assert.equal(by.sat, '2026-04-04T07:00:00.000Z'); // Sat 4 Apr 6pm AEDT (+11)
  assert.equal(by.sun, '2026-04-04T20:00:00.000Z'); // Sun 5 Apr 6am AEST (+10)
  assert.equal(by.mon, '2026-04-05T20:00:00.000Z');
});

test('templates respect startsOn/endsOn, inactive templates and class types', () => {
  const t = { ...tpl('a', 1, '06:00'), startsOn: '2026-10-12', endsOn: '2026-10-19' };
  const off = { ...tpl('b', 1, '07:00'), active: false };
  const out = generateSessions({ templates: [t, off], classTypes: CLASS_TYPES, from: '2026-10-01', to: '2026-10-31', existingIds: new Set() });
  assert.deepEqual(out.map((s) => s.id), ['se_a_20261012', 'se_a_20261019']);
});

test('report aggregation on a small fixture', () => {
  const now = new Date('2026-10-20T00:00:00.000Z');
  const sessions = [
    mkSession('s1', '2026-10-12', '06:00', { instructorId: 'st_julia', capacity: 10 }),
    mkSession('s2', '2026-10-12', '18:00', { instructorId: 'st_julia', capacity: 10 }),
    mkSession('s3', '2026-10-13', '18:00', { instructorId: 'st_gracet', capacity: 10 }),
    mkSession('s4', '2026-10-14', '18:00', { status: 'cancelled' }),
    mkSession('s5', '2026-10-25', '18:00'), // future
  ];
  const b = (id: string, sessionId: string, status: Booking['status']): Booking => ({ id, sessionId, clientId: 'c' + id, status, createdAt: '2026-10-01T00:00:00Z', source: 'client' });
  const bookings = [
    b('1', 's1', 'checked_in'), b('2', 's1', 'checked_in'), b('3', 's1', 'no_show'), b('4', 's1', 'late_cancelled'), b('5', 's1', 'cancelled'),
    b('6', 's2', 'checked_in'), b('7', 's2', 'checked_in'), b('8', 's2', 'checked_in'), b('9', 's2', 'checked_in'), b('10', 's2', 'checked_in'),
    b('11', 's3', 'checked_in'), b('12', 's4', 'removed'), b('13', 's5', 'booked'),
  ];
  const sales: Sale[] = [
    { id: 'a', items: [{ productId: 'pr_p4', name: '4 pack', qty: 1, unitCents: 10000 }], totalCents: 10000, method: 'card_online', createdAt: '2026-10-12T01:00:00Z' },
    { id: 'b', items: [{ productId: 'pr_socks', name: 'Socks', qty: 2, unitCents: 2000 }, { productId: 'pr_drop', name: 'Single', qty: 1, unitCents: 3000 }], totalCents: 6000, method: 'cash', createdAt: '2026-10-13T01:00:00Z', refundedCents: 2000, refundedAt: '2026-10-14T01:00:00Z' },
    { id: 'c', items: [{ productId: 'pr_m2', name: '2/wk', qty: 1, unitCents: 4000 }], totalCents: 4000, method: 'card_online', createdAt: '2026-09-01T01:00:00Z' },
  ];
  const clients = [mkClient('n1', 'New', { createdAt: '2026-10-13T00:00:00Z' }), mkClient('o1', 'Old')];
  const r = buildReport({ range: { from: '2026-10-12', to: '2026-10-18' }, now, sales, sessions, bookings, clients, passes: [], staff: STAFF, classTypes: CLASS_TYPES, products: PRODUCTS });
  assert.equal(r.revenueCents, 16000);
  assert.equal(r.refundsCents, 2000);
  assert.deepEqual(r.revenueByMethod, { card_online: 10000, cash: 6000 });
  // sale b: 7000 gross discounted to 6000 → socks 4000*6/7=3428, dropin gets remainder 2572
  assert.deepEqual(r.revenueByKind, { pack: 10000, retail: 3428, dropin: 2572 });
  assert.equal(r.salesCount, 2);
  assert.equal(r.classesRun, 3);
  assert.equal(r.totalBookings, 10); // s1: 4 (2 in, ns, late), s2: 5, s3: 1
  assert.equal(r.attended, 8);
  assert.equal(r.noShows, 1);
  assert.equal(r.lateCancels, 1);
  assert.equal(r.avgFillPct, Math.round(((30 + 50 + 10) / 3) * 10) / 10);
  assert.equal(r.newClients, 1);
  const julia = r.byInstructor.find((x) => x.staffId === 'st_julia')!;
  assert.deepEqual(julia, { staffId: 'st_julia', name: 'Julia', classes: 2, attendees: 7, payCents: 12000 });
  assert.equal(r.byInstructor.find((x) => x.staffId === 'st_gracet')!.payCents, 6000);
  assert.deepEqual(r.byClassType, [{ classTypeId: 'ct_mat', name: 'Mat Essentials', classes: 3, attendees: 8, avgFillPct: 30 }]);
  assert.equal(r.topSlots[0]!.label, 'Mon 6:00pm');
  assert.equal(r.topSlots[0]!.avgAttendees, 5);
  const csv = salesCsv({ sales, clients, staff: STAFF, range: { from: '2026-10-12', to: '2026-10-18' } });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^Date,Time,Sale ID,Client/);
  assert.match(lines[2]!, /2 x Socks; 1 x Single,cash,60\.00,5\.45,20\.00,40\.00/);
});
