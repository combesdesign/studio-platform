// The live DataStore (src/data/supabase) against the real migrated test database.
//   Run by run.sh (needs PGHOST/PGPORT/PGUSER/PGDATABASE pointing at the test cluster, after fixtures).
//
// 1. Static audit: every .rpc('name', {args}), .from('table') column, storage bucket and edge function
//    the store uses is checked against pg_proc / information_schema / storage.buckets / supabase/functions.
// 2. Mapper coverage: every field in src/shared/types.ts comes out of the snake_case -> camelCase mappers.
// 3. Behaviour: the store is bundled with a fake supabase-js (fake-supabase.mjs) that runs its calls
//    as the signed-in user with RLS, like PostgREST, and the DataStore semantics are checked.
import { build } from 'esbuild';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');
const STORE_SRC = path.join(ROOT, 'src/data/supabase/index.ts');
const src = readFileSync(STORE_SRC, 'utf8');
let failed = 0;
const ok = (name) => console.log(`  ok - ${name}`);
async function t(name, fn) {
  try { await fn(); ok(name); } catch (e) { failed++; console.log(`  FAIL - ${name}\n    ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n    ')}`); }
}
function sql(q) {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.replace(/\n$/, '');
}
const sqlJson = (q) => JSON.parse(sql(q) || 'null');
const id = (name) => sql(`select id from test.ids where name = '${name}'`);

// ============================================================================ 1. static audit
console.log('\n-- static audit of src/data/supabase/index.ts against the database');

/** Split an object literal's text into its top-level keys. */
function topKeys(objText) {
  // key mode until a top-level ':' (then value mode until the next top-level ','), so ternaries don't count
  const keys = []; let depth = 0, token = '', quote = null, inValue = false;
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i];
    if (quote) { if (ch === quote && objText[i - 1] !== '\\') quote = null; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('({['.includes(ch)) { depth++; continue; }
    if (')}]'.includes(ch)) { depth--; continue; }
    if (depth !== 0) continue;
    if (ch === ',') { token = ''; inValue = false; continue; }
    if (inValue) continue;
    if (ch === ':') { const m = /([A-Za-z_]\w*)\s*$/.exec(token); if (m) keys.push(m[1]); token = ''; inValue = true; continue; }
    token += ch;
  }
  return keys;
}
/** Text of the balanced (...) or {...} starting at `start` (the opening char). */
function balanced(text, start) {
  const open = text[start], close = open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start + 1, i);
  }
  return '';
}

const procs = sqlJson(`select json_object_agg(proname, args) from (
  select p.proname, json_build_object('names', coalesce(p.proargnames[1:p.pronargs], '{}'), 'nargs', p.pronargs, 'ndefaults', p.pronargdefaults,
         'returns', format_type(p.prorettype, null)) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') x`);
const columns = sqlJson(`select json_object_agg(table_name, cols) from (
  select table_name, json_agg(column_name::text) cols from information_schema.columns where table_schema = 'public' group by table_name) x`);
const buckets = sqlJson(`select coalesce(json_agg(id), '[]') from storage.buckets`);
const execGrants = sqlJson(`select coalesce(json_agg(p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')`);

// methods of the class, so patchRow(['col', ...]) pairs can be matched to that method's tables
const methods = [];
{
  const re = /^ {2}(?:private |async |static )*(\w+)\s*\(/gm; let m; const starts = [];
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => methods.push({ name: s.name, body: src.slice(s.at, starts[i + 1]?.at ?? src.length) }));
}

