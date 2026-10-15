import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, store, useAction, useData, useToast } from '../shared/react';
import { addDays, startOfStudioDay, studioDate, studioToUTC, time, weekStart } from '../shared/format';
import type { ScheduleTemplate, SessionWithCounts } from '../shared/types';
import { Flower } from '../shared/brand';
import { Avatar, Confirm, Empty, Fill, Icon, Loading, PageHead, Seg, SheetHead, backFrom, cx, dayShort, replaceRoute, useStudio } from './ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmtRange = (from: string) => {
  const a = new Date(from + 'T12:00:00Z'), b = new Date(addDays(from, 6) + 'T12:00:00Z');
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  return `${a.toLocaleDateString('en-AU', o)} – ${b.toLocaleDateString('en-AU', { ...o, year: 'numeric' })}`;
};
const hhmm12 = (t: string) => { const [h, m] = t.split(':').map(Number); const hh = ((h! + 11) % 12) + 1; return `${hh}:${String(m).padStart(2, '0')}${h! < 12 ? 'am' : 'pm'}`; };

export function Schedule({ week }: { week?: string }) {
  const { me, can, typeById, staffById, classTypes, teaches } = useStudio();
  const today = studioDate();
  const from = weekStart(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const res = useData(() => store.listSessions({ from: startOfStudioDay(from), to: startOfStudioDay(addDays(from, 7)), includeCancelled: true }), [from]);
  const [adding, setAdding] = useState<string | null>(null);
  // "My classes" follows instructorId, so a front-desk person who teaches gets it too. Instructors start on their own.
  const [mineOnly, setMineOnly] = useState(!can('allRosters'));
  const iTeach = !can('allRosters') || teaches(me.staffId) || (res.data ?? []).some((s) => s.instructorId === me.staffId);
  const byDay = useMemo(() => {
    const m: Record<string, SessionWithCounts[]> = {};
    for (const s of res.data ?? []) {
      if (mineOnly && s.instructorId !== me.staffId) continue;
      (m[studioDate(s.startsAt)] ??= []).push(s);
    }
    return m;
  }, [res.data, mineOnly, me.staffId]);
  const total = (res.data ?? []).filter((s) => s.status !== 'cancelled');
  const booked = total.reduce((n, s) => n + s.bookedCount, 0), cap = total.reduce((n, s) => n + s.capacity, 0);
  const isThisWeek = from === weekStart(today);
  // paging weeks swaps the page rather than stacking history, so back leaves the schedule
  const go = (d: string) => replaceRoute(`/schedule/${d}`);

  return (
    <div className="schedule">
      <PageHead
        eyebrow={fmtRange(from)}
        title={isThisWeek ? <>This <em>week</em></> : from < weekStart(today) ? <>Past <em>week</em></> : <>Week <em>ahead</em></>}
        sub={total.length ? `${total.length} classes · ${booked} of ${cap} spots booked (${cap ? Math.round((booked / cap) * 100) : 0}% full)` : 'No classes this week.'}
        actions={
          <>
            {can('editClass') && <a className="btn soft" href="#/schedule/timetable"><Icon name="repeat" size={20} />Timetable</a>}
            {can('editClass') && <button className="btn" onClick={() => setAdding(isThisWeek ? today : from)}><Icon name="plus" size={20} />Add class</button>}
          </>
        }
      />
      <div className="wk-nav">
        <div className="wk-arrows">
          <button className="btn icon soft" onClick={() => go(addDays(from, -7))} aria-label="Previous week"><Icon name="left" /></button>
          <button className="btn sm soft" onClick={() => go(weekStart(today))} disabled={isThisWeek}>Today</button>
          <button className="btn icon soft" onClick={() => go(addDays(from, 7))} aria-label="Next week"><Icon name="right" /></button>
        </div>
        {iTeach && (
          <Seg className="sm mine-seg" value={mineOnly ? 'mine' : 'all'} onChange={(v) => setMineOnly(v === 'mine')}
            options={[{ value: 'all', label: 'All classes' }, { value: 'mine', label: 'My classes' }]} />
        )}
        <div className="legend">
          {classTypes.filter((t) => t.active).map((t) => <span key={t.id}><Flower size={13} color={t.color} />{t.name}</span>)}
        </div>
      </div>

      {res.loading && !res.data ? <Loading /> : (
        <div className="week">
          {days.map((d) => {
            const list = byDay[d] ?? [];
            const past = d < today;
            return (
              <section key={d} className={cx('wk-day', d === today && 'today', past && 'past')}>
                <header className="wk-head">
                  <span className="wk-dow">{dayShort(d + 'T02:00:00Z').split(' ')[0]}</span>
                  <span className="wk-date">{Number(d.slice(8))}</span>
                  <span className="wk-long">{dayShort(d + 'T02:00:00Z')}</span>
                </header>
                <div className="wk-list">
                  {list.map((s) => {
                    const ct = typeById(s.classTypeId); const ins = staffById(s.instructorId);
                    const mine = s.instructorId === me.staffId;
                    const open = can('allRosters') || mine;
                    const cls = cx('wc', mine && 'mine', !open && 'locked', s.status === 'cancelled' && 'cancelled');
                    const inner = (
                      <>
                        <span className="wc-time">{time(s.startsAt)}</span>
                        <span className="wc-name">{ct?.name}</span>
                        <span className="wc-ins">{ins && <Avatar name={ins.name} photo={ins.photoUrl} size={20} />}{ins?.name.split(' ')[0]}{ins && ins.name.split(' ')[1] ? ' ' + ins.name.split(' ')[1]![0] : ''}</span>
                        {s.status === 'cancelled' ? <span className="wc-cx">Cancelled</span> : (
                          <span className="wc-fill"><Fill value={s.bookedCount} max={s.capacity} /><span>{s.bookedCount}/{s.capacity}{s.waitlistCount ? ` +${s.waitlistCount}` : ''}</span></span>
                        )}
                      </>
                    );
                    return open
                      ? <a key={s.id} href={`#/class/${s.id}`} className={cls} style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>{inner}</a>
                      : <div key={s.id} className={cls} style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>{inner}</div>;
                  })}
                  {list.length === 0 && <span className="wk-none">{mineOnly ? 'Not teaching' : 'No classes'}</span>}
                  {can('editClass') && !past && <button className="wk-add" onClick={() => setAdding(d)} aria-label={`Add class on ${dayShort(d + 'T02:00:00Z')}`}><Icon name="plus" size={16} /></button>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <AddSessionSheet date={adding} onClose={() => setAdding(null)} />
    </div>
  );
}

function AddSessionSheet({ date, onClose }: { date: string | null; onClose: () => void }) {
  const { classTypes, staff, settings, usualInstructor } = useStudio();
  const types = classTypes.filter((t) => t.active);
  const teachers = staff.filter((s) => s.active);
  const pickTeacher = (typeId?: string) => usualInstructor(typeId) ?? teachers[0]?.id ?? '';
  const [v, setV] = useState({ classTypeId: '', date: '', time: '09:30', instructorId: '', capacity: '', note: '' });
  const { busy, run } = useAction();
  useEffect(() => {
    if (!date) return;
    const t = types[0];
    setV({ classTypeId: t?.id ?? '', date, time: '09:30', instructorId: pickTeacher(t?.id), capacity: String(t?.defaultCapacity ?? settings.defaultCapacity), note: '' });
  }, [date]);
  const ct = types.find((t) => t.id === v.classTypeId);
  const save = async () => {
    const startsAt = studioToUTC(v.date, v.time);
    const r = await run(() => store.upsertSession({
      classTypeId: v.classTypeId, startsAt, endsAt: new Date(new Date(startsAt).getTime() + (ct?.durationMin ?? 55) * 60000).toISOString(),
      instructorId: v.instructorId, capacity: Math.max(1, parseInt(v.capacity) || settings.defaultCapacity), note: v.note.trim() || undefined,
    }), 'Class added');
    if (r) onClose();
  };
  return (
    <Sheet open={!!date} onClose={onClose} label="Add class">
      <SheetHead title={<>Add a <em>class</em></>} sub="A one-off class. For a weekly class, use the timetable." onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Class</span>
          <select className="select" value={v.classTypeId} onChange={(e) => { const t = types.find((x) => x.id === e.target.value); setV({ ...v, classTypeId: e.target.value, capacity: String(t?.defaultCapacity ?? v.capacity), instructorId: pickTeacher(e.target.value) }); }}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.durationMin} min){t.bookable ? '' : ' · coming soon'}</option>)}
          </select>
        </label>
        <label className="field"><span>Date</span><input className="input" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></label>
        <label className="field"><span>Start time</span><input className="input" type="time" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} /></label>
        <label className="field"><span>Instructor</span>
          <select className="select" value={v.instructorId} onChange={(e) => setV({ ...v, instructorId: e.target.value })}>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <label className="field"><span>Capacity</span><input className="input" type="number" min={1} value={v.capacity} onChange={(e) => setV({ ...v, capacity: e.target.value })} /></label>
        <label className="field span2"><span>Note (optional)</span><input className="input" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. Special long-weekend class" /></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !v.classTypeId || !v.date || !v.instructorId}>Add class</button></div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ recurring timetable (templates)
export function Timetable() {
  const { typeById, staffById } = useStudio();
  const res = useData(() => store.listTemplates(), []);
  const [edit, setEdit] = useState<Partial<ScheduleTemplate> | null>(null);
  const [del, setDel] = useState<ScheduleTemplate | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const list = res.data ?? [];
  const today = studioDate();

  const remove = async () => {
    if (!del) return;
    const ok = await run(async () => { await store.deleteTemplate(del.id); return true; });
    if (ok) { toast('Removed from the timetable. Classes already on the schedule stay put.'); setDel(null); }
  };

  return (
    <div className="timetable">
      <PageHead back={backFrom((r) => (r.startsWith('/schedule') ? 'Schedule' : null), { href: '#/schedule', label: 'Schedule' })} eyebrow="Repeats every week" title={<>Recurring <em>timetable</em></>}
        sub="Classes are created for the next 8 weeks. Editing a slot doesn't change classes that already have bookings; edit those from the class itself."
        actions={<button className="btn" onClick={() => setEdit({ weekday: 1, startTime: '06:00', active: true, startsOn: today })}><Icon name="plus" size={20} />Add weekly class</button>} />
      {res.loading && !res.data ? <Loading /> : list.length === 0 ? <div className="card"><Empty title="No weekly classes yet">Add the regular classes and they'll fill the schedule automatically.</Empty></div> : (
        <div className="tt-grid">
          {order.map((wd) => {
            const items = list.filter((t) => t.weekday === wd).sort((a, b) => a.startTime.localeCompare(b.startTime));
            return (
              <section key={wd} className="card tt-day">
                <h3>{DAYS[wd]}</h3>
                {items.length === 0 && <p className="faint small" style={{ padding: '6px 0' }}>Nothing on</p>}
                {items.map((t) => {
                  const ct = typeById(t.classTypeId); const ins = staffById(t.instructorId);
                  const ended = t.endsOn && t.endsOn < today;
                  return (
                    <button key={t.id} className={cx('tt-row', (!t.active || ended) && 'off')} onClick={() => setEdit(t)} style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>
                      <span className="tt-time">{hhmm12(t.startTime)}</span>
                      <span className="tt-t"><strong>{ct?.name ?? 'Class'}</strong><span>{ins?.name ?? 'No instructor'} · {t.capacity ?? ct?.defaultCapacity} spots{t.endsOn ? ` · until ${dayShort(t.endsOn + 'T02:00:00Z')}` : ''}{!t.active ? ' · paused' : ''}</span></span>
                      <Icon name="edit" size={18} />
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
      <TemplateSheet t={edit} onClose={() => setEdit(null)} onDelete={(t) => { setEdit(null); setDel(t); }} />
      <Confirm open={!!del} onClose={() => setDel(null)} title={<>Remove from <em>timetable</em>?</>} danger busy={busy} confirmLabel="Remove" onConfirm={remove}
        body="New classes stop being created for this slot. Classes already on the schedule (and their bookings) aren't touched; cancel those individually if needed." />
    </div>
  );
}

function TemplateSheet({ t, onClose, onDelete }: { t: Partial<ScheduleTemplate> | null; onClose: () => void; onDelete: (t: ScheduleTemplate) => void }) {
  const { classTypes, staff, settings, usualInstructor } = useStudio();
  const toast = useToast();
  const types = classTypes.filter((x) => x.active);
  const teachers = staff.filter((x) => x.active);
  const [v, setV] = useState<Partial<ScheduleTemplate>>({});
  const { busy, run } = useAction();
  useEffect(() => {
    if (!t) return;
    setV({ classTypeId: types[0]?.id, instructorId: usualInstructor(types[0]?.id) ?? teachers[0]?.id, ...t });
  }, [t]);
  const ct = types.find((x) => x.id === v.classTypeId);
  const save = async () => {
    const r = await run(async () => {
      const saved = await store.upsertTemplate({
        id: v.id, classTypeId: v.classTypeId!, weekday: Number(v.weekday ?? 1), startTime: v.startTime || '06:00', instructorId: v.instructorId!,
        capacity: v.capacity || undefined, startsOn: v.startsOn || studioDate(), endsOn: v.endsOn || undefined, active: v.active !== false,
      });
      const from = studioDate();
      const n = await store.generateSessions(from, addDays(from, 56));
      return { saved, n };
    });
    if (r) { toast(r.n ? `Saved. ${r.n} classes added to the schedule.` : 'Saved'); onClose(); }
  };
  const set = (k: keyof ScheduleTemplate) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <Sheet open={!!t} onClose={onClose} label="Weekly class">
      <SheetHead title={v.id ? <>Edit weekly <em>class</em></> : <>New weekly <em>class</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Class</span>
          <select className="select" value={v.classTypeId ?? ''} onChange={set('classTypeId')}>{types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        </label>
        <label className="field"><span>Day</span>
          <select className="select" value={String(v.weekday ?? 1)} onChange={(e) => setV({ ...v, weekday: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{DAYS[d]}</option>)}</select>
        </label>
        <label className="field"><span>Start time</span><input className="input" type="time" value={v.startTime ?? ''} onChange={set('startTime')} /></label>
        <label className="field"><span>Instructor</span>
          <select className="select" value={v.instructorId ?? ''} onChange={set('instructorId')}>{teachers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        </label>
        <label className="field"><span>Capacity</span><input className="input" type="number" min={1} value={v.capacity ?? ''} placeholder={String(ct?.defaultCapacity ?? settings.defaultCapacity)} onChange={(e) => setV({ ...v, capacity: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label className="field"><span>Starts on</span><input className="input" type="date" value={v.startsOn ?? ''} onChange={set('startsOn')} /></label>
        <label className="field"><span>Ends on (optional)</span><input className="input" type="date" value={v.endsOn ?? ''} onChange={set('endsOn')} /></label>
        <label className="check span2"><input type="checkbox" checked={v.active !== false} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Active (untick to pause this slot)</span></label>
      </div>
      <div className="sh-foot">
        {v.id && <button className="btn danger push-left" onClick={() => onDelete(v as ScheduleTemplate)}><Icon name="trash" size={18} />Remove</button>}
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || !v.classTypeId || !v.instructorId}>Save</button>
      </div>
    </Sheet>
  );
}

