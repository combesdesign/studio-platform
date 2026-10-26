// The platform layer: many studios in one demo store, isolation between them, studio resolution,
// branding tokens, per-studio formatting, platform admin, and the feature-module hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, createDemoStore, memoryStorage } from '../src/data/demo';
import { registerDemoFeature } from '../src/data/demo/features';
import { can, registerPermissions } from '../src/domain/permissions';
import { brandTokens, contrast, fontsUrl, accentParts, classPhotoFor, defaultBranding, textLogo } from '../src/shared/branding';
import { initialsFor, manifestFor, pwaIdentity } from '../src/shared/pwa';
import { studioHints, stripStudioPath, slugFromHash } from '../src/shared/resolve';
import { DEFAULT_FORMAT, currentFormat, dayShort, money, setStudioFormat, studioDate, taxOf, time, withStudioFormat } from '../src/shared/format';
import { SNOWY_BRANDING, HARBOUR_BRANDING } from '../src/data/studios';
import type { AuthUser, ID } from '../src/shared/types';
import type { DataStore } from '../src/shared/store';

// ---------------------------------------------------------------- a feature, registered the way src/features/<name>/demo.ts does
interface PingStore { count(): Promise<number>; ping(): Promise<number> }
declare module '../src/shared/store' { interface FeatureStores { ping: PingStore } }
registerPermissions({ 'ping.send': ['owner', 'manager'] });
registerDemoFeature({
  name: 'ping',
  seed: ({ studio }) => ({ n: studio.slug === 'harbour' ? 10 : 0 }),
  create: (ctx) => ({
    count: () => ctx.read(() => ctx.slice<{ n: number }>().n),
    ping: () => ctx.write(() => { ctx.requireStaff('ping.send'); return ++ctx.slice<{ n: number }>().n; }),
  }),
});

const NOW = new Date('2026-10-14T05:00:00Z');
function demo() {
  const storage = memoryStorage();
  const opts = { now: () => NOW, latencyMs: 0, storage, app: 'studio' as const };
  const platform = createDemoPlatform(opts);
  return { platform, storage, opts };
}
async function studioStore(p: ReturnType<typeof createDemoPlatform>, slug: string): Promise<DataStore> {
  const s = await p.findStudio({ slug });
  assert.ok(s, `studio ${slug}`);
  return p.forStudio(s);
}
const staffUser = async (s: DataStore, email: string): Promise<AuthUser> => (await s.demoPersonas()).find((u) => u.email === email)!;

test('the demo platform has Snowy (unchanged) and Harbour, each with its own data', async () => {
  const { platform } = demo();
  const studios = await platform.listStudios();
  assert.deepEqual(studios.map((s) => s.slug).sort(), ['harbour', 'snowy']);
  const snowy = await studioStore(platform, 'snowy');
  const harbour = await studioStore(platform, 'harbour');
  assert.equal((await snowy.getSettings()).name, 'Snowy Pilates Club');
  assert.equal((await harbour.getSettings()).name, 'Harbour Reformer Co.');
  assert.deepEqual((await snowy.listClassTypes()).map((c) => c.name), ['Mat Essentials', 'Mums + Bubs', 'Strength + Sculpt']);
  assert.deepEqual((await harbour.listClassTypes()).map((c) => c.name), ['Reformer Foundations', 'Reformer Flow', 'Jumpboard Burn']);
  await snowy.demoSignInAs!(await staffUser(snowy, 'libby@snowypilatesclub.com'));
  assert.equal((await snowy.listClients()).length >= 40, true);
  await harbour.demoSignInAs!(await staffUser(harbour, 'ava@harbourreformer.example'));
  const hc = await harbour.listClients();
  assert.ok(hc.length >= 12 && hc.length <= 20, `Harbour clients ${hc.length}`);
  // Harbour personas: member at 1 of 2 left this week, pack with 1 left
  const jack = hc.find((c) => c.email === 'jack.nolan@example.com')!;
  assert.equal((await harbour.getCreditSummary(jack.id))[0]?.label, '1 of 2 left this week');
  const priya = hc.find((c) => c.email === 'priya.shah@example.com')!;
  assert.equal((await harbour.getCreditSummary(priya.id))[0]?.label, '1 of 5 left');
});

