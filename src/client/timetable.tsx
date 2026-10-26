/** Timetable tab + class detail sheet. */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BookingWithDetails, CreditSummary } from '../shared/store';
import type { ClassType, Location, SessionWithCounts } from '../shared/types';
import { store, useData, useToast, errorMessage, Sheet, leaveSheets, useBackHandler } from '../shared/react';
import { addDays, dateFormat, dayLong, money, pluralise, startOfStudioDay, studioDate, time } from '../shared/format';
import { Slot } from '../shared/slots';
import { Accent, Arrow, Avatar, CardSkeletons, Empty, ErrorBlock, Flower, Icon, Logo, ScreenHead, SheetHead, Skeleton, classPhoto, useApp } from './ui';
import {
  WEEKDAYS, classTypeFor, dayLabel, firstName, freeCancelUntil, goFlow, hoursUntil, icsDataUrl, icsFileName,
  isLateCancel, sessionState, staffRole, takePendingClass, timeRange, when,
} from './lib';
import { weekday } from '../shared/format';
import { directionsPlatform, directionsUrl, effectiveLocationId, filterByLocation, hasManyLocations } from '../domain';
import { readLocationPref, validLocationPref, writeLocationPref } from '../shared/locationPref';
import { WhosComing, creditLine, fullName, useDependants, type WhoOption } from './family';

type Nav = (to: string, o?: { replace?: boolean }) => void;

let rememberedDay: string | null = null;

export function Timetable({ nav, openId }: { nav: Nav; openId?: string }) {
  const app = useApp();
  const cid = app.client.id;
  const today = studioDate();
  const windowDays = Math.max(1, app.settings.bookingWindowDays || 14);
  const days = useMemo(() => Array.from({ length: windowDays }, (_, i) => addDays(today, i)), [today, windowDays]);
  const [day, setDayState] = useState<string>(rememberedDay && days.includes(rememberedDay) ? rememberedDay : today);
  const setDay = (d: string) => { rememberedDay = d; setDayState(d); };
  // Coming back from the waiver or the shop reopens the class you were looking at.
  const [sheet, setSheet] = useState<string | null>(() => openId ?? takePendingClass('/'));

  // '#/class/:id' (deep links, after the waiver or a Stripe return) becomes the timetable with that class
  // open. The open sheet gets its own history entry, so back closes it and ✕ lands on the timetable.
  useLayoutEffect(() => {
    if (!openId) return;
    setSheet(openId);
    nav('/', { replace: true });
  }, [openId]);
  useEffect(() => {
    if (!sheet) return;
    store.getSession(sheet).then((s) => { if (studioDate(s.startsAt) !== day) setDay(studioDate(s.startsAt)); }).catch(() => {});
  }, [sheet]);

  const sessions = useData(async () => ({
    day,
    list: await store.listSessions({ from: startOfStudioDay(day), to: startOfStudioDay(addDays(day, 1)) }),
  }), [day]);
  const mine = useData(() => store.listClientBookings(cid, { when: 'upcoming', statuses: ['booked', 'waitlisted', 'checked_in'] }), [cid]);
  const credits = useData(() => store.getCreditSummary(cid), [cid]);

  // More than one location: a filter above the days, remembered on this device. A one-location studio never sees it.
  const manyLocs = hasManyLocations(app.locations);
  const [locPick, setLocPick] = useState<string>(() => readLocationPref('client', app.studio.id));
  const loc = manyLocs ? validLocationPref(locPick, app.locations) : '';
  const pickLoc = (id: string) => { setLocPick(id); writeLocationPref('client', app.studio.id, id); };

  const byId = useMemo(() => {
    const m = new Map<string, BookingWithDetails>();
    (mine.data ?? []).forEach((b) => m.set(b.sessionId, b));
    return m;
  }, [mine.data]);
  const bookedDays = useMemo(() => new Set((mine.data ?? []).map((b) => studioDate(b.session.startsAt))), [mine.data]);

  const fresh = sessions.data && sessions.data.day === day;
  const list = fresh ? filterByLocation(sessions.data!.list, loc, app.locations) : [];
  const comingSoon = app.classTypes.filter((t) => t.active && !t.bookable);

  const close = () => setSheet(null);

  return (
    <div className="screen tt">
      <div className="topbar">
        <Logo width={84} />
        <CreditPill credits={credits.data} loading={credits.loading && !credits.data} onClick={() => nav('/passes')} />
      </div>
      <ScreenHead eyebrow={greeting(firstName(app.client.firstName))} title={<>Book a <em>class</em></>} />
      <Slot name="client.timetable" props={{}} />

      {manyLocs && <LocationChips locations={app.locations} value={loc} onPick={pickLoc} />}
      <DateStrip days={days} day={day} onPick={setDay} booked={bookedDays} />

      <div className="day-head">
        <h2 className="day-title">{dayLong(startOfStudioDay(day))}</h2>
        {fresh && list.length > 0 && <span className="muted">{pluralise(list.filter((s) => s.status !== 'cancelled').length, 'class', 'classes')}</span>}
      </div>

      {sessions.error && !fresh ? <ErrorBlock error={sessions.error} onRetry={sessions.reload} /> :
        !fresh ? <CardSkeletons n={3} /> :
          list.length === 0 ? (
            <Empty title="No classes this day">Have a rest day, or take a peek at another day.
              {day !== days[days.length - 1] && <><br /><button className="link-btn inline" onClick={() => setDay(addDays(day, 1))}>See {dayLabel(addDays(day, 1)).toLowerCase() === 'tomorrow' ? 'tomorrow' : WEEKDAYS[weekday(addDays(day, 1))]} →</button></>}
            </Empty>
          ) : (
            <div className="stack cls-list">
              {list.map((s, i) => (
                <SessionCard key={s.id} s={s} i={i} ct={classTypeFor(app.classTypes, s.classTypeId)} mine={byId.get(s.id)} onOpen={() => setSheet(s.id)} />
              ))}
            </div>
          )}

      {comingSoon.length > 0 && <ComingSoon types={comingSoon} />}

      <ClassSheet sessionId={sheet} onClose={close} nav={nav} backLabel="Timetable" where="/" />
    </div>
  );
}

