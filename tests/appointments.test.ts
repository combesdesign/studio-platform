// Appointments feature: slot rules (pure), pack credits, and the demo store (booking, paying, cancelling, events, permissions, studio isolation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, memoryStorage } from '../src/data/demo';
import { studioToUTC, studioDate, addDays, weekday } from '../src/shared/format';
import type { AuthUser, ID } from '../src/shared/types';
import type { DataStore } from '../src/shared/store';
import { allocateCredits, availabilityProblem, computeSlots, creditStatus, creditsLastUntil, isLateCancel, moveProblem, planWaitlist, DEFAULT_SETTINGS, type WaitlistLine } from '../src/features/appointments/logic';
import type { AppointmentCredit } from '../src/features/appointments/types';
import { asClient, at, rejects } from './helpers';

const iso = (d: string, t: string) => studioToUTC(d, t);
const NOW = at('2026-10-14', '16:00'); // Wednesday 4pm Sydney

// ---------------------------------------------------------------- pure rules
const type = { id: 't1', durationMin: 55, bufferMin: 15, staffIds: ['libby'] };
const base = { type, rules: [{ staffId: 'libby', weekday: 1, start: '09:00', end: '12:00' }], timeOff: [], appointments: [], sessions: [], settings: DEFAULT_SETTINGS, now: NOW, from: '2026-10-19', to: '2026-10-19' };

test('slots: fit inside the window on the grid, and the whole session must fit', () => {
  const starts = computeSlots(base).map((s) => s.startsAt);
  // 09:00 … 11:00 (11:00 + 55 min ends 11:55, inside 12:00); 11:30 would run past the window
  assert.deepEqual(starts, ['09:00', '09:30', '10:00', '10:30', '11:00'].map((t) => iso('2026-10-19', t)));
});

test('slots: classes the instructor teaches, other appointments (with buffer), and time off all block', () => {
  const cls = { instructorId: 'libby', startsAt: iso('2026-10-19', '09:00'), endsAt: iso('2026-10-19', '09:55'), status: 'scheduled' as const };
  const other = { instructorId: 'julia', startsAt: iso('2026-10-19', '10:00'), endsAt: iso('2026-10-19', '10:55'), status: 'scheduled' as const };
  const appt = { staffId: 'libby', startsAt: iso('2026-10-19', '10:30'), endsAt: iso('2026-10-19', '11:25'), bufferMin: 15, status: 'booked' as const };
  const gone = { ...appt, startsAt: iso('2026-10-19', '09:00'), endsAt: iso('2026-10-19', '09:55'), status: 'cancelled' as const };
  const starts = (over: object) => computeSlots({ ...base, ...over }).map((s) => s.startsAt);
  // class 9:00-9:55 blocks 9:00 and 9:30 (9:30 + 55 overlaps it); 10:00 is clear but its 15 min buffer + session runs to 11:10 and hits the 10:30 appointment
  assert.deepEqual(starts({ sessions: [cls, other], appointments: [appt] }), []);
  // without the appointment: 10:00 onwards is free (the class ends 9:55; 9:30 still overlaps it)
  assert.deepEqual(starts({ sessions: [cls, other] }), ['10:00', '10:30', '11:00'].map((t) => iso('2026-10-19', t)));
  // a cancelled appointment frees its time
  assert.ok(starts({ appointments: [gone] }).includes(iso('2026-10-19', '09:00')));
  // an appointment ending 11:25 + 15 buffer = 11:40 blocks a start before then; a slot starting after is fine
  const early = { ...appt, startsAt: iso('2026-10-19', '09:00'), endsAt: iso('2026-10-19', '09:55') };
  assert.deepEqual(starts({ appointments: [early] }), ['10:30', '11:00'].map((t) => iso('2026-10-19', t)));
  // time off 10:00-11:00 blocks 9:30 (ends 10:25), 10:00, 10:30; 9:00 (ends 9:55) and 11:00 are free
  const off = [{ staffId: 'libby', startsAt: iso('2026-10-19', '10:00'), endsAt: iso('2026-10-19', '11:00') }];
  assert.deepEqual(starts({ timeOff: off }), ['09:00', '11:00'].map((t) => iso('2026-10-19', t)));
});

test('slots: notice period and horizon apply to clients, not to staff', () => {
  const soon = { ...base, now: at('2026-10-19', '07:30'), from: '2026-10-19', to: '2026-10-19' };
  assert.equal(computeSlots(soon).length, 0, 'with 4 hours notice, 07:30 -> nothing before 11:30, and 11:30 does not fit');
  assert.equal(computeSlots({ ...soon, asStaff: true }).length, 5, 'staff can book inside the notice period');
  const far = { ...base, from: '2026-12-14', to: '2026-12-14' };
  assert.equal(computeSlots(far).length, 0, 'beyond the horizon');
  assert.equal(computeSlots({ ...far, asStaff: true }).length, 5);
  assert.equal(computeSlots({ ...base, now: at('2026-10-19', '10:15'), asStaff: true }).length, 2, 'never in the past');
});

test('slots: DST changeover keeps wall-clock times (Sydney clocks go forward on 4 Oct 2026)', () => {
  const sun = computeSlots({ ...base, rules: [{ staffId: 'libby', weekday: 0, start: '09:00', end: '10:00' }], from: '2026-10-04', to: '2026-10-04', now: at('2026-09-30', '08:00') });
  assert.equal(sun.length, 1);
  assert.equal(sun[0]!.startsAt, iso('2026-10-04', '09:00'));
});

