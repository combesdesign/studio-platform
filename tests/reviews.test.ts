// Reviews and NPS: the maths, and the demo store for both demo studios (prompt once, dismiss, who sees what, Google link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { averageBy, cleanGoogleUrl, cleanReview, npsOf, overall } from '../src/features/reviews/calc';
import type { ReviewEntry } from '../src/features/reviews/types';

const e = (over: Partial<ReviewEntry>): ReviewEntry => ({
  id: 'r' + Math.random(), bookingId: 'b', sessionId: 's', classTypeId: 'mat', instructorId: 'julia', clientFirstName: 'Ann',
  rating: 5, nps: 10, comment: null, createdAt: '2026-10-14T00:00:00.000Z', ...over,
});

test('NPS: promoters (9-10) minus detractors (0-6), passives (7-8) only count in the base', () => {
  assert.equal(npsOf([]).score, null);
  assert.equal(npsOf([e({ nps: null })]).score, null, 'a review without a 0-10 answer is not part of NPS');
  const n = npsOf([e({ nps: 10 }), e({ nps: 9 }), e({ nps: 9 }), e({ nps: 8 }), e({ nps: 7 }), e({ nps: 6 }), e({ nps: 0 }), e({ nps: null })]);
  assert.deepEqual([n.promoters, n.passives, n.detractors, n.answers], [3, 2, 2, 7]);
  assert.equal(n.score, Math.round(((3 - 2) / 7) * 100));
  assert.equal(npsOf([e({ nps: 3 }), e({ nps: 5 })]).score, -100);
  assert.equal(npsOf([e({ nps: 9 })]).score, 100);
});

test('averages per class type and per instructor, best first, rounded to one decimal', () => {
  const list = [e({ rating: 5 }), e({ rating: 4 }), e({ rating: 4, classTypeId: 'mums', instructorId: 'grace' }), e({ rating: 3, classTypeId: 'mums', instructorId: 'grace' }), e({ rating: 5, classTypeId: 'mums', instructorId: 'grace' })];
  assert.deepEqual(averageBy(list, (x) => x.classTypeId), [{ id: 'mat', count: 2, avg: 4.5 }, { id: 'mums', count: 3, avg: 4 }]);
  assert.deepEqual(averageBy(list, (x) => x.instructorId).map((s) => s.id), ['julia', 'grace']);
  assert.deepEqual(overall(list), { count: 5, avg: 4.2 });
  assert.deepEqual(overall([]), { count: 0, avg: null });
});

test('checks: 1-5 flowers, 0-10 score, comment length, web addresses only', () => {
  assert.deepEqual(cleanReview({ rating: 4, nps: 9, comment: '  Lovely  ' }), { rating: 4, nps: 9, comment: 'Lovely' });
  assert.deepEqual(cleanReview({ rating: 1 }), { rating: 1, nps: null, comment: null });
  for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: 3, nps: 11 }, { rating: 3, nps: -1 }, { rating: 3, comment: 'x'.repeat(1001) }]) assert.throws(() => cleanReview(bad), /^Error: INVALID/);
  assert.equal(cleanGoogleUrl(''), '');
  assert.equal(cleanGoogleUrl(' https://g.page/r/abc/review '), 'https://g.page/r/abc/review');
  assert.throws(() => cleanGoogleUrl('javascript:alert(1)'), /INVALID/);
  assert.throws(() => cleanGoogleUrl('not a url'), /INVALID/);
});

async function open(slug: string) {
  const NOW = new Date('2026-10-15T01:30:00Z');
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const s = p.forStudio((await p.findStudio({ slug }))!);
  const personas = await s.demoPersonas();
  return { s, personas, as: (u: (typeof personas)[number]) => s.demoSignInAs!(u) };
}

