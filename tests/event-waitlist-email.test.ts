// Joining the waitlist for a full workshop sends "you're on the waitlist" (event_waitlisted), like classes do (waitlist_joined).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, memoryStorage, STATE_KEY } from '../src/data/demo';
import { EMAIL_DEFS, renderEmail, samplePayload } from '../src/domain/emails';
import type { AuthUser } from '../src/shared/types';
import { asClient, at } from './helpers';

const OWNER: AuthUser = { kind: 'staff', staffId: 'st_libby', email: '', name: 'Libby', role: 'owner' };
type Out = { kind: string; clientId: string; text: string; subject?: string };

function setup() {
  const storage = memoryStorage();
  const now = at('2026-10-14', '16:00');
  const store = createDemoStore({ sampleBilling: false, now: () => now, latencyMs: 0, storage, app: 'studio', studio: 'snowy' });
  const outbox = () => (JSON.parse(storage.getItem(STATE_KEY)!).data[store.studioId].features.appointments.outbox as Out[]);
  return { store, outbox, as: (u: AuthUser) => store.demoSignInAs!(u) };
}

test('the email exists, is editable, and renders with the event name', () => {
  assert.ok(EMAIL_DEFS.some((d) => d.kind === 'event_waitlisted' && d.group === 'Events'));
  const r = renderEmail('event_waitlisted', samplePayload('Snowy Pilates Club', 'event_waitlisted'))!;
  assert.match(r.subject, /on the waitlist: Reformer Basics Workshop/);
  assert.match(r.html, /If a place opens up/);
  assert.ok(!/[{}]/.test(r.subject + r.html));
});

test('joining a full event\'s waitlist queues the email, once; the place offer still goes out later', async () => {
  const { store, outbox, as } = setup();
  const a = store.features.appointments!;
  await as(OWNER);
  const ws = (await a.listEvents()).find((e) => e.kind === 'workshop')!;
  const clients = await store.listClients();
  const [jess, hannah] = [clients.find((c) => c.firstName === 'Jess')!.id, clients.find((c) => c.firstName === 'Hannah')!.id];
  await as(asClient(jess));
  const reg = await a.register({ eventId: ws.id, method: 'card_online' });   // the last place
  await as(asClient(hannah));
  await a.joinWaitlist({ eventId: ws.id });
  const mails = outbox().filter((m) => m.kind === 'event_waitlisted' && m.clientId === hannah);
  assert.equal(mails.length, 1);
  assert.match(mails[0]!.subject!, /on the waitlist/);
  await a.joinWaitlist({ eventId: ws.id }).catch(() => undefined);   // already on it
  assert.equal(outbox().filter((m) => m.kind === 'event_waitlisted' && m.clientId === hannah).length, 1, 'no second email');
  await as(asClient(jess));
  await a.cancelRegistration(reg.registration.id);
  await as(OWNER);
  await a.listEvents();   // the lazy sweep offers the place
  assert.equal(outbox().filter((m) => m.kind === 'waitlist_offer' && m.clientId === hannah).length, 1);
});

test('switching the email off in Settings > Emails stops it', async () => {
  const { store, outbox, as } = setup();
  const a = store.features.appointments!;
  await as(OWNER);
  await store.saveEmailTemplate!('event_waitlisted', { enabled: false });
  const ws = (await a.listEvents()).find((e) => e.kind === 'workshop')!;
  const clients = await store.listClients();
  const [jess, hannah] = [clients.find((c) => c.firstName === 'Jess')!.id, clients.find((c) => c.firstName === 'Hannah')!.id];
  await as(asClient(jess)); await a.register({ eventId: ws.id, method: 'card_online' });
  await as(asClient(hannah)); await a.joinWaitlist({ eventId: ws.id });
  assert.equal(outbox().filter((m) => m.kind === 'event_waitlisted').length, 0);
});