await t('every .rpc() names a real function, with real argument names, and all required arguments', () => {
  const problems = [];
  const re = /\.rpc\(\s*'(\w+)'/g; let m; let n = 0;
  while ((m = re.exec(src))) {
    n++;
    const fn = m[1]; const p = procs[fn];
    if (!p) { problems.push(`${fn}: no such function`); continue; }
    const after = src.slice(m.index + m[0].length).trimStart();
    const keys = after.startsWith(',') ? topKeys(balanced(after, after.indexOf('{'))) : [];
    for (const k of keys) if (!p.names.includes(k)) problems.push(`${fn}: unknown argument ${k} (has ${p.names.join(', ')})`);
    const required = p.names.slice(0, p.nargs - p.ndefaults);
    for (const r of required) if (!keys.includes(r)) problems.push(`${fn}: missing required argument ${r}`);
    if (!execGrants.includes(fn)) problems.push(`${fn}: signed-in users can't execute it`);
  }
  assert.ok(n >= 25, `found only ${n} rpc calls`);
  assert.deepEqual(problems, []);
});

await t('every .from() table/view exists and every column the store selects, filters, orders or writes exists', () => {
  const problems = [];
  const re = /\.from\('(\w+)'\)/g; let m; let n = 0;
  while ((m = re.exec(src))) {
    n++;
    const table = m[1];
    if (src.slice(Math.max(0, m.index - 20), m.index).includes('storage')) continue;
    const cols = columns[table];
    if (!cols) { problems.push(`${table}: no such table or view`); continue; }
    // the chain: up to the end of the statement
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/;\s*\n|\)\);\s*\n|\),\s*\n\s*(?:this|'|`)/);
    const chain = rest.slice(0, end < 0 ? 400 : end + 2);
    for (const s of chain.matchAll(/\.select\('([^']*)'\)/g)) {
      for (const c of s[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if (c === '*') continue;
        const emb = /^(\w+)\(\*\)$/.exec(c);
        if (emb) { if (!columns[emb[1]]) problems.push(`${table}: embedded ${emb[1]} doesn't exist`); continue; }
        if (!cols.includes(c)) problems.push(`${table}.${c} (select)`);
      }
    }
    for (const f of chain.matchAll(/\.(?:eq|neq|lt|lte|gt|gte|ilike|in|is|not|order)\('(\w+)'/g)) if (!cols.includes(f[1])) problems.push(`${table}.${f[1]} (filter)`);
    for (const w of chain.matchAll(/\.(?:insert|upsert|update)\(\{/g)) {
      const keys = topKeys(balanced(chain, w.index + w[0].length - 1));
      for (const k of keys) if (!cols.includes(k)) problems.push(`${table}.${k} (write)`);
    }
  }
  // patchRow([['col', ...]]) / pairs.push(['col', ...]) inside a method go to that method's tables
  for (const meth of methods) {
    const tables = [...meth.body.matchAll(/\.from\('(\w+)'\)/g)].map((x) => x[1]).filter((x) => columns[x]);
    const pairs = [...meth.body.matchAll(/\[\s*'([a-z_]+)',/g)].map((x) => x[1]);
    for (const c of pairs) if (tables.length && !tables.some((tb) => columns[tb].includes(c))) problems.push(`${meth.name}: column ${c} not in ${tables.join('/')}`);
  }
  assert.ok(n >= 20, `found only ${n} from() calls`);
  assert.deepEqual(problems, []);
});

await t('storage bucket and edge functions the store calls exist (and read the body fields it sends)', () => {
  const problems = [];
  const bucket = /const AVATARS = '(\w+)'/.exec(src)?.[1];
  if (!bucket || !buckets.includes(bucket)) problems.push(`bucket ${bucket} missing`);
  for (const m of src.matchAll(/this\.invoke\('([\w-]+)',\s*\{/g)) {
    const fnDir = path.join(ROOT, 'supabase/functions', m[1]);
    if (!existsSync(path.join(fnDir, 'index.ts'))) { problems.push(`edge function ${m[1]} missing`); continue; }
    const fnSrc = readFileSync(path.join(fnDir, 'index.ts'), 'utf8');
    const keys = topKeys(balanced(src, m.index + m[0].length - 1));
    for (const k of keys) if (!new RegExp(`body\\.${k}\\b`).test(fnSrc)) problems.push(`${m[1]} never reads body.${k}`);
  }
  assert.deepEqual(problems, []);
});

// ============================================================================ bundle the store with the fake client
const out = mkdtempSync(path.join(process.env.SNOWY_WORK || tmpdir(), 'live-store-'));
await build({
  entryPoints: [STORE_SRC], bundle: true, format: 'esm', platform: 'node', outfile: path.join(out, 'store.mjs'), logLevel: 'error',
  plugins: [{ name: 'fake-supabase', setup(b) { b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: path.join(HERE, 'fake-supabase.mjs') })); } }],
});
const mod = await import(path.join(out, 'store.mjs'));
const fake = globalThis.__fake;

// ============================================================================ 2. mapper coverage
console.log('\n-- snake_case -> camelCase mappers cover every field in src/shared/types.ts');
const types = readFileSync(path.join(ROOT, 'src/shared/types.ts'), 'utf8');
function fieldsOf(name, seen = new Set()) {
  const m = new RegExp(`export interface ${name}(?: extends (\\w+))? \\{([\\s\\S]*?)\\n\\}`).exec(types);
  if (!m) throw new Error(`interface ${name} not found`);
  const own = [...m[2].matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]);
  return [...(m[1] && !seen.has(m[1]) ? fieldsOf(m[1], seen.add(m[1])) : []), ...own];
}
const sample = (table) => {
  const types2 = sqlJson(`select json_object_agg(column_name, udt_name) from information_schema.columns where table_schema = 'public' and table_name = '${table}'`);
  const row = {};
  for (const [c, ty] of Object.entries(types2)) {
    row[c] = ty.startsWith('_') ? ['00000000-0000-4000-8000-000000000001'] : ty === 'bool' ? true
      : /int|numeric/.test(ty) ? 2 : ty === 'timestamptz' ? '2026-10-19T08:00:00+11:00' : ty === 'date' ? '2026-10-19'
      : ty === 'time' ? '06:00:00' : ty === 'jsonb' ? { answers: { q: 'a' }, injuries: 'x', pregnantOrPostnatal: false, submittedAt: '2026-10-19T08:00:00+11:00' }
      : `${c}-value`;
  }
  return row;
};
const cover = [
  ['StudioSettings', () => mod.mappers.toSettings(sample('studio_settings'))],
  ['Staff', () => mod.mappers.toStaff(sample('staff'), 5000)],
  ['Client', () => mod.mappers.toClient({ ...sample('clients'), source: 'app' }, 'notes')],
  ['ClassType', () => mod.mappers.toClassType(sample('class_types'))],
  ['ScheduleTemplate', () => mod.mappers.toTemplate(sample('schedule_templates'))],
  ['SessionWithCounts', () => mod.mappers.toSession(sample('sessions_with_counts'))],
  ['Product', () => mod.mappers.toProduct({ ...sample('products'), kind: 'retail' }), ['credits', 'validityDays']],
  ['Product', () => mod.mappers.toProduct({ ...sample('products'), kind: 'pack' }), ['stock']],
  ['Pass', () => mod.mappers.toPass({ ...sample('passes'), adjustments: [{ at: '2026-10-19T08:00:00Z', staff_id: 's', delta: 1, reason: 'r' }] })],
  ['Booking', () => mod.mappers.toBooking(sample('bookings'))],
  ['Sale', () => mod.mappers.toSale({ ...sample('sales'), items: [{ product_id: 'p', name: 'n', qty: 1, unit_cents: 100 }] })],
];
for (const [iface, make, notApplicable = []] of cover) {
  await t(`${iface}: every field mapped${notApplicable.length ? ` (${notApplicable.join(', ')} n/a here)` : ''}`, () => {
    const outObj = make();
    const missing = fieldsOf(iface).filter((f) => !notApplicable.includes(f) && !(f in outObj));
    assert.deepEqual(missing, []);
  });
}

// ============================================================================ 3. behaviour
console.log('\n-- the live store against the database (RLS on, as each person)');
const URL_BASE = 'https://proj.supabase.co';
fake.now = '2026-10-19T08:00:00+11:00';
fake.invokeResult['create-checkout'] = { url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
function makeStore(app) {
  globalThis.location = { pathname: app === 'studio' ? '/studio/' : '/', hash: '', href: `https://app.example/${app === 'studio' ? 'studio/' : ''}`, search: '' };
  return mod.createSupabaseStore(URL_BASE, 'anon-key');
}
const code = async (p) => { try { await p; return 'OK'; } catch (e) { return e?.code ?? String(e); } };
const client = makeStore('client');
const studio = makeStore('studio');
const ALICE = id('alice_client'), BOB = id('bob_client'), ERIN = id('erin_client'), DAN = id('dan_client');
const S_EVE = id('s_eve'), S_CANCEL = id('s_cancel'), SCULPT = id('sculpt'), S_THU = id('s_thu');
const range = { from: '2026-10-18T13:00:00.000Z', to: '2026-10-26T13:00:00.000Z' };

await t('DataStore: every method in src/shared/store.ts is implemented', () => {
  const iface = readFileSync(path.join(ROOT, 'src/shared/store.ts'), 'utf8').split('export interface DataStore')[1].split('\nexport ')[0];
  const names = [...iface.matchAll(/^ {2}(\w+)(\?)?\(/gm)].filter((m) => !m[2] || ['registerInterest', 'moveBooking', 'startCheckout'].includes(m[1])).map((m) => m[1]);
  const missing = names.filter((n) => typeof client[n] !== 'function');
  assert.ok(names.length > 45);
  assert.deepEqual(missing, []);
  assert.equal(client.mode, 'live');
});

await t('sign-in: wrong password, staff on the client app and clients on the studio app are refused', async () => {
  assert.equal(await code(client.signIn('alice@example.test', 'wrong')), 'INVALID_LOGIN');
  assert.equal(await code(client.signIn('fran@example.test', 'pw')), 'NOT_ALLOWED');
  assert.equal(await code(studio.signIn('alice@example.test', 'pw')), 'NOT_ALLOWED');
  assert.equal(await client.currentUser(), null);
});

await t('studio: front desk signs in and cancels a class (credits back, studio-cancelled)', async () => {
  const u = await studio.signIn('fran@example.test', 'pw');
  assert.equal(u.kind, 'staff'); assert.equal(u.role, 'front_desk');
  await studio.cancelSession(S_CANCEL, 'Instructor unwell');
  assert.equal((await studio.getSession(S_CANCEL)).status, 'cancelled');
});

await t('client: signs in; settings, class types, staff (no emails) read fine', async () => {
  const u = await client.signIn('Alice@Example.test', 'pw');
  assert.deepEqual([u.kind, u.clientId], ['client', ALICE]);
  const s = await client.getSettings();
  assert.ok(s.cancellationPolicyText.startsWith('If you cancel'));
  assert.equal(s.cancelWindowHours, 3);
  const cts = await client.listClassTypes();
  assert.equal(cts.find((c) => c.name === 'Strength + Sculpt')?.bookable, false);
  const staff = await client.listStaff();
  assert.ok(staff.length >= 5 && staff.every((x) => x.email === '' && x.payPerClassCents === undefined));
});

await t('listSessions includes cancelled classes unless includeCancelled: false (DataStore contract)', async () => {
  const all = await client.listSessions(range);
  assert.ok(all.some((s) => s.id === S_CANCEL && s.status === 'cancelled'));
  const live = await client.listSessions({ ...range, includeCancelled: false });
  assert.ok(!live.some((s) => s.id === S_CANCEL));
  assert.ok(all.every((s, i) => i === 0 || s.startsAt >= all[i - 1].startsAt), 'ordered by startsAt');
});

let aliceBooking;
await t('book: counts, credit summary labels and booking details', async () => {
  const r = await client.bookClass(ALICE, S_EVE);
  aliceBooking = r.booking;
  assert.equal(r.outcome, 'booked');
  assert.equal(r.pass.creditsUsed, 1);
  assert.ok(r.pass.activatedAt && r.pass.expiresAt);
  const s = await client.getSession(S_EVE);
  assert.deepEqual([s.bookedCount, s.waitlistCount, s.spotsLeft], [1, 0, 13]);
  const cs = await client.getCreditSummary(ALICE);
  assert.equal(cs[0].label, '3 of 4 left'); assert.equal(cs[0].remaining, 3);
  assert.equal((await client.getCreditSummary(ALICE, S_THU))[0].label, '3 of 4 left');
  const [b] = await client.listClientBookings(ALICE, { when: 'upcoming' });
  assert.equal(b.classType.name, 'Mat Essentials'); assert.equal(b.instructor.name, 'Grace T'); assert.equal(b.session.bookedCount, 1);
  assert.equal(b.instructor.email, '');
  assert.equal((await client.listClientBookings(ALICE, { when: 'past' })).length, 0);
  assert.equal(await code(client.bookClass(ALICE, S_EVE)), 'ALREADY_BOOKED');
  assert.equal(await code(client.bookClass(ALICE, S_THU, { allowOverCapacity: true })), 'NOT_ALLOWED');
  const passes = await client.listPasses(ALICE);
  assert.equal(passes.length, 1); assert.equal(passes[0].kind, 'pack');
});

await t('client profile: photo upload goes to avatars/<clientId>/<timestamp>.jpg and the public URL is saved', async () => {
  const c = await client.getClient(ALICE);
  const saved = await client.upsertClient({ ...c, photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' });
  assert.match(saved.photoUrl, new RegExp(`^${URL_BASE}/storage/v1/object/public/avatars/${ALICE}/\\d{13}\\.jpg$`));
  assert.equal(sql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${ALICE}/%'`), '1');
  const again = await client.upsertClient({ ...saved, photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAg==' });
  assert.notEqual(again.photoUrl, saved.photoUrl);
  assert.equal(sql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${ALICE}/%'`), '1', 'old photo tidied away');
  const removed = await client.upsertClient({ ...again, photoUrl: undefined });
  assert.equal(removed.photoUrl, undefined, 'undefined removes the photo');
  assert.equal(sql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${ALICE}/%'`), '0');
});

await t('client profile: merges (absent fields kept) and can\'t touch waiver, health form, notes, source, archived, email', async () => {
  const c = await client.getClient(ALICE);
  await client.upsertClient({ ...c, phone: '0400 123 456', birthday: '1990-10-21' });
  const merged = await client.upsertClient({ id: ALICE, firstName: 'Alicia' });
  assert.deepEqual([merged.firstName, merged.phone, merged.birthday], ['Alicia', '0400 123 456', '1990-10-21']);
  const before = await client.getClient(ALICE);
  await client.upsertClient({ ...before, waiverSignedAt: undefined, healthForm: { answers: { x: 'y' }, submittedAt: 'x' }, staffNotes: 'VIP', source: 'import', archived: true });
  const after = await client.getClient(ALICE);
  assert.deepEqual([after.waiverSignedAt, after.healthForm, after.staffNotes, after.source, after.archived],
    [before.waiverSignedAt, before.healthForm, undefined, 'app', false]);
  assert.equal(sql(`select count(*) from public.client_notes where client_id = '${ALICE}'`), '0');
  assert.equal(await code(client.upsertClient({ ...before, id: BOB })), 'NOT_ALLOWED');
  assert.equal(await code(client.upsertClient({ ...after, firstName: '  ' })), 'INVALID');
  // A new email isn't an error: everything saves, a confirm link goes out, and the result says so.
  const changed = await client.upsertClient({ ...after, email: 'alice.new@example.test', phone: '0400 999 000' });
  assert.equal(changed.pendingEmail, 'alice.new@example.test');
  assert.equal(changed.phone, '0400 999 000');
  assert.equal(fake.userUpdates.at(-1).email, 'alice.new@example.test', 'email changes go through Supabase Auth');
  assert.equal(sql(`select email from public.clients where id = '${ALICE}'`), 'alice.new@example.test', 'then sync to the client record');
  assert.equal((await client.upsertClient({ id: ALICE, firstName: 'Alicia' })).pendingEmail, undefined, 'no flag when the email is unchanged');
  sql(`update auth.users set email = 'alice@example.test' where email = 'alice.new@example.test'`);
});

await t('client: register interest (repeatable, own only); staff-only lists refused', async () => {
  await client.registerInterest(ALICE, SCULPT);
  await client.registerInterest(ALICE, SCULPT);
  assert.equal(await code(client.registerInterest(BOB, SCULPT)), 'NOT_ALLOWED');
  assert.equal(await code(client.listClients()), 'NOT_ALLOWED');
  assert.equal(await code(client.getReport({ from: '2026-10-01', to: '2026-10-31' })), 'NOT_ALLOWED');
  const sales = await client.listSales({ from: '2026-10-01', to: '2026-10-31' });
  assert.ok(sales.length >= 1 && sales.every((s) => s.clientId === ALICE && s.items.length >= 1));
  assert.equal(await code(client.listSales({ from: '2026-10-01', to: '2026-10-31', clientId: BOB })), 'NOT_ALLOWED');
  assert.equal(await code(client.purchase({ productId: id('p_pack4'), method: 'card_online' })), 'NOT_ALLOWED');
  assert.deepEqual(await client.startCheckout({ clientId: ALICE, productId: id('p_pack4'), returnUrl: 'https://app.example/#/passes' }),
    { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
});

await t('client: cancel in time gives the credit back', async () => {
  const r = await client.cancelBooking(aliceBooking.id);
  assert.deepEqual([r.booking.status, r.creditReturned, r.lateCancel], ['cancelled', true, false]);
  assert.equal((await client.getCreditSummary(ALICE))[0].label, '4 of 4 left');
});

await t('client with no waiver: WAIVER_REQUIRED, then signs it in the app and it sticks', async () => {
  await client.signOut();
  await client.signIn('erin@example.test', 'pw');
  assert.equal(await code(client.bookClass(ERIN, S_EVE)), 'WAIVER_REQUIRED');
  const c = await client.submitWaiver(ERIN, { answers: { 'Any injuries?': 'Yes' }, injuries: 'Left knee', pregnantOrPostnatal: false });
  assert.ok(c.waiverSignedAt); assert.equal(c.injuries, 'Left knee'); assert.equal(c.healthForm.answers['Any injuries?'], 'Yes');
  assert.equal(await code(client.bookClass(ERIN, S_EVE)), 'NO_CREDITS');
  assert.equal(await code(client.submitWaiver(ALICE, { answers: {} })), 'NOT_FOUND');
  await client.signOut();
});

await t('sign-up: confirm-email step, then a client profile exists', async () => {
  assert.equal(await code(client.signUpClient({ firstName: 'Nora', lastName: 'New', email: 'nora@example.test', password: 'short' })), 'INVALID');
  assert.equal(await code(client.signUpClient({ firstName: 'Nora', lastName: 'New', email: 'nora@example.test', password: 'long enough' })), 'CONFIRM_EMAIL');
  assert.equal(sql(`select first_name from public.clients where email = 'nora@example.test'`), 'Nora');
  assert.equal(await code(client.signUpClient({ firstName: 'Nora', lastName: 'New', email: 'nora@example.test', password: 'long enough' })), 'EMAIL_TAKEN');
});

await t('roster: order, flags and staff notes (front desk)', async () => {
  await client.signIn('bob@example.test', 'pw');
  await client.bookClass(BOB, S_EVE);
  await client.signOut();
  await client.signIn('alice@example.test', 'pw');
  await client.bookClass(ALICE, S_EVE);
  const alice = await studio.getClient(ALICE);
  await studio.upsertClient({ ...alice, staffNotes: 'Paid cash, owes $10', injuries: 'Dodgy knee' });
  const roster = await studio.getRoster(S_EVE);
  assert.deepEqual(roster.map((e) => e.client.firstName), ['Alicia', 'Bob']);
  const a = roster[0];
  assert.equal(a.client.staffNotes, 'Paid cash, owes $10');
  assert.ok(a.flags.includes('first_class') && a.flags.includes('injury'));
  assert.ok(a.pass && a.pass.kind === 'pack');
  assert.ok(roster.some((e) => e.client.photoUrl === undefined));
  const ci = await studio.checkIn(a.id);
  assert.equal(ci.status, 'checked_in');
  assert.equal((await studio.undoCheckIn(a.id)).status, 'booked');
});

await t('instructor: own roster only, no staff notes, can\'t edit clients or write notes', async () => {
  const julia = makeStore('studio');
  await julia.signIn('julia@example.test', 'pw');
  assert.equal(await code(julia.getRoster(S_EVE)), 'NOT_ALLOWED');
  const list = await julia.listClients();
  assert.ok(list.length > 3 && list.every((c) => c.staffNotes === undefined));
  const alice = list.find((c) => c.id === ALICE);
  assert.equal(await code(julia.upsertClient({ ...alice, staffNotes: 'hmm' })), 'NOT_ALLOWED');
  assert.ok((await julia.listPasses(ALICE)).length >= 1, 'instructors see passes on a client profile');
  assert.equal(await code(julia.listSales({ from: '2026-10-01', to: '2026-10-31' })), 'NOT_ALLOWED');
  assert.equal(await code(julia.refundSale(sql(`select id from public.sales limit 1`))), 'NOT_ALLOWED');
  const rep = await julia.getReport({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(rep.revenueCents, 0);
  await julia.signOut();
});

const REPORT_KEYS = fieldsOf('StudioReport').sort();
await t('reports: shaped exactly like StudioReport; revenue by role; CSV exports by permission', async () => {
  const fr = await studio.getReport({ from: '2026-10-12', to: '2026-10-25' });
  assert.deepEqual(Object.keys(fr).sort(), REPORT_KEYS);
  assert.deepEqual([fr.revenueCents, fr.salesCount], [0, 0]);
  assert.equal(await code(studio.exportSalesCsv({ from: '2026-10-12', to: '2026-10-25' })), 'NOT_ALLOWED');
  assert.ok((await studio.exportClientsCsv()).startsWith('First name,Last name,Email'));
  const libby = makeStore('studio');
  await libby.signIn('libby@example.test', 'pw');
  const r = await libby.getReport({ from: '2026-10-12', to: '2026-10-25' });
  assert.deepEqual(Object.keys(r).sort(), REPORT_KEYS);
  assert.ok(r.revenueCents > 0 && r.salesCount > 0);
  assert.equal(Object.values(r.revenueByKind).reduce((a, b) => a + b, 0), r.revenueCents);
  assert.deepEqual(r.range, { from: '2026-10-12', to: '2026-10-25' });
  for (const x of r.byInstructor) assert.deepEqual(Object.keys(x).sort(), ['attendees', 'classes', 'name', 'payCents', 'staffId']);
  const csv = await libby.exportSalesCsv({ from: '2026-10-12', to: '2026-10-25' });
  assert.ok(csv.startsWith('Date,Time,Sale ID,Client') && csv.split('\r\n').length > 3);
  await libby.updateSettings({ abn: '12 345 678 901' });
  assert.equal((await libby.getSettings()).abn, '12 345 678 901');
  await libby.signOut();
});

await t('manager: sees pay rates, can\'t change them or GST; owner can', async () => {
  const mia = makeStore('studio');
  await mia.signIn('mia@example.test', 'pw');
  const julia = (await mia.listStaff()).find((s) => s.name === 'Julia');
  assert.equal(julia.payPerClassCents, 6000);
  assert.equal(await code(mia.upsertStaff({ ...julia, payPerClassCents: 7000 })), 'NOT_ALLOWED');
  const saved = await mia.upsertStaff({ ...julia, bio: 'Updated bio' });
  assert.deepEqual([saved.bio, saved.payPerClassCents], ['Updated bio', 6000]);
  assert.equal(await code(mia.updateSettings({ gstRegistered: false })), 'NOT_ALLOWED');
  assert.equal(await code(mia.upsertStaff({ ...julia, email: 'fran@example.test' })), 'EMAIL_TAKEN');
  await mia.signOut();
  const libby = makeStore('studio');
  await libby.signIn('libby@example.test', 'pw');
  assert.equal((await libby.upsertStaff({ ...julia, payPerClassCents: 6500 })).payPerClassCents, 6500);
  await libby.signOut();
});

await t('front desk: weekly timetable makes classes; edits move them; delete removes them', async () => {
  const gp = (await studio.listStaff()).find((s) => s.name === 'Grace P');
  assert.equal(gp.role, 'front_desk');
  const tpl = await studio.upsertTemplate({ classTypeId: id('mums'), weekday: 4, startTime: '10:30', instructorId: gp.id, startsOn: '2026-10-19', active: true });
  let mine = (await studio.listSessions({ from: range.from, to: '2026-11-09T13:00:00.000Z' })).filter((s) => s.templateId === tpl.id);
  assert.equal(mine.length, 3, 'three Thursdays');
  assert.equal(mine[0].instructorId, gp.id);
  await studio.upsertTemplate({ ...tpl, startTime: '11:00' });
  mine = (await studio.listSessions({ from: range.from, to: '2026-11-09T13:00:00.000Z' })).filter((s) => s.templateId === tpl.id);
  assert.ok(mine.length === 3 && mine.every((s) => s.startsAt.endsWith(':00:00.000Z') && new Date(s.startsAt).getUTCMinutes() === 0));
  assert.equal((await studio.listTemplates()).find((x) => x.id === tpl.id)?.startTime, '11:00');
  await studio.deleteTemplate(tpl.id);
  mine = (await studio.listSessions({ from: range.from, to: '2026-11-09T13:00:00.000Z' })).filter((s) => s.templateId === tpl.id);
  assert.equal(mine.length, 0);
  const ct = await studio.upsertClassType({ name: 'Reformer taster', description: '', durationMin: 45, color: '#5069AC', defaultCapacity: 8, bookable: false, active: true });
  assert.equal(ct.name, 'Reformer taster');
  assert.equal(await code(studio.upsertProduct({ kind: 'retail', name: 'Mat', description: '', priceCents: 5000, active: true, sortOrder: 1 })), 'NOT_ALLOWED');
});

await t('front desk: new clients (duplicate email refused), interest list, till sale and refund', async () => {
  assert.equal(await code(studio.upsertClient({ firstName: 'Copy', lastName: 'Cat', email: 'ALICE@example.test', marketingOptIn: false })), 'EMAIL_TAKEN');
  const w = await studio.upsertClient({ firstName: 'Wendy', lastName: 'Walkin', email: 'wendy@example.test', marketingOptIn: false, source: 'staff', photoUrl: 'data:image/jpeg;base64,/9j/AA==' });
  assert.deepEqual([w.source, w.marketingOptIn, w.waiverSignedAt], ['staff', false, undefined]);
  assert.match(w.photoUrl, new RegExp(`/avatars/${w.id}/\\d+\\.jpg$`));
  await studio.registerInterest(DAN, SCULPT);
  const interest = await studio.listClassInterest();
  assert.ok(interest.some((x) => x.clientId === ALICE) && interest.some((x) => x.clientId === DAN));
  const { sale } = await studio.checkoutCart({ clientId: w.id, items: [{ productId: id('p_socks'), qty: 2 }], method: 'cash' });
  assert.equal(sale.totalCents, 4000);
  const refunded = await studio.refundSale(sale.id, { amountCents: 2000, reason: 'wrong size' });
  assert.equal(refunded.refundedCents, 2000);
  const { pass } = await studio.purchase({ clientId: w.id, productId: id('p_single'), method: 'card_reader' });
  assert.equal(pass.kind, 'dropin');
  const booked = await studio.bookClass(w.id, S_THU);
  assert.equal(booked.outcome, 'booked');
  const roster = await studio.getRoster(S_THU);
  assert.ok(roster[0].flags.includes('no_waiver') && roster[0].flags.includes('last_credit'));
  const moved = await studio.moveBooking(booked.booking.id, id('s_fri'));
  assert.equal(moved.outcome, 'booked');
  const adj = await studio.adjustPass(pass.id, { creditsDelta: 1, reason: 'goodwill' });
  assert.equal(adj.credits, 2); assert.equal(adj.adjustments?.[0]?.reason, 'goodwill');
});

await t('memberships: pause / resume / cancel through the store (no Stripe call without a subscription)', async () => {
  const bobPass = (await studio.listPasses(BOB))[0];
  const paused = await studio.pausePass(bobPass.id, '2026-10-26', '2026-11-01');
  assert.deepEqual([paused.pausedFrom, paused.pausedUntil], ['2026-10-26', '2026-11-01']);
  assert.equal((await studio.resumePass(bobPass.id)).pausedFrom, undefined);
  const cancelled = await studio.cancelMembership(bobPass.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.nextBillingAt);
  assert.equal(fake.invoked.filter((x) => x.name === 'manage-membership').length, 0);
});

// ---------------------------------------------------------------- password links (reset + invite)
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function withPrompt(fn) {
  const calls = [];
  const had = { prompt: globalThis.prompt, alert: globalThis.alert };
  globalThis.prompt = (m) => { calls.push(m); return null; };
  globalThis.alert = () => {};
  return fn(calls).finally(() => { globalThis.prompt = had.prompt; globalThis.alert = had.alert; });
}
function linkStore(app, hash) {
  globalThis.location = { pathname: app === 'studio' ? '/studio/' : '/', hash, href: `https://app.example/${app === 'studio' ? 'studio/' : ''}${hash}`, search: '' };
  return mod.createSupabaseStore(URL_BASE, 'anon-key');
}

await t('password links: recovery goes to the app\'s screen (no prompt), and only once', () => withPrompt(async (prompts) => {
  const s = linkStore('client', '#access_token=x&expires_in=3600&refresh_token=y&token_type=bearer&type=recovery');
  const got = [];
  s.onPasswordRecovery((kind) => got.push(kind));
  s.sb.__fireAuth('PASSWORD_RECOVERY');
  await tick(5);
  assert.deepEqual(got, ['recovery']);
  s.sb.__fireAuth('SIGNED_IN'); // supabase-js re-fires this when the tab regains focus
  await tick(5);
  assert.deepEqual(got, ['recovery']);
  await tick(mod.PASSWORD_HANDLER_GRACE_MS + 50);
  assert.equal(prompts.length, 0, 'no window.prompt once a handler is registered');
}));

await t('password links: an invite link says "invite"; one that lands before the app registers is handed over', () => withPrompt(async (prompts) => {
  const s = linkStore('client', '#access_token=x&type=invite');
  s.sb.__fireAuth('SIGNED_IN');
  await tick(20);
  const got = [];
  const off = s.onPasswordRecovery((kind) => got.push(kind));
  await tick(5);
  assert.deepEqual(got, ['invite']);
  await tick(mod.PASSWORD_HANDLER_GRACE_MS + 50);
  assert.equal(prompts.length, 0);
  off();
  // A plain sign-in (no link in the address) never opens the screen.
  const plain = linkStore('client', '');
  const none = [];
  plain.onPasswordRecovery((kind) => none.push(kind));
  plain.sb.__fireAuth('SIGNED_IN');
  await tick(5);
  assert.deepEqual(none, []);
  assert.equal(mod.passwordLinkKind('#/timetable?type=recovery'), 'recovery');
  assert.equal(mod.passwordLinkKind('#access_token=x&type=signup'), null);
}));

await t('password links: with no screen registered, the prompt fallback still works', () => withPrompt(async (prompts) => {
  const s = linkStore('studio', '#access_token=x&type=recovery');
  s.sb.__fireAuth('PASSWORD_RECOVERY');
  await tick(mod.PASSWORD_HANDLER_GRACE_MS + 80);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /at least 8 characters/);
}));

await t('setNewPassword: at least 8 characters, then auth.updateUser; no session = LINK_EXPIRED', async () => {
  const s = linkStore('client', '');
  assert.equal(await code(s.setNewPassword('short')), 'INVALID');
  assert.equal(await code(s.setNewPassword('long enough')), 'LINK_EXPIRED');
  await s.signIn('alice@example.test', 'pw');
  const before = fake.userUpdates.length;
  assert.equal(await code(s.setNewPassword('a brand new one')), 'OK');
  assert.deepEqual(fake.userUpdates.slice(before).map((u) => u.password), ['a brand new one']);
  await s.signOut();
  globalThis.location = { pathname: '/', hash: '', href: 'https://app.example/', search: '' };
});

console.log(failed ? `\n  ${failed} live store check(s) FAILED` : '\n  live store: all checks passed');
process.exit(failed ? 1 : 0);
