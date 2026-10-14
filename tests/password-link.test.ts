// Demo store: the "Choose a new password" flow (reset + invite links) is demoable end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, memoryStorage, PERSONA_EMAILS } from '../src/data/demo';
import { StoreError } from '../src/shared/store';

type Kind = 'invite' | 'recovery' | undefined;
type DemoExtras = { demoOpenPasswordLink(kind?: 'invite' | 'recovery', email?: string): Promise<boolean> };

const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return e instanceof StoreError ? e.code : String(e); } };

test('reset link: fires the handler, setNewPassword checks length, then signs that client in', async () => {
  const store = createDemoStore({ storage: memoryStorage(), latencyMs: 0, app: 'client' });
  const extras = store as unknown as DemoExtras;
  const got: Kind[] = [];
  const off = store.onPasswordRecovery!((kind?: Kind) => { got.push(kind); });

  await store.requestPasswordReset(PERSONA_EMAILS.member);
  assert.equal(await extras.demoOpenPasswordLink('recovery', PERSONA_EMAILS.member), true);
  assert.deepEqual(got, ['recovery']);
  assert.equal(await store.currentUser(), null, 'not signed in until the new password is saved');

  assert.equal(await code(store.setNewPassword!('short')), 'INVALID');
  await store.setNewPassword!('a lovely long one');
  const me = await store.currentUser();
  assert.equal(me?.kind, 'client');
  assert.equal(me?.email, PERSONA_EMAILS.member);

  off();
  assert.equal(await extras.demoOpenPasswordLink('recovery', PERSONA_EMAILS.member), false, 'no screen registered');
});

test('invite link: client app picks the imported Momence client; unknown emails resolve without signing in', async () => {
  const store = createDemoStore({ storage: memoryStorage(), latencyMs: 0, app: 'client' });
  const extras = store as unknown as DemoExtras;
  const got: Kind[] = [];
  store.onPasswordRecovery!((kind?: Kind) => { got.push(kind); });

  await extras.demoOpenPasswordLink('invite');
  assert.deepEqual(got, ['invite']);
  await store.setNewPassword!('welcome aboard');
  const me = await store.currentUser();
  assert.equal(me?.kind === 'client' && me.name, 'Margaret Hollis');

  await store.signOut();
  await extras.demoOpenPasswordLink('recovery', 'nobody@example.com');
  await store.setNewPassword!('still resolves');
  assert.equal(await store.currentUser(), null);
});

test('studio app: a staff reset link signs the staff member in; a client email does not', async () => {
  const store = createDemoStore({ storage: memoryStorage(), latencyMs: 0, app: 'studio' });
  const extras = store as unknown as DemoExtras;
  store.onPasswordRecovery!(() => {});
  await extras.demoOpenPasswordLink('recovery', PERSONA_EMAILS.member);
  await store.setNewPassword!('long enough');
  assert.equal(await store.currentUser(), null, 'clients are not signed in to the studio app');

  await extras.demoOpenPasswordLink('recovery', 'libby@snowypilatesclub.com');
  await store.setNewPassword!('long enough');
  const me = await store.currentUser();
  assert.equal(me?.kind === 'staff' && me.role, 'owner');
});
