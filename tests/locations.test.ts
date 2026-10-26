// Multi-location and rooms: the room clash check, the location filter, the demo store's locations and rooms (clash enforced on
// classes and weekly slots, plan gate, report filter) and the sample studios (Harbour two locations, Snowy exactly one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classUses, defaultLocation, directionsPlatform, directionsUrl, effectiveLocationId, filterByLocation, findRoomClash, hasManyLocations,
  hasManyRooms, roomsAt, templateClashes, timesOverlap,
} from '../src/domain';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import type { DataStore } from '../src/shared/store';
import type { ClassSession, Location, Room, ScheduleTemplate } from '../src/shared/types';
import { OWNER, baseState, harness, mkSession } from './helpers';

const NOW = new Date('2026-10-19T08:00:00+11:00');
const DAY = '2026-10-21';
const LOC_A: Location = { id: 'loc_a', name: 'Bondi', address: '1 Beach Rd, Bondi', active: true, isDefault: true };
const LOC_B: Location = { id: 'loc_b', name: 'Surry Hills', address: '2 Crown St, Surry Hills', active: true };
const ROOMS: Room[] = [
  { id: 'rm_a1', locationId: 'loc_a', name: 'Studio A', capacity: 8, active: true },
  { id: 'rm_a2', locationId: 'loc_a', name: 'Studio B', active: true },
  { id: 'rm_b1', locationId: 'loc_b', name: 'The Loft', active: true },
];
const inRoom = (s: ClassSession, roomId: string, locationId: string): ClassSession => ({ ...s, roomId, locationId });

// ---------------------------------------------------------------- pure
test('room clash: overlapping times in the same room; back-to-back, other rooms, no room and cancelled classes are fine', () => {
  const uses = classUses([
    inRoom(mkSession('a', DAY, '09:00'), 'rm_a1', 'loc_a'),                                   // 9:00 to 9:55
    inRoom(mkSession('c', DAY, '12:00', { status: 'cancelled' }), 'rm_a1', 'loc_a'),          // cancelled: doesn't hold the room
    mkSession('n', DAY, '15:00'),                                                             // no room
  ], []);
  const nine = uses[0]!;
  assert.equal(uses.length, 1, 'cancelled and room-less classes hold nothing');
  assert.equal(findRoomClash({ roomId: 'rm_a1', startsAt: nine.startsAt, endsAt: nine.endsAt }, uses)?.id, 'a', 'same time, same room');
  assert.equal(findRoomClash({ roomId: 'rm_a1', startsAt: new Date(Date.parse(nine.startsAt) + 30 * 60_000).toISOString(), endsAt: new Date(Date.parse(nine.endsAt) + 30 * 60_000).toISOString() }, uses)?.id, 'a', 'half overlap');
  assert.equal(findRoomClash({ roomId: 'rm_a1', startsAt: nine.endsAt, endsAt: new Date(Date.parse(nine.endsAt) + 3_000_000).toISOString() }, uses), undefined, 'starts as the other ends');
  assert.equal(findRoomClash({ roomId: 'rm_a2', startsAt: nine.startsAt, endsAt: nine.endsAt }, uses), undefined, 'another room');
  assert.equal(findRoomClash({ roomId: undefined, startsAt: nine.startsAt, endsAt: nine.endsAt }, uses), undefined, 'no room, no clash');
  assert.equal(findRoomClash({ roomId: 'rm_a1', startsAt: nine.startsAt, endsAt: nine.endsAt, ignoreId: 'a' }, uses), undefined, 'a class never clashes with itself');
  assert.equal(timesOverlap('2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z', '2026-10-21T11:00:00Z'), false);
});

test('weekly slots clash only in the same room, on the same day, at overlapping times, while both are active and running', () => {
  const types = [{ id: 'ct_mat', durationMin: 55 }] as never;
  const tp = (id: string, o: Partial<ScheduleTemplate>): ScheduleTemplate => ({ id, classTypeId: 'ct_mat', weekday: 1, startTime: '09:00', instructorId: 'i', startsOn: '2026-01-01', active: true, roomId: 'rm_a1', locationId: 'loc_a', ...o });
  const others = [tp('t1', {}), tp('t2', { weekday: 2 }), tp('t3', { roomId: 'rm_a2' }), tp('t4', { active: false }), tp('t5', { startsOn: '2027-01-01' }), tp('t6', { startTime: '10:25' })];
  assert.deepEqual(templateClashes(tp('new', { startTime: '09:30', endsOn: '2026-12-31' }), others, types).map((x) => x.id), ['t1'], 'only the live one in the same room and day (t6 starts as it ends)');
  assert.deepEqual(templateClashes(tp('t1', { endsOn: '2026-12-31' }), others, types).map((x) => x.id), [], 'editing a slot ignores itself');
  assert.deepEqual(templateClashes(tp('new', { roomId: undefined }), others, types), [], 'no room, no clash');
  assert.deepEqual(templateClashes(tp('new', { endsOn: '2026-12-31', startTime: '09:30' }), [tp('late', { startsOn: '2027-01-01' })], types), [], 'date ranges that never meet');
});

