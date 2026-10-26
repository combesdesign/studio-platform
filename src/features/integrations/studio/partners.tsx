/**
 * Settings › Partners: ClassPass and Gympass. Partner IDs, API keys (write-only), spots held per class type, and in the
 * demo a "pretend the partner just sent a booking" button.
 * REAL USE NEEDS A PARTNER AGREEMENT with the partner: see docs/features/integrations.md.
 */
import React, { useEffect, useState } from 'react';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { dateTime, roleCan, useStudio } from '../../../studio/ui';
import { PARTNERS, PARTNER_LABEL, type Partner, type PartnerSetting } from '../types';
import { heldFor } from '../partners';

function PartnerCard({ cfg, canKey, onSaved }: { cfg: PartnerSetting; canKey: boolean; onSaved: () => void }) {
  const toast = useToast();
  const api = store.features.integrations!;
  const [id, setId] = useState(cfg.partnerStudioId);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setId(cfg.partnerStudioId), [cfg.partnerStudioId]);
  const label = PARTNER_LABEL[cfg.partner];
  const save = async (patch: Parameters<typeof api.savePartner>[1], done: string) => {
    setBusy(true);
    try { await api.savePartner(cfg.partner, patch); setKey(''); toast(done); onSaved(); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card pad ig-card">
      <div className="ig-head">
        <h3>{label}</h3>
        <label className="ig-switch">
          <input type="checkbox" checked={cfg.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked, partnerStudioId: id }, e.target.checked ? `${label} switched on` : `${label} switched off`)} />
          <span>{cfg.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <div className="ig-fields">
        <label className="field"><span>Your studio ID at {label}</span>
          <input className="input" value={id} autoComplete="off" maxLength={80} placeholder="Given to you by the partner" onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="field"><span>API key {cfg.keySet ? '(saved)' : ''}</span>
          <input className="input" type="password" value={key} autoComplete="new-password" maxLength={400} disabled={!canKey}
            placeholder={!canKey ? 'Only the owner can enter keys' : cfg.keySet ? 'Saved. Paste a new key to replace it' : 'Paste the key'} onChange={(e) => setKey(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || (id.trim() === cfg.partnerStudioId && !key)} onClick={() => save({ partnerStudioId: id, ...(key ? { apiKey: key } : {}) }, 'Saved')}>Save</button>
        {canKey && cfg.keySet && <button className="btn" disabled={busy} onClick={() => save({ apiKey: '' }, 'Key removed')}>Remove key</button>}
      </div>
      <p className="muted ig-note">Keys are write-only: once saved, they're kept on the server and can't be shown again, only replaced or removed.</p>
    </section>
  );
}

export function PartnersTab() {
  const { me, typeById } = useStudio();
  const toast = useToast();
  const api = store.features.integrations;
  const partners = useData(async () => (api ? api.listPartners() : []), []);
  const reserved = useData(async () => (api ? api.listReserved() : []), []);
  const types = useData(() => store.listClassTypes(), []);
  const [pick, setPick] = useState<Partner | null>(null);
  const [sid, setSid] = useState('');
  const sessions = useData(async () => {
    const t = Date.now();
    const list = await store.listSessions({ from: new Date(t).toISOString(), to: new Date(t + 7 * 86_400_000).toISOString() });
    return list.filter((s) => s.status === 'scheduled' && s.spotsLeft > 0);
  }, []);
  if (!api) return null;
  const canKey = roleCan(me.role, 'integrations.keys');
  const list = partners.data ?? [];
  const from: Partner = pick ?? list.find((p) => p.enabled)?.partner ?? 'classpass';
  const classTypes = (types.data ?? []).filter((c) => c.active && c.bookable);
  const setSpots = async (classTypeId: string, partner: Partner, n: number) => {
    try { await api.setReserved(classTypeId, partner, n); reserved.reload(); } catch (e) { toast(errorMessage(e)); reserved.reload(); }
  };
  const pretend = async () => {
    try { const pb = await api.demoPartnerBook!(from, sid || sessions.data![0]!.id); toast(`${pb.memberName} booked through ${PARTNER_LABEL[from]}`); } catch (e) { toast(errorMessage(e)); }
  };

  return (
    <>
      <div className="note ig-agreement" role="note">
        <strong>ClassPass and Gympass need a partner agreement.</strong> Their members can only book your classes once the partner has signed you up and given you a partner ID,
        an API key and their booking format. This screen and the booking webhook are your side of the plumbing, ready for that day. Until then, leave both switched off.
      </div>
      {partners.error && !partners.data ? <p className="muted">{partners.error.message}</p> : list.map((cfg) => <PartnerCard key={cfg.partner} cfg={cfg} canKey={canKey} onSaved={partners.reload} />)}

      <section className="card pad ig-card">
        <h3>Spots <em>held</em> for partners</h3>
        <p className="muted">How many spots in each class a partner can book. Partner bookings can't go past these, and they show a badge on the roster. Held spots that aren't booked yet are kept back from direct clients, who see the class's spots minus those. The roster shows the real numbers.</p>
        <div className="ig-grid" role="table" aria-label="Spots held for partners">
          <div className="ig-gh" role="row"><span role="columnheader">Class type</span>{PARTNERS.map((p) => <span key={p} role="columnheader">{PARTNER_LABEL[p]}</span>)}</div>
          {classTypes.map((c) => (
            <div className="ig-gr" role="row" key={c.id}>
              <span role="cell" className="ig-gt">{c.name}</span>
              {PARTNERS.map((p) => (
                <SpotsInput key={p} label={`${PARTNER_LABEL[p]} spots for ${c.name}`} value={heldFor(reserved.data ?? [], c.id, p)} max={c.defaultCapacity} onSave={(n) => setSpots(c.id, p, n)} />
              ))}
            </div>
          ))}
        </div>
      </section>

      {api.demoPartnerBook && (
        <section className="card pad ig-card">
          <h3>Try it <em>(demo)</em></h3>
          <p className="muted">Pretend a partner just sent a booking. It follows the same rules as the real webhook: the partner must be on, spots must be held for that class, and the class can't be full.</p>
          <div className="ig-try">
            <label className="field"><span>Partner</span>
              <select className="input" value={from} onChange={(e) => setPick(e.target.value as Partner)}>{PARTNERS.map((p) => <option key={p} value={p}>{PARTNER_LABEL[p]}</option>)}</select>
            </label>
            <label className="field"><span>Class (next 7 days)</span>
              <select className="input" value={sid} onChange={(e) => setSid(e.target.value)}>
                {(sessions.data ?? []).map((s) => <option key={s.id} value={s.id}>{typeById(s.classTypeId)?.name ?? 'Class'}, {dateTime(s.startsAt)}</option>)}
              </select>
            </label>
            <button className="btn primary" disabled={!sessions.data?.length} onClick={pretend}>Send a booking</button>
          </div>
        </section>
      )}
    </>
  );
}

function SpotsInput({ value, max, label, onSave }: { value: number; max: number; label: string; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => { const n = Math.max(0, Math.min(max, Math.round(Number(v) || 0))); setV(String(n)); if (n !== value) onSave(n); };
  return <span role="cell"><input className="input ig-num" type="number" inputMode="numeric" min={0} max={max} value={v} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></span>;
}
