// Marketing (B2): the pure parts (email render with the unsubscribe link, texts, segment rules, push provider) and the demo
// store for both demo studios: campaigns respect opt-in, automations send once, the inbox works both ways, studios stay apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import type { AuthUser, Client } from '../src/shared/types';
import type { DataStore } from '../src/shared/store';
import { renderEmail, buildSms, smsInfo, mergeTags, safeUrl, SMS_OPT_OUT, type EmailBrand } from '../src/features/marketing/render';
import { ruleMatches, filterMatches, reachable } from '../src/features/marketing/segments';
import { AUTOMATION_CATALOG, describeFilter } from '../src/features/marketing/catalog';
import { webProvider, capacitorProvider, pushProvider } from '../src/features/marketing/push';
import type { AudienceMember, MarketingStore } from '../src/features/marketing/types';

const BRAND: EmailBrand = { name: 'Test Studio', primary: '#123456', ink: '#111111', accent: '#8899aa', soft: '#eeeeee', highlight: '#f5e9c8', bg: '#fafafa', displayFont: 'Gloock', bodyFont: 'Work Sans' };

// ---------------------------------------------------------------- email + text
test('email: marketing carries an unsubscribe link and the reason; the studio brand drives the look', () => {
  const out = renderEmail({
    subject: 'Hi {{first_name}}', blocks: [{ type: 'heading', text: 'Hello *{{first_name}}*' }, { type: 'button', label: 'Book', url: '{{app_url}}' }], brand: BRAND,
    vars: { first_name: 'Ana', app_url: 'https://app.example/' }, unsubscribeUrl: 'https://fn.example/marketing-send?m=1&k=u', reason: 'You said yes to news.', address: '1 Test St',
  });
  assert.match(out.html, /Unsubscribe/);
  assert.match(out.html, /k=u/);
  assert.match(out.text, /Unsubscribe: https:\/\/fn\.example/);
  assert.ok(out.html.includes('#123456') && out.html.includes('Test Studio') && out.html.includes('Gloock'), 'the studio’s colours, name and fonts');
  assert.ok(out.html.includes('Ana') && !out.html.includes('{{'), 'merge tags are filled');
  const service = renderEmail({ subject: 's', blocks: [{ type: 'text', text: 'Your pass' }], brand: BRAND });
  assert.doesNotMatch(service.html, /Unsubscribe/, 'service messages have no unsubscribe link');
});

test('email: unknown merge tags vanish and links can’t run script', () => {
  assert.equal(mergeTags('Hi {{first_name}} {{nope}}!', { first_name: 'Ana' }), 'Hi Ana !');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  const out = renderEmail({ subject: 's', blocks: [{ type: 'button', label: 'Go', url: 'javascript:alert(1)' }, { type: 'text', text: '<script>x</script>' }], brand: BRAND });
  assert.doesNotMatch(out.html, /javascript:/);
  assert.doesNotMatch(out.html, /<script>x/);
});

test('text: marketing texts always end with the opt-out line, and long ones count in segments', () => {
  assert.ok(buildSms('Hi {{first_name}}', { first_name: 'Ana' }).endsWith(SMS_OPT_OUT));
  assert.equal(buildSms('Your pass', {}, { marketing: false }), 'Your pass');
  assert.equal(smsInfo('a'.repeat(160)).segments, 1);
  assert.equal(smsInfo('a'.repeat(161)).segments, 2);
  assert.equal(smsInfo('héllo ☃').encoding, 'UCS-2');
});

