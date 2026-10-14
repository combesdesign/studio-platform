import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studioToUTC, studioDate, weekStart, money } from '../src/shared/format';
test('format helpers', () => {
  assert.equal(studioToUTC('2026-10-14', '06:00'), '2026-10-13T19:00:00.000Z'); // AEDT +11
  assert.equal(studioToUTC('2026-06-14', '06:00'), '2026-06-13T20:00:00.000Z'); // AEST +10
  assert.equal(studioDate(new Date('2026-10-13T19:00:00Z')), '2026-10-14');
  assert.equal(weekStart('2026-10-18'), '2026-10-12');
  assert.equal(money(4000), '$40');
});
