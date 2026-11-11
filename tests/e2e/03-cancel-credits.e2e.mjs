import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, T, goStudio, pickDay, bookOpenClass, closeSheet } from './lib.mjs';
await journey('3 cancel outside window gets credit back, late cancel loses it, studio returns it', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Jess');
  // credits left on the pack, read from the Passes tab ("No active passes" means 0)
  const left = async () => {
    await c.getByRole('button', { name: 'Passes' }).click();
    const some = c.getByText(/\d+ of 4 left/), none = c.getByText('No active passes');
    await some.or(none).first().waitFor(T);
    const t = (await none.isVisible()) ? '0 left' : await some.innerText();
    await c.getByRole('button', { name: 'Timetable' }).click();
    return t.replace(' of 4', '');
  };
  assert.equal(await left(), '1 left');
  await pickDay(c, 7);
  await c.locator('.cls', { hasText: '9:30' }).click();
  await bookOpenClass(c);
  await closeSheet(c);
  assert.equal(await left(), '0 left');
  // open it again and cancel, well outside the 3 hour window
  await pickDay(c, 7);
  await c.locator('.cls', { hasText: '9:30' }).click();
  await c.getByRole('button', { name: 'Cancel booking' }).click();
  await c.getByText(/more than 3 hours before class, so your credit goes straight back/).waitFor(T);
  await c.getByRole('button', { name: 'Yes, cancel my booking' }).click();
  await c.getByText('Cancelled. Your credit has been returned.').waitFor(T);
  await closeSheet(c);
  assert.equal(await left(), '1 left', 'credit came back');

  // late cancel: today's 9:30 starts in 1h30 (the demo clock is 8:00am), inside the 3 hour window
  await pickDay(c, 0);
  await c.locator('.cls', { hasText: '9:30' }).click();
  await bookOpenClass(c);
  await c.getByRole('button', { name: 'Done' }).click();
  await c.locator('.cls', { hasText: '9:30' }).click();
  await c.getByRole('button', { name: 'Cancel booking' }).click();
  await c.getByText('This is a late cancel').waitFor(T);
  await c.getByText(/credit won.t be returned/).waitFor(T);
  await c.getByRole('button', { name: 'Cancel and lose the credit' }).click();
  await c.getByText('You late cancelled this class.').waitFor(T);
  await closeSheet(c);
  assert.equal(await left(), '0 left', 'late cancel keeps the credit used');

  // the studio sees the late cancel and returns the credit
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/clients');
  await s.getByRole('searchbox').or(s.locator('input.input').first()).first().fill('Jess');
  await s.getByRole('link', { name: /Jess Walker/ }).first().click();
  const late = s.locator('.b-item', { hasText: 'Late cancel' });
  await late.waitFor(T);
  await late.getByRole('button', { name: 'Return credit' }).click();
  await late.getByRole('button', { name: 'Return credit' }).waitFor({ state: 'hidden', ...T });
  assert.equal(await left(), '1 left', 'studio returned the credit');
});
