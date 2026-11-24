import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, weekOf, T, eventually, settled } from './lib.mjs';
await journey('11 studio cancels a class and restores it: clients are told, credits go back, then everyone is rebooked', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Hannah');
  const left = async () => {
    await c.getByRole('button', { name: 'Passes' }).click();
    const t = c.getByText(/\d of 2 left this week/);
    await t.first().waitFor(T);
    const v = await t.first().innerText();
    await c.getByRole('button', { name: 'Timetable' }).click();
    return v;
  };
  assert.equal(await left(), '1 of 2 left this week');
  await c.getByRole('button', { name: 'Bookings' }).click();
  await c.getByText(/Tomorrow · 6:00/).waitFor(T);

  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/schedule/' + weekOf(1));
  const link = s.locator('a[href^="#/class/"]', { hasText: '6:00am' }).filter({ hasText: 'Julia' });
  await link.click();                                   // Wednesday 6am with Julia: Hannah's class
  const row = s.locator('.rrow', { hasText: 'Hannah Mitchell' });
  await row.waitFor(T);
  const booked = await s.locator('.rrow:not(.wl):not(.muted-row)').count();
  await s.getByRole('button', { name: 'Class actions' }).click();
  await s.getByRole('button', { name: /Cancel class/ }).click();
  await s.getByText(new RegExp(`${booked} people will be removed`)).waitFor(T);
  await s.getByLabel(/Reason/).fill('Instructor unwell, sorry!');
  await s.getByText('Yes, cancel the class').click();
  await s.getByRole('button', { name: 'Cancel class', exact: true }).last().click();
  await s.getByText('Class cancelled. Clients have been notified.').waitFor(T);
  await s.getByRole('button', { name: /Restore class/ }).waitFor(T);
  await s.getByText(/Cancelled · Instructor unwell/).waitFor(T);

  // client: told, booking gone, credit back
  await c.getByText(/Mat Essentials on Wed 6:00am was cancelled by/).waitFor(T);
  assert.equal(await left(), '2 of 2 left this week', 'credit returned');

  // restore: everyone is put back and their credit is taken again
  await s.getByRole('button', { name: /Restore class/ }).click();
  await s.getByRole('button', { name: 'Restore class', exact: true }).last().click();
  await s.getByText(/The class is back on\./).waitFor(T);
  await s.getByText(/Hannah Mitchell.*is booked in again|Hannah Mitchell is booked in again/).waitFor(T);
  await s.getByRole('button', { name: 'Done' }).click();
  await settled(s);
  await eventually(async () => (await s.locator('.rrow:not(.wl):not(.muted-row)').count()) === booked, `roster back to ${booked}`);
  await s.locator('.rrow', { hasText: 'Hannah Mitchell' }).waitFor(T);
  await c.getByRole('button', { name: 'Bookings' }).click();
  await c.getByText(/Tomorrow · 6:00/).waitFor(T);
  assert.equal(await left(), '1 of 2 left this week', 'credit taken again');
});
