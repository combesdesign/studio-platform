// The Momence converter, run on a small FAKE export in tests/fixtures/momence (made-up people, the exact real layout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport, convert, editDistance, normName, parseCsv, parseMomenceDate, passKey, productFromFilename, renderReport, reportCounts, SNOWY_PRODUCTS, sydneyDate, toCsv,
  CLIENT_COLUMNS, PASS_COLUMNS,
} from '../scripts/momence-lib';

const DIR = new URL('./fixtures/momence/', import.meta.url).pathname;
const files = () => readdirSync(DIR).filter((f) => f.endsWith('.csv')).map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));
const conv = () => convert(files());
const client = (c: ReturnType<typeof conv>, email: string) => c.clients.find((x) => x.email === email)!;
const passesOf = (c: ReturnType<typeof conv>, email: string) => c.passes.filter((p) => p.email === email);

test('Momence dates: "December 18th 2025, 8:40 AM" and ISO timestamps (UTC -> Sydney calendar day)', () => {
  assert.equal(parseMomenceDate('December 18th 2025, 8:40 AM'), '2025-12-18');
  assert.equal(parseMomenceDate('January 1st 2026, 12:00 AM'), '2026-01-01');
  assert.equal(parseMomenceDate('March 22nd 2026, 11:59 PM'), '2026-03-22');
  assert.equal(parseMomenceDate('June 3rd 2026, 6:00 PM'), '2026-06-03');
  assert.equal(parseMomenceDate(''), '');
  assert.equal(parseMomenceDate('not a date'), '');
  assert.equal(sydneyDate('2026-11-03T19:30:00.000Z'), '2026-11-04');   // 6:30am next morning in Sydney (AEDT)
  assert.equal(sydneyDate('2026-07-03T13:30:00.000Z'), '2026-07-03');   // winter: AEST, +10
  assert.equal(sydneyDate('2026-07-03T14:30:00.000Z'), '2026-07-04');
  assert.equal(sydneyDate(''), '');
  assert.equal(sydneyDate('junk'), '');
});

test('filenames: product comes from the name (underscores are spaces, " - " kept), case and punctuation ignored', () => {
  assert.equal(productFromFilename('8b91726a-ribbon-active-members-2_Classes_Per_Week_-_Membership.csv'), '2 Classes Per Week - Membership');
  assert.equal(productFromFilename('d38fc147-Momence-Customers.csv'), null);
  assert.equal(normName('INTRO OFFER - 2 WEEKS UNLIMITED'), normName('Intro offer, 2 weeks unlimited'));
  assert.equal(normName('2 Classes Per Week - Membership'), normName('2 Classes Per Week Membership'));
});

test('CSV: quotes, commas inside quotes, BOM and CRLF both ways', () => {
  const rows = parseCsv('﻿"A","B"\r\n"x, y","say ""hi"""\r\n\r\n"",z\r\n');
  assert.deepEqual(rows, [{ A: 'x, y', B: 'say "hi"' }, { A: '', B: 'z' }]);
  assert.equal(toCsv(['A', 'B'], [{ A: 'x, y', B: 'say "hi"' }]), 'A,B\r\n"x, y","say ""hi"""\r\n');
});

test('clients: names trimmed, emails lower-cased, join date parsed, one row per email', () => {
  const c = conv();
  assert.equal(c.stats.customerRows, 12);
  const h = client(c, 'hannah.hill@example.test');
  assert.deepEqual([h.first_name, h.last_name, h.phone, h.joined_on], ['Hannah', 'Hill', '+61411000111', '2025-12-18']);
  assert.equal(c.clients.filter((x) => x.email === 'noah@example.test').length, 1);   // NOAH@ was a repeat
  assert.equal(client(c, 'pat.poe@example.test').last_name, 'Poe, Jr');
  assert.ok(c.clients.every((x) => x.email === x.email.toLowerCase() && x.first_name === x.first_name.trim()));
  assert.equal(client(c, 'hannah.hill@example.test').marketing_opt_in, '', 'no opt-in info in Momence, so nobody is opted in');
});

test('memberships: product from the filename, weekly credits, next billing date kept as the Sydney calendar day', () => {
  const c = conv();
  const [m] = passesOf(c, 'hannah.hill@example.test');
  assert.deepEqual({ ...m, momence_id: '' }, { email: 'hannah.hill@example.test', pass_name: '2 Classes Per Week Membership', kind: 'membership', credits_total: '2', credits_left: '', expires_on: '', paid_until: '2026-11-10', momence_id: '' });
  assert.match(m!.momence_id, /^mom-[0-9a-f]{16}$/);
  assert.equal(passesOf(c, 'mia@example.test').find((p) => p.credits_total === '1')!.paid_until, '2026-11-04');
  assert.equal(passesOf(c, 'noah@example.test')[0]!.pass_name, '3 Classes Per Week Membership');
});

test('intro offer: expiry date kept; blank means not started; either way marked as already had the intro offer', () => {
  const c = conv();
  const started = passesOf(c, 'jack.jones@gmail.test')[0]!;
  assert.deepEqual([started.kind, started.pass_name, started.expires_on, started.paid_until], ['intro', 'Intro offer, 2 weeks unlimited', '2026-11-09', '']);
  assert.equal(passesOf(c, 'ivy.irwin@example.test')[0]!.expires_on, '');
  assert.equal(c.stats.introBlankExpiry, 1);
  for (const e of ['jack.jones@gmail.test', 'ivy.irwin@example.test']) assert.equal(client(c, e).has_purchased_before, 'yes');
  assert.equal(client(c, 'noah@example.test').has_purchased_before, '');
});

