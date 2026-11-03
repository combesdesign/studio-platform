// "Delete my account": the demo store does what the live function does, only the right people can start it, and the legal pages fill in
// the studio's details. (The database and edge function are tested in supabase/tests/account_deletion.sql and functions.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, asClient, baseState, harness, mkClient, mkSession, OWNER, JULIA, rejects } from './helpers';
import { can } from '../src/domain';
import { customLegalDoc, privacyPolicy, termsOfUse } from '../src/shared/legal';
import { GOES_TO } from '../src/features/marketing/goesTo';

const NOW = at('2026-10-12', '08:00');

function state() {
  return baseState({
    clients: [
      mkClient('sarah', 'Sarah', { phone: '0400 000 000', birthday: '1988-02-03', injuries: 'Bad back', staffNotes: 'Pays late', photoUrl: 'data:image/jpeg;base64,xx', emergencyContactName: 'Ben' }),
      mkClient('mia', 'Mia', { guardianClientId: 'sarah', email: '', injuries: 'Asthma' }),
      mkClient('tom', 'Tom', { phone: '0411 111 111' }),
    ],
    staff: [...baseState().staff, { id: 'st_mgr', name: 'Mia M', email: 'm@example.com', role: 'manager', active: true }],
    sessions: [mkSession('wed18', '2026-10-14', '18:00'), mkSession('fri06', '2026-10-16', '06:00', { capacity: 1 })],
  });
}

test('a client deletes their own account: details gone, rows kept, classes and passes cancelled, signed out', async () => {
  const h = await harness(state(), NOW);
  const pack = await h.give('sarah', 'pr_p4');
  await h.as(asClient('sarah'));
  await h.store.bookClass('sarah', 'wed18');
  const salesBefore = (await h.store.listSales({ from: '2000-01-01', to: '2030-01-01' })).length;
  await h.store.deleteMyAccount();

  await h.as(OWNER);
  const s = await h.store.getClient('sarah');
  assert.deepEqual([s.firstName, s.lastName, s.email], ['Deleted', 'client', '']);
  for (const k of ['phone', 'birthday', 'injuries', 'staffNotes', 'photoUrl', 'emergencyContactName'] as const) assert.equal(s[k], undefined, k);
  assert.equal(s.archived, true);
  assert.ok(s.deletedAt);
  const mia = await h.store.getClient('mia');
  assert.deepEqual([mia.firstName, mia.injuries], ['Deleted', undefined], 'dependants go too');
  assert.equal((await h.store.getClient('tom')).phone, '0411 111 111', 'other clients are untouched');
  const bookings = await h.store.listClientBookings('sarah', { when: 'upcoming' });
  assert.equal(bookings.filter((b) => b.status === 'booked').length, 0, 'upcoming classes cancelled');
  assert.equal((await h.store.listPasses('sarah', { includeInactive: true })).find((p) => p.id === pack)?.status, 'cancelled', 'passes cancelled');
  assert.equal((await h.store.listSales({ from: '2000-01-01', to: '2030-01-01' })).length, salesBefore, 'sales stay for the records');
  await h.store.deleteClientAccount('sarah');   // repeating is fine
  assert.equal((await h.store.getClient('sarah')).firstName, 'Deleted');
});

test('after deleting, the client is signed out and cannot sign back in', async () => {
  const h = await harness(state(), NOW);
  await h.as(asClient('tom'));
  await h.store.deleteMyAccount();
  assert.equal(await h.store.currentUser(), null);
  await rejects(h.store.signIn('tom@example.com', 'x'), 'INVALID_LOGIN');
});

test('only the person or the studio owner can delete: not other clients, not a dependant\'s own screen, not instructors or managers', async () => {
  const h = await harness(state(), NOW);
  await h.as(asClient('tom'));
  await rejects(h.store.deleteClientAccount('sarah'), 'NOT_ALLOWED');
  await h.as(asClient('mia'));
  await rejects(h.store.deleteMyAccount(), 'NOT_ALLOWED');
  await h.as(JULIA);
  await rejects(h.store.deleteClientAccount('sarah'), 'NOT_ALLOWED');
  await h.as({ kind: 'staff', staffId: 'st_mgr', email: 'm@example.com', name: 'Mia M', role: 'manager' });
  await rejects(h.store.deleteClientAccount('sarah'), 'NOT_ALLOWED');
  await h.as({ kind: 'staff', staffId: 'st_gracep', email: 'grace.p@snowypilatesclub.com', name: 'Grace P', role: 'front_desk' });
  await rejects(h.store.deleteClientAccount('sarah'), 'NOT_ALLOWED');
  assert.equal((await h.store.getClient('sarah')).firstName, 'Sarah', 'nothing changed');
  await h.as(OWNER);
  await h.store.deleteClientAccount('sarah');
  assert.equal((await h.store.getClient('sarah')).firstName, 'Deleted');
  assert.equal(can('owner', 'client_delete'), true);
  assert.equal(can('manager', 'client_delete'), false);
  assert.equal(can('front_desk', 'client_delete'), false);
});

test('privacy policy and terms fill in the studio and cover what the stores ask about', () => {
  const ctx = { studioName: 'Snowy Pilates Club', abn: '12 345 678 901', abnLabel: 'ABN', email: 'hello@snowy.test', phone: '02 1234 5678', address: '57 Vale Street, Cooma NSW 2630' };
  const text = JSON.stringify(privacyPolicy(ctx));
  for (const must of ['Snowy Pilates Club', 'ABN 12 345 678 901', 'hello@snowy.test', '57 Vale Street', 'health', 'sensitive information', 'Stripe', 'Resend', 'Supabase', 'Anthropic', 'Twilio', 'Sydney',
    'five years', 'Delete my account', 'OAIC', '1300 363 992', 'correct']) assert.ok(text.includes(must), `privacy mentions ${must}`);
  const terms = JSON.stringify(termsOfUse(ctx));
  assert.ok(terms.includes('Snowy Pilates Club') && terms.includes('Australian Consumer Law'));
  assert.ok(!JSON.stringify(privacyPolicy({ ...ctx, abn: undefined })).includes('undefined'), 'no ABN is fine');
});

test('a studio\'s own text replaces the template: blank lines are paragraphs, "# " starts a heading', () => {
  const d = customLegalDoc('Privacy policy', '# What we keep\nNames and emails.\n\nAnd bookings.\n\n# Contact\nSay hi.');
  assert.deepEqual(d.sections.map((s) => s.heading), ['What we keep', 'Contact']);
  assert.deepEqual(d.sections[0]!.paragraphs, ['Names and emails.', 'And bookings.']);
});

test('the "Goes to" picker stores the same values the field always did', () => {
  assert.deepEqual(GOES_TO.map((g) => g.label), ['App home', 'Timetable', 'Passes']);
  assert.equal(GOES_TO[0]!.value, '{{app_url}}');
  for (const g of GOES_TO) assert.match(g.value, /^\{\{\s*app_url\s*\}\}/, 'still accepted by the server check');
});
