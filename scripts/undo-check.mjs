// Playwright check of the undo toast at 1024px (needs: node build.mjs; python3 -m http.server 4173 -d dist). node scripts/undo-check.mjs
import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text() + (m.location()?.url ?? ''))) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:4173/studio/?studio=snowy');
await page.waitForTimeout(600);
await page.getByRole('button', { name: /Libby/ }).first().click();
await page.waitForTimeout(800);
// find a class with people booked: try today's classes, then the schedule
const hrefs = await page.$$eval('a[href^="#/class/"]', (as) => as.map((a) => a.getAttribute('href')));
console.log('class links', hrefs.length);
let opened = false;
for (const h of [...new Set(hrefs)].slice(0, 8)) {
  await page.goto('http://localhost:4173/studio/' + h);
  await page.waitForTimeout(500);
  if (await page.locator('.rrow:not(.wl) .rr-who').count()) { opened = true; break; }
}
if (!opened) { console.log('no roster with bookings found'); process.exit(1); }
const first = page.locator('.rrow:not(.wl) .rr-who').first();
const name = (await first.locator('strong').innerText()).split(' ')[0];
await first.click();
await page.getByRole('button', { name: /Mark no-show/ }).click();
await page.waitForSelector('.snack');
console.log('snack:', await page.locator('.snack').innerText());
await page.screenshot({ path: 'screenshots/undo/01-noshow-undo-toast-1024.png' });
await page.locator('.snack button').click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'screenshots/undo/02-after-undo-1024.png' });
const toastText = await page.locator('.toast').first().innerText().catch(() => '');
console.log('after undo toast:', toastText);
// the snack stays about 10s
await first.click().catch(() => {});
console.log('errors:', JSON.stringify(errors));
await b.close();
process.exit(errors.length ? 1 : 0);
