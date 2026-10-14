/** My bookings tab: upcoming, waitlists, past + policy reminders. */
import React, { useState } from 'react';
import type { BookingWithDetails } from '../shared/store';
import { store, useData } from '../shared/react';
import { studioDate, time } from '../shared/format';
import { CardSkeletons, Empty, ErrorBlock, Icon, ScreenHead, Segmented, useApp } from './ui';
import { ClassSheet } from './timetable';
import { WEEKDAYS, dayLabel, firstName, freeCancelUntil, isLateCancel, timeRange, when } from './lib';
import { weekday } from '../shared/format';

type Nav = (to: string, o?: { replace?: boolean }) => void;

export function Bookings({ nav }: { nav: Nav }) {
  const app = useApp();
  const cid = app.client.id;
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [open, setOpen] = useState<string | null>(null);
  const up = useData(() => store.listClientBookings(cid, { when: 'upcoming' }), [cid]);
  const past = useData(() => (tab === 'past' ? store.listClientBookings(cid, { when: 'past' }) : Promise.resolve(null)), [cid, tab]);

  const upList = (up.data ?? []).slice().sort(byStart);
  const booked = upList.filter((b) => b.status === 'booked' || b.status === 'checked_in');
  const waiting = upList.filter((b) => b.status === 'waitlisted');
  const studioCancelled = upList.filter((b) => b.status === 'removed' && b.session.status === 'cancelled');
  const pastList = (past.data ?? []).filter((b) => !(b.status === 'removed' && b.session.status !== 'cancelled') && b.status !== 'waitlisted')
    .sort((a, b) => byStart(b, a));
  const attended = pastList.filter((b) => b.status === 'checked_in').length;

  return (
    <div className="screen">
      <ScreenHead title={<>Your <em>bookings</em></>} />
      <Segmented value={tab} onChange={setTab} options={[
        { value: 'upcoming', label: 'Upcoming', count: booked.length + waiting.length || undefined },
        { value: 'past', label: 'Past' },
      ]} />

      {tab === 'upcoming' ? (
        up.error && !up.data ? <ErrorBlock error={up.error} onRetry={up.reload} /> :
          !up.data ? <div className="mt-20"><CardSkeletons n={3} h={96} /></div> : (
            <div className="stack lg mt-20">
              {studioCancelled.map((b) => (
                <div key={b.id} className="note danger"><Icon name="info" size={20} />
                  <div><strong>{b.classType.name} on {WEEKDAYS[weekday(studioDate(b.session.startsAt))]} {time(b.session.startsAt)} was cancelled by the studio.</strong> Your credit has been returned.</div>
                </div>
              ))}
              {booked.length === 0 && waiting.length === 0 ? (
                <Empty title="Nothing booked yet" action={<button className="btn" onClick={() => nav('/')}>Find a class</button>}>
                  Your next class is only a couple of taps away.
                </Empty>
              ) : (
                <>
                  {booked.length > 0 && (
                    <section className="stack">
                      {booked.map((b, i) => <BookingCard key={b.id} b={b} i={i} onOpen={() => setOpen(b.sessionId)} />)}
                    </section>
                  )}
                  {waiting.length > 0 && (
                    <section className="stack">
                      <h3 className="section-title">On the <em>waitlist</em></h3>
                      {waiting.map((b, i) => <BookingCard key={b.id} b={b} i={i} onOpen={() => setOpen(b.sessionId)} />)}
                    </section>
                  )}
                </>
              )}
              <Policies />
            </div>
          )
      ) : (
        past.error && !past.data ? <ErrorBlock error={past.error} onRetry={past.reload} /> :
          !past.data ? <div className="mt-20"><CardSkeletons n={4} h={84} /></div> : (
            <div className="stack lg mt-20">
              {pastList.length === 0 ? (
                <Empty title="No past classes yet">Once you’ve done a class it’ll show up here.</Empty>
              ) : (
                <>
                  {attended > 0 && (
                    <div className="stat-card">
                      <span className="stat-num serif">{attended}</span>
                      <span><strong>{attended === 1 ? 'class' : 'classes'} done</strong><br /><span className="muted">Strong from the inside out.</span></span>
                    </div>
                  )}
                  <div className="list-card">
                    {pastList.map((b) => <PastRow key={b.id} b={b} onOpen={() => setOpen(b.sessionId)} />)}
                  </div>
                </>
              )}
            </div>
          )
      )}
      <ClassSheet sessionId={open} onClose={() => setOpen(null)} nav={nav} />
    </div>
  );
}