for (const slug of ['snowy', 'harbour']) {
  test(`demo (${slug}): seeded reviews; a client is asked once per class, can answer or dismiss; staff see by role`, async () => {
    const { s, personas, as } = await open(slug);
    const owner = personas.find((u) => u.kind === 'staff' && u.role === 'owner')!;
    await as(owner);
    const rv = s.features.reviews!;
    assert.ok(rv, 'reviews registered');
    const all = await rv.list();
    assert.ok(all.length > 5, 'seeded reviews');
    assert.ok(all.every((x) => x.rating >= 1 && x.rating <= 5));
    assert.ok(!('clientId' in all[0]!), 'client ids are not sent to the screen');

    // a client with a class waiting for a rating
    const clients = personas.filter((x) => x.kind === 'client');
    const waiting: typeof personas = [];
    for (const u of clients) { await as(u); if (await rv.pendingPrompt()) waiting.push(u); }
    assert.ok(waiting.length >= (slug === 'snowy' ? 2 : 1), 'someone has a "How was…?" card');
    await as(waiting[0]!);
    const prompt = (await rv.pendingPrompt())!;
    assert.ok(prompt.className && prompt.instructorName);
    await assert.rejects(() => rv.submit(prompt.bookingId, { rating: 7 }), /1 to 5/);
    await assert.rejects(() => rv.list(), 'clients can\'t read reviews');
    await assert.rejects(() => rv.saveSettings({ googleReviewUrl: 'https://example.com' }));
    assert.deepEqual(await rv.submit(prompt.bookingId, { rating: 5, nps: 10, comment: 'Great' }), {}, 'no Google link saved yet');
    await assert.rejects(() => rv.submit(prompt.bookingId, { rating: 4 }), /already answered/);
    const next = await rv.pendingPrompt();
    assert.notEqual(next?.bookingId, prompt.bookingId, 'never asked twice about the same booking');
    if (next) { await rv.dismiss(next.bookingId); assert.notEqual((await rv.pendingPrompt())?.bookingId, next.bookingId, 'dismissed stays dismissed'); }

    // owner: sees it, sets the Google link; a 9-10 then gets it, an 8 doesn't
    await as(owner);
    assert.equal((await rv.list()).length, all.length + 1);
    assert.equal((await rv.getSettings()).googleReviewUrl, '');
    await assert.rejects(() => rv.saveSettings({ googleReviewUrl: 'javascript:alert(1)' }), /web address/);
    await rv.saveSettings({ googleReviewUrl: 'https://g.page/r/test/review' });
    if (waiting[1]) {
      await as(waiting[1]);
      const second = (await rv.pendingPrompt())!;
      assert.deepEqual(await rv.submit(second.bookingId, { rating: 5, nps: 9 }), { googleUrl: 'https://g.page/r/test/review' }, 'a 9 or 10 is sent to Google when the link is set');
    }
    if (waiting[2]) {
      await as(waiting[2]);
      const third = (await rv.pendingPrompt())!;
      assert.deepEqual(await rv.submit(third.bookingId, { rating: 4, nps: 8 }), {}, 'an 8 isn\'t');
    }

    // instructors see only their own classes; front desk sees none
    await as(owner);
    const everything = await rv.list();
    const instructor = personas.find((u) => u.kind === 'staff' && u.role === 'instructor' && everything.some((x) => x.instructorId === u.staffId))!;
    await as(instructor);
    const mine = await rv.list();
    assert.ok(mine.length > 0 && mine.length < everything.length, 'an instructor sees a part of them');
    assert.ok(mine.every((x) => x.instructorId === (instructor as { staffId: string }).staffId));
    await assert.rejects(() => rv.saveSettings({ googleReviewUrl: '' }), 'instructors can\'t change the setting');
    const desk = personas.find((u) => u.kind === 'staff' && u.role === 'front_desk');
    if (desk) { await as(desk); await assert.rejects(() => rv.list(), 'front desk has no reviews'); }
  });
}

test('demo: each studio keeps its own reviews and settings', async () => {
  const a = await open('snowy'), b = await open('harbour');
  await a.as(a.personas.find((u) => u.kind === 'staff' && u.role === 'owner')!);
  await b.as(b.personas.find((u) => u.kind === 'staff' && u.role === 'owner')!);
  const sa = await a.s.features.reviews!.list(), sb = await b.s.features.reviews!.list();
  assert.ok(sa.length > 0 && sb.length > 0);
  assert.equal(sa.filter((x) => sb.some((y) => y.bookingId === x.bookingId)).length, 0, 'no review is in both');
  await a.s.features.reviews!.saveSettings({ googleReviewUrl: 'https://g.page/r/snowy' });
  assert.notEqual((await b.s.features.reviews!.getSettings()).googleReviewUrl, 'https://g.page/r/snowy');
});
