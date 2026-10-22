// Xero export: the exact CSV columns, GST per line, payment methods, account codes from settings, balanced journals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCOUNTING, INVOICE_HEADER, JOURNAL_HEADER, normaliseAccounting, xeroDate, xeroManualJournalCsv, xeroSalesInvoicesCsv } from '../src/features/integrations/xero';
import type { Sale } from '../src/shared/types';

const ctx = { studioName: 'Snowy Pilates Club', currency: 'AUD', taxRate: 0.1, taxRegistered: true };
const sale = (over: Partial<Sale> & Pick<Sale, 'id' | 'totalCents' | 'method' | 'items'>): Sale => ({ createdAt: '2026-10-19T23:30:00.000Z', ...over }); // 10:30am Tue 20 Oct in Sydney
const sales: Sale[] = [
  sale({ id: 'sl_aaaa1111', clientId: 'c1', totalCents: 11000, method: 'card_online', items: [{ name: '4 class pack', qty: 1, unitCents: 11000 }] }),
  sale({ id: 'sl_bbbb2222', totalCents: 6000, method: 'cash', items: [{ name: 'Grip socks', qty: 2, unitCents: 3000 }], note: 'Walk-in' }),
  sale({ id: 'sl_cccc3333', clientId: 'c1', totalCents: 10000, method: 'card_reader', items: [{ name: '4 class pack', qty: 1, unitCents: 11000 }] }), // promo took $10 off
  sale({ id: 'sl_dddd4444', totalCents: 3300, method: 'card_reader', items: [{ name: 'Water bottle', qty: 1, unitCents: 3300 }], refundedCents: 3300, refundedAt: '2026-10-21T01:00:00.000Z' }),
  sale({ id: 'sl_eeee5555', totalCents: 0, method: 'comp', items: [{ name: 'Free class', qty: 1, unitCents: 0 }] }),
];
const rows = (csv: string) => csv.split('\r\n').filter(Boolean).map((l) => l.split(','));

test('Xero CSVs: sales invoice and manual journal formats, GST, payment methods and account codes', () => {
  assert.equal(xeroDate('2026-10-05'), '05/10/2026');
  const a = normaliseAccounting({ salesAccount: ' 210 ', cashAccount: '1-1010', junk: 'x', gstAccount: 42 });
  assert.equal(a.salesAccount, '210'); assert.equal(a.cashAccount, '1-1010'); assert.equal(a.gstAccount, DEFAULT_ACCOUNTING.gstAccount, 'anything that isn\'t text falls back to the default');

  // ---- sales invoices: one row per item, GST-exclusive unit amounts with the GST on its own column
  const inv = xeroSalesInvoicesCsv(sales, a, ctx, [{ id: 'c1', firstName: 'Alice', lastName: 'Brown', email: 'alice@example.com' }]);
  const r = rows(inv.csv);
  assert.deepEqual(r[0], INVOICE_HEADER);
  assert.equal(INVOICE_HEADER[0], '*ContactName'); assert.equal(INVOICE_HEADER.length, 28);
  const col = (name: string) => INVOICE_HEADER.indexOf(name);
  assert.equal(r.length - 1, 4, 'pack, socks, pack, and the promo discount line');
  const pack = r[1]!;
  assert.equal(pack[col('*ContactName')], 'Alice Brown'); assert.equal(pack[col('EmailAddress')], 'alice@example.com');
  assert.equal(pack[col('*InvoiceNumber')], 'POS-AAAA1111'); assert.equal(pack[col('Reference')], 'Card (online)');
  assert.equal(pack[col('*InvoiceDate')], '20/10/2026', 'the studio\'s date, not UTC'); assert.equal(pack[col('*DueDate')], '20/10/2026');
  assert.equal(pack[col('*Description')], '4 class pack'); assert.equal(pack[col('*Quantity')], '1');
  assert.equal(pack[col('*UnitAmount')], '100'); assert.equal(pack[col('TaxAmount')], '10.00');
  assert.equal(pack[col('*AccountCode')], '210'); assert.equal(pack[col('*TaxType')], 'GST on Income'); assert.equal(pack[col('Currency')], 'AUD');
  const socks = r[2]!;
  assert.equal(socks[col('*ContactName')], 'Walk-in customers'); assert.equal(socks[col('Reference')], 'Cash: Walk-in');
  assert.equal(socks[col('*Quantity')], '2'); assert.equal(socks[col('*UnitAmount')], '27.275'); assert.equal(socks[col('TaxAmount')], '5.45');
  const discount = r[4]!;
  assert.equal(discount[col('*Description')], 'Discount'); assert.equal(discount[col('*InvoiceNumber')], 'POS-CCCC3333');
  assert.equal(discount[col('*UnitAmount')], '-9.09'); assert.equal(discount[col('TaxAmount')], '-0.91'); assert.equal(discount[col('Reference')], 'Card (reader)');
  assert.equal(inv.sales, 3); assert.equal(inv.grossCents, 11000 + 6000 + 10000);
  assert.deepEqual(inv.skipped.map((s) => s.saleId), ['sl_dddd4444', 'sl_eeee5555'], 'a refunded sale and a complimentary one are left out');
  assert.equal(xeroSalesInvoicesCsv(sales, a, { ...ctx, taxRegistered: false }).gstCents, 0);
  assert.match(xeroSalesInvoicesCsv(sales, a, { ...ctx, taxRegistered: false }).csv.split('\r\n')[1]!, /,BAS Excluded,0\.00,/, 'no GST when the studio isn\'t registered');

  // ---- manual journals: a balanced journal per day and payment method; refunds on the day they were made
  const j = xeroManualJournalCsv(sales, a, ctx);
  const jr = rows(j.csv);
  assert.deepEqual(jr[0], JOURNAL_HEADER);
  const body = jr.slice(1);
  const byNarration = new Map<string, number>();
  for (const l of body) byNarration.set(l[0]!, Math.round((byNarration.get(l[0]!) ?? 0) * 100 + Number(l[5]) * 100) / 100);
  assert.ok([...byNarration.values()].every((n) => n === 0), 'every journal balances to zero');
  const online = body.filter((l) => l[0] === 'Snowy Pilates Club takings 2026-10-20 (Card (online))'.replace(/,/g, ''));
  assert.deepEqual(online.map((l) => [l[1], l[3], l[4], l[5]]), [['20/10/2026', '091', 'BAS Excluded', '110.00'], ['20/10/2026', '210', 'BAS Excluded', '-100.00'], ['20/10/2026', '820', 'BAS Excluded', '-10.00']],
    'money in to the card account, Sales net, GST collected');
  assert.deepEqual(body.filter((l) => l[0]!.includes('(Cash)')).map((l) => l[3]), ['1-1010', '210', '820'], 'cash goes to the cash account code from settings');
  const refundDay = body.filter((l) => l[0]!.includes('2026-10-21'));
  assert.deepEqual(refundDay.map((l) => l[5]), ['-33.00', '30.00', '3.00'], 'the refund comes off on 21 Oct: money out, Sales and GST back');
  assert.equal(j.sales, 4); assert.equal(j.gstCents, 1000 + 545 + 909 + 300 - 300);
});
