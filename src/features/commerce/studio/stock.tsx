/** Studio › Shop › Retail stock: counts, adjustments with reasons, SKUs/barcodes, low-stock levels and a stock report. */
import React, { useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { addDays, money, studioDate } from '../../../shared/format';
import { Empty, Icon, Loading, Seg, SheetHead, cx, downloadText, useStudio } from '../../../studio/ui';
import { STOCK_STATUS_LABEL, STOCK_STATUS_TONE, dmTime, needCommerce } from '../api';
import { STOCK_REASON_LABEL } from '../logic';
import type { RetailItem, StockReason } from '../types';
import { Kpi, Tone } from './bits';

type Range = '7' | '30' | '90';

export function StockTab() {
  const items = useData(() => needCommerce().listRetail(), []);
  const log = useData(() => needCommerce().stockLog({ limit: 25 }), []);
  const [adjust, setAdjust] = useState<RetailItem | null>(null);
  const [edit, setEdit] = useState<RetailItem | null>(null);
  const [range, setRange] = useState<Range>('30');
  const today = studioDate();
  const from = addDays(today, -Number(range) + 1);
  const report = useData(() => needCommerce().stockReport({ from, to: today }), [from, today]);
  const list = items.data ?? [];
  const low = list.filter((i) => i.status === 'low' || i.status === 'out');

  const csv = () => {
    const r = report.data;
    if (!r) return;
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Product', 'SKU', 'On hand', 'Value', 'Sold', 'Received', 'Written off', 'Status'].map(q).join(',')]
      .concat(r.rows.map((x) => [x.name, x.sku ?? '', x.onHand ?? '', (x.valueCents / 100).toFixed(2), x.sold, x.received, x.writtenOff, STOCK_STATUS_LABEL[x.status]].map(q).join(',')));
    downloadText(`stock-${r.from}-to-${r.to}.csv`, rows.join('\n'));
  };

  if (items.error && !items.data) return <Empty title="That didn’t load">{items.error.message}</Empty>;
  if (!items.data) return <Loading />;
  return (
    <>
      {low.length > 0 && (
        <div className="note cm-note warn">
          <Icon name="alert" size={18} />
          <span><strong>{low.length} item{low.length === 1 ? '' : 's'} running low:</strong> {low.map((i) => `${i.name} (${i.stock ?? 0} left)`).join(', ')}.</span>
        </div>
      )}
      <section className="card cm-list">
        <div className="cm-stock-head"><span>Product</span><span>SKU / barcode</span><span>On hand</span><span /></div>
        {list.length === 0 ? <div className="pad"><Empty title="No retail products">Add retail products in Settings › Products &amp; pricing.</Empty></div> : list.map((i) => (
          <div key={i.productId} className={cx('cm-stock', !i.active && 'quiet')}>
            <span className="cm-row-main"><strong>{i.name}</strong><span>{money(i.priceCents)}{!i.active ? ' · not on sale' : ''} · low at {i.lowAt}</span></span>
            <span className="cm-row-main cm-skus"><span>{i.sku ?? <span className="faint">No SKU</span>}</span><span className="faint">{i.barcode ?? 'No barcode'}</span></span>
            <span className="cm-onhand"><strong className="serif">{i.stock ?? '–'}</strong><Tone tone={STOCK_STATUS_TONE[i.status]}>{STOCK_STATUS_LABEL[i.status]}</Tone></span>
            <span className="cm-actions">
              <button className="btn sm soft" onClick={() => setAdjust(i)}>Adjust</button>
              <button className="btn sm ghost" onClick={() => setEdit(i)} aria-label={`Edit ${i.name}`}><Icon name="edit" size={16} />Edit</button>
            </span>
          </div>
        ))}
      </section>

      <section className="cm-report">
        <div className="sec-head">
          <h2>Stock <em>report</em></h2>
          <Seg value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
          <button className="btn sm soft" onClick={csv} disabled={!report.data}><Icon name="download" size={16} />CSV</button>
        </div>
        {!report.data ? <Loading /> : (
          <>
            <div className="cm-kpis">
              <Kpi tone="hero" label="Units on hand" value={report.data.totals.units} sub={`${report.data.totals.low} low · ${report.data.totals.out} out`} />
              <Kpi label="Stock value" value={money(report.data.totals.valueCents)} sub="At sale price" />
              <Kpi label="Sold" value={report.data.totals.sold} sub={`Last ${range} days`} />
              <Kpi tone="mist" label="Written off" value={report.data.rows.reduce((n, r) => n + r.writtenOff, 0)} sub="Damaged or lost" />
            </div>
            <div className="card pad table-wrap">
              <table className="tbl">
                <thead><tr><th>Product</th><th className="num">On hand</th><th className="num">Sold</th><th className="num">Received</th><th className="num">Written off</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {report.data.rows.map((r) => (
                    <tr key={r.productId}><td>{r.name}{r.sku ? <span className="faint"> · {r.sku}</span> : null}</td><td className="num">{r.onHand ?? '–'}</td><td className="num">{r.sold}</td><td className="num">{r.received}</td><td className="num">{r.writtenOff}</td><td className="num">{money(r.valueCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="card pad">
        <h3 className="cm-h3">Recent <em>changes</em></h3>
        {!log.data ? <Loading /> : log.data.length === 0 ? <p className="muted">No stock changes yet.</p> : (
          <div className="cm-ledger">
            {log.data.map((l) => (
              <div key={l.id} className="cm-led">
                <span className="cm-led-t"><strong>{l.productName} · {STOCK_REASON_LABEL[l.reason]}</strong><span>{l.before} → {l.after}{l.note ? ` · ${l.note}` : ''}{l.staffName ? ` · ${l.staffName}` : ''}</span></span>
                <span className="faint">{dmTime(l.at)}</span>
                <span className={cx('cm-led-amt', l.delta < 0 && 'neg')}>{l.delta > 0 ? '+' : '−'}{Math.abs(l.delta)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <Sheet open={!!adjust} onClose={() => setAdjust(null)} label="Adjust stock">{adjust && <AdjustSheet item={adjust} onClose={() => setAdjust(null)} />}</Sheet>
      <Sheet open={!!edit} onClose={() => setEdit(null)} label="Edit product stock details">{edit && <EditSheet item={edit} onClose={() => setEdit(null)} />}</Sheet>
    </>
  );
}

const REASONS: { value: StockReason; label: string; dir: 'in' | 'out' | 'any' }[] = [
  { value: 'received', label: 'Stock received', dir: 'in' }, { value: 'returned', label: 'Customer return', dir: 'in' },
  { value: 'damaged', label: 'Damaged', dir: 'out' }, { value: 'lost', label: 'Lost or stolen', dir: 'out' }, { value: 'other', label: 'Other', dir: 'any' },
];

function AdjustSheet({ item, onClose }: { item: RetailItem; onClose: () => void }) {
  const { busy, run } = useAction();
  const [mode, setMode] = useState<'in' | 'out' | 'count'>(item.stock == null ? 'count' : 'in');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<StockReason>('received');
  const [note, setNote] = useState('');
  const n = Math.floor(Number(qty) || 0);
  const after = mode === 'count' ? n : (item.stock ?? 0) + (mode === 'in' ? n : -n);
  const reasons = REASONS.filter((r) => r.dir === 'any' || r.dir === mode);
  const pickMode = (m: 'in' | 'out' | 'count') => { setMode(m); setReason(m === 'in' ? 'received' : m === 'out' ? 'damaged' : 'count'); };
  const save = async () => {
    const r = await run(() => needCommerce().adjustStock({
      productId: item.productId, reason: mode === 'count' ? 'count' : reason, ...(mode === 'count' ? { setTo: n } : { delta: mode === 'in' ? n : -n }), ...(note.trim() ? { note: note.trim() } : {}),
    }), 'Stock updated');
    if (r) onClose();
  };
  const valid = mode === 'count' ? qty.trim() !== '' && n >= 0 && n !== item.stock : n > 0 && after >= 0;
  return (
    <>
      <SheetHead title={<>Adjust <em>{item.name}</em></>} sub={item.stock == null ? 'Stock isn’t counted yet. Do a stocktake to start tracking it.' : `${item.stock} on hand now.`} onClose={onClose} />
      <div className="stack lg">
        <Seg value={mode} onChange={pickMode} options={[...(item.stock != null ? [{ value: 'in' as const, label: 'Add stock' }, { value: 'out' as const, label: 'Remove stock' }] : []), { value: 'count' as const, label: 'Stocktake' }]} />
        <div className="form-grid">
          <label className="field"><span>{mode === 'count' ? 'Counted on the shelf' : mode === 'in' ? 'How many to add' : 'How many to remove'}</span><input className="input" inputMode="numeric" autoFocus value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="0" /></label>
          {mode !== 'count' ? (
            <label className="field"><span>Reason</span><select className="select" value={reason} onChange={(e) => setReason(e.target.value as StockReason)}>{reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
          ) : <div className="field"><span>Reason</span><div className="input cm-static">Stocktake</div></div>}
          <label className="field span2"><span>Note (optional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'in' ? 'e.g. Delivery from supplier' : 'e.g. Found a tear'} /></label>
        </div>
        {(qty.trim() !== '') && <p className={cx('cm-after', after < 0 && 'danger-text')}>{after < 0 ? `There are only ${item.stock} in stock.` : <>New count: <strong>{after}</strong>{item.stock != null ? ` (was ${item.stock})` : ''}</>}</p>}
        <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !valid} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      </div>
    </>
  );
}

function EditSheet({ item, onClose }: { item: RetailItem; onClose: () => void }) {
  const { busy, run } = useAction();
  const { can } = useStudio();
  const [sku, setSku] = useState(item.sku ?? '');
  const [barcode, setBarcode] = useState(item.barcode ?? '');
  const [low, setLow] = useState(item.lowStockAt != null ? String(item.lowStockAt) : '');
  const save = async () => {
    const r = await run(() => needCommerce().updateRetail(item.productId, { sku: sku.trim() || null, barcode: barcode.trim() || null, lowStockAt: low.trim() ? Math.floor(Number(low)) : null }), 'Saved');
    if (r) onClose();
  };
  return (
    <>
      <SheetHead title={<>{item.name}</>} sub="Scan the barcode into the box below, or type it. The till finds products by barcode or SKU." onClose={onClose} />
      <div className="stack lg">
        <div className="form-grid">
          <label className="field"><span>SKU</span><input className="input cm-upper" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="GRIP-SOCK" maxLength={40} /></label>
          <label className="field"><span>Barcode</span><input className="input" inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="9300000000000" maxLength={40} /></label>
          <label className="field span2"><span>Low-stock alert at (blank = studio default)</span><input className="input" inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value.replace(/\D/g, ''))} placeholder={String(item.lowAt)} /></label>
        </div>
        {can('products') && <p className="muted small">Change the name or price in <a className="linkish" href="#/settings/products">Settings › Products &amp; pricing</a>.</p>}
        <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      </div>
    </>
  );
}
