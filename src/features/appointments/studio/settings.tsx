/** Settings › Appointments: how slots are offered, the session types (private, duet…) and the packs. */
import React, { useEffect, useState } from 'react';
import { Sheet, useAction, useData, useToast } from '../../../shared/react';
import { money } from '../../../shared/format';
import { Empty, Icon, Loading, SheetHead, cx, toCents, toDollars, useStudio } from '../../../studio/ui';
import { needAppts, price } from '../api';
import { REMINDER_HOURS } from '../logic';
import type { AppointmentPack, AppointmentSettings, AppointmentType } from '../types';

export function AppointmentSettingsTab() {
  const ap = needAppts();
  const toast = useToast();
  const { busy, run } = useAction();
  const cur = useData(() => ap.getSettings(), []);
  const types = useData(() => ap.listTypes({ includeInactive: true }), []);
  const packs = useData(() => ap.listPacks({ includeInactive: true }), []);
  const [s, setS] = useState<{ slotStepMin: string; minNoticeHours: string; horizonDays: string; waitlistClaimHours: string; reminderHours: string } | null>(null);
  const [type, setType] = useState<AppointmentType | 'new' | null>(null);
  const [pack, setPack] = useState<AppointmentPack | 'new' | null>(null);
  useEffect(() => { if (cur.data) setS({ slotStepMin: String(cur.data.slotStepMin), minNoticeHours: String(cur.data.minNoticeHours), horizonDays: String(cur.data.horizonDays), waitlistClaimHours: String(cur.data.waitlistClaimHours), reminderHours: String(cur.data.reminderHours) }); }, [cur.data]);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!s) return;
    const patch: Partial<AppointmentSettings> = { slotStepMin: Number(s.slotStepMin), minNoticeHours: Number(s.minNoticeHours), horizonDays: Number(s.horizonDays), waitlistClaimHours: Number(s.waitlistClaimHours), reminderHours: Number(s.reminderHours) };
    void run(async () => { await ap.updateSettings(patch); cur.reload(); }, 'Saved');
  };
  const dirty = !!cur.data && !!s && (String(cur.data.slotStepMin) !== s.slotStepMin || String(cur.data.minNoticeHours) !== s.minNoticeHours || String(cur.data.horizonDays) !== s.horizonDays || String(cur.data.waitlistClaimHours) !== s.waitlistClaimHours || String(cur.data.reminderHours) !== s.reminderHours);
  return (
    <div className="stack lg">
      <section className="card pad">
        <h3>Booking <em>rules</em></h3>
        <p className="muted">Instructors’ weekly hours turn into bookable times using these. The cancellation window is your studio’s one in Policies. Reminder emails go out the number of hours you pick before a session, workshop or event.</p>
        {!s ? <Loading /> : (
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field"><span>Times start every (minutes)</span><input className="input" inputMode="numeric" value={s.slotStepMin} onChange={(e) => setS({ ...s, slotStepMin: e.target.value })} /></label>
              <label className="field"><span>Minimum notice (hours)</span><input className="input" inputMode="numeric" value={s.minNoticeHours} onChange={(e) => setS({ ...s, minNoticeHours: e.target.value })} /></label>
              <label className="field"><span>Clients can book up to (days ahead)</span><input className="input" inputMode="numeric" value={s.horizonDays} onChange={(e) => setS({ ...s, horizonDays: e.target.value })} /></label>
              <label className="field"><span>Waitlist offers stay open for (hours)</span><input className="input" inputMode="numeric" value={s.waitlistClaimHours} onChange={(e) => setS({ ...s, waitlistClaimHours: e.target.value })} /></label>
              <label className="field"><span>Send reminders</span>
                <select className="select" value={s.reminderHours} onChange={(e) => setS({ ...s, reminderHours: e.target.value })}>
                  {REMINDER_HOURS.map((h) => <option key={h} value={String(h)}>{h} hours before</option>)}
                </select></label>
            </div>
            <div className="ap-actions"><button className="btn" disabled={busy || !dirty}>Save</button></div>
          </form>
        )}
      </section>

      <section className="card pad">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><h3>Session <em>types</em></h3><button className="btn" onClick={() => setType('new')}><Icon name="plus" size={18} />Add a type</button></div>
        {!types.data ? <Loading /> : types.data.length === 0 ? <Empty title="No session types yet">Add a private or duet to start taking bookings.</Empty> : (
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Length</th><th>Buffer</th><th>People</th><th className="num">Price</th><th /></tr></thead>
            <tbody>{types.data.map((t) => (
              <tr key={t.id}><td><strong>{t.name}</strong>{!t.active && <span className="chip warn" style={{ marginLeft: 8 }}>Hidden</span>}</td><td>{t.durationMin} min</td><td>{t.bufferMin ? `${t.bufferMin} min` : '–'}</td><td>{t.capacity}</td><td className="num">{price(t.priceCents)}</td>
                <td className="num"><button className="btn ghost sm" onClick={() => setType(t)}>Edit</button></td></tr>
            ))}</tbody></table></div>
        )}
      </section>

      <section className="card pad">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><h3>Appointment <em>packs</em></h3><button className="btn" onClick={() => setPack('new')}><Icon name="plus" size={18} />Add a pack</button></div>
        {!packs.data ? <Loading /> : packs.data.length === 0 ? <Empty title="No packs yet">A “5 privates” pack is a good way to keep clients coming back.</Empty> : (
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Sessions</th><th>Lasts</th><th className="num">Price</th><th /></tr></thead>
            <tbody>{packs.data.map((p) => (
              <tr key={p.id}><td><strong>{p.name}</strong>{!p.active && <span className="chip warn" style={{ marginLeft: 8 }}>Hidden</span>}</td><td>{p.credits}</td><td>{p.validityDays ? `${p.validityDays} days` : 'No expiry'}</td><td className="num">{price(p.priceCents)}</td>
                <td className="num"><button className="btn ghost sm" onClick={() => setPack(p)}>Edit</button></td></tr>
            ))}</tbody></table></div>
        )}
      </section>

      <Sheet open={!!type} onClose={() => setType(null)} label="Session type">
        {type && <TypeForm key={type === 'new' ? 'new' : type.id} t={type === 'new' ? null : type} onClose={() => setType(null)} onSaved={() => { setType(null); types.reload(); }} />}
      </Sheet>
      <Sheet open={!!pack} onClose={() => setPack(null)} label="Appointment pack">
        {pack && <PackForm key={pack === 'new' ? 'new' : pack.id} p={pack === 'new' ? null : pack} types={types.data ?? []} onClose={() => setPack(null)} onSaved={() => { setPack(null); packs.reload(); }} />}
      </Sheet>
    </div>
  );
}