test('availability input: valid times, end after start, no overlaps', () => {
  assert.equal(availabilityProblem([{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '13:00', end: '15:00' }]), null);
  assert.match(availabilityProblem([{ weekday: 1, start: '12:00', end: '09:00' }])!, /finish after/);
  assert.match(availabilityProblem([{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }])!, /overlap/);
  assert.match(availabilityProblem([{ weekday: 9, start: '09:00', end: '12:00' }])!, /day/);
});

const cr = (id: string, over: Partial<AppointmentCredit> = {}): AppointmentCredit => ({
  id, clientId: 'c', packId: 'p', name: 'Pack', credits: 3, used: 0, remaining: 3, validityDays: 90, typeIds: [], purchasedAt: '2026-09-01T00:00:00.000Z', status: 'active', ...over,
});
test('credits: soonest expiry first, spill over to the next, respect type and expiry', () => {
  const a = cr('a', { used: 2, remaining: 1, expiresAt: '2026-11-30T00:00:00.000Z' });
  const b = cr('b', { expiresAt: '2026-11-01T00:00:00.000Z' });
  const c = cr('c', { typeIds: ['other'] });
  const d = cr('d', { expiresAt: '2026-10-01T00:00:00.000Z' }); // expired
  assert.deepEqual(allocateCredits([a, b, c, d], 't1', 1, NOW), [{ creditId: 'b', n: 1 }]);
  assert.deepEqual(allocateCredits([a, b, c, d], 't1', 2, NOW), [{ creditId: 'b', n: 2 }]);
  assert.deepEqual(allocateCredits([a], 't1', 2, NOW), null, 'not enough');
  assert.deepEqual(allocateCredits([a, cr('e')], 't1', 2, NOW), [{ creditId: 'a', n: 1 }, { creditId: 'e', n: 1 }], 'spills into the next pack (unstarted counts as expiring last)');
  assert.equal(allocateCredits([a, b], 't1', 1, NOW, 'a')![0]!.creditId, 'a', 'a chosen credit');
  assert.equal(creditStatus(d, NOW), 'expired');
  assert.equal(creditStatus(cr('z', { used: 3 }), NOW), 'used_up');
});

test('cancel window: exactly on the line is still in time', () => {
  const start = iso('2026-10-20', '10:00');
  assert.equal(isLateCancel(start, at('2026-10-20', '07:00'), 3), false);
  assert.equal(isLateCancel(start, at('2026-10-20', '07:01'), 3), true);
});

// ---------------------------------------------------------------- the demo store
function demo(slug = 'snowy') {
  let t = NOW;
  const store = createDemoStore({ now: () => t, latencyMs: 0, storage: memoryStorage(), app: 'studio', studio: slug });
  const as = (u: AuthUser) => store.demoSignInAs!(u);
  return { store, as, setNow: (d: Date) => { t = d; } };
}
const owner = (slug: string): AuthUser => slug === 'harbour'
  ? { kind: 'staff', staffId: 'hb_st_ava', email: '', name: 'Ava', role: 'owner' }
  : { kind: 'staff', staffId: 'st_libby', email: '', name: 'Libby', role: 'owner' };
async function clientId(store: DataStore, first: string): Promise<ID> {
  await store.demoSignInAs!(owner(store.studioId.includes('harbour') ? 'harbour' : 'snowy'));
  return (await store.listClients()).find((c) => c.firstName === first)!.id;
}

test('seed: Snowy and Harbour each get their own privates, packs, availability and events', async () => {
  const s = demo('snowy'), h = demo('harbour');
  await s.as(owner('snowy')); await h.as(owner('harbour'));
  const sa = s.store.features.appointments!, ha = h.store.features.appointments!;
  assert.deepEqual((await sa.listTypes()).map((t) => t.name), ['Private Intro', 'Private Session', 'Duet Session']);
  assert.deepEqual((await ha.listTypes()).map((t) => t.name), ['Reformer Private', 'Reformer Duet', 'Rehab Private']);
  const staffS = new Map((await s.store.listStaff()).map((x) => [x.id, x.name]));
  assert.ok((await sa.listTypes()).find((t) => t.name === 'Duet Session')!.staffIds.every((id) => staffS.get(id) === 'Libby'), 'duets are with Libby');
  const ev = await sa.listEvents();
  assert.deepEqual(ev.map((e) => e.title), ['Sunday Reset: Mobility + Breath', 'Mat Pilates Foundations']);
  const course = ev.find((e) => e.kind === 'course')!;
  assert.equal(course.sessions.length, 3);
  assert.deepEqual(course.sessions.map((x) => weekday(studioDate(new Date(x.startsAt)))), [6, 6, 6], 'three Saturdays');
  assert.equal(ev.find((e) => e.kind === 'workshop')!.spotsLeft, 1, 'the Sunday workshop is nearly full');
  assert.equal(weekday(studioDate(new Date(ev.find((e) => e.kind === 'workshop')!.sessions[0]!.startsAt))), 0, 'on a Sunday');
  const hev = await ha.listEvents();
  assert.ok(hev.some((e) => e.kind === 'workshop') && hev.some((e) => e.priceCents === 0));
  assert.equal((await ha.listPacks()).length, 2);
  assert.equal((await s.store.getSettings()).name, 'Snowy Pilates Club');
  // the other studio's data stays put
  assert.ok(!(await sa.listTypes()).some((t) => t.name.includes('Reformer')));
});

