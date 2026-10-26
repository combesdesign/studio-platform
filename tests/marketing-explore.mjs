// Quick visual + console pass for Marketing: studio at 1024 (campaigns, automations, audiences, inbox, settings) and the client inbox at 390.
//   node build.mjs && python3 -m http.server 4305 -d dist &   node tests/marketing-explore.mjs screenshots/marketing snowy
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/marketing').replace(/\/?$/, '/');
const slug = process.argv[3] || 'snowy';
const BASE = process.env.BASE || 'http://localhost:4305';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
await localFonts(ctx);
const errs = [];
const watch = (p, tag) => {
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(`${tag}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e.message}`));
};
const say = (m) => console.log(m);

// ---- studio, 1024
const s = await ctx.newPage(); watch(s, 'studio');
await s.goto(`${BASE}/studio/?studio=${slug}`);
await s.waitForSelector('.persona');
await s.locator('.persona', { hasText: process.argv[4] || 'Libby' }).first().click();
await s.waitForSelector('.today .stats');
const go = async (h, wait = 700) => { await s.evaluate((x) => { location.hash = x; }, h); await s.waitForTimeout(wait); };
await go('/marketing/campaigns', 1000);
await s.screenshot({ path: `${OUT}${slug}-studio-campaigns-1024.png`, fullPage: true });
await s.locator('.mk-row').first().click(); await s.waitForTimeout(700);
await s.screenshot({ path: `${OUT}${slug}-studio-campaign-sheet-1024.png` });
await s.keyboard.press('Escape'); await s.waitForTimeout(400);
await go('/marketing/automations', 900);
await s.screenshot({ path: `${OUT}${slug}-studio-automations-1024.png`, fullPage: true });
await s.getByRole('button', { name: /Who’s next/ }).click(); await s.waitForTimeout(800);
await s.screenshot({ path: `${OUT}${slug}-studio-whos-next-1024.png` });
await s.keyboard.press('Escape'); await s.waitForTimeout(400);
await go('/marketing/audiences', 900);
await s.screenshot({ path: `${OUT}${slug}-studio-audiences-1024.png`, fullPage: true });
await go('/marketing/inbox', 900);
await s.screenshot({ path: `${OUT}${slug}-studio-inbox-1024.png`, fullPage: true });
await s.locator('.mk-thread').first().click(); await s.waitForTimeout(800);
await s.screenshot({ path: `${OUT}${slug}-studio-thread-1024.png`, fullPage: true });
await go('/settings/marketing', 900);
await s.screenshot({ path: `${OUT}${slug}-studio-settings-1024.png`, fullPage: true });

// ---- client, 390
const c = await ctx.newPage(); watch(c, 'client');
await c.setViewportSize({ width: 390, height: 844 });
await c.goto(`${BASE}/?studio=${slug}`);
await c.waitForTimeout(800);
await c.waitForSelector('.demo-box .list-row', { timeout: 8000 }).catch(() => {});
const personas = c.locator('.demo-box .list-row');
say('client personas: ' + (await personas.count()));
if (await personas.count()) await personas.first().click();
await c.waitForTimeout(1200);
await c.evaluate(() => { location.hash = '/messages'; });
await c.waitForSelector('.mk-chat', { timeout: 8000 });
await c.waitForTimeout(700);
await c.screenshot({ path: `${OUT}${slug}-client-messages-390.png`, fullPage: true });
await c.locator('.mk-compose textarea').fill('Hi! Is there a class this Saturday for beginners?');
await c.locator('.mk-compose button').click();
await c.waitForSelector('.mk-bubble.mine >> text=Saturday', { timeout: 5000 });
await c.waitForTimeout(500);
await c.screenshot({ path: `${OUT}${slug}-client-messages-sent-390.png`, fullPage: true });
// the studio sees it (demo state syncs between tabs)
await s.waitForTimeout(600);
await go('/marketing/inbox', 900);
say('studio inbox shows the new message: ' + (await s.locator('.mk-thread-prev', { hasText: 'Saturday' }).count() > 0));
console.log('errors:', errs);
await browser.close();
process.exit(errs.length ? 1 : 0);
