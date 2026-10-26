// Visual + console pass for Appointments: client at 390 (book a private, sign up to a workshop, mine), studio at 1024 (calendar, events, hours, settings).
//   node build.mjs && python3 -m http.server 4306 -d dist &   node tests/appointments-explore.mjs screenshots/appointments snowy
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/appointments').replace(/\/?$/, '/');
const slug = process.argv[3] || 'snowy';
const BASE = process.env.BASE || 'http://localhost:4306';
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

// ---- client, 390
const c = await ctx.newPage(); watch(c, 'client');
await c.setViewportSize({ width: 390, height: 844 });
await c.goto(`${BASE}/?studio=${slug}`);
await c.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await c.locator('.demo-box .list-row').nth(1).click();
await c.waitForTimeout(1200);
say('timetable banner: ' + (await c.locator('.ap-promo', { hasText: 'Privates' }).count()));
await c.evaluate(() => { location.hash = '/appointments'; });
await c.waitForSelector('.ap-card', { timeout: 8000 });
await c.waitForTimeout(500);
await c.screenshot({ path: `${OUT}${slug}-client-book-390.png`, fullPage: true });
await c.locator('.ap-card').first().click();
await c.waitForSelector('.ap-slot', { timeout: 8000 });
await c.waitForTimeout(500);
await c.locator('.ap-slot').first().click();
await c.waitForTimeout(400);
await c.screenshot({ path: `${OUT}${slug}-client-slots-390.png` });
await c.getByRole('button', { name: /Continue to pay|Book with/ }).click();
await c.waitForTimeout(500);
if (await c.getByRole('button', { name: /^Pay / }).count()) await c.getByRole('button', { name: /^Pay / }).click();
await c.waitForSelector('.success', { timeout: 8000 });
say('private booked: ' + (await c.locator('.success h2').innerText()));
await c.screenshot({ path: `${OUT}${slug}-client-booked-390.png` });
await c.getByRole('button', { name: 'See my bookings' }).click();
await c.waitForTimeout(600);
say('mine shows it: ' + (await c.locator('.list-row', { hasText: 'Coming up' }).count() + await c.locator('.group-label', { hasText: 'Coming up' }).count()));
await c.screenshot({ path: `${OUT}${slug}-client-mine-390.png`, fullPage: true });
await c.getByRole('tab', { name: /Events/ }).click();
await c.waitForSelector('.ap-card');
await c.waitForTimeout(400);
await c.screenshot({ path: `${OUT}${slug}-client-events-390.png`, fullPage: true });
await c.locator('.ap-card').first().click();
await c.waitForTimeout(700);
await c.screenshot({ path: `${OUT}${slug}-client-event-sheet-390.png` });
const signup = c.getByRole('button', { name: /Sign up for|Save my spot/ });
if (await signup.count()) {
  await signup.click(); await c.waitForTimeout(500);
  if (await c.getByRole('button', { name: /^Pay / }).count()) await c.getByRole('button', { name: /^Pay / }).click();
  await c.waitForSelector('.success', { timeout: 8000 });
  say('workshop: ' + (await c.locator('.success h2').innerText()));
  await c.screenshot({ path: `${OUT}${slug}-client-event-done-390.png` });
} else say('workshop: no sign-up button (already in?)');

// ---- studio, 1024
const s = await ctx.newPage(); watch(s, 'studio');
await s.goto(`${BASE}/studio/?studio=${slug}`);
await s.waitForSelector('.persona');
await s.locator('.persona', { hasText: process.argv[4] || 'Libby' }).first().click();
await s.waitForSelector('.today .stats');
const go = async (h, wait = 800) => { await s.evaluate((x) => { location.hash = x; }, h); await s.waitForTimeout(wait); };
await go('/appointments', 1000);
await s.screenshot({ path: `${OUT}${slug}-studio-calendar-1024.png`, fullPage: true });
say('calendar blocks: ' + (await s.locator('.ap-ev.booked, .ap-ev.completed').count()));
const blocks = s.locator('button.ap-ev');
if (await blocks.count()) { await blocks.first().click(); await s.waitForTimeout(600); await s.screenshot({ path: `${OUT}${slug}-studio-appt-sheet-1024.png` }); await s.keyboard.press('Escape'); await s.waitForTimeout(400); }
await s.getByRole('button', { name: 'Book a client' }).click(); await s.waitForTimeout(600);
await s.locator('.cs-row').first().click(); await s.waitForTimeout(900);
await s.screenshot({ path: `${OUT}${slug}-studio-book-sheet-1024.png` });
await s.keyboard.press('Escape'); await s.waitForTimeout(400);
await go('/appointments/events', 900);
await s.screenshot({ path: `${OUT}${slug}-studio-events-1024.png`, fullPage: true });
await s.locator('.ap-ecard').first().click(); await s.waitForTimeout(800);
await s.screenshot({ path: `${OUT}${slug}-studio-event-sheet-1024.png` });
await s.keyboard.press('Escape'); await s.waitForTimeout(400);
await go('/appointments/hours', 900);
await s.screenshot({ path: `${OUT}${slug}-studio-hours-1024.png`, fullPage: true });
await go('/settings/appointments', 1000);
await s.screenshot({ path: `${OUT}${slug}-studio-settings-1024.png`, fullPage: true });
await go('/', 900);
say('today widget: ' + (await s.locator('h3', { hasText: 'privates' }).count()));
console.log('errors:', errs);
await browser.close();
