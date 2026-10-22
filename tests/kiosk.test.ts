// Kiosk: which classes and people show up on the check-in screen, and that nothing private leaks onto it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kioskPeople, kioskSessions, searchPeople } from '../src/features/kiosk/logic';
import type { RosterEntry } from '../src/shared/store';

const NOW = new Date('2026-10-23T08:00:00.000Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const cls = (id: string, startMin: number, lenMin = 55, status: 'scheduled' | 'cancelled' = 'scheduled') => ({ id, startsAt: at(startMin), endsAt: at(startMin + lenMin), status });

test('kiosk classes: starting within 60 minutes or running, not cancelled or finished', () => {
  const out = kioskSessions([
    cls('later', 90), cls('soon', 59), cls('edge', 60), cls('running', -20), cls('over', -60), cls('cancelled', 10, 55, 'cancelled'), cls('next', 30),
  ], NOW).map((s) => s.id);
  assert.deepEqual(out, ['running', 'next', 'soon', 'edge']);
});

const entry = (id: string, first: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id, sessionId: 's', clientId: 'c' + id, status: 'booked', createdAt: at(-1000), source: 'client', flags: [],
  client: { id: 'c' + id, firstName: first, lastName: 'Brown', email: 'x@y.z', createdAt: at(-1000), marketingOptIn: false, injuries: 'Bad knee', staffNotes: 'Private note' },
  ...over,
});

test('kiosk people: only booked or checked-in, first name + initial, nothing private', () => {
  const people = kioskPeople([
    entry('1', 'Hannah', { flags: ['first_class'] }), entry('2', 'Ava', { status: 'checked_in' }), entry('3', 'Zoe', { status: 'waitlisted' }),
    entry('4', 'Mia', { status: 'no_show' }), entry('5', 'Isla', { flags: ['injury', 'birthday', 'last_credit'] }), entry('6', 'Ella', { flags: ['no_waiver'] }),
  ]);
  assert.deepEqual(people.map((p) => p.firstName), ['Ava', 'Ella', 'Hannah', 'Isla']);
  assert.deepEqual(people.map((p) => p.checkedIn), [true, false, false, false]);
  // "see the front desk" only for no waiver / first class; injuries and the rest stay off the screen
  assert.deepEqual(people.map((p) => p.seeDesk), [false, true, true, false]);
  assert.equal(people[2]!.lastInitial, 'B.');
  assert.doesNotMatch(JSON.stringify(people), /knee|Private|x@y\.z|Brown|injur/i);
});

test('kiosk search: start of the first name, any case', () => {
  const people = kioskPeople([entry('1', 'Hannah'), entry('2', 'Hana'), entry('3', 'Ava')]);
  assert.deepEqual(searchPeople(people, ' han').map((p) => p.firstName), ['Hana', 'Hannah']);
  assert.equal(searchPeople(people, '').length, 3);
  assert.equal(searchPeople(people, 'zzz').length, 0);
});

test('kiosk exit lockout: 5 wrong PINs lock for 5 minutes, a right PIN clears the count', async () => {
  const { NO_LOCK, afterPinTry, lockMinutesLeft, lockMessage } = await import('../src/features/kiosk/logic');
  let lock = NO_LOCK;
  for (let i = 1; i <= 4; i++) { lock = afterPinTry(lock, false, NOW.getTime()); assert.equal(lockMinutesLeft(lock, NOW.getTime()), 0); }
  assert.equal(lock.fails, 4);
  assert.equal(afterPinTry(lock, true, NOW.getTime()), NO_LOCK);
  lock = afterPinTry(lock, false, NOW.getTime());
  assert.equal(lockMinutesLeft(lock, NOW.getTime()), 5);
  assert.equal(lockMinutesLeft(lock, NOW.getTime() + 4 * 60_000 + 1), 1);
  assert.equal(lockMinutesLeft(lock, NOW.getTime() + 5 * 60_000), 0);
  assert.match(lockMessage(1), /1 minute\./);
  // after the lockout ends the count starts fresh
  const again = afterPinTry(lock, false, NOW.getTime() + 6 * 60_000);
  assert.deepEqual(again, { fails: 1, until: 0 });
});
