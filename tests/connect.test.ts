// Stripe Connect in the demo: the studio's owner sees "not connected", the fake "Connect Stripe" flow marks it connected, staff and
// clients can't see or start it, and Snowy (the default studio) stays on its own single Stripe account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, memoryStorage } from '../src/data/demo';

const NOW = new Date('2026-10-19T08:00:00+11:00');
const make = (studio: string, storage = memoryStorage()) => createDemoStore({ now: () => NOW, latencyMs: 0, storage, app: 'studio', studio });

test('Harbour: not connected until the owner connects; then it stays connected', async () => {
  const storage = memoryStorage();
  const harbour = make('harbour', storage);
  const owner = (await harbour.demoPersonas!()).find((u) => u.kind === 'staff' && u.role === 'owner')!;
  await harbour.demoSignInAs!(owner);
  const before = await harbour.getPaymentsStatus();
  assert.deepEqual([before.connectMode, before.connected, before.chargesEnabled, before.accountId], [true, false, false, undefined]);
  assert.equal(await harbour.startPaymentsOnboarding('https://app.example/studio/#/settings/payments'), null, 'demo: nothing to open, it just connects');
  const after = await harbour.getPaymentsStatus();
  assert.deepEqual([after.connected, after.chargesEnabled, after.payoutsEnabled, after.detailsSubmitted, after.accountId], [true, true, true, true, 'acct_demoharbour']);
  // a second tab on the same demo sees it
  const again = make('harbour', storage);
  await again.demoSignInAs!(owner);
  assert.equal((await again.getPaymentsStatus()).connected, true);
});

test('only the owner can see or start it (staff and clients are refused)', async () => {
  const harbour = make('harbour');
  const people = await harbour.demoPersonas!();
  for (const u of people.filter((p) => !(p.kind === 'staff' && p.role === 'owner'))) {
    await harbour.demoSignInAs!(u);
    await assert.rejects(harbour.getPaymentsStatus(), { code: 'NOT_ALLOWED' });
    await assert.rejects(harbour.startPaymentsOnboarding('x'), { code: 'NOT_ALLOWED' });
  }
});

test('Snowy stays on its own Stripe account: nothing to connect', async () => {
  const snowy = make('snowy');
  const owner = (await snowy.demoPersonas!()).find((u) => u.kind === 'staff' && u.role === 'owner')!;
  await snowy.demoSignInAs!(owner);
  const s = await snowy.getPaymentsStatus();
  assert.equal(s.connectMode, false);
  assert.equal(s.connected, false);
  await assert.rejects(snowy.startPaymentsOnboarding('x'), { code: 'CONNECT_OFF' });
});