test('location filter: no location means the default one; one location means nothing to filter', () => {
  const locs = [LOC_B, LOC_A];
  assert.equal(defaultLocation(locs)?.id, 'loc_a');
  assert.equal(defaultLocation([{ ...LOC_A, isDefault: false, active: false }, LOC_B])?.id, 'loc_b', 'no flag: first active');
  const items = [{ id: '1', locationId: 'loc_a' }, { id: '2', locationId: 'loc_b' }, { id: '3' }];
  assert.deepEqual(filterByLocation(items, 'loc_a', locs).map((x) => x.id), ['1', '3'], 'the unplaced class is at the default location');
  assert.deepEqual(filterByLocation(items, 'loc_b', locs).map((x) => x.id), ['2']);
  assert.deepEqual(filterByLocation(items, undefined, locs).map((x) => x.id), ['1', '2', '3'], 'no filter = all');
  assert.equal(effectiveLocationId({}, locs), 'loc_a');
  assert.equal(hasManyLocations([LOC_A]), false);
  assert.equal(hasManyLocations([LOC_A, { ...LOC_B, active: false }]), false, 'a switched-off location doesn’t count');
  assert.equal(hasManyLocations(locs), true);
  assert.equal(hasManyRooms(ROOMS.slice(0, 1)), false);
  assert.equal(hasManyRooms(ROOMS), true);
  assert.deepEqual(roomsAt(ROOMS, 'loc_a').map((r) => r.name), ['Studio A', 'Studio B']);
});

test('directions: Apple Maps on Apple devices, Google Maps elsewhere, address encoded', () => {
  assert.equal(directionsPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'apple');
  assert.equal(directionsPlatform('Mozilla/5.0 (Linux; Android 14)'), 'google');
  assert.equal(directionsUrl('2 Crown St, Surry Hills', 'apple'), 'https://maps.apple.com/?daddr=2%20Crown%20St%2C%20Surry%20Hills');
  assert.match(directionsUrl('2 Crown St', 'google'), /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=2%20Crown%20St$/);
});

// ---------------------------------------------------------------- the demo store
async function owner() {
  const h = await harness(baseState({ locations: [{ ...LOC_A }, { ...LOC_B }], rooms: ROOMS.map((r) => ({ ...r })) }), NOW);
  return h.store;
}
const sessionIn = (s: DataStore, roomId: string | undefined, hhmm: string, extra: Partial<ClassSession> = {}) => {
  const mk = mkSession('x', DAY, hhmm);
  return s.upsertSession({ classTypeId: mk.classTypeId, startsAt: mk.startsAt, endsAt: mk.endsAt, instructorId: mk.instructorId, capacity: 10, ...(roomId ? { roomId } : {}), ...extra });
};

test('store: every studio has a default location and room, made on first use', async () => {
  const h = await harness(baseState(), NOW);
  const [locs, rooms] = [await h.store.listLocations(), await h.store.listRooms()];
  assert.equal(locs.length, 1);
  assert.deepEqual([locs[0]!.isDefault, locs[0]!.active, rooms.length, rooms[0]!.locationId], [true, true, 1, locs[0]!.id]);
  assert.equal(hasManyLocations(locs), false, 'a one-location studio sees none of this');
});

