// Plans and gating: hasFeature, the registry filter, gated feature stores, billing state (trial, past due, read-only), the read-only
// store wrapper, and the demo platform's plan / billing rules. Plans are data: nothing here depends on the draft prices except where
// a test says "the seeded plans".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DRAFT_PLANS, FEATURE_CATALOG, billingState, gateFeatures, hasFeature, mrrCents, planOf, upgradePlanFor,
} from '../src/shared/plans';
import {
  clientProfileEntries, clientRoutesList, clientTabsList, isFeatureLocked, registerClientRoute, registerClientTab, registerSettingsTab,
  registerSlot, registerStudioNav, registerStudioRoute, setRegistryStudio, settingsTabsAll, settingsTabsList, slotEntries, studioNavItems,
  studioRoutesAll, studioRoutesList,
} from '../src/shared/registry';
import { readOnlyStore } from '../src/data/readonly';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import type { DataStore } from '../src/shared/store';
import type { Studio, StudioPlan } from '../src/shared/types';

const G = globalThis as { __STUDIO_SLUG__?: unknown };
const NOW = new Date('2026-10-19T08:00:00+11:00');
const planNamed = (key: string): StudioPlan => planOf(DRAFT_PLANS.find((p) => p.key === key)!);
const onPlan = (key: string): { plan: StudioPlan } => ({ plan: planNamed(key) });

test('seeded plans: bulk email in every plan, and each plan adds to the one below', () => {
  const [studio, plus, sig] = DRAFT_PLANS.map((p) => p.features);
  assert.deepEqual(DRAFT_PLANS.map((p) => [p.name, p.priceCents]), [['Studio', 9900], ['Studio Plus', 17900], ['Signature', 29900]]);
  for (const f of DRAFT_PLANS.map((p) => p.features)) assert.ok(f.includes('marketing') && f.includes('core'));
  assert.deepEqual(studio, ['core', 'kiosk', 'reviews', 'marketing', 'support', 'family']);
  assert.deepEqual(plus!.filter((f) => !studio!.includes(f)), ['appointments', 'ondemand', 'commerce', 'payroll', 'integrations']);
  assert.deepEqual(sig!.filter((f) => !plus!.includes(f)), ['branded_app', 'custom_domain', 'multi_location']);
  const known = new Set(FEATURE_CATALOG.map((f) => f.key));
  for (const f of sig!.filter((x) => x !== 'core')) assert.ok(known.has(f), `${f} is in the catalog (the admin ticks these)`);
});

test('hasFeature: core always, no studio or no plan = everything, otherwise the plan decides', () => {
  assert.equal(hasFeature(onPlan('studio'), 'core'), true);
  assert.equal(hasFeature(onPlan('studio'), undefined), true);
  assert.equal(hasFeature(null, 'payroll'), true);
  assert.equal(hasFeature({}, 'payroll'), true);
  assert.equal(hasFeature(onPlan('studio'), 'marketing'), true);
  assert.equal(hasFeature(onPlan('studio'), 'payroll'), false);
  assert.equal(hasFeature(onPlan('studio_plus'), 'payroll'), true);
  assert.equal(hasFeature(onPlan('studio_plus'), 'multi_location'), false);
  assert.equal(hasFeature(onPlan('signature'), 'multi_location'), true);
  assert.equal(hasFeature({ plan: { features: [] } }, 'marketing'), false, 'an edited plan with nothing ticked really has nothing');
});

test('the single-studio build (STUDIO_SLUG) has everything on, always', () => {
  try {
    G.__STUDIO_SLUG__ = 'snowy';
    assert.equal(hasFeature(onPlan('studio'), 'payroll'), true);
    assert.equal(hasFeature({ plan: { features: [] } }, 'marketing'), true);
    const b = billingState({ billingStatus: 'cancelled' }, { graceDays: 14 }, NOW);
    assert.deepEqual([b.enabled, b.readOnly, b.banner], [false, false, null], 'and never read-only');
  } finally { delete G.__STUDIO_SLUG__; }
  G.__STUDIO_SLUG__ = '';
  assert.equal(hasFeature(onPlan('studio'), 'payroll'), false, 'a platform build (empty slug) is gated');
  delete G.__STUDIO_SLUG__;
});

