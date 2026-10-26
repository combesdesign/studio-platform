/** Studio › Appointments › Calendar: a week grid on wide screens, a day-by-day list on phones. */
import React from 'react';
import { addDays, studioDate, time } from '../../../shared/format';
import { cx } from '../../../studio/ui';
import { APPT_STATUS_LABEL, clock, dayLabel, dateOf, studioMinutes } from '../api';
import type { Appointment, TimeOff } from '../types';

const HOUR_PX = 56;
type Cls = { id: string; startsAt: string; endsAt: string; instructorId: string; name: string };

/** The visible hours: 6am to 8pm, stretched to fit anything earlier or later this week. */
function hourSpan(items: { startsAt: string; endsAt: string }[]): [number, number] {
  let a = 6, b = 20;
  for (const i of items) {
    a = Math.min(a, Math.floor(studioMinutes(i.startsAt) / 60));
    const end = studioMinutes(i.endsAt);
    b = Math.max(b, Math.ceil((end === 0 ? 24 * 60 : end) / 60));
  }
  return [a, Math.min(24, b)];
}

export function WeekGrid({ weekStart, appts, classes, timeOff, onOpen }: { weekStart: string; appts: Appointment[]; classes: Cls[]; timeOff: TimeOff[]; onOpen: (a: Appointment) => void }) {
  const today = studioDate();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const [h0, h1] = hourSpan([...appts, ...classes, ...timeOff]);
  const top = (iso: string) => ((studioMinutes(iso) - h0 * 60) / 60) * HOUR_PX;
  const height = (a: string, b: string) => Math.max(26, ((Date.parse(b) - Date.parse(a)) / 3_600_000) * HOUR_PX - 2);
  const nowIso = new Date().toISOString();
  return (
    <div className="ap-cal ap-grid-view" role="grid" aria-label="Week of appointments">
      <div className="ap-cal-head">
        <div />
        {days.map((d) => <div key={d} className={cx(d === today && 'today')}>{dayLabel(d).split(' ')[0]}<strong>{dayLabel(d).split(' ')[1]}</strong></div>)}
      </div>
      <div className="ap-cal-hours" style={{ height: (h1 - h0) * HOUR_PX }}>
        {Array.from({ length: h1 - h0 }, (_, i) => <span key={i} style={{ top: i * HOUR_PX + 2 }}>{i + h0 === 12 ? '12pm' : i + h0 < 12 ? `${i + h0 || 12}am` : `${i + h0 - 12}pm`}</span>)}
      </div>
      {days.map((d) => (
        <div key={d} className={cx('ap-col', d === today && 'today')} style={{ height: (h1 - h0) * HOUR_PX }}>
          {d === today && studioMinutes(nowIso) >= h0 * 60 && studioMinutes(nowIso) < h1 * 60 && <div className="ap-now" style={{ top: top(nowIso) }} />}
          {timeOff.filter((t) => dateOf(t.startsAt) === d).map((t) => (
            <div key={t.id} className="ap-ev off" style={{ top: top(t.startsAt), height: height(t.startsAt, t.endsAt) }}><strong>Time off</strong>{t.note && <span>{t.note}</span>}</div>
          ))}
          {classes.filter((c) => dateOf(c.startsAt) === d).map((c) => (
            <div key={c.id} className="ap-ev class" style={{ top: top(c.startsAt), height: height(c.startsAt, c.endsAt) }}><strong>{c.name}</strong><span>{time(c.startsAt)}</span></div>
          ))}
          {appts.filter((a) => dateOf(a.startsAt) === d).map((a) => (
            <button key={a.id} className={cx('ap-ev', a.status)} style={{ top: top(a.startsAt), height: height(a.startsAt, a.endsAt) }} onClick={() => onOpen(a)}
              aria-label={`${a.clientName}, ${a.typeName}, ${clock(a.startsAt)}`}>
              <strong>{a.clientName}{a.people > 1 ? ' +1' : ''}</strong><span>{clock(a.startsAt)} · {a.typeName}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Phones (and anywhere a grid is too tight): the same week, one day at a time. */
export function WeekList({ weekStart, appts, onOpen }: { weekStart: string; appts: Appointment[]; onOpen: (a: Appointment) => void }) {
  const today = studioDate();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const any = appts.length > 0;
  return (
    <div className="ap-list-view stack lg">
      {days.map((d) => {
        const list = appts.filter((a) => dateOf(a.startsAt) === d);
        if (list.length === 0 && !(d === today)) return null;
        return (
          <section key={d}>
            <h3 className="small-h" style={{ marginBottom: 8 }}>{dayLabel(d)}{d === today ? ' · today' : ''}</h3>
            {list.length === 0 ? <p className="muted small">Nothing booked.</p> : (
              <div className="ap-day-list">
                {list.map((a) => (
                  <button key={a.id} className="ap-list-row" onClick={() => onOpen(a)}>
                    <span className="ap-when">{clock(a.startsAt)}</span>
                    <span className="ap-who"><strong>{a.clientName}{a.people > 1 ? ' + 1' : ''}</strong><span>{a.typeName} · {a.staffName.split(' ')[0]}</span></span>
                    <span className={cx('chip', a.status === 'booked' ? 'ok' : a.status === 'no_show' ? 'danger' : '')}>{APPT_STATUS_LABEL[a.status]}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
      {!any && <p className="muted">No appointments this week.</p>}
    </div>
  );
}
