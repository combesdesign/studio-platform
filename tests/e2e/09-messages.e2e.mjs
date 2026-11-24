import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
await journey('9 client messages the studio, studio replies from the inbox, client sees the reply and the unread badge', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Jess');
  await c.getByRole('button', { name: 'Profile' }).click();
  const entry = c.locator('.list-row', { hasText: 'Messages' });
  await entry.waitFor(T);
  assert.equal(await entry.getByLabel(/unread/).count(), 0, 'no unread badge to start with');
  await entry.click();
  await c.getByLabel('Message', { exact: true }).fill('Hi! Can I swap to the 9:30 class on Friday?');
  await c.getByRole('button', { name: 'Send', exact: true }).click();
  await c.getByText('Hi! Can I swap to the 9:30 class on Friday?').waitFor(T);
  await c.getByRole('button', { name: /Profile|Back/ }).first().click();
  await entry.waitFor(T);

  // studio inbox: the thread shows up unread, Libby replies
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/marketing/inbox');
  const thread = s.locator('.mk-threads button, .mk-threads a', { hasText: 'Jess Walker' });
  await thread.waitFor(T);
  await thread.getByLabel('1 unread').waitFor(T);
  await thread.click();
  await s.getByText('Hi! Can I swap to the 9:30 class on Friday?').waitFor(T);
  await s.getByRole('textbox', { name: 'Reply' }).fill('Yes of course, you are on the 9:30 on Friday now. See you then!');
  await s.getByRole('button', { name: 'Send', exact: true }).click();
  await s.getByText('Yes of course, you are on the 9:30 on Friday now. See you then!').waitFor(T);
  await thread.getByLabel(/unread/).waitFor({ state: 'detached', ...T });   // her own message is read now

  // client: the badge appears on the Messages row, the reply is in the thread, and the badge clears once read
  await entry.getByLabel('1 unread').waitFor(T);
  await entry.click();
  await c.getByText('Yes of course, you are on the 9:30 on Friday now. See you then!').waitFor(T);
  await c.getByRole('button', { name: /Profile|Back/ }).first().click();
  await entry.waitFor(T);
  await entry.getByLabel(/unread/).waitFor({ state: 'detached', ...T });
});
