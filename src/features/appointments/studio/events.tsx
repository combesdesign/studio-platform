/** Studio › Appointments › Events: workshops, courses and events. Create and edit, see who's coming, take attendance, cancel. */
import React, { useEffect, useState } from 'react';
import { Sheet, store, useAction, useData, useToast } from '../../../shared/react';
import { money, studioDate, studioToUTC } from '../../../shared/format';
import { ClientSearch, MethodPicker } from '../../../studio/book';
import { Confirm, Empty, Fill, Icon, Loading, Seg, SheetHead, cx, roleCan, toCents, toDollars, useStudio } from '../../../studio/ui';
import { KIND_LABEL, REG_STATUS_LABEL, clock, dateOf, dayLabel, eventWhen, needAppts, price, range, studioMinutes } from '../api';
import { eventEnd, eventProblem, eventStart, fromMinutes } from '../logic';
import type { AppointmentPayMethod, EventKind, EventRegistration, StudioEventInput, StudioEventSummary } from '../types';

export function EventsTab() {
  const { me } = useStudio();
  const manage = roleCan(me.role, 'appointments.manage');
  const [past, setPast] = useState(false);
  const events = useData(() => needAppts().listEvents({ includePast: past }), [past]);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<StudioEventSummary | 'new' | null>(null);
  return (
    <>
      <div className="ap-toolbar">
        <Seg value={past ? 'all' : 'upcoming'} onChange={(v) => setPast(v === 'all')} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'all', label: 'Including past' }]} />
        {manage && <button className="btn" onClick={() => setEdit('new')}><Icon name="plus" size={18} />New workshop or event</button>}
      </div>
      {events.error && !events.data ? <Empty title="That didn’t load">{events.error.message}</Empty> : !events.data ? <Loading /> : events.data.length === 0 ? (
        <Empty title="No workshops or events">{manage ? 'Add a workshop, a multi-week course or a one-off event and clients can sign up in the app.' : 'Nothing is scheduled.'}</Empty>
      ) : (
        <div className="ap-grid">
          {events.data.map((e) => (
            <button key={e.id} className="ap-ecard" onClick={() => setOpen(e.id)}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className="chip navy">{KIND_LABEL[e.kind]}</span>
                {e.cancelled ? <span className="chip danger">Cancelled</span> : !e.published ? <span className="chip warn">Draft</span> : null}
              </div>
              <h4>{e.title}</h4>
              <div className="muted">{eventWhen(e)}{e.location ? ` · ${e.location}` : ''}</div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <span><strong>{e.registered}</strong> / {e.capacity} <span className="muted">signed up</span></span><span>{price(e.priceCents)}</span>
              </div>
              <Fill value={e.registered} max={e.capacity} />
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} label="Event">
        {open && <EventSheet key={open} id={open} onClose={() => setOpen(null)} onEdit={(e) => { setOpen(null); setEdit(e); }} />}
      </Sheet>
      <Sheet open={!!edit} onClose={() => setEdit(null)} label="Edit event">
        {edit && <EventEditor key={edit === 'new' ? 'new' : edit.id} event={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); events.reload(); }} />}
      </Sheet>
    </>
  );
}

