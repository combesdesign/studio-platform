import React, { useState } from 'react';
import { store, useAction, useData } from '../shared/react';
import { addDays, money, studioDate, weekStart } from '../shared/format';
import type { ReportRange } from '../shared/types';
import { Avatar, Icon, Loading, PageHead, Seg, cx, downloadText, useStudio } from './ui';
import { METHOD_LABEL } from './clients';

type Preset = 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';
const monthStart = (d: string) => d.slice(0, 8) + '01';
const monthEnd = (d: string) => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10); };
function rangeFor(p: Preset, custom: ReportRange): ReportRange {
  const t = studioDate();
  if (p === 'this_week') return { from: weekStart(t), to: addDays(weekStart(t), 6) };
  if (p === 'last_week') return { from: addDays(weekStart(t), -7), to: addDays(weekStart(t), -1) };
  if (p === 'this_month') return { from: monthStart(t), to: monthEnd(t) };
  if (p === 'last_month') { const prev = addDays(monthStart(t), -1); return { from: monthStart(prev), to: prev }; }
  return custom;
}
const fmtD = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const KIND: Record<string, string> = { membership: 'Memberships', pack: 'Class packs', intro: 'Intro offer', dropin: 'Drop-ins', retail: 'Retail' };

export function Reports() {
  const { can, staffById } = useStudio();
  const [preset, setPreset] = useState<Preset>('this_month');
  const t = studioDate();
  const [custom, setCustom] = useState<ReportRange>({ from: addDays(t, -29), to: t });
  const range = rangeFor(preset, custom);
  const rep = useData(() => store.getReport(range), [range.from, range.to]);
  const { busy, run } = useAction();
  const r = rep.data;
  const showPay = can('pay');

  const exportSales = () => run(async () => downloadText(`snowy-sales-${range.from}-to-${range.to}.csv`, await store.exportSalesCsv(range)), 'Sales CSV downloaded');
  const exportClients = () => run(async () => downloadText(`snowy-clients-${t}.csv`, await store.exportClientsCsv()), 'Clients CSV downloaded');

  const revKinds = r ? Object.entries(r.revenueByKind).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => ({ label: KIND[k] ?? k, value: v ?? 0 })).sort((a, b) => b.value - a.value) : [];
  const methods = r ? Object.entries(r.revenueByMethod).filter(([, v]) => (v ?? 0) > 0) : [];

  return (
    <div className="reports">
      <PageHead eyebrow={`${fmtD(range.from)} – ${fmtD(range.to)}`} title={<>How it's <em>going</em></>}
        actions={can('exportData') && (
          <>
            <button className="btn soft" onClick={exportSales} disabled={busy}><Icon name="download" size={20} />Sales CSV</button>
            <button className="btn soft" onClick={exportClients} disabled={busy}><Icon name="download" size={20} />Clients CSV</button>
          </>
        )} />
      <div className="toolbar">
        <Seg value={preset} onChange={setPreset} className="wrap" options={[
          { value: 'this_week', label: 'This week' }, { value: 'last_week', label: 'Last week' }, { value: 'this_month', label: 'This month' },
          { value: 'last_month', label: 'Last month' }, { value: 'custom', label: 'Custom' },
        ]} />
        {preset === 'custom' && (
          <div className="row custom-range">
            <input className="input sm" type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
            <span className="faint">to</span>
            <input className="input sm" type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
          </div>
        )}
      </div>

      {!r ? (rep.error ? <p className="muted">{rep.error.message}</p> : <Loading />) : (
        <div className={cx('stack lg', rep.loading && 'dim')}>
          <div className="kpis">
            <Kpi label="Revenue" value={money(r.revenueCents - r.refundsCents)} sub={r.refundsCents ? `after ${money(r.refundsCents)} refunds` : `${r.salesCount} sales`} hero />
            <Kpi label="Classes run" value={r.classesRun} />
            <Kpi label="Attendance" value={r.attended} sub={`of ${r.totalBookings} bookings`} />
            <Kpi label="Average fill" value={`${Math.round(r.avgFillPct)}%`} />
            <Kpi label="No-shows" value={r.noShows} />
            <Kpi label="Late cancels" value={r.lateCancels} />
            <Kpi label="New clients" value={r.newClients} />
            <Kpi label="Active memberships" value={r.activeMemberships} sub={`${r.activePacks} active packs`} />
          </div>

          <div className="charts">
            <section className="card pad chart">
              <h3>Revenue by <em>product</em></h3>
              <Bars data={revKinds} fmt={(v) => money(v)} empty="No sales in this period." />
              {methods.length > 0 && (
                <div className="methods-split">
                  {methods.map(([k, v]) => <span key={k}><span className="faint">{METHOD_LABEL[k] ?? k}</span> {money(v ?? 0)}</span>)}
                </div>
              )}
            </section>
            <section className="card pad chart">
              <h3>Attendance by <em>class</em></h3>
              <Bars data={r.byClassType.map((c) => ({ label: c.name, value: c.attendees, note: `${c.classes} classes · ${Math.round(c.avgFillPct)}% full` }))} fmt={(v) => String(v)} empty="No classes run in this period." />
            </section>
            <section className="card pad chart">
              <h3>Busiest <em>times</em></h3>
              <Bars data={r.topSlots.slice(0, 6).map((s) => ({ label: s.label, value: Math.round(s.avgAttendees * 10) / 10 }))} fmt={(v) => `${v} avg`} empty="Not enough classes yet." />
            </section>
          </div>

          <section className="card pad">
            <div className="sec-head"><h3>Instructors</h3>{!showPay && <span className="faint small">Pay amounts are visible to the owner</span>}</div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Instructor</th><th className="num">Classes</th><th className="num">Attendees</th><th className="num">Avg / class</th>{showPay && <th className="num">Pay</th>}</tr></thead>
                <tbody>
                  {r.byInstructor.map((i) => {
                    const st = staffById(i.staffId);
                    return (
                      <tr key={i.staffId}>
                        <td><span className="row"><Avatar name={i.name} photo={st?.photoUrl} size={32} />{i.name}</span></td>
                        <td className="num">{i.classes}</td><td className="num">{i.attendees}</td>
                        <td className="num">{i.classes ? (i.attendees / i.classes).toFixed(1) : '–'}</td>
                        {showPay && <td className="num">{money(i.payCents, { cents: i.payCents % 100 !== 0 })}</td>}
                      </tr>
                    );
                  })}
                  {r.byInstructor.length === 0 && <tr><td colSpan={5} className="faint">No classes taught in this period.</td></tr>}
                </tbody>
                {showPay && r.byInstructor.length > 0 && (
                  <tfoot><tr><td>Total</td><td className="num">{r.byInstructor.reduce((n, i) => n + i.classes, 0)}</td><td className="num">{r.byInstructor.reduce((n, i) => n + i.attendees, 0)}</td><td /><td className="num">{money(r.byInstructor.reduce((n, i) => n + i.payCents, 0))}</td></tr></tfoot>
                )}
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, hero }: { label: string; value: React.ReactNode; sub?: string; hero?: boolean }) {
  return (
    <div className={cx('kpi', hero && 'hero')}>
      <span className="kpi-l">{label}</span>
      <span className="kpi-v">{value}</span>
      {sub && <span className="kpi-s">{sub}</span>}
    </div>
  );
}

/** Single-series horizontal bars: thin marks, value at the tip, hover tooltip via title + CSS. */
function Bars({ data, fmt, empty }: { data: { label: string; value: number; note?: string }[]; fmt: (v: number) => string; empty: string }) {
  if (data.length === 0 || data.every((d) => d.value === 0)) return <p className="muted" style={{ marginTop: 14 }}>{empty}</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="bars" role="table">
      {data.map((d) => (
        <div key={d.label} className="bar-row" role="row" title={`${d.label}: ${fmt(d.value)}${d.note ? ` (${d.note})` : ''}`}>
          <span className="bar-l" role="rowheader">{d.label}{d.note && <span className="faint small">{d.note}</span>}</span>
          <span className="bar-track" role="cell">
            <span className="bar" style={{ ['--w' as string]: String(Math.max(0.02, d.value / max)) }} />
            <span className="bar-v">{fmt(d.value)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
