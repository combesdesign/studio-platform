// Visual + console pass for Libby's feedback (27 Oct): the booking flow at 390 (returning member, first-timer) and the
// membership edit sheet at 1024. Snowy only (?studio=snowy).
//   node build.mjs && python3 -m http.server 4173 -d dist &   node tests/libby-explore.mjs screenshots/libby-feedback
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { localFonts } from './_fonts.mjs';
const OUT = (process.argv[2] || 'screenshots/libby-feedback').replace(/\/?$/, '/');
const BASE = process.env.BASE || 'http://localhost:4173';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errs = [];
const watch = (p, tag) => {
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|ERR_NAME|net::ERR/.test(m.text())) errs.push(`${tag}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e.message}`));
};
const say = (m) => console.log(m);
const newCtx = async (w, h) => { const c = await browser.newContext({ viewport: { width: w, height: h }, locale: 'en-AU', timezoneId: 'Australia/Sydney' }); await localFonts(c); return c; };

/** Open the first class on the next days that offers a "Book this class" / "Join waitlist" button; returns its index info. */
async function openBookable(p, from = 1) {
  const skip = 0; let seen = 0;
  for (let d = from; d < from + 6; d++) {
    await p.locator('.strip-day').nth(d).click(); await p.waitForTimeout(350);
    const n = await p.locator('.cls').count();
    for (let i = 0; i < Math.min(n, 5); i++) {
      await p.locator('.cls').nth(i).click();
      await p.waitForSelector('.cs-foot', { timeout: 5000 });
      if (await p.getByRole('button', { name: /Book this class/ }).count()) { if (seen++ >= skip) return; }
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    }
  }
  throw new Error('no bookable class found');
}
const signInAs = async (p, who) => {
  await p.waitForSelector('.demo-box .list-row', { timeout: 8000 });
  await p.locator('.demo-box .list-row', { hasText: who }).first().click();
  await p.waitForSelector('.strip-day', { timeout: 8000 });
};

// ================================================================= returning member at 390
{
  const ctx = await newCtx(390, 844);
  const p = await ctx.newPage(); watch(p, 'client returning');
  await p.goto(`${BASE}/?studio=snowy`);
  await signInAs(p, 'Hannah');
  await openBookable(p, 8);   // next week, so her 2-a-week allowance is free
  assert.ok(await p.locator('.picker-opt.on').count() === 1, 'the best pass is already selected');
  say('pass preselected: ' + (await p.locator('.picker-opt.on .picker-name').innerText()));
  await p.getByRole('button', { name: /Book this class/ }).click();
  await p.waitForSelector('.health-step', { timeout: 5000 });
  assert.match(await p.locator('.health-step h2').innerText(), /new injuries or health changes since last time/i);
  assert.equal(await p.locator('.health-step .yn button.on').innerText(), 'No', 'No is the default');
  assert.equal(await p.locator('.health-step textarea').count(), 0, 'no text box until Yes');
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${OUT}1-booking-quick-health-check-390.png` });
  await p.locator('.health-step .yn button', { hasText: 'Yes' }).click();
  assert.equal(await p.locator('.health-step .btn.big').isDisabled(), true, 'Yes needs a few words');
  await p.locator('.health-step textarea').fill('sore left knee');
  await p.locator('.health-step .yn button', { hasText: 'No' }).click();
  assert.equal(await p.locator('.health-step textarea').count(), 0);
  await p.getByRole('button', { name: /Confirm booking/ }).click();
  await p.waitForSelector('.success', { timeout: 5000 });
  say('booked: ' + (await p.locator('.success h2').innerText()));
  // a second class straight after: no health step at all (asked less than 30 days ago)
  await p.getByRole('button', { name: 'Done' }).click(); await p.waitForTimeout(300);
  await openBookable(p, 8);
  say('second class pass area: ' + (await p.locator('.pass-none, .picker').first().innerText().catch(() => 'none')).replace(/\n/g, ' | '));
  await p.getByRole('button', { name: /Book this class/ }).click();
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}probe-second.png` });
  await p.waitForSelector('.success', { timeout: 5000 });
  assert.equal(await p.locator('.health-step').count(), 0);
  say('second booking: straight to booked, no health step');
  await ctx.close();
}

