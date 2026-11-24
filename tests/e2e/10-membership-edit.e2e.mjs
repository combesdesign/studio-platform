import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, T, dayStr } from './lib.mjs';
await journey('10 studio moves a membership renewal date and switches the plan, client sees the pending change', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Hannah');
  await c.getByRole('button', { name: 'Passes' }).click();
  await c.getByText('Renews 5 Dec').waitFor(T);
  await c.getByText('2 Classes Per Week Membership').first().waitFor(T);

  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/clients');
  await s.locator('input.input').first().fill('Hannah');
  await s.getByRole('link', { name: /Hannah Mitchell/ }).first().click();
  const card = s.locator('.b-item, .pass-row, li, div', { hasText: '2 Classes Per Week Membership' }).filter({ has: s.getByRole('button', { name: 'Edit' }) }).last();
  await card.getByRole('button', { name: 'Edit' }).click();

  // renewal date: 5 Dec -> 9 Dec
  await s.getByLabel('Next billing date').fill(dayStr(8));
  await s.getByRole('button', { name: 'Review change' }).click();
  await s.getByText(/will be charged next on/).waitFor(T);
  await s.getByRole('button', { name: 'Move renewal date' }).click();
  await s.getByText('Renewal moved to').waitFor(T);
  await c.getByText('Renews 9 Dec').waitFor(T);

  // switch to the 3 classes a week membership from the next cycle
  await card.getByRole('button', { name: 'Edit' }).click();
  await s.getByText('Different membership', { exact: true }).click();
  await s.getByRole('radio', { name: /3 Classes Per Week Membership/ }).click();
  await s.getByRole('button', { name: 'Review change' }).click();
  await s.getByText(/They keep 2 classes a week until/).waitFor(T);
  await s.getByRole('button', { name: /^Move to 3 Classes Per Week Membership/ }).click();
  await s.getByText(/Hannah is moving to 3 Classes Per Week Membership/).waitFor(T);

  // the client's Passes screen shows the pending change, and still has the old plan today
  await c.getByText(/Changing to\s*3 Classes Per Week Membership\s*from 9 Dec/).waitFor(T);
  await c.getByText('2 Classes Per Week Membership').first().waitFor(T);
});