test('studios are isolated: one studio\'s staff and clients can\'t read or change another\'s data', async () => {
  const { platform } = demo();
  const snowy = await studioStore(platform, 'snowy');
  const harbour = await studioStore(platform, 'harbour');
  await harbour.demoSignInAs!(await staffUser(harbour, 'ava@harbourreformer.example'));
  const harbourClient = (await harbour.listClients())[0]!;
  const harbourSession = (await harbour.listSessions({ from: NOW.toISOString(), to: new Date(NOW.getTime() + 7 * 864e5).toISOString() }))[0]!;
  // Snowy's owner, bound to Snowy: Harbour's ids simply don't exist here
  await snowy.demoSignInAs!(await staffUser(snowy, 'libby@snowypilatesclub.com'));
  assert.ok(!(await snowy.listClients()).some((c) => c.id === harbourClient.id || c.email === harbourClient.email));
  await assert.rejects(snowy.getClient(harbourClient.id), { code: 'NOT_FOUND' });
  await assert.rejects(snowy.getRoster(harbourSession.id), { code: 'NOT_FOUND' });
  await assert.rejects(snowy.bookClass(harbourClient.id, harbourSession.id), { code: 'NOT_FOUND' });
  await assert.rejects(snowy.listPasses(harbourClient.id).then((x) => { if (!x.length) throw Object.assign(new Error('empty'), { code: 'NOT_FOUND' }); return x; }), { code: 'NOT_FOUND' });
  // Snowy's owner signed in to the Harbour store is nobody there
  const harbourAsLibby = createDemoStore({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio', studio: 'harbour' });
  await assert.rejects(harbourAsLibby.signIn('libby@snowypilatesclub.com', 'pw'), { code: 'INVALID_LOGIN' });
  // Harbour's settings are untouched by Snowy's owner
  await snowy.updateSettings({ name: 'Snowy Pilates Club', cancelWindowHours: 4 });
  assert.equal((await harbour.getSettings()).cancelWindowHours, 12);
  // A Snowy client can't use their Snowy session at Harbour: they're not a Harbour client
  const snowyClient = (await snowy.demoPersonas()).find((u) => u.kind === 'client')!;
  await snowy.demoSignInAs!(snowyClient);
  assert.equal((await snowy.currentUser())?.kind, 'client');
  assert.equal(await harbour.currentUser(), null, 'signed in once per app: at Harbour that Snowy-only client is nobody');
});

test('one login, many studios: a client joins a second studio by signing in there', async () => {
  const storage = memoryStorage();
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage, app: 'client' });
  const harbour = await studioStore(p, 'harbour');
  const before = (await p.findStudio({ slug: 'harbour' }))!;
  const u = await harbour.signIn('hannah.mitchell@example.com', 'pw');
  assert.equal(u.kind, 'client');
  const me = await harbour.getClient((u as Extract<AuthUser, { kind: 'client' }>).clientId);
  assert.equal(me.firstName, 'Hannah');
  assert.equal(me.waiverSignedAt, undefined, 'a new studio needs its own waiver');
  assert.deepEqual(await harbour.listPasses(me.id), [], 'passes never carry over');
  const memberships = await p.myMemberships();
  assert.deepEqual(memberships.filter((m) => m.kind === 'client').map((m) => m.slug).sort(), ['harbour', 'snowy']);
  assert.equal(before.status, 'live');
});

