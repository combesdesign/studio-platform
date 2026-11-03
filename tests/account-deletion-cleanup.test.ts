// Deleting an account also cancels what is still ahead (event places, appointments) and clears the person from the feature data.
// Live equivalent: 3003_account_deletion_cleanup.sql (tested in supabase/tests/account_deletion.sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, memoryStorage } from '../src/data/demo';
import { studioToUTC } from '../src/shared/format';
import type { AuthUser, ID } from '../src/shared/types';
import type { DataStore } from '../src/shared/store';
import { asClient, at } from './helpers';

const NOW = at('2026-10-14', '16:00');
const OWNER: AuthUser = { kind: 'staff', staffId: 'st_libby', email: '', name: 'Libby', role: 'owner' };

function demo() {
  const store = createDemoStore({ sampleBilling: false, now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio', studio: 'snowy' });
  return { store, as: (u: AuthUser) => store.demoSignInAs!(u) };
}
async function clientId(store: DataStore, first: string): Promise<ID> {
  await store.demoSignInAs!(OWNER);
  return (await store.listClients()).find((c) => c.firstName === first)!.id;
}

test('deleting an account cancels the event place (and offers it on), the appointment, and the waitlist spot', async () => {
  const { store, as } = demo();
  const a = store.features.appointments!;
  const jess = await clientId(store, 'Jess');
  const hannah = await clientId(store, 'Hannah');
  const ws = (await a.listEvents()).find((e) => e.kind === 'workshop')!;
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const slot = (await a.listSlots({ typeId: priv.id, from: '2026-10-20', to: '2026-10-20', staffId: 'st_libby' })).find((s) => s.startsAt === studioToUTC('2026-10-20', '10:30'))!;

  await as(asClient(jess));
  const reg = await a.register({ eventId: ws.id, method: 'card_online' });   // the last place
  await as(OWNER);
  const appt = await a.bookAppointment({ typeId: priv.id, staffId: 'st_libby', startsAt: slot.startsAt, clientId: jess, pay: { method: 'cash' } });
  await as(asClient(hannah));
  await a.joinWaitlist({ eventId: ws.id });

  await as(asClient(jess));
  await store.deleteMyAccount();

  await as(OWNER);
  const regs = await a.listRegistrations({ eventId: ws.id });
  const mine = regs.find((r) => r.id === reg.registration.id)!;
  assert.deepEqual([mine.status, mine.refundDue], ['cancelled', true], 'the place is cancelled and flagged for refund (they paid)');
  const appts = await a.listAppointments({ clientId: jess, includeCancelled: true });
  assert.equal(appts.find((x) => x.id === appt.appointment.id)!.status, 'cancelled', 'the appointment is cancelled');
  const slots = await a.listSlots({ typeId: priv.id, from: '2026-10-20', to: '2026-10-20', staffId: 'st_libby' });
  assert.ok(slots.some((s) => s.startsAt === slot.startsAt), 'and its time is bookable again');
  await as(asClient(hannah));
  assert.equal((await a.getEvent(ws.id)).myWaitlist!.status, 'offered', 'the freed place goes to the next person in line');
});

test('deleting an account scrubs marketing log rows and review comments', async () => {
  const { store, as } = demo();
  const jess = await clientId(store, 'Jess');
  const m = store.features.marketing!, r = store.features.reviews!;
  await as(OWNER);
  const log = () => m.listMessageLog({ limit: 5000 }).then((l) => l.filter((x) => x.clientId === jess));
  assert.ok((await log()).some((l) => l.to !== ''), 'the seed has messages for Jess (otherwise this test proves nothing)');
  const reviews = await r.list();
  const theirs = reviews.length;
  await as(asClient(jess));
  await store.deleteMyAccount();
  await as(OWNER);
  const after = await log();
  assert.ok(after.every((l) => l.to === '' && l.clientName === '' && l.status !== 'queued'), 'log rows stay without address or name, and nothing is left queued');
  assert.equal((await r.list()).length, theirs, 'ratings stay for the averages');
});
