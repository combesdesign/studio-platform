/** Studio › Appointments: the calendar, workshops and events, and instructors' hours. */
import React, { useState } from 'react';
import { Sheet, store, useData } from '../../../shared/react';
import { addDays, startOfStudioDay, studioDate, weekStart } from '../../../shared/format';
import { Empty, Icon, Loading, PageHead, Seg, roleCan, useStudio } from '../../../studio/ui';
import { dayLabel, needAppts } from '../api';
import type { Appointment } from '../types';
import { AppointmentSheet, BookForClientSheet } from './book';
import { WeekGrid, WeekList } from './calendar';
import { EventsTab } from './events';
import { HoursTab } from './hours';

type Tab = 'calendar' | 'events' | 'hours';
const TABS: Tab[] = ['calendar', 'events', 'hours'];

export function AppointmentsPage({ tab: tabParam }: { tab?: string }) {
  const { me } = useStudio();
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'calendar';
  const canBook = roleCan(me.role, 'appointments.book');
  const go = (t: Tab) => { location.hash = t === 'calendar' ? '#/appointments' : `#/appointments/${t}`; };
  return (
    <>
      <PageHead
        eyebrow="Privates, workshops and courses"
        title={<>Appoint<em>ments</em></>}
        sub={canBook ? 'Everyone’s private and duet sessions in one calendar, plus workshops, courses and instructors’ hours.' : 'Your private sessions, workshops and hours.'}
        actions={<Seg<Tab> value={tab} onChange={go} options={[{ value: 'calendar', label: 'Calendar' }, { value: 'events', label: 'Workshops & events' }, { value: 'hours', label: 'Hours' }]} />}
      />
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'events' && <EventsTab />}
      {tab === 'hours' && <HoursTab />}
    </>
  );
}

function CalendarTab() {
  const { me, staff, typeById } = useStudio();
  const canBook = roleCan(me.role, 'appointments.book');
  const [week, setWeek] = useState(() => weekStart(studioDate()));
  const [staffId, setStaffId] = useState('');
  const [open, setOpen] = useState<Appointment | null>(null);
  const [book, setBook] = useState(false);
  const ap = needAppts();
  const from = startOfStudioDay(week), to = startOfStudioDay(addDays(week, 7));
  const appts = useData(() => ap.listAppointments({ from, to, ...(staffId ? { staffId } : {}) }), [week, staffId]);
  const off = useData(() => ap.listTimeOff(staffId || undefined), [staffId]);
  const classes = useData(async () => {
    if (!staffId) return [];
    const list = await store.listSessions({ from, to });
    return list.filter((s) => s.instructorId === staffId).map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, instructorId: s.instructorId, name: typeById(s.classTypeId)?.name ?? 'Class' }));
  }, [week, staffId]);
  const visible = (appts.data ?? []).filter((a) => a.status === 'booked' || a.status === 'completed' || a.status === 'no_show');
  const label = `${dayLabel(week)} to ${dayLabel(addDays(week, 6))}`;
  const thisWeek = week === weekStart(studioDate());
  return (
    <>
      <div className="ap-toolbar">
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn icon soft" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}><Icon name="left" size={18} /></button>
          <strong style={{ minWidth: 170, textAlign: 'center' }}>{label}</strong>
          <button className="btn icon soft" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}><Icon name="right" size={18} /></button>
          {!thisWeek && <button className="btn ghost sm" onClick={() => setWeek(weekStart(studioDate()))}>This week</button>}
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {canBook && staff.length > 1 && (
            <select className="select sm" aria-label="Instructor" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">Everyone</option>{staff.filter((s) => s.active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {canBook && <button className="btn" onClick={() => setBook(true)}><Icon name="plus" size={18} />Book a client</button>}
        </div>
      </div>
      {appts.error && !appts.data ? <Empty title="That didn’t load">{appts.error.message}</Empty> : !appts.data ? <Loading /> : (
        <>
          <WeekGrid weekStart={week} appts={visible} classes={classes.data ?? []} timeOff={(off.data ?? []).filter((t) => t.startsAt < to && t.endsAt > from)} onOpen={setOpen} />
          <WeekList weekStart={week} appts={visible} onOpen={setOpen} />
          {visible.length === 0 && <p className="muted" style={{ marginTop: 14 }}>No appointments this week. Set instructors’ hours under Hours, and clients can book from the app.</p>}
        </>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} label="Appointment">
        {open && <AppointmentSheet appt={open} onClose={() => { setOpen(null); appts.reload(); }} />}
      </Sheet>
      <BookForClientSheet open={book} onClose={() => { setBook(false); appts.reload(); }} />
    </>
  );
}
