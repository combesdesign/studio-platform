// Support: the "reply by" business-hours maths (Mon-Fri 9-5 Sydney, 2 business hours), help search, checks, and the demo store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import '../src/features/support/demo';
import { ARTICLES, searchArticles } from '../src/features/support/articles';
import { cleanBanner, cleanBody, cleanScreenshot, inboxOrder } from '../src/features/support/calc';
import { demoDb } from '../src/features/support/demoDb';
import { formatReplyBy, isOpenNow, replyBy } from '../src/features/support/hours';
import { articleAnswer, withAssistContext } from '../src/features/support/assist';
import { HELP_ARTICLES } from '../supabase/functions/_shared/help-articles';
import type { SupportRequest } from '../src/features/support/types';

const TZ = 'Australia/Sydney';
/** Sydney wall clock -> instant, written as the +11 (summer) or +10 (winter) ISO. */
const at = (iso: string) => new Date(iso);
const sydney = (d: Date) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

test('reply by: inside business hours it is two hours on', () => {
  assert.equal(replyBy(at('2026-10-21T10:00+11:00')).toISOString(), at('2026-10-21T12:00+11:00').toISOString(), 'Wed 10:00 -> 12:00');
  assert.equal(replyBy(at('2026-10-21T14:20+11:00')).toISOString(), at('2026-10-21T16:20+11:00').toISOString());
  assert.equal(replyBy(at('2026-10-21T15:00+11:00')).toISOString(), at('2026-10-21T17:00+11:00').toISOString(), 'exactly at close is still today');
});

test('reply by: after 5pm rolls to the next business day', () => {
  assert.equal(replyBy(at('2026-10-21T15:30+11:00')).toISOString(), at('2026-10-22T09:30+11:00').toISOString(), 'Wed 3:30pm -> 1.5h left today, 0.5h tomorrow: Thu 9:30');
  assert.equal(replyBy(at('2026-10-21T17:00+11:00')).toISOString(), at('2026-10-22T11:00+11:00').toISOString(), 'at 5pm sharp the clock starts tomorrow 9am');
  assert.equal(replyBy(at('2026-10-21T19:45+11:00')).toISOString(), at('2026-10-22T11:00+11:00').toISOString(), 'Wed 7:45pm -> Thu 11:00');
  assert.equal(replyBy(at('2026-10-21T02:00+11:00')).toISOString(), at('2026-10-21T11:00+11:00').toISOString(), 'before 9am the same day: 9 + 2 = 11');
});

test('reply by: Friday evening and weekends wait for Monday', () => {
  assert.equal(replyBy(at('2026-10-23T16:00+11:00')).toISOString(), at('2026-10-26T10:00+11:00').toISOString(), 'Fri 4pm -> 1h left, then Mon 10:00');
  assert.equal(replyBy(at('2026-10-23T18:00+11:00')).toISOString(), at('2026-10-26T11:00+11:00').toISOString(), 'Fri 6pm -> Mon 11:00');
  assert.equal(replyBy(at('2026-10-24T10:00+11:00')).toISOString(), at('2026-10-26T11:00+11:00').toISOString(), 'Saturday -> Mon 11:00');
  assert.equal(replyBy(at('2026-10-25T23:30+11:00')).toISOString(), at('2026-10-26T11:00+11:00').toISOString(), 'Sunday night -> Mon 11:00');
});

test('reply by: uses Sydney time whatever the asker\'s clock says, and survives daylight saving', () => {
  // 11pm Wed UTC = 10am Thu in Sydney (+11)
  assert.equal(sydney(replyBy(at('2026-10-21T23:00:00Z'))), sydney(at('2026-10-22T12:00+11:00')));
  // Winter (+10): Friday 4pm Sydney = 06:00Z; Monday 10am
  assert.equal(replyBy(at('2026-07-17T06:00:00Z')).toISOString(), at('2026-07-20T10:00+10:00').toISOString());
  // Across the clocks going forward (Sun 4 Oct 2026, 2am): Fri 4pm -> Mon 10am in the new time
  assert.equal(replyBy(at('2026-10-02T16:00+10:00')).toISOString(), at('2026-10-05T10:00+11:00').toISOString());
  // Perth is on its own clock: 10am Perth Wed (= 1pm Sydney) -> 3pm Sydney
  assert.equal(replyBy(at('2026-10-21T10:00+08:00')).toISOString(), at('2026-10-21T15:00+11:00').toISOString());
});

test('reply by: longer targets, closed days and options', () => {
  assert.equal(replyBy(at('2026-10-21T10:00+11:00'), { hours: 8 }).toISOString(), at('2026-10-22T10:00+11:00').toISOString(), 'a full business day later');
  assert.equal(replyBy(at('2026-10-21T10:00+11:00'), { hours: 0 }).toISOString(), at('2026-10-21T10:00+11:00').toISOString());
  assert.equal(replyBy(at('2026-10-21T16:00+11:00'), { closedDates: ['2026-10-22'] }).toISOString(), at('2026-10-23T10:00+11:00').toISOString(), 'a closed Thursday is skipped');
  assert.equal(isOpenNow(at('2026-10-21T10:00+11:00')), true);
  assert.equal(isOpenNow(at('2026-10-21T17:00+11:00')), false);
  assert.equal(isOpenNow(at('2026-10-24T10:00+11:00')), false);
});

