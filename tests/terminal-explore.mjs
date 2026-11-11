// Click-through of the Stripe Terminal card reader in the demo (simulated reader): Settings -> Payments -> add a reader, then a POS sale
// on "Card reader" (waiting state, approve after ~2s, receipt), a decline, and a cancel. 1024 wide on ?studio=snowy, fails on console errors.
//   node build.mjs && python3 -m http.server 4307 -d dist &   node tests/terminal-explore.mjs screenshots/terminal snowy
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/terminal').replace(/\/?$/, '/');
const slug = process.argv[3] || 'snowy';
const BASE = process.env.BASE || 'http://localhost:4307';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
await localFonts(ctx);
const errs = [];
const s = await ctx.newPage();
s.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(m.text()); });
s.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
const must = (ok, msg) => { if (!ok) { errs.push(msg); console.log('FAIL: ' + msg); } else console.log('ok: ' + msg); };

await s.goto(`${BASE}/studio/?studio=${slug}`);
await s.waitForSelector('.persona', { timeout: 8000 });
await s.locator('.persona', { hasText: 'Libby' }).first().click();
await s.waitForSelector('.today .stats', { timeout: 8000 });

// 1. register a reader
await s.evaluate(() => { location.hash = '/settings/payments'; });
await s.waitForSelector('[data-testid="card-reader-panel"]', { timeout: 8000 });
await s.getByPlaceholder('sepia-cat-river').fill('sepia-cat-river');
await s.getByRole('button', { name: 'Add reader' }).click();
await s.getByText('This device').waitFor({ timeout: 5000 });
must(true, 'reader registered and chosen for this device');

// 2. POS: a retail item, pay on the reader
const sale = async (note) => {
  await s.evaluate(() => { location.hash = '/pos'; });
  const again = s.getByRole('button', { name: 'New sale' });
  if (await again.isVisible().catch(() => false)) await again.click();
  await s.waitForSelector('.pos-products .tile', { timeout: 8000 });
  await s.locator('.tile.k-retail:not(.off)').first().click();
  if (note) await s.getByPlaceholder('Note (optional)').fill(note);
  await s.getByRole('button', { name: /on reader/ }).click();
  await s.waitForSelector('[data-testid="terminal-sheet"]', { timeout: 5000 });
};
await sale();
await s.getByText('Tap or insert card on the reader').waitFor({ timeout: 5000 });
await s.waitForTimeout(500);
await s.screenshot({ path: `${OUT}pos-card-reader-1024.png` });
await s.getByText('All done').waitFor({ timeout: 8000 });
must((await s.locator('.rc-done').innerText()).includes('paid by card reader'), 'approved after ~2s, receipt says paid by card reader');

// 3. decline
await sale('decline please');
await s.getByText('The card was declined.').waitFor({ timeout: 8000 });
must(true, 'decline shows a clear message');
await s.getByRole('button', { name: 'Back to cart' }).click();

// 4. cancel
await s.getByRole('button', { name: /on reader/ }).click();
await s.getByTestId('terminal-cancel').click();
await s.waitForSelector('[data-testid="terminal-sheet"]', { state: 'detached', timeout: 5000 });
must(await s.getByRole('button', { name: /on reader/ }).isVisible(), 'cancel returns to the cart with nothing charged');

await browser.close();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no console errors');
process.exit(errs.length ? 1 : 0);