test('members missing from the customers file still become clients (and are reported)', () => {
  const c = conv();
  assert.deepEqual(c.missingFromCustomers, ['ruby.reid@example.test']);
  assert.equal(client(c, 'ruby.reid@example.test').first_name, 'Ruby');
  assert.equal(passesOf(c, 'ruby.reid@example.test').length, 1);
});

test('pass ids are stable and per person per product, with no personal details in them', () => {
  assert.equal(passKey('a@x.test', '2 Classes Per Week - Membership'), passKey('a@x.test', '2 classes per week membership'));
  assert.notEqual(passKey('a@x.test', 'Unlimited Membership'), passKey('b@x.test', 'Unlimited Membership'));
  const c = conv();
  assert.equal(new Set(c.passes.map((p) => p.momence_id)).size, c.passes.length);
  assert.equal(c.passes.length, 9);
});

test('a members file that matches no product stops everything with a clear list', () => {
  const bad = [...files(), { name: 'zz-ribbon-active-members-Mystery_Pass_-_Special.csv', text: '"First Name","Last Name","Email","Paid","Exp. / Remaining"\n' },
    { name: 'zz-ribbon-active-members-Online_Membership.csv', text: '"First Name","Last Name","Email","Paid","Exp. / Remaining"\n' }];
  assert.throws(() => convert(bad), (e: Error) => /Mystery Pass - Special/.test(e.message) && /Online Membership/.test(e.message) && /Products I know/.test(e.message) && /--ignore/.test(e.message));
  assert.equal(convert(bad, { ignore: ['mystery', 'online'] }).passes.length, 9, '--ignore leaves a file out on purpose');
  assert.throws(() => convert(files().filter((f) => !/Customers/.test(f.name))), /customers file/);
});

test('every product the converter knows is in RULES.md', () => {
  const rules = normName(readFileSync(new URL('../RULES.md', import.meta.url), 'utf8'));
  for (const p of SNOWY_PRODUCTS) assert.ok(rules.includes(normName(p.name)), p.name);
});

test('tidy-up report: duplicates, typos, two memberships, missing members, owner accounts, made-up emails', () => {
  const c = conv();
  const r = buildReport(c, { studioDomain: 'studio.test', today: '2026-10-27' });
  assert.deepEqual(r.sameNameDifferentEmail.map((x) => x.name).sort(), ['Jack Jones', 'Kim Knight']);
  const typos = r.likelyTypoPairs.map((x) => [x.a, x.b].sort().join(' | '));
  assert.ok(typos.includes('jack.jones@gmail.test | jack.jones@gmqil.test'));
  assert.ok(typos.includes('kim.knight@bigoond.test | kim.knight@bigpond.test'));
  assert.equal(r.likelyTypoPairs.length, 2);
  assert.deepEqual(r.twoMemberships.map((x) => [x.email, x.products.length]), [['mia@example.test', 2]]);
  assert.deepEqual(r.missingFromCustomers.map((x) => x.email), ['ruby.reid@example.test']);
  assert.deepEqual(r.studioAccounts.map((x) => x.email), ['olive@studio.test']);
  assert.deepEqual(r.placeholderEmails.map((x) => x.email), ['1a2b3c4d5e@autogenerated.momence.com']);
  assert.deepEqual(r.duplicateRowsInCustomers, ['noah@example.test']);
  assert.deepEqual(r.billingDatePassed.map((x) => x.date), ['2026-10-20']);
  assert.equal(r.noPhone, 4);   // Ivy, Kim (bigoond), Lena, Ruby (not in the customers file)
  assert.equal(reportCounts(r).twoMemberships, 1);
  const text = renderReport(r, c);
  assert.match(text, /## On two memberships at once \(1\)/);
  assert.match(text, /## Members missing from the customers file \(1\)/);
});

test('a domain a letter off a common one is flagged even without a twin', () => {
  const c = conv();
  const r = buildReport(c);
  assert.deepEqual(r.likelyDomainTypos, [], 'the fixture\'s .test domains are not near a real provider');
  const lone = convert([{ name: 'x-Momence-Customers.csv', text: '"First Name","Last Name","Email","Phone Number","First Seen","Last Seen"\n"A","B","ab.cd@gmqil.com","",,\n"C","D","cd.ef@bigoond.com","",,\n"E","F","ef@gmail.com","",,\n' }]);
  assert.deepEqual(buildReport(lone).likelyDomainTypos, [{ email: 'ab.cd@gmqil.com', looksLike: 'gmail.com' }, { email: 'cd.ef@bigoond.com', looksLike: 'bigpond.com' }]);
  assert.equal(editDistance('gmail', 'gmqil'), 1);
});

test('command line: writes both staging CSVs in the layout the SQL expects, and the report, and prints counts only', () => {
  const out = mkdtempSync(join(tmpdir(), 'momence-test-'));
  const log = execFileSync('node', ['--import', 'tsx', 'scripts/momence-convert.mts', DIR, '--out', out, '--report', '--studio-domain', 'studio.test'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.match(log, /Tidy-up items: .*twoMemberships 1/);
  assert.ok(!/@/.test(log), 'the log never prints an email address');
  const clients = readFileSync(join(out, 'momence_clients.csv'), 'utf8').split('\r\n');
  const passes = readFileSync(join(out, 'momence_passes.csv'), 'utf8').split('\r\n');
  assert.equal(clients[0], CLIENT_COLUMNS.join(','));
  assert.equal(passes[0], PASS_COLUMNS.join(','));
  assert.equal(parseCsv(clients.join('\n')).length, 12);
  assert.equal(parseCsv(passes.join('\n')).length, 9);
  assert.ok(readFileSync(join(out, 'tidy-up-report.md'), 'utf8').startsWith('# Momence import'));
  assert.throws(() => execFileSync('node', ['--import', 'tsx', 'scripts/momence-convert.mts', out], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' }), /./);
});