// ---------------------------------------------------------------- segment rules
const NOW = new Date('2026-10-19T00:00:00Z');
const member = (over: Partial<AudienceMember> = {}): AudienceMember => ({
  clientId: 'c1', firstName: 'Ana', lastName: 'Test', email: 'ana@example.com', phone: '0400000000', optIn: true, joinedAt: '2026-01-01T00:00:00.000Z', visits: 3,
  activeMember: false, packs: [], tags: [], ...over,
});
test('segments: rules, not, any / all, and who can be reached', () => {
  const lapsed = member({ lastVisitAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(ruleMatches(lapsed, { type: 'no_visit', days: 30 }, NOW), true);
  assert.equal(ruleMatches(member({ lastVisitAt: '2026-10-10T00:00:00.000Z' }), { type: 'no_visit', days: 30 }, NOW), false);
  assert.equal(ruleMatches(member({ visits: 0 }), { type: 'no_visit', days: 30 }, NOW), false, 'someone who never came is not "lapsed"');
  assert.equal(ruleMatches(member({ packs: [{ id: 'p', name: 'Pack', remaining: 1 }] }), { type: 'pack_low', credits: 1 }, NOW), true);
  assert.equal(ruleMatches(member({ tags: ['VIP'] }), { type: 'tag', tag: 'vip' }, NOW), true);
  assert.equal(ruleMatches(member(), { type: 'opted_in', not: true }, NOW), false);
  assert.equal(filterMatches(member({ activeMember: true }), { match: 'any', rules: [{ type: 'intro' }, { type: 'active_member' }] }, NOW), true);
  assert.equal(filterMatches(member({ activeMember: true }), { match: 'all', rules: [{ type: 'intro' }, { type: 'active_member' }] }, NOW), false);
  assert.equal(filterMatches(member(), { match: 'all', rules: [] }, NOW), true, 'no rules = everyone');
  assert.equal(describeFilter({ match: 'all', rules: [{ type: 'no_visit', days: 30 }, { type: 'intro', not: true }] }), 'No visit in 30 days and Not on the intro offer');
  assert.equal(reachable(member({ optIn: false }), 'email', true).ok, false, 'marketing needs opt-in');
  assert.equal(reachable(member({ optIn: false }), 'email', false).ok, true, 'a service message about their own pass does not');
  assert.equal(reachable(member({ phone: undefined }), 'sms', true).ok, false, 'no mobile number');
});

test('automations: the six requested automations exist, each with a sensible delay', () => {
  const keys = AUTOMATION_CATALOG.map((a) => a.key);
  for (const k of ['welcome', 'intro_ending', 'pack_low', 'winback', 'birthday', 'after_first_class']) assert.ok(keys.includes(k as never), k);
  for (const a of AUTOMATION_CATALOG) assert.ok(a.delay.default >= a.delay.min && a.delay.default <= a.delay.max, a.key);
  for (const a of AUTOMATION_CATALOG.filter((x) => x.kind === 'marketing')) assert.ok(a.defaults.body.length > 0);
});

// ---------------------------------------------------------------- push provider
test('push: with no browser or native shell, nothing is supported and subscribing explains why', async () => {
  assert.equal(webProvider.supported(), false);
  assert.equal(capacitorProvider.supported(), false);
  assert.equal(pushProvider().platform, 'web');
  await assert.rejects(() => webProvider.subscribe({}), /browser can’t show notifications/);
});

// ---------------------------------------------------------------- the demo store, both studios
let CLOCK = new Date('2026-10-18T21:00:00Z'); // Mon 19 Oct 2026, 8am Sydney
function platform() {
  CLOCK = new Date('2026-10-18T21:00:00Z');
  return createDemoPlatform({ now: () => CLOCK, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
}
interface Desk { s: DataStore; m: MarketingStore; owner: AuthUser; staff(role: string): Promise<AuthUser>; as(u: AuthUser): Promise<unknown>; asOwner(): Promise<unknown> }
async function desk(p: ReturnType<typeof createDemoPlatform>, slug: string): Promise<Desk> {
  const studio = await p.findStudio({ slug });
  assert.ok(studio, slug);
  const s = p.forStudio(studio);
  const personas = await s.demoPersonas();
  const owner = personas.find((u) => u.kind === 'staff' && u.role === 'owner')!;
  await s.demoSignInAs!(owner);
  const m = s.features.marketing!;
  assert.ok(m, `${slug}: marketing is registered`);
  return {
    s, m, owner, as: (u) => s.demoSignInAs!(u), asOwner: () => s.demoSignInAs!(owner),
    staff: async (role) => personas.find((u) => u.kind === 'staff' && u.role === role)!,
  };
}
const SLUGS = ['snowy', 'harbour'];
const clientUser = (c: Client): AuthUser => ({ kind: 'client', clientId: c.id, email: c.email, name: c.firstName });
const everyone = { match: 'all' as const, rules: [] };

test('demo: both studios are seeded with segments, campaigns (sent, draft, scheduled), automations and inbox threads', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const { m } = await desk(p, slug);
    const segs = await m.listSegments();
    assert.ok(segs.length >= 6, `${slug}: starter segments`);
    assert.ok(segs.every((x) => x.optedIn <= x.count), `${slug}: opted-in never exceeds matches`);
    const camps = await m.listCampaigns();
    assert.ok(camps.some((c) => c.status === 'sent' && c.channel === 'email') && camps.some((c) => c.channel === 'sms') && camps.some((c) => c.status === 'draft') && camps.some((c) => c.status === 'scheduled'), `${slug}: every kind of campaign`);
    const autos = await m.listAutomations();
    assert.equal(autos.length, AUTOMATION_CATALOG.length, `${slug}: all automations`);
    assert.ok(autos.every((a) => a.enabled), `${slug}: they start on`);
    const threads = await m.listThreads();
    assert.ok(threads.length >= 3 && threads.some((t) => t.unread > 0), `${slug}: inbox threads`);
    assert.equal(await m.inboxUnreadCount(), threads.reduce((n, t) => n + t.unread, 0), `${slug}: unread adds up`);
  }
});

test('demo: only front desk and above can use marketing; clients and instructors are refused', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const instructor = (await d.s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'instructor');
    if (instructor) { await d.as(instructor); await assert.rejects(() => d.m.listCampaigns(), (e: Error & { code?: string }) => e.code === 'NOT_ALLOWED', `${slug}: instructor`); }
    const front = (await d.s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'front_desk');
    if (front) {
      await d.as(front);
      assert.ok((await d.m.listCampaigns()).length > 0, `${slug}: front desk can look`);
      await assert.rejects(() => d.m.saveCampaign({ name: 'x', channel: 'sms', body: 'hi' }), (e: Error & { code?: string }) => e.code === 'NOT_ALLOWED', `${slug}: front desk can’t create`);
    }
    await d.asOwner();
    const c = (await d.s.listClients())[0]!;
    await d.as(clientUser(c));
    await assert.rejects(() => d.m.listSegments(), (e: Error & { code?: string }) => e.code === 'NOT_ALLOWED', `${slug}: client`);
  }
});