test('slots avoid classes the instructor teaches and appointments already booked', async () => {
  const { store, as } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const types = await a.listTypes();
  const priv = types.find((t) => t.name === 'Private Session')!;
  const libby = 'st_libby';
  // Tuesday 20 Oct: Libby teaches Mat Essentials 09:30-10:25 and 18:00; her private hours are 09:00-15:00
  const slots = await a.listSlots({ typeId: priv.id, from: '2026-10-20', to: '2026-10-20', staffId: libby });
  const t = (x: string) => iso('2026-10-20', x);
  assert.ok(slots.length > 0);
  assert.ok(!slots.some((s) => s.startsAt === t('09:00') || s.startsAt === t('09:30') || s.startsAt === t('10:00')), 'overlaps the 9:30 class');
  assert.ok(slots.some((s) => s.startsAt === t('10:30')), 'free after the class');
  // staff booking on behalf of Chloe: she then no longer sees that start time
  const chloe = await clientId(store, 'Chloe');
  const slot = slots.find((s) => s.startsAt === t('10:30'))!;
  const r = await a.bookAppointment({ typeId: priv.id, staffId: libby, startsAt: slot.startsAt, clientId: chloe, pay: { method: 'cash' } });
  assert.equal(r.sale?.totalCents, 12000);
  assert.equal(r.appointment.status, 'booked');
  const after = await a.listSlots({ typeId: priv.id, from: '2026-10-20', to: '2026-10-20', staffId: libby });
  assert.ok(!after.some((s) => s.startsAt === t('10:30') || s.startsAt === t('11:00')), 'the booking and its buffer are blocked');
  await rejects(a.bookAppointment({ typeId: priv.id, staffId: libby, startsAt: slot.startsAt, clientId: chloe, pay: { method: 'cash' } }), 'SLOT_TAKEN');
  // booked sessions show on the sale list and in revenue
  const sales = await store.listSales({ from: '2026-10-14', to: '2026-10-14', clientId: chloe });
  assert.equal(sales.length, 1);
  assert.equal(sales[0]!.items[0]!.name, 'Private Session');
});

test('clients: waiver first, cards or credits only, duets are per person', async () => {
  const { store, as } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const duet = (await a.listTypes()).find((t) => t.capacity === 2)!;
  const day = addDays(studioDate(NOW), 7);
  const slot = (await a.listSlots({ typeId: duet.id, from: day, to: addDays(day, 14) }))[0]!;
  const chloe = await clientId(store, 'Chloe'); // no waiver yet
  await as(asClient(chloe));
  await rejects(a.bookAppointment({ typeId: duet.id, staffId: slot.staffId, startsAt: slot.startsAt, pay: { method: 'card_online' } }), 'WAIVER_REQUIRED');
  const hannah = await clientId(store, 'Hannah');
  await as(asClient(hannah));
  await rejects(a.bookAppointment({ typeId: duet.id, staffId: slot.staffId, startsAt: slot.startsAt, pay: { method: 'cash' } }), 'NOT_ALLOWED');
  await rejects(a.bookAppointment({ typeId: duet.id, staffId: slot.staffId, startsAt: slot.startsAt, people: 3, pay: { method: 'card_online' } }), 'INVALID');
  await rejects(a.bookAppointment({ typeId: duet.id, staffId: slot.staffId, startsAt: slot.startsAt, pay: { method: 'pack' } }), 'NO_CREDITS');
  const r = await a.bookAppointment({ typeId: duet.id, staffId: slot.staffId, startsAt: slot.startsAt, people: 2, pay: { method: 'card_online' }, note: 'Bringing my mum' });
  assert.equal(r.sale!.totalCents, 15000, '2 × $75');
  assert.equal(r.appointment.people, 2);
  const mine = await a.listAppointments();
  assert.ok(mine.every((x) => x.clientId === hannah), 'clients only see their own');
  await rejects(a.bookAppointment({ typeId: duet.id, staffId: slot.staffId, startsAt: slot.startsAt, clientId: await clientId(store, 'Jess'), pay: { method: 'card_online' } }), 'NOT_ALLOWED');
});

test('pack credits: used for a booking, returned on an in-time cancel, kept on a late cancel', async () => {
  const { store, as, setNow } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const jess = await clientId(store, 'Jess');
  await as(asClient(jess));
  const before = (await a.listCredits())[0]!;
  assert.equal(before.remaining, 1, 'Jess has one of three left');
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const day = addDays(studioDate(NOW), 10);
  const slots = await a.listSlots({ typeId: priv.id, from: day, to: addDays(day, 10) });
  const r = await a.bookAppointment({ typeId: priv.id, staffId: slots[0]!.staffId, startsAt: slots[0]!.startsAt, pay: { method: 'pack' } });
  assert.equal(r.sale, undefined, 'no money changes hands for a credit');
  assert.equal((await a.listCredits(undefined, { includeInactive: true }))[0]!.remaining, 0);
  assert.equal((await a.listCredits(undefined, { includeInactive: true }))[0]!.status, 'used_up');
  const later = slots.find((x) => Date.parse(x.startsAt) >= Date.parse(slots[0]!.startsAt) + 3 * 3600_000)!;
  await rejects(a.bookAppointment({ typeId: priv.id, staffId: later.staffId, startsAt: later.startsAt, pay: { method: 'pack' } }), 'NO_CREDITS');
  const c = await a.cancelAppointment(r.appointment.id);
  assert.equal(c.late, false);
  assert.equal(c.creditsReturned, 1);
  assert.equal((await a.listCredits())[0]!.remaining, 1);
  assert.equal((await a.listAppointments({ includeCancelled: true })).find((x) => x.id === r.appointment.id)!.status, 'cancelled');
  // inside the studio's 3 hour window the credit is lost
  const again = await a.bookAppointment({ typeId: priv.id, staffId: slots[0]!.staffId, startsAt: slots[0]!.startsAt, pay: { method: 'pack' } });
  setNow(new Date(Date.parse(again.appointment.startsAt) - 2 * 3600_000));
  const late = await a.cancelAppointment(again.appointment.id);
  assert.equal(late.late, true);
  assert.equal(late.creditsReturned, 0);
  assert.equal(late.appointment.status, 'late_cancelled');
  assert.equal((await a.listCredits(undefined, { includeInactive: true }))[0]!.remaining, 0, 'credit kept by the studio');
  // ...and a late-cancelled slot is free again
  setNow(NOW);
  await as(owner('snowy'));
  assert.ok((await a.listSlots({ typeId: priv.id, from: day, to: addDays(day, 10) })).some((s) => s.startsAt === slots[0]!.startsAt && s.staffId === slots[0]!.staffId));
});

