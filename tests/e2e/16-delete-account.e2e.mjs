import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, T, eventually, settled } from './lib.mjs';
await journey('16 delete my account: the client is removed and the future booking spot frees up', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Jack');
  // Jack takes spot 5 in tonight's Reformer Flow
  await c.locator('.cls', { hasText: 'Reformer Flow' }).click();
  await c.getByRole('button', { name: /Book this class/ }).click();
  const grid = c.getByRole('group', { name: 'Choose your spot' });
  await grid.getByRole('button', { name: /^Spot 5, free/ }).click();
  await c.getByRole('button', { name: /Book spot 5/i }).click();
  await c.getByText(/You.re booked in/).waitFor(T);
  await c.getByRole('button', { name: 'Done' }).click();
  await settled(c);

  // studio: he is on the roster, on spot 5
  const s = await env.studio();
  await studioSignInAs(s, 'Ava Chen');
  await s.locator('.today .stats').waitFor(T);
  await s.getByRole('link', { name: /Reformer Flow/ }).first().click();
  const row = s.locator('.rrow', { hasText: 'Jack Nolan' });
  await row.waitFor(T);
  const counts = await s.locator('.rrow:not(.wl):not(.muted-row)').count();
  const rosterUrl = await s.evaluate(() => location.hash);

  // Jack deletes his account from Profile
  await c.getByRole('button', { name: 'Profile' }).click();
  await c.locator('.list-row', { hasText: 'Delete my account' }).click();
  await c.getByText(/Your upcoming classes are cancelled/).waitFor(T);
  const go = c.getByRole('button', { name: 'Delete my account', exact: true });
  assert.ok(await go.isDisabled(), 'needs the tick box first');
  await c.getByRole('checkbox', { name: /I understand/ }).check();
  await go.click();
  await c.getByText('Your account has been deleted').waitFor(T);
  await c.getByRole('button', { name: 'Join the club' }).waitFor(T);   // back at the welcome screen, signed out

  // studio: gone from the roster, and from the client list
  await eventually(async () => (await s.locator('.rrow', { hasText: 'Jack Nolan' }).count()) === 0, 'Jack to leave the roster');
  assert.equal(await s.locator('.rrow:not(.wl):not(.muted-row)').count(), counts - 1);
  await goStudio(s, '#/clients');
  await s.locator('input.input').first().fill('Jack');
  await s.getByText(/No clients|No one|nothing/i).first().waitFor(T);
  assert.equal(await s.locator('a[href^="#/clients/"]', { hasText: 'Jack Nolan' }).count(), 0);

  // the spot is free again: another client sees all eight reformers open
  await clientSignInAs(c, 'Priya');
  await c.locator('.cls', { hasText: 'Reformer Flow' }).click();
  await c.getByRole('button', { name: /Book this class/ }).click();
  await grid.waitFor(T);
  await grid.getByRole('button', { name: /^Spot 5, free/ }).waitFor(T);
  assert.equal(await grid.locator('[aria-label*="taken"]').count(), 0);
}, { platform: true });
