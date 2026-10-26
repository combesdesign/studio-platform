// Online classes: link parsing, checks, and the demo store for both demo studios (locked vs unlocked, free videos, views, staff only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { cleanVideo, embedUrl, hasOnlineAccess, parseVideoUrl, toClientVideo } from '../src/features/ondemand/calc';
import type { AdminVideo } from '../src/features/ondemand/types';
import type { Pass } from '../src/shared/types';

test('links: YouTube, Vimeo (incl. unlisted) and direct files are understood; anything else is refused', () => {
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), { kind: 'youtube', id: 'aqz-KE-bpKQ' });
  assert.deepEqual(parseVideoUrl('https://youtu.be/aqz-KE-bpKQ?t=4'), { kind: 'youtube', id: 'aqz-KE-bpKQ' });
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/shorts/aqz-KE-bpKQ'), { kind: 'youtube', id: 'aqz-KE-bpKQ' });
  assert.deepEqual(parseVideoUrl('https://vimeo.com/123456789'), { kind: 'vimeo', id: '123456789' });
  assert.deepEqual(parseVideoUrl('https://vimeo.com/123456789/abcdef1234'), { kind: 'vimeo', id: '123456789', hash: 'abcdef1234' });
  assert.deepEqual(parseVideoUrl('https://player.vimeo.com/video/123456789?h=abcdef1234'), { kind: 'vimeo', id: '123456789', hash: 'abcdef1234' });
  assert.equal(parseVideoUrl('https://cdn.example.com/a/b.MP4?x=1').kind, 'file');
  for (const bad of ['', 'not a url', 'javascript:alert(1)', 'https://example.com/page.html', 'https://www.youtube.com/watch', 'https://vimeo.com/channels/staffpicks', 'ftp://x.com/a.mp4']) assert.equal(parseVideoUrl(bad).kind, 'invalid', bad);
  assert.match(embedUrl(parseVideoUrl('https://vimeo.com/123456789/abcdef1234'))!, /^https:\/\/player\.vimeo\.com\/video\/123456789\?h=abcdef1234&autoplay=1/);
  assert.match(embedUrl(parseVideoUrl('https://youtu.be/aqz-KE-bpKQ'))!, /^https:\/\/www\.youtube-nocookie\.com\/embed\/aqz-KE-bpKQ/);
  assert.equal(embedUrl(parseVideoUrl('https://x.com/a.mp4')), null, 'a file is not embedded');
});

test('checks: title, category, minutes and a playable link', () => {
  const ok = { title: ' Core ', category: 'Core', durationMin: 20, videoUrl: 'https://vimeo.com/123456789' };
  assert.deepEqual(cleanVideo(ok), { title: 'Core', description: '', instructor: '', durationMin: 20, level: 'All levels', category: 'Core', thumbnailUrl: '', videoUrl: ok.videoUrl, published: false, free: false });
  for (const bad of [{ title: '' }, { category: ' ' }, { durationMin: 0 }, { durationMin: 601 }, { durationMin: 1.5 }, { videoUrl: 'https://example.com/x' }, { thumbnailUrl: 'javascript:1' }, { description: 'x'.repeat(1001) }]) {
    assert.throws(() => cleanVideo({ ...ok, ...bad }), /^Error: INVALID/);
  }
});

const video = (over: Partial<AdminVideo> = {}): AdminVideo => ({ id: 'v1', title: 'T', description: '', instructor: '', durationMin: 10, level: '', category: 'Core', thumbnailUrl: '', videoUrl: 'https://x.com/a.mp4', published: true, free: false, sortOrder: 1, views: 0, ...over });
const pass = (over: Partial<Pass> = {}): Pass => ({ id: 'p1', clientId: 'c', productId: 'pr_online', kind: 'membership', name: 'Online', status: 'active', purchasedAt: '2026-10-01T00:00:00Z', credits: null, creditsUsed: 0, priceCents: 1900, ...over });