test('registries skip nav, routes, settings tabs, slots and tabs whose feature the plan lacks', () => {
  const r = () => null;
  registerStudioNav({ id: 't.nav.free', label: 'Free', icon: 'x', href: '#/f' });
  registerStudioNav({ id: 't.nav.pay', feature: 'payroll', label: 'Pay', icon: 'x', href: '#/p' });
  registerStudioRoute({ id: 't.route.pay', feature: 'payroll', path: '/t-payroll', render: r });
  registerStudioRoute({ id: 't.route.mkt', feature: 'marketing', path: '/t-mkt', render: r });
  registerSettingsTab({ id: 't.tab.pay', feature: 'payroll', label: 'Pay', render: r });
  registerSlot('roster.header', { id: 't.slot.pay', feature: 'payroll', render: () => null });
  registerSlot('roster.header', { id: 't.slot.free', render: () => null });
  registerClientTab({ id: 't.ctab', feature: 'ondemand', path: '/t-online', label: 'Online', icon: 'x' });
  registerClientRoute({ id: 't.croute', feature: 'ondemand', path: '/t-online', render: r });
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).filter((i) => i.startsWith('t.'));

  setRegistryStudio(onPlan('studio'));
  assert.deepEqual(ids(studioNavItems()), ['t.nav.free']);
  assert.deepEqual(ids(studioRoutesList()), ['t.route.mkt']);
  assert.deepEqual(ids(settingsTabsList()), []);
  assert.deepEqual(ids(slotEntries('roster.header')), ['t.slot.free']);
  assert.deepEqual(ids(clientTabsList()), []);
  assert.deepEqual(ids(clientRoutesList()), []);
  assert.deepEqual(ids(clientProfileEntries()), []);
  assert.deepEqual(ids(studioRoutesAll()), ['t.route.pay', 't.route.mkt'], 'locked routes stay findable, to show the upsell');
  assert.deepEqual(ids(settingsTabsAll()), ['t.tab.pay']);
  assert.equal(isFeatureLocked('payroll'), true);
  assert.equal(isFeatureLocked('marketing'), false);

  setRegistryStudio(onPlan('studio_plus'));
  assert.deepEqual(ids(studioNavItems()).sort(), ['t.nav.free', 't.nav.pay']);
  assert.deepEqual(ids(studioRoutesList()), ['t.route.pay', 't.route.mkt']);
  assert.deepEqual(ids(settingsTabsList()), ['t.tab.pay']);
  assert.deepEqual(ids(slotEntries('roster.header')).sort(), ['t.slot.free', 't.slot.pay']);
  assert.deepEqual(ids(clientTabsList()), ['t.ctab']);
  assert.deepEqual(ids(clientRoutesList()), ['t.croute']);
  setRegistryStudio(null);
  assert.equal(ids(studioNavItems()).length, 2, 'no studio bound: nothing filtered');
});