test('store: a room can’t be double-booked; a place is optional; cancelling frees the room', async () => {
  const s = await owner();
  const a = await sessionIn(s, 'rm_a1', '09:00');
  assert.deepEqual([a.roomId, a.locationId], ['rm_a1', 'loc_a'], 'the room brings its location');
  await assert.rejects(sessionIn(s, 'rm_a1', '09:30'), { code: 'ROOM_BUSY', message: /Studio A is already booked at 9:00am for/ });
  await sessionIn(s, 'rm_a1', '09:55');                       // back to back is fine
  await sessionIn(s, 'rm_a2', '09:00');                       // another room, same time
  await sessionIn(s, undefined, '09:00');                     // no room at all
  await assert.rejects(sessionIn(s, 'rm_b1', '09:00', { locationId: 'loc_a' }), { code: 'INVALID', message: /different location/ });
  await assert.rejects(sessionIn(s, 'rm_nope', '09:00'), { code: 'NOT_FOUND' });
  await s.cancelSession(a.id, 'Teacher sick');
  await sessionIn(s, 'rm_a1', '08:15');                       // the cancelled class let go of the room
  await assert.rejects(s.upsertSession({ ...a, status: 'scheduled' }), { code: 'ROOM_BUSY' });   // ...so putting it back is refused now
  await assert.rejects(s.restoreSession!(a.id), { code: 'ROOM_BUSY' });
});

test('store: editing a class keeps its room unless you change it; saving without a room clears it', async () => {
  const s = await owner();
  const a = await sessionIn(s, 'rm_a1', '14:00');
  const same = await s.upsertSession({ ...a, note: 'Bring a towel' });
  assert.equal(same.roomId, 'rm_a1', 'its own time is not a clash with itself');
  const none = await s.upsertSession({ ...a, roomId: undefined as never, locationId: undefined as never });
  assert.equal(none.roomId, undefined);
});

test('store: weekly slots in a busy room are refused, and a generated class skips a room that’s taken', async () => {
  const s = await owner();
  const ins = (await s.listStaff())[0]!.id;
  const slot = (startTime: string, roomId?: string) => s.upsertTemplate({ classTypeId: 'ct_mat', weekday: 3, startTime, instructorId: ins, startsOn: '2026-10-01', active: true, ...(roomId ? { roomId } : {}) });
  const t1 = await slot('09:00', 'rm_a1');
  assert.equal(t1.locationId, 'loc_a');
  await assert.rejects(slot('09:30', 'rm_a1'), { code: 'ROOM_BUSY', message: /Studio A already has/ });
  await slot('09:30', 'rm_a2');
  // a one-off class already holds the room on the 28th at 11:00; the weekly 11:00 slot made later skips that date only
  await sessionIn(s, 'rm_a1', '11:00', { startsAt: mkSession('o', '2026-10-28', '11:00').startsAt, endsAt: mkSession('o', '2026-10-28', '11:55').endsAt });
  await slot('11:00', 'rm_a1');
  await s.generateSessions('2026-10-21', '2026-11-04');
  const all = await s.listSessions({ from: '2026-10-20T00:00:00Z', to: '2026-11-05T00:00:00Z' });
  const day = (iso: string) => new Date(Date.parse(iso) + 11 * 3_600_000).toISOString().slice(0, 10);   // Sydney date (AEDT)
  const weekly11 = all.filter((x) => x.templateId && x.roomId === 'rm_a1' && new Date(x.startsAt).getUTCHours() === 0);
  assert.deepEqual(weekly11.map((x) => day(x.startsAt)).sort(), ['2026-10-21', '2026-11-04'], 'the 28th keeps the one-off class that was there first');
  assert.equal(all.filter((x) => x.roomId === 'rm_a1' && day(x.startsAt) === '2026-10-28' && new Date(x.startsAt).getUTCHours() === 0).length, 1, 'never two in the room');
});

test('store: reports can be limited to a location (classes only; sessions without a location count for the default one)', async () => {
  const past = (id: string, d: string, extra: Partial<ClassSession>) => mkSession(id, d, '09:00', extra);
  const h = await harness(baseState({
    locations: [{ ...LOC_A }, { ...LOC_B }], rooms: ROOMS.map((r) => ({ ...r })),
    sessions: [past('p1', '2026-10-12', { roomId: 'rm_a1', locationId: 'loc_a' }), past('p2', '2026-10-13', { roomId: 'rm_b1', locationId: 'loc_b' }), past('p3', '2026-10-14', {}), past('p4', '2026-10-15', { roomId: 'rm_b1', locationId: 'loc_b' })],
  }), NOW);
  const range = { from: '2026-10-12', to: '2026-10-18' };
  assert.equal((await h.store.getReport(range)).classesRun, 4);
  assert.equal((await h.store.getReport({ ...range, locationId: 'loc_a' })).classesRun, 2, 'Bondi: its own class plus the one with no location');
  assert.equal((await h.store.getReport({ ...range, locationId: 'loc_b' })).classesRun, 2);
});

