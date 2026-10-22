/**
 * Xero export: pure functions that turn the studio's sales into Xero's import CSVs.
 *
 *   Sales invoices      (Xero: Business > Invoices > Sales > Import). One row per sale item, with the GST on that line,
 *                       an account code and a tax type. The payment method goes in Reference. This is the one that feeds the BAS.
 *   Manual journals     (Xero: Accounting > Advanced > Manual journals > Import). One balanced journal per day and payment method:
 *                       debit the payment account, credit Sales, credit the GST account. Takings summary for bookkeepers who
 *                       reconcile the payment accounts.
 *
 * Account codes come from the studio's settings (Settings > Xero export). Money in sales is GST-inclusive; the tax part is
 * worked out per sale at the studio's rate, like the receipts and the sales report. Dates are DD/MM/YYYY, Xero's Australian format.
 */
import { toCsv } from '../../domain/report';
import { studioDate, taxOf } from '../../shared/format';
import type { Cents, ISODate, PaymentMethod, Sale } from '../../shared/types';

export interface AccountingSettings {
  /** Income account for class passes and retail. Xero's default "Sales" is 200. */
  salesAccount: string;
  /** GST collected (liability) account, for journals. Xero's default "GST" is 820. */
  gstAccount: string;
  /** Where the money lands, by payment method: clearing or bank accounts in the studio's chart of accounts. */
  cardOnlineAccount: string;
  cardReaderAccount: string;
  cashAccount: string;
  /** Invoice lines when the studio is registered for GST. */
  taxType: string;
  /** Invoice lines when it isn't, and every journal line. */
  noTaxType: string;
  /** Put in front of the invoice number: POS-1A2B3C4D. */
  invoicePrefix: string;
}

export const DEFAULT_ACCOUNTING: AccountingSettings = {
  salesAccount: '200', gstAccount: '820', cardOnlineAccount: '091', cardReaderAccount: '092', cashAccount: '090',
  taxType: 'GST on Income', noTaxType: 'BAS Excluded', invoicePrefix: 'POS-',
};

export const ACCOUNTING_KEYS = Object.keys(DEFAULT_ACCOUNTING) as (keyof AccountingSettings)[];

/** Fill in defaults, trim, drop anything that isn't ours or isn't text. */
export function normaliseAccounting(raw: Partial<Record<string, unknown>> | null | undefined): AccountingSettings {
  const out = { ...DEFAULT_ACCOUNTING };
  for (const k of ACCOUNTING_KEYS) { const v = raw?.[k]; if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 60); }
  return out;
}

export interface XeroContext {
  studioName: string;
  currency: string;
  /** 0.1 = 10% GST, included in sale totals. */
  taxRate: number;
  taxRegistered: boolean;
  /** Name for a sale with no client attached. */
  walkInName?: string;
}

export interface XeroClient { id: string; firstName: string; lastName: string; email?: string }

const EXPORTED: PaymentMethod[] = ['card_online', 'card_reader', 'cash'];
export const METHOD_LABEL: Record<PaymentMethod, string> = {
  card_online: 'Card (online)', card_reader: 'Card (reader)', cash: 'Cash', comp: 'Complimentary', imported: 'Imported',
};

const dollars = (c: Cents) => (c / 100).toFixed(2);
/** '2026-10-19' -> '19/10/2026' */
export const xeroDate = (d: ISODate): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const trim4 = (n: number) => String(Math.round(n * 10000) / 10000);

function accountFor(method: PaymentMethod, a: AccountingSettings): string | null {
  return method === 'card_online' ? a.cardOnlineAccount : method === 'card_reader' ? a.cardReaderAccount : method === 'cash' ? a.cashAccount : null;
}

export interface XeroResult {
  csv: string;
  /** Rows after the header. */
  rows: number;
  /** Sales that made it into the file. */
  sales: number;
  /** Money in the file: GST-inclusive total and the GST part. */
  grossCents: Cents;
  gstCents: Cents;
  /** Sales left out, and why (shown to the person exporting). */
  skipped: { saleId: string; reason: string }[];
}

// ---------------------------------------------------------------- manual journals
export const JOURNAL_HEADER = ['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2'];

