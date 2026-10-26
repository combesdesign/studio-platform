// The demo store as the apps use it: zero-arg createDemoStore({ sampleBilling: false }) with a localStorage shim.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

const { createDemoStore, STATE_KEY } = await import('../src/data/demo');
const { weekStart, studioDate, addDays, studioToUTC } = await import('../src/shared/format');

test('zero-arg demo store seeds a realistic, consistent studio', async () => {
  const store = createDemoStore({ sampleBilling: false });
  assert.equal(store.mode, 'demo');
  const personas = await store.demoPersonas();
  assert.equal(personas.filter((p) => p.kind === 'client').length, 5);
  assert.equal(personas.filter((p) => p.kind === 'staff').length, 4);
  assert.ok(mem.get(STATE_KEY), 'persisted to localStorage');

  const libby = personas.find((p) => p.kind === 'staff' && p.role === 'owner')!;
  await store.demoSignInAs!(libby);
  const clients = await store.listClients();
  assert.ok(clients.length >= 40 && clients.length <= 52, `~45 clients (${clients.length})`);

  const today = studioDate(new Date());
  const mon = weekStart(today);
  const week = await store.listSessions({ from: studioToUTC(mon, '00:00'), to: studioToUTC(addDays(mon, 14), '00:00') });
  assert.equal(week.filter((s) => s.status === 'scheduled').length >= 26, true);
  assert.ok(week.some((s) => s.waitlistCount > 0 && s.spotsLeft === 0), 'a full class with a waitlist');

  const staff = await store.listStaff();
  assert.deepEqual(staff.map((s) => s.name), ['Libby', 'Grace P', 'Grace T', 'Julia']);
  assert.ok(staff.every((s) => s.photoUrl && !s.photoUrl.startsWith('/')));

  const report = await store.getReport({ from: addDays(mon, -42), to: addDays(mon, -1) });
  assert.ok(report.classesRun > 70, `classes run ${report.classesRun}`);
  assert.ok(report.revenueCents > 500_000, `revenue ${report.revenueCents}`);
  assert.ok(report.attended > 250);
  assert.ok(report.byInstructor.length >= 3);

  // Persona states
  const byEmail = (e: string) => clients.find((c) => c.email === e)!;
  const chloe = byEmail('chloe.bennett@example.com');
  assert.equal(chloe.waiverSignedAt, undefined);
  assert.equal(await store.isIntroEligible(chloe.id), true);
  const jess = await store.getCreditSummary(byEmail('jess.walker@example.com').id);
  assert.equal(jess[0]?.label, '1 of 4 left');
  const hannah = await store.getCreditSummary(byEmail('hannah.mitchell@example.com').id);
  assert.equal(hannah[0]?.label, '1 of 2 left this week');
  const mia = await store.getCreditSummary(byEmail('mia.roberts@example.com').id);
  assert.equal(mia[0]?.label, 'Unlimited');
  assert.equal(mia[0]?.pass.kind, 'intro');

  // Pack usage always matches bookings; memberships never exceed their weekly credits; no class over capacity.
  const platform = JSON.parse(mem.get(STATE_KEY)!) as import('../src/data/demo/db').PlatformDemoState;
  assert.deepEqual(platform.studios.map((s) => s.slug), ['snowy', 'harbour'], 'the demo platform has Snowy and Harbour');
  const raw = platform.data['studio_snowy']!;
  const startOf = new Map(raw.sessions.map((s) => [s.id, s.startsAt]));
  const using = ['booked', 'checked_in', 'no_show', 'late_cancelled'];
  for (const p of raw.passes) {
    const uses = raw.bookings.filter((b) => b.passId === p.id && using.includes(b.status));
    if (p.kind !== 'membership' && p.credits !== null) assert.equal(p.creditsUsed, uses.length, `${p.clientId} ${p.name}`);
    if (p.kind === 'membership' && p.credits !== null) {
      const perWeek = new Map<string, number>();
      for (const b of uses) { const w = weekStart(studioDate(startOf.get(b.sessionId)!)); perWeek.set(w, (perWeek.get(w) ?? 0) + 1); }
      for (const n of perWeek.values()) assert.ok(n <= p.credits);
    }
  }
  for (const s of raw.sessions) {
    const n = raw.bookings.filter((b) => b.sessionId === s.id && ['booked', 'checked_in', 'no_show'].includes(b.status)).length;
    assert.ok(n <= s.capacity, `${s.id} over capacity`);
  }

  // A second store instance (another tab) sees the same data; a booking shows up after sync.
  const other = createDemoStore({ sampleBilling: false });
  await other.demoSignInAs!(personas.find((p) => p.kind === 'client' && p.email === 'jess.walker@example.com')!);
  const open = week.find((s) => s.status === 'scheduled' && s.spotsLeft > 0 && Date.parse(s.startsAt) > Date.now() + 4 * 3_600_000)!;
  const booked = await other.bookClass(byEmail('jess.walker@example.com').id, open.id);
  assert.equal(booked.outcome, 'booked');
  const roster = await store.getRoster(open.id);
  const entry = roster.find((r) => r.clientId === byEmail('jess.walker@example.com').id)!;
  assert.ok(entry.flags.includes('last_credit'));

  await store.demoReset!();
  assert.equal((await store.currentUser())?.kind, 'staff');
});
