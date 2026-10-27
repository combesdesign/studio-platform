// Libby's feedback, round two (27 Oct): client emails (missing ones + editable wording), the intro check-in and Google review
// automations, Send a text, and Snowy's real product names and prices. Demo store; the SQL and edge function sides are in
// supabase/tests/libby2_*.sql and functions.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMAIL_DEFS, mergeEmailText, renderClassEmail, samplePayload, emailVars } from '../src/domain/emails';
import { automationHit, buildAudience } from '../src/features/marketing/segments';
import '../src/features/demo';
import { PRODUCTS } from '../src/data/demo/fixtures';
import { at, asClient, baseState, harness, JULIA, mkClient, mkSession, OWNER, rejects } from './helpers';
import type { DemoState } from '../src/data/demo/engine';
import type { AuthUser, Booking, Pass } from '../src/shared/types';
import type { MarketingStore } from '../src/features/marketing/types';
import type { ReviewsStore } from '../src/features/reviews/types';

const NOW = at('2026-10-27', '08:00'); // Tuesday
const DAY = 86_400_000;
const FRONT: AuthUser = { kind: 'staff', staffId: 'st_gracep', email: 'grace.p@snowypilatesclub.com', name: 'Grace P', role: 'front_desk' };

function twoClients() {
  return baseState({
    clients: [mkClient('ann', 'Ann'), mkClient('bea', 'Bea'), mkClient('cat', 'Cat', { marketingOptIn: true, phone: '0412 345 678' })],
    sessions: [mkSession('one', '2026-10-28', '09:00', { capacity: 1 }), mkSession('late', '2026-10-27', '10:00')],
  });
}
const sent = (h: { outbox(): { kind: string }[] }) => h.outbox().map((o) => o.kind);

test('the edge function copies of the shared files match the source (edit src, then cp)', () => {
  const same = (a: string, b: string) => assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'), `${b} is out of date, copy ${a} over it`);
  same('src/domain/emails.ts', 'supabase/functions/_shared/emails.ts');
  same('src/features/marketing/render.ts', 'supabase/functions/_shared/marketing-render.ts');
});

// ---------------------------------------------------------------- the emails: wording, merge tags, defaults
test('every editable email has default wording, and merge tags (single or double braces) fill in; unknown tags vanish', () => {
  assert.deepEqual(EMAIL_DEFS.map((d) => d.kind), ['booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome']);
  const p = samplePayload('Snowy Pilates Club');
  assert.equal(mergeEmailText('Hi {first_name}, {{class_name}} at {class_time} with {instructor} {nope}!', emailVars(p)), 'Hi Hannah, Mat Essentials at 6:00am Tue 28 Oct with Julia !');
  for (const d of EMAIL_DEFS) {
    const r = renderClassEmail(d.kind, p)!;
    assert.ok(r.subject && r.html.includes('Snowy Pilates Club') && r.text.startsWith('Hi Hannah,'), d.kind);
    assert.ok(!/\{[a-z_]+\}/.test(r.subject + r.html + r.text), `${d.kind} left a tag unfilled`);
  }
  assert.equal(renderClassEmail('booking_confirmed', p)!.subject, 'You\'re booked: Mat Essentials, 6:00am Tue 28 Oct');
  assert.equal(renderClassEmail('waitlist_promoted', p)!.subject, 'A spot opened up: Mat Essentials, 6:00am Tue 28 Oct');
  assert.equal(renderClassEmail('class_reminder', p)!.subject, 'See you soon: Mat Essentials at 6:00am');
  assert.match(renderClassEmail('class_cancelled', p)!.html, /Sorry, we’ve had to cancel this class \(our instructor is unwell\)\. Any credit you used is back on your pass\./);
  assert.equal(renderClassEmail('nonsense', p), null);
});

