// Gap-fills (27 Oct): the remaining client emails are editable, staff can move an appointment, dependants get the health
// check, appointments and events can sit in a room, and the client app shows a pending membership move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMAIL_DEFS, renderEmail, samplePayload } from '../src/domain/emails';
import { createDemoStore, memoryStorage, STATE_KEY } from '../src/data/demo';
import { addDays, studioDate } from '../src/shared/format';
import type { AuthUser, ID } from '../src/shared/types';
import type { DataStore } from '../src/shared/store';
import { asClient, at } from './helpers';

const NOW = at('2026-10-14', '16:00');
const owner: AuthUser = { kind: 'staff', staffId: 'st_libby', email: 'libby@snowypilatesclub.com', name: 'Libby', role: 'owner' };
function demo() {
  let t = NOW;
  const storage = memoryStorage();
  const store = createDemoStore({ sampleBilling: false, now: () => t, latencyMs: 0, storage, app: 'studio', studio: 'snowy' });
  return { store, storage, as: (u: AuthUser) => store.demoSignInAs!(u), setNow: (d: Date) => { t = d; } };
}
async function clientId(store: DataStore, first: string): Promise<ID> {
  await store.demoSignInAs!(owner);
  return (await store.listClients()).find((c) => c.firstName === first)!.id;
}
const outbox = (d: ReturnType<typeof demo>) => (JSON.parse(d.storage.getItem(STATE_KEY)!).data[d.store.studioId].features.appointments.outbox ?? []) as { kind: string; text: string; subject?: string }[];

// ---------------------------------------------------------------- 1. editable emails, the rest
const NEW_KINDS = ['receipt', 'gift_card', 'appointment_confirmed', 'appointment_cancelled', 'appointment_moved', 'appointment_reminder', 'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer'];

test('emails: every client email is in the editable list, with standard wording that renders and merges every tag', () => {
  for (const k of NEW_KINDS) assert.ok(EMAIL_DEFS.some((d) => d.kind === k), `${k} is editable`);
  for (const d of EMAIL_DEFS) {
    const r = renderEmail(d.kind, samplePayload('Snowy Pilates Club', d.kind))!;
    assert.ok(r.subject && !/[{}]/.test(r.subject), `${d.kind}: subject has no stray tags (${r.subject})`);
    assert.ok(!/\{[a-z_]+\}/.test(r.html + r.text), `${d.kind}: no stray tags in the body`);
  }
  const p = samplePayload('Snowy Pilates Club', 'appointment_moved');
  assert.equal(renderEmail('appointment_moved', p)!.subject, 'Moved: Private Reformer, 6:00am Tue 28 Oct');
  assert.match(renderEmail('appointment_moved', p)!.html, /It was 9:00am Tue 28 Oct\./);
  assert.equal(renderEmail('receipt', samplePayload('Snowy Pilates Club', 'receipt'))!.subject, 'Your receipt from Snowy Pilates Club');
  assert.match(renderEmail('gift_card', samplePayload('Snowy Pilates Club', 'gift_card'))!.html, /GIFT-7K3Q-9XPM/);
  assert.equal(renderEmail('gift_card', { ...samplePayload('X', 'gift_card'), from_name: '' })!.subject, 'Someone sent you a X gift card');
});

test('emails: a studio\'s own subject and intro apply to receipts, gift cards, appointments and events; the fixed parts stay', () => {
  const ov = (kind: string, o: object) => ({ ...samplePayload('Snowy Pilates Club', kind), email_overrides: { [kind]: o } });
  const a = renderEmail('appointment_confirmed', ov('appointment_confirmed', { subject: 'Locked in, {first_name}', intro: 'See you at {session_time} with {instructor}.{paid_note}' }))!;
  assert.equal(a.subject, 'Locked in, Hannah');
  assert.match(a.html, /See you at 6:00am Tue 28 Oct with Julia\. You paid \$120\.00\./);
  assert.match(a.html, /Private Reformer/, 'the session box is still added');
  assert.match(renderEmail('receipt', ov('receipt', { intro: 'Cheers {first_name}, {total} received.' }))!.html, /Cheers Hannah, \$105\.00 received\./);
  const g = renderEmail('gift_card', ov('gift_card', { subject: 'A present from {from_name}' }))!;
  assert.equal(g.subject, 'A present from Hank');
  assert.match(g.html, /GIFT-7K3Q-9XPM/, 'the code is never editable away');
  // cancellations keep the credit / refund sentences unless the studio replaces the intro
  const late = { ...samplePayload('Snowy', 'event_cancelled'), late: true, credit_returned: false };
  assert.match(renderEmail('event_cancelled', late)!.html, /Your workshop has been cancelled\. It was inside the cancellation window/);
  const byStudio = { ...samplePayload('Snowy', 'event_cancelled'), cancelled_by_studio: true, reason: 'low numbers', refund_due: true };
  assert.match(renderEmail('event_cancelled', byStudio)!.html, /we’ve had to cancel this workshop \(low numbers\)\. We’ll refund what you paid\./);
  assert.match(renderEmail('waitlist_offer', { ...samplePayload('Snowy', 'waitlist_offer'), amount_cents: 0 })!.html, /save your spot before then/);
});