// ------------------------------------------------------------------ one event: attendees
function EventSheet({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (e: StudioEventSummary) => void }) {
  const { me, staffById } = useStudio();
  const toast = useToast();
  const ap = needAppts();
  const manage = roleCan(me.role, 'appointments.manage');
  const book = roleCan(me.role, 'appointments.book');
  const ev = useData(() => ap.getEvent(id), [id]);
  const regs = useData(() => ap.listRegistrations({ eventId: id }), [id]);
  const { busy, run } = useAction();
  const [add, setAdd] = useState(false);
  const [method, setMethod] = useState<Exclude<AppointmentPayMethod, 'pack' | 'card_online'>>('card_reader');
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [cancelEv, setCancelEv] = useState(false);
  const [reason, setReason] = useState('');
  const e = ev.data;
  if (!e) return <><SheetHead title="Event" onClose={onClose} /><Loading /></>;
  const list = regs.data ?? [];
  const going = list.filter((r) => r.status === 'registered');
  const others = list.filter((r) => r.status !== 'registered');
  const reload = () => { ev.reload(); regs.reload(); };
  const register = () => pick && run(async () => { await ap.register({ eventId: e.id, clientId: pick.id, method: e.priceCents === 0 ? 'comp' : method }); setAdd(false); setPick(null); reload(); }, 'Added');
  const toggle = (r: EventRegistration, at: string, present: boolean) => run(async () => { await ap.setAttendance(r.id, at, present); regs.reload(); });
  const cancelReg = (r: EventRegistration, waive: boolean) => run(async () => { const o = await ap.cancelRegistration(r.id, waive ? { waivePenalty: true } : undefined); toast(o.refundDue ? 'Cancelled, refund due' : o.late ? 'Cancelled late' : 'Cancelled'); reload(); });
  const refund = (r: EventRegistration) => run(async () => {
    if (r.payment.saleId) await store.refundSale(r.payment.saleId, { reason: 'Event cancelled' });
    await ap.markRefunded({ registrationId: r.id }); reload();
  }, 'Refunded');
  return (
    <>
      <SheetHead title={e.title} sub={`${KIND_LABEL[e.kind]} · ${eventWhen(e)}${e.location ? ` · ${e.location}` : ''}`} onClose={onClose} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <span className="chip">{going.length} / {e.capacity} signed up</span><span className="chip">{price(e.priceCents)}</span>
        {e.hostStaffId && <span className="chip">Host: {staffById(e.hostStaffId)?.name ?? 'Instructor'}</span>}
        {e.cancelled ? <span className="chip danger">Cancelled{e.cancelReason ? `: ${e.cancelReason}` : ''}</span> : !e.published && <span className="chip warn">Draft, hidden from clients</span>}
      </div>
      {e.sessions.length > 1 && <ul className="ap-sessions" style={{ marginBottom: 14 }}>{e.sessions.map((s, i) => <li key={s.startsAt}><span>Session {i + 1} · {dayLabel(s.startsAt)}</span><span>{range(s.startsAt, s.endsAt)}</span></li>)}</ul>}
      <h3 className="small-h" style={{ marginBottom: 6 }}>Who’s <em>coming</em></h3>
      {regs.error && !regs.data ? <p className="muted">{regs.error.message}</p> : !regs.data ? <Loading /> : going.length === 0 ? <p className="muted">No one yet.</p> : (
        <div>
          {going.map((r) => (
            <div key={r.id} className="ap-att">
              <span className="grow"><strong>{r.clientName}</strong><div className="muted small">{r.payment.amountCents > 0 ? `Paid ${money(r.payment.amountCents, { cents: true })}` : 'Free / comp'}</div></span>
              {e.sessions.map((s, i) => {
                const present = r.attended.includes(s.startsAt);
                return <button key={s.startsAt} className={cx('chip flag', present && 'ok')} aria-pressed={present} disabled={busy || Date.now() < Date.parse(s.startsAt)} title={Date.now() < Date.parse(s.startsAt) ? 'Opens when the session starts' : undefined}
                  onClick={() => toggle(r, s.startsAt, !present)}>{present && <Icon name="check" size={14} />}{e.sessions.length > 1 ? `S${i + 1}` : 'Here'}</button>;
              })}
              {book && !e.cancelled && <button className="btn ghost sm" disabled={busy} onClick={() => cancelReg(r, false)}>Cancel</button>}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted small" style={{ marginBottom: 4 }}>Cancelled</div>
          {others.map((r) => (
            <div key={r.id} className="ap-att"><span className="grow">{r.clientName}<div className="muted small">{REG_STATUS_LABEL[r.status]}</div></span>
              {r.refundDue && book && r.payment.saleId && <button className="btn sm" disabled={busy} onClick={() => refund(r)}>Refund {money(r.payment.amountCents, { cents: true })}</button>}</div>
          ))}
        </div>
      )}
      {book && !e.cancelled && (
        <div style={{ marginTop: 16 }}>
          {!add ? <button className="chip-btn" onClick={() => setAdd(true)}><Icon name="plus" size={16} />Add someone</button> : !pick ? (
            <><div className="muted small" style={{ marginBottom: 6 }}>Pick a client</div><ClientSearch autoFocus exclude={going.map((r) => r.clientId)} onPick={(c) => setPick({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim() })} /></>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <div><strong>{pick.name}</strong> <button className="linkish" onClick={() => setPick(null)}>change</button></div>
              {e.priceCents > 0 && <MethodPicker value={method} onChange={(m) => setMethod(m as typeof method)} />}
              <div className="row" style={{ gap: 8 }}><button className="btn" disabled={busy} onClick={register}>Add to {e.title}</button><button className="btn ghost" onClick={() => { setAdd(false); setPick(null); }}>Never mind</button></div>
            </div>
          )}
        </div>
      )}
      {manage && !e.cancelled && (
        <div className="sh-foot" style={{ justifyContent: 'space-between' }}>
          <button className="btn ghost" onClick={() => setCancelEv(true)}>Cancel event</button>
          <button className="btn" onClick={() => onEdit(e)}>Edit details</button>
        </div>
      )}
      <Confirm open={cancelEv} onClose={() => setCancelEv(false)} title="Cancel this event?" danger busy={busy} confirmLabel="Cancel event"
        body={`Everyone signed up is cancelled and emailed. ${going.some((r) => r.payment.amountCents > 0) ? 'Paid sign-ups are marked refund due.' : ''}`}
        onConfirm={() => run(async () => { await ap.cancelEvent(e.id, reason); setCancelEv(false); reload(); }, 'Event cancelled')}>
        <label className="field"><span>Reason (shown to clients)</span><input className="input" value={reason} onChange={(x) => setReason(x.target.value)} placeholder="Instructor unwell" /></label>
      </Confirm>
    </>
  );
}

// ------------------------------------------------------------------ create / edit
interface Sess { date: string; start: string; end: string }
function EventEditor({ event, onClose, onSaved }: { event: StudioEventSummary | null; onClose: () => void; onSaved: () => void }) {
  const { staff } = useStudio();
  const { busy, run } = useAction();
  const toast = useToast();
  const [v, setV] = useState(() => ({
    kind: (event?.kind ?? 'workshop') as EventKind, title: event?.title ?? '', description: event?.description ?? '', price: toDollars(event?.priceCents ?? 0), capacity: String(event?.capacity ?? 12),
    hostStaffId: event?.hostStaffId ?? '', location: event?.location ?? '', published: event?.published ?? true, refundCutoffHours: String(event?.refundCutoffHours ?? 48),
  }));
  const [sessions, setSessions] = useState<Sess[]>(() => event && event.sessions.length
    ? event.sessions.map((s) => ({ date: dateOf(s.startsAt), start: fromMinutes(studioMinutes(s.startsAt)), end: fromMinutes(studioMinutes(s.endsAt) || 24 * 60 - 1) }))
    : [{ date: studioDate(), start: '10:00', end: '12:00' }]);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  const upd = (i: number, patch: Partial<Sess>) => setSessions((l) => l.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  useEffect(() => { if (v.kind !== 'course') setSessions((l) => l.slice(0, 1)); }, [v.kind]);

  const input = (): StudioEventInput => ({
    ...(event ? { id: event.id } : {}), kind: v.kind, title: v.title.trim(), description: v.description.trim(), priceCents: toCents(v.price), capacity: Math.round(Number(v.capacity) || 0),
    ...(v.hostStaffId ? { hostStaffId: v.hostStaffId } : {}), ...(v.location.trim() ? { location: v.location.trim() } : {}), published: v.published,
    refundCutoffHours: Math.max(0, Math.round(Number(v.refundCutoffHours) || 0)),
    sessions: sessions.map((s) => ({ startsAt: studioToUTC(s.date, s.start), endsAt: studioToUTC(s.date, s.end) })).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  });
  const problem = (() => { const i = input(); return i.title ? eventProblem({ title: i.title, capacity: i.capacity, priceCents: i.priceCents, sessions: i.sessions, refundCutoffHours: i.refundCutoffHours }) : 'Give it a name.'; })();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) { toast(problem); return; }
    const r = await run(() => needAppts().upsertEvent(input()), event ? 'Saved' : 'Event added');
    if (r) onSaved();
  };
  return (
    <form onSubmit={save}>
      <SheetHead title={event ? <>Edit <em>event</em></> : <>New <em>event</em></>} onClose={onClose} />
      <div className="stack" style={{ gap: 14 }}>
        <Seg<EventKind> value={v.kind} onChange={(kind) => setV({ ...v, kind })} options={[{ value: 'workshop', label: 'Workshop' }, { value: 'course', label: 'Course (several sessions)' }, { value: 'event', label: 'Event' }]} />
        <div className="form-grid">
          <label className="field span2"><span>Name</span><input className="input" value={v.title} onChange={set('title')} required /></label>
          <label className="field span2"><span>Description</span><textarea className="textarea" rows={3} value={v.description} onChange={set('description')} /></label>
          <label className="field"><span>{v.kind === 'course' ? 'Price for the whole course' : 'Price per person'}</span><input className="input" inputMode="decimal" value={v.price} onChange={set('price')} placeholder="0 for free" /></label>
          <label className="field"><span>Spots</span><input className="input" inputMode="numeric" value={v.capacity} onChange={set('capacity')} /></label>
          <label className="field"><span>Host</span><select className="select" value={v.hostStaffId} onChange={set('hostStaffId')}><option value="">No one in particular</option>{staff.filter((s) => s.active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="field"><span>Where</span><input className="input" value={v.location} onChange={set('location')} placeholder="Studio, rooftop…" /></label>
          <label className="field"><span>Full refund up to (hours before the first session)</span><input className="input" inputMode="numeric" value={v.refundCutoffHours} onChange={set('refundCutoffHours')} /></label>
        </div>
        <div>
          <div className="muted small" style={{ marginBottom: 6 }}>{v.kind === 'course' ? 'Sessions' : 'When'}</div>
          {sessions.map((s, i) => (
            <div key={i} className="ap-win">
              <input className="input" style={{ width: 150 }} type="date" value={s.date} aria-label="Date" onChange={(e) => e.target.value && upd(i, { date: e.target.value })} />
              <input className="input" type="time" value={s.start} aria-label="Starts" onChange={(e) => upd(i, { start: e.target.value })} />
              <span className="muted">to</span>
              <input className="input" type="time" value={s.end} aria-label="Ends" onChange={(e) => upd(i, { end: e.target.value })} />
              {sessions.length > 1 && <button type="button" className="btn icon soft" aria-label="Remove session" onClick={() => setSessions(sessions.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>}
            </div>
          ))}
          {v.kind === 'course' && <button type="button" className="chip-btn" onClick={() => { const l = sessions[sessions.length - 1]!; const d = new Date(`${l.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); setSessions([...sessions, { ...l, date: d.toISOString().slice(0, 10) }]); }}><Icon name="plus" size={16} />Add a session</button>}
        </div>
        <label className="check"><input type="checkbox" checked={v.published} onChange={set('published')} /><span>Show it to clients in the app</span></label>
        {problem && <p role="alert" style={{ color: 'var(--danger)' }}>{problem}</p>}
      </div>
      <div className="sh-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{event ? 'Save changes' : 'Add event'}</button></div>
    </form>
  );
}
