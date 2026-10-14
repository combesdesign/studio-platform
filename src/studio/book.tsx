/** Shared booking flows: client search, add-to-class, walk-in, move, record waiver, new client. */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, store, useAction, useData, useToast } from '../shared/react';
import { addDays, money, startOfStudioDay, studioDate, time } from '../shared/format';
import type { Client, PaymentMethod, Product, SessionWithCounts } from '../shared/types';
import { Avatar, Fill, Icon, SheetHead, cx, dayShort, fullName, useStudio } from './ui';

// ------------------------------------------------------------------ client search
export function ClientSearch({ onPick, autoFocus, exclude, placeholder = 'Search name, email or phone' }: { onPick: (c: Client) => void; autoFocus?: boolean; exclude?: string[]; placeholder?: string }) {
  const [q, setQ] = useState('');
  const res = useData(() => store.listClients({ search: q.trim() || undefined }), [q]);
  const list = (res.data ?? []).filter((c) => !exclude?.includes(c.id)).slice(0, 30);
  return (
    <div className="csearch">
      <label className="search-in">
        <Icon name="search" size={20} />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} aria-label="Search clients" />
      </label>
      <div className="cs-results list">
        {list.map((c) => (
          <button key={c.id} className="cs-row" onClick={() => onPick(c)} type="button">
            <Avatar name={fullName(c)} size={38} />
            <span className="cs-t"><strong>{fullName(c)}</strong><span>{c.email}{c.phone ? ` · ${c.phone}` : ''}</span></span>
            {!c.waiverSignedAt && <span className="chip danger">No waiver</span>}
            <Icon name="right" size={18} />
          </button>
        ))}
        {!res.loading && list.length === 0 && <p className="muted small" style={{ padding: '14px 4px' }}>No clients match “{q}”.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ new client form
export type NewClient = { firstName: string; lastName: string; email: string; phone: string; birthday: string; injuries: string };
export const emptyClient: NewClient = { firstName: '', lastName: '', email: '', phone: '', birthday: '', injuries: '' };
export function ClientFields({ v, set, compact }: { v: NewClient; set: (v: NewClient) => void; compact?: boolean }) {
  const f = (k: keyof NewClient) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set({ ...v, [k]: e.target.value });
  return (
    <div className="form-grid">
      <label className="field"><span>First name</span><input className="input" value={v.firstName} onChange={f('firstName')} required autoFocus /></label>
      <label className="field"><span>Last name</span><input className="input" value={v.lastName} onChange={f('lastName')} required /></label>
      <label className="field"><span>Email</span><input className="input" type="email" value={v.email} onChange={f('email')} required /></label>
      <label className="field"><span>Mobile</span><input className="input" type="tel" value={v.phone} onChange={f('phone')} placeholder="04xx xxx xxx" /></label>
      {!compact && <label className="field"><span>Birthday (optional)</span><input className="input" type="date" value={v.birthday} onChange={f('birthday')} /></label>}
      {!compact && <label className="field span2"><span>Injuries or health notes (optional)</span><textarea className="textarea" value={v.injuries} onChange={f('injuries')} rows={2} /></label>}
    </div>
  );
}
export async function createClient(v: NewClient): Promise<Client> {
  if (!v.firstName.trim() || !v.email.trim()) throw new Error('Add at least a first name and email.');
  return store.upsertClient({
    firstName: v.firstName.trim(), lastName: v.lastName.trim(), email: v.email.trim().toLowerCase(), phone: v.phone.trim() || undefined,
    birthday: v.birthday || undefined, injuries: v.injuries.trim() || undefined, marketingOptIn: false, source: 'staff',
  });
}

export function NewClientSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Client) => void }) {
  const [v, setV] = useState<NewClient>(emptyClient);
  const { busy, run } = useAction();
  useEffect(() => { if (open) setV(emptyClient); }, [open]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = await run(() => createClient(v), 'Client added');
    if (c) onCreated(c);
  };
  return (
    <Sheet open={open} onClose={onClose} label="New client">
      <form onSubmit={save}>
        <SheetHead title={<>New <em>client</em></>} sub="They can set a password later from the client app." onClose={onClose} />
        <ClientFields v={v} set={setV} />
        <div className="sh-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>Add client</button></div>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ payment method picker
export const METHODS: { value: PaymentMethod; label: string; icon: string }[] = [
  { value: 'card_reader', label: 'Card reader', icon: 'card' },
  { value: 'cash', label: 'Cash', icon: 'cash' },
  { value: 'comp', label: 'Comp', icon: 'gift' },
];
export function MethodPicker({ value, onChange }: { value: PaymentMethod; onChange: (m: PaymentMethod) => void }) {
  return (
    <div className="methods" role="radiogroup" aria-label="Payment method">
      {METHODS.map((m) => (
        <button key={m.value} type="button" role="radio" aria-checked={value === m.value} className={cx('method', value === m.value && 'on')} onClick={() => onChange(m.value)}>
          <Icon name={m.icon} size={22} /><span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ book a client into a session (with options)
type Mode = 'credit' | 'comp' | 'sell';
export function BookOptions({ client, session, onDone, onBack }: { client: Client; session: SessionWithCounts; onDone: () => void; onBack?: () => void }) {
  const { me, typeById, can } = useStudio();
  const toast = useToast();
  const credits = useData(() => store.getCreditSummary(client.id, session.id), [client.id, session.id]);
  const products = useData(() => store.listProducts({ kinds: ['dropin', 'pack', 'intro'] }), []);
  const intro = useData(() => store.isIntroEligible(client.id), [client.id]);
  const eligible = (credits.data ?? []).filter((c) => c.remaining === null || c.remaining > 0);
  const [mode, setMode] = useState<Mode>('credit');
  const [passId, setPassId] = useState<string | undefined>();
  const [squeeze, setSqueeze] = useState(false);
  const [productId, setProductId] = useState<string | undefined>();
  const [method, setMethod] = useState<PaymentMethod>('card_reader');
  const { busy, run } = useAction();
  const full = session.spotsLeft <= 0;
  const sellable = (products.data ?? []).filter((p) => p.kind !== 'intro' || intro.data);

  useEffect(() => {
    if (credits.loading) return;
    if (eligible.length === 0 && mode === 'credit') setMode(can('pos') ? 'sell' : 'comp');
    if (!passId && eligible[0]) setPassId(eligible[0].pass.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credits.loading, eligible.length]);
  useEffect(() => { if (!productId && sellable.length) setProductId((sellable.find((p) => p.kind === 'dropin') ?? sellable[0])!.id); }, [sellable.length]);

  const go = async () => {
    const r = await run(async () => {
      let useId = mode === 'credit' ? passId : undefined;
      if (mode === 'sell') {
        if (!productId) throw new Error('Pick something to sell.');
        const out = await store.checkoutCart({ clientId: client.id, items: [{ productId, qty: 1 }], method, staffId: me.staffId });
        useId = out.passes[0]?.id;
      }
      return store.bookClass(client.id, session.id, { asStaff: true, passId: useId, skipCredit: mode === 'comp', allowOverCapacity: squeeze });
    });
    if (r) {
      toast(r.outcome === 'waitlisted' ? `${client.firstName} is on the waitlist` : `${client.firstName} is booked in`);
      onDone();
    }
  };

  const ct = typeById(session.classTypeId);
  const selProduct = sellable.find((p) => p.id === productId);
  return (
    <div className="bookopts">
      <div className="bo-who">
        <Avatar name={fullName(client)} size={52} />
        <div><strong>{fullName(client)}</strong><div className="muted small">{ct?.name} · {time(session.startsAt)} {dayShort(session.startsAt)}</div></div>
        {onBack && <button className="btn sm ghost push" onClick={onBack} type="button">Change</button>}
      </div>
      {!client.waiverSignedAt && <div className="note warn"><Icon name="doc" size={18} />No waiver on file. You can still book them in; they'll be flagged on the roster.</div>}

      <div className="opt-list" role="radiogroup">
        <label className={cx('opt', mode === 'credit' && 'on', eligible.length === 0 && 'disabled')}>
          <input type="radio" name="mode" checked={mode === 'credit'} disabled={eligible.length === 0} onChange={() => setMode('credit')} />
          <span className="opt-t"><strong>Use their credit</strong>
            <span>{credits.loading ? 'Checking passes…' : eligible.length === 0 ? 'No credit that covers this class' : eligible.length === 1 ? `${eligible[0]!.pass.name} · ${eligible[0]!.label}` : `${eligible.length} passes available`}</span>
          </span>
        </label>
        {mode === 'credit' && eligible.length > 1 && (
          <div className="opt-sub">
            {eligible.map((c) => (
              <label key={c.pass.id} className={cx('pass-pick', passId === c.pass.id && 'on')}>
                <input type="radio" name="pass" checked={passId === c.pass.id} onChange={() => setPassId(c.pass.id)} />
                <span><strong>{c.pass.name}</strong> <span className="muted">· {c.label}</span></span>
              </label>
            ))}
          </div>
        )}
        {can('pos') && (
          <label className={cx('opt', mode === 'sell' && 'on')}>
            <input type="radio" name="mode" checked={mode === 'sell'} onChange={() => setMode('sell')} />
            <span className="opt-t"><strong>Sell a pass and book</strong><span>Drop-in, pack or intro offer</span></span>
          </label>
        )}
        {mode === 'sell' && (
          <div className="opt-sub stack">
            <div className="prod-pills">
              {sellable.map((p) => (
                <button type="button" key={p.id} className={cx('pill', productId === p.id && 'on')} onClick={() => setProductId(p.id)}>{p.name}<span>{money(p.priceCents)}</span></button>
              ))}
            </div>
            <MethodPicker value={method} onChange={setMethod} />
          </div>
        )}
        <label className={cx('opt', mode === 'comp' && 'on')}>
          <input type="radio" name="mode" checked={mode === 'comp'} onChange={() => setMode('comp')} />
          <span className="opt-t"><strong>Comp, no credit</strong><span>Free class, nothing taken from their passes</span></span>
        </label>
      </div>

      {full && (
        <label className="check squeeze">
          <input type="checkbox" checked={squeeze} onChange={(e) => setSqueeze(e.target.checked)} />
          <span><strong>Squeeze in over capacity</strong><br /><span className="muted small">The class is full ({session.bookedCount}/{session.capacity}). Leave this off to add them to the waitlist instead.</span></span>
        </label>
      )}
      <div className="sh-foot">
        <button className="btn block" onClick={go} disabled={busy || (mode === 'credit' && !passId) || (mode === 'sell' && !productId)}>
          {busy ? 'Booking…' : full && !squeeze ? 'Add to waitlist' : mode === 'sell' && selProduct ? `Charge ${money(selProduct.priceCents)} and book` : 'Book in'}
        </button>
      </div>
    </div>
  );
}

export function AddClientSheet({ open, onClose, session, exclude }: { open: boolean; onClose: () => void; session: SessionWithCounts; exclude: string[] }) {
  const [client, setClient] = useState<Client | null>(null);
  useEffect(() => { if (open) setClient(null); }, [open]);
  return (
    <Sheet open={open} onClose={onClose} label="Add client to class">
      <SheetHead title={<>Add to <em>class</em></>} sub={client ? undefined : 'Find a client to book in.'} onClose={onClose} />
      {client
        ? <BookOptions client={client} session={session} onDone={onClose} onBack={() => setClient(null)} />
        : <ClientSearch onPick={setClient} autoFocus exclude={exclude} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ walk-in: new client + drop-in + book
export function WalkInSheet({ open, onClose, session }: { open: boolean; onClose: () => void; session: SessionWithCounts }) {
  const { me, settings } = useStudio();
  const toast = useToast();
  const [v, setV] = useState<NewClient>(emptyClient);
  const [method, setMethod] = useState<PaymentMethod>('card_reader');
  const [waiver, setWaiver] = useState(false);
  const [productId, setProductId] = useState<string>('');
  const products = useData(() => store.listProducts({ kinds: ['dropin', 'intro'] }), []);
  const { busy, run } = useAction();
  useEffect(() => { if (open) { setV(emptyClient); setWaiver(false); setMethod('card_reader'); } }, [open]);
  useEffect(() => { const d = products.data?.find((p) => p.kind === 'dropin') ?? products.data?.[0]; if (d && !productId) setProductId(d.id); }, [products.data]);
  const prod = products.data?.find((p) => p.id === productId);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      const c = await createClient(v);
      if (waiver) await store.submitWaiver(c.id, { answers: {}, injuries: v.injuries.trim() || undefined });
      let passId: string | undefined;
      if (prod) {
        const out = await store.checkoutCart({ clientId: c.id, items: [{ productId: prod.id, qty: 1 }], method, staffId: me.staffId, note: 'Walk-in' });
        passId = out.passes[0]?.id;
      }
      await store.bookClass(c.id, session.id, { asStaff: true, passId, skipCredit: !prod, allowOverCapacity: true });
      return c;
    });
    if (ok) { toast(`${ok.firstName} is in. Welcome!`); onClose(); }
  };

  return (
    <Sheet open={open} onClose={onClose} label="Walk-in">
      <form onSubmit={go}>
        <SheetHead title={<>Walk-<em>in</em></>} sub="Add a new client, take payment and book them into this class in one go." onClose={onClose} />
        <ClientFields v={v} set={setV} compact />
        <div className="stack" style={{ marginTop: 18 }}>
          <div className="eyebrow">What they're buying</div>
          <div className="prod-pills">
            {(products.data ?? []).map((p) => (
              <button type="button" key={p.id} className={cx('pill', productId === p.id && 'on')} onClick={() => setProductId(p.id)}>{p.name}<span>{money(p.priceCents)}</span></button>
            ))}
          </div>
          <MethodPicker value={method} onChange={setMethod} />
          <label className="check"><input type="checkbox" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} /><span>They've read and signed the waiver and health form (paper or in person)</span></label>
        </div>
        <div className="sh-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Working…' : prod ? `Charge ${money(prod.priceCents)} and book` : 'Book in'}</button>
        </div>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ pick an upcoming session
export function SessionPicker({ onPick, excludeId, days = 14, title }: { onPick: (s: SessionWithCounts) => void; excludeId?: string; days?: number; title?: string }) {
  const { typeById, staffById } = useStudio();
  const today = studioDate();
  const res = useData(() => store.listSessions({ from: new Date().toISOString(), to: startOfStudioDay(addDays(today, days + 1)) }), [today, days]);
  const list = (res.data ?? []).filter((s) => s.status === 'scheduled' && s.id !== excludeId && typeById(s.classTypeId)?.bookable !== false);
  const groups = useMemo(() => {
    const m = new Map<string, SessionWithCounts[]>();
    for (const s of list) { const k = studioDate(s.startsAt); m.set(k, [...(m.get(k) ?? []), s]); }
    return [...m.entries()];
  }, [list]);
  return (
    <div className="spicker">
      {title && <div className="eyebrow" style={{ marginBottom: 8 }}>{title}</div>}
      {groups.map(([d, ss]) => (
        <div key={d} className="sp-day">
          <div className="sp-date">{d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : dayShort(ss[0]!.startsAt)}</div>
          {ss.map((s) => {
            const ct = typeById(s.classTypeId);
            return (
              <button key={s.id} className="sp-row" onClick={() => onPick(s)} type="button" style={{ ['--ct' as string]: ct?.color ?? 'var(--sky)' }}>
                <span className="sp-time">{time(s.startsAt)}</span>
                <span className="sp-t"><strong>{ct?.name}</strong><span>{staffById(s.instructorId)?.name}</span></span>
                <span className="sp-fill"><span>{s.spotsLeft === 0 ? `Full${s.waitlistCount ? ` · ${s.waitlistCount} waiting` : ''}` : `${s.spotsLeft} left`}</span><Fill value={s.bookedCount} max={s.capacity} /></span>
              </button>
            );
          })}
        </div>
      ))}
      {!res.loading && groups.length === 0 && <p className="muted">No upcoming classes.</p>}
    </div>
  );
}

export function BookClientSheet({ open, onClose, client }: { open: boolean; onClose: () => void; client: Client }) {
  const [s, setS] = useState<SessionWithCounts | null>(null);
  useEffect(() => { if (open) setS(null); }, [open]);
  return (
    <Sheet open={open} onClose={onClose} label="Book into class">
      <SheetHead title={<>Book <em>{client.firstName}</em> in</>} sub={s ? undefined : 'Pick a class in the next two weeks.'} onClose={onClose} />
      {s ? <BookOptions client={client} session={s} onDone={onClose} onBack={() => setS(null)} /> : <SessionPicker onPick={setS} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ record waiver on the client's behalf
export function WaiverSheet({ open, onClose, client }: { open: boolean; onClose: () => void; client: Client }) {
  const { settings } = useStudio();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [injuries, setInjuries] = useState('');
  const [postnatal, setPostnatal] = useState(false);
  const [agree, setAgree] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!open) return;
    setAnswers(client.healthForm?.answers ?? {}); setInjuries(client.injuries ?? client.healthForm?.injuries ?? '');
    setPostnatal(!!client.healthForm?.pregnantOrPostnatal); setAgree(false);
  }, [open, client]);
  const save = async () => {
    const r = await run(() => store.submitWaiver(client.id, { answers, injuries: injuries.trim() || undefined, pregnantOrPostnatal: postnatal }), 'Waiver recorded');
    if (r) onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} label="Record waiver">
      <SheetHead title={<>Waiver &amp; <em>health</em></>} sub={`Recording on behalf of ${fullName(client)}.`} onClose={onClose} />
      <div className="waiver-text">{settings.waiverText || 'Waiver text not set yet (Settings › Policies).'}</div>
      <div className="stack" style={{ marginTop: 16 }}>
        {settings.healthQuestions.map((q) => (
          <label key={q} className="field"><span>{q}</span>
            <input className="input" value={answers[q] ?? ''} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} placeholder="Answer" />
          </label>
        ))}
        <label className="field"><span>Injuries or conditions</span><textarea className="textarea" rows={2} value={injuries} onChange={(e) => setInjuries(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={postnatal} onChange={(e) => setPostnatal(e.target.checked)} /><span>Pregnant or postnatal</span></label>
        <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{client.firstName} has read and agreed to the waiver (signed in person)</span></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={!agree || busy} onClick={save}>Save waiver</button></div>
    </Sheet>
  );
}

export function productKindLabel(k: Product['kind']) {
  return { membership: 'Memberships', pack: 'Class packs', intro: 'Intro offer', dropin: 'Drop-in', retail: 'Retail' }[k];
}