// ================================================================= first-timer at 390
{
  const ctx = await newCtx(390, 844);
  const p = await ctx.newPage(); watch(p, 'client first-timer');
  await p.goto(`${BASE}/?studio=snowy`);
  await signInAs(p, 'Chloe');
  await openBookable(p, 0);
  say('first-timer sees: ' + (await p.locator('.pass-none, .picker').first().innerText()).replace(/\n/g, ' | '));
  await p.getByRole('button', { name: /Book this class/ }).click();
  await p.waitForTimeout(500);
  say('after Book: ' + (await p.locator('.sheet, [role=dialog]').last().innerText()).replace(/\n+/g, ' | ').slice(0, 200));
  await p.getByRole('button', { name: /See passes/ }).click();
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /Claim your intro offer/ }).first().click();
  await p.getByRole('button', { name: /Continue to payment/ }).click();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}probe-pay.png` });
  say('pay: ' + (await p.locator('.sheet, [role=dialog]').last().innerText()).replace(/\n+/g, ' | ').slice(0, 300));
  await p.locator('.sheet .btn.big, [role=dialog] .btn.big').last().click();
  await p.waitForTimeout(2500);
  say('after pay: ' + (await p.locator('.sheet, [role=dialog]').last().innerText()).replace(/\n+/g, ' | ').slice(0, 300));
  await p.getByRole('button', { name: /Back to/ }).click();
  await p.waitForTimeout(800);
  say('back at: ' + (await p.locator('.sheet, [role=dialog]').last().innerText()).replace(/\n+/g, ' | ').slice(0, 300));
  await p.getByRole('button', { name: /Book this class/ }).click();
  await p.waitForTimeout(800);
  say('waiver: ' + (await p.locator('.flow').innerText()).replace(/\n+/g, ' | ').slice(0, 300));
  // the pass was settled first: the waiver is the only thing left, then it books with that pass
  assert.match(await p.locator('.flow h1').innerText(), /A little about/i);
  await p.locator('.flow input[autocomplete="off"]').nth(0).fill('Sam Bennett');
  await p.locator('.flow input[autocomplete="off"]').nth(1).fill('0400 111 222');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${OUT}2-booking-first-timer-waiver-390.png` });
  await p.getByRole('button', { name: 'Continue' }).click();
  for (const b of await p.locator('.hq .yn button', { hasText: 'No' }).all()) await b.click();
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.locator('.flow input[type=checkbox]').check();
  await p.locator('.flow input.sig').fill('Chloe Bennett');
  await p.getByRole('button', { name: /Sign and book my class/ }).click();
  await p.waitForSelector('.cs-foot', { timeout: 6000 });
  await p.waitForTimeout(500);
  const txt = await p.locator('.sheet, [role=dialog]').last().innerText();
  assert.match(txt, /You.re booked in/);
  assert.match(txt, /Booked with\s+Intro offer/);
  say('first-timer booked with the pass they chose, after the waiver');
  await ctx.close();
}

// ================================================================= studio at 1024: policies + edit membership
{
  const ctx = await newCtx(1024, 768);
  const p = await ctx.newPage(); watch(p, 'studio');
  await p.goto(`${BASE}/studio/?studio=snowy`);
  await p.waitForSelector('.persona', { timeout: 8000 });
  await p.locator('.persona').first().click();           // Libby, the owner
  await p.waitForSelector('.today .stats', { timeout: 8000 });
  // Settings > Policies: the new health switches (per studio, saved)
  await p.evaluate(() => { location.hash = '/settings/policies'; });
  await p.getByText('Long health form for first-timers').waitFor({ timeout: 6000 });
  assert.equal(await p.getByText('Quick health check for returning clients').count(), 1);
  assert.equal(await p.locator('input[type=number][max="365"]').inputValue(), '30', 'default is every 30 days');
  await p.locator('input[type=number][max="365"]').fill('14');
  await p.getByRole('button', { name: /^Save/ }).click();
  await p.getByText('Policies saved').waitFor({ timeout: 4000 });
  say('policies saved (14 days)');
  // Client profile > membership > Edit
  await p.evaluate(() => { location.hash = '/clients'; });
  await p.waitForSelector('input[type=search], input.input', { timeout: 6000 });
  await p.locator('input[type=search], input.input').first().fill('Hannah');
  await p.locator('a[href^="#/clients/"]', { hasText: 'Hannah' }).first().click();
  await p.waitForSelector('.pass', { timeout: 6000 });
  const card = p.locator('.pass', { hasText: 'per week' }).first();
  await card.getByRole('button', { name: 'Edit' }).click();
  await p.getByText('Edit membership').first().waitFor();
  // renewal date
  const before = await card.locator('.pass-meta').first().innerText();
  const d = new Date(Date.now() + 12 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  await p.locator('.sheet input[type=date], [role=dialog] input[type=date]').fill(d);
  await p.getByRole('button', { name: 'Review change' }).click();
  assert.match(await p.locator('.em-sum').innerText(), /will be charged next on/);
  await p.getByRole('button', { name: 'Move renewal date' }).click();
  await p.getByText(/Renewal moved to/).waitFor({ timeout: 4000 });
  await p.waitForFunction((was) => ![...document.querySelectorAll('.pass-meta')].some((e) => e.textContent.includes(was)), before.split('Next billing ')[1], { timeout: 4000 });
  say('renewal date moved: ' + before.replace(/\n/g, ' ') + ' -> ' + (await card.locator('.pass-meta').first().innerText()).replace(/\n/g, ' '));
  // different membership
  await card.getByRole('button', { name: 'Edit' }).click();
  await p.getByRole('tab', { name: 'Different membership' }).click();
  await p.locator('.em-opt', { hasText: '3 Classes Per Week Membership' }).click();
  await p.waitForTimeout(200);
  await p.getByRole('button', { name: 'Review change' }).click();
  const sum = await p.locator('.sheet, [role=dialog]').last().innerText();
  assert.match(sum, /Move Hannah from 2 Classes Per Week Membership .* to 3 Classes Per Week Membership/);
  assert.match(sum, /won.t charge or credit anything/);
  assert.match(sum, /They keep 2 classes a week until/);
  await p.waitForTimeout(250);
  await p.screenshot({ path: `${OUT}3-edit-membership-confirm-1024.png` });
  await p.getByRole('button', { name: /^Move to 3 Classes Per Week Membership/ }).click();
  await p.getByText(/is moving to 3 Classes Per Week Membership/).waitFor({ timeout: 4000 });
  await p.waitForSelector('.pass-pending', { timeout: 4000 });
  say('membership move saved: ' + (await p.locator('.pass-pending').first().innerText()));
  await ctx.close();
}

console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
await browser.close();
if (errs.length) process.exit(1);
