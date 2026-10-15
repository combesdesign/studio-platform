/**
 * Onboarding wizard for a new studio's owner (#/welcome/<step>): details -> branding -> class types ->
 * pricing -> policies -> staff -> go live. Everything it creates is ordinary studio data (class types,
 * products, settings, staff), so the owner can change any of it later in Settings.
 */
import React, { useEffect, useState } from 'react';
import type { ClassType, Product, StaffRole, StudioBranding, StudioSettings } from '../shared/types';
import { store, useAction, useData } from '../shared/react';
import { applyBranding } from '../shared/branding';
import { BrandingEditor, BrandPreview } from '../shared/branding-editor';
import { Accented, Flower } from '../shared/brand';
import { CURRENCY, money } from '../shared/format';
import { Icon, cx, useStudio } from './ui';

const STEPS = [
  { key: 'details', label: 'Your studio' },
  { key: 'branding', label: 'Look + feel' },
  { key: 'classes', label: 'Classes' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'policies', label: 'Policies' },
  { key: 'staff', label: 'Your team' },
  { key: 'live', label: 'Go live' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

const TIMEZONES = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Hobart', 'Pacific/Auckland', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
const CURRENCIES = ['AUD', 'NZD', 'GBP', 'USD', 'EUR'];

export function Onboarding({ step }: { step?: string }) {
  const { studio } = useStudio();
  const i = Math.max(0, STEPS.findIndex((s) => s.key === step));
  const cur = STEPS[i]!.key;
  const go = (k: StepKey) => location.replace(`#/welcome/${k}`);
  const next = () => go(STEPS[Math.min(STEPS.length - 1, i + 1)]!.key);
  const back = () => go(STEPS[Math.max(0, i - 1)]!.key);
  const later = () => { try { sessionStorage.setItem(`onboard-skip-${studio.id}`, '1'); } catch { /* private mode */ } location.hash = '/'; };
  return (
    <div className="onb">
      <header className="onb-head">
        <div className="eyebrow"><Flower size={12} className="eb-fl" />{studio.status === 'onboarding' ? 'Setting up' : 'Studio setup'}</div>
        <h1><Accented text={`Welcome to *${studio.name}*`} /></h1>
        <p className="muted">A few steps and your studio is ready for its first booking. You can change all of this later in Settings.</p>
      </header>
      <ol className="onb-steps" aria-label="Setup steps">
        {STEPS.map((s, n) => (
          <li key={s.key}>
            <button className={cx(n === i && 'on', n < i && 'done')} onClick={() => go(s.key)} aria-current={n === i ? 'step' : undefined}>
              <span className="onb-n">{n < i ? <Icon name="check" size={14} /> : n + 1}</span>{s.label}
            </button>
          </li>
        ))}
      </ol>
      <section className="card pad onb-card">
        {cur === 'details' && <Details onDone={next} />}
        {cur === 'branding' && <Branding onDone={next} />}
        {cur === 'classes' && <Classes />}
        {cur === 'pricing' && <Pricing />}
        {cur === 'policies' && <Policies onDone={next} />}
        {cur === 'staff' && <Team />}
        {cur === 'live' && <GoLive />}
      </section>
      <footer className="onb-foot">
        {i > 0 ? <button className="btn ghost" onClick={back}><Icon name="left" size={18} />Back</button> : <span />}
        <button className="linkish" onClick={later}>Finish later</button>
        {cur !== 'live' && cur !== 'details' && cur !== 'branding' && cur !== 'policies' && <button className="btn" onClick={next}>Next<Icon name="right" size={18} /></button>}
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ 1. details
function Details({ onDone }: { onDone: () => void }) {
  const { studio } = useStudio();
  const [v, setV] = useState({ name: studio.name, address: studio.address, email: studio.email, phone: studio.phone ?? '', website: studio.website ?? '', timezone: studio.timezone, currency: studio.currency, taxId: studio.taxId ?? '' });
  const { busy, run } = useAction();
  const f = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const save = async () => {
    const r = await run(() => store.updateStudio({ name: v.name.trim(), address: v.address.trim(), email: v.email.trim(), phone: v.phone.trim(), website: v.website.trim(), timezone: v.timezone, currency: v.currency, taxId: v.taxId.trim(), taxRegistered: !!v.taxId.trim() }), 'Saved');
    if (r) onDone();
  };
  return (
    <div className="stack lg">
      <h2>Your <em>studio</em></h2>
      <div className="form-grid">
        <label className="field span2"><span>Studio name</span><input className="input" value={v.name} onChange={f('name')} /></label>
        <label className="field span2"><span>Address</span><input className="input" value={v.address} onChange={f('address')} placeholder="Street, suburb, state, postcode" /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={v.email} onChange={f('email')} /></label>
        <label className="field"><span>Phone</span><input className="input" type="tel" value={v.phone} onChange={f('phone')} /></label>
        <label className="field"><span>Website</span><input className="input" value={v.website} onChange={f('website')} placeholder="https://" /></label>
        <label className="field"><span>{studio.taxIdLabel} (for tax invoices)</span><input className="input" value={v.taxId} onChange={f('taxId')} /></label>
        <label className="field"><span>Timezone</span><select className="select" value={v.timezone} onChange={f('timezone')}>{[...new Set([v.timezone, ...TIMEZONES])].map((z) => <option key={z}>{z}</option>)}</select></label>
        <label className="field"><span>Currency</span><select className="select" value={v.currency} onChange={f('currency')}>{[...new Set([v.currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="onb-actions"><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}<Icon name="right" size={18} /></button></div>
    </div>
  );
}

// ------------------------------------------------------------------ 2. branding
function Branding({ onDone }: { onDone: () => void }) {
  const { studio } = useStudio();
  const [b, setB] = useState<StudioBranding>(studio.branding);
  const { busy, run } = useAction();
  const save = async () => {
    const r = await run(() => store.updateStudio({ branding: { ...b, appName: b.appName || studio.name } }), 'Looking good');
    if (r) { applyBranding(r.branding, { title: `Studio · ${r.branding.appName}`, themeColor: r.branding.colors.ink }); onDone(); }
  };
  return (
    <div className="onb-brand">
      <div className="stack lg">
        <h2>Look + <em>feel</em></h2>
        <p className="muted">Upload your logo, pick your colours and fonts. The preview is your clients’ app.</p>
        <BrandingEditor value={b} onChange={setB} name={studio.name} compact {...(store.uploadBrandingImage ? { upload: (f: File) => store.uploadBrandingImage!(f) } : {})} />
        <div className="onb-actions"><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}<Icon name="right" size={18} /></button></div>
      </div>
      <BrandPreview branding={b} name={studio.name} />
    </div>
  );
}

// ------------------------------------------------------------------ 3. class types
const CLASS_IDEAS: Omit<ClassType, 'id' | 'color'>[] = [
  { name: 'Mat Pilates', description: 'A full-body mat class for every level.', durationMin: 50, defaultCapacity: 12, level: 'All levels', bookable: true, active: true },
  { name: 'Reformer', description: 'Spring-loaded strength and control on the reformer.', durationMin: 50, defaultCapacity: 8, level: 'All levels', bookable: true, active: true },
  { name: 'Barre', description: 'Low-impact, high-burn work at the barre.', durationMin: 45, defaultCapacity: 14, level: 'All levels', bookable: true, active: true },
  { name: 'Beginners', description: 'New here? Learn the basics properly.', durationMin: 45, defaultCapacity: 10, level: 'Beginners', bookable: true, active: true },
];
function Classes() {
  const types = useData(() => store.listClassTypes({ includeInactive: true }), []);
  const { studio, settings } = useStudio();
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [mins, setMins] = useState('50');
  const colors = [studio.branding.colors.primary, studio.branding.colors.accent, studio.branding.colors.ink, '#7FA79B', '#C9A961'];
  const add = (ct: Omit<ClassType, 'id' | 'color'>) => run(() => store.upsertClassType({ ...ct, color: colors[(types.data?.length ?? 0) % colors.length]! }), `${ct.name} added`);
  const existing = new Set((types.data ?? []).map((t) => t.name.toLowerCase()));
  return (
    <div className="stack lg">
      <h2>Your <em>classes</em></h2>
      <p className="muted">The kinds of class you run. Add the weekly timetable afterwards in Schedule › Timetable.</p>
      <div className="onb-list">
        {(types.data ?? []).map((t) => <div key={t.id} className="onb-item" style={{ ['--ct' as string]: t.color }}><span className="ct-sw" /><strong>{t.name}</strong><span className="muted small">{t.durationMin} min · {t.defaultCapacity} spots</span></div>)}
        {types.data && types.data.length === 0 && <p className="muted small">No classes yet. Start with an idea below or add your own.</p>}
      </div>
      <div className="onb-chips">
        {CLASS_IDEAS.filter((c) => !existing.has(c.name.toLowerCase())).map((c) => <button key={c.name} className="chip-btn" disabled={busy} onClick={() => add(c)}><Icon name="plus" size={16} />{c.name}</button>)}
      </div>
      <div className="onb-add">
        <input className="input" placeholder="Your own class name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input onb-mins" inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} aria-label="Minutes" />
        <button className="btn soft" disabled={busy || !name.trim()} onClick={async () => { await add({ name: name.trim(), description: '', durationMin: Number(mins) || 50, defaultCapacity: settings.defaultCapacity, bookable: true, active: true }); setName(''); }}>Add</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 4. pricing
type Tpl = { key: string; on: boolean; price: string; make: (cents: number) => Omit<Product, 'id'> };
const TEMPLATES = (): Tpl[] => [
  { key: 'Intro offer: 2 weeks unlimited', on: true, price: '49', make: (c) => ({ kind: 'intro', name: 'Intro offer: 2 weeks unlimited', description: 'Two weeks of unlimited classes from your first booking. New clients only.', priceCents: c, credits: null, validityDays: 14, newClientsOnly: true, active: true, sortOrder: 1, highlight: 'New clients' }) },
  { key: 'Single class', on: true, price: '30', make: (c) => ({ kind: 'dropin', name: 'Single class', description: 'One class, valid 60 days from first booking.', priceCents: c, credits: 1, validityDays: 60, active: true, sortOrder: 20 }) },
  { key: '5 class pack', on: true, price: '135', make: (c) => ({ kind: 'pack', name: '5 class pack', description: 'Five classes within 3 months of your first booking.', priceCents: c, credits: 5, validityDays: 91, active: true, sortOrder: 21 }) },
  { key: '10 class pack', on: false, price: '250', make: (c) => ({ kind: 'pack', name: '10 class pack', description: 'Ten classes within 6 months of your first booking.', priceCents: c, credits: 10, validityDays: 182, active: true, sortOrder: 22 }) },
  { key: '2 classes a week', on: true, price: '45', make: (c) => ({ kind: 'membership', name: '2 classes a week', description: 'Two classes every week, billed weekly.', priceCents: c, credits: 2, validityDays: null, billingInterval: 'week', active: true, sortOrder: 10, highlight: 'Recommended' }) },
  { key: 'Unlimited weekly', on: false, price: '65', make: (c) => ({ kind: 'membership', name: 'Unlimited', description: 'As many classes as you like, billed weekly.', priceCents: c, credits: null, validityDays: null, billingInterval: 'week', active: true, sortOrder: 11 }) },
];
function Pricing() {
  const products = useData(() => store.listProducts({ includeInactive: true }), []);
  const [tpls, setTpls] = useState<Tpl[]>(TEMPLATES);
  const { busy, run } = useAction();
  const have = new Set((products.data ?? []).map((p) => p.name.toLowerCase()));
  const todo = tpls.filter((t) => t.on && !have.has(t.make(0).name.toLowerCase()));
  const create = () => run(async () => {
    for (const t of todo) await store.upsertProduct(t.make(Math.round(Number(t.price) * 100) || 0));
  }, `${todo.length} added to your shop`);
  return (
    <div className="stack lg">
      <h2>Your <em>pricing</em></h2>
      <p className="muted">Start from these and adjust the prices. Prices include tax. Everything can be changed later in Settings › Products.</p>
      <div className="onb-list">
        {tpls.map((t, n) => {
          const made = have.has(t.make(0).name.toLowerCase());
          return (
            <label key={t.key} className={cx('onb-tpl', made && 'made')}>
              <input type="checkbox" checked={made || t.on} disabled={made} onChange={(e) => setTpls(tpls.map((x, k) => (k === n ? { ...x, on: e.target.checked } : x)))} />
              <span className="onb-tpl-t"><strong>{t.key}</strong><span className="muted small">{t.make(0).description}</span></span>
              {made ? <span className="chip ok">In your shop</span>
                : <span className="money-in"><span>$</span><input className="input sm" inputMode="decimal" value={t.price} onChange={(e) => setTpls(tpls.map((x, k) => (k === n ? { ...x, price: e.target.value } : x)))} aria-label={`${t.key} price in ${CURRENCY}`} /></span>}
            </label>
          );
        })}
      </div>
      <div className="onb-actions"><button className="btn" onClick={create} disabled={busy || todo.length === 0}>{busy ? 'Adding…' : todo.length ? `Add ${todo.length} to my shop` : 'All added'}</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ 5. policies
function Policies({ onDone }: { onDone: () => void }) {
  const { settings } = useStudio();
  const [v, setV] = useState<Pick<StudioSettings, 'cancelWindowHours' | 'waitlistCutoffHours' | 'bookingWindowDays' | 'defaultCapacity' | 'waiverText'>>({
    cancelWindowHours: settings.cancelWindowHours, waitlistCutoffHours: settings.waitlistCutoffHours, bookingWindowDays: settings.bookingWindowDays,
    defaultCapacity: settings.defaultCapacity, waiverText: settings.waiverText,
  });
  useEffect(() => setV((x) => ({ ...x, waiverText: settings.waiverText })), [settings.waiverText]);
  const { busy, run } = useAction();
  const n = (k: 'cancelWindowHours' | 'waitlistCutoffHours' | 'bookingWindowDays' | 'defaultCapacity') => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) || 0 });
  const save = async () => {
    const r = await run(() => store.updateSettings({
      ...v,
      cancellationPolicyText: `Cancel at least ${v.cancelWindowHours} hours before class to get your credit back. Later cancellations and no-shows lose the credit.`,
      waitlistPolicyText: `If a class is full, join the waitlist. If a spot opens, the first person with a credit is booked in automatically, up to ${v.waitlistCutoffHours} hour${v.waitlistCutoffHours === 1 ? '' : 's'} before class.`,
    }), 'Policies saved');
    if (r) onDone();
  };
  return (
    <div className="stack lg">
      <h2>Your <em>policies</em></h2>
      <div className="form-grid">
        <label className="field"><span>Free cancellation until (hours before class)</span><input className="input" type="number" min={0} value={v.cancelWindowHours} onChange={n('cancelWindowHours')} /></label>
        <label className="field"><span>Waitlist auto-booking stops (hours before)</span><input className="input" type="number" min={0} value={v.waitlistCutoffHours} onChange={n('waitlistCutoffHours')} /></label>
        <label className="field"><span>Clients can book ahead (days)</span><input className="input" type="number" min={1} value={v.bookingWindowDays} onChange={n('bookingWindowDays')} /></label>
        <label className="field"><span>Spots per class (default)</span><input className="input" type="number" min={1} value={v.defaultCapacity} onChange={n('defaultCapacity')} /></label>
        <label className="field span2"><span>Waiver (clients sign this before their first class)</span><textarea className="textarea onb-waiver" value={v.waiverText} onChange={(e) => setV({ ...v, waiverText: e.target.value })} /></label>
      </div>
      <div className="onb-actions"><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}<Icon name="right" size={18} /></button></div>
    </div>
  );
}

// ------------------------------------------------------------------ 6. staff
function Team() {
  const staff = useData(() => store.listStaff({ includeInactive: true }), []);
  const { busy, run } = useAction();
  const [v, setV] = useState<{ name: string; email: string; role: StaffRole }>({ name: '', email: '', role: 'instructor' });
  const invite = async () => {
    const r = await run(() => store.upsertStaff({ name: v.name.trim(), email: v.email.trim(), role: v.role, active: true }), `${v.name.trim()} added. They’ll get an invite to set a password.`);
    if (r) setV({ name: '', email: '', role: 'instructor' });
  };
  return (
    <div className="stack lg">
      <h2>Your <em>team</em></h2>
      <p className="muted">Add your instructors and front desk. Each person signs in to this studio app with their own email.</p>
      <div className="onb-list">
        {(staff.data ?? []).map((s) => <div key={s.id} className="onb-item"><strong>{s.name}</strong><span className="muted small">{s.email} · {s.role.replace('_', ' ')}</span></div>)}
      </div>
      <div className="onb-add">
        <input className="input" placeholder="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <input className="input" type="email" placeholder="Email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        <select className="select" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as StaffRole })} aria-label="Role">
          <option value="instructor">Instructor</option><option value="front_desk">Front desk</option><option value="manager">Manager</option>
        </select>
        <button className="btn soft" disabled={busy || !v.name.trim() || !v.email.trim()} onClick={invite}>Invite</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 7. go live
function GoLive() {
  const { studio } = useStudio();
  const data = useData(async () => {
    const [types, products, staff, templates] = await Promise.all([store.listClassTypes(), store.listProducts(), store.listStaff(), store.listTemplates().catch(() => [])]);
    return { types, products, staff, templates };
  }, []);
  const { busy, run } = useAction();
  const d = data.data;
  const checks = d ? [
    { ok: !!studio.address && !!studio.email, label: 'Studio details', to: 'details' },
    { ok: !!studio.branding?.colors, label: 'Look + feel', to: 'branding' },
    { ok: d.types.length > 0, label: `${d.types.length} class type${d.types.length === 1 ? '' : 's'}`, to: 'classes' },
    { ok: d.products.length > 0, label: `${d.products.length} product${d.products.length === 1 ? '' : 's'} in the shop`, to: 'pricing' },
    { ok: d.templates.length > 0, label: d.templates.length ? `${d.templates.length} weekly classes on the timetable` : 'Weekly timetable (Schedule › Timetable)', to: '' },
  ] : [];
  const ready = checks.slice(0, 4).every((c) => c.ok);
  const live = studio.status === 'live';
  const open = async () => {
    const r = await run(() => store.updateStudio({ status: 'live' }), `${studio.name} is live`);
    if (r) location.hash = '/';
  };
  return (
    <div className="stack lg">
      <h2>{live ? <>You’re <em>live</em></> : <>Ready to <em>open?</em></>}</h2>
      <ul className="onb-checks">
        {checks.map((c) => (
          <li key={c.label} className={cx(c.ok && 'ok')}>
            <span className="onb-tick">{c.ok ? <Icon name="check" size={16} /> : <Flower size={12} />}</span>
            {c.to ? <a href={`#/welcome/${c.to}`}>{c.label}</a> : <a href="#/schedule/timetable">{c.label}</a>}
          </li>
        ))}
      </ul>
      {d && d.products.length > 0 && <p className="muted small">From {money(Math.min(...d.products.map((p) => p.priceCents)))} in your shop.</p>}
      {live
        ? <p className="muted">Clients can find {studio.name} in the app and book. Share your link: <strong>?studio={studio.slug}</strong></p>
        : <p className="muted">Going live puts {studio.name} in the app’s studio list so clients can sign up and book.</p>}
      {!live && <div className="onb-actions"><button className="btn" onClick={open} disabled={busy || !ready}>{busy ? 'Opening…' : 'Go live'}<Icon name="right" size={18} /></button>{!ready && <span className="muted small">Finish the first four steps first.</span>}</div>}
    </div>
  );
}