test('campaign: only clients who opted in get it, and opting out removes you from the next one', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const clients = await d.s.listClients();
    const optedIn = clients.filter((c) => c.marketingOptIn && c.email);
    const out = clients.filter((c) => !c.marketingOptIn);
    assert.ok(optedIn.length > 2 && out.length > 0, `${slug}: a mix of yes and no`);
    const draft = await d.m.saveCampaign({ name: 'Everyone', channel: 'email', subject: 'Hi {{first_name}}', blocks: [{ id: 'b', type: 'text', text: 'News' }] });
    const sent = await d.m.sendCampaign(draft.id);
    assert.equal(sent.stats.sent, optedIn.length, `${slug}: sent to exactly the opted-in clients`);
    assert.ok(sent.stats.skipped >= out.length, `${slug}: the rest were left out`);
    const detail = await d.m.getCampaign(sent.id);
    assert.ok(detail.recipients.every((r) => r.status !== 'sent' || optedIn.some((c) => c.id === r.clientId)), `${slug}: nobody who said no got it`);
    assert.ok(!detail.recipients.some((r) => r.status === 'sent' && out.some((c) => c.id === r.clientId)));
    // a sent campaign is kept as it was
    await assert.rejects(() => d.m.saveCampaign({ id: sent.id, name: 'Changed', channel: 'email', subject: 's', blocks: [{ id: 'b', type: 'text', text: 'x' }] }), /can’t be changed/);
    await assert.rejects(() => d.m.deleteCampaign(sent.id), /kept/);
    // one client opts out (what the profile switch and the email link both do)
    const leaver = optedIn[0]!;
    await d.s.upsertClient({ ...leaver, marketingOptIn: false });
    const again = await d.m.sendCampaign((await d.m.saveCampaign({ name: 'Again', channel: 'email', subject: 'Again', blocks: [{ id: 'b', type: 'text', text: 'x' }] })).id);
    assert.equal(again.stats.sent, optedIn.length - 1, `${slug}: the person who opted out is skipped`);
  }
});

