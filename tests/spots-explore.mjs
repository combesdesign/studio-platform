// Visual + console pass for spot (mat / reformer) selection:
//   Harbour client at 390 (Book -> the spot picker -> booked in a chosen spot -> shown in Bookings), Harbour studio at 1024 (roster map, spot
//   chips, move a spot, the layout editor in Settings > Locations & rooms). Snowy: no picker, no map, no layout UI in the class sheet.
//   node build.mjs && python3 -m http.server 4308 -d dist &   node tests/spots-explore.mjs screenshots/spots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/spots').replace(/\/?$/, '/');
const BASE = process.env.BASE || 'http://localhost:4308';
const EXTRA = process.env.EXTRA || '/tmp/claude-0/spots-extra/';
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

// ---- Harbour client at 390: book, pick a spot
const c = await ctx.newPage(); watch(c, 'harbour client');
await c.setViewportSize({ width: 390, height: 844 });
await c.goto(`${BASE}/?studio=harbour`);
await c.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await c.locator('.demo-box .list-row').nth(1).click();   // Jack: 2 a week member
await c.waitForSelector('.strip-day', { timeout: 8000 });
let opened = false;
for (let d = 2; d < 6 && !opened; d++) {
  await c.locator('.strip-day').nth(d).click(); await c.waitForTimeout(400);
  for (const i of [0, 1, 2]) {
    if (i >= await c.locator('.cls').count()) break;
    await c.locator('.cls').nth(i).click();
    await c.waitForSelector('.cs-foot', { timeout: 5000 });
    if (await c.getByRole('button', { name: /Book this class/ }).count()) { opened = true; break; }
    await c.keyboard.press('Escape'); await c.waitForTimeout(300);
  }
}
assert.ok(opened, 'found a class Jack can book');
await c.getByRole('button', { name: /Book this class/ }).click();
await c.waitForSelector('.spot-step .spot-grid', { timeout: 5000 });
const free = await c.locator('.spot-step .spot-cell.free').count(), taken = await c.locator('.spot-step .spot-cell.taken').count();
say(`picker: ${free} free, ${taken} taken, ${await c.locator('.spot-step .spot-cell.instructor').count()} instructor`);
assert.ok(free >= 1 && await c.locator('.spot-step .spot-cell.instructor').count() === 1);
assert.match(await c.locator('.spot-step .btn.big').innerText(), /Pick for me/, 'Pick for me is the default');
// the grid must fit the phone without sideways scrolling
const fits = await c.evaluate(() => { const w = document.querySelector('.spot-step .spot-wrap'); return w.scrollWidth <= w.clientWidth + 1; });
assert.ok(fits, 'the spot grid fits at 390');
const tgt = c.locator('.spot-step .spot-cell.free').last();
const spotNo = (await tgt.locator('.spot-n').innerText()).trim();
await tgt.click();
assert.match(await c.locator('.spot-step .btn.big').innerText(), new RegExp(`Book spot ${spotNo}`), 'the button names the chosen spot');
await c.waitForTimeout(250);
await c.screenshot({ path: `${OUT}client-spot-picker-harbour-390.png` });
await c.locator('.spot-step .btn.big').click();
await c.waitForSelector('.success-spot', { timeout: 5000 });
assert.match(await c.locator('.success-spot').innerText(), new RegExp(`spot ${spotNo}`, 'i'));
say('booked: ' + (await c.locator('.success-spot').innerText()));
await c.getByRole('button', { name: 'Done' }).click();
// Bookings shows the spot (hash routing)
await c.evaluate(() => { location.hash = '/bookings'; });
await c.waitForSelector('.bk', { timeout: 5000 });
const spots = await c.locator('.bk-spot').allInnerTexts();
say('bookings show: ' + spots.join(' | '));
assert.ok(spots.some((t) => t.includes(`Spot ${spotNo}`)));
// change it
await c.locator('.bk', { has: c.locator('.bk-spot', { hasText: `Spot ${spotNo}` }) }).first().click();
await c.waitForSelector('.spot-using', { timeout: 5000 });
await c.locator('.spot-using .btn', { hasText: 'Change' }).click();
await c.waitForSelector('.spot-step .spot-cell.mine');
const other = c.locator('.spot-step .spot-cell.free').first();
const otherNo = (await other.locator('.spot-n').innerText()).trim();
await other.click();
await c.locator('.spot-step .btn.big').click();
await c.waitForFunction((n) => document.querySelector('.spot-using')?.textContent?.toLowerCase().includes(`spot ${n}`), otherNo, { timeout: 5000 });
say(`changed to spot ${otherNo}`);