test('store: only owners and managers edit locations; names are unique; the main location stays on', async () => {
  const h = await harness(baseState({ locations: [{ ...LOC_A }, { ...LOC_B }], rooms: ROOMS.map((r) => ({ ...r })) }), NOW);
  const s = h.store;
  const bondi = await s.upsertLocation({ name: 'Bondi Beach', address: '1 Beach Rd', active: true, id: 'loc_a' });
  assert.equal(bondi.isDefault, true, 'renaming keeps it the main location');
  await assert.rejects(s.upsertLocation({ name: 'surry hills', address: '', active: true }), { code: 'INVALID', message: /already have a location/ });
  await assert.rejects(s.upsertLocation({ id: 'loc_a', name: 'Bondi', address: '', active: false }), { code: 'INVALID', message: /main location/ });
  await assert.rejects(s.upsertRoom({ locationId: 'loc_a', name: 'studio a', active: true }), { code: 'INVALID', message: /already has a room/ });
  const room = await s.upsertRoom({ locationId: 'loc_b', name: 'Back room', capacity: 6, active: true });
  assert.deepEqual([room.locationId, room.capacity], ['loc_b', 6]);
  await assert.rejects(s.upsertRoom({ locationId: 'nope', name: 'X', active: true }), { code: 'NOT_FOUND' });
  const julia = (await s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'instructor')!;
  await s.demoSignInAs!(julia);
  await assert.rejects(s.upsertLocation({ name: 'Sneaky', address: '', active: true }), { code: 'NOT_ALLOWED' });
  assert.equal((await s.listLocations()).length, 2, 'staff can still read them');
  await s.demoSignInAs!(OWNER);
});

// ---------------------------------------------------------------- the sample studios and the plan gate
test('demo platform: Harbour has Bondi and Surry Hills with rooms and classes at both; Snowy has the one default location', async () => {
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const snowy = p.forStudio((await p.findStudio({ slug: 'snowy' }))!), harbour = p.forStudio((await p.findStudio({ slug: 'harbour' }))!);
  const sl = await snowy.listLocations();
  assert.equal(sl.length, 1);
  assert.equal((await snowy.listRooms()).length, 1);
  const hl = await harbour.listLocations(), hr = await harbour.listRooms();
  assert.deepEqual(hl.map((l) => l.name), ['Bondi', 'Surry Hills']);
  assert.ok(hr.filter((r) => r.locationId === hl[0]!.id).length >= 2 && hr.filter((r) => r.locationId === hl[1]!.id).length >= 1);
  const week = await harbour.listSessions({ from: '2026-10-19T00:00:00+11:00', to: '2026-10-26T00:00:00+11:00' });
  for (const l of hl) assert.ok(filterByLocation(week, l.id, hl).filter((x) => x.roomId).length >= 4, `${l.name} has classes in rooms`);
  assert.ok(week.every((x) => !x.roomId || hr.find((r) => r.id === x.roomId)?.locationId === x.locationId), 'every class room belongs to its location');
  for (const x of snowy ? await snowy.listSessions({ from: '2026-10-19T00:00:00+11:00', to: '2026-10-26T00:00:00+11:00' }) : []) assert.equal(x.roomId, undefined, 'Snowy classes have no room');
});

test('plan gate: a studio without multi_location can’t add its second location; one that already has several keeps going', async () => {
  const storage = memoryStorage();   // the admin and the owner are two apps on one device
  const admin = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage, app: 'admin' });
  await admin.demoSignInAs!('pete@studioplatform.example');
  const snowy = (await admin.findStudio({ slug: 'snowy' }))!;
  await admin.setStudioPlan(snowy.id, { planId: 'plan_studio', status: 'active' });
  const app = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage, app: 'studio' });
  const store = app.forStudio((await app.findStudio({ slug: 'snowy' }))!);
  await store.demoSignInAs!((await store.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'owner')!);
  await assert.rejects(store.upsertLocation({ name: 'Cooma North', address: '', active: true }), { code: 'FEATURE_LOCKED' });
  await admin.setStudioPlan(snowy.id, { planId: 'plan_signature', status: 'active' });
  const again = app.forStudio((await app.findStudio({ slug: 'snowy' }))!);
  assert.equal((await again.upsertLocation({ name: 'Cooma North', address: '9 Sharp St, Cooma', active: true })).name, 'Cooma North');
});
