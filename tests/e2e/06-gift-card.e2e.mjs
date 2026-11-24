import assert from 'node:assert/strict';
import { journey, clientSignInAs, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
await journey('6 gift card bought online is redeemed at the POS', async (env) => {
  const c = await env.client();
  await clientSignInAs(c, 'Hannah');
  await c.evaluate(() => { location.hash = '#/gift-cards/buy'; });
  await c.getByRole('heading', { name: /Give the gift of/ }).waitFor(T);
  await c.locator('.cm-money input').fill('50');
  await c.getByLabel('Their name').fill('Maya Friend');
  await c.getByLabel('Their email').fill('maya.friend@example.com');
  await c.getByRole('button', { name: /Continue to payment · \$50/ }).click();
  await c.getByRole('button', { name: /^Pay \$50/ }).click();
  await c.getByRole('heading', { name: /Gift sent/ }).waitFor(T);
  await c.getByText('maya.friend@example.com').first().waitFor(T);

  // studio: the card is on the Shop tab with its full code and $50 balance
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/shop/gift-cards');
  const row = s.locator('.cm-row', { hasText: 'Maya Friend' });
  await row.waitFor(T);
  await row.getByText('$50', { exact: true }).waitFor(T);
  const code = (await row.locator('.cm-code').innerText()).trim();
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$/);

  // POS: 4 class pack for Jess ($100) paid partly with the gift card
  await goStudio(s, '#/pos');
  await s.locator('.tile', { hasText: '4 class pack' }).click();
  await s.getByRole('button', { name: 'Add client' }).click();
  await s.locator('.sheet input.input, [role=dialog] input.input').first().fill('Jess');
  await s.getByText('Jess Walker').first().click();
  await s.getByRole('button', { name: /Promo code or gift card/ }).click();
  await s.getByLabel('Gift card code').fill(code);
  await s.getByRole('button', { name: 'Add', exact: true }).last().click();
  await s.locator('.pc-totals').getByText('$50.00').first().waitFor(T);   // $100 less the $50 card
  await s.getByRole('radio', { name: 'Cash' }).click();
  await s.getByRole('button', { name: 'Charge $50.00' }).click();
  await s.getByRole('heading', { name: /All done/ }).waitFor(T);
  await s.getByText(/\$50\.00 paid by cash/).waitFor(T);

  // the card is spent: balance $0 in the shop list, and the code won't redeem twice
  await goStudio(s, '#/shop/gift-cards');
  await s.getByText('All', { exact: true }).click();
  const spent = s.locator('.cm-row', { hasText: 'Maya Friend' });
  await spent.waitFor(T);
  await eventually(async () => /\$0\b/.test(await spent.locator('.cm-row-bal').innerText()), 'gift card balance to hit $0');
  await goStudio(s, '#/pos');
  await s.locator('.tile', { hasText: 'Grip socks' }).click();
  await s.getByRole('button', { name: /Promo code or gift card/ }).click();
  await s.getByLabel('Gift card code').fill(code);
  await s.getByRole('button', { name: 'Add', exact: true }).last().click();
  await s.getByText(/no balance|used up|spent|nothing left|has been used/i).first().waitFor(T);
});