test('cancelling: the studio cancel window decides, card payments become "refund due", staff can waive', async () => {
  const { store, as, setNow } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const hannah = await clientId(store, 'Hannah');
  // staff books Hannah for tomorrow 10:00 with Libby (Thursday: her hours 09:00-15:00) - 18 hours away, inside no window
  const tomorrow = addDays(studioDate(NOW), 1);
  const slot = (await a.listSlots({ typeId: priv.id, from: tomorrow, to: tomorrow, staffId: 'st_libby' })).find((s) => s.startsAt === iso(tomorrow, '10:00'))!;
  assert.ok(slot);
  const b = await a.bookAppointment({ typeId: priv.id, staffId: 'st_libby', startsAt: slot.startsAt, clientId: hannah, pay: { method: 'card_reader' } });
  const ok = await a.cancelAppointment(b.appointment.id);
  assert.equal(ok.late, false);
  assert.equal(ok.refundDue, true);
  assert.equal(ok.appointment.refundDue, true);
  await a.markRefunded({ appointmentId: b.appointment.id });
  assert.equal((await a.listAppointments({ includeCancelled: true })).find((x) => x.id === b.appointment.id)!.refundDue, undefined);
  await rejects(a.cancelAppointment(b.appointment.id), 'INVALID');
  // 2 hours before the session = inside the window (3 hours): late cancel, no refund; staff waive = full refund
  const sess = (await a.listSlots({ typeId: priv.id, from: tomorrow, to: tomorrow, staffId: 'st_libby' }))[0]!;
  const c = await a.bookAppointment({ typeId: priv.id, staffId: 'st_libby', startsAt: sess.startsAt, clientId: hannah, pay: { method: 'cash' } });
  setNow(new Date(Date.parse(sess.startsAt) - 2 * 3600_000));
  const waived = await a.cancelAppointment(c.appointment.id, { waivePenalty: true });
  assert.equal(waived.late, false);
  assert.equal(waived.refundDue, true);
  const d = await a.bookAppointment({ typeId: priv.id, staffId: 'st_libby', startsAt: sess.startsAt, clientId: hannah, pay: { method: 'cash' } });
  const lateOne = await a.cancelAppointment(d.appointment.id);
  assert.equal(lateOne.late, true);
  assert.equal(lateOne.refundDue, false, 'money is kept on a late cancel');
  assert.equal(lateOne.appointment.status, 'late_cancelled');
});

test('permissions: instructors see only their sessions; only the front desk and above book or cancel for others; managers edit the catalogue', async () => {
  const { store, as } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const all = await a.listAppointments({ includeCancelled: true });
  assert.ok(all.some((x) => x.staffId === 'st_libby') && all.some((x) => x.staffId === 'st_julia'));
  await as({ kind: 'staff', staffId: 'st_julia', email: '', name: 'Julia', role: 'instructor' });
  const mine = await a.listAppointments({ includeCancelled: true });
  assert.ok(mine.length > 0 && mine.every((x) => x.staffId === 'st_julia'), 'Julia only sees Julia’s');
  await rejects(a.upsertType({ name: 'X', description: '', durationMin: 30, priceCents: 100, capacity: 1, bufferMin: 0, staffIds: [], active: true }), 'NOT_ALLOWED');
  await rejects(a.bookAppointment({ typeId: 'apty_private', staffId: 'st_julia', startsAt: new Date().toISOString(), clientId: 'x', pay: { method: 'cash' } }), 'NOT_ALLOWED');
  // her own hours are hers to change; Libby's are not
  await a.setAvailability('st_julia', [{ weekday: 3, start: '10:00', end: '12:00' }]);
  assert.equal((await a.listAvailability('st_julia')).length, 1);
  await rejects(a.setAvailability('st_libby', []), 'NOT_ALLOWED');
  const myTimeOff = await a.addTimeOff({ staffId: 'st_julia', startsAt: iso('2026-10-28', '09:00'), endsAt: iso('2026-10-28', '13:00'), note: 'Dentist' });
  await a.removeTimeOff(myTimeOff.id);
  await rejects(a.addTimeOff({ staffId: 'st_libby', startsAt: iso('2026-10-28', '09:00'), endsAt: iso('2026-10-28', '13:00') }), 'NOT_ALLOWED');
  // her new hours show up as slots, and the old ones are gone
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const s = await a.listSlots({ typeId: priv.id, from: '2026-10-21', to: '2026-10-23', staffId: 'st_julia' });
  assert.deepEqual(s.map((x) => x.startsAt), ['10:00', '10:30', '11:00', '11:30'].map((t) => iso('2026-10-21', t)).filter((x) => x <= iso('2026-10-21', '11:00')));
  // an owner changes the catalogue; unknown staff are dropped; clients only see active types
  await as(owner('snowy'));
  const t = await a.upsertType({ name: 'Reformer Trial', description: '', durationMin: 40, priceCents: 5000, capacity: 1, bufferMin: 5, staffIds: ['st_julia', 'nobody'], active: false });
  assert.deepEqual(t.staffIds, ['st_julia']);
  await as(asClient(await clientId(store, 'Hannah')));
  assert.ok(!(await a.listTypes()).some((x) => x.id === t.id));
  await rejects(a.listSlots({ typeId: t.id, from: '2026-10-21', to: '2026-10-22' }), 'NOT_FOUND');
});

