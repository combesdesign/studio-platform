// Spot (mat / reformer) selection: the pure layout rules, then the demo store (picking, clashes, auto-assign for waitlist promotion
// and family, cancelling frees the spot, capacity untouched, who can change what and when) and the sample studios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookableSpots, makeLayout, pickSpot, resizeLayout, roomForSession, sessionLayout, setCellKind, validateLayout,
} from '../src/domain';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import type { Location, Room, SpotLayout } from '../src/shared/types';
import { OWNER, asClient, at, baseState, harness, mkClient, mkSession, rejects } from './helpers';

const NOW = at('2026-10-12', '08:00');   // Monday
const LOC: Location = { id: 'loc1', name: 'Main location', address: '', active: true, isDefault: true };
/** 2 x 3: the instructor, then five cells of which one is out of order: four bookable spots (1 to 4). */
const LAYOUT: SpotLayout = {
  rows: 2, cols: 3,
  cells: [{ label: 'Instructor', kind: 'instructor' }, { label: '1', kind: 'spot' }, { label: '2', kind: 'spot' },
    { label: '', kind: 'unavailable' }, { label: '3', kind: 'spot' }, { label: '4', kind: 'spot' }],
};
const ROOM: Room = { id: 'rm1', locationId: 'loc1', name: 'Main room', active: true, spotLayout: LAYOUT };

function state(opts: { spotPicking?: boolean; capacity?: number; layout?: boolean } = {}) {
  const ct = baseState().classTypes.map((c) => (c.id === 'ct_mat' ? { ...c, spotPicking: opts.spotPicking !== false } : c));
  return baseState({
    classTypes: ct, locations: [{ ...LOC }], rooms: [opts.layout === false ? { ...ROOM, spotLayout: undefined as never } : { ...ROOM }],
    clients: [mkClient('amy', 'Amy'), mkClient('ben', 'Ben'), mkClient('cat', 'Cat'), mkClient('dan', 'Dan'), mkClient('eve', 'Eve'),
      mkClient('mum', 'Mum'), mkClient('kid', 'Kid', { guardianClientId: 'mum', email: '' })],
    sessions: [
      mkSession('mon18', '2026-10-12', '18:00', { capacity: opts.capacity ?? 4, roomId: 'rm1', locationId: 'loc1' }),
      mkSession('wed18', '2026-10-14', '18:00', { capacity: 4, roomId: 'rm1', locationId: 'loc1' }),
    ],
  });
}

async function setup(opts: Parameters<typeof state>[0] = {}) {
  const h = await harness(state(opts), NOW);
  for (const c of ['amy', 'ben', 'cat', 'dan', 'eve', 'mum', 'kid']) await h.give(c, 'pr_mu');
  return h;
}

