/**
 * Timesheets, studio app: the front desk clock (Today widget), "My timesheet", and the entry sheet used to type hours
 * in by hand. Clock-ins and typed hours are pending until the owner approves them; only approved hours are paid.
 */
import React, { useEffect, useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { Flower } from '../../../shared/brand';
import { time, studioDate } from '../../../shared/format';
import type { ISODate } from '../../../shared/types';
import { Confirm, Empty, Icon, Loading, PageHead, SheetHead, cx, useStudio } from '../../../studio/ui';
import { entryMinutes, periodFor, shiftPeriod, sessionTypeLabel } from '../calc';
import type { TimesheetEntry, TimesheetStatus } from '../types';
import { PeriodNav, dateLabel, dateOf, hm, hrs, payroll, periodLabel, time24, toInstant, useTick } from './bits';

const STATUS: Record<TimesheetStatus, { label: string; tone: string }> = {
  pending: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Not approved', tone: 'danger' },
};

// ---------------------------------------------------------------- Today widget

export function ClockWidget() {
  if (!payroll()) return null;
  return <ClockInner />;
}
function ClockInner() {
  const pr = payroll()!;
  const status = useData(() => pr.clockStatus(), []);
  const { busy, run } = useAction();
  const tick = useTick(15_000);
  const s = status.data;
  if (!s || !s.eligible) return null;
  const mins = s.open ? Math.max(0, Math.round((tick - Date.parse(s.open.startedAt)) / 60_000)) : 0;
  return (
    <section className={cx('card pad ck-card', s.open && 'on')}>
      <div className="sec-head" style={{ marginBottom: 8 }}>
        <h3><Flower size={16} className="h-fl" />Front desk <em>clock</em></h3>
        <a className="linkish" href="#/timesheet">My timesheet<Icon name="right" size={16} /></a>
      </div>
      {s.open ? (
        <>
          <p className="ck-big">{hm(mins)}</p>
          <p className="muted small">On the clock since {time(s.open.startedAt)}</p>
          <button className="btn block ck-btn" disabled={busy} onClick={() => run(() => pr.clockOut(), 'Clocked out. Nice work today')}><Icon name="pause" size={18} />Clock out</button>
        </>
      ) : (
        <>
          <p className="muted ck-sub">{s.todayMinutes > 0 ? `${hrs(s.todayMinutes)} logged today.` : 'Start your shift when you’re at the desk.'}</p>
          <button className="btn block ck-btn" disabled={busy} onClick={() => run(() => pr.clockIn(), 'Clocked in. Have a good one')}><Icon name="play" size={18} />Clock in</button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- one entry

export function EntryRow({ e, name, onEdit, children }: { e: TimesheetEntry; name?: string; onEdit?: (e: TimesheetEntry) => void; children?: React.ReactNode }) {
  const mins = entryMinutes(e);
  const st = STATUS[e.status];
  const open = !e.endedAt;
  return (
    <div className={cx('ts-row', e.status)}>
      <div className="ts-date"><strong>{dateLabel(dateOf(e.startedAt))}</strong>{name && <span>{name}</span>}</div>
      <div className="ts-what">
        <span className="ts-time">{time(e.startedAt)} – {open ? 'now' : time(e.endedAt!)}</span>
        <span className="faint small">
          {e.kind === 'session' ? `${sessionTypeLabel(e.sessionType ?? '')}${e.units > 1 ? ` × ${e.units}` : ''}` : e.source === 'clock' ? 'Clocked' : 'Typed in'}
          {e.breakMin > 0 ? ` · ${e.breakMin} min break` : ''}{e.note ? ` · ${e.note}` : ''}
        </span>
        {e.reviewNote && <span className="faint small">“{e.reviewNote}”</span>}
      </div>
      <div className="ts-hrs">{open ? <span className="chip warn">On the clock</span> : hrs(mins)}</div>
      <div className="ts-st"><span className={cx('chip', st.tone)}>{st.label}</span></div>
      <div className="ts-act">
        {children}
        {onEdit && <button className="btn ghost sm" onClick={() => onEdit(e)} aria-label="Edit entry"><Icon name="edit" size={16} />Edit</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add or edit hours

export function EntrySheet({ open, entry, defaultStaffId, onClose }: { open: boolean; entry?: TimesheetEntry | null; defaultStaffId?: string; onClose: () => void }) {
  const { me, can, staff } = useStudio();
  const pr = payroll()!;
  const { busy, run } = useAction();
  const manager = can('payroll.timesheets');
  const [staffId, setStaffId] = useState(me.staffId);
  const [kind, setKind] = useState<'shift' | 'session'>('shift');
  const [date, setDate] = useState<ISODate>(studioDate());
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('13:00');
  const [brk, setBrk] = useState('30');
  const [note, setNote] = useState('');
  const [stype, setStype] = useState('private');
  const [units, setUnits] = useState('1');
  const [del, setDel] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (entry) {
      setStaffId(entry.staffId); setKind(entry.kind); setDate(dateOf(entry.startedAt)); setStart(time24(entry.startedAt));
      setEnd(entry.endedAt ? time24(entry.endedAt) : time24(new Date().toISOString())); setBrk(String(entry.breakMin)); setNote(entry.note ?? '');
      setStype(entry.sessionType ?? 'private'); setUnits(String(entry.units));
    } else {
      setStaffId(defaultStaffId ?? me.staffId); setKind('shift'); setDate(studioDate()); setStart('09:00'); setEnd('13:00'); setBrk('30'); setNote(''); setStype('private'); setUnits('1');
    }
  }, [open, entry?.id]);
  const people = staff.filter((s) => s.active);
  const isOwner = can('payroll.timesheets_approve');
  const save = async () => {
    const endIso = toInstant(date, end);
    let startIso = toInstant(date, start);
    // a shift that runs past midnight: the finish is the next morning
    let finish = endIso;
    if (Date.parse(finish) <= Date.parse(startIso)) finish = new Date(Date.parse(finish) + 864e5).toISOString();
    const r = await run(() => pr.saveTimesheet({
      ...(entry ? { id: entry.id } : {}), staffId, kind, startedAt: startIso, endedAt: finish, breakMin: kind === 'shift' ? Math.max(0, Number(brk) || 0) : 0,
      ...(kind === 'session' ? { sessionType: stype, units: Math.max(1, Number(units) || 1) } : {}), ...(note.trim() ? { note } : {}),
    }), entry ? 'Entry updated' : isOwner ? 'Hours added and approved' : 'Hours added. They’ll show once the owner approves');
    if (r) onClose();
  };
  const remove = async () => { if (entry && (await run(() => pr.deleteTimesheet(entry.id), 'Entry removed')) !== undefined) { setDel(false); onClose(); } };
  return (
    <Sheet open={open} onClose={onClose} label="Timesheet entry">
      <SheetHead title={entry ? <>Edit <em>hours</em></> : <>Add <em>hours</em></>} sub={isOwner ? 'You’re the owner, so these are approved straight away.' : 'The owner approves hours before they’re paid.'} onClose={onClose} />
      <div className="form-grid">
        {manager && (
          <label className="field"><span>Who</span>
            <select className="select" value={staffId} disabled={!!entry} onChange={(e) => setStaffId(e.target.value)}>{people.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}
        {manager && !entry && (
          <label className="field"><span>What</span>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as 'shift' | 'session')}><option value="shift">Shift (hours)</option><option value="session">Private / appointment session</option></select>
          </label>
        )}
        <label className="field"><span>Date</span><input className="input" type="date" value={date} max={studioDate()} onChange={(e) => setDate(e.target.value)} /></label>
        <span className="ts-pair">
          <label className="field"><span>Start</span><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field"><span>Finish</span><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </span>
        {kind === 'shift' ? (
          <label className="field"><span>Unpaid break (minutes)</span><input className="input" inputMode="numeric" value={brk} onChange={(e) => setBrk(e.target.value.replace(/\D/g, ''))} /></label>
        ) : (
          <>
            <label className="field"><span>Session type</span><input className="input" value={stype} onChange={(e) => setStype(e.target.value)} placeholder="private" /></label>
            <label className="field"><span>How many sessions</span><input className="input" inputMode="numeric" value={units} onChange={(e) => setUnits(e.target.value.replace(/\D/g, ''))} /></label>
          </>
        )}
        <label className="field span2"><span>Note (optional)</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Forgot to clock in, covering the lunch rush…" /></label>
      </div>
      <div className="sh-foot">
        {entry && <button className="btn ghost danger-text push-left" onClick={() => setDel(true)}>Remove</button>}
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || !date || !start || !end} onClick={save}>Save</button>
      </div>
      <Confirm open={del} onClose={() => setDel(false)} title={<>Remove this <em>entry</em>?</>} confirmLabel="Remove" danger busy={busy} onConfirm={remove} />
    </Sheet>
  );
}

// ---------------------------------------------------------------- My timesheet

export function MyTimesheet() {
  if (!payroll()) return null;
  return <MyTimesheetInner />;
}
function MyTimesheetInner() {
  const { me } = useStudio();
  const pr = payroll()!;
  const settings = useData(() => pr.getSettings(), []);
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<TimesheetEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const cur = settings.data ? periodFor(studioDate(), settings.data) : null;
  const per = cur ? shiftPeriod(cur, offset) : null;
  const rows = useData(async () => (per ? pr.listTimesheets({ from: per.from, to: per.to, staffId: me.staffId }) : []), [per?.from, per?.to]);
  const status = useData(() => pr.clockStatus(), []);
  const list = (rows.data ?? []).filter((e) => e.kind === 'shift');
  const approved = list.filter((e) => e.status === 'approved').reduce((n, e) => n + entryMinutes(e), 0);
  const pending = list.filter((e) => e.status === 'pending').reduce((n, e) => n + entryMinutes(e), 0);
  return (
    <div className="ts-page">
      <PageHead eyebrow="Timesheet" title={<>My <em>hours</em></>} sub="Clock in at the desk, or add a shift you forgot. The owner approves hours before they’re paid."
        actions={<button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={20} />Add a shift</button>} />
      {per && (
        <div className="toolbar">
          <PeriodNav from={per.from} to={per.to} onPrev={() => setOffset(offset - 1)} onNext={() => setOffset(offset + 1)} nextDisabled={offset >= 0} sub={offset === 0 ? 'This pay period' : undefined} />
        </div>
      )}
      <div className="kpis ts-kpis">
        <div className="kpi hero"><span className="kpi-l">Approved</span><span className="kpi-v">{hrs(approved)}</span><span className="kpi-s">{per ? periodLabel(per.from, per.to) : ''}</span></div>
        <div className="kpi"><span className="kpi-l">Waiting for approval</span><span className="kpi-v">{hrs(pending)}</span></div>
        {status.data?.eligible === false && <div className="kpi"><span className="kpi-l">Clock</span><span className="kpi-v" style={{ fontSize: 20 }}>Not set up</span><span className="kpi-s">Ask the owner for an hourly rate</span></div>}
      </div>
      {rows.loading && !rows.data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No shifts yet">Shifts you clock or add for this pay period show here.</Empty></div>
      ) : (
        <div className="card ts-list">{list.map((e) => <EntryRow key={e.id} e={e} {...(e.status !== 'approved' && e.endedAt ? { onEdit: setEdit } : {})} />)}</div>
      )}
      <EntrySheet open={adding || !!edit} entry={edit} onClose={() => { setAdding(false); setEdit(null); }} />
    </div>
  );
}
