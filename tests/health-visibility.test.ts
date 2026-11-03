// Settings > Policies > "Who can see health notes": the demo store hides injuries and health forms (and the roster flags) per the setting.
// The default is owner, managers and the instructor of a class the client is booked into. (SQL: supabase/tests/health_notes_visibility.sql.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, asClient, baseState, harness, mkClient, mkSession, OWNER, JULIA, rejects } from './helpers';
import { canSeeHealthNotes, healthVisibility } from '../src/domain';
import type { AuthUser } from '../src/shared/types';

const NOW = at('2026-10-12', '08:00');
const DESK: AuthUser = { kind: 'staff', staffId: 'st_gracep', email: 'grace.p@snowypilatesclub.com', name: 'Grace P', role: 'front_desk' };

function state() {
  return baseState({
    clients: [mkClient('amy', 'Amy', { injuries: 'Bad knee', healthForm: { answers: { Pregnant: 'No' }, injuries: 'Bad knee', submittedAt: '2026-10-01T00:00:00.000Z' } }), mkClient('ben', 'Ben', { injuries: 'Shoulder' })],
    sessions: [mkSession('wed18', '2026-10-14', '18:00')],   // Julia teaches
  });
}

test('the rule: owner and managers always; instructors only for their own class under the default', () => {
  assert.equal(healthVisibility(undefined), 'class_instructor');
  assert.equal(canSeeHealthNotes('owner_manager', 'owner', false), true);
  assert.equal(canSeeHealthNotes('owner_manager', 'manager', false), true);
  assert.equal(canSeeHealthNotes('owner_manager', 'instructor', true), false);
  assert.equal(canSeeHealthNotes('class_instructor', 'instructor', true), true);
  assert.equal(canSeeHealthNotes('class_instructor', 'instructor', false), false);
  assert.equal(canSeeHealthNotes('class_instructor', 'front_desk', false), false);
  assert.equal(canSeeHealthNotes('all_staff', 'front_desk', false), true);
});

test('default: an instructor can not read health notes for a client who is not in one of their classes', async () => {
  const h = await harness(state(), NOW);
  await h.give('amy', 'pr_p4');
  await h.store.bookClass('amy', 'wed18');
  await h.as(JULIA);
  assert.equal((await h.store.getClient('amy')).injuries, 'Bad knee', 'Amy is booked into Julia\'s class');
  assert.equal((await h.store.getClient('ben')).injuries, undefined, 'Ben is not');
  assert.equal((await h.store.getClient('ben')).healthForm, undefined);
  const list = await h.store.listClients();
  assert.deepEqual(list.map((c) => [c.firstName, c.injuries]), [['Amy', 'Bad knee'], ['Ben', undefined]]);
  const roster = await h.store.getRoster('wed18');
  assert.ok(roster[0]!.flags.includes('injury'));
  await h.as(DESK);
  assert.equal((await h.store.getClient('amy')).injuries, undefined, 'front desk sees none');
  assert.equal((await h.store.getRoster('wed18'))[0]!.flags.includes('injury'), false);
  assert.equal((await h.store.getRoster('wed18'))[0]!.client.injuries, undefined);
  await h.as(OWNER);
  assert.equal((await h.store.getClient('ben')).injuries, 'Shoulder');
  await h.as(asClient('ben'));
  assert.equal((await h.store.getClient('ben')).injuries, 'Shoulder', 'clients read their own');
});

test('all staff and owner-and-managers-only', async () => {
  const h = await harness(state(), NOW);
  await h.store.updateSettings({ healthNotesVisibility: 'all_staff' });
  await h.as(DESK);
  assert.equal((await h.store.getClient('ben')).injuries, 'Shoulder');
  await h.as(OWNER);
  await h.store.updateSettings({ healthNotesVisibility: 'owner_manager' });
  await h.give('amy', 'pr_p4');
  await h.store.bookClass('amy', 'wed18');
  await h.as(JULIA);
  assert.equal((await h.store.getClient('amy')).injuries, undefined, 'even her own class\'s client');
  await h.as(OWNER);
  await rejects(h.store.updateSettings({ healthNotesVisibility: 'everyone' as never }), 'INVALID');
});

test('staff who can not read the notes can not wipe them by saving the client', async () => {
  const h = await harness(state(), NOW);
  await h.as(DESK);
  const ben = await h.store.getClient('ben');
  await h.store.upsertClient({ ...ben, phone: '0400 000 000', injuries: '' });
  await h.as(OWNER);
  const after = await h.store.getClient('ben');
  assert.deepEqual([after.phone, after.injuries], ['0400 000 000', 'Shoulder']);
});