test('your own wording replaces subject and intro, is escaped, and is used in the studio\'s colours', () => {
  const p = { ...samplePayload('Harbour Reformer Co.'), brand: { primary: '#1F5F4A', ink: '#10281F', soft: '#E4EFEA', bg: '#F4EFE6' } };
  const r = renderClassEmail('booking_confirmed', p, { subject: 'See you, {first_name}!', intro: 'We saved you a spot in {class_name} <b>x</b>.\n\nBring water.' })!;
  assert.equal(r.subject, 'See you, Hannah!');
  assert.match(r.html, /<p>We saved you a spot in Mat Essentials &lt;b&gt;x&lt;\/b&gt;\.<\/p><p>Bring water\.<\/p>/);
  assert.ok(r.html.includes('#1F5F4A') && r.html.includes('#E4EFEA') && !r.html.includes('See you on the mat'));
  // blank wording falls back to the default
  assert.equal(renderClassEmail('booking_confirmed', p, { subject: '  ', intro: '' })!.subject, 'You\'re booked: Mat Essentials, 6:00am Tue 28 Oct');
  // late cancel wording
  const late = renderClassEmail('booking_cancelled', { ...p, late: true, credit_returned: false })!;
  assert.match(late.html, /inside the cancellation window, so the credit isn’t returned/);
  assert.match(renderClassEmail('booking_cancelled', { ...p, late: false, credit_returned: true })!.html, /Your credit is back on your pass/);
  assert.doesNotMatch(renderClassEmail('booking_cancelled', { ...p, late: false, credit_returned: false })!.html, /credit/);
});

