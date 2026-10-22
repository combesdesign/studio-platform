// Custom domains (admin): tidy the typed domain, plain-words reasons it can't be added, DNS steps for sub-domain vs root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DOMAINS, dnsSteps, domainOwners, domainProblem, isApex, normaliseDomain } from '../src/admin/domains';

const ctx = { platformDomain: 'studioplatform.app', existing: ['book.snowy.com.au'], takenBy: { 'book.harbour.com.au': 'Harbour Reformer' } };

test('normaliseDomain strips protocol, path, port, case and trailing dot', () => {
  assert.equal(normaliseDomain('  https://Book.Example.com:443/classes?x=1 '), 'book.example.com');
  assert.equal(normaliseDomain('Book.Example.com.'), 'book.example.com');
  assert.equal(normaliseDomain('user@book.example.com'), 'book.example.com');
});

test('domainProblem: accepts a good one, explains the rest', () => {
  assert.equal(domainProblem('book.newstudio.com.au', ctx), '');
  assert.match(domainProblem('', ctx), /Type a domain/);
  assert.match(domainProblem('localhost', ctx), /full domain/);
  assert.match(domainProblem('10.0.0.1', ctx), /IP address/);
  assert.match(domainProblem('not a domain.com', ctx), /not a valid/);
  assert.match(domainProblem('-bad.example.com', ctx), /not a valid/);
  assert.match(domainProblem('harbour.studioplatform.app', ctx), /platform's own domain/);
  assert.match(domainProblem('book.snowy.com.au', ctx), /already has/);
  assert.match(domainProblem('book.harbour.com.au', ctx), /already linked to Harbour Reformer/);
  const full = { ...ctx, existing: Array.from({ length: MAX_DOMAINS }, (_, i) => `d${i}.example.com`) };
  assert.match(domainProblem('one.more.com', full), /up to 10/);
});

test('domainOwners leaves out the studio being edited', () => {
  const m = domainOwners([{ id: 'a', name: 'A', customDomains: ['A.com'] }, { id: 'b', name: 'B', customDomains: ['b.com'] }, { id: 'c', name: 'C' }], 'a');
  assert.deepEqual(m, { 'b.com': 'B' });
});

test('dnsSteps: CNAME for a sub-domain, ALIAS for a root domain, Netlify and Supabase notes', () => {
  const sub = dnsSteps('book.snowy.com.au', 'snowy', 'studioplatform.app');
  assert.deepEqual(sub[0]?.record, { type: 'CNAME', name: 'book', value: 'snowy.studioplatform.app' });
  assert.ok(sub.some((s) => /Netlify/.test(s.title) && /domain alias/i.test(s.body)));
  assert.ok(sub.some((s) => /Supabase/.test(s.title) && /Redirect URLs/.test(s.body)));
  assert.equal(isApex('snowy.com.au'), true);
  assert.equal(isApex('example.com'), true);
  assert.equal(isApex('book.snowy.com.au'), false);
  assert.equal(dnsSteps('snowy.com.au', 'snowy', 'studioplatform.app')[0]?.record?.type, 'ALIAS / ANAME');
});
