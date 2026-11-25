// Notice board: the rules (calc), and the demo store for both demo studios (seeded example, who can post, active vs finished, pin, remove).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { cleanNotice, isActive, sortNotices } from '../src/features/notices/calc';
import type { Notice } from '../src/features/notices/types';

const n = (over: Partial<Notice>): Notice => ({ id: 'n' + Math.random(), title: 'T', body: '', pinned: false, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', ...over });

test('a notice shows until the end of its last day; no date means until removed', () => {
  assert.equal(isActive(n({}), '2026-10-15'), true);
  assert.equal(isActive(n({ showUntil: '2026-10-15' }), '2026-10-15'), true, 'still showing on its last day');
  assert.equal(isActive(n({ showUntil: '2026-10-14' }), '2026-10-15'), false);
});

test('pinned first, then newest', () => {
  const a = n({ id: 'a', createdAt: '2026-10-10T00:00:00.000Z' });
  const b = n({ id: 'b', createdAt: '2026-10-12T00:00:00.000Z' });
  const c = n({ id: 'c', createdAt: '2026-10-01T00:00:00.000Z', pinned: true });
  assert.deepEqual(sortNotices([a, b, c]).map((x) => x.id), ['c', 'b', 'a']);
});

test('checks: title needed, lengths, web address, valid future date', () => {
  const ok = cleanNotice({ title: '  Hello ', body: ' Text ', linkUrl: ' https://example.com/x ', showUntil: '2026-11-01', pinned: true }, '2026-10-15');
  assert.deepEqual(ok, { ok: true, value: { title: 'Hello', body: 'Text', pinned: true, linkUrl: 'https://example.com/x', showUntil: '2026-11-01' } });
  assert.deepEqual(cleanNotice({ title: 'Hi' }, '2026-10-15'), { ok: true, value: { title: 'Hi', body: '', pinned: false } });
  for (const bad of [{ title: '  ' }, { title: 'x'.repeat(81) }, { title: 'a', body: 'x'.repeat(301) }, { title: 'a', linkUrl: 'javascript:alert(1)' }, { title: 'a', linkUrl: 'example.com' },
    { title: 'a', showUntil: '2026-10-14' }, { title: 'a', showUntil: 'soon' }]) assert.equal(cleanNotice(bad, '2026-10-15').ok, false, JSON.stringify(bad));
});

async function open(slug: string) {
  const NOW = new Date('2026-10-15T01:30:00Z');
  const p = createDemoPlatform({ sampleBilling: false, now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const s = p.forStudio((await p.findStudio({ slug }))!);
  const personas = await s.demoPersonas();
  return { s, personas, as: (u: (typeof personas)[number]) => s.demoSignInAs!(u) };
}

for (const slug of ['snowy', 'harbour']) {
  test(`demo (${slug}): one example notice; owner and manager manage, everyone else only reads what is showing`, async () => {
    const { s, personas, as } = await open(slug);
    const role = (r: string) => personas.find((u) => u.kind === 'staff' && u.role === r);
    const client = personas.find((u) => u.kind === 'client')!;
    await as(role('owner')!);
    const nt = s.features.notices!;
    assert.ok(nt, 'notices registered');
    const seeded = await nt.listAll();
    assert.equal(seeded.length, 1, 'one example notice');
    assert.ok(seeded[0]!.title && !seeded[0]!.pinned);

    const posted = await nt.save({ title: 'Studio closed Monday', body: 'Public holiday.', linkUrl: 'https://example.com/hours', showUntil: '2026-10-20', pinned: true });
    assert.equal(posted.pinned, true);
    assert.deepEqual((await nt.listActive()).map((x) => x.id), [posted.id, seeded[0]!.id], 'pinned first');
    await assert.rejects(() => nt.save({ title: '' }), /title/);
    await assert.rejects(() => nt.save({ title: 'Old', showUntil: '2026-10-01' }), /past/);

    const edited = await nt.save({ id: posted.id, title: 'Studio closed Monday 19th', pinned: true });
    assert.equal(edited.title, 'Studio closed Monday 19th');
    assert.equal(edited.linkUrl, undefined, 'a blank link clears it');
    assert.equal((await nt.setPinned(posted.id, false)).pinned, false);

    const m = role('manager');
    if (m) { await as(m); assert.equal((await nt.listAll()).length, 2, 'a manager manages notices too'); }
    const front = role('front_desk') ?? role('instructor');
    if (front) { await as(front); await assert.rejects(() => nt.save({ title: 'No' }), /access/); await assert.rejects(() => nt.listAll()); }

    await as(client);
    assert.equal((await nt.listActive()).length, 2, 'clients see the active ones');
    await assert.rejects(() => nt.save({ title: 'Nope' }));
    await assert.rejects(() => nt.remove(posted.id));
    await assert.rejects(() => nt.listAll());

    await as(role('owner')!);
    await nt.remove(posted.id);
    assert.equal((await nt.listAll()).length, 1);
    await assert.rejects(() => nt.remove(posted.id), /find/);
  });
}