test('platform admin: create a studio, invite its owner, onboarding to live, suspend', async () => {
  const { platform } = demo();
  await assert.rejects(platform.createStudio({ name: 'X', slug: 'x-studio', email: 'x@x.example' }), { code: 'AUTH_REQUIRED' });
  await platform.demoSignInAs!('ava@harbourreformer.example');
  await assert.rejects(platform.createStudio({ name: 'X', slug: 'x-studio', email: 'x@x.example' }), { code: 'NOT_ALLOWED' });
  await platform.demoSignInAs!('pete@studioplatform.example');
  assert.equal((await platform.platformUser())?.role, 'platform_admin');
  await assert.rejects(platform.createStudio({ name: 'Dup', slug: 'snowy', email: 'x@x.example' }), { code: 'SLUG_TAKEN' });
  await assert.rejects(platform.createStudio({ name: 'Bad', slug: 'Bad Slug', email: 'x@x.example' }), { code: 'INVALID' });
  await assert.rejects(platform.createStudio({ name: 'Admin', slug: 'admin', email: 'x@x.example' }), { code: 'INVALID' });
  const s = await platform.createStudio({ name: 'Bondi Barre House', slug: 'bondi-barre', email: 'hello@bondi.example', timezone: 'Australia/Perth' });
  assert.equal(s.status, 'onboarding');
  assert.equal((await platform.listStudios()).some((x) => x.id === s.id), false, 'not in the public list while setting up');
  assert.equal((await platform.listStudios({ includeAll: true })).some((x) => x.id === s.id), true);
  const owner = await platform.inviteOwner(s.id, { name: 'Nina Park', email: 'nina@bondi.example' });
  assert.equal(owner.role, 'owner');
  // the owner sets up and opens the studio
  const store = platform.forStudio(s);
  await store.demoSignInAs!((await store.demoPersonas()).find((u) => u.email === 'nina@bondi.example')!);
  await store.updateStudio({ branding: { ...s.branding, colors: { ...s.branding.colors, primary: '#7A3E2B' } } });
  const ct = await store.upsertClassType({ name: 'Barre', description: '', durationMin: 45, color: '#7A3E2B', defaultCapacity: 12, bookable: true, active: true });
  await store.upsertProduct({ kind: 'pack', name: '5 pack', description: '', priceCents: 12000, credits: 5, validityDays: 90, active: true, sortOrder: 1 });
  assert.equal((await store.listClassTypes())[0]?.id, ct.id);
  await assert.rejects(store.updateStudio({ status: 'live' as const, name: '' }), { code: 'INVALID' });
  assert.equal((await store.updateStudio({ status: 'live' })).status, 'live');
  await assert.rejects(store.updateStudio({ status: 'live' }), { code: 'INVALID' });
  assert.equal((await platform.listStudios()).some((x) => x.id === s.id), true, 'live studios are listed');
  // its dates are in its own timezone (Perth, UTC+8)
  assert.equal((await store.getSettings()).timezone, 'Australia/Perth');
  // suspend: nobody can change anything there
  await platform.demoSignInAs!('pete@studioplatform.example');
  await platform.setStudioStatus(s.id, 'suspended');
  await platform.demoSignInAs!('nina@bondi.example');
  await assert.rejects(store.updateStudio({ name: 'Bondi Barre' }), { code: 'STUDIO_SUSPENDED' });
  await assert.rejects(store.upsertClassType({ name: 'Barre 2', description: '', durationMin: 45, color: '#7A3E2B', defaultCapacity: 12, bookable: true, active: true }), { code: 'STUDIO_SUSPENDED' });
  assert.equal((await platform.listStudios()).some((x) => x.id === s.id), false, 'suspended studios leave the picker');
  await platform.demoSignInAs!('pete@studioplatform.example');
  const stats = await platform.studioStats!();
  assert.equal(stats[s.id]?.staff, 1);
});

test('feature modules: registered demo stores get per-studio seeded data, persistence and permissions', async () => {
  const { platform } = demo();
  const snowy = await studioStore(platform, 'snowy');
  const harbour = await studioStore(platform, 'harbour');
  assert.ok(snowy.features.ping && harbour.features.ping, 'store.features.ping is there once registered');
  assert.equal(await snowy.features.ping!.count(), 0);
  assert.equal(await harbour.features.ping!.count(), 10, 'seeded per studio');
  await snowy.demoSignInAs!(await staffUser(snowy, 'julia@snowypilatesclub.com'));
  await assert.rejects(snowy.features.ping!.ping(), { code: 'NOT_ALLOWED' }, 'feature permission: instructors can\'t');
  await snowy.demoSignInAs!(await staffUser(snowy, 'libby@snowypilatesclub.com'));
  assert.equal(await snowy.features.ping!.ping(), 1);
  assert.equal(await harbour.features.ping!.count(), 10, 'other studio untouched');
  assert.equal(can('owner', 'ping.send'), true);
  assert.equal(can('instructor', 'ping.send'), false);
  assert.equal(can('owner', 'nope.unknown'), false);
  assert.throws(() => registerPermissions({ 'Bad Name.x': ['owner'] } as never));
});

