import assert from 'node:assert/strict';
import { journey, studioSignInAs, goStudio, T, eventually } from './lib.mjs';
await journey('5 POS: pack + merch with a promo code, cash, then void: credits, stock and report total go back', async (env) => {
  const s = await env.studio();
  await studioSignInAs(s, 'Libby');
  // a second studio tab does the checking, so the receipt (and its Void button) stays open on the first
  const v = await env.studio();
  const stats = async () => { await goStudio(v, '#/reports'); await v.getByText('Revenue', { exact: true }).first().waitFor(T); return v.locator('.view, main').first().innerText(); };
  const revenue = async (re) => eventually(async () => { const t = await stats(); if (!re.test(t)) throw new Error(JSON.stringify(t.replace(/\n+/g, ' ').slice(0, 400))); return true; }, `revenue to match ${re}`);
  const jessLeft = async () => {
    await goStudio(v, '#/clients');
    await v.locator('input.input').first().fill('Jess');
    await v.getByRole('link', { name: /Jess Walker/ }).first().click();
    await v.getByText('Passes').first().waitFor(T);
    return v.locator('body').innerText();
  };
  const jess = (re, want = true) => eventually(async () => { if (re.test(await jessLeft()) !== want) throw new Error(`Jess profile ${want ? 'lacks' : 'still has'} ${re}`); return true; }, `Jess ${re}`);
  await revenue(/Revenue\s*\$0\s*0 sales/);
  await jess(/8 of 8 left/, false);

  await goStudio(s, '#/pos');
  await s.locator('.tile', { hasText: '8 class pack' }).click();
  await s.locator('.tile', { hasText: 'Grip socks' }).click();
  await s.getByRole('button', { name: 'Add client' }).click();
  await s.locator('.sheet input.input, [role=dialog] input.input').first().fill('Jess');
  await s.getByText('Jess Walker').first().click();
  await s.getByRole('button', { name: /Promo code or gift card/ }).click();
  await s.getByLabel('Promo code').fill('spring5');
  await s.getByRole('button', { name: 'Apply', exact: true }).click();
  await s.locator('.pc-totals').getByText('$205.00').first().waitFor(T);   // $190 + $20, less the $5 promo
  await s.getByRole('radio', { name: 'Cash' }).click();
  await s.getByRole('button', { name: 'Charge $205.00' }).click();
  await s.getByRole('heading', { name: /All done/ }).waitFor(T);
  await s.getByText(/\$205\.00 paid by cash/).waitFor(T);
  await s.locator('.receipt .rc-items').getByText('Discount').waitFor(T);

  // the effects are real: report total, Jess's pack and the socks stock
  await revenue(/Revenue\s*\$205\s*1 sale/);
  await jess(/8 of 8 left/);
  await goStudio(v, '#/pos');
  await v.locator('.tile', { hasText: 'Grip socks' }).getByText('14 in stock').waitFor(T);

  // void the cash sale from the receipt
  await s.getByRole('button', { name: /Void sale/ }).click();
  await s.getByText(/Checking/).waitFor({ state: 'hidden', ...T });
  await s.getByRole('button', { name: 'Void sale', exact: true }).click();
  await s.getByText('Sale voided').waitFor(T);
  await revenue(/Revenue\s*\$0\s*after \$205 refunds/);   // net revenue is back to nothing: the void is a full refund
  await jess(/Voided/);
  await jess(/8 of 8 left/, false);
  await jess(/1 of 4 left/);   // her old pack is untouched
  await goStudio(v, '#/pos');
  await v.locator('.tile', { hasText: 'Grip socks' }).getByText('15 in stock').waitFor(T);
});
