/**
 * Kiosk mode: full-screen check-in for the front-desk iPad, in the studio's branding.
 * Classes starting within 60 minutes (or running) -> tap your class -> tap your name (or search your first name) ->
 * "You're in, Hannah!". Leaving needs the staff PIN (Settings › Kiosk), or the signed-in staff member's password.
 * It sits over the staff app as a fixed layer, and puts you back here if the browser's back button tries to leave.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Flower, Logo } from '../../../shared/brand';
import { errorMessage, store, useData } from '../../../shared/react';
import { time } from '../../../shared/format';
import type { SessionWithCounts } from '../../../shared/types';
import { Icon, cx, useStudio } from '../../../studio/ui';
import { KIOSK_WINDOW_MIN, isPin, kioskPeople, kioskSessions, searchPeople, startsLabel, type KioskPerson } from '../logic';

// ------------------------------------------------------------------ keep the kiosk locked until someone exits
let locked = false;
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => { if (locked && !/^#?\/kiosk/.test(location.hash)) location.replace('#/kiosk'); });
}

const IDLE_MS = 90_000;
const DONE_MS = 4_500;

export function KioskPage() {
  const { studio, typeById, staffById } = useStudio();
  const [now, setNow] = useState(() => new Date());
  const [classId, setClassId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [done, setDone] = useState<{ firstName: string; seeDesk: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [exiting, setExiting] = useState(false);
  const touched = useRef(Date.now());

  useEffect(() => { locked = true; return () => { locked = false; }; }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);

  const minute = Math.floor(now.getTime() / 60_000);
  const sessions = useData(() => {
    const t = Date.now();
    return store.listSessions({ from: new Date(t - 6 * 3_600_000).toISOString(), to: new Date(t + KIOSK_WINDOW_MIN * 60_000).toISOString() });
  }, [minute]);
  const classes = kioskSessions(sessions.data ?? [], now);
  const cls = classes.find((s) => s.id === classId) ?? null;

  const roster = useData(() => (classId ? store.getRoster(classId) : Promise.resolve([])), [classId]);
  const people = searchPeople(kioskPeople(roster.data ?? []), q);

  // The class you picked has finished or been cancelled: back to the list.
  useEffect(() => { if (classId && sessions.data && !cls) { setClassId(null); setQ(''); } }, [classId, sessions.data, cls]);

  // After a confirmation, go back to the names; after a quiet minute or so, back to the class list.
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(null), DONE_MS); return () => clearTimeout(t); }, [done]);
  useEffect(() => {
    const t = setInterval(() => { if (classId && !exiting && Date.now() - touched.current > IDLE_MS) { setClassId(null); setQ(''); setDone(null); setProblem(''); } }, 5_000);
    return () => clearInterval(t);
  }, [classId, exiting]);

  const checkIn = async (p: KioskPerson) => {
    if (busy || p.checkedIn) return;
    setBusy(p.bookingId); setProblem('');
    try {
      await store.checkIn(p.bookingId);
      setDone({ firstName: p.firstName, seeDesk: p.seeDesk });
      setQ('');
    } catch (e) {
      setProblem(`${errorMessage(e)} Please see the front desk.`);
    } finally { setBusy(null); }
  };

  const leave = () => { locked = false; location.hash = '#/'; };

  return (
    <div className="kiosk" role="dialog" aria-modal="true" aria-label="Check-in" onPointerDown={() => { touched.current = Date.now(); }}>
      <header className="k-top">
        <Logo className="k-logo" letters="var(--primary)" flower="var(--accent)" label={studio.name} />
        <div className="k-clock">{time(now)}</div>
      </header>

      <main className="k-main">
        {done ? (
          <button className="k-done" onClick={() => setDone(null)} aria-live="polite">
            <Flower size={120} spin color="var(--accent)" />
            <h1>You're in, <em>{done.firstName}</em>!</h1>
            <p>Enjoy class</p>
            {done.seeDesk && <span className="k-desk">Please see the front desk</span>}
          </button>
        ) : !cls ? (
          <>
            <h1>Welcome. <em>Check in</em></h1>
            <p className="k-sub">Tap your class</p>
            {sessions.loading && !sessions.data ? <p className="k-empty">One moment…</p> : classes.length === 0 ? (
              <div className="k-empty"><Flower size={44} color="var(--accent)" /><p>No classes are starting soon.<br />Please see the front desk.</p></div>
            ) : (
              <div className="k-cards">
                {classes.map((s) => (
                  <button key={s.id} className="k-card" onClick={() => { setClassId(s.id); setQ(''); setProblem(''); }}>
                    <span className="k-time">{time(s.startsAt)}</span>
                    <strong>{typeById(s.classTypeId)?.name ?? 'Class'}</strong>
                    <span className="k-meta">{staffById(s.instructorId)?.name ?? ''}</span>
                    <span className="k-when">{startsLabel(s, now)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <button className="k-back" onClick={() => { setClassId(null); setQ(''); setProblem(''); }}><Icon name="left" size={22} />All classes</button>
            <h1>{typeById(cls.classTypeId)?.name ?? 'Class'} <em>{time(cls.startsAt)}</em></h1>
            <p className="k-sub">Tap your name, or type your first name</p>
            <input className="k-search" type="search" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="words" enterKeyHint="search"
              placeholder="Search by first name" aria-label="Search by first name" value={q} onChange={(e) => setQ(e.target.value)} />
            {problem && <p className="k-problem" role="alert">{problem}</p>}
            {roster.loading && !roster.data ? <p className="k-empty">One moment…</p> : people.length === 0 ? (
              <p className="k-empty">{q ? <>We can't find “{q}” in this class.<br />Please see the front desk.</> : <>No one is booked in yet.<br />Please see the front desk.</>}</p>
            ) : (
              <div className="k-people">
                {people.map((p) => (
                  <button key={p.bookingId} className={cx('k-person', p.checkedIn && 'in')} disabled={p.checkedIn || busy === p.bookingId} onClick={() => checkIn(p)}>
                    <span className="k-av">{p.firstName[0]?.toUpperCase()}</span>
                    <span className="k-nm">{p.firstName} {p.lastInitial}</span>
                    {p.checkedIn && <Icon name="check" size={22} className="k-tick" />}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="k-foot"><button className="k-exit" onClick={() => setExiting(true)}>Exit kiosk</button></footer>
      {exiting && <ExitCheck onCancel={() => setExiting(false)} onDone={leave} />}
    </div>
  );
}

// ------------------------------------------------------------------ leaving: PIN, or the staff member's password
function ExitCheck({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const { me } = useStudio();
  const kiosk = store.features.kiosk;
  const has = useData(async () => (kiosk ? kiosk.hasPin() : false), []);
  const [pin, setPin] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const tryPin = async (v: string) => {
    setBusy(true);
    try {
      if (kiosk && (await kiosk.checkPin(v))) return onDone();
      setErr('That PIN isn\'t right.');
    } catch (e) { setErr(errorMessage(e)); }
    setPin(''); setBusy(false);
  };
  const press = (d: string) => {
    if (busy || pin.length >= 4) return;
    const v = pin + d; setPin(v); setErr('');
    if (isPin(v)) void tryPin(v);
  };
  const tryPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr('');
    try { await store.signIn(me.email, pw); onDone(); } catch { setErr('That password isn\'t right.'); setBusy(false); }
  };

  return (
    <div className="k-scrim" onClick={onCancel}>
      <div className="k-modal" role="dialog" aria-label="Exit kiosk" onClick={(e) => e.stopPropagation()}>
        {has.loading && has.data === undefined ? <p className="k-sub">One moment…</p> : has.data ? (
          <>
            <h2>Staff <em>PIN</em></h2>
            <div className="k-dots" aria-label={`${pin.length} of 4 digits`}>{[0, 1, 2, 3].map((i) => <span key={i} className={cx(i < pin.length && 'on')} />)}</div>
            <p className="k-err" role="alert">{err}</p>
            <div className="k-pad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
              <button className="quiet" onClick={onCancel}>Cancel</button>
              <button onClick={() => press('0')}>0</button>
              <button className="quiet" onClick={() => { setPin((p) => p.slice(0, -1)); setErr(''); }} aria-label="Delete">⌫</button>
            </div>
          </>
        ) : (
          <form onSubmit={tryPassword}>
            <h2>Staff <em>password</em></h2>
            <p className="k-sub">Enter the password for {me.email} to leave kiosk mode.</p>
            <input className="k-search" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            <p className="k-err" role="alert">{err}</p>
            <div className="k-actions"><button type="button" className="k-btn quiet" onClick={onCancel}>Cancel</button><button type="submit" className="k-btn" disabled={busy || !pw}>Exit kiosk</button></div>
          </form>
        )}
      </div>
    </div>
  );
}
