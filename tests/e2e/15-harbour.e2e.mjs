import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, T, eventually, settled } from './lib.mjs';
await journey('15 Harbour on the platform build: location filter, spot picker, plan-locked upsell, no Snowy anywhere', async (env) => {
  const noSnowy = async (p, where) => {
    const seen = await p.evaluate(() => [document.title, document.body.innerText, ...[...document.querySelectorAll('[alt],[aria-label],[title],[placeholder]')].map((e) => ['alt', 'aria-label', 'title', 'placeholder'].map((a) => e.getAttribute(a) || '').join(' '))].join('\n'));
    assert.doesNotMatch(seen, /snowy|cooma|vale st/i, `"Snowy" (or its town) showed up on ${where}`);
  };
  const c = await env.client();
  await noSnowy(c, 'the client welcome');
  await clientSignInAs(c, 'Jack');
  const classes = () => c.locator('.cls');
  await classes().first().waitFor(T);
  assert.equal(await classes().count(), 3);

  // location filter
  await c.getByRole('button', { name: 'Bondi', exact: true }).click();
  await eventually(async () => (await classes().count()) === 1, 'only the Bondi class');
  assert.match(await classes().first().innerText(), /Bondi/);
  await c.getByRole('button', { name: 'Surry Hills', exact: true }).click();
  await eventually(async () => (await classes().count()) === 2, 'only the Surry Hills classes');
  assert.doesNotMatch((await classes().allInnerTexts()).join(' '), /Bondi/);
  await c.getByRole('button', { name: 'All locations' }).click();
  await eventually(async () => (await classes().count()) === 3, 'all three classes');

  // spot picker: the 5:45pm Reformer Flow at Surry Hills
  await c.locator('.cls', { hasText: 'Reformer Flow' }).click();
  await c.getByRole('button', { name: /Book this class/ }).click();
  await c.getByRole('heading', { name: /Pick your spot/ }).waitFor(T);
  const grid = c.getByRole('group', { name: 'Choose your spot' });
  await grid.waitFor(T);
  assert.equal(await grid.getByRole('button', { name: /^Spot \d+, free/ }).count(), 8, 'eight free reformers');
  await grid.getByRole('button', { name: /^Spot \d+, free/ }).last().click();
  const label = await grid.locator('[aria-pressed=true]').getAttribute('aria-label');
  const spot = label.match(/Spot (\d+)/)[1];
  await c.getByRole('button', { name: new RegExp(`Book spot ${spot}`, 'i') }).click();
  await c.getByText(/You.re booked in/).waitFor(T);
  await c.getByText(new RegExp(`spot ${spot}`, 'i')).first().waitFor(T);
  await noSnowy(c, 'the client booking');
  // change spot: mine is marked, and can't be re-picked as a different one
  await c.getByRole('button', { name: 'Done' }).click();
  await settled(c);
  await c.locator('.cls', { hasText: 'Reformer Flow' }).click();
  await c.getByRole('button', { name: 'Change' }).waitFor(T);
  await c.getByRole('button', { name: 'Change' }).click();
  await c.getByRole('group', { name: 'Choose your spot' }).getByLabel(new RegExp(`Spot ${spot}, yours`)).waitFor(T);
  await c.getByRole('button', { name: /Keep spot/i }).click();
  await c.getByRole('button', { name: 'Cancel booking' }).waitFor(T);

  // studio: roster shows Jack on that spot; Payroll is not on Harbour's plan
  const s = await env.studio();
  await studioSignInAs(s, 'Ava Chen');
  await s.locator('.today .stats').waitFor(T);
  await s.getByRole('link', { name: /Reformer Flow/ }).first().click();
  const row = s.locator('.rrow', { hasText: 'Jack Nolan' });
  await row.waitFor(T);
  await row.getByText(new RegExp(`\\b${spot}\\b`)).first().waitFor(T);
  await noSnowy(s, 'the studio roster');
  for (const [hash, text] of [['#/payroll', /Payroll and cover is available on Studio Plus/], ['#/shop', /Gift cards, promos and retail is available on Studio Plus/], ['#/appointments', /Appointments and workshops is available on Studio Plus/]]) {
    await goStudio(s, hash);
    await s.getByTestId('upsell').waitFor(T);
    await s.getByText(text).waitFor(T);
    await noSnowy(s, `the ${hash} upsell`);
  }
  await goStudio(s, '#/settings');
  await s.getByText('Studio setup').waitFor(T);
  await noSnowy(s, 'settings');
}, { platform: true });