const byStart = (a: BookingWithDetails, b: BookingWithDetails) => a.session.startsAt.localeCompare(b.session.startsAt);

function BookingCard({ b, onOpen, i }: { b: BookingWithDetails; onOpen: () => void; i: number }) {
  const { settings } = useApp();
  const d = studioDate(b.session.startsAt);
  const late = isLateCancel(b.session, settings);
  const lbl = dayLabel(d);
  return (
    <button className="bk" onClick={onOpen} style={{ ['--c' as any]: b.classType.color || 'var(--sky)', animationDelay: `${i * 50}ms` }}>
      <span className="bk-date">
        <span className="bk-wd">{WEEKDAYS[weekday(d)]}</span>
        <span className="bk-num serif">{Number(d.slice(8))}</span>
        <span className="bk-mo">{new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'short' }).format(new Date(d + 'T00:00:00Z'))}</span>
      </span>
      <span className="bk-main">
        <span className="bk-name">{b.classType.name}</span>
        <span className="muted">{lbl === 'Today' || lbl === 'Tomorrow' ? `${lbl} · ` : ''}{timeRange(b.session)}{b.instructor ? ` · ${firstName(b.instructor.name)}` : ''}</span>
        {b.status === 'waitlisted' ? (
          <span className="tag warn">Waitlisted #{b.waitlistPosition ?? '–'}</span>
        ) : late ? (
          <span className="bk-hint late">Inside {settings.cancelWindowHours}h – late cancel applies</span>
        ) : (
          <span className="bk-hint">Free cancel until {time(freeCancelUntil(b.session, settings))} {WEEKDAYS[weekday(studioDate(freeCancelUntil(b.session, settings)))]}</span>
        )}
      </span>
      <Icon name="chevron" size={18} className="faint" />
    </button>
  );
}

const PAST_LABEL: Record<string, [string, string]> = {
  checked_in: ['Attended', 'ok'],
  booked: ['Booked', ''],
  no_show: ['No-show', 'danger'],
  late_cancelled: ['Late cancel', 'warn'],
  cancelled: ['Cancelled', 'muted-tag'],
  removed: ['Class cancelled', 'muted-tag'],
};

function PastRow({ b, onOpen }: { b: BookingWithDetails; onOpen: () => void }) {
  const [label, tone] = PAST_LABEL[b.status] ?? [b.status, ''];
  return (
    <button className="list-row" onClick={onOpen}>
      <span className="past-bar" style={{ background: b.classType.color || 'var(--sky)' }} />
      <span className="list-row-main">
        <span className="list-row-title">{b.classType.name}</span>
        <span className="list-row-sub">{when(b.session.startsAt)}{b.instructor ? ` · ${firstName(b.instructor.name)}` : ''}</span>
      </span>
      <span className={'tag ' + tone}>{label}</span>
    </button>
  );
}

export function Policies() {
  const { settings } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const items = [
    { k: 'cancel', title: 'Cancellation policy', icon: 'clock', text: settings.cancellationPolicyText || `Cancel at least ${settings.cancelWindowHours} hours before class to get your credit back.` },
    { k: 'wait', title: 'How the waitlist works', icon: 'users', text: settings.waitlistPolicyText || `If a spot opens we’ll book you in automatically, up to ${settings.waitlistCutoffHours} hour before class.` },
  ];
  return (
    <section className="policies">
      {items.map((it) => (
        <div key={it.k} className={'acc' + (open === it.k ? ' open' : '')}>
          <button className="acc-head" aria-expanded={open === it.k} onClick={() => setOpen(open === it.k ? null : it.k)}>
            <Icon name={it.icon} size={20} /><span>{it.title}</span><Icon name="chevron" size={18} className="acc-chev" />
          </button>
          {open === it.k && <div className="acc-body"><p>{it.text}</p></div>}
        </div>
      ))}
    </section>
  );
}