test('reply by: how it reads on screen, in the studio\'s timezone', () => {
  const now = at('2026-10-21T14:20+11:00');
  assert.equal(formatReplyBy(at('2026-10-21T16:20+11:00'), now, TZ), '4:20pm today');
  assert.equal(formatReplyBy(at('2026-10-22T09:30+11:00'), now, TZ), '9:30am tomorrow');
  assert.equal(formatReplyBy(at('2026-10-26T11:00+11:00'), now, TZ), '11:00am Monday');
  assert.equal(formatReplyBy(at('2026-11-03T11:00+11:00'), now, TZ), '11:00am Tue 3 Nov');
  assert.equal(formatReplyBy(at('2026-10-21T16:20+11:00'), now, 'Australia/Perth'), '1:20pm today', 'a Perth studio reads Perth time');
  assert.equal(formatReplyBy(at('2026-10-21T12:00+11:00'), at('2026-10-21T12:00+11:00'), TZ), '12:00pm today');
  assert.equal(formatReplyBy(at('2026-10-21T00:05+11:00'), now, TZ), '12:05am today');
});

test('help search: plain words find the right guide, no categories needed', () => {
  assert.equal(ARTICLES.length, 10);
  const top = (q: string) => searchArticles(q, 3).map((a) => a.slug);
  assert.equal(top('how do I refund a sale')[0], 'refund-a-sale');
  assert.equal(top('a client was charged twice')[0], 'refund-a-sale');
  assert.equal(top('cancelling the 6am class because the teacher is sick')[0], 'cancel-a-class');
  assert.equal(top('add new instructor')[0], 'add-a-staff-member');
  assert.equal(top('extend someone\'s expiry')[0], 'change-a-clients-pass');
  assert.equal(top('kiosk')[0], 'set-up-the-kiosk');
  assert.equal(top('sell voucher')[0], 'sell-a-gift-card');
  assert.equal(top('upload a vimeo video')[0], 'add-an-online-video');
  assert.equal(top('change our logo and colors')[0], 'change-branding');
  assert.equal(top('export wages csv')[0], 'export-payroll');
  assert.equal(top('refnd')[0], 'refund-a-sale', 'one typo is fine');
  assert.deepEqual(top('ab'), [], 'needs a few letters');
  assert.deepEqual(top('my printer is on fire'), [], 'nothing relevant: no suggestions, they just send it');
  assert.ok(searchArticles('class', 3).length <= 3, 'at most 3');
  for (const a of ARTICLES) assert.ok(a.steps.length >= 3 && a.steps.length <= 6, `${a.slug} is short`);
});

