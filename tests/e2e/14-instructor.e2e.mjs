import assert from 'node:assert/strict';
import { journey, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
await journey('14 instructor login: only the allowed screens, no health notes for clients outside her classes', async (env) => {
  const s = await env.studio();
  const openClient = async (name) => {
    await goStudio(s, '#/clients');
    await s.locator('input.input').first().fill(name);
    await s.locator('a[href^="#/clients/"]', { hasText: name }).first().click();
    await s.getByText('Health & waiver').waitFor(T);
  };
  const body = () => s.locator('body').innerText();

  // the owner sees Kylie's health notes (the baseline), then signs out
  await studioSignInAs(s, 'Libby');
  await openClient('Kylie');
  await s.getByText(/Postnatal \(3 months\)/).first().waitFor(T);
  await s.getByRole('button', { name: 'Sign out' }).click();
  await s.getByRole('button', { name: /Sign in as Grace T/ }).waitFor(T);

  await studioSignInAs(s, 'Grace T');
  await eventually(async () => {
    const labels = (await s.locator('nav, .nav, .sidebar').first().innerText()).split('\n').map((x) => x.trim()).filter(Boolean);
    for (const ok of ['Today', 'Schedule', 'Appointments', 'Clients', 'Point of sale', 'Reports', 'Cover', 'Reviews']) if (!labels.includes(ok)) throw new Error(`missing ${ok}: ${labels}`);
    for (const no of ['Settings', 'Payroll', 'Marketing', 'Kiosk mode', 'Shop', 'Online classes']) if (labels.includes(no)) throw new Error(`should not show ${no}`);
    return true;
  }, 'instructor nav');

  // the blocked screens say so, even by address
  for (const hash of ['#/settings', '#/payroll', '#/marketing', '#/kiosk']) {
    await goStudio(s, hash);
    await s.getByText('Not available for your role').waitFor(T);
  }

  // health notes follow the default policy: only for clients booked into her own classes
  await openClient('Kylie');                  // Kylie is in Grace P's Mums + Bubs, not Grace T's classes
  await s.getByText('Health notes are private for this client. Ask the owner or a manager if you need them.').waitFor(T);
  let t = await body();
  assert.doesNotMatch(t, /Postnatal|Injury noted|Pregnant \/ postnatal|Do you have any current injuries/);
  await openClient('Georgia');                // Georgia is in Grace T's 6am class today
  await s.getByText('Do you have any current injuries').waitFor(T);
  assert.doesNotMatch(await body(), /Health notes are private/);
});
