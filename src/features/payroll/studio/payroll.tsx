/**
 * Payroll, studio app: pay periods (what each person earns, adjustments, mark paid, Xero CSV), timesheet approval,
 * pay rules, the Settings tab and the pay-rule line on staff cards. The owner changes pay; managers can look.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { money, studioDate } from '../../../shared/format';
import type { ID, ISODate, Staff } from '../../../shared/types';
import { Avatar, Confirm, Empty, Icon, Loading, PageHead, Seg, SheetHead, cx, dateTime, downloadText, roleLabel, useStudio } from '../../../studio/ui';
import { RULE_KIND_LABEL, describeRule, hoursOf, periodDays, periodFor, sessionTypeLabel, shiftPeriod } from '../calc';
import type { PayPeriodView, PayRule, PayRuleKind, PayTier, PayrollSettings, StaffPay, TimesheetEntry } from '../types';
import { EntryRow, EntrySheet } from './clock';
import { MoneyInput, PeriodNav, centsOf, dateLabel, dollarsOf, hrs, payroll, periodLabel } from './bits';

type Tab = 'periods' | 'timesheets' | 'rules';
const dayNum = (d: ISODate) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y ?? 1970, (m ?? 1) - 1, dd ?? 1) / 864e5; };

// ---------------------------------------------------------------- page

export function PayrollPage({ tab }: { tab?: string }) {
  if (!payroll()) return null;
  return <PayrollInner tab={(tab === 'timesheets' || tab === 'rules' ? tab : 'periods') as Tab} />;
}

function PayrollInner({ tab }: { tab: Tab }) {
  const { can } = useStudio();
  const pr = payroll()!;
  const settings = useData(() => pr.getSettings(), []);
  const [offset, setOffset] = useState(0);
  const go = (t: Tab) => { location.hash = t === 'periods' ? '/payroll' : `/payroll/${t}`; };
  const cur = settings.data ? periodFor(studioDate(), settings.data) : null;
  const per = cur ? shiftPeriod(cur, offset) : null;
  const owner = can('payroll.manage');
  return (
    <div className="payroll-page">
      <PageHead eyebrow="Staff + pay" title={<>Pay<em>roll</em></>}
        sub={owner ? 'What everyone has earned, from classes taught, approved hours and your pay rules.' : 'What everyone has earned. Only the owner changes pay, hours and rules.'} />
      <div className="toolbar">
        <Seg value={tab} onChange={go} options={[{ value: 'periods', label: 'Pay periods' }, { value: 'timesheets', label: 'Timesheets' }, { value: 'rules', label: 'Pay rules' }]} />
      </div>
      {!settings.data || !per || !cur ? <Loading /> : (
        <>
          {tab !== 'rules' && (
            <div className="toolbar pr-period-bar">
              <PeriodNav from={per.from} to={per.to} onPrev={() => setOffset(offset - 1)} onNext={() => setOffset(offset + 1)} nextDisabled={offset >= 1}
                sub={offset === 0 ? `This ${settings.data.frequency === 'weekly' ? 'week' : 'fortnight'}` : offset === 1 ? 'Next' : undefined} />
              {offset !== 0 && <button className="btn ghost sm" onClick={() => setOffset(0)}>Back to now</button>}
            </div>
          )}
          {tab === 'periods' && <PeriodsTab per={per} cur={cur} settings={settings.data} setOffset={setOffset} onTab={go} />}
          {tab === 'timesheets' && <TimesheetsTab per={per} />}
          {tab === 'rules' && <RulesTab />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pay periods

function PeriodsTab({ per, cur, settings, setOffset, onTab }: { per: { from: ISODate; to: ISODate }; cur: { from: ISODate; to: ISODate }; settings: PayrollSettings; setOffset: (n: number) => void; onTab: (t: Tab) => void }) {
  const { can, studio } = useStudio();
  const pr = payroll()!;
  const view = useData(() => pr.getPayPeriod(per), [per.from, per.to]);
  const runs = useData(() => pr.listPayRuns(), []);
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState<'paid' | 'reopen' | null>(null);
  const [adjust, setAdjust] = useState<ID | null>(null);
  const owner = can('payroll.manage');
  const v = view.data;
  if (!v) return view.error ? <p className="muted">{view.error.message}</p> : <Loading />;

  const paid = v.status === 'paid';
  const blocker = paid ? '' : v.inProgress ? 'This pay period is still running. You can mark it paid once it’s over.'
    : v.openClocks > 0 ? 'Someone is still clocked in. Their shift needs closing first.'
    : v.pendingEntries > 0 ? `${v.pendingEntries} timesheet ${v.pendingEntries === 1 ? 'entry needs' : 'entries need'} approving first.` : '';
  const withPay = v.staff.filter((s) => s.totalCents !== 0 || s.warnings.length > 0 || s.pendingEntries > 0);
  const without = v.staff.filter((s) => !withPay.includes(s));
  const hours = v.staff.reduce((n, s) => n + s.minutes, 0);
  const classes = v.staff.reduce((n, s) => n + s.classCount, 0);
  const csv = () => run(async () => downloadText(`${studio.slug}-payroll-${v.from}-to-${v.to}.csv`, await pr.exportCsv(per)), 'CSV downloaded');
  const markPaid = async () => { const r = await run(() => pr.markPaid(per), 'Marked as paid'); if (r) setConfirm(null); };
  const reopen = async () => { const r = await run(() => pr.reopenPeriod(per), 'Pay period reopened'); if (r) setConfirm(null); };
  const jump = (from: ISODate) => setOffset(Math.round((dayNum(from) - dayNum(cur.from)) / periodDays(settings.frequency)));

  return (
    <div className={cx('stack lg', view.loading && 'dim')}>
      <div className="pr-head">
        <div className="pr-status">
          <span className={cx('chip', paid ? 'ok' : v.inProgress ? '' : 'cream')}>{paid ? `Paid ${dateLabel(studioDate(v.paidAt ? new Date(v.paidAt) : new Date()))}` : v.inProgress ? 'In progress' : 'Ready to pay'}</span>
          {paid && <span className="faint small">A saved copy of what was paid. Changing a rule later doesn’t touch it.</span>}
        </div>
        {owner && (
          <div className="pr-actions">
            <button className="btn soft" disabled={busy || v.staff.length === 0} onClick={csv}><Icon name="download" size={20} />Xero CSV</button>
            {paid ? <button className="btn ghost" disabled={busy} onClick={() => setConfirm('reopen')}>Reopen</button>
              : <button className="btn" disabled={busy || !!blocker} onClick={() => setConfirm('paid')}><Icon name="check" size={20} />Mark as paid</button>}
          </div>
        )}
      </div>
      {blocker && (
        <div className="pr-note">
          <Icon name={v.inProgress ? 'clock' : 'alert'} size={20} /><span>{blocker}</span>
          {!v.inProgress && (v.pendingEntries > 0 || v.openClocks > 0) && <button className="linkish" onClick={() => onTab('timesheets')}>Go to timesheets<Icon name="right" size={16} /></button>}
        </div>
      )}

      <div className="kpis">
        <div className="kpi hero"><span className="kpi-l">Total pay</span><span className="kpi-v">{money(v.totalCents)}</span><span className="kpi-s">{periodLabel(v.from, v.to)}</span></div>
        <div className="kpi"><span className="kpi-l">Classes taught</span><span className="kpi-v">{classes}</span></div>
        <div className="kpi"><span className="kpi-l">Hours</span><span className="kpi-v">{hoursOf(hours)}</span></div>
        <div className="kpi"><span className="kpi-l">To approve</span><span className="kpi-v">{v.pendingEntries}</span>{v.pendingEntries > 0 && <span className="kpi-s">Not counted yet</span>}</div>
      </div>

      {withPay.length === 0 ? (
        <div className="card"><Empty title="Nothing to pay yet">Classes taught and approved hours in this period show here.</Empty></div>
      ) : (
        <div className="pr-staff">
          {withPay.map((s) => <StaffPayCard key={s.staffId} sp={s} view={v} canAdjust={owner && !paid} onAdjust={() => setAdjust(s.staffId)} />)}
        </div>
      )}
      {without.length > 0 && <p className="faint small pr-none">Not paid through payroll this period: {without.map((s) => s.name).join(', ')}.</p>}

      {(runs.data?.length ?? 0) > 0 && (
        <section className="card pad">
          <h3>Recent pay <em>runs</em></h3>
          <div className="pr-runs">
            {runs.data!.slice(0, 6).map((r) => (
              <button key={r.from} className={cx('pr-run', r.from === per.from && 'on')} onClick={() => jump(r.from)}>
                <span><strong>{periodLabel(r.from, r.to)}</strong><span className="faint small">Paid {dateLabel(studioDate(new Date(r.paidAt)))}</span></span>
                <span className="pr-run-amt">{money(r.totalCents)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <AdjustSheet staffId={adjust} period={per} onClose={() => setAdjust(null)} />
      <Confirm open={confirm === 'paid'} onClose={() => setConfirm(null)} title={<>Mark as <em>paid</em>?</>} confirmLabel="Mark as paid" busy={busy} onConfirm={markPaid}
        body={`${money(v.totalCents)} for ${periodLabel(v.from, v.to)}. This locks the period: hours, adjustments and the numbers are saved as they are now. You can reopen it if something needs fixing.`} />
      <Confirm open={confirm === 'reopen'} onClose={() => setConfirm(null)} title={<>Reopen this <em>period</em>?</>} confirmLabel="Reopen" busy={busy} onConfirm={reopen}
        body="The saved copy is replaced by live numbers again, and hours and adjustments can change. Mark it paid again when you’re done." />
    </div>
  );
}

function StaffPayCard({ sp, view, canAdjust, onAdjust }: { sp: StaffPay; view: PayPeriodView; canAdjust: boolean; onAdjust: () => void }) {
  const { staffById, typeById } = useStudio();
  const pr = payroll()!;
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const st = staffById(sp.staffId);
  const adj = view.adjustments.filter((a) => a.staffId === sp.staffId);
  const bits = [sp.classCount ? `${sp.classCount} ${sp.classCount === 1 ? 'class' : 'classes'}` : '', sp.attendees ? `${sp.attendees} attended` : '', sp.minutes ? hrs(sp.minutes) : ''].filter(Boolean).join(' · ');
  return (
    <article className={cx('card pr-card', open && 'open')}>
      <button className="pr-card-h" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar name={sp.name} {...(st?.photoUrl ? { photo: st.photoUrl } : {})} size={44} />
        <span className="pr-card-t"><strong>{sp.name}</strong><span className="muted small">{bits || 'Adjustments only'}</span></span>
        {sp.warnings.length > 0 && <span className="chip warn"><Icon name="alert" size={14} />Check</span>}
        {sp.pendingEntries > 0 && <span className="chip">{sp.pendingEntries} to approve</span>}
        <span className="pr-amt">{money(sp.totalCents, { cents: sp.totalCents % 100 !== 0 })}</span>
        <Icon name="down" size={20} className="pr-chev" />
      </button>
      {open && (
        <div className="pr-card-b">
          {sp.warnings.map((w, i) => <p key={i} className="pr-warn"><Icon name="alert" size={16} />{w}</p>)}
          <div className="table-wrap">
            <table className="tbl pr-tbl">
              <thead><tr><th>Earnings rate</th><th className="num">Units</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {sp.lines.filter((l) => l.kind !== 'adjustment').map((l, i) => (
                  <tr key={i}><td>{l.earningsRate}</td><td className="num">{l.kind === 'hourly' ? l.units.toFixed(2) : l.units}</td><td className="num">{money(l.rateCents)}</td><td className="num">{money(l.amountCents)}</td></tr>
                ))}
                {sp.lines.every((l) => l.kind === 'adjustment') && <tr><td colSpan={4} className="faint">No classes or hours counted.</td></tr>}
                {adj.map((a) => (
                  <tr key={a.id}>
                    <td>{a.label}<span className="faint small pr-reason">{a.reason}</span></td><td className="num">1</td><td className="num">{money(a.amountCents)}</td>
                    <td className="num">{money(a.amountCents)}{canAdjust && <button className="pr-x" disabled={busy} aria-label="Remove adjustment" onClick={() => run(() => pr.removeAdjustment(a.id), 'Adjustment removed')}><Icon name="x" size={14} /></button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Total</td><td className="num"><strong>{money(sp.totalCents)}</strong></td></tr></tfoot>
            </table>
          </div>
          {sp.classes.length > 0 && (
            <details className="pr-classes">
              <summary>Classes taught ({sp.classes.length})</summary>
              <ul>
                {sp.classes.map((c) => (
                  <li key={c.sessionId}><span>{dateTime(c.startsAt)}</span><span>{typeById(c.classTypeId)?.name ?? 'Class'}</span><span className="faint">{c.attendees} attended</span><span className="num">{c.note ?? money(c.amountCents)}</span></li>
                ))}
              </ul>
            </details>
          )}
          {canAdjust && <button className="btn soft sm" onClick={onAdjust}><Icon name="plus" size={16} />Add an adjustment</button>}
        </div>
      )}
    </article>
  );
}

function AdjustSheet({ staffId, period, onClose }: { staffId: ID | null; period: { from: ISODate; to: ISODate }; onClose: () => void }) {
  const { staff, staffById } = useStudio();
  const pr = payroll()!;
  const { busy, run } = useAction();
  const [who, setWho] = useState('');
  const [dir, setDir] = useState<'add' | 'take'>('add');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('Bonus');
  const [reason, setReason] = useState('');
  useEffect(() => { if (staffId) { setWho(staffId); setDir('add'); setAmount(''); setLabel('Bonus'); setReason(''); } }, [staffId]);
  const cents = centsOf(amount);
  const save = async () => {
    const abs = Math.abs(cents ?? 0);
    const r = await run(() => pr.addAdjustment({ ...period, staffId: who, label, amountCents: dir === 'add' ? abs : -abs, reason }), 'Adjustment added');
    if (r) onClose();
  };
  return (
    <Sheet open={!!staffId} onClose={onClose} label="Add an adjustment">
      <SheetHead title={<>Add an <em>adjustment</em></>} sub={`For ${periodLabel(period.from, period.to)}. It shows on the export under this name.`} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Who</span>
          <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>{staff.filter((s) => s.active || s.id === staffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
        <div className="field span2"><span>Type</span><Seg value={dir} onChange={setDir} options={[{ value: 'add', label: 'Add to pay' }, { value: 'take', label: 'Take off' }]} /></div>
        <MoneyInput label="Amount" value={amount} onChange={setAmount} placeholder="0" />
        <label className="field"><span>Name on the export</span>
          <input className="input" list="pr-adj-names" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <datalist id="pr-adj-names"><option value="Bonus" /><option value="Reimbursement" /><option value="Correction" /><option value="Deduction" /></datalist>
        </label>
        <label className="field span2"><span>Reason (kept on the record)</span><textarea className="textarea" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={staffId ? `Why ${staffById(staffId)?.name.split(' ')[0] ?? 'they'} is getting this` : ''} /></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !cents || !reason.trim() || !who} onClick={save}>Add adjustment</button></div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- timesheets

function TimesheetsTab({ per }: { per: { from: ISODate; to: ISODate } }) {
  const { can, staffById, staff } = useStudio();
  const pr = payroll()!;
  const rows = useData(() => pr.listTimesheets(per), [per.from, per.to]);
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<TimesheetEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<Set<ID>>(new Set());
  const [reject, setReject] = useState<ID[] | null>(null);
  const [note, setNote] = useState('');
  const approver = can('payroll.timesheets_approve');
  useEffect(() => setSel(new Set()), [per.from, per.to]);
  const all = rows.data ?? [];
  const pending = all.filter((e) => e.status === 'pending');
  const done = all.filter((e) => e.status !== 'pending');
  const owner = staff.find((s) => s.role === 'owner' && s.active)?.name ?? 'the owner';
  const ready = pending.filter((e) => e.endedAt);
  const toggle = (id: ID) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const approve = (ids: ID[]) => run(async () => { await pr.reviewTimesheets(ids, 'approve'); setSel(new Set()); }, ids.length === 1 ? 'Approved' : `${ids.length} entries approved`);
  const doReject = async () => { if (!reject) return; const r = await run(() => pr.reviewTimesheets(reject, 'reject', note), 'Marked as not approved'); if (r) { setReject(null); setNote(''); setSel(new Set()); } };

  return (
    <div className={cx('stack lg', rows.loading && 'dim')}>
      <div className="tab-head">
        <p className="muted">{approver ? 'Approve hours before they’re counted in pay. Typed-in shifts and private sessions show here too.' : `${owner} approves hours. You can add or fix entries for the team.`}</p>
        <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={20} />Add hours</button>
      </div>
      {rows.loading && !rows.data ? <Loading /> : all.length === 0 ? (
        <div className="card"><Empty title="No hours logged">Clock-ins and typed-in shifts for this period show here.</Empty></div>
      ) : (
        <>
          {pending.length > 0 && (
            <section className="card pad ts-block">
              <div className="sec-head">
                <h3>Waiting for <em>approval</em><span className="count">{pending.length}</span></h3>
                {approver && ready.length > 0 && (
                  <span className="row">
                    {sel.size > 0 && <button className="btn soft sm" disabled={busy} onClick={() => setReject([...sel])}>Not approved ({sel.size})</button>}
                    <button className="btn sm" disabled={busy} onClick={() => approve(sel.size > 0 ? [...sel] : ready.map((e) => e.id))}><Icon name="check" size={16} />{sel.size > 0 ? `Approve ${sel.size}` : 'Approve all'}</button>
                  </span>
                )}
              </div>
              <div className="ts-list">
                {pending.map((e) => (
                  <div key={e.id} className="ts-sel">
                    {approver && <input type="checkbox" aria-label="Select entry" disabled={!e.endedAt} checked={sel.has(e.id)} onChange={() => toggle(e.id)} />}
                    <EntryRow e={e} name={staffById(e.staffId)?.name ?? ''} onEdit={e.endedAt ? setEdit : undefined}>
                      {approver && e.endedAt && <button className="btn sm" disabled={busy} onClick={() => approve([e.id])}>Approve</button>}
                    </EntryRow>
                  </div>
                ))}
              </div>
            </section>
          )}
          {done.length > 0 && (
            <section className="card pad ts-block">
              <h3>Approved <em>hours</em></h3>
              <div className="ts-list">
                {done.map((e) => <EntryRow key={e.id} e={e} name={staffById(e.staffId)?.name ?? ''} onEdit={approver ? setEdit : undefined} />)}
              </div>
            </section>
          )}
        </>
      )}
      <EntrySheet open={adding || !!edit} entry={edit} onClose={() => { setAdding(false); setEdit(null); }} />
      <Confirm open={!!reject} onClose={() => setReject(null)} title={<>Not <em>approved</em>?</>} confirmLabel="Mark as not approved" busy={busy} onConfirm={doReject}
        body="These hours won’t be paid. The person can see your note and add a corrected entry.">
        <label className="field"><span>Note (optional)</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Doubled up with Tuesday’s shift" /></label>
      </Confirm>
    </div>
  );
}

// ---------------------------------------------------------------- pay rules

function RulesTab() {
  const { staff, can, teaches, typeById } = useStudio();
  const pr = payroll()!;
  const rules = useData(() => pr.listPayRules(), []);
  const [edit, setEdit] = useState<{ rule?: PayRule; staff: Staff } | null>(null);
  const [del, setDel] = useState<PayRule | null>(null);
  const { busy, run } = useAction();
  const owner = can('payroll.rules');
  const focus = new URLSearchParams(location.hash.split('?')[1] ?? '').get('staff');
  const active = staff.filter((s) => s.active);
  const mine = (id: ID) => (rules.data ?? []).filter((r) => r.staffId === id);
  return (
    <div className="stack lg">
      <div className="tab-head"><p className="muted">{owner ? 'How each person is paid. One rule per kind; a rule for a single class type beats one for all classes.' : 'How each person is paid. Only the owner can change these.'}</p></div>
      {rules.loading && !rules.data ? <Loading /> : (
        <div className="pr-rules">
          {active.map((s) => {
            const list = mine(s.id);
            return (
              <section key={s.id} className={cx('card pad pr-rule-card', focus === s.id && 'focus')}>
                <div className="pr-rule-h">
                  <Avatar name={s.name} {...(s.photoUrl ? { photo: s.photoUrl } : {})} size={44} />
                  <span className="pr-card-t"><strong>{s.name}</strong><span className="muted small">{roleLabel(s.role, teaches(s.id))}</span></span>
                  {owner && <button className="btn soft sm push" onClick={() => setEdit({ staff: s })}><Icon name="plus" size={16} />Add rule</button>}
                </div>
                {list.length === 0 ? <p className="pr-norule"><Icon name="alert" size={16} />No pay rule yet. {teaches(s.id) ? 'Their classes earn nothing until one is added.' : ''}</p> : (
                  <ul className="pr-rule-list">
                    {list.map((r) => (
                      <li key={r.id} className={cx(!r.active && 'off')}>
                        <span className="pr-rule-k">{RULE_KIND_LABEL[r.kind]}{r.classTypeId && <span className="chip">{typeById(r.classTypeId)?.name ?? 'One class type'}</span>}{!r.active && <span className="chip">Off</span>}</span>
                        <span className="pr-rule-d">{describeRule(r, (c) => money(c, { cents: c % 100 !== 0 }))}</span>
                        {r.earningsRate && <span className="faint small">Export name: {r.earningsRate}</span>}
                        {owner && <span className="pr-rule-a"><button className="btn ghost sm" onClick={() => setEdit({ rule: r, staff: s })}>Edit</button><button className="btn ghost sm danger-text" onClick={() => setDel(r)}>Remove</button></span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      <RuleSheet target={edit} onClose={() => setEdit(null)} />
      <Confirm open={!!del} onClose={() => setDel(null)} title={<>Remove this <em>rule</em>?</>} confirmLabel="Remove" danger busy={busy}
        body="Past pay periods that are already paid keep what they paid. Open ones are recalculated without it."
        onConfirm={async () => { if (del && (await run(() => pr.deletePayRule(del.id), 'Rule removed')) !== undefined) setDel(null); }} />
    </div>
  );
}

const KINDS: { value: PayRuleKind; label: string; hint: string }[] = [
  { value: 'flat', label: 'Per class', hint: 'The same amount for every class taught.' },
  { value: 'per_head', label: 'Base + per head', hint: 'A base amount, plus a bit extra for each attendee above a number.' },
  { value: 'tiered', label: 'By attendance', hint: 'The more people turn up, the higher the amount. The highest tier reached applies.' },
  { value: 'hourly', label: 'Hourly', hint: 'Approved timesheet hours, like front desk shifts.' },
  { value: 'session', label: 'Private / appointment', hint: 'Paid for sessions logged with the same session type.' },
];

function RuleSheet({ target, onClose }: { target: { rule?: PayRule; staff: Staff } | null; onClose: () => void }) {
  const { classTypes } = useStudio();
  const pr = payroll()!;
  const { busy, run } = useAction();
  const [kind, setKind] = useState<PayRuleKind>('flat');
  const [ct, setCt] = useState('');
  const [rate, setRate] = useState('');
  const [base, setBase] = useState('');
  const [perHead, setPerHead] = useState('');
  const [above, setAbove] = useState('0');
  const [tiers, setTiers] = useState<{ min: string; pay: string }[]>([{ min: '0', pay: '' }]);
  const [stype, setStype] = useState('private');
  const [perHour, setPerHour] = useState(false);
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!target) return;
    const r = target.rule;
    setKind(r?.kind ?? 'flat'); setCt(r?.classTypeId ?? ''); setRate(dollarsOf(r?.rateCents)); setBase(dollarsOf(r?.baseCents)); setPerHead(dollarsOf(r?.perHeadCents));
    setAbove(String(r?.aboveN ?? 0)); setTiers(r?.tiers?.length ? r.tiers.map((t) => ({ min: String(t.minAttendees), pay: dollarsOf(t.payCents) })) : [{ min: '0', pay: '' }]);
    setStype(r?.sessionType ?? 'private'); setPerHour(!!r?.perHour); setName(r?.earningsRate ?? ''); setActive(r?.active ?? true);
  }, [target]);
  const hint = KINDS.find((k) => k.value === kind)?.hint;
  const classKind = kind === 'flat' || kind === 'per_head' || kind === 'tiered';
  const save = async () => {
    if (!target) return;
    const t: PayTier[] = tiers.filter((x) => x.min !== '' && x.pay !== '').map((x) => ({ minAttendees: Number(x.min), payCents: centsOf(x.pay) ?? 0 }));
    const r = await run(() => pr.savePayRule({
      ...(target.rule ? { id: target.rule.id } : {}), staffId: target.staff.id, kind, active,
      ...(name.trim() ? { earningsRate: name.trim() } : {}), ...(classKind && ct ? { classTypeId: ct } : {}),
      ...(kind === 'flat' || kind === 'hourly' || kind === 'session' ? { rateCents: centsOf(rate) ?? 0 } : {}),
      ...(kind === 'per_head' ? { baseCents: centsOf(base) ?? 0, perHeadCents: centsOf(perHead) ?? 0, aboveN: Number(above) || 0 } : {}),
      ...(kind === 'tiered' ? { tiers: t } : {}),
      ...(kind === 'session' ? { sessionType: stype, ...(perHour ? { perHour: true } : {}) } : {}),
    }), 'Pay rule saved');
    if (r) onClose();
  };
  const setTier = (i: number, patch: Partial<{ min: string; pay: string }>) => setTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <Sheet open={!!target} onClose={onClose} label="Pay rule">
      <SheetHead title={target?.rule ? <>Edit pay <em>rule</em></> : <>New pay <em>rule</em></>} sub={target ? `For ${target.staff.name}` : undefined} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>How they’re paid</span>
          <select className="select" value={kind} disabled={!!target?.rule} onChange={(e) => setKind(e.target.value as PayRuleKind)}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
          {hint && <span className="faint small">{hint}</span>}
        </label>
        {classKind && (
          <label className="field span2"><span>Applies to</span>
            <select className="select" value={ct} onChange={(e) => setCt(e.target.value)}><option value="">Every class they teach</option>{classTypes.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name} only</option>)}</select>
          </label>
        )}
        {kind === 'flat' && <MoneyInput label="Amount per class" value={rate} onChange={setRate} placeholder="60" />}
        {kind === 'hourly' && <MoneyInput label="Rate per hour" value={rate} onChange={setRate} placeholder="32.50" />}
        {kind === 'per_head' && (
          <>
            <MoneyInput label="Base per class" value={base} onChange={setBase} placeholder="45" />
            <MoneyInput label="Extra per attendee" value={perHead} onChange={setPerHead} placeholder="3" />
            <label className="field span2"><span>Extra applies above this many attendees</span><input className="input" inputMode="numeric" value={above} onChange={(e) => setAbove(e.target.value.replace(/\D/g, ''))} /></label>
          </>
        )}
        {kind === 'tiered' && (
          <div className="field span2"><span>Tiers: when this many people attended or more</span>
            <div className="pr-tiers">
              {tiers.map((t, i) => (
                <div key={i} className="pr-tier">
                  <input className="input" inputMode="numeric" aria-label="Attendees" value={t.min} onChange={(e) => setTier(i, { min: e.target.value.replace(/\D/g, '') })} />
                  <span className="faint small">or more →</span>
                  <MoneyInput value={t.pay} onChange={(v) => setTier(i, { pay: v })} ariaLabel="Pay for this tier" placeholder="60" />
                  <button className="btn ghost icon" aria-label="Remove tier" disabled={tiers.length < 2} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}><Icon name="x" size={18} /></button>
                </div>
              ))}
              <button className="chip-btn" onClick={() => setTiers([...tiers, { min: '', pay: '' }])}><Icon name="plus" size={16} />Add a tier</button>
            </div>
          </div>
        )}
        {kind === 'session' && (
          <>
            <label className="field"><span>Session type</span><input className="input" value={stype} onChange={(e) => setStype(e.target.value)} placeholder="private" /></label>
            <MoneyInput label={perHour ? 'Rate per hour' : 'Rate per session'} value={rate} onChange={setRate} placeholder="90" />
            <label className="check span2"><input type="checkbox" checked={perHour} onChange={(e) => setPerHour(e.target.checked)} /><span>Pay by the hour instead of per session</span></label>
          </>
        )}
        <label className="field span2"><span>Name on the Xero export (optional)</span><input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={kind === 'hourly' ? 'Ordinary hours' : kind === 'session' ? `${sessionTypeLabel(stype)} sessions` : 'Class pay'} /></label>
        <label className="check span2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Rule is on</span></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy} onClick={save}>Save rule</button></div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Settings tab + staff card slot

export function PayrollSettingsTab() {
  if (!payroll()) return null;
  return <SettingsInner />;
}
function SettingsInner() {
  const { can } = useStudio();
  const pr = payroll()!;
  const settings = useData(() => pr.getSettings(), []);
  const { busy, run } = useAction();
  const owner = can('payroll.manage');
  const s = settings.data;
  const [freq, setFreq] = useState<PayrollSettings['frequency']>('weekly');
  const [anchor, setAnchor] = useState('');
  useEffect(() => { if (s) { setFreq(s.frequency); setAnchor(s.periodAnchor); } }, [s?.frequency, s?.periodAnchor]);
  if (!s) return <Loading />;
  const now = periodFor(studioDate(), { frequency: freq, periodAnchor: anchor || s.periodAnchor });
  const dirty = freq !== s.frequency || anchor !== s.periodAnchor;
  return (
    <div className="stack lg" style={{ maxWidth: 720 }}>
      <section className="card pad">
        <h3>Pay <em>period</em></h3>
        <p className="muted" style={{ marginTop: 8 }}>How often you pay the team. The payroll screen, timesheets and the Xero export all follow it.</p>
        <div className="form-grid" style={{ marginTop: 16 }}>
          <div className="field"><span>Paid</span><Seg value={freq} onChange={(v) => owner && setFreq(v)} options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }]} /></div>
          <label className="field"><span>A day a pay period starts</span><input className="input" type="date" value={anchor} disabled={!owner} onChange={(e) => setAnchor(e.target.value)} /></label>
          <p className="faint small span2">The current pay period is {periodLabel(now.from, now.to)}.</p>
        </div>
        {owner ? <div className="sh-foot" style={{ position: 'static', background: 'none' }}><button className="btn" disabled={busy || !dirty || !anchor} onClick={() => run(() => pr.updateSettings({ frequency: freq, periodAnchor: anchor }), 'Pay period saved')}>Save</button></div>
          : <p className="faint small" style={{ marginTop: 12 }}>Only the owner changes the pay period.</p>}
      </section>
      <section className="card pad">
        <h3>Class <em>cover</em></h3>
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={s.coverAutoApprove} disabled={busy} onChange={(e) => run(() => pr.updateSettings({ coverAutoApprove: e.target.checked }), e.target.checked ? 'Claims now go straight through' : 'Claims now wait for approval')} />
          <span><strong>Approve claims automatically</strong><br /><span className="muted small">When someone claims a class that needs cover, the instructor changes straight away. Off means the owner or a manager approves each one.</span></span>
        </label>
      </section>
    </div>
  );
}

/** Settings › Staff cards: a one-line pay summary (owner and managers only). */
export function StaffPayLine({ staff }: { staff: Staff }) {
  if (!payroll()) return null;
  return <StaffPayLineInner staff={staff} />;
}
function StaffPayLineInner({ staff }: { staff: Staff }) {
  const pr = payroll()!;
  const rules = useData(() => pr.listPayRules({ staffId: staff.id }), [staff.id]);
  const list = (rules.data ?? []).filter((r) => r.active);
  const text = useMemo(() => list.slice(0, 2).map((r) => describeRule(r, (c) => money(c, { cents: c % 100 !== 0 }))).join(' · '), [rules.data]);
  if (!rules.data) return null;
  return <span className="small muted">{list.length ? text : 'No pay rule yet'}{list.length > 2 ? ` · +${list.length - 2} more` : ''}</span>;
}

