/** Studio sheets for one appointment: look it over, mark it done, cancel or refund it; and booking a client in. */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, errorMessage, store, useAction, useBackHandler, useData, useToast } from '../../../shared/react';
import { addDays, money, studioDate } from '../../../shared/format';
import type { Client } from '../../../shared/types';
import { ClientSearch, MethodPicker } from '../../../studio/book';
import { Avatar, Confirm, Icon, SheetHead, cx, fullName, roleCan, useStudio } from '../../../studio/ui';
import { APPT_STATUS_LABEL, APPT_STATUS_TONE, clock, dayFull, dayLabel, dateOf, needAppts, range } from '../api';
import { usableCredits } from '../logic';
import type { Appointment, AppointmentSlot, AppointmentPayMethod } from '../types';

export function AppointmentSheet({ appt, onClose }: { appt: Appointment; onClose: () => void }) {
  const { me, settings } = useStudio();
  const toast = useToast();
  const { busy, run } = useAction();
  const ap = needAppts();
  const canBook = roleCan(me.role, 'appointments.book');
  const own = roleCan(me.role, 'appointments.own');
  const [confirm, setConfirm] = useState<null | 'cancel' | 'waive'>(null);
  const [moving, setMoving] = useState(false);
  const started = Date.now() >= Date.parse(appt.startsAt);
  const live = appt.status === 'booked';
  const cancel = (waive: boolean) => run(async () => {
    const r = await ap.cancelAppointment(appt.id, waive ? { waivePenalty: true } : undefined);
    toast(r.late ? 'Cancelled late: the credit or payment is kept' : r.creditsReturned ? 'Cancelled, credit returned' : r.refundDue ? 'Cancelled, refund due' : 'Cancelled');
    setConfirm(null); onClose();
  });
  const refund = () => run(async () => {
    if (appt.payment.saleId) await store.refundSale(appt.payment.saleId, { reason: 'Appointment cancelled' });
    await ap.markRefunded({ appointmentId: appt.id });
    onClose();
  }, 'Refunded');
  const mark = (s: 'completed' | 'no_show' | 'booked') => run(async () => { await ap.setAppointmentStatus(appt.id, s); onClose(); }, s === 'completed' ? 'Marked done' : s === 'no_show' ? 'Marked no-show' : 'Back to booked');
  if (moving) return <StaffMoveBody appt={appt} onClose={() => setMoving(false)} onMoved={onClose} />;
  return (
    <>
      <SheetHead title={<>{appt.typeName}</>} sub={`${dayFull(appt.startsAt)} · ${range(appt.startsAt, appt.endsAt)}`} onClose={onClose} />
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className={cx('chip', APPT_STATUS_TONE[appt.status])}>{APPT_STATUS_LABEL[appt.status]}</span>
          <span className="chip">{appt.people === 2 ? '2 people' : '1 person'}</span>
          <span className="chip">{appt.payment.method === 'pack' ? 'Pack credit' : appt.payment.amountCents ? `Paid ${money(appt.payment.amountCents, { cents: true })}` : 'Comp'}</span>
          {appt.refundDue && <span className="chip warn">Refund due</span>}
        </div>
        <div className="ap-kv">
          <div><span className="muted">Client</span> <a href={`#/clients/${appt.clientId}`}>{appt.clientName}</a></div>
          <div><span className="muted">Instructor</span> {appt.staffName}</div>
          {appt.bufferMin > 0 && <div><span className="muted">Buffer</span> {appt.bufferMin} min after</div>}
          <div><span className="muted">Booked</span> {appt.source === 'staff' ? 'by the studio' : 'by the client'}</div>
        </div>
        {appt.note && <div className="panel-soft"><span className="muted small">Client’s note</span><br />{appt.note}</div>}
        {(own || canBook) && (appt.status === 'booked' || appt.status === 'completed' || appt.status === 'no_show') && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {appt.status !== 'completed' && <button className="btn" disabled={busy || !started} onClick={() => mark('completed')}><Icon name="check" size={17} />Mark done</button>}
            {appt.status !== 'no_show' && <button className="btn ghost" disabled={busy || !started} onClick={() => mark('no_show')}>No-show</button>}
            {appt.status !== 'booked' && <button className="btn ghost" disabled={busy} onClick={() => mark('booked')}>Back to booked</button>}
            {!started && live && <span className="muted small" style={{ alignSelf: 'center' }}>You can mark it once it has started.</span>}
          </div>
        )}
        {canBook && live && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn soft" onClick={() => setMoving(true)}>Move to another time</button>
            <button className="btn ghost" onClick={() => setConfirm('cancel')}>Cancel appointment</button>
            <button className="btn ghost" onClick={() => setConfirm('waive')}>Cancel, no penalty</button>
          </div>
        )}
        {canBook && appt.refundDue && appt.payment.saleId && <button className="btn" disabled={busy} onClick={refund}>Refund {money(appt.payment.amountCents, { cents: true })}</button>}
      </div>
      <Confirm open={!!confirm} onClose={() => setConfirm(null)} title="Cancel this appointment?" confirmLabel={confirm === 'waive' ? 'Cancel, keep nothing' : 'Cancel appointment'} danger busy={busy}
        body={confirm === 'waive' ? 'The client gets their credit back, or a refund is queued if they paid, whatever the cancellation window says.'
          : `Inside the ${settings.cancelWindowHours} hour window the client keeps no credit or refund. Otherwise they get it back.`}
        onConfirm={() => cancel(confirm === 'waive')} />
    </>
  );
}

