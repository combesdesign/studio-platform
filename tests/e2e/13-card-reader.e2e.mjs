import assert from 'node:assert/strict';
import { journey, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
await journey('13 card reader demo: a charge succeeds, a decline is handled and nothing is recorded', async (env) => {
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  await goStudio(s, '#/settings/payments');
  const panel = s.getByTestId('card-reader-panel');
  await panel.getByPlaceholder('sepia-cat-river').fill('sepia-cat-river');
  await panel.getByRole('button', { name: 'Add reader' }).click();
  await s.getByText('Card reader added').waitFor(T);
  await panel.getByText('Demo reader (simulated)').waitFor(T);

  const salesCount = async () => {
    await goStudio(s, '#/reports');
    await s.getByText('Revenue', { exact: true }).first().waitFor(T);
    return s.locator('.view, main').first().innerText();
  };
  const report = (re) => eventually(async () => { const t = await salesCount(); if (!re.test(t)) throw new Error(t.slice(0, 300)); return true; }, `report to match ${re}`);
  await report(/Revenue\s*\$0\s*0 sales/);

  // a decline: the demo reader declines when the sale note says "decline"
  await goStudio(s, '#/pos');
  await s.locator('.tile', { hasText: 'Grip socks' }).click();
  await s.getByRole('radio', { name: 'Card reader' }).first().waitFor(T);
  await s.getByPlaceholder('Note (optional)').fill('decline please');
  await s.getByRole('button', { name: /Charge \$20\.00 on reader/ }).click();
  await s.getByRole('heading', { name: /Tap or insert card/ }).waitFor(T);
  await s.getByRole('heading', { name: 'The card was declined.' }).waitFor(T);
  await s.getByRole('button', { name: 'Try again' }).waitFor(T);
  await s.getByRole('button', { name: 'Back to cart' }).click();
  await report(/Revenue\s*\$0\s*0 sales/);       // declined: nothing was recorded

  // a charge that goes through: the sale is recorded once, stock drops
  await goStudio(s, '#/pos');
  await s.locator('.tile', { hasText: 'Grip socks' }).click();
  await s.getByRole('button', { name: /Charge \$20\.00 on reader/ }).click();
  await s.getByRole('heading', { name: /Tap or insert card/ }).waitFor(T);
  await s.getByRole('heading', { name: /All done/ }).waitFor({ timeout: 15000 });
  await s.getByText(/\$20\.00 paid by card reader/).waitFor(T);
  await report(/Revenue\s*\$20\s*1 sale/);
  await goStudio(s, '#/pos');
  await s.locator('.tile', { hasText: 'Grip socks' }).getByText('14 in stock').waitFor(T);
});