function TypeForm({ t, onClose, onSaved }: { t: AppointmentType | null; onClose: () => void; onSaved: () => void }) {
  const { staff } = useStudio();
  const { busy, run } = useAction();
  const [v, setV] = useState({ name: t?.name ?? '', description: t?.description ?? '', durationMin: String(t?.durationMin ?? 55), price: toDollars(t?.priceCents ?? 0), capacity: String(t?.capacity ?? 1), bufferMin: String(t?.bufferMin ?? 5), bookingNote: t?.bookingNote ?? '', active: t?.active ?? true });
  const [staffIds, setStaffIds] = useState<string[]>(t?.staffIds ?? []);
  const people = staff.filter((s) => s.active !== false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => needAppts().upsertType({
      ...(t ? { id: t.id } : {}), name: v.name.trim(), description: v.description.trim(), durationMin: Math.round(Number(v.durationMin) || 0), priceCents: toCents(v.price),
      capacity: v.capacity === '2' ? 2 : 1, bufferMin: Math.max(0, Math.round(Number(v.bufferMin) || 0)), staffIds, ...(v.bookingNote.trim() ? { bookingNote: v.bookingNote.trim() } : {}), active: v.active,
    }), 'Saved');
    if (r) onSaved();
  };
  return (
    <form onSubmit={save}>
      <SheetHead title={t ? <>Edit <em>session type</em></> : <>New <em>session type</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Name</span><input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required placeholder="Private reformer" /></label>
        <label className="field span2"><span>Description (clients see this)</span><textarea className="textarea" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
        <label className="field"><span>Length (minutes)</span><input className="input" inputMode="numeric" value={v.durationMin} onChange={(e) => setV({ ...v, durationMin: e.target.value })} /></label>
        <label className="field"><span>Buffer after (minutes)</span><input className="input" inputMode="numeric" value={v.bufferMin} onChange={(e) => setV({ ...v, bufferMin: e.target.value })} /></label>
        <label className="field"><span>Price per person</span><input className="input" inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} /></label>
        <label className="field"><span>Up to</span><select className="select" value={v.capacity} onChange={(e) => setV({ ...v, capacity: e.target.value })}><option value="1">1 person (private)</option><option value="2">2 people (duet)</option></select></label>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="muted small" style={{ marginBottom: 6 }}>Who offers it</div>
        <div className="ap-opts">{people.map((s) => <button key={s.id} type="button" className="ap-opt" aria-pressed={staffIds.includes(s.id)} onClick={() => setStaffIds(staffIds.includes(s.id) ? staffIds.filter((x) => x !== s.id) : [...staffIds, s.id])}>{s.name}</button>)}</div>
      </div>
      <label className="field" style={{ marginTop: 14 }}><span>Note before booking (optional)</span><input className="input" value={v.bookingNote} onChange={(e) => setV({ ...v, bookingNote: e.target.value })} placeholder="Wear grip socks. Arrive 5 minutes early." /></label>
      <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Clients can book it</span></label>
      <div className="sh-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>Save</button></div>
    </form>
  );
}

