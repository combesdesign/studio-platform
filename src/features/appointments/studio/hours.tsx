/** Studio › Appointments › Hours: weekly availability and time off, for yourself (instructors) or anyone (owner and manager). */
import React, { useEffect, useMemo, useState } from 'react';
import { errorMessage, store, useAction, useData, useToast } from '../../../shared/react';
import { addDays, studioDate, studioToUTC } from '../../../shared/format';
import { Empty, Icon, Loading, roleCan, useStudio } from '../../../studio/ui';
import { dayLabel, needAppts, range } from '../api';
import { availabilityProblem } from '../logic';
import type { AvailabilityInput } from '../types';

const DAYS = [{ n: 1, l: 'Mon' }, { n: 2, l: 'Tue' }, { n: 3, l: 'Wed' }, { n: 4, l: 'Thu' }, { n: 5, l: 'Fri' }, { n: 6, l: 'Sat' }, { n: 0, l: 'Sun' }];

export function HoursTab() {
  const { me, staff } = useStudio();
  const toast = useToast();
  const ap = needAppts();
  const manage = roleCan(me.role, 'appointments.manage');
  const people = manage ? staff.filter((s) => s.active !== false) : staff.filter((s) => s.id === me.staffId);
  const [staffId, setStaffId] = useState(me.staffId);
  const rules = useData(() => ap.listAvailability(staffId), [staffId]);
  const off = useData(() => ap.listTimeOff(staffId), [staffId]);
  const [draft, setDraft] = useState<AvailabilityInput[] | null>(null);
  const { busy, run } = useAction();
  const [offForm, setOffForm] = useState({ date: studioDate(), allDay: true, start: '09:00', end: '12:00', note: '' });

  useEffect(() => { if (rules.data) setDraft(rules.data.map(({ weekday, start, end }) => ({ weekday, start, end }))); }, [rules.data]);
  const problem = useMemo(() => (draft ? availabilityProblem(draft) : null), [draft]);
  const dirty = useMemo(() => JSON.stringify((rules.data ?? []).map(({ weekday, start, end }) => ({ weekday, start, end }))) !== JSON.stringify(draft ?? []), [rules.data, draft]);
  const upd = (i: number, patch: Partial<AvailabilityInput>) => setDraft((d) => (d ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => draft && run(async () => { await ap.setAvailability(staffId, draft); rules.reload(); }, 'Hours saved');
  const addOff = () => run(async () => {
    const day = offForm.date;
    const startsAt = studioToUTC(day, offForm.allDay ? '00:00' : offForm.start);
    const endsAt = offForm.allDay ? studioToUTC(addDays(day, 1), '00:00') : studioToUTC(day, offForm.end);
    await ap.addTimeOff({ staffId, startsAt, endsAt, ...(offForm.note.trim() ? { note: offForm.note.trim() } : {}) });
    setOffForm({ ...offForm, note: '' }); off.reload();
  }, 'Time off added');

  return (
    <div className="stack lg">
      {people.length > 1 && (
        <label className="field" style={{ maxWidth: 320 }}><span>Whose hours</span>
          <select className="select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>{people.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
      )}
      <section className="card pad">
        <h3>Weekly <em>hours</em></h3>
        <p className="muted">When {staffId === me.staffId ? 'you are' : 'they are'} free for private and duet appointments. Classes they teach block their own time automatically.</p>
        {!draft ? <Loading /> : (
          <div className="ap-hours">
            {DAYS.map((d) => {
              const rows = draft.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === d.n);
              return (
                <div key={d.n} className="ap-hours-row">
                  <strong>{d.l}</strong>
                  <div>
                    {rows.length === 0 && <span className="muted">Not available</span>}
                    {rows.map(({ r, i }) => (
                      <div key={i} className="ap-win">
                        <input className="input" type="time" step={300} value={r.start} aria-label={`${d.l} start`} onChange={(e) => upd(i, { start: e.target.value })} />
                        <span className="muted">to</span>
                        <input className="input" type="time" step={300} value={r.end} aria-label={`${d.l} end`} onChange={(e) => upd(i, { end: e.target.value })} />
                        <button className="btn icon soft" aria-label={`Remove ${d.l} window`} onClick={() => setDraft(draft.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
                      </div>
                    ))}
                    <button className="chip-btn" onClick={() => setDraft([...draft, { weekday: d.n, start: '09:00', end: '17:00' }])}><Icon name="plus" size={16} />Add hours</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {problem && <p className="field-err" role="alert" style={{ color: 'var(--danger)', marginTop: 10 }}>{problem}</p>}
        <div className="sh-foot" style={{ position: 'static' }}><button className="btn" disabled={busy || !dirty || !!problem} onClick={save}>Save hours</button></div>
      </section>

      <section className="card pad">
        <h3>Time <em>off</em></h3>
        <p className="muted">Blocks bookings for that time. Existing bookings stay put, so cancel or move those separately.</p>
        {off.data && off.data.length > 0 && (
          <ul className="ap-sessions" style={{ marginBottom: 14 }}>
            {off.data.map((t) => (
              <li key={t.id}><span>{dayLabel(t.startsAt)}{t.note ? ` · ${t.note}` : ''}</span>
                <span>{range(t.startsAt, t.endsAt)} <button className="btn icon soft" aria-label="Remove time off" onClick={() => run(async () => { await ap.removeTimeOff(t.id); off.reload(); })}><Icon name="x" size={16} /></button></span></li>
            ))}
          </ul>
        )}
        <div className="form-grid">
          <label className="field"><span>Day</span><input className="input" type="date" value={offForm.date} min={studioDate()} onChange={(e) => e.target.value && setOffForm({ ...offForm, date: e.target.value })} /></label>
          <label className="check" style={{ alignSelf: 'end', minHeight: 44 }}><input type="checkbox" checked={offForm.allDay} onChange={(e) => setOffForm({ ...offForm, allDay: e.target.checked })} /><span>All day</span></label>
          {!offForm.allDay && <><label className="field"><span>From</span><input className="input" type="time" value={offForm.start} onChange={(e) => setOffForm({ ...offForm, start: e.target.value })} /></label>
            <label className="field"><span>To</span><input className="input" type="time" value={offForm.end} onChange={(e) => setOffForm({ ...offForm, end: e.target.value })} /></label></>}
          <label className="field span2"><span>Note (optional)</span><input className="input" value={offForm.note} onChange={(e) => setOffForm({ ...offForm, note: e.target.value })} placeholder="Holiday, appointment…" /></label>
        </div>
        <div className="sh-foot" style={{ position: 'static' }}><button className="btn" disabled={busy} onClick={addOff}>Add time off</button></div>
      </section>
    </div>
  );
}