test('locked vs unlocked: free videos are open, paid ones need an active pass from a flagged product, and the address is withheld while locked', () => {
  const now = new Date('2026-10-26T01:00:00Z');
  const flagged = new Set(['pr_online']);
  const locked = toClientVideo(video(), false, null);
  assert.equal(locked.locked, true);
  assert.equal(locked.videoUrl, null);
  assert.ok(!JSON.stringify(locked).includes('a.mp4'), 'the address is nowhere in the locked row');
  const free = toClientVideo(video({ free: true }), false, null);
  assert.deepEqual([free.locked, free.videoUrl], [false, 'https://x.com/a.mp4']);
  assert.equal(toClientVideo(video(), true, null).locked, false);

  assert.equal(hasOnlineAccess([pass()], flagged, now), true);
  assert.equal(hasOnlineAccess([pass({ productId: 'pr_p4' })], flagged, now), false, 'a pass from a product that isn\'t flagged');
  assert.equal(hasOnlineAccess([], flagged, now), false);
  assert.equal(hasOnlineAccess([pass({ status: 'cancelled' })], flagged, now), false, 'cancelled');
  assert.equal(hasOnlineAccess([pass({ expiresAt: '2026-10-01T00:00:00Z' })], flagged, now), false, 'expired');
  assert.equal(hasOnlineAccess([pass({ pausedFrom: '2026-10-20', pausedUntil: '2026-11-20' })], flagged, now), false, 'paused');
  assert.equal(hasOnlineAccess([pass({ productId: 'a' }), pass({ productId: 'pr_online' })], flagged, now), true, 'any one pass will do');
});

async function open(slug: string) {
  const NOW = new Date('2026-10-15T01:30:00Z');
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const s = p.forStudio((await p.findStudio({ slug }))!);
  const personas = await s.demoPersonas();
  return { s, personas, as: (u: (typeof personas)[number]) => s.demoSignInAs!(u) };
}