test('every feature module registration names its feature (so the filter can see it)', () => {
  const root = new URL('../src/features', import.meta.url).pathname;
  let seen = 0;
  for (const feat of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const app of ['studio', 'client']) {
      let src = '';
      try { src = readFileSync(path.join(root, feat.name, app, 'index.tsx'), 'utf8'); } catch { continue; }
      for (const line of src.split('\n').filter((l) => /^\s*register(ClientTab|ClientRoute|ClientProfileEntry|StudioNav|StudioRoute|SettingsTab|TodayWidget|Slot)\(/.test(l))) {
        seen++;
        assert.ok(line.includes(`feature: '${feat.name}'`), `${feat.name}/${app}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.ok(seen > 40, `checked ${seen} registrations`);
});

test('gateFeatures: a locked feature store is simply not there, and follows the plan live', () => {
  let studio: { plan?: StudioPlan } = onPlan('studio');
  const f = gateFeatures({ payroll: { x: 1 }, marketing: { y: 2 } } as Record<string, unknown>, () => studio);
  assert.equal(f.payroll, undefined);
  assert.deepEqual(f.marketing, { y: 2 });
  assert.deepEqual(Object.keys(f), ['marketing']);
  studio = onPlan('studio_plus');
  assert.deepEqual(f.payroll, { x: 1 });
});

test('upgradePlanFor names the cheapest plan that adds the feature', () => {
  assert.equal(upgradePlanFor(DRAFT_PLANS, onPlan('studio'), 'payroll')?.name, 'Studio Plus');
  assert.equal(upgradePlanFor(DRAFT_PLANS, onPlan('studio'), 'multi_location')?.name, 'Signature');
  assert.equal(upgradePlanFor(DRAFT_PLANS.map((p) => ({ ...p, active: false })), onPlan('studio'), 'payroll'), undefined);
});

test('billingState: trial days, banner, past due then read-only after the grace period, cancelled', () => {
  const g = { graceDays: 14 };
  const DAY = 86_400_000;
  const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
  assert.deepEqual(billingState({}, g, NOW).enabled, false, 'no billing status = no billing');
  let b = billingState({ billingStatus: 'trialing', trialEndsAt: at(11) }, g, NOW);
  assert.deepEqual([b.trialDaysLeft, b.banner, b.readOnly], [11, null, false]);
  b = billingState({ billingStatus: 'trialing', trialEndsAt: at(3) }, g, NOW);
  assert.deepEqual([b.trialDaysLeft, b.banner, b.readOnly], [3, 'trial', false]);
  b = billingState({ billingStatus: 'trialing', trialEndsAt: at(-2) }, g, NOW);
  assert.deepEqual([b.trialDaysLeft, b.banner, b.readOnly], [0, 'trial_ended', false]);
  b = billingState({ billingStatus: 'trialing', trialEndsAt: at(-15) }, g, NOW);
  assert.deepEqual([b.banner, b.readOnly], ['trial_ended', true]);
  b = billingState({ billingStatus: 'past_due', pastDueSince: at(-3) }, g, NOW);
  assert.deepEqual([b.banner, b.readOnly], ['past_due', false]);
  assert.equal(b.readOnlyOn, at(11));
  b = billingState({ billingStatus: 'past_due', pastDueSince: at(-14) }, g, NOW);
  assert.equal(b.readOnly, true, 'exactly at the grace period');
  b = billingState({ billingStatus: 'past_due', pastDueSince: at(-5) }, { graceDays: 3 }, NOW);
  assert.equal(b.readOnly, true, 'the grace period is a setting');
  b = billingState({ billingStatus: 'cancelled' }, g, NOW);
  assert.deepEqual([b.banner, b.readOnly], ['cancelled', true]);
  b = billingState({ billingStatus: 'active' }, g, NOW);
  assert.deepEqual([b.banner, b.readOnly, b.enabled], [null, false, true]);
  b = billingState({ billingStatus: 'trialing', trialEndsAt: at(3), billingComped: true }, g, NOW);
  assert.equal(b.banner, null, 'a comped studio isn\'t nagged');
});

test('mrrCents: paying studios only (not trials, not comped, not cancelled)', () => {
  const s = (key: string, billingStatus: Studio['billingStatus'], billingComped = false) => ({ plan: planNamed(key), billingStatus, billingComped });
  assert.equal(mrrCents([s('studio', 'active'), s('studio_plus', 'past_due'), s('signature', 'active', true), s('studio', 'trialing'), s('signature', 'cancelled')]), 9900 + 17900);
});

// ------------------------------------------------------------------ the read-only store wrapper
test('read-only store: reads work, writes say why not, support stays open', async () => {
  const calls: string[] = [];
  const fake = {
    mode: 'demo', studioId: 's1',
    listClients: async () => { calls.push('listClients'); return [1]; },
    getSettings: async () => 'settings',
    upsertClient: async () => { calls.push('upsertClient'); return 1; },
    checkoutCart: async () => 1,
    currentUser: async () => 'me',
    signOut: async () => 'out',
    startPlanCheckout: async () => null,
    subscribe: () => () => {},
    features: { payroll: { listTimesheets: async () => ['t'], saveTimesheet: async () => 1 }, support: { send: async () => 'sent' } },
  } as unknown as DataStore;
  const ro = readOnlyStore(fake) as unknown as Record<string, any>;
  assert.deepEqual(await ro.listClients(), [1]);
  assert.equal(await ro.getSettings(), 'settings');
  assert.equal(await ro.currentUser(), 'me');
  assert.equal(await ro.signOut(), 'out');
  assert.equal(await ro.startPlanCheckout(), null, 'the owner can still sort out billing');
  assert.equal(ro.mode, 'demo');
  await assert.rejects(ro.upsertClient(), { code: 'READ_ONLY' });
  await assert.rejects(ro.checkoutCart(), { code: 'READ_ONLY' });
  assert.deepEqual(await ro.features.payroll.listTimesheets(), ['t']);
  await assert.rejects(ro.features.payroll.saveTimesheet(), { code: 'READ_ONLY' });
  assert.equal(await ro.features.support.send(), 'sent');
  assert.deepEqual(calls, ['listClients'], 'blocked writes never reach the real store');
});

// ------------------------------------------------------------------ the demo platform
async function asAdmin() {
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'admin' });
  await p.demoSignInAs!('pete@studioplatform.example');
  return p;
}
async function ownerOf(p: ReturnType<typeof createDemoPlatform>, slug: string): Promise<DataStore> {
  const s = (await p.findStudio({ slug }))!;
  const store = p.forStudio(s);
  const me = (await store.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'owner')!;
  await store.demoSignInAs!(me);
  return store;
}

test('demo: Snowy is on Signature (comped), Harbour is on a Studio trial, so Harbour has locks', async () => {
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const snowy = (await p.findStudio({ slug: 'snowy' }))!, harbour = (await p.findStudio({ slug: 'harbour' }))!;
  assert.deepEqual([snowy.plan?.name, snowy.billingStatus, snowy.billingComped], ['Signature', 'active', true]);
  assert.deepEqual([harbour.plan?.name, harbour.billingStatus], ['Studio', 'trialing']);
  assert.equal(billingState(harbour, { graceDays: 14 }, NOW).trialDaysLeft, 11);
  const sFeatures = p.forStudio(snowy).features, hFeatures = p.forStudio(harbour).features;
  for (const k of ['payroll', 'commerce', 'appointments', 'ondemand', 'integrations', 'marketing', 'kiosk', 'reviews']) assert.ok((sFeatures as Record<string, unknown>)[k], `Snowy has ${k}`);
  assert.ok(hFeatures.marketing && hFeatures.kiosk && hFeatures.reviews, 'Harbour keeps what Studio includes');
  for (const k of ['payroll', 'commerce', 'appointments', 'ondemand', 'integrations']) assert.equal((hFeatures as Record<string, unknown>)[k], undefined, `Harbour doesn't have ${k}`);
});

test('demo: only platform admins edit plans; the price list is readable; edits reach every studio', async () => {
  const p = await asAdmin();
  const before = await p.listPlans();
  assert.deepEqual(before.map((x) => x.name), ['Studio', 'Studio Plus', 'Signature']);
  const plus = before[1]!;
  const saved = await p.savePlan({ id: plus.id, name: 'Studio Plus', priceCents: 18900, stripePriceId: 'price_1PlusTest', features: [...plus.features.filter((f) => f !== 'payroll')] });
  assert.deepEqual([saved.priceCents, saved.stripePriceId, saved.features.includes('payroll')], [18900, 'price_1PlusTest', false]);
  await assert.rejects(p.savePlan({ id: plus.id, name: 'x', stripePriceId: 'nope' }), { code: 'INVALID' });
  await assert.rejects(p.savePlan({ id: plus.id, name: 'x', features: ['not_a_feature'] }), { code: 'INVALID' });
  await assert.rejects(p.savePlan({ id: plus.id, name: 'x', priceCents: -1 }), { code: 'INVALID' });
  const added = await p.savePlan({ name: 'Studio Max', priceCents: 39900, features: ['payroll'] });
  assert.deepEqual([added.key, added.features], ['studio_max', ['core', 'payroll']]);
  // a studio on Studio Plus sees the edit straight away (plans are data)
  await p.setStudioPlan((await p.findStudio({ slug: 'harbour' }))!.id, { planId: plus.id });
  const harbour = (await p.findStudio({ slug: 'harbour' }))!;
  assert.equal(p.forStudio(harbour).features.payroll, undefined, 'payroll was taken off Studio Plus');
  assert.ok(p.forStudio(harbour).features.commerce);
  await p.signOut();
  await assert.rejects(p.savePlan({ name: 'Sneaky' }), { code: 'AUTH_REQUIRED' });   // signed out
  const owner = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  await ownerOf(owner, 'harbour');
  await assert.rejects(owner.savePlan({ name: 'Sneaky' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(owner.setStudioPlan('studio_snowy', { planId: 'plan_studio' }), { code: 'NOT_ALLOWED' });
  assert.equal((await owner.listPlans()).length, 3, 'a non-admin can still read the price list');
});

test('demo: billing settings (14 or 30 day trial, grace days) and new studios start on a trial', async () => {
  const p = await asAdmin();
  assert.deepEqual(await p.getBillingSettings(), { trialDays: 14, graceDays: 14 });
  await assert.rejects(p.saveBillingSettings({ trialDays: 21 as 14 }), { code: 'INVALID' });
  await assert.rejects(p.saveBillingSettings({ graceDays: 400 }), { code: 'INVALID' });
  await p.saveBillingSettings({ trialDays: 30, graceDays: 7 });
  const s = await p.createStudio({ name: 'Bay Pilates', slug: 'bay', email: 'hi@bay.example' });
  assert.deepEqual([s.plan?.name, s.billingStatus], ['Studio', 'trialing']);
  assert.equal(billingState(s, await p.getBillingSettings(), NOW).trialDaysLeft, 30);
});

test('demo: admin sets a plan by hand (comp), and a studio can be put past due', async () => {
  const p = await asAdmin();
  const harbour = (await p.findStudio({ slug: 'harbour' }))!;
  const sig = (await p.listPlans()).find((x) => x.key === 'signature')!;
  let s = await p.setStudioPlan(harbour.id, { planId: sig.id });
  assert.deepEqual([s.plan?.name, s.billingStatus, s.billingComped], ['Signature', 'active', true]);
  assert.ok(p.forStudio(s).features.payroll, 'Signature switches the feature stores on');
  s = await p.setStudioPlan(harbour.id, { planId: sig.id, status: 'past_due', comped: false });
  assert.ok(s.pastDueSince);
  assert.equal(billingState(s, { graceDays: 14 }, NOW).banner, 'past_due');
  await assert.rejects(p.setStudioPlan(harbour.id, { planId: 'plan_nope' }), { code: 'NOT_FOUND' });
  await assert.rejects(p.setStudioPlan(harbour.id, { planId: sig.id, status: 'weird' as 'active' }), { code: 'INVALID' });
  assert.equal(mrrCents((await p.listStudios({ includeAll: true }))), 29900, 'MRR counts the paying (not comped) Signature studio');
});

test('demo: the owner sees and changes their own plan; nobody else can', async () => {
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const store = await ownerOf(p, 'harbour');
  const info = await store.getBilling();
  assert.deepEqual([info.enabled, info.status, info.comped, info.hasSubscription], [true, 'trialing', false, false]);
  assert.equal((await store.listPlans()).length, 3);
  assert.equal(await store.startPlanCheckout('plan_studio_plus', 'https://x/'), null, 'demo: no Stripe to visit, it just switches');
  const after = await store.getBilling();
  assert.deepEqual([after.status, after.planId, after.hasSubscription], ['active', 'plan_studio_plus', true]);
  assert.ok(store.features.payroll, 'and the locked features come on');
  await assert.rejects(store.startPlanCheckout('plan_nope', 'x'), { code: 'NOT_FOUND' });
  const other = (await store.demoPersonas()).find((u) => u.kind === 'staff' && u.role !== 'owner')!;
  await store.demoSignInAs!(other);
  await assert.rejects(store.getBilling(), { code: 'NOT_ALLOWED' });
  await assert.rejects(store.startPlanCheckout('plan_studio', 'x'), { code: 'NOT_ALLOWED' });
  // Snowy: billing is off in the app (single studio)
  const snowy = await ownerOf(p, 'snowy');
  assert.equal((await snowy.getBilling()).enabled, false);
});

test('an older saved demo (no plans yet) is upgraded in place, keeping its studios', async () => {
  const storage = memoryStorage();
  const first = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage, app: 'studio' });
  await first.listStudios();
  const raw = JSON.parse(storage.getItem('spc-demo-v4')!);
  delete raw.plans; delete raw.billingSettings;
  for (const s of raw.studios) { delete s.planId; delete s.plan; delete s.billingStatus; delete s.trialEndsAt; delete s.billingComped; }
  storage.setItem('spc-demo-v4', JSON.stringify(raw)); storage.setItem('spc-demo-v4:rev', 'other');
  const again = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage, app: 'studio' });
  const list = await again.listStudios();
  assert.deepEqual(list.map((s) => [s.slug, s.plan?.name, s.billingStatus]).sort(), [['harbour', 'Studio', 'trialing'], ['snowy', 'Signature', 'active']]);
});