function LocationChips({ locations, value, onPick }: { locations: Location[]; value: string; onPick: (id: string) => void }) {
  const opts = [{ id: '', name: 'All locations' }, ...locations.filter((l) => l.active)];
  return (
    <div className="loc-chips" role="group" aria-label="Location">
      {opts.map((o) => <button key={o.id || 'all'} type="button" className="loc-chip" aria-pressed={o.id === value} onClick={() => onPick(o.id)}>{o.name}</button>)}
    </div>
  );
}

function greeting(name: string) {
  const h = Number(dateFormat({ hour: 'numeric', hour12: false }).format(new Date()));
  const part = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  return name ? `${part}, ${name}` : `Good ${part.toLowerCase()}`;
}

function CreditPill({ credits, loading, onClick }: { credits?: CreditSummary[]; loading: boolean; onClick: () => void }) {
  if (loading) return <Skeleton w={110} h={36} r={999} />;
  const c = (credits ?? []).filter((x) => !x.pass.noClasses); // an online-only pass is not class credit
  let label = 'Get a pass';
  let tone = 'cta';
  if (c.some((x) => x.remaining === null)) { label = 'Unlimited'; tone = ''; }
  else {
    const n = c.reduce((a, x) => a + (x.remaining ?? 0), 0);
    if (n > 0) { label = pluralise(n, 'credit'); tone = ''; }
  }
  return (
    <button className={'credit-pill ' + tone} onClick={onClick}>
      <Icon name={tone ? 'plus' : 'ticket'} size={17} />{label}
    </button>
  );
}