// ---------------------------------------------------------------- the emails fire in the demo
test('demo: booking confirmed, waitlist joined, booking cancelled (late too), waitlist promoted and class cancelled all send', async () => {
  const s = twoClients();
  const h = await harness(s, NOW);
  await h.give('ann', 'pr_p4'); await h.give('bea', 'pr_p4'); await h.give('cat', 'pr_p4');
  await h.as(asClient('ann'));
  const annRes = await h.store.bookClass('ann', 'one');
  await h.as(asClient('bea'));
  const w = await h.store.bookClass('bea', 'one');
  assert.equal(w.outcome, 'waitlisted');
  assert.deepEqual(sent(h), ['booking_confirmed', 'waitlist_joined']);
  assert.match(h.outbox()[1]!.subject!, /^You're on the waitlist: Mat Essentials, /);
  // Ann cancels in time: her booking cancelled email says the credit is back; Bea is promoted
  await h.as(asClient('ann'));
  await h.store.cancelBooking(annRes.booking.id);
  assert.deepEqual(sent(h).slice(2), ['booking_cancelled', 'waitlist_promoted']);
  assert.match(h.outbox()[2]!.text, /Your credit is back on your pass/);
  assert.equal(h.outbox()[2]!.clientId, 'ann');
  assert.equal(h.outbox()[3]!.clientId, 'bea');
  // a late cancel (inside 3 hours) gets the late wording
  await h.as(OWNER);
  const catBooking = await h.store.bookClass('cat', 'late', { asStaff: true });
  h.setNow(at('2026-10-27', '08:30'));      // an hour and a half before the 10:00 class
  const before = h.outbox().length;
  await h.as(asClient('cat'));
  await h.store.cancelBooking(catBooking.booking.id);
  assert.equal(h.outbox().length, before + 1);
  assert.equal(h.outbox().at(-1)!.kind, 'booking_cancelled');
  assert.match(h.outbox().at(-1)!.text, /inside the cancellation window/);
  // staff cancelling for a client does not send the "you cancelled" email
  await h.as(OWNER);
  const n = h.outbox().length;
  await h.store.cancelBooking(w.booking.id, { asStaff: true });
  assert.equal(h.outbox().length, n, 'only the client\'s own cancellation sends it');
  // the studio cancels a class: everyone booked gets the cancelled email with the reason
  await h.store.bookClass('ann', 'one', { asStaff: true });
  const m = h.outbox().length;
  await h.store.cancelSession('one', 'Instructor unwell');
  assert.equal(h.outbox().length, m + 1);
  assert.equal(h.outbox().at(-1)!.kind, 'class_cancelled');
  assert.match(h.outbox().at(-1)!.text, /\(Instructor unwell\)/);
});

test('demo: Settings > Emails switches an email off, changes its wording, and only owner and manager can', async () => {
  const s = twoClients();
  const h = await harness(s, NOW);
  await h.give('ann', 'pr_p4');
  assert.deepEqual(await h.store.listEmailTemplates(), []);
  const row = await h.store.saveEmailTemplate('booking_confirmed', { subject: 'You\'re in, {first_name}!', intro: 'See you at {class_time}.' });
  assert.equal(row.subject, 'You\'re in, {first_name}!');
  await h.as(asClient('ann'));
  await h.store.bookClass('ann', 'one');
  assert.equal(h.outbox().at(-1)!.subject, 'You\'re in, Ann!');
  assert.match(h.outbox().at(-1)!.text, /See you at \d{1,2}:\d\d[ap]m \w{3} \d+ \w{3}\./);
  await h.as(OWNER);
  await h.store.saveEmailTemplate('waitlist_joined', { enabled: false });
  assert.equal((await h.store.listEmailTemplates()).find((r) => r.kind === 'waitlist_joined')?.enabled, false);
  await h.as(asClient('bea')); await h.give('bea', 'pr_p4'); await h.as(asClient('bea'));
  const before = h.outbox().length;
  assert.equal((await h.store.bookClass('bea', 'one')).outcome, 'waitlisted');
  assert.equal(h.outbox().length, before, 'switched off: no waitlist email');
  // back to standard wording removes the row
  await h.as(OWNER);
  await h.store.saveEmailTemplate('booking_confirmed', { subject: '', intro: null });
  assert.equal((await h.store.listEmailTemplates()).some((r) => r.kind === 'booking_confirmed'), false);
  await rejects(h.store.saveEmailTemplate('nope', { enabled: false }), 'NOT_FOUND');
  await rejects(h.store.saveEmailTemplate('welcome', { subject: 'x'.repeat(151) }), 'INVALID');
  // "Send me a test" goes to the signed-in staff member, whatever the switch says
  const t = await h.store.sendTestEmail('waitlist_joined');
  assert.equal(t.to, 'libby@snowypilatesclub.com');
  assert.match(h.outbox().at(-1)!.subject!, /^\[Test\] /);
  // front desk, instructors and clients can't see or change them
  for (const who of [FRONT, JULIA, asClient('ann')]) {
    await h.as(who);
    await rejects(h.store.listEmailTemplates(), 'NOT_ALLOWED');
    await rejects(h.store.saveEmailTemplate('welcome', { enabled: false }), 'NOT_ALLOWED');
    await rejects(h.store.sendTestEmail('welcome'), 'NOT_ALLOWED');
  }
});

test('demo: the welcome email goes to a new sign-up unless the Welcome automation will send it', async () => {
  const s = twoClients();
  const h = await harness(s, NOW);
  await h.store.signOut();
  // marketing never opened (no slice): the studio's welcome goes, opted in or not
  await h.store.signUpClient({ firstName: 'Dee', lastName: 'New', email: 'dee@example.com', password: 'secret1', marketingOptIn: true });
  assert.equal(h.outbox().filter((o) => o.kind === 'welcome').length, 1);
  assert.equal(h.outbox().at(-1)!.subject, 'Welcome to Snowy Pilates Club');
  // the automation is on (marketing opened): opted in = the automation owns it, no second email; not opted in = the studio's welcome
  const marketing = h.store.features.marketing as MarketingStore;
  await h.as(OWNER);
  assert.ok((await marketing.listAutomations()).find((a) => a.key === 'welcome')!.enabled);
  await h.store.signOut();
  await h.store.signUpClient({ firstName: 'Eve', lastName: 'New', email: 'eve@example.com', password: 'secret1', marketingOptIn: true });
  assert.equal(h.outbox().filter((o) => o.kind === 'welcome').length, 1, 'opted in: left to the automation');
  await h.store.signOut();
  await h.store.signUpClient({ firstName: 'Fay', lastName: 'New', email: 'fay@example.com', password: 'secret1', marketingOptIn: false });
  assert.equal(h.outbox().filter((o) => o.kind === 'welcome').length, 2, 'not opted in: the studio welcome');
  // and the automation does send a warm, studio-named email to Eve
  await h.as(OWNER);
  const plan = await marketing.runAutomations({ dryRun: true });
  const welcome = plan.items.filter((i) => i.key === 'welcome');
  assert.deepEqual(welcome.map((i) => i.clientName), ['Eve New']);
  assert.equal(welcome[0]!.subject, 'Welcome to Snowy Pilates Club');
  // switching the automation off hands the welcome back to the transactional email
  await marketing.saveAutomation({ key: 'welcome', enabled: false });
  await h.store.signOut();
  await h.store.signUpClient({ firstName: 'Gus', lastName: 'New', email: 'gus@example.com', password: 'secret1', marketingOptIn: true });
  assert.equal(h.outbox().filter((o) => o.kind === 'welcome').length, 3);
});

// ---------------------------------------------------------------- intro offer check-in
function member(over: Partial<Parameters<typeof buildAudience>[0]['clients'][number]> = {}, pass: Partial<Pass> = {}, visits: string[] = [], now = NOW) {
  const c = mkClient('ivy', 'Ivy', { marketingOptIn: true, ...over });
  const intro: Pass = {
    id: 'pa1', clientId: 'ivy', productId: 'pr_intro', kind: 'intro', name: 'Intro offer', status: 'active', purchasedAt: new Date(now.getTime() - 9 * DAY).toISOString(),
    activatedAt: new Date(now.getTime() - 7 * DAY).toISOString(), expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(), credits: null, creditsUsed: 0, priceCents: 4900, ...pass,
  };
  return buildAudience({ now, clients: [c], passes: [intro], visits: visits.map((v) => ({ clientId: 'ivy', at: v })), tags: {} })[0]!;
}

test('intro check-in: N days into the offer (default 7 of 14), once, only while the offer is running', () => {
  assert.ok(automationHit('intro_checkin', 7, member(), NOW), 'day 7 of a 14 day offer is the middle');
  assert.equal(automationHit('intro_checkin', 7, member(), NOW)!.key, 'intro_checkin:ivy:pa1');
  assert.equal(automationHit('intro_checkin', 9, member(), NOW), null, 'not yet day 9');
  assert.ok(automationHit('intro_checkin', 3, member(), NOW), 'a few days late still catches up inside the 7 day window');
  assert.equal(automationHit('intro_checkin', 7, member({}, { activatedAt: new Date(NOW.getTime() - 20 * DAY).toISOString(), expiresAt: new Date(NOW.getTime() - 6 * DAY).toISOString(), status: 'expired' }), NOW), null, 'the offer has ended');
  assert.equal(automationHit('intro_checkin', 7, member({}, { activatedAt: undefined, expiresAt: undefined }), NOW), null, 'not started counting yet (no booking)');
});

test('intro check-in and the welcome are both on by default for Snowy\'s demo, and "Who\'s next" shows them once', async () => {
  const s = baseState({
    clients: [mkClient('ivy', 'Ivy', { marketingOptIn: true, createdAt: new Date(NOW.getTime() - 9 * DAY).toISOString() }), mkClient('new', 'Newbie', { marketingOptIn: true, createdAt: NOW.toISOString() })],
    passes: [{ id: 'pa1', clientId: 'ivy', productId: 'pr_intro', kind: 'intro', name: 'Intro offer, 2 weeks unlimited', status: 'active', purchasedAt: new Date(NOW.getTime() - 9 * DAY).toISOString(),
      activatedAt: new Date(NOW.getTime() - 7 * DAY).toISOString(), expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(), credits: null, creditsUsed: 0, priceCents: 4900 }],
  });
  const h = await harness(s, NOW);
  const m = h.store.features.marketing as MarketingStore;
  const list = await m.listAutomations();
  const keys = list.map((a) => a.key);
  assert.ok(keys.includes('welcome') && keys.includes('intro_checkin') && keys.includes('review_ask'));
  assert.ok(list.find((a) => a.key === 'welcome')!.enabled && list.find((a) => a.key === 'intro_checkin')!.enabled, 'both on');
  const cin = list.find((a) => a.key === 'intro_checkin')!;
  assert.equal(cin.delay, 7);
  assert.match(cin.body, /How are you finding it/);
  assert.match(cin.body, /here’s what to book next/);
  const plan = await m.runAutomations({ dryRun: false });
  assert.deepEqual(plan.items.filter((i) => i.key === 'intro_checkin').map((i) => i.clientName), ['Ivy Test']);
  assert.deepEqual(plan.items.filter((i) => i.key === 'welcome').map((i) => i.clientName), ['Newbie Test']);
  assert.equal((await m.runAutomations({ dryRun: false })).items.length, 0, 'each person gets each message once');
  // editable
  await m.saveAutomation({ key: 'intro_checkin', delay: 5, body: 'Hi {{first_name}}, how is it going?' });
  const after = (await m.listAutomations()).find((a) => a.key === 'intro_checkin')!;
  assert.equal(after.delay, 5); assert.match(after.body, /how is it going/);
  await rejects(m.saveAutomation({ key: 'intro_checkin', delay: 30 }), 'INVALID');
});

// ---------------------------------------------------------------- Google review every N classes
const visitsAt = (n: number, endDaysAgo: number) => Array.from({ length: n }, (_, i) => new Date(NOW.getTime() - (endDaysAgo + (n - 1 - i) * 3) * DAY).toISOString());

test('review ask: after the Nth, 2Nth ... class; not before; once per 60 days; never after a click; only when switched on', () => {
  const rv = { every: 5, url: 'https://g.page/r/abc/review' };
  const five = member({}, {}, visitsAt(5, 1));
  const hit = automationHit('review_ask', 0, five, NOW, { review: rv });
  assert.equal(hit?.key, 'review_ask:ivy:5');
  assert.equal(hit?.vars.review_url, rv.url);
  assert.equal(hit?.vars.class_count, '5');
  assert.equal(automationHit('review_ask', 0, five, NOW, { review: null }), null, 'off');
  assert.equal(automationHit('review_ask', 0, member({}, {}, visitsAt(4, 1)), NOW, { review: rv }), null, 'only 4 classes');
  assert.equal(automationHit('review_ask', 0, member({}, {}, visitsAt(8, 1)), NOW, { review: rv }), null, 'the 5th was 10 days ago; the 6th to 8th are not milestones');
  assert.equal(automationHit('review_ask', 0, member({}, {}, visitsAt(10, 1)), NOW, { review: rv })?.key, 'review_ask:ivy:10', '2N');
  assert.equal(automationHit('review_ask', 0, member({}, {}, visitsAt(5, 12)), NOW, { review: rv }), null, 'the 7 day catch-up window has passed');
  assert.equal(automationHit('review_ask', 0, member({}, {}, [new Date(NOW.getTime() - 3_600_000).toISOString(), ...visitsAt(4, 3)]), NOW, { review: rv }), null, 'wait a few hours after the class');
  const log = (daysAgo: number, clicked = false) => ({ clientId: 'ivy', at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), ...(clicked ? { clickedAt: new Date(NOW.getTime() - daysAgo * DAY + 60_000).toISOString() } : {}) });
  assert.equal(automationHit('review_ask', 0, five, NOW, { review: rv, reviewLog: [log(30)] }), null, 'asked 30 days ago: wait');
  assert.equal(automationHit('review_ask', 0, five, NOW, { review: rv, reviewLog: [log(61)] })?.key, 'review_ask:ivy:5', '61 days is fine');
  assert.equal(automationHit('review_ask', 0, five, NOW, { review: rv, reviewLog: [log(200, true)] }), null, 'clicked once: never again');
});

