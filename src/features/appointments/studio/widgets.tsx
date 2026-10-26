/** Today › Appointments widget, and the appointments card on a client's profile. */
import React, { useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { addDays, money, startOfStudioDay, studioDate } from '../../../shared/format';
import type { Client } from '../../../shared/types';
import { Flower } from '../../../shared/brand';
import { MethodPicker } from '../../../studio/book';
import { Icon, SheetHead, roleCan, useStudio } from '../../../studio/ui';
import { APPT_STATUS_LABEL, appts, clock, dayLabel, needAppts } from '../api';
import type { AppointmentPayMethod } from '../types';
import { BookForClientSheet } from './book';

export function TodaysAppointments() {
  const today = studioDate();
  const list = useData(async () => (appts() ? appts()!.listAppointments({ from: startOfStudioDay(today), to: startOfStudioDay(addDays(today, 1)) }) : []), []);
  const rows = (list.data ?? []).filter((a) => a.status === 'booked' || a.status === 'completed' || a.status === 'no_show');
  if (rows.length === 0) return null;
  return (
    <section className="card pad alerts">
      <h3><Flower size={16} className="h-fl" />Today’s <em>privates</em></h3>
      <div>
        {rows.map((a) => (
          <a key={a.id} className="alert-row" href="#/appointments">
            <span className="grow"><strong>{clock(a.startsAt)}</strong> {a.clientName}{a.people > 1 ? ' + 1' : ''}<span className="muted small"> · {a.typeName} · {a.staffName.split(' ')[0]}</span></span>
            {a.status !== 'booked' ? <span className="muted small">{APPT_STATUS_LABEL[a.status]}</span> : <Icon name="right" size={16} />}
          </a>
        ))}
      </div>
    </section>
  );
}

export function ClientAppointmentsCard({ client }: { client: Client }) {
  const { me } = useStudio();
  const canBook = roleCan(me.role, 'appointments.book');
  const ap = appts();
  const list = useData(async () => (ap ? ap.listAppointments({ clientId: client.id, from: new Date(Date.now() - 60 * 86400000).toISOString() }) : []), [client.id]);
  const credits = useData(async () => (ap ? ap.listCredits(client.id) : []), [client.id]);
  const [book, setBook] = useState(false);
  const [sell, setSell] = useState(false);
  if (!ap || !canBook) return null;
  const rows = (list.data ?? []).filter((a) => a.status === 'booked' || a.status === 'completed').sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, 5);
  const left = (credits.data ?? []).filter((c) => c.status === 'active').reduce((n, c) => n + c.remaining, 0);
  return (
    <section className="card pad">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3>Private <em>sessions</em></h3>
        <div className="row" style={{ gap: 8 }}><button className="btn ghost sm" onClick={() => setSell(true)}>Sell a pack</button><button className="btn sm" onClick={() => setBook(true)}>Book</button></div>
      </div>
      <p className="muted">{left > 0 ? `${left} appointment ${left === 1 ? 'credit' : 'credits'} left.` : 'No appointment credits.'}</p>
      {rows.length === 0 ? <p className="muted small">No recent private sessions.</p> : rows.map((a) => (
        <div key={a.id} className="ap-att"><span className="grow"><strong>{a.typeName}</strong><div className="muted small">{dayLabel(a.startsAt)}, {clock(a.startsAt)} · {a.staffName.split(' ')[0]}</div></span><span className="chip">{APPT_STATUS_LABEL[a.status]}</span></div>
      ))}
      <BookForClientSheet open={book} onClose={() => { setBook(false); list.reload(); credits.reload(); }} client={client} />
      <Sheet open={sell} onClose={() => setSell(false)} label="Sell a pack">
        {sell && <SellPack client={client} onClose={() => { setSell(false); credits.reload(); }} />}
      </Sheet>
    </section>
  );
}

function SellPack({ client, onClose }: { client: Client; onClose: () => void }) {
  const ap = needAppts();
  const packs = useData(() => ap.listPacks(), []);
  const { busy, run } = useAction();
  const [packId, setPackId] = useState('');
  const [method, setMethod] = useState<AppointmentPayMethod>('card_reader');
  const sel = packs.data?.find((p) => p.id === packId) ?? packs.data?.[0];
  const sell = async () => { if (sel && (await run(() => ap.buyPack({ packId: sel.id, clientId: client.id, method: method as Exclude<AppointmentPayMethod, 'pack'> }), 'Pack sold'))) onClose(); };
  return (
    <>
      <SheetHead title={<>Sell a <em>pack</em></>} sub={`${client.firstName} ${client.lastName}`.trim()} onClose={onClose} />
      {packs.data && packs.data.length === 0 ? <p className="muted">Add a pack in Settings › Appointments first.</p> : (
        <div className="stack" style={{ gap: 14 }}>
          <label className="field"><span>Pack</span><select className="select" value={sel?.id ?? ''} onChange={(e) => setPackId(e.target.value)}>{(packs.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.priceCents)}</option>)}</select></label>
          <MethodPicker value={method as 'card_reader' | 'cash' | 'comp'} onChange={setMethod} />
        </div>
      )}
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !sel} onClick={sell}>{sel ? `Take ${method === 'comp' ? 'no payment' : money(sel.priceCents)}` : 'Sell'}</button></div>
    </>
  );
}
