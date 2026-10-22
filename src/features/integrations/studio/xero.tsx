/**
 * Settings › Xero export: account codes, and a sales export in Xero's import formats (sales invoices or manual journals).
 * The CSV is built in the browser from the studio's sales (xero.ts), so it works the same on demo and live.
 */
import React, { useEffect, useState } from 'react';
import { money, studioDate } from '../../../shared/format';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { downloadText, Seg } from '../../../studio/ui';
import { ACCOUNTING_KEYS, DEFAULT_ACCOUNTING, xeroManualJournalCsv, xeroSalesInvoicesCsv, type AccountingSettings, type XeroResult } from '../xero';

type Format = 'invoices' | 'journal';
const FIELD: Record<keyof AccountingSettings, { label: string; hint: string }> = {
  salesAccount: { label: 'Sales account', hint: 'Income account code for passes and retail' },
  gstAccount: { label: 'GST account', hint: 'GST collected, used in journals' },
  cardOnlineAccount: { label: 'Card (online) account', hint: 'Where Stripe payouts land, e.g. a clearing account' },
  cardReaderAccount: { label: 'Card (reader) account', hint: 'Where card machine takings land' },
  cashAccount: { label: 'Cash account', hint: 'Cash takings' },
  taxType: { label: 'Tax type on invoice lines', hint: 'e.g. GST on Income' },
  noTaxType: { label: 'Tax rate for journal lines', hint: 'e.g. BAS Excluded (journals post GST on its own line)' },
  invoicePrefix: { label: 'Invoice number prefix', hint: 'POS- gives POS-1A2B3C4D' },
};

export function XeroTab() {
  const toast = useToast();
  const api = store.features.integrations;
  const cur = useData(async () => (api ? api.getAccounting() : DEFAULT_ACCOUNTING), []);
  const studio = useData(() => store.getStudio(), []);
  const [form, setForm] = useState<AccountingSettings>(DEFAULT_ACCOUNTING);
  const [busy, setBusy] = useState(false);
  const today = studioDate();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [format, setFormat] = useState<Format>('invoices');
  const [result, setResult] = useState<XeroResult | null>(null);
  useEffect(() => { if (cur.data) setForm(cur.data); }, [cur.data]);
  if (!api) return null;
  const dirty = cur.data && ACCOUNTING_KEYS.some((k) => form[k] !== cur.data![k]);

  const save = async () => {
    setBusy(true);
    try { await api.saveAccounting(form); toast('Xero settings saved'); cur.reload(); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  const exportNow = async () => {
    if (!studio.data) return;
    setBusy(true); setResult(null);
    try {
      if (dirty) await api.saveAccounting(form);
      const [sales, clients] = await Promise.all([store.listSales({ from, to }), store.listClients({ includeArchived: true })]);
      const st = studio.data;
      const ctx = { studioName: st.name, currency: st.currency, taxRate: st.taxRate, taxRegistered: st.taxRegistered };
      const r = format === 'invoices' ? xeroSalesInvoicesCsv(sales, form, ctx, clients) : xeroManualJournalCsv(sales, form, ctx);
      setResult(r);
      if (r.rows > 0) downloadText(`xero-${format === 'invoices' ? 'sales-invoices' : 'manual-journals'}-${from}-to-${to}.csv`, r.csv);
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <section className="card pad ig-card">
        <h3>Xero <em>export</em></h3>
        <p className="muted">Download your sales as a file Xero can import. Choose the dates and the format, then import it in Xero. Cash and card sales are included; complimentary and imported sales are left out.</p>
        <div className="ig-try">
          <label className="field"><span>From</span><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>To</span><input className="input" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <Seg<Format> value={format} onChange={setFormat} options={[{ value: 'invoices', label: 'Sales invoices' }, { value: 'journal', label: 'Manual journals' }]} />
        <p className="muted ig-note">
          {format === 'invoices'
            ? 'One invoice per sale, with GST on every line and the payment method in Reference. Best for your BAS. Refunded sales are left out: make a credit note in Xero.'
            : 'One journal per day and payment method: money in, Sales, and GST on its own line. Refunds come off on the day they were made. Best for reconciling payouts.'}
        </p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy || !studio.data || from > to} onClick={exportNow}>Download CSV</button>
        </div>
        {result && (
          <div className="note ig-result" role="status">
            {result.rows === 0 ? 'No sales in those dates.' : <>Exported {result.sales} {result.sales === 1 ? 'sale' : 'sales'} ({result.rows} rows): {money(result.grossCents)} including {money(result.gstCents)} GST.</>}
            {result.skipped.length > 0 && <> Left out: {result.skipped.length} ({[...new Set(result.skipped.map((s) => s.reason))].join('; ')}).</>}
          </div>
        )}
      </section>

      <section className="card pad ig-card">
        <h3>Account <em>codes</em></h3>
        <p className="muted">These need to match your Xero chart of accounts. The starting values are Xero's usual codes for Australia; change them if your accountant set yours up differently.</p>
        <div className="ig-fields">
          {ACCOUNTING_KEYS.map((k) => (
            <label className="field" key={k}><span>{FIELD[k].label}</span>
              <input className="input" value={form[k]} maxLength={60} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              <small className="muted">{FIELD[k].hint}</small>
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy || !dirty} onClick={save}>Save codes</button>
          <button className="btn" disabled={busy} onClick={() => setForm(DEFAULT_ACCOUNTING)}>Use Xero's usual codes</button>
        </div>
      </section>
    </>
  );
}