// ---------------------------------------------------------------- pure
test('layouts: a fresh grid is numbered 1..n, resizing keeps what is there, bad layouts say why', () => {
  const g = makeLayout(2, 6);
  assert.deepEqual(bookableSpots(g), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  const edited = setCellKind(setCellKind(g, 0, 'instructor'), 5, 'unavailable');
  const bigger = resizeLayout(edited, 3, 6);
  assert.equal(bigger.cells[0]!.kind, 'instructor');
  assert.equal(bigger.cells[5]!.kind, 'unavailable');
  assert.equal(bookableSpots(bigger).length, 16);
  assert.equal(validateLayout(g), null);
  assert.match(validateLayout({ ...g, cells: g.cells.slice(1) }) ?? '', /isn’t valid/);
  assert.match(validateLayout({ ...g, cells: g.cells.map((c, i) => (i === 1 ? { ...c, label: '1' } : c)) }) ?? '', /Two spots are called/);
  assert.match(validateLayout({ rows: 1, cols: 1, cells: [{ label: '', kind: 'unavailable' }] }) ?? '', /at least one spot/);
  assert.match(validateLayout({ rows: 1, cols: 1, cells: [{ label: ' ', kind: 'spot' }] }) ?? '', /number or name/);
});

test('pick for me: first free in reading order, or the free spot nearest the family', () => {
  assert.equal(pickSpot(LAYOUT, []), '1');
  assert.equal(pickSpot(LAYOUT, ['1', '2']), '3');
  assert.equal(pickSpot(LAYOUT, ['1', '2', '3', '4']), undefined);
  const wide = makeLayout(2, 6);
  assert.equal(pickSpot(wide, ['1', '2', '3', '4', '5'], ['5']), '6', 'next to the parent, not the front of the room');
  assert.equal(pickSpot(wide, ['8'], ['8']), '7');
});

test('a class uses spots only with the class type on and a room with a layout (a lone default room counts)', () => {
  const ct = { spotPicking: true }, rooms = [ROOM], locs = [LOC];
  assert.ok(sessionLayout({ roomId: 'rm1' }, ct, rooms, locs));
  assert.equal(sessionLayout({ roomId: 'rm1' }, { spotPicking: false }, rooms, locs), undefined, 'class type off');
  assert.equal(sessionLayout({ roomId: 'rm1' }, undefined, rooms, locs), undefined);
  assert.equal(sessionLayout({ roomId: 'nope' }, ct, rooms, locs), undefined, 'unknown room');
  assert.ok(sessionLayout({}, ct, rooms, locs), 'no room: the only room at the main location');
  const two: Room[] = [ROOM, { id: 'rm2', locationId: 'loc1', name: 'Second', active: true }];
  assert.equal(roomForSession({}, two, locs), undefined, 'no room and two rooms: no guess');
  assert.equal(sessionLayout({ roomId: 'rm2' }, ct, two, locs), undefined, 'a room without a layout');
});

// ---------------------------------------------------------------- the store
test('picking a spot while booking; without one you are given the first free; the picker never shows who holds a spot', async () => {
  const h = await setup();
  await h.as(asClient('amy'));
  const spots = await h.store.getSessionSpots!('mon18');
  assert.equal(spots.enabled, true);
  assert.deepEqual(spots.taken, []);
  assert.equal(spots.layout!.cells.length, 6);
  const a = await h.store.bookClass('amy', 'mon18', { spot: '4' });
  assert.equal(a.booking.spot, '4');
  await h.as(asClient('ben'));
  const b = await h.store.bookClass('ben', 'mon18');
  assert.equal(b.booking.spot, '1', 'no choice made: the first free spot');
  assert.deepEqual((await h.store.getSessionSpots!('mon18')).taken.sort(), ['1', '4']);
  assert.equal(JSON.stringify(await h.store.getSessionSpots!('mon18')).includes('amy'), false);
  const mine = await h.store.listClientBookings('ben', { when: 'upcoming' });
  assert.equal(mine[0]!.spot, '1', 'the spot shows on the booking');
});

test('two people can not hold the same spot; a spot outside the layout is refused; moving frees the old one', async () => {
  const h = await setup();
  await h.as(asClient('amy'));
  const a = await h.store.bookClass('amy', 'mon18', { spot: '2' });
  await h.as(asClient('ben'));
  await rejects(h.store.bookClass('ben', 'mon18', { spot: '2' }), 'SPOT_TAKEN');
  assert.equal((await h.store.getSessionSpots!('mon18')).taken.length, 1, 'the refused booking left nothing behind');
  await rejects(h.store.bookClass('ben', 'mon18', { spot: '9' }), 'INVALID');
  const b = await h.store.bookClass('ben', 'mon18', { spot: '3' });
  await rejects(h.store.chooseSpot!(b.booking.id, '2'), 'SPOT_TAKEN');
  assert.equal((await h.store.chooseSpot!(b.booking.id, '4')).spot, '4');
  assert.deepEqual((await h.store.getSessionSpots!('mon18')).taken.sort(), ['2', '4'], 'spot 3 is free again');
  await h.as(asClient('amy'));
  assert.equal((await h.store.chooseSpot!(a.booking.id, '3')).spot, '3', 'and someone else can take it');
  assert.equal((await h.store.chooseSpot!(a.booking.id, null)).spot, '1', 'pick for me: the first free one');
  await rejects(h.store.chooseSpot!(b.booking.id, '2'), 'NOT_ALLOWED');   // Ben's booking
});

test('cancelling frees the spot for the next person', async () => {
  const h = await setup();
  await h.as(asClient('amy'));
  const a = await h.store.bookClass('amy', 'mon18', { spot: '1' });
  await h.store.cancelBooking(a.booking.id);
  assert.deepEqual((await h.store.getSessionSpots!('mon18')).taken, []);
  const row = (await h.store.listClientBookings('amy', { statuses: ['cancelled'] }))[0]!;
  assert.equal(row.spot, undefined, 'a cancelled booking holds no spot');
  await h.as(asClient('ben'));
  assert.equal((await h.store.bookClass('ben', 'mon18', { spot: '1' })).booking.spot, '1');
});

test('a waitlist promotion is given a spot (the one just freed), and the capacity rules are untouched', async () => {
  const h = await setup({ capacity: 2 });
  await h.as(asClient('amy')); const a = await h.store.bookClass('amy', 'mon18');
  await h.as(asClient('ben')); const b = await h.store.bookClass('ben', 'mon18', { spot: '4' });
  await h.as(asClient('cat'));
  const c = await h.store.bookClass('cat', 'mon18', { spot: '3' });
  assert.equal(c.outcome, 'waitlisted', 'full: waitlisted, and a spot is not held for her');
  assert.equal(c.booking.spot, undefined);
  assert.deepEqual((await h.store.getSessionSpots!('mon18')).taken.sort(), ['1', '4']);
  await h.as(asClient('amy'));
  const r = await h.store.cancelBooking(a.booking.id);
  assert.equal(r.promoted?.clientId, 'cat');
  assert.equal(r.promoted?.spot, '1', 'the promoted client gets the first free spot');
  assert.deepEqual((await h.store.getSessionSpots!('mon18')).taken.sort(), ['1', '4']);
  assert.equal((await h.store.getSession('mon18')).bookedCount, 2);
});

test('family: a dependant is booked next to their parent without choosing', async () => {
  const h = await setup();
  await h.as(asClient('amy')); await h.store.bookClass('amy', 'mon18', { spot: '2' });
  await h.as(asClient('mum'));
  const [mum, kid] = await h.store.bookAttendees!('mon18', ['mum', 'kid']);
  assert.equal(mum!.booking.spot, '1');
  assert.equal(kid!.booking.spot, '3', 'the nearest free spot to Mum, not the next number');
  assert.equal(new Set([mum!.booking.spot, kid!.booking.spot, '2']).size, 3);
});

test('more people than spots: capacity still decides who is in, the extra person simply has no spot', async () => {
  const h = await setup({ capacity: 5 });
  const spots: (string | undefined)[] = [];
  for (const c of ['amy', 'ben', 'cat', 'dan', 'eve']) { await h.as(asClient(c)); spots.push((await h.store.bookClass(c, 'mon18')).booking.spot); }
  assert.deepEqual(spots, ['1', '2', '3', '4', undefined]);
  assert.equal((await h.store.getSession('mon18')).bookedCount, 5);
  await h.as(asClient('eve'));
  await rejects(h.store.chooseSpot!((await h.store.listClientBookings('eve', { when: 'upcoming' }))[0]!.id, '1'), 'SPOT_TAKEN');
});

test('staff assign a walk-in a spot and move anyone; clients can not change a spot once the class has started', async () => {
  const h = await setup();
  await h.as(OWNER);
  const w = await h.store.bookClass('dan', 'mon18', { asStaff: true, spot: '3' });
  assert.equal(w.booking.spot, '3');
  const roster = await h.store.getRoster('mon18');
  assert.equal(roster.find((e) => e.clientId === 'dan')!.spot, '3');
  assert.equal((await h.store.chooseSpot!(w.booking.id, '2')).spot, '2');
  await h.store.checkIn(w.booking.id);
  assert.equal((await h.store.chooseSpot!(w.booking.id, '4')).spot, '4', 'staff can move a checked-in client');
  h.setNow(at('2026-10-12', '18:10'));                              // class has started
  await h.as(asClient('dan'));
  await rejects(h.store.chooseSpot!(w.booking.id, '1'), 'TOO_LATE');
  await h.as(OWNER);
  assert.equal((await h.store.chooseSpot!(w.booking.id, '1')).spot, '1', 'staff still can until it ends');
});

test('spots off: a class type without the toggle, or a room without a layout, behaves exactly as before', async () => {
  for (const o of [{ spotPicking: false }, { layout: false }]) {
    const h = await setup(o);
    await h.as(asClient('amy'));
    assert.equal((await h.store.getSessionSpots!('mon18')).enabled, false);
    const r = await h.store.bookClass('amy', 'mon18');
    assert.equal(r.booking.spot, undefined);
    await rejects(h.store.chooseSpot!(r.booking.id, '1'), 'INVALID');
    await h.as(asClient('ben'));
    await rejects(h.store.bookClass('ben', 'mon18', { spot: '1' }), 'INVALID');
  }
});

test('switching a class type on later gives everyone already booked a spot; editing a room layout needs a valid one', async () => {
  const h = await setup({ spotPicking: false });
  await h.as(asClient('amy')); await h.store.bookClass('amy', 'mon18');
  await h.as(asClient('ben')); await h.store.bookClass('ben', 'mon18');
  await h.as(OWNER);
  const ct = (await h.store.listClassTypes()).find((c) => c.id === 'ct_mat')!;
  await h.store.upsertClassType({ ...ct, spotPicking: true });
  const roster = await h.store.getRoster('mon18');
  assert.deepEqual(roster.map((e) => e.spot).sort(), ['1', '2']);
  const room = (await h.store.listRooms())[0]!;
  await assert.rejects(h.store.upsertRoom({ ...room, spotLayout: { rows: 1, cols: 2, cells: [{ label: '1', kind: 'spot' }, { label: '1', kind: 'spot' }] } }), { code: 'INVALID' });
  const renamed = await h.store.upsertRoom({ id: room.id, locationId: room.locationId, name: 'Reformer room', active: true });
  assert.ok(renamed.spotLayout, 'saving a room without a layout leaves its layout alone');
  assert.equal((await h.store.upsertRoom({ id: room.id, locationId: room.locationId, name: 'Reformer room', active: true, spotLayout: null })).spotLayout, undefined);
});

// ---------------------------------------------------------------- the sample studios
test('Harbour has a reformer layout with spot picking on and every booking holds a different spot; Snowy is unchanged', async () => {
  const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
  const harbour = p.forStudio((await p.findStudio({ slug: 'harbour' }))!), snowy = p.forStudio((await p.findStudio({ slug: 'snowy' }))!);
  const rooms = await harbour.listRooms();
  assert.equal(rooms.filter((r) => r.spotLayout).length, 3);
  const layout = rooms.find((r) => r.name === 'Studio A')!.spotLayout!;
  assert.deepEqual([layout.rows, layout.cols], [2, 6]);
  assert.equal(validateLayout(layout), null);
  assert.ok((await harbour.listClassTypes()).every((c) => c.spotPicking));
  await harbour.demoSignInAs!((await harbour.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'owner')!);
  let withSpots = 0;
  for (const s of await harbour.listSessions({ from: '2026-10-05T00:00:00+11:00', to: '2026-11-02T00:00:00+11:00' })) {
    const live = (await harbour.getRoster(s.id)).filter((e) => e.status === 'booked' || e.status === 'checked_in');
    const mine = live.map((e) => e.spot).filter((x): x is string => !!x);
    assert.equal(new Set(mine).size, mine.length, 'no two people share a spot');
    if (s.roomId !== 'hb_room_sh_back') assert.equal(mine.length, live.length, 'everyone booked has a spot');
    withSpots += mine.length;
  }
  assert.ok(withSpots > 10);
  assert.ok((await snowy.listRooms()).every((r) => !r.spotLayout));
  assert.ok((await snowy.listClassTypes()).every((c) => !c.spotPicking));
});