// ---- Harbour studio at 1024: roster
const s = await ctx.newPage(); watch(s, 'harbour studio');
await s.goto(`${BASE}/studio/?studio=harbour`);
await s.waitForSelector('.persona', { timeout: 8000 });
await s.locator('.persona', { hasText: 'Ava' }).first().click();
await s.waitForSelector('.today .stats', { timeout: 8000 });
await s.evaluate(() => { location.hash = '/schedule'; });
await s.waitForSelector('.week .wc');
let found = false;
const n = await s.locator('.week .wc').count();
for (let i = n - 1; i >= Math.max(0, n - 30) && !found; i--) {   // later classes first: the move needs one that hasn't finished
  await s.locator('.week .wc').nth(i).click();
  await s.waitForSelector('.roster', { timeout: 5000 }).catch(() => undefined);
  await s.waitForTimeout(350);
  if (await s.locator('.rs-map').count() && await s.locator('.spot-chip').count() >= 2) { found = true; break; }
  await s.evaluate(() => history.back()); await s.waitForSelector('.week .wc', { timeout: 5000 });
}
assert.ok(found, 'a roster with a map and spot chips');
say(`roster: ${await s.locator('.spot-chip').count()} spot chips; map: ${(await s.locator('.rs-map-head').innerText()).replace(/\s+/g, ' ')}`);
await s.waitForTimeout(300);
await s.screenshot({ path: `${OUT}roster-spots-harbour-1024.png` });
// move someone
const first = s.locator('.rrow .rr-who').first();
const who = (await first.locator('strong').innerText()).trim();
await first.click();
await s.getByRole('button', { name: /Move spot|Give a spot/ }).click();
await s.waitForSelector('.sheet .spot-grid');
const dest = s.locator('.sheet .spot-cell.free').first();
const destNo = (await dest.locator('.spot-n').innerText()).trim();
await dest.click();
await s.getByRole('button', { name: /^(Move|Give spot)$/ }).click();
await s.waitForTimeout(600);
const chips = await s.locator('.rrow', { hasText: who }).first().locator('.spot-chip').innerText();
say(`moved ${who} to spot ${destNo}: chip now "${chips}"`);
assert.equal(chips.trim(), `Spot ${destNo}`);
// the walk-in sheet offers a spot
await s.getByRole('button', { name: /Walk-in/ }).click();
await s.waitForSelector('.sl-staff', { timeout: 5000 });
await s.locator('.sl-staff .pill', { hasText: 'Choose a spot' }).click();
await s.waitForSelector('.sl-staff .spot-grid');
say('walk-in sheet offers: ' + (await s.locator('.sl-staff .pill').allInnerTexts()).join(' | '));
await s.screenshot({ path: `${EXTRA}walkin-spot-1024.png` });
await s.keyboard.press('Escape');
// layout editor
await s.evaluate(() => { location.hash = '/settings/locations'; });
await s.waitForSelector('.loc-card');
await s.locator('.loc-room', { hasText: 'Studio A' }).click();
await s.waitForSelector('.sl-editor .spot-grid');
const meta = await s.locator('.sl-editor').innerText();
say('layout editor: ' + meta.replace(/\s+/g, ' ').slice(0, 140));
await s.locator('.sl-tool', { hasText: 'Not available' }).click();
await s.locator('.sl-editor .spot-cell.edit.spot').first().click();
assert.match(await s.locator('.sl-foot').innerText(), /7 spots/, 'making a spot unavailable renumbers: 7 left');
await s.waitForTimeout(300);
await s.screenshot({ path: `${EXTRA}layout-editor-1024.png` });
await s.keyboard.press('Escape');

// ---- Snowy: nothing changes
const sc = await ctx.newPage(); watch(sc, 'snowy client');
await sc.setViewportSize({ width: 390, height: 844 });
await sc.goto(`${BASE}/?studio=snowy`);
await sc.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await sc.locator('.demo-box .list-row').nth(1).click();
await sc.waitForSelector('.cls', { timeout: 8000 });
await sc.locator('.cls').first().click();
await sc.waitForSelector('.cs-foot');
if (await sc.getByRole('button', { name: /Book this class/ }).count()) await sc.getByRole('button', { name: /Book this class/ }).click();
await sc.waitForTimeout(600);
assert.equal(await sc.locator('.spot-grid, .spot-step, .spot-using').count(), 0, 'Snowy client: no spot picker');
const ss = await ctx.newPage(); watch(ss, 'snowy studio');
await ss.goto(`${BASE}/studio/?studio=snowy`);
await ss.waitForSelector('.persona', { timeout: 8000 });
await ss.locator('.persona').first().click();
await ss.waitForSelector('.today .stats', { timeout: 8000 });
await ss.evaluate(() => { location.hash = '/schedule'; });
await ss.waitForSelector('.week .wc');
await ss.locator('.week .wc').first().click();
await ss.waitForSelector('.roster');
await ss.waitForTimeout(400);
assert.equal(await ss.locator('.rs-map, .spot-chip').count(), 0, 'Snowy roster: no map or spot chips');
say('snowy: no spot UI on the client or the roster');
await browser.close();
console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
process.exit(errs.length ? 1 : 0);