test('campaign: nothing to send, bad input and scheduling are refused with a friendly message', async () => {
  const p = platform();
  const d = await desk(p, 'snowy');
  await assert.rejects(() => d.m.saveCampaign({ name: '', channel: 'email', subject: 's' }), /name/i);
  const draft = await d.m.saveCampaign({ name: 'No subject', channel: 'email', subject: '', blocks: [{ id: 'b', type: 'text', text: 'x' }] });
  await assert.rejects(() => d.m.sendCampaign(draft.id), /subject/i);
  const ok = await d.m.saveCampaign({ id: draft.id, name: 'No subject', channel: 'email', subject: 'Hello', blocks: [{ id: 'b', type: 'text', text: 'x' }] });
  await assert.rejects(() => d.m.scheduleCampaign(ok.id, new Date(CLOCK.getTime() - 3600_000).toISOString()), /future/);
  const later = new Date(CLOCK.getTime() + 3 * 86_400_000).toISOString();
  const sch = await d.m.scheduleCampaign(ok.id, later);
  assert.equal(sch.status, 'scheduled');
  await assert.rejects(() => d.m.saveCampaign({ id: ok.id, name: 'x', channel: 'email', subject: 'Hello', blocks: [{ id: 'b', type: 'text', text: 'x' }] }), /Unschedule/);
  assert.equal((await d.m.unscheduleCampaign(ok.id)).status, 'draft');
  // scheduled campaigns go out by themselves once their time has come
  await d.m.scheduleCampaign(ok.id, later);
  CLOCK = new Date(CLOCK.getTime() + 4 * 86_400_000);
  assert.equal((await d.m.listCampaigns()).find((c) => c.id === ok.id)!.status, 'sent');
});

test('audience: a segment can be saved, previewed and used; one still in use can’t be deleted', async () => {
  const p = platform();
  const d = await desk(p, 'snowy');
  const prev = await d.m.previewAudience({ match: 'all', rules: [{ type: 'opted_in' }] });
  assert.ok(prev.count > 0 && prev.optedIn === prev.count);
  const seg = await d.m.saveSegment({ name: 'Opted in', filter: { match: 'all', rules: [{ type: 'opted_in' }] } });
  await assert.rejects(() => d.m.saveSegment({ name: 'opted IN', filter: everyone }), /already/);
  await assert.rejects(() => d.m.previewAudience({ match: 'all', rules: [{ type: 'tag', tag: '' }] }), /tag/i);
  const draft = await d.m.saveCampaign({ name: 'To them', channel: 'sms', body: 'Hello', segmentId: seg.id });
  await assert.rejects(() => d.m.deleteSegment(seg.id), /still uses/);
  await d.m.deleteCampaign(draft.id);
  await d.m.deleteSegment(seg.id);
  // tags
  const c = (await d.s.listClients())[0]!;
  assert.deepEqual(await d.m.setClientTags(c.id, ['Retreat', 'retreat', ' Teacher training ']), ['Retreat', 'Teacher training'], 'tags are tidied and de-duplicated');
  assert.equal((await d.m.listTags()).find((t) => t.tag === 'Retreat')?.count, 1);
  const tagged = await d.m.previewAudience({ match: 'all', rules: [{ type: 'tag', tag: 'RETREAT' }] });
  assert.equal(tagged.count, 1, 'tags match whatever the capitals');
});

test('automations: the dry run shows who is next, a real run sends once each, a second run sends nothing', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const clients = await d.s.listClients();
    const dry = await d.m.runAutomations({ dryRun: true });
    assert.equal(dry.dryRun, true);
    const before = (await d.m.listMessageLog({ limit: 500 })).length;
    assert.equal((await d.m.listMessageLog({ limit: 500 })).length, before, `${slug}: a dry run sends nothing`);
    const marketingKeys = new Set(AUTOMATION_CATALOG.filter((a) => a.kind === 'marketing').map((a) => a.key));
    for (const it of dry.items.filter((x) => marketingKeys.has(x.key))) {
      assert.ok(clients.find((c) => c.id === it.clientId)?.marketingOptIn, `${slug}: ${it.automationName} only goes to opted-in clients (${it.clientName})`);
    }
    const first = await d.m.runAutomations({ dryRun: false });
    assert.equal(first.items.length, dry.items.length, `${slug}: sends what the dry run promised`);
    assert.equal((await d.m.listMessageLog({ limit: 500 })).length, before + first.items.length);
    const second = await d.m.runAutomations({ dryRun: false });
    assert.equal(second.items.length, 0, `${slug}: nobody gets the same message twice`);
    // switching one off stops it
    const welcome = (await d.m.listAutomations()).find((a) => a.key === 'welcome')!;
    assert.equal((await d.m.saveAutomation({ key: 'welcome', enabled: false })).enabled, false);
    assert.equal((await d.m.listAutomations()).find((a) => a.key === 'welcome')!.enabled, false);
    assert.ok(welcome.sentLast30Days >= 0);
    await assert.rejects(() => d.m.saveAutomation({ key: 'winback', delay: 1 }), /days/i);
  }
});