// ------------------------------------------------------------------ move an appointment (staff)
/**
 * Staff move an appointment any time, to any free slot for any instructor who offers that session type. The client window doesn't
 * apply. It is the same move as the client's (same payment, same credit) and sends the same "moved" email.
 */
function StaffMoveBody({ appt, onClose, onMoved }: { appt: Appointment; onClose: () => void; onMoved: () => void }) {
  const { staffById } = useStudio();
  const { busy, run } = useAction();
  const ap = needAppts();
  const types = useData(() => ap.listTypes(), []);
  const [staffId, setStaffId] = useState('');
  const [day, setDay] = useState(dateOf(appt.startsAt) < studioDate() ? studioDate() : dateOf(appt.startsAt));
  const [sel, setSel] = useState<AppointmentSlot | null>(null);
  const type = types.data?.find((t) => t.id === appt.typeId);
  const slots = useData(() => ap.listSlots({ typeId: appt.typeId, from: day, to: day, excludeAppointmentId: appt.id }), [appt.id, day]);
  useEffect(() => { setSel(null); }, [day, staffId]);
  const list = useMemo(() => {
    const seen = new Set<string>();
    return (slots.data ?? []).filter((s) => (!staffId || s.staffId === staffId) && !(s.staffId === appt.staffId && s.startsAt === appt.startsAt) && (seen.has(s.startsAt) ? false : (seen.add(s.startsAt), true)));
  }, [slots.data, staffId]);
  const who = (id: string) => staffById(id)?.name ?? 'Instructor';
  const move = async () => {
    if (!sel) return;
    const r = await run(() => ap.moveAppointment(appt.id, { startsAt: sel.startsAt, staffId: sel.staffId }), `Moved. ${appt.clientName.split(' ')[0]} has been emailed the new time.`);
    if (r) onMoved(); else slots.reload();
  };
  return (
    <>
      <SheetHead title={<>Move <em>{appt.typeName}</em></>} sub={`Now: ${dayFull(appt.startsAt)}, ${range(appt.startsAt, appt.endsAt)} with ${who(appt.staffId)}`} onClose={onClose} back={{ label: 'Back', onClick: onClose }} />
      <div className="stack" style={{ gap: 16 }}>
        <p className="muted small">Any time works, the cancellation window doesn’t apply. {appt.clientName.split(' ')[0]} keeps their {appt.payment.method === 'pack' ? 'credit' : 'payment'} and gets the usual “moved” email.</p>
        <div className="form-grid">
          <label className="field"><span>Day</span><input className="input" type="date" value={day} min={studioDate()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
          <label className="field"><span>Instructor</span><select className="select" value={staffId} onChange={(e) => setStaffId(e.target.value)}><option value="">Anyone</option>{(type?.staffIds ?? [appt.staffId]).map((id) => <option key={id} value={id}>{who(id)}</option>)}</select></label>
        </div>
        <div>
          <div className="muted small" style={{ marginBottom: 8 }}>Open times · {dayLabel(day)}</div>
          {slots.loading && !slots.data ? <p className="muted">Looking…</p> : list.length === 0 ? <p className="muted">Nothing else open that day. Check the instructor’s hours, or pick another day.</p> : (
            <div className="ap-slots">{list.map((s) => <button key={s.startsAt + s.staffId} type="button" className="ap-slot" aria-pressed={sel?.startsAt === s.startsAt && sel.staffId === s.staffId} onClick={() => setSel(s)}>{clock(s.startsAt)}</button>)}</div>
          )}
        </div>
        {sel && <div className="muted small">{dayFull(sel.startsAt)}, {range(sel.startsAt, sel.endsAt)} with {who(sel.staffId)}</div>}
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Keep it where it is</button><button className="btn" disabled={busy || !sel} onClick={move}>Move it</button></div>
    </>
  );
}

// ------------------------------------------------------------------ book a client in
export function BookForClientSheet({ open, onClose, client: preset }: { open: boolean; onClose: () => void; client?: Client }) {
  return (
    <Sheet open={open} onClose={onClose} label="Book an appointment">
      {open && <BookBody key={preset?.id ?? 'new'} preset={preset} onClose={onClose} />}
    </Sheet>
  );
}

function BookBody({ preset, onClose }: { preset?: Client; onClose: () => void }) {
  const { staff, staffById } = useStudio();
  const toast = useToast();
  const { busy, run } = useAction();
  const ap = needAppts();
  const [client, setClient] = useState<Client | undefined>(preset);
  const types = useData(() => ap.listTypes(), []);
  const [typeId, setTypeId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [day, setDay] = useState(studioDate());
  const [sel, setSel] = useState<AppointmentSlot | null>(null);
  const [people, setPeople] = useState(1);
  const [method, setMethod] = useState<AppointmentPayMethod>('card_reader');
  const [note, setNote] = useState('');
  const type = types.data?.find((t) => t.id === typeId);
  const slots = useData(async () => (typeId ? ap.listSlots({ typeId, from: day, to: day }) : []), [typeId, day]);
  const credits = useData(async () => (client ? ap.listCredits(client.id) : []), [client?.id]);
  useBackHandler(!!client && !preset, () => setClient(undefined));
  useEffect(() => { if (types.data && !typeId && types.data[0]) setTypeId(types.data[0].id); }, [types.data]);
  useEffect(() => { setSel(null); setStaffId(''); setPeople(1); }, [typeId, day]);
  const list = useMemo(() => {
    const seen = new Set<string>();
    return (slots.data ?? []).filter((s) => (!staffId || s.staffId === staffId) && (seen.has(s.startsAt) ? false : (seen.add(s.startsAt), true)));
  }, [slots.data, staffId]);
  const have = sel && type ? usableCredits(credits.data ?? [], type.id, new Date(sel.startsAt)).reduce((n, c) => n + c.remaining, 0) : 0;
  const canPack = have >= people && !!sel;
  useEffect(() => { setMethod(canPack ? 'pack' : (m) => (m === 'pack' ? 'card_reader' : m)); }, [canPack]);

  if (!client) {
    return (
      <>
        <SheetHead title={<>Book an <em>appointment</em></>} sub="Who is it for?" onClose={onClose} />
        <ClientSearch autoFocus onPick={setClient} />
      </>
    );
  }
  const book = async () => {
    if (!sel || !type) return;
    const r = await run(() => ap.bookAppointment({ typeId: type.id, staffId: sel.staffId, startsAt: sel.startsAt, people, clientId: client.id, ...(note.trim() ? { note: note.trim() } : {}), pay: { method } }), 'Booked');
    if (r) onClose();
  };
  const offering = type ? type.staffIds : [];
  return (
    <>
      <SheetHead title={<>Book <em>{client.firstName}</em></>} onClose={onClose} back={preset ? undefined : { label: 'Find a client', onClick: () => setClient(undefined) }} />
      <div className="stack" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}><Avatar name={fullName(client)} photo={client.photoUrl} size={38} /><div><strong>{fullName(client)}</strong>{credits.data && credits.data.some((c) => c.status === 'active') && <div className="muted small">{credits.data.filter((c) => c.status === 'active').reduce((n, c) => n + c.remaining, 0)} appointment credits</div>}</div></div>
        {types.data && types.data.length === 0 ? <p className="muted">Add an appointment type in Settings › Appointments first.</p> : (
          <>
            <div className="form-grid">
              <label className="field"><span>Session</span><select className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)}>{(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.durationMin} min · {money(t.priceCents)}</option>)}</select></label>
              <label className="field"><span>Day</span><input className="input" type="date" value={day} min={studioDate()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
              <label className="field"><span>Instructor</span><select className="select" value={staffId} onChange={(e) => { setStaffId(e.target.value); setSel(null); }}><option value="">Anyone</option>{offering.map((id) => <option key={id} value={id}>{staffById(id)?.name ?? 'Instructor'}</option>)}</select></label>
              {type?.capacity === 2 && <label className="field"><span>People</span><select className="select" value={people} onChange={(e) => setPeople(Number(e.target.value))}><option value={1}>1</option><option value={2}>2</option></select></label>}
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 8 }}>Open times · {dayLabel(day)}</div>
              {slots.loading && !slots.data ? <p className="muted">Looking…</p> : list.length === 0 ? <p className="muted">Nothing open that day. Check the instructor’s hours, or pick another day.</p> : (
                <div className="ap-slots">{list.map((s) => <button key={s.startsAt + s.staffId} type="button" className="ap-slot" aria-pressed={sel?.startsAt === s.startsAt} onClick={() => setSel(s)}>{clock(s.startsAt)}</button>)}</div>
              )}
            </div>
            {sel && type && (
              <>
                <div className="muted small">With {staffById(sel.staffId)?.name ?? staff.find((s) => s.id === sel.staffId)?.name ?? 'instructor'} · {range(sel.startsAt, sel.endsAt)}</div>
                {canPack ? (
                  <div className="ap-opts">
                    <button type="button" className="ap-opt" aria-pressed={method === 'pack'} onClick={() => setMethod('pack')}>Use {people} {people === 1 ? 'credit' : 'credits'} ({have} left)</button>
                    <button type="button" className="ap-opt" aria-pressed={method !== 'pack'} onClick={() => setMethod('card_reader')}>Take payment</button>
                  </div>
                ) : null}
                {method !== 'pack' && <><MethodPicker value={method as 'card_reader' | 'cash' | 'comp'} onChange={setMethod} /><div className="muted small">{method === 'comp' ? 'No charge.' : `${money(people * type.priceCents, { cents: true })} to take.`}</div></>}
                <label className="field"><span>Note for the instructor (optional)</span><textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              </>
            )}
          </>
        )}
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !sel} onClick={book}>Book it</button></div>
    </>
  );
}