test('emails: the edge function copy matches, and the demo wording follows Settings > Emails for appointments and events', async () => {
  assert.equal(readFileSync('src/domain/emails.ts', 'utf8'), readFileSync('supabase/functions/_shared/emails.ts', 'utf8'));
  const d = demo();
  await d.as(owner);
  const a = d.store.features.appointments!;
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const hannah = await clientId(d.store, 'Hannah');
  const slots = await a.listSlots({ typeId: priv.id, from: addDays(studioDate(NOW), 5), to: addDays(studioDate(NOW), 24) });
  const days = [...new Map(slots.map((x) => [studioDate(new Date(x.startsAt)), x])).values()];   // one slot per day, so none overlap
  assert.ok(days.length >= 4);
  const book = (s: typeof slots[number]) => a.bookAppointment({ typeId: priv.id, staffId: s.staffId, startsAt: s.startsAt, clientId: hannah, pay: { method: 'cash' } });
  await book(days[0]!);
  assert.equal(outbox(d).at(-1)!.subject, `You're booked: Private Session, ${outbox(d).at(-1)!.subject!.split(', ').slice(1).join(', ')}`);
  await d.store.saveEmailTemplate('appointment_confirmed', { subject: 'Locked in: {session_name}' });
  await book(days[1]!);
  assert.equal(outbox(d).at(-1)!.subject, 'Locked in: Private Session');
  await d.store.saveEmailTemplate('appointment_confirmed', { enabled: false });
  const n = outbox(d).length;
  await book(days[2]!);
  assert.equal(outbox(d).length, n, 'switched off: nothing goes out');
  await d.store.saveEmailTemplate('appointment_moved', { subject: 'New time, {first_name}' });
  const appt = (await a.listAppointments()).find((x) => x.clientId === hannah && x.startsAt === days[0]!.startsAt)!;
  await a.moveAppointment(appt.id, { startsAt: days[3]!.startsAt, staffId: days[3]!.staffId });
  assert.equal(outbox(d).at(-1)!.kind, 'appointment_moved');
  assert.equal(outbox(d).at(-1)!.subject, 'New time, Hannah');
  // "Send me a test" works for the new kinds, and unknown kinds are refused
  await d.store.saveEmailTemplate('receipt', { subject: 'Receipt for you' });
  assert.equal((await d.store.sendTestEmail('receipt')).to, 'libby@snowypilatesclub.com');
  assert.equal((await d.store.sendTestEmail('waitlist_offer')).to, 'libby@snowypilatesclub.com');
  await assert.rejects(d.store.sendTestEmail('nonsense'));
  void asClient;
});

// ---------------------------------------------------------------- 2. staff move an appointment
test('staff move: any time (inside the client window too), to any instructor who offers the type, same payment, "moved" email goes', async () => {
  const d = demo();
  await d.as(owner);
  const a = d.store.features.appointments!;
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const hannah = await clientId(d.store, 'Hannah');
  const slots = await a.listSlots({ typeId: priv.id, from: addDays(studioDate(NOW), 5), to: addDays(studioDate(NOW), 24) });
  const days = [...new Map(slots.map((x) => [studioDate(new Date(x.startsAt)), x])).values()];
  const booked = await a.bookAppointment({ typeId: priv.id, staffId: days[0]!.staffId, startsAt: days[0]!.startsAt, clientId: hannah, pay: { method: 'cash' } });
  // 30 minutes before it starts: the client window is long gone
  d.setNow(new Date(Date.parse(days[0]!.startsAt) - 30 * 60_000));
  await d.as(asClient(hannah));
  await assert.rejects(a.moveAppointment(booked.appointment.id, { startsAt: days[1]!.startsAt, staffId: days[1]!.staffId }), /TOO_LATE|cancellation window|contact the studio/i);
  await d.as(owner);
  const other = (await a.listSlots({ typeId: priv.id, from: studioDate(new Date(days[2]!.startsAt)), to: studioDate(new Date(days[2]!.startsAt)), excludeAppointmentId: booked.appointment.id })).find((s) => s.staffId !== days[0]!.staffId) ?? days[2]!;
  const moved = await a.moveAppointment(booked.appointment.id, { startsAt: other.startsAt, staffId: other.staffId });
  assert.deepEqual([moved.startsAt, moved.staffId, moved.status, moved.payment.method], [other.startsAt, other.staffId, 'booked', 'cash']);
  const last = outbox(d).at(-1)!;
  assert.equal(last.kind, 'appointment_moved');
  assert.match(last.subject!, /^Moved: Private Session, /);
});
