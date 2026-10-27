// Visual + console pass for Libby's round-two fixes (27 Oct): Settings > Emails (edit, preview, test) and the Send a text sheet
// on a client profile, at 1024. Snowy only (?studio=snowy).
//   node build.mjs && python3 -m http.server 4173 -d dist &   node tests/libby2-explore.mjs screenshots/libby-feedback
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/libby-feedback').replace(/\/?$/, '/');
const BASE = process.env.BASE || 'http://localhost:4173';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errs = [];
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'en-AU', timezoneId: 'Australia/Sydney' });
await localFonts(ctx);
const p = await ctx.newPage();
p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(m.text()); });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await p.goto(`${BASE}/studio/?studio=snowy`);
await p.waitForSelector('.persona', { timeout: 8000 });
await p.locator('.persona').first().click();   // Libby, the owner
await p.waitForSelector('.today .stats', { timeout: 8000 });

// ---- Settings > Emails
await p.evaluate(() => { location.hash = '/settings/emails'; });
await p.waitForSelector('.eml-item', { timeout: 6000 });
assert.ok(await p.locator('.eml-item').count() >= 7, 'all client emails are listed');
await p.locator('.eml-item', { hasText: /on the waitlist/i }).first().click();
const subj = p.locator('.eml-form input.input').first();
await subj.fill('You are on the list for {class_name}');
await p.locator('.eml-form textarea').fill('Hi {first_name}, we will email you the moment a spot opens up at {studio_name}.');
await p.locator('.eml-tags .chip', { hasText: '{class_time}' }).click();
await p.waitForTimeout(400);
assert.match(await p.locator('.eml-subject strong').innerText(), /You are on the list for /);
const frame = p.frameLocator('.eml-frame');
await frame.locator('body').waitFor();
assert.match(await frame.locator('body').innerText(), /we will email you the moment a spot opens up at Snowy/i);
await p.getByRole('button', { name: 'Save changes' }).click();
await p.getByText(/saved/i).first().waitFor({ timeout: 4000 });
await p.getByRole('button', { name: /Send me a test/ }).click();
await p.getByText(/test/i).last().waitFor({ timeout: 4000 });
await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}4-settings-emails-1024.png` });
console.log('emails tab ok');

// ---- Send a text on a client profile
await p.evaluate(() => { location.hash = '/clients'; });
await p.waitForSelector('a[href^="#/clients/"]', { timeout: 6000 });
await p.locator('a[href^="#/clients/"]').first().click();
await p.getByRole('button', { name: 'Send a text' }).waitFor({ timeout: 6000 });
await p.getByRole('button', { name: 'Send a text' }).click();
await p.waitForSelector('.sheet, [role=dialog]', { timeout: 4000 });
if (await p.locator('.sheet textarea, [role=dialog] textarea').count()) {
  await p.locator('.sheet textarea, [role=dialog] textarea').fill('Hi! Your 6am mat class is moved to the studio upstairs this week. See you there.');
  assert.match(await p.locator('.mk-count').innerText(), /\d+\/160/);
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${OUT}5-send-a-text-1024.png` });
  await p.getByRole('button', { name: 'Send text' }).click();
  await p.getByText(/Text sent to/).waitFor({ timeout: 4000 });
  console.log('text sent');
} else {
  await p.screenshot({ path: `${OUT}5-send-a-text-1024.png` });
  console.log('client has no phone: sheet shows the explanation');
}
await browser.close();
assert.deepEqual(errs, [], 'no console errors:\n' + errs.join('\n'));
console.log('no console errors');
