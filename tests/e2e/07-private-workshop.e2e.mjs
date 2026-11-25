import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
await journey('7 book a private with a credit, move it, sign up to a workshop', async (env) => {
  // Snowy has privates and events switched off for clients (Settings › Appointments); the owner turns them on first.
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/settings/appointments');
  const offer = s.getByLabel('Offer privates and events to clients');
  await offer.waitFor(T);
  await eventually(() => offer.isEnabled(), 'the setting to load');
  assert.equal(await offer.isChecked(), false, 'Snowy starts with the page off');
  await offer.check();
  await s.getByText('Privates and events are on for clients').waitFor(T);
  const c = await env.client();
  await clientSignInAs(c, 'Jess');
  await c.evaluate(() => { location.hash = '#/appointments'; });
  const credits = () => c.locator('.view').innerText();

  // ---- book a private Session with the credit left on her 3 pack
  await c.getByText('Private Session', { exact: true }).first().click();
  await c.locator('.ap-day').first().waitFor(T);
  await c.locator('.ap-slot').first().click();
  const when = (await c.locator('.ap-sum strong').innerText()).trim();          // "Tuesday 1 December, 12:30pm"
  await c.getByRole('button', { name: /1 credit \(1 left\)/ }).click();
  await c.getByRole('button', { name: 'Book with a credit' }).click();
  await c.getByRole('heading', { name: /You.re booked/ }).waitFor(T);
  await c.getByRole('button', { name: 'See my bookings' }).click();
  const short = `${when.split(' ')[0].slice(0, 3)} ${when.split(' ')[1]} ${when.split(' ')[2].slice(0, 3)}, ${when.split(', ')[1]}`;   // "Tue 1 Dec, 12:30pm"
  const mine = c.locator('.list-row', { hasText: short });
  await mine.waitFor(T);
  await eventually(async () => /0 of 3 left|3 of 3 used|No credits|0 left/i.test(await credits()) || !/1 of 3 left/.test(await credits()), 'credit to be used');

  // ---- move it to another time: same credit, new time
  await mine.click();
  await c.getByRole('button', { name: 'Move to another time' }).click();
  await c.getByRole('heading', { name: /Move to another time/ }).waitFor(T);
  await c.locator('.ap-day').first().waitFor(T);
  await c.locator('.ap-slot').first().click();
  const moved = (await c.locator('.ap-sum strong').innerText()).trim();
  assert.notEqual(moved, when);
  await c.getByRole('button', { name: 'Move my session' }).click();
  await c.getByText(/Moved\. We.ve emailed you the new time/).waitFor(T);
  const movedShort = `${moved.split(' ')[0].slice(0, 3)} ${moved.split(' ')[1]} ${moved.split(' ')[2].slice(0, 3)}, ${moved.split(', ')[1]}`;
  await c.locator('.list-row', { hasText: movedShort }).waitFor(T);
  assert.equal(await c.locator('.list-row', { hasText: short }).count(), 0, 'old time is gone');
  assert.match(await credits(), /Private Session/);

  // ---- a workshop: Sunday Reset has one spot left
  await c.getByRole('button', { name: /^Events/ }).or(c.getByText(/^Events/).first()).first().click();
  await c.getByText('Sunday Reset: Mobility + Breath').first().click();
  await c.getByRole('button', { name: /Sign up for \$55/ }).click();
  await c.getByRole('button', { name: /^Pay \$55/ }).click();
  await c.getByRole('heading', { name: /You.re in/ }).waitFor(T);
  await c.getByRole('button', { name: 'Done' }).click();
  // it shows under Mine, and the studio sees both on her profile
  await c.locator('.view').getByText(/^Mine/).first().click();
  await c.getByText('Sunday Reset: Mobility + Breath').first().waitFor(T);
  await goStudio(s, '#/clients');
  await s.locator('input.input').first().fill('Jess');
  await s.getByRole('link', { name: /Jess Walker/ }).first().click();
  await s.getByText(movedShort).first().waitFor(T);
  await s.getByText('No appointment credits.').waitFor(T);
  assert.equal(await s.getByText(short).count(), 0, 'studio no longer shows the old time');
  await goStudio(s, '#/appointments/events');
  await s.getByText('12 / 12 signed up').waitFor(T);   // was 11 / 12 before Jess
});
