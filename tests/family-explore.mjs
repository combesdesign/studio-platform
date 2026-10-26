// Visual + console pass for Family accounts: client at 390 (Family screen, "Who's coming?" picker), studio at 1024 (roster with "via <parent>").
//   node build.mjs && python3 -m http.server 4307 -d dist &   node tests/family-explore.mjs screenshots/family snowy
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/family').replace(/\/?$/, '/');
const slug = process.argv[3] || 'snowy';
const BASE = process.env.BASE || 'http://localhost:4307';
const EXTRA = process.env.EXTRA || '/tmp/claude-0/family-extra/';   // shots we look at but don't keep
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

// ---- client, 390: Sophie (a mum with baby Poppy)
const c = await ctx.newPage(); watch(c, 'client');
await c.setViewportSize({ width: 390, height: 844 });
await c.goto(`${BASE}/?studio=${slug}`);
await c.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await c.locator('.demo-box .list-row', { hasText: 'Poppy' }).click();
await c.waitForTimeout(1200);
await c.evaluate(() => { location.hash = '/family'; });
await c.waitForSelector('.fam-card', { timeout: 8000 });
await c.waitForTimeout(400);
say('family cards: ' + (await c.locator('.fam-card').count()) + ' · ' + (await c.locator('.fam-card strong').first().innerText()));
await c.screenshot({ path: `${EXTRA}family-screen-390.png`, fullPage: true });
// add a dependant, then remove them again
await c.getByRole('button', { name: /Add someone/ }).click();
await c.waitForSelector('input.input[required]');
await c.locator('input.input[required]').fill('Ollie');
await c.getByRole('button', { name: 'Add to my family' }).click();
await c.waitForFunction(() => document.querySelectorAll('.fam-card').length === 2, null, { timeout: 5000 });
say('added Ollie: ' + (await c.locator('.fam-card').count()) + ' cards');
await c.getByRole('button', { name: 'Edit Ollie' }).click();
await c.getByRole('button', { name: 'Remove Ollie' }).click();
await c.getByRole('button', { name: /Yes, remove Ollie/ }).click();
await c.waitForFunction(() => document.querySelectorAll('.fam-card').length === 1, null, { timeout: 5000 });
say('removed Ollie: back to ' + (await c.locator('.fam-card').count()) + ' card');
// the picker on a class
await c.evaluate(() => { location.hash = '/'; });
await c.waitForSelector('.strip-day', { timeout: 8000 });
await c.locator('.strip-day').nth(2).click();   // two days on, so the class is still to come
await c.waitForSelector('.cls-main', { timeout: 8000 });
await c.locator('.cls-main', { hasText: 'Mat' }).first().click();

await c.waitForSelector('.picker.who', { timeout: 8000 });
await c.waitForTimeout(500);
say('picker options: ' + (await c.locator('.picker.who .picker-opt').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ')).join(' | '));
await c.locator('.picker.who .picker-opt').nth(1).click();
await c.waitForTimeout(300);
await c.waitForTimeout(3200);   // let the "removed" toast go
await c.screenshot({ path: `${OUT}client-picker-390.png` });

// ---- studio, 1024: the roster shows Poppy under her own name with "via Sophie Archer"
const s = await ctx.newPage(); watch(s, 'studio');
await s.setViewportSize({ width: 1024, height: 768 });
await s.goto(`${BASE}/studio/?studio=${slug}`);
await s.waitForSelector('.persona', { timeout: 8000 });
await s.locator('.persona', { hasText: 'Libby' }).first().click();
await s.waitForSelector('.today .stats', { timeout: 8000 });
await s.evaluate(() => { location.hash = '/clients'; });
await s.waitForTimeout(500);
await s.getByPlaceholder(/Search/i).first().fill('poppy');
await s.waitForTimeout(500);
say('clients search "poppy": ' + (await s.locator('.list-row, tr').filter({ hasText: 'Poppy' }).count()) + ' hit(s), tag: ' + (await s.locator('text=/via Sophie/').count()));
await s.screenshot({ path: `${EXTRA}studio-clients-1024.png` });
await s.getByText('Poppy Archer').first().click();
await s.waitForTimeout(800);
await s.screenshot({ path: `${EXTRA}studio-client-1024.png`, fullPage: true });
await s.getByText('Mums + Bubs').first().click();
await s.waitForSelector('.rr-t', { timeout: 8000 });
await s.waitForTimeout(500);
say('roster via tags: ' + (await s.locator('.via-tag').allInnerTexts()).join(', '));
await s.screenshot({ path: `${OUT}studio-roster-1024.png` });

await browser.close();
say(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
process.exit(errs.length ? 1 : 0);
