import React, { useEffect, useState } from 'react';
import { store, useData } from '../shared/react';
import { addDays, dateFormat, pluralise, startOfStudioDay, studioDate, time } from '../shared/format';
import { brandAsset, getBranding } from '../shared/branding';
import { todayWidgetsList } from '../shared/registry';
import type { Client, Pass, SessionWithCounts } from '../shared/types';
import type { RosterEntry } from '../shared/store';
import { brandPhrases, Flower, Logo } from '../shared/brand';
import { LocationFilter, placeLabel, useAtLocation, useLocationFilter, useLocations } from './locations';
import { Accent, Avatar, Empty, Fill, Icon, Loading, Seg, Sep, cx, dayLong, dayShort, fullName, useStudio } from './ui';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The website's phrases, one at a time. Starts on today's phrase; rotates gently unless reduced motion is on. */
function useBrandPhrase(ms = 7000) {
  const phrases = brandPhrases();
  const n = Math.max(1, phrases.length);
  const [i, setI] = useState(() => Math.floor(Date.now() / 864e5) % n);
  useEffect(() => {
    if (reducedMotion() || phrases.length < 2) return;
    const t = window.setInterval(() => setI((k) => (k + 1) % n), ms);
    return () => window.clearInterval(t);
  }, [ms, n]);
  return { phrase: phrases[i % n] ?? '', i };
}