test('review ask end to end in the demo: settings, the email goes once to an opted-in client, and not again', async () => {
  const dates = visitsAt(5, 1);
  const s = baseState({
    clients: [mkClient('ann', 'Ann', { marketingOptIn: true }), mkClient('bea', 'Bea', { marketingOptIn: false })],
    sessions: dates.map((d, i) => ({ ...mkSession(`s${i}`, d.slice(0, 10), '09:00'), startsAt: d, endsAt: new Date(Date.parse(d) + 55 * 60_000).toISOString() })),
  });
  s.bookings = (['ann', 'bea'] as const).flatMap((c) => dates.map((d, i): Booking => ({ id: `${c}${i}`, sessionId: `s${i}`, clientId: c, status: 'checked_in', createdAt: d, checkedInAt: d, source: 'staff' }) as Booking));
  const h = await harness(s, NOW);
  const m = h.store.features.marketing as MarketingStore;
  const r = h.store.features.reviews as ReviewsStore;
  assert.equal((await m.runAutomations({ dryRun: true })).items.filter((i) => i.key === 'review_ask').length, 0, 'off until the studio turns it on');
  await rejects(r.saveSettings({ googleAskEnabled: true }), 'INVALID');   // needs the link first
  await rejects(r.saveSettings({ googleReviewUrl: 'https://g.page/r/abc/review', googleAskEvery: 0 }), 'INVALID');
  const saved = await r.saveSettings({ googleReviewUrl: 'https://g.page/r/abc/review', googleAskEnabled: true, googleAskEvery: 5 });
  assert.deepEqual([saved.googleAskEnabled, saved.googleAskEvery], [true, 5]);
  const plan = await m.runAutomations({ dryRun: false });
  const asks = plan.items.filter((i) => i.key === 'review_ask');
  assert.deepEqual(asks.map((i) => i.clientName), ['Ann Test'], 'Bea did not opt in to marketing');
  assert.match(asks[0]!.preview, /5 classes/);
  assert.equal((await m.runAutomations({ dryRun: false })).items.filter((i) => i.key === 'review_ask').length, 0, 'not twice');
  assert.equal((await r.saveSettings({ googleReviewUrl: '' })).googleAskEnabled, false, 'no link, no ask');
  await h.as(FRONT);
  await rejects(r.saveSettings({ googleAskEvery: 3 }), 'NOT_ALLOWED');
});

