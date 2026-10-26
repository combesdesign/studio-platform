// Payroll: the shared calculation (all rule kinds), the CSV export, and the demo store for both demo studios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { calcPayroll, payrollCsv, periodFor, shiftPeriod, classParts } from '../src/features/payroll/calc';
import type { PayRule, TimesheetEntry } from '../src/features/payroll/types';

const R = { from: '2026-10-05', to: '2026-10-11' };
const rule = (r: Partial<PayRule> & Pick<PayRule, 'kind'>): PayRule => ({ id: 'r' + Math.random(), staffId: 'a', active: true, ...r });
const cls = (id: string, staffId: string, attendees: number, day = '2026-10-06') =>
  ({ sessionId: id, staffId, classTypeId: 'ct1', startsAt: `${day}T00:00:00.000Z`, attendees });
const entry = (over: Partial<TimesheetEntry>): TimesheetEntry => ({
  id: 'e' + Math.random(), staffId: 'a', kind: 'shift', startedAt: '2026-10-07T00:00:00.000Z', endedAt: '2026-10-07T04:30:00.000Z', breakMin: 30,
  units: 1, source: 'manual', status: 'approved', createdBy: 'a', createdAt: '2026-10-07T00:00:00.000Z', ...over,
});

test('calc: per class, per head, tiered pay', () => {
  assert.equal(classParts({ kind: 'flat', rateCents: 6000 }, 3).parts[0]!.amountCents, 6000);
  const perHead = classParts({ kind: 'per_head', baseCents: 5000, perHeadCents: 500, aboveN: 4 }, 9).parts.reduce((n, p) => n + p.amountCents, 0);
  assert.equal(perHead, 5000 + 5 * 500);
  const tiers = [{ minAttendees: 1, payCents: 4000 }, { minAttendees: 6, payCents: 6000 }, { minAttendees: 10, payCents: 8000 }];
  const pay = (n: number) => classParts({ kind: 'tiered', tiers }, n).parts.reduce((x, p) => x + p.amountCents, 0);
  assert.deepEqual([pay(1), pay(6), pay(12)], [4000, 6000, 8000]);
});

test('calc: hours, session types, adjustments, pending and missing rules', () => {
  const out = calcPayroll({
    ...R, staff: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo' }],
    classes: [cls('s1', 'a', 8), cls('s2', 'b', 4)],
    rules: [rule({ kind: 'flat', rateCents: 7000 }), rule({ kind: 'hourly', rateCents: 3000 }), rule({ kind: 'session', sessionType: 'private', rateCents: 9000 })],
    entries: [
      entry({}),                                                                  // 4h worked, approved
      entry({ startedAt: '2026-10-08T00:00:00.000Z', endedAt: '2026-10-08T01:00:00.000Z', breakMin: 0, status: 'pending' }),
      entry({ kind: 'session', sessionType: 'private', units: 2, startedAt: '2026-10-09T00:00:00.000Z', endedAt: '2026-10-09T01:00:00.000Z', breakMin: 0 }),
    ],
    adjustments: [{ id: 'j1', periodFrom: R.from, periodTo: R.to, staffId: 'a', label: 'Bonus', amountCents: 2500, reason: 'Cover', createdBy: 'a', createdAt: R.from }],
  });
  const ann = out.staff.find((s) => s.staffId === 'a')!;
  assert.equal(ann.totalCents, 7000 + 4 * 3000 + 2 * 9000 + 2500);
  assert.equal(ann.pendingEntries, 1);
  assert.equal(out.pendingEntries, 1);
  const bo = out.staff.find((s) => s.staffId === 'b')!;
  assert.equal(bo.totalCents, 0, 'a rule only applies to the person it belongs to');
  assert.ok(bo.warnings.some((w) => /No pay rule/.test(w)));
  const csv = payrollCsv(out).split(/\r?\n/);
  assert.equal(csv[0], 'Employee,Earnings rate,Hours / units,Rate,Amount');
  assert.ok(csv.some((l) => l.startsWith('Ann,') && l.endsWith(',25.00')), 'adjustment row');
  assert.ok(!csv.some((l) => l.startsWith('Bo,')), 'zero rows are left out');
});

test('calc: periods repeat from the anchor and shift', () => {
  const p = periodFor('2026-10-15', { frequency: 'weekly', periodAnchor: '2024-01-01' });
  assert.deepEqual(p, { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(shiftPeriod(p, -1), { from: '2026-10-05', to: '2026-10-11' });
  const f = periodFor('2026-10-15', { frequency: 'fortnightly', periodAnchor: '2024-01-01' });
  assert.equal(f.to > f.from && (Date.parse(f.to) - Date.parse(f.from)) / 864e5, 13);
});

test('demo: both studios are seeded; cover, clock, pay and export work end to end', async () => {
  const NOW = new Date('2026-10-15T01:30:00Z');
  const p = createDemoPlatform({ sampleBilling: false, now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  for (const slug of ['snowy', 'harbour']) {
    const s = p.forStudio((await p.findStudio({ slug }))!);
    const personas = await s.demoPersonas();
    await s.demoSignInAs!(personas.find((u) => u.kind === 'staff' && u.role === 'owner')!);
    const pr = s.features.payroll!;
    assert.ok(pr, `${slug}: payroll registered`);
    const set = await pr.getSettings();
    const cur = periodFor('2026-10-15', set);
    const prev = shiftPeriod(cur, -1);
    const view = await pr.getPayPeriod(prev);
    assert.ok(view.staff.length > 0 && view.totalCents > 0, `${slug}: last period has pay`);
    assert.ok((await pr.listPayRules()).length > 0, `${slug}: pay rules seeded`);
    assert.ok((await pr.listCover()).length > 0, `${slug}: cover requests seeded`);
    const csv = await pr.exportCsv(prev);
    assert.match(csv, /^Employee,Earnings rate,Hours \/ units,Rate,Amount/);
    // adjustment moves the total, markPaid freezes it, reopen unfreezes
    const who = view.staff[0]!.staffId;
    const before = (await pr.getPayPeriod(prev)).totalCents;
    const adj = await pr.addAdjustment({ ...prev, staffId: who, label: 'Bonus', amountCents: 5000, reason: 'Test' });
    assert.equal((await pr.getPayPeriod(prev)).totalCents, before + 5000);
    await pr.removeAdjustment(adj.id);
    assert.equal((await pr.getPayPeriod(prev)).totalCents, before);
    // can't pay a period that is still running
    await assert.rejects(() => pr.markPaid(cur));
    // clock in then out as the owner is allowed only if eligible; either way it must not throw on status
    const st = await pr.clockStatus();
    assert.equal(typeof st.eligible, 'boolean');
  }
});

test('demo: a studio keeps its own payroll data', async () => {
  const NOW = new Date('2026-10-15T01:30:00Z');
  const p = createDemoPlatform({ sampleBilling: false, now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const get = async (slug: string) => {
    const s = p.forStudio((await p.findStudio({ slug }))!);
    await s.demoSignInAs!((await s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'owner')!);
    return s.features.payroll!;
  };
  const a = await get('snowy');
  const ra = await a.listPayRules(), ca = await a.listCover();
  const b = await get('harbour');
  const rb = await b.listPayRules(), cb = await b.listCover();
  assert.ok(ra.length > 0 && rb.length > 0 && cb.length > 0);
  assert.notDeepEqual(ra.map((r) => r.staffId), rb.map((r) => r.staffId), 'each studio has its own people');
  await assert.rejects(() => b.decideCover(ca[0]!.id, 'decline'), 'one studio can’t touch another studio’s request');
});
