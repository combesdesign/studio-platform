// Locations polish: the client's .ics file and Bookings list name the location when the studio has several, and a location in another
// timezone shows its own local times (display only). A one-location studio is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icsDataUrl, inZone, placeOf, sessionZone, zoneLabel } from '../src/domain';
import { time } from '../src/shared/format';
import type { Location, SessionWithCounts, StudioSettings } from '../src/shared/types';
import { at, mkSession } from './helpers';
import { defaultSettings } from '../src/data/demo/fixtures';

const loc = (id: string, name: string, extra: Partial<Location> = {}): Location => ({ id, name, address: `1 ${name} St`, active: true, ...extra });
const BONDI = loc('bondi', 'Bondi', { isDefault: true });
const PERTH = loc('perth', 'Perth', { timezone: 'Australia/Perth' });
const one = [loc('main', 'Main location', { isDefault: true })];
const many = [BONDI, PERTH];
const session = (extra: object = {}) => ({ ...mkSession('s1', '2026-10-14', '18:00'), spotsLeft: 3, ...extra }) as unknown as SessionWithCounts;
const decode = (url: string) => decodeURIComponent(url.replace('data:text/calendar;charset=utf-8,', ''));

test('placeOf: nothing for a one-location studio, the class\'s location (or the default) otherwise', () => {
  assert.equal(placeOf(session(), one), undefined);
  assert.equal(placeOf(session(), many)?.name, 'Bondi', 'no location = the default one');
  assert.equal(placeOf(session({ locationId: 'perth' }), many)?.name, 'Perth');
});

test('sessionZone: only when the location\'s timezone differs from the studio\'s', () => {
  assert.equal(sessionZone(session(), many, 'Australia/Sydney'), undefined);
  assert.equal(sessionZone(session({ locationId: 'perth' }), many, 'Australia/Sydney'), 'Australia/Perth');
  assert.equal(sessionZone(session({ locationId: 'perth' }), many, 'Australia/Perth'), undefined, 'same as the studio: nothing to say');
  assert.equal(zoneLabel('Australia/Perth'), 'Perth time');
});

test('inZone: 6pm in Sydney is 3pm in Perth, and the studio\'s own zone is put back afterwards', () => {
  const t = at('2026-10-14', '18:00').toISOString();
  const sydney = time(t);
  assert.equal(inZone('Australia/Perth', () => time(t)), '3:00pm');
  assert.equal(inZone(undefined, () => time(t)), sydney);
  assert.equal(time(t), sydney);
});

test('.ics: the location\'s name and address when there are several, the studio address otherwise', () => {
  const settings: StudioSettings = { ...defaultSettings(), address: '57 Vale St, Cooma NSW' };
  const s = session({ locationId: 'perth' });
  assert.match(decode(icsDataUrl(s, undefined, undefined, settings, placeOf(s, many))), /LOCATION:Perth\\, 1 Perth St/);
  assert.match(decode(icsDataUrl(s, undefined, undefined, settings, placeOf(s, one))), /LOCATION:57 Vale St\\, Cooma NSW/);
  assert.match(decode(icsDataUrl(s, undefined, undefined, settings)), /LOCATION:57 Vale St/);
  // the start time is an absolute instant, so it is right in any calendar whatever zone the class is shown in
  assert.match(decode(icsDataUrl(s, undefined, undefined, settings)), new RegExp('DTSTART:' + s.startsAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')));
});