// ---------------------------------------------------------------- Send a text
test('send a text: owner, manager and front desk; needs a phone number; 480 characters; logged in the history as a text', async () => {
  const s = twoClients();
  const h = await harness(s, NOW);
  const m = h.store.features.marketing as MarketingStore;
  const sentMsg = await m.sendText('cat', 'Hi Cat, your class moved to 10:30.');
  assert.equal(sentMsg.channel, 'sms');
  assert.equal(sentMsg.from, 'staff');
  const thread = await m.getThread('cat');
  assert.deepEqual(thread.messages.map((x) => [x.channel, x.body]), [['sms', 'Hi Cat, your class moved to 10:30.']]);
  assert.equal(thread.thread?.unread, 0);
  await rejects(m.sendText('ann', 'Hello'), 'NO_PHONE');
  await rejects(m.sendText('cat', '   '), 'INVALID');
  await rejects(m.sendText('cat', 'x'.repeat(481)), 'INVALID');
  await m.sendText('cat', 'x'.repeat(480));
  await h.as(FRONT);
  assert.equal((await m.sendText('cat', 'Front desk here')).channel, 'sms');
  await h.as(JULIA);
  await rejects(m.sendText('cat', 'Nope'), 'NOT_ALLOWED');
  await h.as(asClient('cat'));
  await rejects(m.sendText('cat', 'Nope'), 'NOT_ALLOWED');
});

// ---------------------------------------------------------------- Snowy's real prices
test('Snowy\'s product list matches Libby\'s price list', () => {
  const by = (id: string) => PRODUCTS.find((p) => p.id === id)!;
  const rows = [
    ['pr_intro', 'Intro offer, 2 weeks unlimited', 4900, 14], ['pr_m1', '1 Class Per Week Membership', 2200, null], ['pr_m2', '2 Classes Per Week Membership', 4000, null],
    ['pr_m3', '3 Classes Per Week Membership', 5500, null], ['pr_mu', 'Unlimited Membership', 6900, null], ['pr_p4', '4 class pack', 10000, 61],
    ['pr_p8', '8 class pack', 19000, 122], ['pr_drop', 'Single class', 3000, 61],
  ] as const;
  for (const [id, name, cents, days] of rows) {
    assert.deepEqual([by(id).name, by(id).priceCents, by(id).validityDays], [name, cents, days], id);
  }
  assert.equal(by('pr_intro').newClientsOnly, true);
  for (const id of ['pr_m1', 'pr_m2', 'pr_m3', 'pr_mu']) assert.equal(by(id).billingInterval, 'week');
  assert.ok(readFileSync('RULES.md', 'utf8').includes('1 Class Per Week Membership: $22/week'));
});
