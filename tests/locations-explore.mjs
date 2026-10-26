// Visual + console pass for multi-location and rooms:
//   Harbour (Bondi + Surry Hills): client timetable with the location filter at 390, studio Settings > Locations & rooms at 1024,
//   the schedule filter and the room clash warning. Snowy (one location): none of it shows.
//   node build.mjs && python3 -m http.server 4307 -d dist &   node tests/locations-explore.mjs screenshots/locations
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/locations').replace(/\/?$/, '/');
const BASE = process.env.BASE || 'http://localhost:4307';
const EXTRA = process.env.EXTRA || '/tmp/claude-0/locations-extra/';
mkdirSync(OUT, { recursive: true }); mkdirSync(EXTRA, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
await localFonts(ctx);
const errs = [];
const watch = (p, tag) => {
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(`${tag}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e.message}`));
};
const say = (m) => console.log(m);

// ---- Harbour client at 390
const c = await ctx.newPage(); watch(c, 'harbour client');
await c.setViewportSize({ width: 390, height: 844 });
await c.goto(`${BASE}/?studio=harbour`);
await c.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await c.locator('.demo-box .list-row').nth(1).click();
await c.waitForSelector('.loc-chips', { timeout: 8000 });
const chips = await c.locator('.loc-chip').allInnerTexts();
say('client filter: ' + chips.join(' | '));
assert.deepEqual(chips, ['All locations', 'Bondi', 'Surry Hills']);
// find a day with classes at both places, then filter
const strip = c.locator('.strip-day');
let both = false;
for (let i = 0; i < Math.min(await strip.count(), 8) && !both; i++) {
  await strip.nth(i).click(); await c.waitForTimeout(500);
  const where = new Set(await c.locator('.cls-where').allInnerTexts());
  both = where.has('Bondi') && where.has('Surry Hills');
}
assert.ok(both, 'a day with classes at both locations');
const all = await c.locator('.cls').count();
await c.getByRole('button', { name: 'Surry Hills', exact: true }).click(); await c.waitForTimeout(300);
const sh = await c.locator('.cls-where').allInnerTexts();
say(`Surry Hills only: ${sh.length} of ${all} classes`);
assert.ok(sh.length > 0 && sh.length < all && sh.every((t) => t === 'Surry Hills'));
await c.reload(); await c.waitForSelector('.loc-chips');
assert.equal(await c.locator('.loc-chip[aria-pressed="true"]').innerText(), 'Surry Hills', 'the filter is remembered on this device');
await c.waitForSelector('.cls'); await c.waitForTimeout(500);
await c.screenshot({ path: `${OUT}client-timetable-filter-harbour-390.png` });
await c.locator('.cls').first().click();
await c.waitForSelector('.cs-dir', { timeout: 5000 });
const dir = await c.locator('.cs-dir').getAttribute('href');
say('directions: ' + dir + ' · ' + (await c.locator('.cs-where').innerText()).replace(/\s+/g, ' '));
assert.match(dir, /google\.com\/maps\/dir|maps\.apple\.com/);
assert.match(dir, /Crown%20Street/);
await c.screenshot({ path: `${EXTRA}client-class-sheet-390.png` });

// ---- Harbour studio at 1024
const s = await ctx.newPage(); watch(s, 'harbour studio');
await s.goto(`${BASE}/studio/?studio=harbour`);
await s.waitForSelector('.persona', { timeout: 8000 });
await s.locator('.persona', { hasText: 'Ava' }).first().click();
await s.waitForSelector('.today .stats', { timeout: 8000 });
assert.ok(await s.locator('.sec-head .loc-seg').count(), 'Today has the location filter');
await s.evaluate(() => { location.hash = '/settings/locations'; });
await s.waitForSelector('.loc-card', { timeout: 8000 });
const cards = await s.locator('.loc-card').count();
say('settings: ' + cards + ' locations · ' + (await s.locator('.loc-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 160));
assert.equal(cards, 2);
await s.waitForTimeout(400);
await s.screenshot({ path: `${OUT}settings-locations-harbour-1024.png` });
// schedule: filter, then the clash warning in the weekly class editor
await s.evaluate(() => { location.hash = '/schedule'; });
await s.waitForSelector('.week .wc');
const before = await s.locator('.wc').count();
await s.locator('.wk-nav .loc-seg button', { hasText: 'Surry Hills' }).click(); await s.waitForTimeout(300);
const after = await s.locator('.wc').count();
say(`schedule: ${before} classes, ${after} at Surry Hills`);
assert.ok(after > 0 && after < before);
await s.evaluate(() => { location.hash = '/schedule/timetable'; });
await s.waitForSelector('.tt-row');
await s.getByRole('button', { name: /Add weekly class/ }).click();
await s.waitForSelector('.room-field select');
const roomSel = s.locator('.room-field select');
const opt = await roomSel.locator('option', { hasText: 'Studio A' }).getAttribute('value');
await roomSel.selectOption(opt);
await s.locator('input[type="time"]').first().fill('06:00');
await s.waitForSelector('.room-warn', { timeout: 5000 });
say('clash warning: ' + (await s.locator('.room-warn').innerText()));
assert.ok(await s.getByRole('button', { name: 'Save' }).isDisabled(), 'Save is off while the room is taken');
await s.screenshot({ path: `${EXTRA}template-clash-1024.png` });
await s.locator('input[type="time"]').first().fill('15:00');
await s.waitForFunction(() => !document.querySelector('.room-warn'));
say('moved to 3pm: the warning goes');
await s.evaluate(() => { location.hash = '/reports'; });
await s.waitForSelector('.toolbar .loc-seg');
say('reports has the location filter');

// ---- Snowy: nothing about locations
const sc = await ctx.newPage(); watch(sc, 'snowy client');
await sc.setViewportSize({ width: 390, height: 844 });
await sc.goto(`${BASE}/?studio=snowy`);
await sc.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await sc.locator('.demo-box .list-row').nth(1).click();
await sc.waitForSelector('.cls', { timeout: 8000 });
assert.equal(await sc.locator('.loc-chips, .cls-where').count(), 0, 'Snowy client: no location UI');
await sc.locator('.cls').first().click();
await sc.waitForSelector('.cs-facts');
assert.equal(await sc.locator('.cs-where, .cs-dir').count(), 0, 'Snowy class sheet: no directions row');
const ss = await ctx.newPage(); watch(ss, 'snowy studio');
await ss.goto(`${BASE}/studio/?studio=snowy`);
await ss.waitForSelector('.persona', { timeout: 8000 });
await ss.locator('.persona').first().click();
await ss.waitForSelector('.today .stats', { timeout: 8000 });
await ss.evaluate(() => { location.hash = '/schedule'; });
await ss.waitForSelector('.week .wc');
assert.equal(await ss.locator('.loc-seg, .wc-place').count(), 0, 'Snowy schedule: no location filter');
await ss.evaluate(() => { location.hash = '/schedule/timetable'; });
await ss.waitForSelector('.tt-row');
await ss.getByRole('button', { name: /Add weekly class/ }).click();
await ss.waitForSelector('.sh-foot');
assert.equal(await ss.locator('.room-field').count(), 0, 'Snowy weekly editor: no room picker');
say('snowy: no location UI anywhere (settings tabs: ' + (await (async () => { await ss.keyboard.press('Escape'); await ss.evaluate(() => { location.hash = '/settings/studio'; }); await ss.waitForSelector('.settings .tabs a'); return (await ss.locator('.settings .tabs a').allInnerTexts()).join(', '); })()) + ')');
await browser.close();
console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
process.exit(errs.length ? 1 : 0);