test('workshops and courses: register, pay, capacity, cancel with the refund cut-off, attendee lists', async () => {
  const { store, as } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const workshop = (await a.listEvents()).find((e) => e.kind === 'workshop')!;
  const course = (await a.listEvents()).find((e) => e.kind === 'course')!;
  const chloe = await clientId(store, 'Chloe');
  const jess = await clientId(store, 'Jess');
  // a client with no waiver can't sign up; with a waiver she can, once
  await as(asClient(chloe));
  await rejects(a.register({ eventId: workshop.id, method: 'card_online' }), 'WAIVER_REQUIRED');
  await as(asClient(jess));
  assert.equal((await a.listEvents()).find((e) => e.id === workshop.id)!.mine, undefined);
  const r = await a.register({ eventId: workshop.id, method: 'card_online' });
  assert.equal(r.sale!.totalCents, 5500);
  assert.equal(r.registration.status, 'registered');
  assert.equal((await a.getEvent(workshop.id)).spotsLeft, 0, 'that was the last spot');
  assert.equal((await a.getEvent(workshop.id)).mine!.id, r.registration.id);
  await rejects(a.register({ eventId: workshop.id, method: 'card_online' }), 'ALREADY_BOOKED');
  const hannah = await clientId(store, 'Hannah');
  await as(asClient(hannah));
  await rejects(a.register({ eventId: workshop.id, method: 'card_online' }), 'EVENT_FULL');
  await rejects(a.listRegistrations({ eventId: workshop.id }), 'NOT_ALLOWED');
  // the course is bought once for all three dates
  await as(asClient(jess));
  const c = await a.register({ eventId: course.id, method: 'card_online' });
  assert.equal(c.sale!.totalCents, 13500);
  assert.equal(c.sale!.items.length, 1, 'one purchase for all sessions');
  assert.equal(c.registration.startsAt, course.sessions[0]!.startsAt);
  // cancelling more than 48 hours before the first session: refund due; the workshop is within 4 days so also fine
  const cc = await a.cancelRegistration(c.registration.id);
  assert.equal(cc.late, false);
  assert.equal(cc.refundDue, true);
  assert.equal((await a.getEvent(course.id)).mine, undefined);
  // the front desk sees the list and takes attendance
  await as(owner('snowy'));
  const list = await a.listRegistrations({ eventId: workshop.id });
  assert.equal(list.length, 12);
  const mine = list.find((x) => x.clientId === jess)!;
  const present = await a.setAttendance(mine.id, workshop.sessions[0]!.startsAt, true);
  assert.deepEqual(present.attended, [workshop.sessions[0]!.startsAt]);
  await rejects(a.setAttendance(mine.id, '2020-01-01T00:00:00.000Z', true), 'INVALID');
  // cancelling the whole event refunds everyone who paid
  const gone = await a.cancelEvent(workshop.id, 'Instructor unwell');
  assert.equal(gone.cancelled, true);
  const after = await a.listRegistrations({ eventId: workshop.id });
  assert.ok(after.every((x) => x.status === 'cancelled'));
  assert.ok(after.every((x) => x.refundDue === (x.payment.amountCents > 0)));
  assert.equal((await a.listEvents()).find((e) => e.id === workshop.id)!.cancelled, true, 'staff still see it, marked cancelled');
  await as(asClient(hannah));
  assert.ok(!(await a.listEvents()).some((e) => e.id === workshop.id), 'clients no longer see it');
});

// ---------------------------------------------------------------- moving an appointment
test('move rules: clients until the cancel window, staff any time, only booked sessions, credits must outlast the new time', () => {
  const a = { startsAt: iso('2026-10-20', '10:00'), status: 'booked' as const };
  assert.equal(moveProblem(a, at('2026-10-20', '07:00'), 3, false), null, 'exactly on the line is still in time');
  assert.equal(moveProblem(a, at('2026-10-20', '07:01'), 3, false)?.code, 'TOO_LATE', 'inside the window');
  assert.equal(moveProblem(a, at('2026-10-20', '07:01'), 3, true), null, 'the front desk can still move it');
  assert.equal(moveProblem(a, at('2026-10-20', '10:30'), 3, false)?.code, 'TOO_LATE', 'already started');
  assert.equal(moveProblem({ ...a, status: 'cancelled' }, at('2026-10-14', '09:00'), 3, true)?.code, 'INVALID');
  const uses = [{ creditId: 'a', n: 1 }];
  assert.equal(creditsLastUntil(uses, [{ id: 'a', expiresAt: '2026-11-01T00:00:00.000Z' }], '2026-10-31T00:00:00.000Z'), true);
  assert.equal(creditsLastUntil(uses, [{ id: 'a', expiresAt: '2026-11-01T00:00:00.000Z' }], '2026-11-02T00:00:00.000Z'), false, 'the pack would have run out');
  assert.equal(creditsLastUntil(uses, [{ id: 'a' }], '2030-01-01T00:00:00.000Z'), true, 'no expiry');
});

