// End-to-end messaging check in the demo: client (390) sends, Libby (1024) sees it and replies, client sees the reply,
// Libby starts a new message from a client's profile. Unread counts on both sides, no console errors.
//   node build.mjs && python3 -m http.server 4305 -d dist &   node tests/messaging-explore.mjs screenshots/messaging snowy
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/messaging').replace(/\/?$/, '/');
const slug = process.argv[3] || 'snowy';
const BASE = process.env.BASE || 'http://localhost:4305';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
await localFonts(ctx);
const errs = [], fails = [];
const watch = (p, tag) => {
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(`${tag}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e.message}`));
};
const check = (name, ok) => { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) fails.push(name); };

const s = await ctx.newPage(); watch(s, 'studio');
await s.goto(`${BASE}/studio/?studio=${slug}`);
await s.waitForSelector('.persona');
await s.locator('.persona', { hasText: 'Libby' }).first().click();
await s.waitForSelector('.today .stats');
const go = async (h, wait = 700) => { await s.evaluate((x) => { location.hash = x; }, h); await s.waitForTimeout(wait); };
await go('/marketing/inbox', 900);
const badge0 = await s.locator('.mk-page .tabs .mk-badge').count();

const c = await ctx.newPage(); watch(c, 'client');
await c.setViewportSize({ width: 390, height: 844 });
await c.goto(`${BASE}/?studio=${slug}`);
await c.waitForSelector('.demo-box .list-row', { timeout: 8000 });
await c.locator('.demo-box .list-row').first().click();
await c.waitForTimeout(1200);
// Profile tab, then Messages
await c.locator('nav a, nav button, .tabbar a, .tabbar button', { hasText: 'Profile' }).first().click();
await c.waitForTimeout(600);
await c.locator('button.list-row', { hasText: 'Messages' }).click();
await c.waitForSelector('.mk-chat');
const msg = 'Hi! Is there a beginners class this Saturday?';
await c.locator('.mk-compose textarea').fill(msg);
await c.locator('.mk-compose button').click();
await c.waitForSelector(`.mk-bubble.mine >> text=Saturday`, { timeout: 5000 });
check('client sees own message', true);

// studio side
await s.waitForTimeout(800);
const badge1 = await s.locator('.mk-page .tabs .mk-badge').first().textContent().catch(() => null);
check(`studio Inbox tab badge appears (was ${badge0 ? 'present' : 'none'}, now ${badge1})`, !!badge1 && Number(badge1) >= 1);
check('studio thread list shows the message', (await s.locator('.mk-thread.unread .mk-thread-prev', { hasText: 'Saturday' }).count()) > 0);
await s.screenshot({ path: `${OUT}studio-inbox-unread-1024.png` });
const thr = s.locator('.mk-thread.unread', { hasText: 'Saturday' }).first();
const threadUnread = Number(await thr.locator('.mk-badge').textContent());
await thr.click();
await s.waitForSelector('.mk-bubble.theirs >> text=Saturday');
await s.waitForTimeout(600);
const before = Number(badge1);
await s.waitForTimeout(500);
const after = Number(await s.locator('.mk-page .tabs .mk-badge').first().textContent().catch(() => '0'));
check(`opening the thread lowers the studio badge (${before} to ${after})`, after === before - threadUnread);
await s.locator('.mk-compose textarea').fill('Hi! Yes, Reformer Basics at 9am Saturday. Spots are open.');
await s.locator('.mk-compose button[type=submit]').click();
await s.waitForSelector('.mk-bubble.mine >> text=Reformer Basics');
// client sees the reply
await c.waitForSelector('.mk-bubble.theirs >> text=Reformer Basics', { timeout: 6000 }).then(() => check('client sees the reply live', true), () => check('client sees the reply live', false));
await c.screenshot({ path: `${OUT}client-reply-390.png` });
// client unread: leave Messages and check the Profile entry
await c.locator('.screen-back button, .back-pill').first().click().catch(() => {});
await c.waitForTimeout(500);
// studio sends a second one while client sits on Profile
await s.locator('.mk-compose textarea').fill('See you there!');
await s.locator('.mk-compose button[type=submit]').click();
await c.waitForTimeout(900);
const entry = c.locator('button.list-row', { hasText: 'Messages' });
check('client Profile > Messages entry shows an unread count', (await entry.locator('.mk-unread').count()) > 0);
await c.screenshot({ path: `${OUT}client-profile-unread-390.png` });

// Libby starts a new message from a client's profile
await go('/clients', 900);
const row = s.locator('a[href^="#/clients/"], .client-row, tr').filter({ hasText: /\w/ }).nth(3);
await row.click(); await s.waitForTimeout(800);
const name = (await s.locator('h1, .page-head h1').first().textContent() ?? '').trim();
await s.getByRole('link', { name: /Message/ }).first().click();
await s.waitForSelector('.mk-compose textarea');
const first = `Hi from the studio, ${Date.now() % 1000}`;
await s.locator('.mk-compose textarea').fill(first);
await s.locator('.mk-compose button[type=submit]').click();
await s.waitForSelector(`.mk-bubble.mine >> text=${first}`);
await s.waitForTimeout(500);
check(`new thread started from profile (${name})`, (await s.locator('.mk-thread', { hasText: 'Hi from the studio' }).count()) > 0);
await s.screenshot({ path: `${OUT}studio-new-thread-1024.png` });

console.log('errors:', errs);
await browser.close();
process.exit(errs.length || fails.length ? 1 : 0);