for (const slug of ['snowy', 'harbour']) {
  test(`demo (${slug}): seeded library; clients see locked rows without addresses, free videos play, flagging a product unlocks it, staff manage`, async () => {
    const { s, personas, as } = await open(slug);
    const od = s.features.ondemand!;
    assert.ok(od, 'registered');
    const owner = personas.find((u) => u.kind === 'staff' && u.role === 'owner')!;
    await as(owner);
    const all = await od.adminList();
    assert.equal(all.length, slug === 'snowy' ? 6 : 4);
    assert.ok(all.every((v) => v.published && v.views > 0 && v.thumbnailUrl && v.videoUrl));
    assert.ok(all.some((v) => v.free), 'a free video');
    if (slug === 'snowy') {
      assert.ok(all.some((v) => v.free && v.title === 'Mums + Bubs: getting started'));
      assert.ok((await s.listProducts()).some((p) => p.name === 'Online membership' && p.priceCents === 1900), 'the seeded Online membership');
      assert.ok((await od.getSettings()).productIds.includes('pr_online'));
    }

    // a client with no online pass: paid rows locked and address-free, free rows open
    const client = personas.find((u) => u.kind === 'client')!;
    await as(client);
    const cat = await od.list();
    assert.equal(cat.access, false);
    assert.equal(cat.videos.length, all.length);
    for (const v of cat.videos) {
      assert.equal(v.locked, !v.free);
      assert.equal(v.videoUrl === null, v.locked, 'address only when unlocked');
    }
    const paid = cat.videos.find((v) => v.locked)!;
    const free = cat.videos.find((v) => v.free)!;
    await assert.rejects(() => od.recordView(paid.id), /Unlock/);
    const before = (await (async () => { await as(owner); return od.adminList(); })()).find((v) => v.id === free.id)!.views;
    await as(client);
    await od.recordView(free.id);
    assert.ok((await od.list()).videos.find((v) => v.id === free.id)!.lastWatchedAt, 'shows as recently watched');
    await assert.rejects(() => od.adminList(), 'clients can\'t see the staff list');
    await assert.rejects(() => od.save({ title: 'x', category: 'x', durationMin: 5, videoUrl: 'https://x.com/a.mp4' }), 'or add videos');
    await assert.rejects(() => od.saveSettings({ productIds: [] }), 'or change who gets access');

    await as(owner);
    assert.equal((await od.adminList()).find((v) => v.id === free.id)!.views, before + 1, 'the view was counted');

    // flag every membership product, then sell this client one: unlocked
    const products = (await s.listProducts()).filter((p) => p.kind !== 'retail');
    const online = products.find((p) => p.name === 'Online membership') ?? products.find((p) => p.kind === 'membership')!;
    await od.saveSettings({ productIds: [online.id] });
    await assert.rejects(() => od.saveSettings({ productIds: ['nope'] }), /no longer exists/);
    await s.checkoutCart({ clientId: (client as { clientId: string }).clientId, items: [{ productId: online.id, qty: 1 }], method: 'cash' });
    await as(client);
    const open2 = await od.list();
    assert.equal(open2.access, true);
    assert.ok(open2.videos.every((v) => !v.locked && v.videoUrl));
    await od.recordView(paid.id);

    // staff: add, publish/unpublish, reorder, delete
    await as(owner);
    const added = await od.save({ title: ' New one ', category: 'Core', durationMin: 12, videoUrl: 'https://vimeo.com/123456789/abcdef1234' });
    assert.equal(added.title, 'New one');
    assert.equal(added.published, false);
    assert.equal((await od.adminList()).at(-1)!.id, added.id, 'added at the end');
    await assert.rejects(() => od.save({ title: '', category: 'Core', durationMin: 12, videoUrl: 'https://vimeo.com/123456789' }), /title/);
    await as(client);
    assert.ok(!(await od.list()).videos.some((v) => v.id === added.id), 'a draft is hidden from clients');
    await as(owner);
    await od.setPublished(added.id, true);
    await as(client);
    assert.ok((await od.list()).videos.some((v) => v.id === added.id));
    await as(owner);
    const ids = (await od.adminList()).map((v) => v.id);
    await od.reorder([...ids].reverse());
    assert.deepEqual((await od.adminList()).map((v) => v.id), [...ids].reverse());
    await assert.rejects(() => od.reorder([ids[0]!]), /doesn't match/);
    await od.remove(added.id);
    assert.equal((await od.adminList()).length, all.length);
  });
}

test('demo: Snowy and Harbour libraries are separate', async () => {
  const a = await open('snowy');
  const b = await open('harbour');
  await a.as(a.personas.find((u) => u.kind === 'staff' && u.role === 'owner')!);
  await b.as(b.personas.find((u) => u.kind === 'staff' && u.role === 'owner')!);
  const sa = (await a.s.features.ondemand!.adminList()).map((v) => v.id);
  const sb = (await b.s.features.ondemand!.adminList()).map((v) => v.id);
  assert.ok(sa.every((id) => !sb.includes(id)));
});

// ---------------------------------------------------------------- online-only (noClasses) products
import { baseState, harness, mkClient, mkSession, asClient, rejects } from './helpers';
import { checkPassForSession, creditLabel, isUnlimited } from '../src/domain/rules';
import type { Product } from '../src/shared/types';

test('online-only: a noClasses pass is never unlimited credit and never pays for a class (rules)', () => {
  const p = pass({ noClasses: true });
  assert.equal(isUnlimited(p), false);
  assert.equal(creditLabel(p, null), 'Online only');
  const e = checkPassForSession({ pass: p, session: { startsAt: '2026-10-20T08:00:00Z', classTypeId: 'ct_mat' }, uses: [], now: new Date('2026-10-15T00:00:00Z') });
  assert.equal(e.eligible, false);
  assert.equal(creditLabel(pass(), null), 'Unlimited', 'a normal unlimited membership still says Unlimited');
});

test('online-only: Snowy\'s seeded Online membership is flagged, and a member holding only it can\'t book and doesn\'t see "Unlimited"', async () => {
  const o = await open('snowy');
  await o.as(o.personas.find((u) => u.kind === 'staff' && u.role === 'owner')!);
  const online = (await o.s.listProducts({ includeInactive: true })).find((p) => p.id === 'pr_online');
  assert.equal(online?.noClasses, true);

  const NOW = new Date('2026-10-19T08:00:00+11:00');
  const online2: Product = { ...online! };
  const h = await harness(baseState({
    clients: [mkClient('a', 'Ava')], products: [online2],
    sessions: [mkSession('mat', '2026-10-21', '09:00')],
  }), NOW);
  await h.give('a', 'pr_online');
  await h.as(asClient('a'));
  const summary = await h.store.getCreditSummary('a');
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.label, 'Online only');
  assert.ok(summary[0]!.pass.noClasses, 'the pass carries the flag, so the timetable pill ignores it (shows "Get a pass")');
  assert.equal((await h.store.getCreditSummary('a', 'mat')).length, 0, 'nothing to book this class with');
  await rejects(h.store.bookClass('a', 'mat'), 'NO_CREDITS');
});