test('moving: one step to another free time, same payment or credit, own time never blocks, family and staff rules', async () => {
  const { store, as, setNow } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const priv = (await a.listTypes()).find((t) => t.name === 'Private Session')!;
  const [jess, alice, hannah] = [await clientId(store, 'Jess'), await clientId(store, 'Alice'), await clientId(store, 'Hannah')];
  const day = addDays(studioDate(NOW), 10);
  const all = await a.listSlots({ typeId: priv.id, from: day, to: addDays(day, 10) });
  const first = all[0]!;

  // Jess pays with her last credit
  await as(asClient(jess));
  const r = await a.bookAppointment({ typeId: priv.id, staffId: first.staffId, startsAt: first.startsAt, pay: { method: 'pack' } });
  const id = r.appointment.id;
  const credit = (await a.listCredits(undefined, { includeInactive: true }))[0]!;
  assert.equal(credit.remaining, 0);
  // 30 minutes later overlaps her own session: not offered normally, but fine for a move
  const near = new Date(Date.parse(first.startsAt) + 30 * 60_000).toISOString();
  const plain = await a.listSlots({ typeId: priv.id, from: day, to: day, staffId: first.staffId });
  const forMove = await a.listSlots({ typeId: priv.id, from: day, to: day, staffId: first.staffId, excludeAppointmentId: id });
  assert.ok(!plain.some((x) => x.startsAt === near) && forMove.some((x) => x.startsAt === near), 'its own time doesn’t block the move');
  assert.ok(forMove.some((x) => x.startsAt === first.startsAt && x.staffId === first.staffId), 'and its current time is open again');
  const countBefore = (await a.listAppointments({ includeCancelled: true })).length;
  const moved = await a.moveAppointment(id, { startsAt: near });
  assert.equal(moved.id, id, 'the same appointment');
  assert.deepEqual([moved.startsAt, moved.staffId, moved.status], [near, first.staffId, 'booked']);
  assert.equal(moved.endsAt, new Date(Date.parse(near) + 55 * 60_000).toISOString(), 'the session length stays');
  assert.deepEqual(moved.payment, r.appointment.payment, 'still paid with the same credit');
  assert.equal((await a.listCredits(undefined, { includeInactive: true }))[0]!.remaining, 0, 'the credit isn’t returned and taken again');
  assert.equal((await a.listAppointments({ includeCancelled: true })).length, countBefore, 'not a cancel and a rebook');
  assert.equal((await store.listSales({ from: '2026-10-14', to: '2026-10-14', clientId: jess })).length, 0, 'no money moved');
  await rejects(a.moveAppointment(id, { startsAt: near }), 'INVALID');
  await rejects(a.moveAppointment(id, { startsAt: new Date(NOW.getTime() + 3600_000).toISOString() }), 'SLOT_TAKEN');

  // a card payment stays one sale, whoever it moves to
  await as(asClient(alice));
  const other = all.find((x) => Date.parse(x.startsAt) >= Date.parse(near) + 3 * 3600_000)!;
  const paid = await a.bookAppointment({ typeId: priv.id, staffId: other.staffId, startsAt: other.startsAt, pay: { method: 'card_online' } });
  const julia = (await a.listSlots({ typeId: priv.id, from: day, to: addDays(day, 10), staffId: 'st_julia' }))[0];
  assert.ok(julia, 'Julia offers privates too');
  const swapped = await a.moveAppointment(paid.appointment.id, { startsAt: julia!.startsAt, staffId: 'st_julia' });
  assert.deepEqual([swapped.staffId, swapped.staffName, swapped.payment.saleId], ['st_julia', 'Julia', paid.sale!.id]);
  assert.equal((await store.listSales({ from: '2026-10-14', to: '2026-10-14', clientId: alice })).length, 1, 'one sale before and after');
  // somebody else's slot and somebody else's session
  await rejects(a.moveAppointment(paid.appointment.id, { startsAt: near, staffId: first.staffId }), 'SLOT_TAKEN');
  await as(asClient(hannah));
  await rejects(a.moveAppointment(paid.appointment.id, { startsAt: other.startsAt }), 'NOT_FOUND');

  // inside the studio's 3 hour window: clients can't, the front desk can
  await as(asClient(alice));
  setNow(new Date(Date.parse(swapped.startsAt) - 2 * 3600_000));
  const last = all[all.length - 1]!;
  await rejects(a.moveAppointment(paid.appointment.id, { startsAt: last.startsAt, staffId: last.staffId }), 'TOO_LATE');
  await as(owner('snowy'));
  const rescued = await a.moveAppointment(paid.appointment.id, { startsAt: last.startsAt, staffId: last.staffId });
  assert.equal(rescued.startsAt, last.startsAt);
  // cancelled sessions can't be moved
  await as(asClient(alice));
  setNow(NOW);
  await a.cancelAppointment(paid.appointment.id);
  await rejects(a.moveAppointment(paid.appointment.id, { startsAt: julia!.startsAt, staffId: 'st_julia' }), 'INVALID');
});

// ---------------------------------------------------------------- waitlist
const START = '2026-10-17T22:30:00.000Z'; // the Sunday workshop: Sunday 18 Oct, 9:30am Sydney
const wl = (id: string, status: WaitlistLine['status'], joinedAt: string, offerExpiresAt?: string): WaitlistLine => ({ id, status, joinedAt, ...(offerExpiresAt ? { offerExpiresAt } : {}) });
const plan = (line: WaitlistLine[], over: Partial<Parameters<typeof planWaitlist>[0]> = {}) =>
  planWaitlist({ line, capacity: 12, taken: 11, now: NOW, claimHours: 12, eventStart: START, open: true, ...over });

test('waitlist plan: a free place goes to whoever joined first, and is held for the claim window', () => {
  const line = [wl('b', 'waiting', '2026-10-14T01:00:00.000Z'), wl('a', 'waiting', '2026-10-14T00:00:00.000Z')];
  assert.deepEqual(plan(line, { taken: 12 }), { expire: [], offer: [] }, 'full: nothing to offer');
  assert.deepEqual(plan(line), { expire: [], offer: [{ id: 'a', expiresAt: new Date(NOW.getTime() + 12 * 3_600_000).toISOString() }] }, 'one place: the first in line');
  assert.deepEqual(plan(line, { taken: 10 }).offer.map((o) => o.id), ['a', 'b'], 'two places: two offers, in order');
  assert.equal(plan(line, { taken: 10, claimHours: 2 }).offer[0]!.expiresAt, new Date(NOW.getTime() + 2 * 3_600_000).toISOString(), 'the studio sets the window');
});

