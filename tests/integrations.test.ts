// ClassPass / Gympass hooks: the spot rules, and the demo store for both demo studios (spots held, partner bookings, write-only keys, roles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { heldFor, partnerBookError } from '../src/features/integrations/partners';

const ok = { capacity: 10, booked: 3, held: 2, used: 0 };

test('partner spot rules: held spots, class full, cancelled, started', () => {
  assert.equal(partnerBookError(ok), null);
  assert.equal(partnerBookError({ ...ok, held: 0 })?.code, 'NO_PARTNER_SPOTS');
  assert.equal(partnerBookError({ ...ok, used: 2 })?.code, 'NO_PARTNER_SPOTS');
  assert.equal(partnerBookError({ ...ok, booked: 10 })?.code, 'CLASS_FULL');
  assert.equal(partnerBookError({ ...ok, cancelled: true })?.code, 'CLASS_CANCELLED');
  assert.equal(partnerBookError({ ...ok, started: true })?.code, 'TOO_LATE');
  assert.equal(heldFor([{ classTypeId: 'a', partner: 'classpass', spots: 3 }], 'a', 'classpass'), 3);
  assert.equal(heldFor([{ classTypeId: 'a', partner: 'classpass', spots: 3 }], 'a', 'gympass'), 0);
});

async function open(slug: string) {
  const NOW = new Date('2026-10-15T01:30:00Z');
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const s = p.forStudio((await p.findStudio({ slug }))!);
  const personas = await s.demoPersonas();
  const as = async (role: string) => { const u = personas.find((p) => p.kind === 'staff' && p.role === role); if (u) await s.demoSignInAs!(u); return !!u; };
  return { s, as };
}

for (const slug of ['snowy', 'harbour']) {
  test(`demo (${slug}): partner seeded, spots held, partner bookings follow the rules, keys are write-only, roles`, async () => {
    const { s, as } = await open(slug);
    const partner = slug === 'snowy' ? 'classpass' : 'gympass';
    const other = slug === 'snowy' ? 'gympass' : 'classpass';
    await as('owner');
    const api = s.features.integrations!;
    assert.ok(api, 'integrations registered');
    const list = await api.listPartners();
    assert.equal(list.length, 2);
    assert.deepEqual(list.filter((p) => p.enabled).map((p) => p.partner), [partner]);
    assert.ok(list.find((p) => p.partner === partner)!.partnerStudioId);
    const reserved = await api.listReserved();
    assert.ok(reserved.length > 0 && reserved.every((r) => r.partner === partner));

    // keys: owner only, never returned
    const saved = await api.savePartner(partner, { apiKey: 'sekrit-key-123' });
    assert.equal(saved.keySet, true);
    assert.ok(!JSON.stringify(await api.listPartners()).includes('sekrit'), 'the key is never sent back');
    assert.ok(!JSON.stringify(localStorage_dump(s)).includes('sekrit'), 'and never kept in the demo data either');
    assert.equal((await api.savePartner(partner, { apiKey: '' })).keySet, false);
    await assert.rejects(() => api.savePartner(other, { enabled: true }), /partner ID/, 'can\'t switch on without an ID');

    // partner bookings: the seeded ones show up, and the rules apply
    const types = await s.listClassTypes();
    const heldType = types.find((t) => t.id === reserved[0]!.classTypeId)!;
    const unheld = types.find((t) => t.active && t.bookable && !reserved.some((r) => r.classTypeId === t.id));
    const sessions = (await s.listSessions({ from: '2026-10-15T01:30:00Z', to: '2026-10-30T00:00:00Z' })).filter((x) => x.status === 'scheduled' && Date.parse(x.startsAt) > Date.parse('2026-10-15T01:30:00Z'));
    const mine = sessions.filter((x) => x.classTypeId === heldType.id);
    const seeded = (await Promise.all(mine.map((x) => api.partnerBookings(x.id)))).flat();
    assert.ok(seeded.length > 0 && seeded.every((b) => b.source === partner), 'seeded partner bookings');
    const roster = await s.getRoster(seeded[0]!.sessionId);
    assert.ok(roster.some((e) => e.id === seeded[0]!.bookingId && e.status === 'booked'), 'a partner booking is on the roster');
    assert.equal(roster.find((e) => e.id === seeded[0]!.bookingId)!.passId, undefined, 'no pass is used');

    const held = reserved[0]!.spots;
    const free = mine.find((x) => !seeded.some((b) => b.sessionId === x.id) && x.spotsLeft >= held + 1)!;
    const before = (await s.getRoster(free.id)).filter((e) => e.status === 'booked').length;
    for (let i = 0; i < held; i++) await api.demoPartnerBook!(partner, free.id);
    const after = await s.getRoster(free.id);
    assert.equal(after.filter((e) => e.status === 'booked').length, before + held, 'new partner bookings show on the roster straight away');
    assert.equal((await s.getSession(free.id)).bookedCount, before + held);
    assert.equal((await api.partnerBookings(free.id)).length, held);
    await assert.rejects(() => api.demoPartnerBook!(partner, free.id), /spots held for this partner are all taken/);
    await assert.rejects(() => api.demoPartnerBook!(other, free.id), /switched on/, 'the other partner is off');
    if (unheld) {
      const s2 = sessions.find((x) => x.classTypeId === unheld.id);
      if (s2) await assert.rejects(() => api.demoPartnerBook!(partner, s2.id), /No spots are held/);
    }
    // change what is held
    await api.setReserved(heldType.id, partner, 0);
    assert.equal((await api.listReserved()).some((r) => r.classTypeId === heldType.id && r.partner === partner), false);
    await assert.rejects(() => api.setReserved(heldType.id, partner, 201), /0 to 200/);
    await assert.rejects(() => api.setReserved('nope', partner, 1), /find that class type/);

    // roles
    if (await as('manager')) {
      await api.savePartner(partner, { partnerStudioId: 'MGR-1' });
      await assert.rejects(() => api.savePartner(partner, { apiKey: 'x' }), 'a manager can\'t enter a key');
    }
    await as('instructor');
    assert.ok((await api.listReserved()).length >= 0, 'instructors can see what is held');
    await assert.rejects(() => api.listPartners(), 'but not the partner settings');
    await assert.rejects(() => api.setReserved(heldType.id, partner, 1));
  });
}

// the demo keeps its data in the studio slice; make sure a key can't be found anywhere in it
function localStorage_dump(s: unknown): unknown { return JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'function' ? undefined : v))); }

test('demo: each studio keeps its own partner settings and partner ID', async () => {
  const a = await open('snowy'), b = await open('harbour');
  await a.as('owner'); await b.as('owner');
  const pa = await a.s.features.integrations!.listPartners(), pb = await b.s.features.integrations!.listPartners();
  assert.equal(pa.find((p) => p.partner === 'classpass')!.enabled, true);
  assert.equal(pb.find((p) => p.partner === 'classpass')!.enabled, false);
  await assert.rejects(() => b.s.features.integrations!.demoPartnerBook!('classpass', 'x'), 'Harbour has ClassPass switched off');
});
