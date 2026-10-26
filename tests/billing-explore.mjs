// Visual + console pass for plans and billing in the demo at 1024:
//   Harbour (Studio trial): Settings -> Plan & billing, a locked feature's upsell; platform admin: the plans editor.
//   node build.mjs && python3 -m http.server 4307 -d dist &   node tests/billing-explore.mjs screenshots/billing
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/billing').replace(/\/?$/, '/');
const BASE = process.env.BASE || 'http://localhost:4307';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
await localFonts(ctx);
const errs = [];
const watch = (p) => { p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(m.text()); }); p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`)); };
const top = async (p) => { await p.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('*').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); }); await p.waitForTimeout(400); };

const s = await ctx.newPage(); watch(s);
await s.goto(`${BASE}/studio/?studio=harbour`);
await s.waitForSelector('.persona', { timeout: 8000 });
await s.locator('.persona', { hasText: 'Ava' }).first().click();
await s.waitForSelector('.today .stats', { timeout: 8000 });
await s.evaluate(() => { location.hash = '/settings/plan'; });
await s.waitForSelector('[data-testid="plan-panel"]', { timeout: 8000 });
console.log('plan: ' + (await s.locator('[data-testid="plan-panel"]').innerText()).replace(/\s+/g, ' ').slice(0, 300));
await top(s); await s.screenshot({ path: `${OUT}plan-and-billing-1024.png` });
await s.evaluate(() => { location.hash = '/payroll'; });
await s.waitForSelector('[data-testid="upsell"]', { timeout: 8000 });
await s.getByText('Studio Plus', { exact: false }).first().waitFor({ timeout: 5000 });
console.log('upsell: ' + (await s.locator('[data-testid="upsell"]').innerText()).replace(/\s+/g, ' '));
await top(s); await s.screenshot({ path: `${OUT}locked-feature-upsell-1024.png` });

const a = await ctx.newPage(); watch(a);
await a.goto(`${BASE}/admin/`);
await a.getByRole('button', { name: /Sign in as/ }).first().click();
await a.waitForSelector('.ad-nav, nav, .admin-nav', { timeout: 8000 });
await a.evaluate(() => { location.hash = '/plans'; });
await a.getByText(/MRR/i).first().waitFor({ timeout: 8000 });
await a.getByText(/1 trialing/).first().waitFor({ timeout: 5000 });
console.log('plans: ' + (await a.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300));
await top(a); await a.screenshot({ path: `${OUT}admin-plans-1024.png` });
await browser.close();
console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
process.exit(errs.length ? 1 : 0);