test('branding: Snowy\'s tokens are exactly its original theme; other studios derive sensible shades', () => {
  const t = brandTokens(SNOWY_BRANDING);
  const original: Record<string, string> = {
    '--primary': '#5069AC', '--primary-600': '#435C9E', '--ink': '#24345F', '--accent': '#85A2D1', '--soft': '#EEF2F9', '--soft-2': '#E3E9F4',
    '--highlight': '#F2E6C6', '--highlight-2': '#F8F1DE', '--bg': '#FAF8F3', '--muted': '#5D6A8A', '--faint': '#8C96B0',
    '--ink-rgb': '36, 52, 95', '--primary-rgb': '80, 105, 172', '--bg-rgb': '250, 248, 243', '--shade-rgb': '26, 36, 68', '--ink-2': '#1C2A4F',
    '--soft-light': '#F7F9FD', '--bg-light': '#FCFBF8', '--highlight-light': '#FBF5E6', '--highlight-hover': '#ECDCB2', '--soft-white': '#FBFCFF', '--soft-3': '#DCE6F4',
    '--display': "'Instrument Serif', Georgia, serif", '--body': "'Questrial', system-ui, -apple-system, 'Segoe UI', sans-serif",
  };
  for (const [k, v] of Object.entries(original)) assert.equal(t[k]?.toUpperCase(), v.toUpperCase(), k);
  assert.equal(fontsUrl(SNOWY_BRANDING.fonts), 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Questrial&display=swap', 'same Google Fonts request as before');
  const h = brandTokens(HARBOUR_BRANDING);
  assert.equal(h['--primary'], '#1F4A3D');
  assert.equal(h['--display'], "'Gloock', Georgia, serif");
  assert.ok(!fontsUrl(HARBOUR_BRANDING.fonts).includes('Gloock:ital'), 'no italic requested for a family without one');
  const d = brandTokens(defaultBranding('New Place'));
  for (const k of ['--primary-600', '--soft-2', '--muted', '--faint', '--shade-rgb', '--highlight-hover']) assert.ok(d[k], `${k} derived`);
  assert.ok(contrast(d['--ink']!, d['--bg']!) > 7, 'default ink on bg is readable');
  assert.deepEqual(accentParts('Join the newest club to hit *Cooma!*'), [{ text: 'Join the newest club to hit ', em: false }, { text: 'Cooma!', em: true }]);
  assert.equal(classPhotoFor(SNOWY_BRANDING, 'Mums + Bubs'), 'img/portrait.webp');
  assert.equal(classPhotoFor(SNOWY_BRANDING, 'Mat Essentials'), 'img/wide.webp');
  assert.equal(classPhotoFor(SNOWY_BRANDING, { name: 'Mat Essentials', imageUrl: 'x.webp' }), 'x.webp');
  assert.ok(textLogo('Bondi Barre House').svg.includes('HOUSE'));
});

test('studio resolution order: build config, subdomain/domain, #/s/<slug>, ?studio=, remembered', () => {
  const all = { host: 'harbour.studioplatform.app', platformDomain: 'studioplatform.app', hash: '#/s/snowy/passes', search: '?studio=bondi', remembered: 'zen' };
  assert.deepEqual(studioHints({ ...all, buildSlug: 'snowy' }), [{ source: 'build', slug: 'snowy' }], 'single-studio build wins outright');
  assert.deepEqual(studioHints(all).map((h) => `${h.source}:${h.slug ?? h.domain}`), ['subdomain:harbour', 'path:snowy', 'query:bondi', 'remembered:zen']);
  assert.deepEqual(studioHints({ ...all, host: 'app.snowypilatesclub.com' })[0], { source: 'domain', domain: 'app.snowypilatesclub.com' });
  assert.equal(studioHints({ ...all, host: 'www.studioplatform.app' })[0]?.source, 'path', 'www is not a studio');
  assert.equal(studioHints({ ...all, host: 'admin.studioplatform.app' })[0]?.source, 'path', 'admin is not a studio');
  assert.equal(studioHints({ host: 'localhost:4173', hash: '#/', search: '' }).length, 0, 'nothing -> the picker');
  assert.equal(slugFromHash('#/s/harbour'), 'harbour');
  assert.equal(stripStudioPath('#/s/harbour/class/abc'), '#/class/abc');
  assert.equal(stripStudioPath('#/s/harbour'), '#/');
  assert.equal(studioHints({ search: '?studio=Bad Slug!' }).length, 0, 'junk slugs are ignored');
});

test('formatting follows the current studio (timezone, locale, currency, tax) and defaults to Snowy\'s', () => {
  assert.deepEqual(currentFormat(), DEFAULT_FORMAT);
  const at = new Date('2026-10-14T19:30:00Z'); // 6:30am Thu 15 Oct in Sydney; 3:30am Thu in Perth; 8:30am Thu in Auckland
  assert.equal(time(at), '6:30am');
  assert.equal(studioDate(at), '2026-10-15');
  assert.equal(money(4900), '$49');
  assert.equal(taxOf(11000), 1000);
  withStudioFormat({ timezone: 'Australia/Perth' }, () => { assert.equal(time(at), '3:30am'); assert.equal(dayShort(at), 'Thu 15 Oct'); });
  withStudioFormat({ timezone: 'Pacific/Auckland', currency: 'NZD', locale: 'en-NZ', taxRate: 0.15 }, () => {
    assert.equal(time(at), '8:30am');
    assert.equal(taxOf(11500), 1500);
    assert.match(money(4900), /49/);
  });
  assert.equal(time(at), '6:30am', 'restored afterwards');
  setStudioFormat({ timezone: 'Europe/London' });
  assert.equal(studioDate(new Date('2026-10-14T23:30:00Z')), '2026-10-15');
  setStudioFormat(DEFAULT_FORMAT);
});

test('bound stores keep their studio\'s timezone even when another studio is the app\'s current one', async () => {
  const { platform } = demo();
  await platform.demoSignInAs!('pete@studioplatform.example');
  const perth = await platform.createStudio({ name: 'West', slug: 'west', email: 'w@w.example', timezone: 'Australia/Perth' });
  const store = platform.forStudio(perth);
  await platform.inviteOwner(perth.id, { name: 'Wes', email: 'wes@w.example' });
  await store.demoSignInAs!((await store.demoPersonas()).find((u) => u.email === 'wes@w.example')!);
  const ct = await store.upsertClassType({ name: 'Flow', description: '', durationMin: 50, color: '#333333', defaultCapacity: 10, bookable: true, active: true });
  const staffId = ((await store.currentUser()) as Extract<AuthUser, { kind: 'staff' }>).staffId as ID;
  await store.upsertTemplate({ classTypeId: ct.id, weekday: 5, startTime: '06:00', instructorId: staffId, startsOn: '2026-01-01', active: true });
  const list = await store.listSessions({ from: '2026-10-15T00:00:00Z', to: '2026-10-17T00:00:00Z' });
  assert.equal(list[0]?.startsAt, '2026-10-15T22:00:00.000Z', 'Friday 6am in Perth (UTC+8), not Sydney');
});

test('home screen identity: each studio gets its own name and colours (client and studio apps)', () => {
  const h = pwaIdentity(HARBOUR_BRANDING, 'client', 'Harbour Reformer Co.');
  assert.equal(h.name, HARBOUR_BRANDING.appName);
  assert.equal(h.themeColor, HARBOUR_BRANDING.colors.primary);
  assert.notEqual(h.themeColor, pwaIdentity(SNOWY_BRANDING, 'client', 'Snowy Pilates Club').themeColor);
  const staff = pwaIdentity(HARBOUR_BRANDING, 'studio', 'Harbour Reformer Co.');
  assert.equal(staff.name, `${HARBOUR_BRANDING.appName} Studio`);
  assert.equal(staff.themeColor, HARBOUR_BRANDING.colors.ink);
  assert.equal(initialsFor('Harbour Reformer Co.'), 'HR');
  assert.equal(initialsFor('Snowy'), 'S');
  const m = manifestFor(h, { startUrl: 'https://x.test/?studio=harbour', scope: 'https://x.test/', icons: [] });
  assert.deepEqual([m.name, m.start_url, m.display, m.theme_color], [h.name, 'https://x.test/?studio=harbour', 'standalone', h.themeColor]);
});
