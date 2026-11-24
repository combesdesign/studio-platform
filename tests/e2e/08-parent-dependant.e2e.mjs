import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, pickDay, closeSheet, weekOf, T, eventually } from './lib.mjs';
await journey('8 a parent books her baby into a class on her own pack', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Sophie');
  const left = async () => {
    await c.getByRole('button', { name: 'Passes' }).click();
    const t = c.getByText(/\d+ of 4 left/);
    await t.first().waitFor(T);
    const v = await t.first().innerText();
    await c.getByRole('button', { name: 'Timetable' }).click();
    return v;
  };
  assert.equal(await left(), '2 of 4 left');   // the seeded Mums + Bubs booking used one each for Sophie and Poppy
  await pickDay(c, 8);
  await c.locator('.cls', { hasText: 'Mums + Bubs' }).click();
  const who = c.getByRole('group', { name: /Who.s coming/ });
  await who.waitFor(T);
  await who.getByRole('checkbox', { name: /Sophie \(you\)/ }).click();      // untick herself, Poppy only
  await who.getByRole('checkbox', { name: /Poppy/ }).click();
  await c.getByRole('button', { name: 'Book for Poppy' }).click();
  const booked = c.getByText(/You.re booked in|booked in/i), confirm = c.getByRole('button', { name: /Confirm booking/ });
  await booked.or(confirm).first().waitFor(T);
  if (await confirm.isVisible()) await confirm.click();
  await c.getByText(/Poppy.*booked|You.re booked in/i).first().waitFor(T);
  await closeSheet(c);
  assert.equal(await left(), '1 of 4 left', 'Poppy used a credit from Sophie’s pack');
  // the class now has Poppy in it (not Sophie), and one fewer spot
  await pickDay(c, 8);
  await c.locator('.cls', { hasText: 'Mums + Bubs' }).getByText('10 spots').waitFor(T);
  await c.locator('.cls', { hasText: 'Mums + Bubs' }).click();
  const picker = await c.getByRole('group', { name: /Who.s coming/ }).innerText();
  assert.ok(picker.includes('Sophie') && !picker.includes('Poppy'), 'Poppy is already in, only Sophie is still offered');
  await closeSheet(c);
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/schedule/' + weekOf(8));
  const link = s.getByRole('link', { name: /Mums \+ Bubs/ }).last();
  await link.waitFor(T);
  await link.click();
  await s.getByRole('heading', { name: /Mums/ }).waitFor(T);
  const row = s.locator('.rrow', { hasText: 'Poppy Archer' });
  await row.waitFor(T);
  await row.getByText('via Sophie Archer').waitFor(T);
  await row.getByText('4 class pack · 1 left').waitFor(T);   // Sophie's pack, shared with Poppy
  assert.equal(await s.locator('.rr-t strong', { hasText: /^Sophie Archer$/ }).count(), 0, 'Sophie herself is not in this class');
  await row.getByRole('button', { name: 'Check in Poppy' }).click();
  await row.getByRole('button', { name: /Undo check-in for Poppy/ }).waitFor(T);
});
