import assert from 'node:assert/strict';
import { ANCHOR, journey, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
// 8:45am: the 9:30 class is inside the kiosk's one hour window
await journey('12 kiosk: client checks herself in, exit needs the PIN, five wrong tries lock it', async (env) => {
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/settings/kiosk');
  await s.getByLabel(/PIN \(4 numbers\)/).fill('2468');
  await s.getByRole('button', { name: /Set PIN/ }).click();
  await s.getByText('Kiosk PIN saved').waitFor(T);

  await goStudio(s, '#/kiosk');
  const kiosk = s.getByRole('dialog', { name: 'Check-in' });
  await kiosk.waitFor(T);
  await kiosk.locator('.k-card', { hasText: 'Mat Essentials' }).click();
  const people = kiosk.locator('.k-person');
  await people.first().waitFor(T);
  const first = people.first();
  const who = (await first.innerText()).split('\n')[0].trim();
  const firstName = who.split(' ')[0];
  await kiosk.getByLabel('Search by first name').fill(firstName.slice(0, 3));
  await kiosk.locator('.k-person', { hasText: firstName }).first().click();
  await kiosk.getByRole('heading', { name: new RegExp(`You.re in, ${firstName}`) }).waitFor(T);

  // the roster on the studio side has her checked in
  const v = await env.studio();
  await goStudio(v, '#/');
  await v.getByRole('link', { name: 'Open roster' }).click();
  await v.getByRole('button', { name: new RegExp(`Undo check-in for ${firstName}`) }).waitFor(T);

  // exiting needs the PIN: one wrong, then the right one
  const pad = (digits) => digits.split('').reduce((p, d) => p.then(() => s.getByRole('dialog', { name: 'Exit kiosk' }).getByRole('button', { name: d, exact: true }).click()), Promise.resolve());
  await s.getByRole('button', { name: 'Exit kiosk' }).click();
  const exit = s.getByRole('dialog', { name: 'Exit kiosk' });
  await exit.waitFor(T);
  await pad('1111');
  await exit.getByText("That PIN isn't right.").waitFor(T);
  assert.ok(await kiosk.isVisible(), 'still in the kiosk');
  await pad('2468');
  await kiosk.waitFor({ state: 'hidden', ...T });
  await s.locator('.today .stats').waitFor(T);

  // five wrong tries lock the exit, even for the right PIN
  await goStudio(s, '#/kiosk');
  await kiosk.waitFor(T);
  await s.getByRole('button', { name: 'Exit kiosk' }).click();
  await exit.waitFor(T);
  for (let i = 1; i <= 5; i++) {
    await pad('9999');
    if (i < 5) await exit.getByText("That PIN isn't right.").waitFor(T);
  }
  await exit.getByText(/Too many tries\. Exit is locked for 5 minutes/).waitFor(T);
  // the keypad is dead while locked: tapping the right PIN (even by script) does nothing
  await exit.evaluate((el) => { for (const d of '2468') [...el.querySelectorAll('button')].find((b) => b.textContent === d).click(); });
  await exit.getByText(/Too many tries/).waitFor(T);
  assert.ok(await kiosk.isVisible(), 'the right PIN does not get out while locked');
  // the lockout survives a reload
  await s.reload();
  await kiosk.waitFor(T);
  await s.getByRole('button', { name: 'Exit kiosk' }).click();
  await exit.getByText(/Too many tries/).waitFor(T);
}, { time: new Date(ANCHOR.getTime() + 45 * 60_000) });