test('inbox: a client writes, the studio sees it unread and replies, the client sees the reply; each studio keeps its own', async () => {
  const p = platform();
  const snowy = await desk(p, 'snowy'), harbour = await desk(p, 'harbour');
  await snowy.asOwner();
  const [sc] = (await snowy.s.listClients()).filter((c) => c.email);
  const beforeUnread = await snowy.m.inboxUnreadCount();
  await snowy.as(clientUser(sc!));
  assert.equal(await snowy.m.myUnreadCount() >= 0, true);
  await assert.rejects(() => snowy.m.sendMyMessage('   '), /Write/i);
  await snowy.m.sendMyMessage('Can I bring a friend on Saturday?');
  await snowy.asOwner();
  assert.equal(await snowy.m.inboxUnreadCount(), beforeUnread + 1);
  const detail = await snowy.m.getThread(sc!.id);
  assert.equal(detail.messages.at(-1)!.body, 'Can I bring a friend on Saturday?');
  assert.equal(detail.messages.at(-1)!.from, 'client');
  assert.ok(detail.thread!.unread >= 1);
  await snowy.m.sendStaffMessage(sc!.id, 'Of course, see you then!');
  assert.equal((await snowy.m.getThread(sc!.id)).thread!.unread, 0, 'replying counts as reading');
  await snowy.as(clientUser(sc!));
  const mine = await snowy.m.getMyThread();
  assert.ok(mine.unread >= 1);
  assert.equal(mine.messages.at(-1)!.from, 'staff');
  assert.ok(mine.messages.at(-1)!.staffName);
  await snowy.m.markMyThreadRead();
  assert.equal((await snowy.m.getMyThread()).unread, 0);
  // Harbour's inbox has none of Snowy's conversations, and Harbour staff can't open a Snowy client's thread
  await harbour.asOwner();
  assert.ok(!(await harbour.m.listThreads()).some((t) => t.clientId === sc!.id));
  await assert.rejects(() => harbour.m.getThread(sc!.id), (e: Error & { code?: string }) => e.code === 'NOT_FOUND');
  await assert.rejects(() => harbour.m.sendStaffMessage(sc!.id, 'hi'), (e: Error & { code?: string }) => e.code === 'NOT_FOUND');
});

test('push: a device registers, is counted, and can be removed; sending says it needs keys', async () => {
  const p = platform();
  const d = await desk(p, 'snowy');
  const start = await d.m.getPushStatus();
  await d.m.registerPush({ platform: 'web', token: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } });
  await d.m.registerPush({ platform: 'web', token: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } }); // same device twice
  await d.m.registerPush({ platform: 'ios', token: 'apns-token-1' });
  const st = await d.m.getPushStatus();
  assert.equal(st.registered, true);
  assert.deepEqual([st.devices.web - start.devices.web, st.devices.ios - start.devices.ios, st.devices.android - start.devices.android], [1, 1, 0], 'a device is counted once');
  assert.equal(st.needsKeys, true);
  assert.match((await d.m.sendTestPush()).note, /keys/i);
  await d.m.unregisterPush('https://push.example/abc');
  assert.equal((await d.m.getPushStatus()).devices.web, start.devices.web);
  await assert.rejects(() => d.m.registerPush({ platform: 'web' as never, token: '' }), /can’t be registered/);
});

test('settings: sender details save per studio and a bad reply-to is refused', async () => {
  const p = platform();
  const a = await desk(p, 'snowy'), b = await desk(p, 'harbour');
  await a.asOwner();
  await a.m.updateSettings({ fromName: 'Libby at the studio', replyTo: 'hello@example.com' });
  assert.equal((await a.m.getSettings()).fromName, 'Libby at the studio');
  await b.asOwner();
  assert.notEqual((await b.m.getSettings()).fromName, 'Libby at the studio', 'the other studio is untouched');
  await a.asOwner();
  await assert.rejects(() => a.m.updateSettings({ replyTo: 'not an email' }), /reply-to/i);
  const prov = await a.m.getProviders();
  assert.equal(prov.sms.provider, 'stub');
  assert.equal(prov.push.ready, false);
});