test('checks on what is sent', () => {
  assert.equal(cleanBody('  hello  '), 'hello');
  assert.throws(() => cleanBody('   '), /^Error: INVALID/);
  assert.throws(() => cleanBody('x'.repeat(4001)), /INVALID/);
  assert.equal(cleanScreenshot(null), null);
  assert.equal(cleanScreenshot('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA');
  assert.throws(() => cleanScreenshot('data:text/html;base64,AAAA'), /INVALID/);
  assert.throws(() => cleanScreenshot('data:image/png;base64,' + 'A'.repeat(900_000)), /INVALID/);
  assert.equal(cleanBanner('   '), null);
  assert.equal(cleanBanner(' Payments are slow '), 'Payments are slow');
  assert.throws(() => cleanBanner('x'.repeat(201)), /INVALID/);
});

test('inbox order: urgent unresolved first, then newest', () => {
  const r = (id: string, createdAt: string, urgent = false, status: SupportRequest['status'] = 'open') => ({ id, createdAt, urgent, status } as SupportRequest);
  const list = [r('old-urgent', '2026-10-20T01:00Z', true), r('new', '2026-10-21T01:00Z'), r('newest-resolved-urgent', '2026-10-22T01:00Z', true, 'resolved'), r('mid', '2026-10-20T12:00Z')];
  assert.deepEqual(inboxOrder(list).map((x) => x.id), ['old-urgent', 'newest-resolved-urgent', 'new', 'mid']);
});

test('demo store: staff send and follow up, the admin side sees every studio, instant promise numbers', async () => {
  demoDb.reset();
  const NOW = new Date('2026-10-21T01:30:00Z'); // Wed 12:30pm Sydney
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const snowy = p.forStudio((await p.findStudio({ slug: 'snowy' }))!);
  const harbour = p.forStudio((await p.findStudio({ slug: 'harbour' }))!);
  const login = async (s: typeof snowy, role: string) => { const u = (await s.demoPersonas!()).find((x) => x.kind === 'staff' && x.role === role)!; await s.demoSignInAs!(u); };
  await login(snowy, 'front_desk');
  const sup = snowy.features.support!;
  assert.ok(sup, 'support registered');
  const before = (await sup.listMine()).length;
  const normal = await sup.send({ body: '  How do I move a class?  ', urgent: false, screenshot: null, context: { route: '#/schedule', appVersion: '0.1.0', userAgent: 'Test' }, replyBy: replyBy(NOW).toISOString() });
  assert.equal(normal.body, 'How do I move a class?');
  assert.equal(normal.status, 'open');
  assert.equal(normal.replyBy, at('2026-10-21T14:30+11:00').toISOString());
  assert.equal(normal.context.route, '#/schedule');
  assert.equal(normal.messages.length, 1);
  const urgent = await sup.send({ body: 'Nobody can pay', urgent: true, context: { route: '#/pos', appVersion: '0.1.0', userAgent: 'Test' }, replyBy: replyBy(NOW).toISOString() });
  assert.equal(urgent.replyBy, null, 'urgent has no reply-by: "on it now"');
  await assert.rejects(() => sup.send({ body: '   ', urgent: false, context: { route: '', appVersion: '', userAgent: '' }, replyBy: null }), /INVALID|Tell us/);
  assert.equal((await sup.listMine()).length, before + 2);

  // the admin sees both studios' requests, replies, and the studio sees the reply
  const { supportAdmin } = await import('../src/features/support/admin/store');
  const admin = supportAdmin();
  const all = await admin.list();
  assert.ok(all.some((r) => r.studioName !== normal.studioName), 'admin sees more than one studio');
  assert.ok(all.some((r) => r.id === urgent.id && r.urgent));
  const replied = await admin.reply(normal.id, 'Drag it on the schedule.');
  assert.equal(replied.status, 'waiting');
  const mine = (await sup.listMine()).find((r) => r.id === normal.id)!;
  assert.equal(mine.messages.at(-1)!.from, 'platform');
  const back = await sup.follow(normal.id, 'Thanks!');
  assert.equal(back.status, 'open', 'a follow-up re-opens it');
  assert.equal((await admin.setStatus(normal.id, 'resolved')).status, 'resolved');

  // a banner set by the admin shows in the studio apps (both)
  assert.equal(await sup.banner(), null);
  await admin.setBanner('Payments are slow right now, we\'re on it', 'warn');
  assert.equal((await sup.banner())?.message, 'Payments are slow right now, we\'re on it');
  await login(harbour, 'owner');
  assert.equal((await harbour.features.support!.banner())?.tone, 'warn');
  await admin.setBanner(null);
  assert.equal(await sup.banner(), null);

  // another studio's staff can't follow up on Snowy's thread
  await assert.rejects(() => harbour.features.support!.follow(normal.id, 'hi'), /find that request/);
  assert.ok(!(await harbour.features.support!.listMine()).some((r) => r.studioId === normal.studioId), 'Harbour never lists Snowy requests');
  demoDb.reset();
});

test('the edge function\'s copy of the help articles matches the app (regenerate: node --import tsx scripts/sync-help-articles.mts)', () => {
  const want = ARTICLES.map(({ slug, title, summary, steps, tip }) => ({ slug, title, summary, steps, ...(tip ? { tip } : {}) }));
  assert.deepEqual(HELP_ARTICLES, want);
});

test('help assistant without AI: first steps of the best article plus a link; a person when nothing fits', async () => {
  const a = articleAnswer('how do I cancel a class');
  assert.match(a.answer, /^1\. /m);
  assert.equal(a.link?.href, '#/help/cancel-a-class');
  assert.equal(a.suggestHuman, false);
  assert.ok(a.answer.split('\n').filter((l) => /^\d\. /.test(l)).length <= 3);
  const none = articleAnswer('zzzz qqqq');
  assert.equal(none.suggestHuman, true);
  assert.equal(none.link, undefined);

  demoDb.reset();
  const p = createDemoPlatform({ now: () => new Date('2026-10-21T01:30:00Z'), latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const snowy = p.forStudio((await p.findStudio({ slug: 'snowy' }))!);
  const u = (await snowy.demoPersonas!()).find((x) => x.kind === 'staff' && x.role === 'front_desk')!; await snowy.demoSignInAs!(u);
  assert.equal((await snowy.features.support!.assist({ question: 'how do I refund a sale', page: '#/pos' })).link?.href, '#/help/refund-a-sale');
});

test('sending on after an answer attaches what was suggested', () => {
  const ans = { answer: '1. Open Schedule.', suggestHuman: false };
  assert.equal(withAssistContext('Still stuck', null), 'Still stuck');
  assert.match(withAssistContext('Still stuck', ans), /^Still stuck\n\n---\nThe help assistant suggested:\n1\. Open Schedule\.$/);
  const long = 'x'.repeat(3990);
  assert.equal(withAssistContext(long, ans), long, 'never pushes a message over the limit');
});