export function useNow(ms = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

export function relTime(s: { startsAt: string; endsAt: string }, now: number): string {
  const a = new Date(s.startsAt).getTime(), b = new Date(s.endsAt).getTime();
  if (now >= b) return 'Finished';
  if (now >= a) return 'On now';
  const m = Math.round((a - now) / 60000);
  if (m < 60) return `In ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `In ${h} hr ${r} min` : `In ${h} hr`;
}

function greeting() {
  const h = Number(dateFormat({ hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

type Dash = { sessions: SessionWithCounts[]; rosters: Record<string, RosterEntry[]> };
type Expiring = { client: Client; pass: Pass }[];

export function Today() {
  const { me, staffById, typeById, can } = useStudio();
  const now = useNow();
  const today = studioDate();
  const mine = !can('allRosters');
  const [view, setView] = useState<'all' | 'mine'>('all');
  const { phrase, i: phraseKey } = useBrandPhrase();

  const dash = useData<Dash>(async () => {
    const all = await store.listSessions({ from: startOfStudioDay(today), to: startOfStudioDay(addDays(today, 1)), includeCancelled: true });
    const sessions = mine ? all.filter((s) => s.instructorId === me.staffId) : all;
    const rosters: Record<string, RosterEntry[]> = {};
    await Promise.all(sessions.filter((s) => s.status !== 'cancelled').map(async (s) => { rosters[s.id] = await store.getRoster(s.id).catch(() => []); }));
    return { sessions, rosters };
  }, [today, mine]);

  const expiring = useData<Expiring>(async () => {
    if (mine) return [];
    const clients = await store.listClients();
    const limit = Date.now() + 7 * 864e5;
    const out: Expiring = [];
    await Promise.all(clients.map(async (c) => {
      const passes = await store.listPasses(c.id).catch(() => [] as Pass[]);
      for (const p of passes) {
        if (p.status !== 'active' || !p.expiresAt) continue;
        const t = new Date(p.expiresAt).getTime();
        if (t > Date.now() && t <= limit) out.push({ client: c, pass: p });
      }
    }));
    return out.sort((a, b) => (a.pass.expiresAt! < b.pass.expiresAt! ? -1 : 1));
  }, [mine]);

  const first = me.name.split(' ')[0] ?? me.name;
  // More than one location: filter the day to one (remembered on this device). A one-location studio sees none of this.
  const places = useLocations();
  const [locPick, setLocPick] = useLocationFilter(places.locations);
  const allSessions = useAtLocation(dash.data?.sessions ?? [], places.many ? locPick : '', places.locations);
  // "My classes" is about who teaches the class (instructorId), whatever the staff member's role.
  const myToday = allSessions.filter((s) => s.instructorId === me.staffId && s.status !== 'cancelled');
  const canFilter = !mine && myToday.length > 0;
  const sessions = canFilter && view === 'mine' ? allSessions.filter((s) => s.instructorId === me.staffId) : allSessions;
  const live = allSessions.filter((s) => s.status !== 'cancelled');
  const next = sessions.filter((s) => s.status !== 'cancelled').find((s) => new Date(s.endsAt).getTime() > now);
  const rosters = dash.data?.rosters ?? {};
  const booked = live.reduce((n, s) => n + s.bookedCount, 0);
  const checkedIn = Object.values(rosters).reduce((n, r) => n + r.filter((e) => e.status === 'checked_in').length, 0);
  const waitlist = live.reduce((n, s) => n + s.waitlistCount, 0);
  const noWaiver: { e: RosterEntry; s: SessionWithCounts }[] = [];
  for (const s of live) for (const e of rosters[s.id] ?? []) if (e.flags.includes('no_waiver') && (e.status === 'booked' || e.status === 'checked_in' || e.status === 'waitlisted')) noWaiver.push({ e, s });
  const teachingLine = myToday.length
    ? ` You're teaching ${myToday.map((s) => `${typeById(s.classTypeId)?.name ?? 'a class'} at ${time(s.startsAt)}`).join(' and ')}.`
    : '';
  const sub = dash.loading && !dash.data ? 'Getting today ready…'
    : mine ? (myToday.length ? `You're teaching ${pluralise(myToday.length, 'class', 'classes')} today.` : 'No classes for you today. Enjoy the breather.')
    : live.length ? `${pluralise(live.length, 'class', 'classes')} on today, ${booked} booked in.${teachingLine}` : 'No classes on today. A quiet one.';
  const birthdays: { e: RosterEntry; s: SessionWithCounts }[] = [];
  for (const s of live) for (const e of rosters[s.id] ?? []) if (e.flags.includes('birthday') && (e.status === 'booked' || e.status === 'checked_in')) birthdays.push({ e, s });

  return (
    <div className="today">
      <section className="today-hero">
        <img className="th-photo" src={brandAsset(getBranding().photos.hero)} alt="" />
        <div className="th-inner">
          <div className="th-main">
            <Logo className="th-logo" letters="var(--highlight)" flower="var(--accent)" />
            <div className="eyebrow"><Flower size={12} className="eb-fl" />{dayLong(new Date())}</div>
            <h1>{greeting()}, <em>{first}</em></h1>
            <p className="th-sub">{sub}</p>
            {phrase && <p className="th-phrase"><Flower size={14} /><span key={phraseKey}>{phrase}</span></p>}
          </div>
          {(can('pos') || can('editClients')) && (
            <div className="th-actions">
              {can('pos') && <a className="btn glass" href="#/pos"><Icon name="bag" size={20} />Sell</a>}
              {can('editClients') && <a className="btn white" href="#/clients?new=1"><Icon name="userPlus" size={20} />New client</a>}
            </div>
          )}
        </div>
      </section>

      {dash.loading && !dash.data ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Classes today" value={live.length} />
            <Stat label="Booked" value={booked} />
            <Stat label="Checked in" value={checkedIn} accent />
            <Stat label="On waitlists" value={waitlist} />
          </div>

          <div className="today-grid">
            {next && <div className="tg-next"><NextCard s={next} now={now} roster={rosters[next.id] ?? []} /></div>}
            <section className="tg-list">
                <div className="sec-head">
                  <h2>{mine ? <>Your <em>classes</em></> : <>Today's <em>classes</em></>}</h2>
                  {places.many && <LocationFilter locations={places.locations} value={locPick} onChange={setLocPick} />}
                  {canFilter && <Seg className="sm" value={view} onChange={setView} options={[{ value: 'all', label: 'All classes' }, { value: 'mine', label: `My classes (${myToday.length})` }]} />}
                  <a className="linkish" href="#/schedule">Full schedule<Icon name="right" size={16} /></a>
                </div>
                {sessions.length === 0 ? (
                  <div className="card"><Empty title="A quiet day">{mine ? 'You’re not teaching today.' : 'No classes are scheduled today.'}</Empty></div>
                ) : (
                  <div className="cls-list">
                    {sessions.map((s) => {
                      const ct = typeById(s.classTypeId); const ins = staffById(s.instructorId);
                      const r = rosters[s.id] ?? [];
                      const ci = r.filter((e) => e.status === 'checked_in').length;
                      const done = new Date(s.endsAt).getTime() <= now;
                      const isLive = !done && new Date(s.startsAt).getTime() <= now;
                      return (
                        <a key={s.id} href={`#/class/${s.id}`} className={cx('cls-card', s.status === 'cancelled' && 'cancelled', s.id === next?.id && 'is-next', done && 'done', isLive && 'live')} style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>
                          <div className="cls-time"><strong>{time(s.startsAt).replace(/(am|pm)$/, '')}</strong><span>{time(s.startsAt).slice(-2)}</span></div>
                          <div className="cls-body">
                            <div className="cls-name">{ct?.name ?? 'Class'}{s.status === 'cancelled' && <span className="chip danger">Cancelled</span>}{isLive && <span className="chip ok"><Flower size={11} spin className="live-fl" color="currentColor" />On now</span>}</div>
                            <div className="cls-meta">
                              {ins && <Avatar name={ins.name} photo={ins.photoUrl} size={24} />}
                              <span>{ins?.name ?? 'No instructor'}{s.instructorId === me.staffId && !mine ? ' (you)' : ''}</span><Sep /><span>{ct?.durationMin ?? 55} min</span>
                              {places.many && <><Sep /><span className="cls-place">{placeLabel(s, places.locations, places.rooms)}</span></>}
                            </div>
                          </div>
                          {s.status !== 'cancelled' && (
                            <div className="cls-count">
                              <div><strong>{s.bookedCount}</strong><span>/{s.capacity}</span></div>
                              <Fill value={s.bookedCount} max={s.capacity} />
                              <div className="cls-sub">
                                {done || isLive ? `${ci} checked in` : s.spotsLeft === 0 ? 'Full' : `${s.spotsLeft} spots left`}
                                {s.waitlistCount > 0 && <> · {s.waitlistCount} waitlist</>}
                              </div>
                            </div>
                          )}
                          <Icon name="right" size={20} className="cls-go" />
                        </a>
                      );
                    })}
                  </div>
                )}
              {todayWidgetsList().filter((w) => w.column !== 'side' && (!w.perm || can(w.perm))).map((w) => <React.Fragment key={w.id}>{w.render()}</React.Fragment>)}
            </section>

            <aside className="tg-aside">
              <section className="card pad alerts">
                <h3><Flower size={16} className="h-fl" />Heads <em>up</em></h3>
                {noWaiver.length === 0 && (expiring.data?.length ?? 0) === 0 && birthdays.length === 0 && (
                  <p className="muted" style={{ marginTop: 10 }}>{expiring.loading ? 'Checking…' : mine ? 'All clear for your classes. Good energy!' : 'All clear. Everyone booked in today has a waiver. Good energy all round.'}</p>
                )}
                {noWaiver.length > 0 && (
                  <div className="alert-group">
                    <div className="ag-head danger"><Icon name="doc" size={18} />No waiver yet <span className="count">{noWaiver.length}</span></div>
                    {noWaiver.map(({ e, s }) => (
                      <a key={e.id} className="alert-row" href={`#/clients/${e.clientId}`}>
                        <Avatar name={fullName(e.client)} photo={e.client.photoUrl} size={32} /><span className="ar-t"><strong>{fullName(e.client)}</strong><span>{time(s.startsAt)} {typeById(s.classTypeId)?.name}</span></span><Icon name="right" size={16} />
                      </a>
                    ))}
                  </div>
                )}
                {birthdays.length > 0 && (
                  <div className="alert-group">
                    <div className="ag-head cream"><Icon name="cake" size={18} />Birthday this week</div>
                    {birthdays.map(({ e, s }) => (
                      <a key={e.id} className="alert-row" href={`#/clients/${e.clientId}`}>
                        <Avatar name={fullName(e.client)} photo={e.client.photoUrl} size={32} /><span className="ar-t"><strong>{fullName(e.client)}</strong><span>In {time(s.startsAt)} {typeById(s.classTypeId)?.name}</span></span><Icon name="right" size={16} />
                      </a>
                    ))}
                  </div>
                )}
                {(expiring.data?.length ?? 0) > 0 && (
                  <div className="alert-group">
                    <div className="ag-head warn"><Icon name="clock" size={18} />Passes expiring this week <span className="count">{expiring.data!.length}</span></div>
                    {expiring.data!.slice(0, 8).map(({ client, pass }) => (
                      <a key={pass.id} className="alert-row" href={`#/clients/${client.id}`}>
                        <Avatar name={fullName(client)} photo={client.photoUrl} size={32} />
                        <span className="ar-t"><strong>{fullName(client)}</strong><span>{pass.name}{pass.credits != null ? ` · ${Math.max(0, pass.credits - pass.creditsUsed)} left` : ''} · {dayShort(pass.expiresAt!)}</span></span>
                        <Icon name="right" size={16} />
                      </a>
                    ))}
                    {expiring.data!.length > 8 && <p className="muted small" style={{ padding: '8px 4px 0' }}>+ {expiring.data!.length - 8} more</p>}
                  </div>
                )}
              </section>
              {todayWidgetsList().filter((w) => w.column === 'side' && (!w.perm || can(w.perm))).map((w) => <React.Fragment key={w.id}>{w.render()}</React.Fragment>)}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return <div className={cx('stat', accent && 'accent')}><span className="stat-v">{value}</span><span className="stat-l">{label}</span></div>;
}

function NextCard({ s, now, roster }: { s: SessionWithCounts; now: number; roster: RosterEntry[] }) {
  const { staffById, typeById } = useStudio();
  const ct = typeById(s.classTypeId); const ins = staffById(s.instructorId);
  const ci = roster.filter((e) => e.status === 'checked_in').length;
  const firsts = roster.filter((e) => e.flags.includes('first_class') && (e.status === 'booked' || e.status === 'checked_in')).length;
  const rel = relTime(s, now);
  return (
    <a className="next-card" href={`#/class/${s.id}`}>
      <Flower size={240} className="nc-flower" color="#fff" />
      <div className="nc-top"><span className="nc-pill">{rel === 'On now' ? <><Flower size={12} spin className="live-fl" color="var(--ok)" />On now</> : <>Up next<Sep />{rel.toLowerCase()}</>}</span></div>
      <div className="nc-main">
        <div className="nc-time">{time(s.startsAt)}</div>
        <div className="nc-name"><Accent text={ct?.name ?? 'Class'} /></div>
        <div className="nc-meta">
          {ins && <Avatar name={ins.name} photo={ins.photoUrl} size={28} />}<span>with {ins?.name ?? 'TBC'}</span>
        </div>
      </div>
      <div className="nc-foot">
        <div className="nc-stat"><strong>{s.bookedCount}<span>/{s.capacity}</span></strong><span>booked</span></div>
        <div className="nc-stat"><strong>{ci}</strong><span>checked in</span></div>
        {s.waitlistCount > 0 && <div className="nc-stat"><strong>{s.waitlistCount}</strong><span>waitlist</span></div>}
        {firsts > 0 && <div className="nc-stat"><strong>{firsts}</strong><span>first class</span></div>}
        <span className="btn nc-btn">Open roster<Icon name="right" size={18} /></span>
      </div>
    </a>
  );
}