/** One balanced journal per studio day and payment method (refunds are taken off on the day they were made). */
export function xeroManualJournalCsv(sales: readonly Sale[], a: AccountingSettings, ctx: XeroContext): XeroResult {
  const skipped: XeroResult['skipped'] = [];
  const groups = new Map<string, { date: ISODate; method: PaymentMethod; gross: Cents; gst: Cents }>();
  let grossCents = 0, gstCents = 0, counted = 0;
  const add = (date: ISODate, method: PaymentMethod, gross: Cents) => {
    const gst = ctx.taxRegistered ? taxOf(gross, ctx.taxRate) : 0;
    const k = `${date}|${method}`;
    const g = groups.get(k) ?? { date, method, gross: 0, gst: 0 };
    g.gross += gross; g.gst += gst; groups.set(k, g);
    grossCents += gross; gstCents += gst;
  };
  for (const s of sales) {
    if (!EXPORTED.includes(s.method)) { skipped.push({ saleId: s.id, reason: `${METHOD_LABEL[s.method]} sales aren't takings` }); continue; }
    if (s.totalCents <= 0) { skipped.push({ saleId: s.id, reason: 'No money was taken' }); continue; }
    add(studioDate(s.createdAt), s.method, s.totalCents);
    if ((s.refundedCents ?? 0) > 0) add(studioDate(s.refundedAt ?? s.createdAt), s.method, -(s.refundedCents ?? 0));
    counted++;
  }
  const rows: unknown[][] = [JOURNAL_HEADER];
  const ordered = [...groups.values()].sort((x, y) => x.date.localeCompare(y.date) || x.method.localeCompare(y.method));
  for (const g of ordered) {
    if (g.gross === 0) continue;
    const narration = `${ctx.studioName} takings ${g.date} (${METHOD_LABEL[g.method]})`;
    const line = (desc: string, account: string, cents: Cents) => rows.push([narration, xeroDate(g.date), desc, account, a.noTaxType, dollars(cents), '', '', '', '']);
    line(`${METHOD_LABEL[g.method]} received`, accountFor(g.method, a)!, g.gross);
    line('Sales', a.salesAccount, -(g.gross - g.gst));
    if (g.gst !== 0) line('GST collected', a.gstAccount, -g.gst);
  }
  return { csv: toCsv(rows), rows: rows.length - 1, sales: counted, grossCents, gstCents, skipped };
}

// ---------------------------------------------------------------- sales invoices
export const INVOICE_HEADER = [
  '*ContactName', 'EmailAddress', 'POAddressLine1', 'POAddressLine2', 'POAddressLine3', 'POAddressLine4', 'POCity', 'PORegion', 'POPostalCode', 'POCountry',
  '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate', 'InventoryItemCode', '*Description', '*Quantity', '*UnitAmount', 'Discount', '*AccountCode', '*TaxType', 'TaxAmount',
  'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2', 'Currency', 'BrandingTheme',
];

/** One invoice per sale (paid at the time, so the due date is the sale date). Refunded sales are left out: make a credit note in Xero. */
export function xeroSalesInvoicesCsv(sales: readonly Sale[], a: AccountingSettings, ctx: XeroContext, clients: readonly XeroClient[] = []): XeroResult {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const skipped: XeroResult['skipped'] = [];
  const rows: unknown[][] = [INVOICE_HEADER];
  let grossCents = 0, gstCents = 0, counted = 0;
  const taxType = ctx.taxRegistered ? a.taxType : a.noTaxType;
  for (const s of [...sales].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    if (!EXPORTED.includes(s.method)) { skipped.push({ saleId: s.id, reason: `${METHOD_LABEL[s.method]} sales aren't takings` }); continue; }
    if (s.totalCents <= 0) { skipped.push({ saleId: s.id, reason: 'No money was taken' }); continue; }
    if ((s.refundedCents ?? 0) > 0) { skipped.push({ saleId: s.id, reason: 'Refunded: make a credit note in Xero' }); continue; }
    const c = s.clientId ? byId.get(s.clientId) : undefined;
    const contact = c ? `${c.firstName} ${c.lastName}`.trim() || 'Client' : ctx.walkInName ?? 'Walk-in customers';
    const date = xeroDate(studioDate(s.createdAt));
    const number = `${a.invoicePrefix}${s.id.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()}`;
    const reference = `${METHOD_LABEL[s.method]}${s.note ? `: ${s.note}` : ''}`.slice(0, 255);
    // Lines are GST-inclusive; anything between the items and the total is a discount (promo code, gift card, credit).
    const lines = s.items.map((i) => ({ name: i.name, qty: Math.max(1, i.qty), gross: Math.max(1, i.qty) * i.unitCents }));
    const diff = s.totalCents - lines.reduce((n, l) => n + l.gross, 0);
    if (diff !== 0) lines.push({ name: diff < 0 ? 'Discount' : 'Adjustment', qty: 1, gross: diff });
    for (const l of lines) {
      const tax = ctx.taxRegistered ? taxOf(l.gross, ctx.taxRate) : 0;
      const net = l.gross - tax;
      rows.push([
        contact, c?.email ?? '', '', '', '', '', '', '', '', '',
        number, reference, date, date, '', l.name, l.qty, trim4(net / 100 / l.qty), '', a.salesAccount, taxType, dollars(tax),
        '', '', '', '', ctx.currency, '',
      ]);
      gstCents += tax;
    }
    grossCents += s.totalCents; counted++;
  }
  return { csv: toCsv(rows), rows: rows.length - 1, sales: counted, grossCents, gstCents, skipped };
}