test('waitlist plan: a held place isn\'t offered twice, a lapsed offer passes on, and nothing outlives the event', () => {
  const later = new Date(NOW.getTime() + 3_600_000).toISOString();
  const held = [wl('a', 'offered', '2026-10-14T00:00:00.000Z', later), wl('b', 'waiting', '2026-10-14T01:00:00.000Z')];
  assert.deepEqual(plan(held), { expire: [], offer: [] }, 'a live offer holds the only place');
  const lapsed = [wl('a', 'offered', '2026-10-14T00:00:00.000Z', NOW.toISOString()), wl('b', 'waiting', '2026-10-14T01:00:00.000Z')];
  const p = plan(lapsed);
  assert.deepEqual(p.expire, ['a'], 'exactly at the deadline it has lapsed');
  assert.deepEqual(p.offer.map((o) => o.id), ['b'], 'and the next person gets it');
  const soon = plan([wl('a', 'waiting', '2026-10-14T00:00:00.000Z')], { eventStart: new Date(NOW.getTime() + 5 * 3_600_000).toISOString() });
  assert.equal(soon.offer[0]!.expiresAt, new Date(NOW.getTime() + 5 * 3_600_000).toISOString(), 'never past the start');
  const closed = plan(held, { open: false });
  assert.deepEqual(closed, { expire: ['a', 'b'], offer: [] }, 'cancelled or started: everyone is let go');
});

test('waitlist: join when full, get offered a cancelled place, claim it by signing up; the rest keep their turn', async () => {
  const { store, as, setNow } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const ws = (await a.listEvents()).find((e) => e.kind === 'workshop')!;
  const [jess, hannah, alice, chloe, poppy] = [await clientId(store, 'Jess'), await clientId(store, 'Hannah'), await clientId(store, 'Alice'), await clientId(store, 'Chloe'), await clientId(store, 'Poppy')];
  // a place is left, so there's nothing to wait for
  await as(asClient(hannah));
  await rejects(a.joinWaitlist({ eventId: ws.id }), 'NOT_FULL');
  await as(asClient(jess));
  const jr = await a.register({ eventId: ws.id, method: 'card_online' });
  // now it's full: Hannah and Alice queue up (Chloe has no waiver yet)
  await as(asClient(chloe));
  await rejects(a.joinWaitlist({ eventId: ws.id }), 'WAIVER_REQUIRED');
  await as(asClient(hannah));
  const h = await a.joinWaitlist({ eventId: ws.id });
  assert.deepEqual([h.status, h.position], ['waiting', 1]);
  await rejects(a.joinWaitlist({ eventId: ws.id }), 'ALREADY_BOOKED');
  setNow(new Date(NOW.getTime() + 60_000));
  await as(asClient(alice));
  assert.equal((await a.joinWaitlist({ eventId: ws.id })).position, 2);
  const seen = await a.getEvent(ws.id);
  assert.deepEqual([seen.spotsLeft, seen.waitlisted, seen.myWaitlist!.position], [0, 2, 2]);
  assert.equal((await a.listWaitlist({ clientId: alice })).length, 1, 'clients see their own place in line');
  await rejects(a.listWaitlist({ eventId: ws.id }), 'NOT_ALLOWED');

  // Jess cancels: Hannah (first in line) is offered the place for the studio's claim window (12h by default)
  await as(asClient(jess));
  await a.cancelRegistration(jr.registration.id);
  await as(asClient(hannah));
  const offered = (await a.getEvent(ws.id)).myWaitlist!;
  assert.equal(offered.status, 'offered');
  assert.equal(offered.offerExpiresAt, new Date(NOW.getTime() + 60_000 + 12 * 3_600_000).toISOString());
  assert.equal((await a.getEvent(ws.id)).spotsLeft, 0, 'the place is held, not free');
  // nobody else can take it, not even the next in line or a newcomer
  await as(asClient(alice));
  await rejects(a.register({ eventId: ws.id, method: 'card_online' }), 'EVENT_FULL');
  assert.equal((await a.getEvent(ws.id)).myWaitlist!.status, 'waiting', 'Alice is still waiting');
  await as(asClient(poppy));
  await rejects(a.register({ eventId: ws.id, method: 'card_online' }), 'EVENT_FULL');
  // Hannah claims by paying; her turn is done and Alice moves up
  await as(asClient(hannah));
  const claimed = await a.register({ eventId: ws.id, method: 'card_online' });
  assert.equal(claimed.sale!.totalCents, 5500);
  const after = await a.getEvent(ws.id);
  assert.deepEqual([after.myWaitlist, after.mine?.id, after.waitlisted], [undefined, claimed.registration.id, 1]);
  await as(owner('snowy'));
  const line = await a.listWaitlist({ eventId: ws.id });
  assert.deepEqual(line.map((x) => [x.clientName.split(' ')[0], x.position, x.status]), [['Alice', 1, 'waiting']]);
});

