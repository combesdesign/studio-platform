/**
 * Appointments in the client app: one screen ("Privates and events") with three tabs.
 *   Book      private and duet sessions (pick a type, instructor, day and time), and appointment packs
 *   Events    workshops, courses and events (sign up, pay, cancel)
 *   Mine      upcoming and past appointments, credits, and your registrations
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, errorMessage, leaveSheets, store, useBackHandler, useData, useToast } from '../../../shared/react';
import { addDays, money, studioDate } from '../../../shared/format';
import { Accent, BackPill, CardSkeletons, Empty, ErrorBlock, Flower, Icon, ScreenHead, Segmented, SheetHead, useApp } from '../../../client/ui';
import { goFlow, queryOf } from '../../../client/lib';
import { WhosComing, creditLine, fullName, useDependants } from '../../../client/family';
import { brandAsset } from '../../../shared/branding';
import {
  KIND_LABEL, cancelNote, clock, creditsLeft, dayFull, dayLabel, dateOf, eventWhen, needAppts, pageBase, price, range, APPT_STATUS_LABEL,
} from '../api';
import { eventEnd, eventStart, usableCredits } from '../logic';
import type {
  Appointment, AppointmentCredit, AppointmentPack, AppointmentSlot, AppointmentType, EventRegistration, StudioEventSummary,
} from '../types';

type Nav = (to: string, o?: { replace?: boolean }) => void;
type Tab = 'book' | 'events' | 'mine';

export const ApptIcon = ({ size = 20 }: { size?: number }) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="8.5" r="3.2" /><path d="M3 19c.8-3 3-4.6 6-4.6 1.4 0 2.6.3 3.6.9" /><path d="M16.5 13v6M13.5 16h6" />
  </svg>
);

// ------------------------------------------------------------------ demo card payment (same look as the core checkout)
function PayStep({ amountCents, busy, onPay, note }: { amountCents: number; busy: boolean; onPay: () => void; note?: React.ReactNode }) {
  const app = useApp();
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', exp: '12 / 29', cvc: '123', name: `${app.client.firstName} ${app.client.lastName}`.trim() });
  return (
    <div className="stack">
      {store.mode === 'demo' && <div className="demo-strip"><Icon name="info" size={18} />Demo – no real payment is taken</div>}
      <div className="card-form">
        <label className="field"><span>Card number</span>
          <div className="input-icon"><Icon name="card" size={20} /><input className="input" inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} /></div>
        </label>
        <div className="grid2">
          <label className="field"><span>Expiry</span><input className="input" autoComplete="cc-exp" value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} /></label>
          <label className="field"><span>CVC</span><input className="input" inputMode="numeric" autoComplete="cc-csc" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} /></label>
        </div>
        <label className="field"><span>Name on card</span><input className="input" autoComplete="cc-name" value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} /></label>
      </div>
      <button className="btn block big" disabled={busy} onClick={onPay}>{busy ? 'Processing…' : <><Icon name="lock" size={17} />Pay {money(amountCents, { cents: true })}</>}</button>
      {note && <p className="fine muted center">{note}</p>}
    </div>
  );
}

/** Live: off to Stripe Checkout. Demo (startCheckout missing or null): returns false so the caller shows the card sheet. */
async function tryCheckout(order: Parameters<NonNullable<ReturnType<typeof needAppts>['startCheckout']>>[0]): Promise<boolean> {
  const a = needAppts();
  if (!a.startCheckout) return false;
  const r = await a.startCheckout(order);
  if (r && r.url) { location.href = r.url; return true; }
  return false;
}
const returnUrl = () => `${pageBase()}#/appointments?paid=1`;
const fakeCardDelay = () => new Promise((r) => setTimeout(r, 650));

function WaiverNote({ nav, where, dep }: { nav: Nav; where: string; /** Family: whose waiver (a dependant's is signed by the parent in Profile, then Family). */ dep?: { id: string; firstName: string } }) {
  return (
    <div className="note cream"><Icon name="info" size={20} /><div>{dep ? `${dep.firstName}’s waiver and health form needs signing first.` : 'Please complete your waiver and health form first.'} <button className="link-btn inline" onClick={() => leaveSheets(() => goFlow(nav, dep ? `/family?sign=${encodeURIComponent(dep.id)}&then=1` : '/waiver', { label: 'Privates and events', where }))}>Do it now</button></div></div>
  );
}

