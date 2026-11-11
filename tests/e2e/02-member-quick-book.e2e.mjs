import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, T, goStudio, pickDay, weekOf } from './lib.mjs';
await journey('2 member books in 3 taps, quick injury check yes, roster shows the injury flag', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Hannah');
  let taps = 0;
  const tap = async (loc) => { await loc.click(); taps++; };
  await pickDay(c, 7); // next Tuesday, so her 2-a-week allowance is free
  await tap(c.locator('.cls', { hasText: '9:30' }));
  await tap(c.getByRole('button', { name: /Book this class/ }));
  // quick check: asked because she has not done one in the last 30 days; "No" is the default, she answers Yes
  await c.getByText(/new injuries or health changes since last time/i).waitFor(T);
  assert.equal(await c.locator('.health-step .yn button.on').innerText(), 'No');
  await c.getByRole('radio', { name: 'Yes' }).click();
  await c.locator('.health-step textarea').fill('Sore left knee');
  await tap(c.getByRole('button', { name: /Confirm booking/ }));
  await c.getByText(/You.re booked in/).waitFor(T);
  assert.ok(taps <= 3, `booked in ${taps} taps`);
  // and a second booking straight after needs no health step at all (asked within 30 days): 2 taps
  await c.keyboard.press('Escape');
  await c.getByRole('button', { name: 'Cancel booking' }).waitFor({ state: 'hidden', ...T });
  await pickDay(c, 8);
  await c.locator('.cls', { hasText: /spots? left|spots?\b/ }).first().click();
  await c.getByRole('button', { name: /Book this class/ }).click();
  await c.getByText(/You.re booked in/).waitFor(T);
  assert.equal(await c.locator('.health-step').count(), 0);

  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, `#/schedule/${weekOf(7)}`);
  await s.getByRole('link', { name: /9:30/ }).first().click();   // first 9:30 on the week: Tuesday
  const row = s.locator('.rrow', { hasText: 'Hannah Mitchell' });
  await row.waitFor(T);
  await row.getByText('Injury', { exact: true }).waitFor(T);
});
