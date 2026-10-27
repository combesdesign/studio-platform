// Rooms for appointments and events (demo store): staff hold a room when booking; events carry a room; classes, appointments and
// event sessions all share one clash rule; a cancelled thing lets go of its room. Mirrors supabase/tests/appointments_rooms.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, memoryStorage } from '../src/data/demo';
import { addDays, studioDate } from '../src/shared/format';
import { appointmentUses, eventUses, findRoomClash } from '../src/domain';
import type { AuthUser } from '../src/shared/types';
import { at, rejects } from './helpers';

const NOW = at('2026-10-14', '16:00'); // Wednesday 4pm Sydney
const OWNER: AuthUser = { kind: 'staff', staffId: 'st_libby', email: '', name: 'Libby', role: 'owner' };

test('pure: appointment and event uses share the room rule; an event does not clash with its own sessions', () => {
  const uses = [
    ...appointmentUses([{ id: 'a1', roomId: 'r1', startsAt: '2026-10-23T09:00:00Z', endsAt: '2026-10-23T10:00:00Z', status: 'booked' },
                        { id: 'a2', roomId: 'r1', startsAt: '2026-10-23T12:00:00Z', endsAt: '2026-10-23T13:00:00Z', status: 'cancelled' },
                        { id: 'a3', startsAt: '2026-10-23T09:00:00Z', endsAt: '2026-10-23T10:00:00Z', status: 'booked' }]),
    ...eventUses([{ id: 'e1', title: 'Hips', roomId: 'r2', sessions: [{ startsAt: '2026-10-24T09:00:00Z', endsAt: '2026-10-24T10:00:00Z' }, { startsAt: '2026-10-25T09:00:00Z', endsAt: '2026-10-25T10:00:00Z' }] },
                  { id: 'e2', title: 'Called off', roomId: 'r2', cancelled: true, sessions: [{ startsAt: '2026-10-26T09:00:00Z', endsAt: '2026-10-26T10:00:00Z' }] }]),
  ];
  assert.equal(uses.length, 3, 'cancelled things and things with no room hold nothing');
  const want = (roomId: string, s: string, e: string, ignoreId?: string) => findRoomClash({ roomId, startsAt: s, endsAt: e, ignoreId }, uses);
  assert.equal(want('r1', '2026-10-23T09:30:00Z', '2026-10-23T10:30:00Z')?.label, 'an appointment');
  assert.equal(want('r1', '2026-10-23T10:00:00Z', '2026-10-23T11:00:00Z'), undefined, 'back to back is fine');
  assert.equal(want('r1', '2026-10-23T12:00:00Z', '2026-10-23T13:00:00Z'), undefined, 'a cancelled appointment let go');
  assert.equal(want('r2', '2026-10-25T09:00:00Z', '2026-10-25T10:00:00Z')?.label, 'Hips');
  assert.equal(want('r2', '2026-10-25T09:00:00Z', '2026-10-25T10:00:00Z', 'e1'), undefined, 'editing the event itself is not a clash');
});

test('demo store: appointments, events and classes can not hold one room at the same time', async () => {
  const store = createDemoStore({ sampleBilling: false, now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio', studio: 'snowy' });
  await store.demoSignInAs!(OWNER);
  const ap = store.features.appointments!;
  const [main] = await store.listRooms();
  const roomA = main!;
  const roomB = await store.upsertRoom({ locationId: roomA.locationId, name: 'Studio 2', active: true });
  const priv = (await ap.listTypes()).find((t) => t.name === 'Private Session')!;
  const day = addDays(studioDate(NOW), 5);
  const slots = await ap.listSlots({ typeId: priv.id, from: day, to: addDays(day, 3) });
  const slot = slots[0]!;
  const client = (await store.listClients())[0]!;
  const book = (s: typeof slot, roomId?: string) => ap.bookAppointment({ typeId: priv.id, staffId: s.staffId, startsAt: s.startsAt, clientId: client.id, pay: { method: 'comp' }, ...(roomId ? { roomId } : {}) });

  // staff hold a room; the appointment says which room and where
  const booked = await book(slot, roomA.id);
  assert.equal(booked.appointment.roomId, roomA.id);
  assert.equal(booked.appointment.locationId, roomA.locationId);
  await rejects(book(slots.find((s) => s.startsAt !== slot.startsAt)!, 'nope'), 'NOT_FOUND');

  // an event on top of it is refused (the message names the room and what holds it); another room is fine
  const when = { startsAt: new Date(Date.parse(slot.startsAt) + 15 * 60_000).toISOString(), endsAt: new Date(Date.parse(slot.startsAt) + 75 * 60_000).toISOString() };
  const ev = { kind: 'workshop' as const, title: 'Hips', description: '', priceCents: 0, capacity: 8, published: true, refundCutoffHours: 0, sessions: [when] };
  await assert.rejects(ap.upsertEvent({ ...ev, roomId: roomA.id }), { code: 'ROOM_BUSY', message: /Main room is already booked at .* for an appointment/ });
  const inB = await ap.upsertEvent({ ...ev, roomId: roomB.id });
  assert.deepEqual([inB.roomId, inB.locationId], [roomB.id, roomA.locationId]);
  const edited = await ap.upsertEvent({ ...inB, title: 'Hips and hamstrings' });
  assert.equal(edited.title, 'Hips and hamstrings', 'an event does not clash with itself');
  assert.equal((await ap.upsertEvent({ ...edited, roomId: undefined as unknown as string })).roomId, undefined, 'clearing the room works');
  await ap.upsertEvent({ ...edited, roomId: roomB.id });

  // a class goes the other way: the room is taken by the event
  const cts = await store.listClassTypes();
  await assert.rejects(store.upsertSession({ classTypeId: cts[0]!.id, startsAt: when.startsAt, endsAt: when.endsAt, instructorId: 'st_julia', capacity: 8, roomId: roomB.id }), { code: 'ROOM_BUSY', message: /Studio 2 is already booked .* for Hips/ });

  // moving an appointment into a busy time is refused; cancelling lets go of the room
  const far = slots.filter((x) => x.staffId === slot.staffId && Math.abs(Date.parse(x.startsAt) - Date.parse(slot.startsAt)) >= 3 * 3_600_000);
  const [other, third] = [far[0]!, far[far.length - 1]!];
  const second = await book(other, roomA.id);
  await ap.upsertEvent({ ...ev, title: 'Evening', roomId: roomA.id, sessions: [{ startsAt: third.startsAt, endsAt: new Date(Date.parse(third.startsAt) + 30 * 60_000).toISOString() }] });
  await rejects(ap.moveAppointment(second.appointment.id, { startsAt: third.startsAt }), 'ROOM_BUSY');
  await ap.cancelAppointment(booked.appointment.id, { waivePenalty: true });
  const again = await ap.upsertEvent({ ...ev, title: 'Same time, same room', roomId: roomA.id });
  assert.equal(again.roomId, roomA.id, 'a cancelled appointment let go of the room');
});