// ------------------------------------------------------------------ the screen
export function AppointmentsScreen({ nav, path }: { nav: Nav; path: string }) {
  const app = useApp();
  const toast = useToast();
  const ap = store.features.appointments;
  const q = queryOf(path);
  const [tab, setTab] = useState<Tab>((q.get('tab') as Tab) || 'book');
  const types = useData(() => needAppts().listTypes(), []);
  const packs = useData(() => needAppts().listPacks(), []);
  const credits = useData(() => needAppts().listCredits(app.client.id), [app.client.id]);
  const events = useData(() => needAppts().listEvents(), []);
  const mineAppts = useData(() => needAppts().listAppointments({ clientId: app.client.id, from: new Date(Date.now() - 90 * 86400000).toISOString() }), [app.client.id]);
  const regs = useData(() => needAppts().listRegistrations({ clientId: app.client.id }), [app.client.id]);
  const [book, setBook] = useState<AppointmentType | null>(null);
  const [pack, setPack] = useState<AppointmentPack | null>(null);
  const [event, setEvent] = useState<string | null>(null);
  const paid = q.get('paid');

  useEffect(() => {
    if (paid) { toast('Payment received. Your booking will show up in a moment.'); setTab('mine'); nav('/appointments', { replace: true }); }
  }, [paid]);

  if (!ap) return null;
  const left = creditsLeft(credits.data ?? []);
  const upcomingCount = (mineAppts.data ?? []).filter((a) => a.status === 'booked' && Date.parse(a.endsAt) > Date.now()).length
    + (regs.data ?? []).filter((r) => r.status === 'registered').length;

  return (
    <div className="screen">
      <div className="screen-back"><BackPill label="Profile" onClick={() => nav('/profile')} /></div>
      <ScreenHead eyebrow="One on one and special sessions" title={<>Privates <em>and events</em></>} sub="Book a private or duet with your instructor, or sign up for a workshop or course." />
      <Segmented<Tab> value={tab} onChange={setTab} options={[
        { value: 'book', label: 'Book' }, { value: 'events', label: 'Events', count: (events.data ?? []).length },
        { value: 'mine', label: 'Mine', count: upcomingCount },
      ]} />

      {tab === 'book' && (
        <div className="stack mt-20">
          {left > 0 && <div className="ap-credit"><span><strong>{left}</strong> appointment {left === 1 ? 'credit' : 'credits'} ready to use</span><Flower size={20} /></div>}
          {types.error && !types.data ? <ErrorBlock error={types.error} onRetry={types.reload} /> : !types.data ? <CardSkeletons n={2} h={110} /> : types.data.length === 0 ? (
            <Empty title="No private sessions yet">Ask the studio about booking a one on one.</Empty>
          ) : (
            <div className="ap-types">
              {types.data.map((t) => (
                <button key={t.id} className={'ap-card' + (t.imageUrl ? ' img' : '')} onClick={() => setBook(t)}>
                  {t.imageUrl && <span className="ap-thumb" style={{ backgroundImage: `url(${brandAsset(t.imageUrl)})` }} />}
                  <span className="ap-body">
                    <span className="ap-t">{t.name}</span>
                    {t.description && <span className="ap-s">{t.description}</span>}
                    <span className="ap-row">
                      <span className="ap-meta"><span>{t.durationMin} min</span><span>{t.capacity === 2 ? 'Up to 2 people' : '1 person'}</span></span>
                      <span className="ap-price">{price(t.priceCents)}{t.capacity === 2 && t.priceCents > 0 ? <small className="muted"> each</small> : null}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {(packs.data ?? []).length > 0 && (
            <div className="group mt-12">
              <div className="group-label">Save with a pack</div>
              <div className="stack">
                {(packs.data ?? []).map((p) => (
                  <button key={p.id} className="ap-promo" onClick={() => setPack(p)}>
                    <Flower size={26} color="var(--accent)" />
                    <span style={{ flex: 1 }}><strong>{p.name}</strong><span>{p.credits} sessions{p.validityDays ? ` · valid ${p.validityDays} days from first use` : ''}</span></span>
                    <span className="ap-price serif">{price(p.priceCents)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'events' && (
        <div className="stack mt-20">
          {events.error && !events.data ? <ErrorBlock error={events.error} onRetry={events.reload} /> : !events.data ? <CardSkeletons n={2} h={130} /> : events.data.length === 0 ? (
            <Empty title="Nothing coming up">Workshops, courses and events will show here as the studio adds them.</Empty>
          ) : (
            <div className="ap-types">
              {events.data.map((e) => (
                <button key={e.id} className={'ap-card' + (e.imageUrl ? ' img' : '')} onClick={() => setEvent(e.id)}>
                  {e.imageUrl && <span className="ap-thumb" style={{ backgroundImage: `url(${brandAsset(e.imageUrl)})` }} />}
                  <span className="ap-body">
                    <span className="ap-row"><span className={'tag ' + (e.mine || e.myWaitlist?.status === 'offered' ? 'ok' : 'cream')}>{e.mine ? 'You’re in' : e.myWaitlist?.status === 'offered' ? 'A place is held for you' : e.myWaitlist ? 'On the waitlist' : KIND_LABEL[e.kind]}</span><span className="ap-price">{price(e.priceCents)}</span></span>
                    <span className="ap-t">{e.title}</span>
                    <span className="ap-meta"><span>{eventWhen(e)}</span>{e.location && <span>{e.location}</span>}</span>
                    <span className="ap-meta"><span>{e.spotsLeft <= 0 ? 'Full · waitlist open' : e.spotsLeft <= 3 ? `${e.spotsLeft} ${e.spotsLeft === 1 ? 'spot' : 'spots'} left` : `${e.spotsLeft} spots`}</span></span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'mine' && <Mine nav={nav} appts={mineAppts} regs={regs} credits={credits.data ?? []} events={events.data ?? []} reload={() => { mineAppts.reload(); regs.reload(); credits.reload(); events.reload(); }} />}

      <Sheet open={!!book} onClose={() => setBook(null)} label="Book a private">
        {book && <BookBody key={book.id} type={book} nav={nav} onClose={() => setBook(null)} onDone={() => { setBook(null); setTab('mine'); }} />}
      </Sheet>
      <Sheet open={!!pack} onClose={() => setPack(null)} label="Buy a pack">
        {pack && <PackBody key={pack.id} pack={pack} onClose={() => setPack(null)} />}
      </Sheet>
      <Sheet open={!!event} onClose={() => setEvent(null)} label="Event">
        {event && <EventBody key={event} id={event} nav={nav} onClose={() => setEvent(null)} />}
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------ book a private
function BookBody({ type, nav, onClose, onDone }: { type: AppointmentType; nav: Nav; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const toast = useToast();
  const ap = needAppts();
  const today = studioDate();
  const slots = useData(() => ap.listSlots({ typeId: type.id, from: today, to: addDays(today, 27) }), [type.id]);
  // Family accounts: a private is for one person, so "Who's it for?" is a single choice (me or a dependant)
  const { deps } = useDependants();
  const [forId, setForId] = useState<string | undefined>(undefined);
  const forDep = forId ? deps.find((x) => x.id === forId) : undefined;
  const credits = useData(() => ap.listCredits(forId ?? app.client.id), [app.client.id, forId]);
  const [staffId, setStaffId] = useState('');
  const [day, setDay] = useState('');
  const [sel, setSel] = useState<AppointmentSlot | null>(null);
  const [people, setPeople] = useState(1);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<'pack' | 'card_online'>('card_online');
  const [step, setStep] = useState<'pick' | 'pay' | 'done'>('pick');
  const [busy, setBusy] = useState(false);
  const [waiver, setWaiver] = useState(false);
  const [done, setDone] = useState<Appointment | null>(null);
  useBackHandler(step === 'pay', () => setStep('pick'));

  const staffNames = useMemo(() => type.staffIds.map((id) => ({ id, name: app.staff.find((s) => s.id === id)?.name ?? 'Instructor' })), [type.id, app.staff]);
  const all = (slots.data ?? []).filter((s) => !staffId || s.staffId === staffId);
  // "Anyone": one chip per start time (the first instructor who's free)
  const unique = useMemo(() => { const seen = new Set<string>(); return all.filter((s) => (seen.has(s.startsAt) ? false : (seen.add(s.startsAt), true))); }, [slots.data, staffId]);
  const days = useMemo(() => { const m = new Map<string, AppointmentSlot[]>(); for (const s of unique) { const d = dateOf(s.startsAt); (m.get(d) ?? m.set(d, []).get(d)!).push(s); } return m; }, [unique]);
  const dayKeys = [...days.keys()];
  const activeDay = day && days.has(day) ? day : dayKeys[0] ?? '';
  const daySlots = days.get(activeDay) ?? [];
  const usable = sel ? usableCredits(credits.data ?? [], type.id, new Date(sel.startsAt)) : [];
  const haveCredits = usable.reduce((n, c) => n + c.remaining, 0);
  const canPack = !!sel && haveCredits >= people;
  const effective: 'pack' | 'card_online' = canPack && method === 'pack' ? 'pack' : 'card_online';
  const total = people * type.priceCents;
  const staffName = (id: string) => app.staff.find((s) => s.id === id)?.name ?? 'your instructor';

  useEffect(() => { if (canPack) setMethod('pack'); else setMethod('card_online'); }, [canPack]);
  useEffect(() => { if (sel && !all.some((s) => s.startsAt === sel.startsAt && s.staffId === sel.staffId)) setSel(null); }, [staffId]);

  const book = async (m: 'pack' | 'card_online') => {
    if (!sel) return;
    setBusy(true);
    try {
      if (m === 'card_online') await fakeCardDelay();
      const r = await ap.bookAppointment({ typeId: type.id, staffId: sel.staffId, startsAt: sel.startsAt, people, ...(forId ? { clientId: forId } : {}), ...(note.trim() ? { note: note.trim() } : {}), pay: { method: m } });
      setDone(r.appointment); setStep('done');
    } catch (e: any) {
      if (e?.code === 'WAIVER_REQUIRED') setWaiver(true); else toast(errorMessage(e));
    } finally { setBusy(false); }
  };
  const next = async () => {
    if (!sel) return;
    if (effective === 'pack') return book('pack');
    setBusy(true);
    try {
      const went = await tryCheckout({ kind: 'appointment', booking: { typeId: type.id, staffId: sel.staffId, startsAt: sel.startsAt, people, ...(note.trim() ? { note: note.trim() } : {}) }, ...(forId ? { clientId: forId } : {}), returnUrl: returnUrl() });
      if (!went) setStep('pay');
    } catch (e: any) {
      if (e?.code === 'WAIVER_REQUIRED') setWaiver(true); else toast(errorMessage(e));
    } finally { setBusy(false); }
  };

  if (step === 'done' && done) {
    return (
      <>
        <SheetHead onClose={onClose} />
        <div className="success">
          <div className="success-mark"><Flower size={64} className="bloom" /></div>
          <h2>You’re <em>booked</em></h2>
          <p className="muted">{done.typeName} with {done.staffName}<br />{dayFull(done.startsAt)}, {range(done.startsAt, done.endsAt)}</p>
          <p className="fine muted">We’ve emailed you the details. {cancelNote(done.startsAt, app.settings.cancelWindowHours, done.payment.method === 'pack' ? 'credit' : 'payment')}</p>
          <div className="stack"><button className="btn block" onClick={onDone}>See my bookings</button><button className="btn ghost block" onClick={onClose}>Done</button></div>
        </div>
      </>
    );
  }
  if (step === 'pay' && sel) {
    return (
      <div className="stack lg ap-stack">
        <SheetHead back={{ label: 'Times', onClick: () => setStep('pick') }} eyebrow="Checkout" title={<>{money(total)} <span className="muted-serif">· {type.name}</span></>} onClose={onClose} />
        {waiver && <WaiverNote nav={nav} where="/appointments" {...(forDep ? { dep: forDep } : {})} />}
        <PayStep amountCents={total} busy={busy} onPay={() => book('card_online')} note={`${dayFull(sel.startsAt)}, ${clock(sel.startsAt)} with ${staffName(sel.staffId)}`} />
      </div>
    );
  }
  return (
    <div className="stack lg ap-stack">
      <SheetHead eyebrow={`${type.durationMin} min · ${type.capacity === 2 ? 'Up to 2 people' : '1 person'}`} title={type.name} onClose={onClose} />
      {type.description && <p className="muted">{type.description}</p>}
      {type.bookingNote && <div className="note cream"><Icon name="info" size={20} /><div>{type.bookingNote}</div></div>}
      {waiver && <WaiverNote nav={nav} where="/appointments" {...(forDep ? { dep: forDep } : {})} />}
      {slots.error && !slots.data ? <ErrorBlock error={slots.error} onRetry={slots.reload} /> : !slots.data ? <CardSkeletons n={2} h={64} /> : (
        <>
          {staffNames.length > 1 && (
            <div className="group"><div className="group-label">Instructor</div>
              <div className="ap-opts">
                <button className="ap-opt" aria-pressed={!staffId} onClick={() => setStaffId('')}>Anyone</button>
                {staffNames.map((s) => <button key={s.id} className="ap-opt" aria-pressed={staffId === s.id} onClick={() => setStaffId(s.id)}>{s.name.split(' ')[0]}</button>)}
              </div>
            </div>
          )}
          {dayKeys.length === 0 ? <p className="panel-soft">No times are open in the next four weeks{staffId ? ` with ${staffName(staffId).split(' ')[0]}` : ''}. Try another instructor, or ask the studio.</p> : (
            <>
              <div className="group"><div className="group-label">Day</div>
                <div className="ap-days" role="group" aria-label="Choose a day">
                  {dayKeys.map((d) => {
                    const [wd, dn] = dayLabel(d).split(' ');
                    return <button key={d} className="ap-day" aria-pressed={d === activeDay} onClick={() => { setDay(d); setSel(null); }}><small>{wd}</small><strong>{dn}</strong><small>{dayLabel(d).split(' ')[2]}</small></button>;
                  })}
                </div>
              </div>
              <div className="group"><div className="group-label">Time · {dayFull(activeDay)}</div>
                <div className="ap-slots">
                  {daySlots.map((s) => <button key={s.startsAt + s.staffId} className="ap-slot" aria-pressed={sel?.startsAt === s.startsAt} onClick={() => setSel(s)}>{clock(s.startsAt)}</button>)}
                </div>
              </div>
            </>
          )}
          {sel && (
            <>
              {deps.length > 0 && (
                <WhosComing single title="Who’s coming?" selected={[forId ?? app.client.id]} onChange={([id]) => { setForId(id === app.client.id ? undefined : id); setWaiver(false); }}
                  options={[{ id: app.client.id, name: `${app.client.firstName} (you)`, ...(app.client.photoUrl ? { photoUrl: app.client.photoUrl } : {}) },
                    ...deps.map((x) => ({ id: x.id, name: fullName(x), ...(x.waiverSignedAt ? {} : { flag: 'Waiver needed' }), ...(x.photoUrl ? { photoUrl: x.photoUrl } : {}) }))]} />
              )}
              {type.capacity === 2 && (
                <div className="group"><div className="group-label">{forDep ? `${forDep.firstName} and a friend` : 'Who’s coming'}</div>
                  <div className="ap-opts">
                    <button className="ap-opt" aria-pressed={people === 1} onClick={() => setPeople(1)}>{forDep ? `Just ${forDep.firstName}` : 'Just me'}</button>
                    <button className="ap-opt" aria-pressed={people === 2} onClick={() => setPeople(2)}>{forDep ? `${forDep.firstName} and a friend` : 'Me and a friend'}</button>
                  </div>
                </div>
              )}
              <label className="field"><span>Anything we should know? (optional)</span><textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Injuries, goals, first time on a reformer…" /></label>
              {canPack && (
                <div className="group"><div className="group-label">Pay with</div>
                  <div className="ap-opts">
                    <button className="ap-opt" aria-pressed={effective === 'pack'} onClick={() => setMethod('pack')}>{people} {people === 1 ? 'credit' : 'credits'} ({haveCredits} left)</button>
                    <button className="ap-opt" aria-pressed={effective === 'card_online'} onClick={() => setMethod('card_online')}>Card · {money(total)}</button>
                  </div>
                </div>
              )}
              <div className="ap-sum">
                <strong>{dayFull(sel.startsAt)}, {clock(sel.startsAt)}</strong>
                <span>{type.durationMin} min with {staffName(sel.staffId)}{people === 2 ? ' · 2 people' : ''}</span>
                <span className="ap-fine">{cancelNote(sel.startsAt, app.settings.cancelWindowHours, effective === 'pack' ? 'credit' : 'payment')}</span>
              </div>
              <button className="btn block big" disabled={busy} onClick={next}>
                {busy ? 'One moment…' : effective === 'pack' ? `Book with ${people === 1 ? 'a credit' : 'credits'}` : total === 0 ? 'Book' : `Continue to pay ${money(total)}`}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ buy a pack
function PackBody({ pack, onClose }: { pack: AppointmentPack; onClose: () => void }) {
  const toast = useToast();
  const ap = needAppts();
  const [step, setStep] = useState<'review' | 'pay' | 'done'>('review');
  const [busy, setBusy] = useState(false);
  useBackHandler(step === 'pay', () => setStep('review'));
  const start = async () => {
    setBusy(true);
    try { if (!(await tryCheckout({ kind: 'pack', packId: pack.id, returnUrl: returnUrl() }))) setStep('pay'); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  const pay = async () => {
    setBusy(true);
    try { await fakeCardDelay(); await ap.buyPack({ packId: pack.id, method: 'card_online' }); setStep('done'); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  if (step === 'done') {
    return (<><SheetHead onClose={onClose} /><div className="success"><div className="success-mark"><Flower size={64} className="bloom" /></div><h2>Pack <em>added</em></h2>
      <p className="muted">{pack.credits} credits are ready. Use them when you book a private.</p><div className="stack"><button className="btn block" onClick={onClose}>Done</button></div></div></>);
  }
  if (step === 'pay') {
    return (<div className="stack lg ap-stack"><SheetHead back={{ label: pack.name, onClick: () => setStep('review') }} eyebrow="Checkout" title={<>{money(pack.priceCents)} <span className="muted-serif">· {pack.name}</span></>} onClose={onClose} />
      <PayStep amountCents={pack.priceCents} busy={busy} onPay={pay} /></div>);
  }
  return (
    <div className="stack lg ap-stack">
      <SheetHead eyebrow="Appointment pack" title={pack.name} onClose={onClose} />
      {pack.description && <p className="muted">{pack.description}</p>}
      <div className="ap-sum"><strong>{pack.credits} sessions · {price(pack.priceCents)}</strong>
        <span>{pack.credits > 0 && pack.priceCents > 0 ? `${money(Math.round(pack.priceCents / pack.credits), { cents: true })} a session. ` : ''}One credit covers one person for one session{pack.validityDays ? `, and your pack lasts ${pack.validityDays} days from first use` : ''}.</span></div>
      <button className="btn block big" disabled={busy} onClick={start}>{busy ? 'One moment…' : `Buy for ${money(pack.priceCents)}`}</button>
    </div>
  );
}

// ------------------------------------------------------------------ an event, workshop or course
function EventBody({ id, nav, onClose }: { id: string; nav: Nav; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const ap = needAppts();
  const ev = useData(() => ap.getEvent(id), [id]);
  const [step, setStep] = useState<'view' | 'pay' | 'done' | 'cancel'>('view');
  const [busy, setBusy] = useState(false);
  const [waiver, setWaiver] = useState(false);
  const [outcome, setOutcome] = useState<string>('');
  // Family accounts: tick who's coming (a paid online checkout in live mode is one person at a time), and cancel a dependant's spot
  const { deps } = useDependants();
  const [who, setWho] = useState<string[] | null>(null);
  const [ctarget, setCtarget] = useState<{ id: string; name: string } | null>(null);
  const famRegs = useData(() => (deps.length ? ap.listRegistrations({ clientId: app.client.id }) : Promise.resolve([] as EventRegistration[])), [id, deps.length, ev.data?.spotsLeft]);
  useBackHandler(step === 'pay', () => setStep('view'));
  const e: StudioEventSummary | undefined = ev.data;
  if (!e) return <div className="stack lg ap-stack"><SheetHead onClose={onClose} />{ev.error ? <ErrorBlock error={ev.error} onRetry={ev.reload} /> : <CardSkeletons n={2} h={90} />}</div>;

  const started = Date.now() >= Date.parse(eventStart(e));
  const offered = e.myWaitlist?.status === 'offered' ? e.myWaitlist : undefined;   // a place is being held for them
  const avail = offered ? Math.max(1, e.spotsLeft) : e.spotsLeft;
  const full = avail <= 0;
  const me = app.client.id;
  const famIn = (famRegs.data ?? []).filter((r) => r.eventId === e.id && r.status === 'registered' && r.clientId !== me);
  const options = [
    ...(e.mine ? [] : [{ id: me, name: `${app.client.firstName} (you)`, ...(app.client.photoUrl ? { photoUrl: app.client.photoUrl } : {}) }]),
    ...deps.filter((x) => !famIn.some((r) => r.clientId === x.id)).map((x) => ({ id: x.id, name: fullName(x), ...(x.waiverSignedAt ? {} : { flag: 'Waiver needed' }), ...(x.photoUrl ? { photoUrl: x.photoUrl } : {}) })),
  ];
  const onePerCheckout = store.mode === 'live' && e.priceCents > 0;
  const picked = (who ?? (e.mine ? [] : [me])).filter((x) => options.some((o) => o.id === x));
  const sel = onePerCheckout ? picked.slice(0, 1) : picked;
  const showWho = deps.length > 0 && options.length > 0;
  const signUp = deps.length > 0 ? sel : [me];
  const total = e.priceCents * Math.max(1, signUp.length);
  const nameOf = (cid: string) => (cid === me ? 'you' : deps.find((x) => x.id === cid)?.firstName ?? 'them');
  const unsigned = deps.find((x) => signUp.includes(x.id) && !x.waiverSignedAt);
  const register = async (viaCard: boolean) => {
    if (unsigned) { leaveSheets(() => goFlow(nav, `/family?sign=${encodeURIComponent(unsigned.id)}&then=1`, { label: 'Privates and events', where: '/appointments?tab=events' })); return; }
    if (signUp.length > avail) { toast(avail === 1 ? 'There’s only 1 spot left.' : `There are only ${avail} spots left.`); return; }
    setBusy(true);
    try {
      if (viaCard) await fakeCardDelay();
      for (const cid of signUp) await ap.register({ eventId: e.id, ...(cid !== me ? { clientId: cid } : {}), method: 'card_online' });
      if (signUp.length > 1 || signUp[0] !== me) setOutcome('');
      setStep('done'); setWho(null); ev.reload(); famRegs.reload();
    } catch (x: any) {
      if (x?.code === 'WAIVER_REQUIRED') setWaiver(true); else toast(errorMessage(x));
    } finally { setBusy(false); }
  };
  const start = async () => {
    if (e.priceCents === 0) return register(false);
    if (unsigned) return register(false);
    setBusy(true);
    try {
      const cid = signUp[0] !== me ? signUp[0] : undefined;
      if (!(await tryCheckout({ kind: 'event', eventId: e.id, ...(cid ? { clientId: cid } : {}), returnUrl: returnUrl() }))) setStep('pay');
    }
    catch (x: any) { if (x?.code === 'WAIVER_REQUIRED') setWaiver(true); else toast(errorMessage(x)); }
    finally { setBusy(false); }
  };
  const joinLine = async () => {
    setBusy(true);
    try { await ap.joinWaitlist({ eventId: e.id }); toast('You’re on the waitlist. We’ll email you if a place opens.'); ev.reload(); }
    catch (x: any) { if (x?.code === 'WAIVER_REQUIRED') setWaiver(true); else toast(errorMessage(x)); }
    finally { setBusy(false); }
  };
  const leaveLine = async () => {
    if (!e.myWaitlist) return;
    setBusy(true);
    try { await ap.leaveWaitlist(e.myWaitlist.id); toast(offered ? 'Thanks for letting us know. The place goes to the next person.' : 'You’re off the waitlist.'); ev.reload(); }
    catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };
  const target = ctarget ?? (e.mine ? { id: e.mine.id, name: '' } : null);
  const cancel = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await ap.cancelRegistration(target.id);
      setCtarget(null);
      setOutcome(r.late ? 'Cancelled. It was inside the refund window, so your payment isn’t returned.' : r.refundDue ? 'Cancelled. The studio will refund what you paid.' : 'Cancelled.');
      setStep('done'); ev.reload();
    } catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };

  if (step === 'done') {
    return (<><SheetHead onClose={onClose} /><div className="success"><div className="success-mark"><Flower size={64} className="bloom" /></div>
      <h2>{outcome ? <>All <em>done</em></> : <>You’re <em>in</em></>}</h2>
      <p className="muted">{outcome || `${e.title}, ${eventWhen(e)}. We’ve emailed you the details.`}</p>
      <div className="stack"><button className="btn block" onClick={onClose}>Done</button></div></div></>);
  }
  if (step === 'pay') {
    return (<div className="stack lg ap-stack"><SheetHead back={{ label: e.title, onClick: () => setStep('view') }} eyebrow="Checkout" title={<>{money(e.priceCents)} <span className="muted-serif">· {e.title}</span></>} onClose={onClose} />
      {waiver && <WaiverNote nav={nav} where="/appointments?tab=events" />}
      <PayStep amountCents={total} busy={busy} onPay={() => register(true)} note={signUp.length > 1 ? `${signUp.length} spots · ${signUp.map(nameOf).join(', ')}` : undefined} /></div>);
  }
  return (
    <div className="stack lg ap-stack">
      <SheetHead eyebrow={KIND_LABEL[e.kind]} title={e.title} onClose={onClose} />
      {e.imageUrl && <div className="ap-thumb" style={{ backgroundImage: `url(${brandAsset(e.imageUrl)})`, borderRadius: 18 }} />}
      {e.description && <p className="muted" style={{ whiteSpace: 'pre-line' }}>{e.description}</p>}
      <ul className="ap-sessions">
        {e.sessions.map((s, i) => <li key={s.startsAt}><span>{e.sessions.length > 1 ? `Session ${i + 1} · ` : ''}{dayLabel(s.startsAt)}</span><span>{range(s.startsAt, s.endsAt)}</span></li>)}
      </ul>
      <div className="ap-meta"><span>{price(e.priceCents)}{e.sessions.length > 1 && e.priceCents > 0 ? ' for all sessions' : ''}</span>{e.location && <span>{e.location}</span>}<span>{e.spotsLeft <= 0 ? 'Full' : `${e.spotsLeft} ${e.spotsLeft === 1 ? 'spot' : 'spots'} left`}</span></div>
      {waiver && <WaiverNote nav={nav} where="/appointments?tab=events" />}
      {offered && (
        <div className="note ok"><Icon name="check" size={20} /><div><strong>A place has opened up for you.</strong> It’s yours until {dayLabel(offered.offerExpiresAt!)}, {clock(offered.offerExpiresAt!)}. {e.priceCents > 0 ? 'Sign up and pay to keep it.' : 'Save your spot to keep it.'}</div></div>
      )}
      {e.myWaitlist && !offered && (
        <div className="note cream"><Icon name="info" size={20} /><div>You’re number {e.myWaitlist.position} on the waitlist. We’ll email you if a place opens up, and hold it for you for a little while.</div></div>
      )}
      {e.mine && <div className="note ok"><Icon name="check" size={20} /><div>You’re registered{e.mine.payment.amountCents > 0 ? ` and paid ${money(e.mine.payment.amountCents, { cents: true })}` : ''}.</div></div>}
      {famIn.map((r) => (
        <div key={r.id} className="note ok fam-row"><Icon name="check" size={20} /><div>{r.clientName.split(' ')[0]} is registered.</div>
          {!started && <button className="btn sm soft" aria-label={`Cancel ${r.clientName.split(' ')[0]}’s spot`} onClick={() => { setCtarget({ id: r.id, name: r.clientName.split(' ')[0]! }); setStep('cancel'); }}>Cancel</button>}
        </div>
      ))}
      {step === 'cancel' && target && (
        <div className="stack">
          <p className="muted">{cancelNote(eventStart(e), e.refundCutoffHours, 'payment')}</p>
          <button className="btn danger-solid block" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : target.name ? `Yes, cancel ${target.name}’s spot` : 'Yes, cancel my spot'}</button>
          <button className="btn ghost block" onClick={() => { setCtarget(null); setStep('view'); }}>Keep the spot</button>
        </div>
      )}
      {step !== 'cancel' && e.mine && !started && <button className="btn ghost block" onClick={() => { setCtarget(null); setStep('cancel'); }}>Cancel my spot</button>}
      {step !== 'cancel' && (!e.mine || showWho) && (
        <>
          {showWho && !started && !full && <WhosComing options={options} selected={sel} onChange={setWho} single={onePerCheckout} />}
          {!e.mine && full && !started && !e.myWaitlist && <p className="ap-fine">This one is full. Join the waitlist and we’ll email you if a place opens up.</p>}
          {!e.mine && !(full && !started) && <p className="ap-fine">{e.priceCents > 0 ? cancelNote(eventStart(e), e.refundCutoffHours, 'payment').replace('Free to cancel', 'Full refund if you cancel') : 'Free to join. Please cancel if you can’t make it so someone else can come.'}</p>}
          {(!e.mine || showWho) && (full && !e.mine && !started ? (
            e.myWaitlist
              ? <button className="btn ghost block" disabled={busy} onClick={leaveLine}>Leave the waitlist</button>
              : <button className="btn block big" disabled={busy} onClick={joinLine}>{busy ? 'One moment…' : 'Join the waitlist'}</button>
          ) : (
            <button className="btn block big" disabled={busy || full || started || (showWho && sel.length === 0)} onClick={start}>
              {started ? 'Sign-up has closed' : full ? 'Sorry, this one is full' : busy ? 'One moment…' : showWho && sel.length === 0 ? 'Choose who’s coming' : e.priceCents === 0 ? (signUp.length > 1 ? `Save ${signUp.length} spots` : 'Save my spot') : `Sign up for ${money(total)}`}
            </button>
          ))}
          {offered && !started && <button className="btn ghost block" disabled={busy} onClick={leaveLine}>Give the place back</button>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ mine
function Mine({ nav, appts, regs, credits, events, reload }: {
  nav: Nav;
  appts: { data?: Appointment[]; error?: Error; reload: () => void };
  regs: { data?: EventRegistration[]; error?: Error; reload: () => void };
  credits: AppointmentCredit[]; events: StudioEventSummary[]; reload: () => void;
}) {
  const app = useApp();
  const toast = useToast();
  const [open, setOpen] = useState<Appointment | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const list = appts.data ?? [];
  const upcoming = list.filter((a) => a.status === 'booked' && Date.parse(a.endsAt) > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = list.filter((a) => !upcoming.includes(a)).sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, 8);
  const myRegs = (regs.data ?? []).filter((r) => r.status === 'registered').sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const active = credits.filter((c) => c.status === 'active');
  const waiting = events.filter((e) => e.myWaitlist);
  const cancel = async () => {
    if (!open) return;
    setBusy(true);
    try {
      const r = await needAppts().cancelAppointment(open.id);
      toast(r.late ? 'Cancelled. It was inside the cancellation window, so it isn’t refunded.' : r.creditsReturned ? 'Cancelled. Your credit is back.' : r.refundDue ? 'Cancelled. The studio will refund you.' : 'Cancelled.');
      setOpen(null); reload();
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  if (appts.error && !appts.data) return <div className="mt-20"><ErrorBlock error={appts.error} onRetry={appts.reload} /></div>;
  if (!appts.data || !regs.data) return <div className="mt-20"><CardSkeletons n={2} h={80} /></div>;
  const nothing = upcoming.length === 0 && myRegs.length === 0 && past.length === 0 && active.length === 0 && waiting.length === 0;
  return (
    <div className="stack mt-20">
      {nothing && <Empty title="Nothing booked yet">Your privates, workshops and credits will live here.</Empty>}
      {active.length > 0 && (
        <div className="group"><div className="group-label">Your credits</div>
          <div className="list-card">{active.map((c) => (
            <div key={c.id} className="list-row" style={{ cursor: 'default' }}><span className="row-ic"><Flower size={20} /></span>
              <span className="list-row-main"><span className="list-row-title">{c.name}</span>
                <span className="list-row-sub">{c.remaining} of {c.credits} left{c.expiresAt ? ` · until ${dayLabel(c.expiresAt)}` : c.validityDays ? ` · valid ${c.validityDays} days from first use` : ''}</span></span></div>
          ))}</div>
        </div>
      )}
      {(upcoming.length > 0 || myRegs.length > 0) && (
        <div className="group"><div className="group-label">Coming up</div>
          <div className="list-card">
            {upcoming.map((a) => (
              <button key={a.id} className="list-row" onClick={() => setOpen(a)}><span className="row-ic"><Icon name="calendar" size={20} /></span>
                <span className="list-row-main"><span className="list-row-title">{a.typeName}{a.people > 1 ? ' · 2 people' : ''}{a.clientId !== app.client.id ? ` · ${a.clientName.split(' ')[0]}` : ''}</span>
                  <span className="list-row-sub">{dayLabel(a.startsAt)}, {clock(a.startsAt)} with {a.staffName.split(' ')[0]}</span></span><Icon name="chevron" size={18} /></button>
            ))}
            {myRegs.map((r) => {
              const e = events.find((x) => x.id === r.eventId);
              return (
                <div key={r.id} className="list-row" style={{ cursor: 'default' }}><span className="row-ic"><Flower size={20} /></span>
                  <span className="list-row-main"><span className="list-row-title">{r.eventTitle}{r.clientId !== app.client.id ? ` · ${r.clientName.split(' ')[0]}` : ''}</span>
                    <span className="list-row-sub">{e ? eventWhen(e) : dayLabel(r.startsAt)}</span></span>
                  <button className="btn soft sm" onClick={() => nav('/appointments?tab=events')}>Details</button></div>
              );
            })}
          </div>
        </div>
      )}
      {waiting.length > 0 && (
        <div className="group"><div className="group-label">Waitlist</div>
          <div className="list-card">{waiting.map((e) => {
            const w = e.myWaitlist!;
            return (
              <div key={w.id} className="list-row" style={{ cursor: 'default' }}><span className="row-ic"><Flower size={20} /></span>
                <span className="list-row-main"><span className="list-row-title">{e.title}</span>
                  <span className="list-row-sub">{w.status === 'offered' ? `A place is held for you until ${dayLabel(w.offerExpiresAt!)}, ${clock(w.offerExpiresAt!)}` : `Number ${w.position} in line`}</span></span>
                <button className={'btn sm ' + (w.status === 'offered' ? '' : 'soft')} onClick={() => nav('/appointments?tab=events')}>{w.status === 'offered' ? 'Claim' : 'Details'}</button></div>
            );
          })}</div>
        </div>
      )}
      {past.length > 0 && (
        <div className="group"><div className="group-label">Recent</div>
          <div className="list-card">{past.map((a) => (
            <div key={a.id} className="list-row" style={{ cursor: 'default' }}><span className="row-ic"><Icon name="clock" size={20} /></span>
              <span className="list-row-main"><span className="list-row-title">{a.typeName}</span><span className="list-row-sub">{dayLabel(a.startsAt)}, {clock(a.startsAt)} · {APPT_STATUS_LABEL[a.status]}</span></span></div>
          ))}</div>
        </div>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} label="Your appointment">
        {open && (
          <div className="stack lg ap-stack">
            <SheetHead eyebrow={`${open.people > 1 ? '2 people · ' : ''}${open.staffName}`} title={open.typeName} onClose={() => setOpen(null)} />
            <div className="ap-sum"><strong>{dayFull(open.startsAt)}</strong><span>{range(open.startsAt, open.endsAt)}</span>{open.note && <span className="ap-fine">Your note: {open.note}</span>}</div>
            <p className="muted">{cancelNote(open.startsAt, app.settings.cancelWindowHours, open.payment.method === 'pack' ? 'credit' : 'payment')}</p>
            <button className="btn danger-solid block" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : 'Cancel this session'}</button>
            <button className="btn ghost block" onClick={() => setOpen(null)}>Keep it</button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------ timetable banner
export function TimetableBanner({ nav }: { nav: Nav }) {
  const ap = store.features.appointments;
  const types = useData(async () => (ap ? ap.listTypes() : []), []);
  const events = useData(async () => (ap ? ap.listEvents() : []), []);
  if (!ap || (!(types.data ?? []).length && !(events.data ?? []).length)) return null;
  const n = (events.data ?? []).length;
  const offer = (events.data ?? []).find((e) => e.myWaitlist?.status === 'offered');
  if (offer) {
    return (
      <button className="ap-promo" style={{ margin: '0 0 16px' }} onClick={() => nav('/appointments?tab=events')}>
        <ApptIcon size={26} />
        <span style={{ flex: 1 }}><strong>A place opened up</strong><span>{offer.title} is held for you until {dayLabel(offer.myWaitlist!.offerExpiresAt!)}, {clock(offer.myWaitlist!.offerExpiresAt!)}</span></span>
        <Icon name="chevron" size={18} />
      </button>
    );
  }
  return (
    <button className="ap-promo" style={{ margin: '0 0 16px' }} onClick={() => nav('/appointments')}>
      <ApptIcon size={26} />
      <span style={{ flex: 1 }}><strong>Privates{n ? ' and events' : ''}</strong><span>{(types.data ?? []).length ? 'Book a one on one' : 'Workshops and courses'}{n ? `, or join ${n === 1 ? 'a workshop' : `one of ${n} workshops and events`}` : ''}</span></span>
      <Icon name="chevron" size={18} />
    </button>
  );
}
