import assert from 'node:assert/strict';
import { eventually, journey, clientSignInAs, studioSignInAs, T, goStudio, pickDay } from './lib.mjs';
await journey('4 full class: join waitlist, studio removes a booking, waitlisted client is promoted', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Hannah');
  const cls = c.locator('.cls', { hasText: '6:00' }).filter({ hasText: 'pm' });
  await cls.getByText('Join waitlist').waitFor(T);
  await cls.click();
  await c.getByText(/3 on the waitlist/).waitFor(T);
  await c.getByRole('button', { name: 'Join waitlist', exact: true }).last().click();
  await c.getByRole('button', { name: 'Join the waitlist' }).click();
  await c.getByText('You’re on the waitlist').waitFor(T);
  await c.getByRole('button', { name: 'Done' }).click();
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await s.locator('.today .stats').waitFor(T);
  await s.getByRole('link', { name: /Mat Essentials/ }).filter({ hasText: '14/14' }).first().click();
  const wl = s.locator('.rrow.wl');
  await wl.filter({ hasText: 'Hannah Mitchell' }).waitFor(T);
  assert.equal(await wl.count(), 4);
  // The studio removes bookings one at a time. The class holds 2 spots back for ClassPass, so the first removal only
  // brings it down to its direct limit; after that each free spot goes to the first person on the list with a usable
  // credit. Keep going until Hannah gets one.
  const attending = s.locator('.rrow:not(.wl):not(.muted-row)');
  const hannah = attending.filter({ hasText: 'Hannah Mitchell' });
  const before = await wl.count();
  for (let removed = 0; removed < 6 && !(await hannah.count()); removed++) {
    const row = attending.filter({ hasNotText: 'Hannah Mitchell' }).first();
    const name = await row.locator('.rr-t strong').innerText();
    await row.locator('.rr-who').click();
    await s.getByRole('button', { name: /Cancel booking/ }).click();
    await s.getByText(/gets the credit back/).waitFor(T);
    await s.getByRole('button', { name: 'Cancel booking', exact: true }).last().click();
    await attending.filter({ hasText: name }).waitFor({ state: 'detached', ...T });
  }
  await hannah.waitFor(T);
  await hannah.getByRole('button', { name: 'Check in Hannah' }).waitFor(T);
  assert.ok((await wl.count()) < before, 'the waitlist got shorter');
  assert.equal(await wl.filter({ hasText: 'Hannah Mitchell' }).count(), 0);

  // and on her phone she is now booked, no longer waitlisted
  await c.getByRole('button', { name: 'Bookings' }).click();
  const mine = c.locator('.view').getByText('Booked', { exact: true }).or(c.locator('.view').getByText(/6:00\s*pm/i));
  await mine.first().waitFor(T);
  assert.equal(await c.getByText('Waitlist', { exact: true }).count(), 0);
});