function DateStrip({ days, day, onPick, booked }: { days: string[]; day: string; onPick: (d: string) => void; booked: Set<string> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    const box = ref.current;
    if (el && box) {
      const target = el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2;
      box.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
  }, [day]);
  const month = dateFormat({ timeZone: 'UTC', month: 'long', year: 'numeric' })
    .format(new Date(day + 'T00:00:00Z'));
  return (
    <div className="strip-wrap">
      <div className="strip-month">{month}</div>
      <div className="strip" ref={ref} role="group" aria-label="Choose a day">
        {days.map((d) => {
          const lbl = dayLabel(d);
          return (
            <button key={d} className="strip-day" aria-pressed={d === day} onClick={() => onPick(d)} aria-label={dayLong(startOfStudioDay(d))}>
              <span className="strip-wd">{lbl === 'Today' ? 'Today' : WEEKDAYS[weekday(d)]}</span>
              <span className="strip-num">{Number(d.slice(8))}</span>
              <span className={'strip-dot' + (booked.has(d) ? ' on' : '')} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SessionCard({ s, ct, mine, onOpen, i }: { s: SessionWithCounts; ct?: ClassType; mine?: BookingWithDetails; onOpen: () => void; i: number }) {
  const { staff, locations } = useApp();
  const where = hasManyLocations(locations) ? locations.find((l) => l.id === effectiveLocationId(s, locations)) : undefined;
  const inst = staff.find((x) => x.id === s.instructorId);
  const st = sessionState(s);
  const t = time(s.startsAt);
  const dur = ct?.durationMin ?? Math.round((new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60000);
  let status: React.ReactNode;
  if (st === 'cancelled') status = <span className="tag muted-tag">Cancelled</span>;
  else if (mine?.status === 'booked' || mine?.status === 'checked_in') status = <span className="tag ok"><Icon name="check" size={15} />Booked</span>;
  else if (mine?.status === 'waitlisted') status = <span className="tag warn">Waitlisted{mine.waitlistPosition ? ` #${mine.waitlistPosition}` : ''}</span>;
  else if (st === 'finished') status = <span className="tag muted-tag">Finished</span>;
  else if (st === 'started') status = <span className="tag muted-tag">Started</span>;
  else if (ct && !ct.bookable) status = <span className="tag cream">Register interest</span>;
  else if (s.spotsLeft <= 0) status = <><span className="tag line">Full</span><span className="state-sub">Join waitlist</span></>;
  else if (s.spotsLeft <= 3) status = <span className="tag warn-soft">{s.spotsLeft === 1 ? 'Last spot' : `${s.spotsLeft} spots left`}</span>;
  else status = <span className="spots">{s.spotsLeft} spots</span>;
  const dim = st === 'cancelled' || st === 'finished' || st === 'started';
  return (
    <button className={'cls' + (dim ? ' dim' : '') + (mine && mine.status !== 'waitlisted' ? ' mine' : '')} onClick={onOpen}
      style={{ ['--c' as any]: ct?.color || 'var(--accent)', animationDelay: `${Math.min(i, 8) * 45}ms` }}>
      <span className="cls-time">
        <span className="cls-hm">{t.slice(0, -2)}</span>
        <span className="cls-ap">{t.slice(-2)}</span>
      </span>
      <span className="cls-main">
        <span className={'cls-name' + (st === 'cancelled' ? ' strike' : '')}>{ct?.name ?? 'Class'}</span>
        <span className="cls-meta">
          {inst && <Avatar name={inst.name} src={inst.photoUrl} size={24} className="ringed" />}
          <span>{inst ? firstName(inst.name) : 'TBC'}</span><span className="dotsep" />{dur} min
        </span>
        {where && <span className="cls-where"><Icon name="pin" size={14} />{where.name}</span>}
      </span>
      <span className="cls-state">{status}</span>
    </button>
  );
}

// ------------------------------------------------------------------ coming soon
function ComingSoon({ types }: { types: ClassType[] }) {
  const [open, setOpen] = useState<ClassType | null>(null);
  return (
    <section className="soon">
      {types.map((t) => (
        <button key={t.id} className="soon-card" onClick={() => setOpen(t)}>
          <span className="soon-img"><img src={classPhoto(t)} alt="" loading="lazy" /></span>
          <span className="soon-body">
            <span className="soon-top"><span className="soon-dur">{t.durationMin} min</span><span className="tag glass-tag">Coming soon</span></span>
            <span className="soon-name serif"><Accent text={t.name} /></span>
            {t.description && <span className="soon-desc">{t.description}</span>}
            <span className="btn white sm soon-cta">Register interest <Arrow /></span>
          </span>
        </button>
      ))}
      <InterestSheet ct={open} onClose={() => setOpen(null)} />
    </section>
  );
}

const interestKey = (id: string) => `spc.interest.${id}`;
function readInterest(id: string) { try { return !!localStorage.getItem(interestKey(id)); } catch { return false; } }

function InterestSheet({ ct, onClose }: { ct: ClassType | null; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [done, setDone] = useState(false);
  useEffect(() => { if (ct) setDone(readInterest(ct.id)); }, [ct]);
  if (!ct) return null;
  const register = async () => {
    const s = store as any;
    try {
      if (typeof s.registerInterest === 'function') await s.registerInterest(app.client.id, ct.id);
      try { localStorage.setItem(interestKey(ct.id), new Date().toISOString()); } catch { /* private mode */ }
      setDone(true);
      toast('Thanks – we’ll let you know when it’s on');
    } catch (e) { toast(errorMessage(e)); }
  };
  const canStore = typeof (store as any).registerInterest === 'function';
  const mailto = `mailto:${app.settings.email}?subject=${encodeURIComponent(`Register interest: ${ct.name}`)}&body=${encodeURIComponent(`Hi! I'd love to hear when ${ct.name} starts.\n\n${app.client.firstName} ${app.client.lastName}`)}`;
  return (
    <Sheet open onClose={onClose} label={ct.name}>
      <SheetHead onClose={onClose} />
      <div className="stack lg">
        <div>
          <span className="tag cream">Coming soon</span>
          <h2 className="mt-12"><Accent text={ct.name} /></h2>
          <p className="muted mt-8">{ct.durationMin} min{ct.level ? ` · ${ct.level}` : ''}</p>
        </div>
        <p>{ct.description}</p>
        {done ? (
          <div className="done-row"><span className="done-tick"><Icon name="check" size={18} /></span>You’re on the list. We’ll be in touch as soon as it hits the timetable.</div>
        ) : canStore ? (
          <button className="btn block" onClick={register}>Let me know when it starts</button>
        ) : (
          <a className="btn block" href={mailto} onClick={() => { try { localStorage.setItem(interestKey(ct.id), '1'); } catch { /* */ } setTimeout(() => setDone(true), 400); }}>
            <Icon name="mail" size={18} />Register interest by email
          </a>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ class sheet
type Mode = 'view' | 'cancel' | 'booked' | 'waitlisted' | 'nocredits';

/** Class detail, opened over the timetable or bookings. backLabel names that screen ("‹ Timetable"). */
export function ClassSheet({ sessionId, onClose, nav, backLabel, where }: { sessionId: string | null; onClose: () => void; nav: Nav; backLabel: string; where: string }) {
  return (
    <Sheet open={!!sessionId} onClose={onClose} label="Class details">
      {sessionId && <ClassSheetBody key={sessionId} id={sessionId} onClose={onClose} nav={nav} backLabel={backLabel} where={where} />}
    </Sheet>
  );
}

function ClassSheetBody({ id, onClose, nav, backLabel, where }: { id: string; onClose: () => void; nav: Nav; backLabel: string; where: string }) {
  const app = useApp();
  const toast = useToast();
  const cid = app.client.id;
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [passId, setPassId] = useState<string | undefined>(undefined);
  const [lastCancel, setLastCancel] = useState<{ returned: boolean } | null>(null);
  // Family accounts: who's coming (null = just me), the dependant booking being cancelled, and what we just booked
  const { deps } = useDependants();
  const [who, setWho] = useState<string[] | null>(null);
  const [target, setTarget] = useState<{ booking: BookingWithDetails; name: string } | null>(null);
  const [results, setResults] = useState<{ name: string; outcome: 'booked' | 'waitlisted' }[] | null>(null);
  const [needy, setNeedy] = useState<string | null>(null);
  // the out-of-credits and cancel screens are a step inside the sheet: back returns to the details
  useBackHandler(mode === 'nocredits' || mode === 'cancel', () => setMode('view'));
  const back = { label: backLabel, onClick: onClose };

  const depKey = deps.map((x) => x.id).join(',');
  const d = useData(async () => {
    const [s, bks, credits] = await Promise.all([
      store.getSession(id),
      store.listClientBookings(cid, { when: 'all' }),
      store.getCreditSummary(cid, id),
    ]);
    const pick = (list: BookingWithDetails[]) => {
      const forThis = list.filter((b) => b.sessionId === id);
      return forThis.find((b) => ['booked', 'checked_in', 'waitlisted'].includes(b.status)) ?? forThis.find((b) => ['no_show', 'late_cancelled'].includes(b.status));
    };
    const mine = pick(bks);
    const fam = await Promise.all(deps.map(async (dep) => ({
      dep, booking: pick(await store.listClientBookings(dep.id, { when: 'all' })), credits: await store.getCreditSummary(dep.id, id),
    })));
    return { s, mine, credits, fam };
  }, [id, cid, depKey]);

  if (d.error && !d.data) return <><SheetHead back={back} /><ErrorBlock error={d.error} onRetry={d.reload} /></>;
  if (!d.data) return <><SheetHead back={back} /><SheetSkeleton /></>;

  const { s, mine, credits, fam } = d.data;
  const ct = classTypeFor(app.classTypes, s.classTypeId);
  const inst = app.staff.find((x) => x.id === s.instructorId);
  const st = sessionState(s);
  const late = isLateCancel(s, app.settings);
  const booked = mine && (mine.status === 'booked' || mine.status === 'checked_in');
  const waitlisted = mine?.status === 'waitlisted';
  const full = s.spotsLeft <= 0;
  const bookable = ct?.bookable !== false;
  const className = ct?.name ?? 'Class';
  // Several locations: say which one, with its address and a way to get there. One location: the page is exactly as before.
  const place = hasManyLocations(app.locations) ? app.locations.find((l) => l.id === effectiveLocationId(s, app.locations)) : undefined;
  // Leave the sheet (popping its history entry first), then open a flow that knows how to bring us back.
  const toFlow = (to: string) => leaveSheets(() => goFlow(nav, to, { label: className, where, reopen: id }));
  const toShop = () => toFlow('/passes?for=' + encodeURIComponent(id));

  // ---- family: who can still be added to this class, and who's ticked
  const isActive = (b?: BookingWithDetails) => !!b && ['booked', 'checked_in', 'waitlisted'].includes(b.status);
  const meIn = isActive(mine);
  const options: WhoOption[] = [
    ...(meIn ? [] : [{ id: cid, name: `${app.client.firstName} (you)`, sub: creditLine(app.client, credits[0], 'You').text, photoUrl: app.client.photoUrl } as WhoOption]),
    ...fam.filter((f) => !isActive(f.booking)).map((f): WhoOption => ({
      id: f.dep.id, name: fullName(f.dep), sub: creditLine(f.dep, f.credits[0], app.client.firstName).text,
      ...(f.dep.waiverSignedAt ? {} : { flag: 'Waiver needed' }), ...(f.dep.photoUrl ? { photoUrl: f.dep.photoUrl } : {}),
    })),
  ];
  const sel = (who ?? (meIn ? [] : [cid])).filter((x) => options.some((o) => o.id === x));
  const showWho = deps.length > 0 && options.length > 0;
  const nameOf = (x: string) => (x === cid ? firstName(app.client.firstName) : fam.find((f) => f.dep.id === x)?.dep.firstName ?? 'them');

  const book = async () => {
    if (deps.length > 0 && sel.length === 0) return;
    // a dependant's waiver has to be signed by the parent first: send them to Family, then back here
    const unsigned = fam.find((f) => sel.includes(f.dep.id) && !f.dep.waiverSignedAt);
    if (unsigned) { toFlow(`/family?sign=${encodeURIComponent(unsigned.dep.id)}&then=${encodeURIComponent(id)}`); return; }
    // a dependant with no usable pass: say who, and offer the shop for them (unless the class is full: the waitlist takes no credit)
    const noPass = !full && fam.find((f) => sel.includes(f.dep.id) && f.credits.length === 0);
    if (noPass) { setNeedy(noPass.dep.id); setMode('nocredits'); return; }
    setBusy(true);
    try {
      if (deps.length > 0 && store.bookAttendees) {
        const rs = await store.bookAttendees(id, sel, passId && sel.includes(cid) ? { passId } : undefined);
        const list = rs.map((r, i) => ({ name: nameOf(sel[i]!), outcome: r.outcome }));
        setResults(list);
        setMode(list.every((x) => x.outcome === 'waitlisted') ? 'waitlisted' : 'booked');
        setWho(null);
      } else {
        const r = await store.bookClass(cid, id, passId ? { passId } : undefined);
        setResults(null);
        setMode(r.outcome === 'booked' ? 'booked' : 'waitlisted');
      }
      d.reload();
    } catch (e: any) {
      if (e?.code === 'WAIVER_REQUIRED') toFlow('/waiver?then=' + encodeURIComponent(id));
      else if (e?.code === 'NO_CREDITS') setMode('nocredits');
      else toast(errorMessage(e));
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    const b = target?.booking ?? mine;
    if (!b) return;
    setBusy(true);
    try {
      const r = await store.cancelBooking(b.id);
      if (!target) setLastCancel({ returned: r.creditReturned });
      toast(r.creditReturned ? (target ? `${target.name}’s booking cancelled – the credit’s back` : 'Booking cancelled – your credit’s back') : 'Booking cancelled');
      setMode('view');
      setTarget(null);
      d.reload();
    } catch (e) { toast(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const leave = async (b: BookingWithDetails | undefined = mine, name?: string) => {
    if (!b) return;
    setBusy(true);
    try { await store.leaveWaitlist(b.id); toast(name ? `${name} has left the waitlist` : 'You’ve left the waitlist'); d.reload(); }
    catch (e) { toast(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const ics = <a className="btn soft block" href={icsDataUrl(s, ct, inst, app.settings)} download={icsFileName(s, ct)}><Icon name="calplus" size={19} />Add to calendar</a>;

  // ---------- success states
  if (mode === 'booked' || mode === 'waitlisted') {
    return (
      <>
      <SheetHead onClose={onClose} />
      <div className="success">
        <div className="success-mark"><Flower size={64} className="bloom" /></div>
        <h2>{results && results.length > 1 ? (mode === 'booked' ? <>You’re all <em>booked</em> in</> : <>You’re on the <em>waitlist</em></>) : mode === 'booked' ? <>You’re <em>booked</em> in</> : <>You’re on the <em>waitlist</em></>}</h2>
        <p className="muted">{ct?.name} · {time(s.startsAt)} {dayLong(s.startsAt)}{inst ? ` with ${firstName(inst.name)}` : ''}</p>
        {results && (results.length > 1 || results[0]?.name !== firstName(app.client.firstName)) && (
          <ul className="who-results" aria-label="Who’s booked">
            {results.map((r) => <li key={r.name}><Icon name={r.outcome === 'booked' ? 'check' : 'clock'} size={16} /><strong>{r.name}</strong><span className="muted">{r.outcome === 'booked' ? 'booked in' : 'on the waitlist'}</span></li>)}
          </ul>
        )}
        {mode === 'booked' ? (
          <p className="success-note">Free cancellation until {when(freeCancelUntil(s, app.settings))}. See you on the mat!</p>
        ) : (
          <p className="success-note">If a spot opens up we’ll book you in automatically and use a credit then – you’ll get a notification. Auto-booking stops {pluralise(app.settings.waitlistCutoffHours, 'hour')} before class.</p>
        )}
        {mode === 'booked' && <Slot name="client.booked" props={{ session: s }} />}
        <div className="stack">
          {mode === 'booked' && ics}
          <button className="btn block" onClick={onClose}>Done</button>
        </div>
      </div>
      </>
    );
  }

  if (mode === 'nocredits') {
    return (
      <div className="stack lg">
        <SheetHead back={{ label: className, onClick: () => { setNeedy(null); setMode('view'); } }} onClose={onClose} />
        <div className="center-col">
          <div className="empty-mark lg"><Icon name="ticket" size={30} /></div>
          {needy ? (
            <>
              <h2>{fam.find((f) => f.dep.id === needy)?.dep.firstName ?? 'They'} needs a <em>pass</em></h2>
              <p className="muted">Your passes can’t cover them for {ct?.name ?? 'this class'}. Memberships are personal, so they’ll need their own pass, or a class pack you can share. Grab one and we’ll bring you straight back here.</p>
            </>
          ) : (
            <>
              <h2>You’re out of <em>credits</em></h2>
              <p className="muted">You’ll need a pass that covers {ct?.name ?? 'this class'} to book. Grab one and we’ll bring you straight back here.</p>
            </>
          )}
        </div>
        <button className="btn block" onClick={needy ? () => toFlow('/passes?for=' + encodeURIComponent(id) + '&who=' + encodeURIComponent(needy)) : toShop}>See passes + memberships</button>
        <button className="btn ghost block" onClick={() => { setNeedy(null); setMode('view'); }}>Not now</button>
      </div>
    );
  }

  if (mode === 'cancel' && (target?.booking ?? mine)) {
    return (
      <div className="stack lg">
        <SheetHead back={{ label: className, onClick: () => setMode('view') }} onClose={onClose} />
        <div className="center-col">
          <div className={'empty-mark lg' + (late ? ' warn' : '')}><Icon name={late ? 'clock' : 'calendar'} size={30} /></div>
          {late ? (
            <>
              <h2>This is a <em>late cancel</em></h2>
              <p className="muted">Class starts in {formatIn(hoursUntil(s.startsAt))}. Cancelling within {pluralise(app.settings.cancelWindowHours, 'hour')} of class means your credit won’t be returned{app.settings.lateCancelFeeCents > 0 ? ` and a ${money(app.settings.lateCancelFeeCents)} late cancel fee applies` : ''}.</p>
            </>
          ) : (
            <>
              <h2>{target ? <>Cancel {target.name}’s <em>spot?</em></> : <>Cancel your <em>spot?</em></>}</h2>
              <p className="muted">{target ? `You’re cancelling more than ${pluralise(app.settings.cancelWindowHours, 'hour')} before class, so the credit goes straight back on the pass it came from.` : `You’re cancelling more than ${pluralise(app.settings.cancelWindowHours, 'hour')} before class, so your credit goes straight back on your pass.`}</p>
            </>
          )}
        </div>
        <div className="panel-soft row gap-12">
          <span className="cls-bar" style={{ background: ct?.color || 'var(--accent)' }} />
          <div><strong>{ct?.name}</strong><div className="muted">{time(s.startsAt)} {dayLong(s.startsAt)}</div></div>
        </div>
        <div className="stack">
          <button className={'btn block ' + (late ? 'danger-solid' : 'danger')} disabled={busy} onClick={cancel}>
            {busy ? 'Cancelling…' : late ? 'Cancel and lose the credit' : target ? `Yes, cancel ${target.name}’s booking` : 'Yes, cancel my booking'}
          </button>
          <button className="btn ghost block" onClick={() => { setTarget(null); setMode('view'); }}>{target ? `Keep ${target.name}’s spot` : 'Keep my spot'}</button>
        </div>
      </div>
    );
  }

  // ---------- details
  return (
    <div className="cs">
      <SheetHead compact back={back} title={<>{time(s.startsAt)} · {className}</>} />
      <div className="cs-media">
        <img src={classPhoto(ct ?? undefined)} alt="" />
      </div>
      <div className="cs-top">
        <div className="row spread">
          <span className="cs-idx serif">{String(Math.max(0, app.classTypes.findIndex((t) => t.id === s.classTypeId)) + 1).padStart(2, '0')}</span>
          {ct?.level && <span className="tag">{ct.level === 'All levels' ? 'All levels welcome' : ct.level}</span>}
        </div>
        <h2 className="cs-title"><Accent text={ct?.name ?? 'Class'} /></h2>
        <div className="cs-facts">
          <span><Icon name="calendar" size={18} />{dayLong(s.startsAt)}</span>
          <span><Icon name="clock" size={18} />{timeRange(s)}</span>
          <span><Icon name="pin" size={18} />{place ? place.name : app.settings.address.split(',')[0]}</span>
        </div>
        {place && place.address && (
          <p className="cs-where">
            {place.address}{' '}
            <a className="cs-dir" href={directionsUrl(place.address, directionsPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent))} target="_blank" rel="noopener noreferrer">Get directions<span className="sr-only"> to {place.name}</span></a>
          </p>
        )}
      </div>

      {st !== 'cancelled' && booked && (
        <div className="note ok"><Icon name="check" size={20} /><div><strong>You’re booked in.</strong> {st === 'open' ? 'See you on the mat!' : ''}</div></div>
      )}
      {st !== 'cancelled' && waitlisted && (
        <div className="note cream"><Icon name="users" size={20} /><div><strong>You’re #{mine?.waitlistPosition ?? '–'} on the waitlist.</strong> We’ll book you in automatically if a spot opens.</div></div>
      )}
      {st !== 'cancelled' && fam.filter((f) => isActive(f.booking)).map((f) => {
        const b = f.booking!;
        const wl = b.status === 'waitlisted';
        return (
          <div key={f.dep.id} className={'note ' + (wl ? 'cream' : 'ok') + ' fam-row'}>
            <Icon name={wl ? 'users' : 'check'} size={20} />
            <div><strong>{f.dep.firstName} {wl ? `is #${b.waitlistPosition ?? '–'} on the waitlist.` : 'is booked in.'}</strong></div>
            {st === 'open' && b.status !== 'checked_in' && (
              <button className="btn sm soft" disabled={busy} aria-label={wl ? `Take ${f.dep.firstName} off the waitlist` : `Cancel ${f.dep.firstName}’s booking`}
                onClick={() => (wl ? leave(b, f.dep.firstName) : (setTarget({ booking: b, name: f.dep.firstName }), setMode('cancel')))}>{wl ? 'Leave' : 'Cancel'}</button>
            )}
          </div>
        );
      })}
      {st === 'cancelled' && (
        <div className="note danger"><Icon name="info" size={20} /><div><strong>This class has been cancelled.</strong>{s.cancelReason ? <div>{s.cancelReason}</div> : null} Any credits used have been returned.</div></div>
      )}
      {mine && (mine.status === 'no_show' || mine.status === 'late_cancelled') && (
        <div className="note"><Icon name="info" size={20} /><div>{mine.status === 'no_show' ? 'Marked as a no-show for this class.' : 'You late cancelled this class.'}</div></div>
      )}
      {lastCancel && !mine && (
        <div className="note ok"><Icon name="check" size={20} /><div>Cancelled. {lastCancel.returned ? 'Your credit has been returned.' : 'The credit wasn’t returned as it was a late cancel.'}</div></div>
      )}

      {st !== 'cancelled' && <Mats s={s} />}

      {s.note && <div className="note"><Icon name="info" size={20} /><div>{s.note}</div></div>}
      {ct?.bookingNote && (
        <div className="note cream"><Icon name="heart" size={20} /><div><strong>Before you book</strong><div>{ct.bookingNote}</div></div></div>
      )}

      {ct?.description && <p className="cs-desc">{ct.description}</p>}
      <Slot name="client.class" props={{ session: s }} />

      {inst && (
        <figure className="inst">
          <div className="kicker">Your instructor</div>
          <div className="inst-pic"><Avatar name={inst.name} src={inst.photoUrl} size={128} /></div>
          <h3 className="inst-name">{inst.name}</h3>
          <span className="inst-role">{staffRole(inst)}</span>
          {inst.bio && <p className="inst-bio">{inst.bio}</p>}
        </figure>
      )}

      {st === 'open' && bookable && showWho && <WhosComing options={options} selected={sel} onChange={setWho} />}
      {st === 'open' && bookable && !booked && !waitlisted && (!showWho || sel.includes(cid)) && (
        <PassPicker credits={credits} passId={passId} setPassId={setPassId} full={full} onShop={toShop} />
      )}
      {booked && mine?.passId && (
        <div className="using"><Icon name="ticket" size={20} /><span>Booked with <strong>{credits.find((c) => c.pass.id === mine.passId)?.pass.name ?? 'your pass'}</strong></span></div>
      )}

      <div className="cs-foot">
        {st !== 'open' || !bookable ? (
          <>
            {!bookable && st === 'open' && <p className="muted center">This class isn’t open for booking yet.</p>}
            {st === 'started' && <p className="muted center">This class has started – see you next time.</p>}
            {st === 'finished' && <p className="muted center">{booked ? 'Hope you enjoyed it!' : 'This class has finished.'}</p>}
            <button className="btn soft block" onClick={onClose}>Close</button>
          </>
        ) : booked ? (
          <>
            {showWho && <button className="btn block" disabled={busy || sel.length === 0} onClick={book}>{busy ? 'Booking…' : sel.length === 0 ? 'Choose who’s coming' : full ? 'Join waitlist' : `Add ${sel.map(nameOf).join(' and ')}`}</button>}
            <p className={'policy-line' + (late ? ' late' : '')}>
              <Icon name={late ? 'info' : 'check'} size={17} />
              {late
                ? `Cancelling now is a late cancel – the credit won’t be returned.`
                : `Free cancellation until ${when(freeCancelUntil(s, app.settings))}.`}
            </p>
            <div className="foot-row">
              {ics}
              <button className="btn danger block" onClick={() => setMode('cancel')}>Cancel booking</button>
            </div>
          </>
        ) : waitlisted ? (
          <>
            {showWho && <button className="btn block" disabled={busy || sel.length === 0} onClick={book}>{busy ? 'Booking…' : sel.length === 0 ? 'Choose who’s coming' : `Add ${sel.map(nameOf).join(' and ')}`}</button>}
            <p className="policy-line"><Icon name="users" size={17} />You’re #{mine?.waitlistPosition ?? '–'} on the waitlist. We’ll book you in automatically if a spot opens.</p>
            <button className="btn danger block" disabled={busy} onClick={() => leave()}>{busy ? 'Leaving…' : 'Leave waitlist'}</button>
          </>
        ) : full ? (
          <>
            <p className="policy-line"><Icon name="users" size={17} />Class is full{s.waitlistCount ? ` · ${s.waitlistCount} on the waitlist` : ''}. Joining is free – a credit is only used if you get a spot.</p>
            <button className="btn block" disabled={busy || (showWho && sel.length === 0)} onClick={book}>{busy ? 'Joining…' : showWho && sel.length === 0 ? 'Choose who’s coming' : 'Join waitlist'}</button>
          </>
        ) : (
          <>
            {late ? (
              <p className="policy-line late"><Icon name="info" size={17} />Class starts within {pluralise(app.settings.cancelWindowHours, 'hour')}, so this booking can’t be cancelled for a credit back.</p>
            ) : (
              <p className="policy-line"><Icon name="check" size={17} />Free cancellation until {when(freeCancelUntil(s, app.settings))}.</p>
            )}
            <button className="btn block big" disabled={busy || (showWho && sel.length === 0)} onClick={book}>
              {busy ? 'Booking…' : showWho && sel.length === 0 ? 'Choose who’s coming' : showWho && sel.length > 1 ? <>Book {sel.length} spots <Arrow /></> : showWho && !sel.includes(cid) ? <>Book for {nameOf(sel[0]!)} <Arrow /></> : <>Book this class <Arrow /></>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function formatIn(h: number): string {
  if (h < 1) { const m = Math.max(1, Math.round(h * 60)); return pluralise(m, 'minute'); }
  const r = Math.round(h * 2) / 2;
  return r === 1 ? '1 hour' : `${r} hours`;
}

function SheetSkeleton() {
  return (
    <div className="stack lg" aria-busy="true">
      <Skeleton w="40%" h={14} />
      <Skeleton w="70%" h={40} />
      <Skeleton w="85%" h={18} />
      <Skeleton h={64} r={16} />
      <Skeleton h={90} r={16} />
      <Skeleton h={52} r={999} />
    </div>
  );
}

function Mats({ s }: { s: SessionWithCounts }) {
  const cap = s.capacity;
  const taken = Math.min(cap, s.bookedCount);
  const label = s.spotsLeft <= 0 ? `Full${s.waitlistCount ? ` · ${s.waitlistCount} waiting` : ''}` : s.spotsLeft === 1 ? '1 mat left' : `${s.spotsLeft} of ${cap} mats free`;
  return (
    <div className="mats">
      <div className="mats-row" aria-hidden="true">
        {cap <= 30 && Array.from({ length: cap }).map((_, i) => <span key={i} className={'mat' + (i < taken ? ' taken' : '')} />)}
      </div>
      <span className={'mats-label' + (s.spotsLeft <= 3 ? ' warn' : '')}>{label}</span>
    </div>
  );
}

function PassPicker({ credits, passId, setPassId, full, onShop }: {
  credits: CreditSummary[]; passId?: string; setPassId: (s?: string) => void; full: boolean; onShop: () => void;
}) {
  if (credits.length === 0) {
    return (
      <div className="pass-none">
        <div>
          <strong>No pass for this class yet</strong>
          <p className="muted">{full ? 'You can still join the waitlist – you’ll need a credit if a spot opens.' : 'Grab a class pack, membership or the intro offer to book.'}</p>
        </div>
        <button className="btn sm cream" onClick={onShop}>Shop</button>
      </div>
    );
  }
  if (full) return null;
  const sel = passId ?? credits[0]!.pass.id;
  return (
    <div className="picker">
      <div className="kicker">Booking with</div>
      <div className="picker-list" role="radiogroup">
        {credits.map((c, i) => (
          <button key={c.pass.id} role="radio" aria-checked={sel === c.pass.id} className={'picker-opt' + (sel === c.pass.id ? ' on' : '')}
            onClick={() => setPassId(i === 0 && !passId ? undefined : c.pass.id)}>
            <span className="radio" />
            <span className="picker-main">
              <span className="picker-name">{c.pass.name}</span>
              <span className="muted">{c.label}{c.pass.activatedAt ? '' : ' · starts with this booking'}</span>
            </span>
            {i === 0 && credits.length > 1 && <span className="tag">Best fit</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