function PackForm({ p, types, onClose, onSaved }: { p: AppointmentPack | null; types: AppointmentType[]; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const [v, setV] = useState({ name: p?.name ?? '', description: p?.description ?? '', credits: String(p?.credits ?? 5), price: toDollars(p?.priceCents ?? 0), validityDays: p?.validityDays == null ? '' : String(p.validityDays), active: p?.active ?? true });
  const [typeIds, setTypeIds] = useState<string[]>(p?.typeIds ?? []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => needAppts().upsertPack({
      ...(p ? { id: p.id } : {}), name: v.name.trim(), description: v.description.trim(), credits: Math.round(Number(v.credits) || 0), priceCents: toCents(v.price),
      validityDays: v.validityDays.trim() ? Math.round(Number(v.validityDays)) : null, typeIds, active: v.active,
    }), 'Saved');
    if (r) onSaved();
  };
  return (
    <form onSubmit={save}>
      <SheetHead title={p ? <>Edit <em>pack</em></> : <>New <em>pack</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Name</span><input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required placeholder="5 privates" /></label>
        <label className="field span2"><span>Description</span><input className="input" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
        <label className="field"><span>Sessions in the pack</span><input className="input" inputMode="numeric" value={v.credits} onChange={(e) => setV({ ...v, credits: e.target.value })} /></label>
        <label className="field"><span>Price</span><input className="input" inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} /></label>
        <label className="field span2"><span>Lasts (days from first use, blank for no expiry)</span><input className="input" inputMode="numeric" value={v.validityDays} onChange={(e) => setV({ ...v, validityDays: e.target.value })} /></label>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="muted small" style={{ marginBottom: 6 }}>Works for (none selected means any session type)</div>
        <div className="ap-opts">{types.map((t) => <button key={t.id} type="button" className="ap-opt" aria-pressed={typeIds.includes(t.id)} onClick={() => setTypeIds(typeIds.includes(t.id) ? typeIds.filter((x) => x !== t.id) : [...typeIds, t.id])}>{t.name}</button>)}</div>
      </div>
      <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Available to buy</span></label>
      <div className="sh-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>Save</button></div>
    </form>
  );
}
