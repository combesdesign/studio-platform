// Studio app run-through. Serve dist first:  python3 -m http.server 4174 -d dist &
// Then: node src/studio/e2e.mjs   (screenshots -> screenshots/studio/)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4174/studio/';
const OUT = new URL('../../screenshots/studio/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const errors = [];
const step = (m) => console.log('•', m);

const browser = await chromium.launch();
async function page(w, h, tag) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'en-AU', timezoneId: 'Australia/Sydney', hasTouch: w < 1100 });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|fonts\.g/.test(m.text())) errors.push(`[${tag}] console: ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  return p;
}
const shot = async (p, name, full = false) => { await p.waitForTimeout(450); await p.screenshot({ path: OUT + name + '.png', fullPage: full }); step('shot ' + name); };
const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForTimeout(500); };
const toastText = async (p) => (await p.locator('.toast, .snack').allTextContents()).join(' | ');

async function signInLibby(p) {
  await p.goto(BASE);
  await p.waitForSelector('.signin');
  await p.locator('.persona', { hasText: 'Libby' }).first().click();
  await p.waitForSelector('.today .page-head');
}

// ---------------------------------------------------------------- iPad landscape: full flow
{
  const p = await page(1024, 768, 'ipad-l');
  await p.goto(BASE);
  await p.waitForSelector('.signin');
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForSelector('.persona');
  await shot(p, '01-signin-1024');
  await p.locator('.persona', { hasText: 'Libby' }).first().click();
  await p.waitForSelector('.today .stats');
  await shot(p, '02-today-1024');
  await shot(p, '02b-today-1024-full', true);

  // open a class with bookings still to check in
  const cards = p.locator('.cls-card:not(.cancelled)');
  const n = await cards.count();
  step(`today has ${n} classes`);
  let opened = false;
  for (let i = 0; i < n && !opened; i++) {
    await cards.nth(i).click();
    await p.waitForSelector('.roster .page-head');
    await p.waitForTimeout(400);
    const free = await p.locator('.rrow:not(.in) .ci:not(.on)').count();
    if (free >= 2) opened = true; else await go(p, '/');
  }
  if (!opened) { // fall back to the schedule's next class
    await go(p, '/schedule');
    await p.locator('.wk-day.today .wc, .wk-day:not(.past) .wc').first().click();
    await p.waitForSelector('.roster .page-head');
  }
  await shot(p, '03-roster-1024');

  const ci = p.locator('.rrow:not(.in) .ci');
  await ci.first().click(); await p.waitForTimeout(500);
  step('after check-in 1: ' + await toastText(p));
  await p.locator('.rrow:not(.in) .ci').first().click(); await p.waitForTimeout(500);
  step('after check-in 2: ' + await toastText(p));
  const inBefore = await p.locator('.rrow.in').count();
  await shot(p, '04-roster-checked-1024');
  await p.locator('.snack button', { hasText: 'Undo' }).click();
  await p.waitForTimeout(700);
  const inAfter = await p.locator('.rrow.in').count();
  step(`checked in rows: ${inBefore} -> after undo ${inAfter}`);
  if (inAfter !== inBefore - 1) errors.push('undo did not reduce checked-in count');

  // flags: tap an injury chip if present
  const inj = p.locator('.chip.flag.warn', { hasText: 'Injury' }).first();
  if (await inj.count()) { await inj.click(); await shot(p, '05-injury-sheet-1024'); await p.keyboard.press('Escape'); }

  // add a client to the class
  await p.locator('.ph-actions button', { hasText: 'Add client' }).click();
  await p.waitForSelector('.csearch');
  await shot(p, '06-add-client-search-1024');
  await p.locator('.cs-row').first().click();
  await p.waitForSelector('.bookopts');
  await p.waitForTimeout(500);
  await shot(p, '07-add-client-options-1024');
  await p.locator('.bookopts .sh-foot .btn').click();
  await p.waitForTimeout(700);
  step('after add: ' + await toastText(p));
  await shot(p, '08-roster-after-add-1024');

  // entry actions sheet
  await p.locator('.rrow:not(.in) .rr-who').first().click();
  await p.waitForTimeout(300);
  await shot(p, '09-entry-sheet-1024');
  await p.keyboard.press('Escape');

  // class actions + walk-in
  await p.locator('.ph-actions button', { hasText: 'Walk-in' }).click();
  await p.waitForTimeout(300);
  await shot(p, '10-walkin-1024');
  await p.keyboard.press('Escape');

  // POS: 4-pack to a client with cash
  await go(p, '/pos');
  await p.waitForSelector('.tile');
  await shot(p, '11-pos-1024');
  await p.locator('.tile', { hasText: /4 class/i }).first().click();
  await p.locator('.pc-noclient .btn').click();
  await p.waitForSelector('.cs-row');
  await p.locator('.cs-row').nth(2).click();
  await p.locator('.method', { hasText: 'Cash' }).click();
  await shot(p, '12-pos-cart-1024');
  await p.locator('.pc-charge').click();
  await p.waitForSelector('.receipt', { timeout: 5000 });
  await shot(p, '13-receipt-1024', true);

  // schedule
  await go(p, '/schedule');
  await p.waitForSelector('.week');
  await shot(p, '14-schedule-1024');
  await go(p, '/schedule/timetable');
  await p.waitForSelector('.timetable');
  await shot(p, '15-timetable-1024');

  // clients + profile + adjust credits
  await go(p, '/clients');
  await p.waitForSelector('.crow');
  await shot(p, '16-clients-1024');
  // receipt client has a fresh 4-pack: open the profile from POS sale via the receipt link would be ideal; find someone with a pack
  const rows = p.locator('.crow');
  let adjusted = false;
  const rowCount = Math.min(await rows.count(), 15);
  for (let i = 0; i < rowCount && !adjusted; i++) {
    await go(p, '/clients');
    await p.locator('.crow').nth(i).click();
    await p.waitForSelector('.profile .pf-head');
    await p.waitForTimeout(400);
    if (i === 0) await shot(p, '17-profile-1024');
    const adj = p.locator('.pass-actions .btn', { hasText: 'Adjust' }).first();
    if (await adj.count()) {
      await shot(p, '17-profile-1024');
      await shot(p, '17b-profile-1024-full', true);
      await adj.click();
      await p.waitForSelector('.adj-credits, .sheet .field');
      const plus = p.locator('.stepper button[aria-label="Add a credit"]');
      if (await plus.count()) await plus.click();
      else await p.locator('.sheet input[type=date]').fill('2026-12-31');
      await p.locator('.sheet input[placeholder^="e.g. Away"]').fill('Goodwill credit');
      await shot(p, '18-adjust-1024');
      await p.locator('.sheet .sh-foot .btn', { hasText: 'Save adjustment' }).click();
      await p.waitForTimeout(600);
      step('after adjust: ' + await toastText(p));
      adjusted = true;
    }
  }
  if (!adjusted) errors.push('no client with an adjustable pass found');

  await go(p, '/reports');
  await p.waitForSelector('.kpis', { timeout: 8000 });
  await shot(p, '19-reports-1024');
  await shot(p, '19b-reports-1024-full', true);
  await go(p, '/settings/policies');
  await p.waitForTimeout(400);
  await shot(p, '20-settings-1024');
  await go(p, '/settings/products');
  await shot(p, '21-settings-products-1024');
  await go(p, '/settings/staff');
  await shot(p, '22-settings-staff-1024');
}

// ---------------------------------------------------------------- iPad portrait + phone: key screens
for (const [w, h] of [[768, 1024], [390, 844]]) {
  const tag = `${w}`;
  const p = await page(w, h, tag);
  await signInLibby(p);
  await shot(p, `30-today-${tag}`);
  await p.locator('.cls-card:not(.cancelled)').first().click();
  await p.waitForSelector('.roster .page-head');
  await shot(p, `31-roster-${tag}`);
  await go(p, '/schedule');
  await shot(p, `32-schedule-${tag}`);
  await go(p, '/pos');
  await p.locator('.tile').first().click();
  await shot(p, `33-pos-${tag}`);
  await go(p, '/clients');
  await p.locator('.crow').first().click();
  await p.waitForSelector('.profile .pf-head');
  await shot(p, `34-profile-${tag}`);
  await go(p, '/reports');
  await p.waitForSelector('.kpis');
  await shot(p, `35-reports-${tag}`);
  if (w < 700) { await p.locator('.tabbar button').click(); await shot(p, `36-more-${tag}`); }
}

// ---------------------------------------------------------------- instructor permissions
{
  const p = await page(1024, 768, 'instr');
  await p.goto(BASE);
  await p.waitForSelector('.persona');
  await p.locator('.persona', { hasText: 'Grace P' }).first().click();
  await p.waitForSelector('.today');
  const nav = await p.locator('.nav a').allTextContents();
  step('instructor nav: ' + nav.join(', '));
  if (nav.some((t) => /Reports|Settings/.test(t))) errors.push('instructor sees reports/settings');
  await shot(p, '40-today-instructor-1024');
}

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nNo console errors.');
process.exit(errors.length ? 1 : 0);