test('waitlist: an offer nobody claims lapses and goes to the next; giving a place back does the same; the line ends when the event starts', async () => {
  const { store, as, setNow } = demo();
  await as(owner('snowy'));
  const a = store.features.appointments!;
  const ws = (await a.listEvents()).find((e) => e.kind === 'workshop')!;
  const [jess, hannah, alice, poppy] = [await clientId(store, 'Jess'), await clientId(store, 'Hannah'), await clientId(store, 'Alice'), await clientId(store, 'Poppy')];
  await as(asClient(jess));
  const jr = await a.register({ eventId: ws.id, method: 'card_online' });
  for (const [i, c] of [hannah, alice, poppy].entries()) {
    setNow(new Date(NOW.getTime() + (i + 1) * 60_000));
    await as(asClient(c));
    await a.joinWaitlist({ eventId: ws.id });
  }
  await as(asClient(jess));
  await a.cancelRegistration(jr.registration.id);
  const status = async (c: string) => { await as(asClient(c)); const w = (await a.getEvent(ws.id)).myWaitlist; return w ? w.status : 'gone'; };
  assert.deepEqual([await status(hannah), await status(alice), await status(poppy)], ['offered', 'waiting', 'waiting']);

  // Hannah sits on it for 13 hours: her offer lapses and Alice is offered the place instead
  setNow(new Date(NOW.getTime() + 13 * 3_600_000 + 5 * 60_000));
  assert.deepEqual([await status(hannah), await status(alice), await status(poppy)], ['gone', 'offered', 'waiting']);
  await as(asClient(hannah));
  await rejects(a.register({ eventId: ws.id, method: 'card_online' }), 'EVENT_FULL');
  // Alice hands it back: Poppy is next
  await as(asClient(alice));
  const mine = (await a.getEvent(ws.id)).myWaitlist!;
  await a.leaveWaitlist(mine.id);
  assert.deepEqual([await status(alice), await status(poppy)], ['gone', 'offered']);
  // only the owner's line is theirs to leave
  await as(asClient(hannah));
  await rejects(a.leaveWaitlist(mine.id), 'NOT_FOUND');
  // the front desk can take someone off, and it goes on; when nobody's left the place is simply free
  await as(owner('snowy'));
  const poppyEntry = (await a.listWaitlist({ eventId: ws.id }))[0]!;
  await a.leaveWaitlist(poppyEntry.id);
  assert.deepEqual([(await a.getEvent(ws.id)).spotsLeft, (await a.getEvent(ws.id)).waitlisted], [1, 0]);

  // an offer never outlives the event: with a long claim window it ends when the event starts
  await a.updateSettings({ waitlistClaimHours: 72 });
  await as(asClient(jess));
  setNow(new Date(NOW.getTime() + 2 * 86_400_000));   // Friday afternoon: the workshop is under a day away
  const again = await a.register({ eventId: ws.id, method: 'card_online' });
  await as(asClient(alice));
  await a.joinWaitlist({ eventId: ws.id });
  await as(asClient(jess));
  await a.cancelRegistration(again.registration.id);
  await as(asClient(alice));
  assert.equal((await a.getEvent(ws.id)).myWaitlist!.offerExpiresAt, START);
  // and when it starts, the line is cleared
  setNow(new Date(Date.parse(START) + 60_000));
  await as(owner('snowy'));
  assert.deepEqual(await a.listWaitlist({ eventId: ws.id }), []);
  await rejects(a.updateSettings({ waitlistClaimHours: 0 }), 'INVALID');
});

test('events: validation, free events and the single-date rule', async () => {
  const { store, as } = demo('harbour');
  await as(owner('harbour'));
  const a = store.features.appointments!;
  const social = (await a.listEvents()).find((e) => e.priceCents === 0)!;
  const base = { kind: 'workshop' as const, title: 'Mobility', description: 'x', priceCents: 4000, capacity: 6, published: true, refundCutoffHours: 24, sessions: [{ startsAt: iso('2026-11-01', '09:00'), endsAt: iso('2026-11-01', '10:00') }] };
  await rejects(a.upsertEvent({ ...base, title: ' ' }), 'INVALID');
  await rejects(a.upsertEvent({ ...base, capacity: 0 }), 'INVALID');
  await rejects(a.upsertEvent({ ...base, sessions: [] }), 'INVALID');
  await rejects(a.upsertEvent({ ...base, sessions: [{ startsAt: iso('2026-11-01', '10:00'), endsAt: iso('2026-11-01', '09:00') }] }), 'INVALID');
  await rejects(a.upsertEvent({ ...base, sessions: [...base.sessions, { startsAt: iso('2026-11-08', '09:00'), endsAt: iso('2026-11-08', '10:00') }] }), 'INVALID');
  const saved = await a.upsertEvent({ ...base, kind: 'course', sessions: [...base.sessions, { startsAt: iso('2026-11-08', '09:00'), endsAt: iso('2026-11-08', '10:00') }] });
  assert.equal(saved.sessions.length, 2);
  // capacity can't go below the people already registered
  await rejects(a.upsertEvent({ ...social, capacity: 3 }), 'INVALID');
  // a free event needs no payment
  const priya = await clientId(store, 'Priya');
  await as(asClient(priya));
  const r = await a.register({ eventId: social.id, method: 'card_online' });
  assert.equal(r.sale, undefined);
  assert.equal(r.registration.payment.amountCents, 0);
});

test('isolation: Snowy and Harbour keep separate appointments data', async () => {
  const storage = memoryStorage();
  const mk = (slug: string) => createDemoStore({ now: () => NOW, latencyMs: 0, storage, app: 'studio', studio: slug });
  const s = mk('snowy'), h = mk('harbour');
  await s.demoSignInAs!(owner('snowy'));
  await h.demoSignInAs!(owner('harbour'));
  const sa = s.features.appointments!, ha = h.features.appointments!;
  const t = await sa.upsertType({ name: 'Snowy only', description: '', durationMin: 30, priceCents: 1000, capacity: 1, bufferMin: 0, staffIds: [], active: true });
  assert.ok((await sa.listTypes()).some((x) => x.id === t.id));
  assert.ok(!(await ha.listTypes()).some((x) => x.id === t.id));
  await rejects(ha.listSlots({ typeId: t.id, from: '2026-10-20', to: '2026-10-21' }), 'NOT_FOUND');
});
