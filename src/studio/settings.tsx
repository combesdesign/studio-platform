import React, { useEffect, useState } from 'react';
import { Sheet, leaveSheets, store, useAction, useData, useToast } from '../shared/react';
import { money } from '../shared/format';
import type { ClassType, Product, Staff, StaffRole, StudioSettings } from '../shared/types';
import { Flower } from '../shared/brand';
import { brandAsset, getBranding } from '../shared/branding';
import { Slot } from '../shared/slots';
import { isFeatureLocked, settingsTabsAll, settingsTabsList } from '../shared/registry';
import { PlanPanel, Upsell } from './billing';
import { Avatar, Confirm, Icon, Loading, PageHead, ROLE_LABEL, SheetHead, cx, replaceRoute, roleLabel, toCents, toDollars, useStudio, type Perm } from './ui';
import { productKindLabel } from './book';
import { healthPolicy } from '../domain';
import { BrandingTab } from './branding';
import { LocationsTab, useLocationsTabVisible } from './locations';
import { PaymentsPanel } from './payments';
import { isSingleStudio } from '../shared/boot';
import { SingleRoomLayoutCard } from './spots';

const TABS: { key: string; label: string; perm?: Perm | string; order: number }[] = [
  { key: 'studio', label: 'Studio', order: 10 }, { key: 'branding', label: 'Branding', order: 15 }, { key: 'policies', label: 'Policies', order: 20 },
  { key: 'classes', label: 'Class types', order: 30 }, { key: 'products', label: 'Products & pricing', perm: 'products', order: 40 },
  { key: 'staff', label: 'Staff', perm: 'staff', order: 50 },
  // Stripe Connect: each studio on the platform is paid into its own Stripe account. The single-studio Snowy build never shows this.
  { key: 'payments', label: 'Payments', perm: 'studioFinance', order: 45 },
  // What the studio pays Pete (plans + billing). The single-studio Snowy build never shows this.
  { key: 'plan', label: 'Plan & billing', perm: 'studioFinance', order: 46 },
];

export function Settings({ tab = 'studio' }: { tab?: string }) {
  const { can } = useStudio();
  const feature = settingsTabsList();
  // Locations & rooms: only when the plan has multi_location, or the studio already runs more than one location. One-location studios never see it.
  const locationsOn = useLocationsTabVisible();
  const all = [...TABS.filter((t) => (t.key !== 'payments' && t.key !== 'plan') || !isSingleStudio()), ...feature.map((t) => ({ key: t.id, label: t.label, ...(t.perm ? { perm: t.perm } : {}), order: t.order ?? 100 }))]
    .concat(locationsOn ? [{ key: 'locations', label: 'Locations & rooms', perm: 'settings', order: 47 }] : [])
    .concat(store.mode === 'demo' ? [{ key: 'demo', label: 'Demo', order: 90 }] : [])
    .sort((x, y) => x.order - y.order);
  const tabs = all.filter((t) => !t.perm || can(t.perm));
  const lockedTab = settingsTabsAll().find((t) => t.id === tab && t.feature && isFeatureLocked(t.feature));
  const cur = lockedTab ? tab : tabs.find((t) => t.key === tab)?.key ?? 'studio';
  const featureTab = feature.find((t) => t.id === cur);
  // With many tabs the strip scrolls sideways: keep the open one in view (deep links and returning from Stripe land on a late tab).
  useEffect(() => { document.querySelector<HTMLElement>('.settings .tabs a.on')?.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }, [cur]);
  return (
    <div className="settings">
      <PageHead eyebrow="Settings" title={<>Studio <em>setup</em></>} />
      <nav className="tabs" aria-label="Settings sections">
        {/* Tabs swap in place (no history entry each), so back leaves Settings rather than stepping through tabs. */}
        {tabs.map((t) => <a key={t.key} href={`#/settings/${t.key}`} className={cx(cur === t.key && 'on')} aria-current={cur === t.key ? 'page' : undefined}
          onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); replaceRoute(`/settings/${t.key}`); }}>{t.label}</a>)}
      </nav>
      {cur === 'studio' && <StudioTab />}
      {cur === 'policies' && <PoliciesTab />}
      {cur === 'classes' && <ClassTypesTab />}
      {cur === 'products' && <ProductsTab />}
      {cur === 'staff' && <StaffTab />}
      {cur === 'demo' && <DemoTab />}
      {cur === 'branding' && <BrandingTab />}
      {cur === 'payments' && <PaymentsTab />}
      {cur === 'plan' && <PlanPanel />}
      {cur === 'locations' && <LocationsTab />}
      {lockedTab && <Upsell feature={lockedTab.feature!} />}
      {featureTab && featureTab.render()}
    </div>
  );
}

function useDraft() {
  const { settings } = useStudio();
  const [d, setD] = useState<StudioSettings>(settings);
  useEffect(() => setD(settings), [settings]);
  const dirty = JSON.stringify(d) !== JSON.stringify(settings);
  return { d, setD, dirty, reset: () => setD(settings), settings };
}

function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="savebar"><span>Unsaved changes</span><button className="btn sm ghost light" onClick={onReset}>Discard</button><button className="btn sm cream" onClick={onSave} disabled={busy}>Save changes</button></div>
  );
}

function StudioTab() {
  const { can, studio } = useStudio();
  const { d, setD, dirty, reset } = useDraft();
  const { busy, run } = useAction();
  const fin = can('studioFinance');
  const f = (k: keyof StudioSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value });
  const save = () => run(() => store.updateSettings(fin ? { name: d.name, address: d.address, email: d.email, phone: d.phone, abn: d.abn, gstRegistered: d.gstRegistered } : { name: d.name, address: d.address, email: d.email, phone: d.phone }), 'Studio details saved');
  return (
    <div className="set-grid">
      <section className="card pad">
        <h3>Studio <em>details</em></h3>
        <p className="muted small" style={{ margin: '6px 0 18px' }}>Shown on receipts, emails and the client app.</p>
        <div className="form-grid">
          <label className="field span2"><span>Studio name</span><input className="input" value={d.name} onChange={f('name')} /></label>
          <label className="field span2"><span>Address</span><input className="input" value={d.address} onChange={f('address')} /></label>
          <label className="field"><span>Email</span><input className="input" type="email" value={d.email} onChange={f('email')} /></label>
          <label className="field"><span>Phone</span><input className="input" type="tel" value={d.phone ?? ''} onChange={f('phone')} /></label>
        </div>
      </section>
      <section className="card pad">
        <h3>Tax &amp; <em>payments</em></h3>
        <p className="muted small" style={{ margin: '6px 0 18px' }}>{fin ? `Used on tax invoices. Prices include ${studio.taxName}.` : 'Only the owner can change these.'}</p>
        <div className="form-grid">
          <label className="field span2"><span>{studio.taxIdLabel}</span><input className="input" value={d.abn ?? ''} onChange={f('abn')} disabled={!fin} placeholder="12 345 678 901" /></label>
          <label className="check span2"><input type="checkbox" checked={d.gstRegistered} disabled={!fin} onChange={(e) => setD({ ...d, gstRegistered: e.target.checked })} /><span>Registered for {studio.taxName} (receipts show "Total includes {studio.taxName} of $X")</span></label>
        </div>
        <div className="panel" style={{ marginTop: 18 }}>
          <strong>Card payments</strong>
          <p className="small muted" style={{ marginTop: 4 }}>{store.mode === 'demo' ? 'Demo mode: payments are simulated.' : 'Online payments and memberships run through Stripe. Bank details are managed in your Stripe dashboard.'} In-studio card reader (Stripe Terminal) is coming later.</p>
        </div>
      </section>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset} />
    </div>
  );
}

function PaymentsTab() {
  return (
    <div className="card pad" style={{ maxWidth: 640 }}>
      <h3>Card <em>payments</em></h3>
      <p className="muted small" style={{ margin: '6px 0 18px' }}>Clients pay by card in the app and the money goes straight to your own Stripe account.</p>
      <PaymentsPanel returnRoute="/settings/payments" />
    </div>
  );
}

function PoliciesTab() {
  const { d, setD, dirty, reset } = useDraft();
  const { busy, run } = useAction();
  const n = (k: keyof StudioSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: Math.max(0, Number(e.target.value) || 0) });
  const c = (k: keyof StudioSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: toCents(e.target.value) });
  const t = (k: keyof StudioSettings) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const hp = healthPolicy(d);
  const save = () => run(() => store.updateSettings({
    cancelWindowHours: d.cancelWindowHours, waitlistCutoffHours: d.waitlistCutoffHours, lateCancelFeeCents: d.lateCancelFeeCents, noShowFeeCents: d.noShowFeeCents,
    bookingWindowDays: d.bookingWindowDays, defaultCapacity: d.defaultCapacity, cancellationPolicyText: d.cancellationPolicyText, waitlistPolicyText: d.waitlistPolicyText,
    waiverText: d.waiverText, healthQuestions: d.healthQuestions.map((q) => q.trim()).filter(Boolean),
    longHealthFormFirstTimers: hp.longFormFirstTimers, quickHealthCheck: hp.quickCheck, quickHealthCheckDays: hp.quickCheckDays,
  }), 'Policies saved');
  return (
    <div className="set-grid">
      <section className="card pad">
        <h3>Booking <em>rules</em></h3>
        <div className="form-grid" style={{ marginTop: 18 }}>
          <label className="field"><span>Cancel window (hours before class)</span><input className="input" type="number" min={0} value={d.cancelWindowHours} onChange={n('cancelWindowHours')} /></label>
          <label className="field"><span>Waitlist stops (hours before class)</span><input className="input" type="number" min={0} value={d.waitlistCutoffHours} onChange={n('waitlistCutoffHours')} /></label>
          <label className="field"><span>Late cancel fee</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" defaultValue={toDollars(d.lateCancelFeeCents)} key={'l' + d.lateCancelFeeCents} onBlur={c('lateCancelFeeCents') as never} /></div></label>
          <label className="field"><span>No-show fee</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" defaultValue={toDollars(d.noShowFeeCents)} key={'n' + d.noShowFeeCents} onBlur={c('noShowFeeCents') as never} /></div></label>
          <label className="field"><span>Clients can book (days ahead)</span><input className="input" type="number" min={1} value={d.bookingWindowDays} onChange={n('bookingWindowDays')} /></label>
          <label className="field"><span>Default class capacity</span><input className="input" type="number" min={1} value={d.defaultCapacity} onChange={n('defaultCapacity')} /></label>
        </div>
        <p className="small faint" style={{ marginTop: 12 }}>Fees are charged on top of losing the credit. $0 means no fee.</p>
      </section>
      <section className="card pad">
        <h3>Policy <em>text</em></h3>
        <div className="stack" style={{ marginTop: 18 }}>
          <label className="field"><span>Cancellation policy (shown to clients)</span><textarea className="textarea" rows={5} value={d.cancellationPolicyText} onChange={t('cancellationPolicyText')} /></label>
          <label className="field"><span>Waitlist policy</span><textarea className="textarea" rows={5} value={d.waitlistPolicyText} onChange={t('waitlistPolicyText')} /></label>
        </div>
      </section>
      <section className="card pad span-all">
        <h3>Health <em>questions at booking</em></h3>
        <p className="muted small" style={{ margin: '6px 0 14px' }}>Clients choose the class and their pass first. These only appear after that, and only when they’re needed. Everyone still signs the waiver once.</p>
        <div className="stack">
          <label className="check"><input type="checkbox" checked={hp.longFormFirstTimers} onChange={(e) => setD({ ...d, longHealthFormFirstTimers: e.target.checked })} />
            <span><strong>Long health form for first-timers</strong><br /><span className="muted small">New clients answer the health questions below with their waiver. Off means the waiver and emergency contact only.</span></span></label>
          <label className="check"><input type="checkbox" checked={hp.quickCheck} onChange={(e) => setD({ ...d, quickHealthCheck: e.target.checked })} />
            <span><strong>Quick health check for returning clients</strong><br /><span className="muted small">One tap: “Any new injuries or health changes since last time?” A yes is saved to their notes with the date and flagged on the roster.</span></span></label>
          {hp.quickCheck && (
            <label className="field" style={{ maxWidth: 260 }}><span>Ask at most once every (days)</span>
              <input className="input" type="number" min={1} max={365} value={hp.quickCheckDays} onChange={(e) => setD({ ...d, quickHealthCheckDays: Math.min(365, Math.max(1, Math.round(Number(e.target.value)) || 30)) })} /></label>
          )}
        </div>
      </section>
      <section className="card pad span-all">
        <h3>Waiver &amp; health <em>form</em></h3>
        <div className="stack" style={{ marginTop: 18 }}>
          <label className="field"><span>Waiver text</span><textarea className="textarea" rows={9} value={d.waiverText} onChange={t('waiverText')} /></label>
          <div className="field"><span>Health questions</span>
            <div className="stack">
              {d.healthQuestions.map((q, i) => (
                <div key={i} className="row">
                  <input className="input" value={q} onChange={(e) => setD({ ...d, healthQuestions: d.healthQuestions.map((x, j) => (j === i ? e.target.value : x)) })} />
                  <button className="btn icon ghost" onClick={() => setD({ ...d, healthQuestions: d.healthQuestions.filter((_, j) => j !== i) })} aria-label="Remove question"><Icon name="trash" size={18} /></button>
                </div>
              ))}
              <button className="btn sm soft" style={{ justifySelf: 'start' }} onClick={() => setD({ ...d, healthQuestions: [...d.healthQuestions, ''] })}><Icon name="plus" size={16} />Add question</button>
            </div>
          </div>
        </div>
      </section>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset} />
    </div>
  );
}

// ------------------------------------------------------------------ class types
function ClassTypesTab() {
  const { classTypes } = useStudio();
  const [edit, setEdit] = useState<Partial<ClassType> | null>(null);
  const { settings } = useStudio();
  return (
    <div>
      <div className="tab-head"><p className="muted">The kinds of classes on the timetable.</p><button className="btn" onClick={() => setEdit({ color: getBranding().colors.accent, durationMin: 55, defaultCapacity: settings.defaultCapacity, bookable: true, active: true })}><Icon name="plus" size={20} />New class type</button></div>
      <div className="ct-grid">
        {classTypes.map((t) => (
          <button key={t.id} className={cx('card ct-card', !t.active && 'off')} onClick={() => setEdit(t)} style={{ ['--ct' as string]: t.color }}>
            <span className="ct-sw" />
            <span className="ct-name">{t.name}</span>
            <span className="ct-meta">{t.durationMin} min · {t.defaultCapacity} spots{t.level ? ` · ${t.level}` : ''}</span>
            <span className="ct-desc">{t.description}</span>
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {!t.bookable && <span className="chip cream">Coming soon</span>}
              {!t.active && <span className="chip">Hidden</span>}
              {t.bookingNote && <span className="chip">Booking note</span>}
              {t.spotPicking && <span className="chip">Clients pick a spot</span>}
            </span>
          </button>
        ))}
      </div>
      <SingleRoomLayoutCard />
      <ClassTypeSheet t={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

/** The studio's own colours first, then a few calm extras. */
const swatches = () => { const c = getBranding().colors; return [...new Set([c.primary, c.accent, c.ink, '#7FA79B', '#C9A961', '#9C8AB4', '#6E8FA6'])]; };
function ClassTypeSheet({ t, onClose }: { t: Partial<ClassType> | null; onClose: () => void }) {
  const [v, setV] = useState<Partial<ClassType>>({});
  const { busy, run } = useAction();
  useEffect(() => { if (t) setV(t); }, [t]);
  const s = (k: keyof ClassType) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const save = async () => {
    const r = await run(() => store.upsertClassType({
      id: v.id, name: (v.name ?? '').trim(), description: v.description ?? '', durationMin: Number(v.durationMin) || 55, color: v.color ?? getBranding().colors.accent,
      defaultCapacity: Number(v.defaultCapacity) || 14, level: v.level || undefined, bookingNote: v.bookingNote || undefined, bookable: v.bookable !== false, active: v.active !== false,
      ...(v.spotPicking !== undefined ? { spotPicking: !!v.spotPicking } : {}),
    }), 'Class type saved');
    if (r) onClose();
  };
  return (
    <Sheet open={!!t} onClose={onClose} label="Class type">
      <SheetHead title={v.id ? <>Edit <em>{v.name}</em></> : <>New class <em>type</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Name</span><input className="input" value={v.name ?? ''} onChange={s('name')} /></label>
        <label className="field span2"><span>Description</span><textarea className="textarea" rows={2} value={v.description ?? ''} onChange={s('description')} /></label>
        <label className="field"><span>Length (minutes)</span><input className="input" type="number" value={v.durationMin ?? ''} onChange={(e) => setV({ ...v, durationMin: Number(e.target.value) })} /></label>
        <label className="field"><span>Default capacity</span><input className="input" type="number" value={v.defaultCapacity ?? ''} onChange={(e) => setV({ ...v, defaultCapacity: Number(e.target.value) })} /></label>
        <label className="field"><span>Level</span><input className="input" value={v.level ?? ''} onChange={s('level')} placeholder="All levels" /></label>
        <div className="field"><span>Timetable colour</span>
          <div className="swatches">{swatches().map((c) => <button key={c} type="button" className={cx('sw', v.color?.toLowerCase() === c.toLowerCase() && 'on')} style={{ background: c }} onClick={() => setV({ ...v, color: c })} aria-label={c} />)}</div>
        </div>
        <label className="field span2"><span>Booking note (shown before booking)</span><textarea className="textarea" rows={2} value={v.bookingNote ?? ''} onChange={s('bookingNote')} placeholder="e.g. Mums must have clearance from a women's health professional" /></label>
        <label className="check span2"><input type="checkbox" checked={v.bookable !== false} onChange={(e) => setV({ ...v, bookable: e.target.checked })} /><span>Bookable (untick for “Coming soon – register interest”)</span></label>
        <label className="check span2"><input type="checkbox" checked={!!v.spotPicking} onChange={(e) => setV({ ...v, spotPicking: e.target.checked })} /><span><strong>Let clients pick a spot</strong><br /><span className="muted small">They choose their reformer or mat when they book, or tap “Pick for me”. It only applies to classes in a room with a spot layout (Settings, Class types or Locations &amp; rooms).</span></span></label>
        <label className="check span2"><input type="checkbox" checked={v.active !== false} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Active</span></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !(v.name ?? '').trim()}>Save</button></div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ products (mirrors the website's "Find what's best for you")
const perClass = (p: Product) => {
  if (p.noClasses) return 'Online classes only';
  if (p.kind === 'membership') return p.credits == null ? 'Unlimited classes' : `${money(Math.round(p.priceCents / p.credits), { cents: true })} per class`;
  if (p.kind === 'intro') return `Unlimited for ${p.validityDays ?? 14} days`;
  if (p.kind === 'dropin' || (p.credits ?? 1) === 1) return 'Per class';
  return `${money(Math.round(p.priceCents / (p.credits ?? 1)), { cents: true })} per class`;
};

function PlanCard({ p, onEdit, ghostBadge }: { p: Product; onEdit: () => void; ghostBadge?: boolean }) {
  const pick = !!p.highlight && p.active;
  return (
    <button className={cx('plan', pick && 'pick', !p.active && 'off')} onClick={onEdit} aria-label={`Edit ${p.name}`}>
      {p.highlight ? <span className="badge">{p.highlight}</span> : !p.active ? <span className="badge">Hidden</span> : ghostBadge ? <span className="badge ghost" aria-hidden="true">–</span> : null}
      <span className="pname">{p.name}</span>
      <span className="amt">{money(p.priceCents)}{p.kind === 'membership' && <small>/{p.billingInterval ?? 'week'}</small>}</span>
      <span className="per">{perClass(p)}</span>
      <hr />
      <span className="pdesc">{p.description || prodSummary(p)}</span>
      <span className={cx('btn sm', pick ? 'white' : 'soft', 'plan-edit')}><Icon name="edit" size={16} />Edit</span>
    </button>
  );
}

function ProductsTab() {
  const res = useData(() => store.listProducts({ includeInactive: true }), []);
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  if (!res.data) return <Loading />;
  const by = (...k: Product['kind'][]) => res.data!.filter((p) => k.includes(p.kind)).sort((a, b) => a.sortOrder - b.sortOrder);
  const members = by('membership'), packs = by('dropin', 'pack'), intro = by('intro'), retail = by('retail');
  const anyBadge = members.some((p) => p.highlight);
  return (
    <div className="products">
      <div className="tab-head"><p className="muted">Prices include GST. This is what clients see in the shop, same as the website.</p><button className="btn" onClick={() => setEdit({ kind: 'pack', active: true, sortOrder: 50, credits: 4, validityDays: 61 })}><Icon name="plus" size={20} />New product</button></div>

      {members.length > 0 && (
        <section className="plan-sec">
          <div className="sec-head"><h2>Member<em>ships</em></h2><span className="muted small">Activate from first use · billed by weekly direct debit</span></div>
          <div className="plans">{members.map((p) => <PlanCard key={p.id} p={p} onEdit={() => setEdit(p)} ghostBadge={anyBadge} />)}</div>
        </section>
      )}

      {intro.map((p) => (
        <button key={p.id} className={cx('offer-card', !p.active && 'off')} onClick={() => setEdit(p)} aria-label={`Edit ${p.name}`}>
          <span className="oc-copy">
            <span className="oc-price"><sup>$</sup>{toDollars(p.priceCents)}</span>
            <span className="oc-name">{p.name}{!p.active && ' · hidden'}</span>
            <span className="oc-desc">{p.description || prodSummary(p)}</span>
            <span className="oc-fine">New clients only<Flower size={9} color="var(--highlight)" />{p.validityDays ?? 14} days unlimited from first booking</span>
            <span className="btn sm white plan-edit"><Icon name="edit" size={16} />Edit</span>
          </span>
          <span className="oc-img"><img src={brandAsset(getBranding().photos.offer ?? getBranding().photos.hero)} alt="" loading="lazy" /></span>
        </button>
      ))}

      {packs.length > 0 && (
        <section className="plan-sec">
          <div className="sec-head"><h2>Class <em>packs</em></h2><span className="muted small">Expiry starts at the first booking</span></div>
          <div className="plans packs">{packs.map((p) => <PlanCard key={p.id} p={p} onEdit={() => setEdit(p)} />)}</div>
        </section>
      )}

      {retail.length > 0 && (
        <section className="plan-sec">
          <div className="sec-head"><h2><em>Retail</em></h2></div>
          <div className="card list">
            {retail.map((p) => (
              <button key={p.id} className={cx('prod-row', !p.active && 'off')} onClick={() => setEdit(p)}>
                <Flower size={14} className="pr-fl" />
                <span className="grow"><strong>{p.name}</strong>{!p.active && <span className="chip" style={{ marginLeft: 8 }}>Hidden</span>}
                  <span className="faint small block">{prodSummary(p)}</span></span>
                <span className="prod-price">{money(p.priceCents)}</span>
                <Icon name="right" size={18} className="faint" />
              </button>
            ))}
          </div>
        </section>
      )}
      <ProductSheet p={edit} onClose={() => setEdit(null)} />
    </div>
  );
}
function prodSummary(p: Product) {
  if (p.kind === 'retail') return p.stock == null ? 'Stock not tracked' : `${p.stock} in stock`;
  if (p.noClasses) return 'Online classes only, no studio classes';
  if (p.kind === 'membership') return `${p.credits == null ? 'Unlimited' : `${p.credits} credit${p.credits === 1 ? '' : 's'}`} per week, billed weekly`;
  if (p.kind === 'intro') return `Unlimited for ${p.validityDays ?? 14} days from first booking · new clients only`;
  return `${p.credits ?? 1} credit${(p.credits ?? 1) === 1 ? '' : 's'}${p.validityDays ? ` · expires ${p.validityDays} days after first use` : ''}`;
}

function ProductSheet({ p, onClose }: { p: Partial<Product> | null; onClose: () => void }) {
  const [v, setV] = useState<Partial<Product>>({});
  const [price, setPrice] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (p) { setV(p); setPrice(toDollars(p.priceCents ?? 0)); } }, [p]);
  const kind = v.kind ?? 'pack';
  const unlimited = v.credits === null;
  const familyDefault = kind === 'pack' || kind === 'dropin';
  const shareable = v.familyShareable ?? familyDefault;
  const save = async () => {
    const isPass = kind !== 'retail';
    const r = await run(() => store.upsertProduct({
      id: v.id, kind, name: (v.name ?? '').trim(), description: v.description ?? '', priceCents: toCents(price), active: v.active !== false,
      highlight: v.highlight || undefined, sortOrder: Number(v.sortOrder) || 0,
      credits: isPass ? (kind === 'intro' ? null : kind === 'dropin' ? 1 : v.credits ?? null) : undefined,
      validityDays: isPass && kind !== 'membership' ? (v.validityDays ?? null) : undefined,
      billingInterval: kind === 'membership' ? v.billingInterval ?? 'week' : undefined,
      newClientsOnly: kind === 'intro' ? true : undefined,
      classTypeIds: v.classTypeIds, noClasses: isPass && v.noClasses ? true : undefined,
      // only stored when it differs from the default (packs and drop-ins share, memberships and intro offers don't)
      familyShareable: isPass && !v.noClasses && shareable !== familyDefault ? shareable : undefined,
      stock: kind === 'retail' ? (v.stock ?? null) : undefined,
    }), 'Product saved');
    if (r) onClose();
  };
  return (
    <Sheet open={!!p} onClose={onClose} label="Product">
      <SheetHead title={v.id ? <>Edit <em>product</em></> : <>New <em>product</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field"><span>Type</span>
          <select className="select" value={kind} onChange={(e) => setV({ ...v, kind: e.target.value as Product['kind'] })} disabled={!!v.id}>
            <option value="membership">Membership</option><option value="pack">Class pack</option><option value="intro">Intro offer</option><option value="dropin">Drop-in</option><option value="retail">Retail</option>
          </select>
        </label>
        <label className="field"><span>Price (inc GST)</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div></label>
        <label className="field span2"><span>Name</span><input className="input" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <label className="field span2"><span>Description</span><textarea className="textarea" rows={2} value={v.description ?? ''} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
        {kind === 'membership' && (
          <>
            <label className="field"><span>Classes per week</span><input className="input" type="number" min={1} value={unlimited ? '' : v.credits ?? ''} disabled={unlimited} onChange={(e) => setV({ ...v, credits: Number(e.target.value) || 1 })} /></label>
            <label className="check" style={{ alignSelf: 'end', minHeight: 48 }}><input type="checkbox" checked={unlimited} onChange={(e) => setV({ ...v, credits: e.target.checked ? null : 1 })} /><span>Unlimited</span></label>
          </>
        )}
        {kind === 'pack' && <label className="field"><span>Credits</span><input className="input" type="number" min={1} value={v.credits ?? ''} onChange={(e) => setV({ ...v, credits: Number(e.target.value) || 1 })} /></label>}
        {(kind === 'pack' || kind === 'dropin' || kind === 'intro') && (
          <label className="field"><span>Expires (days after first use)</span><input className="input" type="number" min={1} value={v.validityDays ?? ''} onChange={(e) => setV({ ...v, validityDays: e.target.value ? Number(e.target.value) : null })} /></label>
        )}
        {kind === 'retail' && <label className="field"><span>Stock (blank = not tracked)</span><input className="input" type="number" min={0} value={v.stock ?? ''} onChange={(e) => setV({ ...v, stock: e.target.value === '' ? null : Number(e.target.value) })} /></label>}
        <label className="field"><span>Badge (optional)</span><input className="input" value={v.highlight ?? ''} onChange={(e) => setV({ ...v, highlight: e.target.value })} placeholder="Recommended" /></label>
        <label className="field"><span>Sort order</span><input className="input" type="number" value={v.sortOrder ?? 0} onChange={(e) => setV({ ...v, sortOrder: Number(e.target.value) })} /></label>
        <label className="check span2"><input type="checkbox" checked={v.active !== false} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>On sale (shown in the shop and POS)</span></label>
        {kind !== 'retail' && <label className="check span2"><input type="checkbox" checked={!!v.noClasses} onChange={(e) => setV({ ...v, noClasses: e.target.checked })} /><span>Online only (no studio classes, e.g. the Online membership)</span></label>}
        {kind !== 'retail' && !v.noClasses && <label className="check span2"><input type="checkbox" checked={shareable} onChange={(e) => setV({ ...v, familyShareable: e.target.checked })} /><span>Family-shareable (a parent's kids and partner can use these credits. Off means they need their own pass)</span></label>}
      </div>
      {kind === 'intro' && <p className="small faint" style={{ marginTop: 12 }}>Intro offers are unlimited for the period and only for clients who've never had a class pass.</p>}
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !(v.name ?? '').trim()}>Save</button></div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ staff
function StaffTab() {
  const { staff, can, me, teaches, templates, typeById } = useStudio();
  const [edit, setEdit] = useState<Partial<Staff> | null>(null);
  const showPay = can('pay');
  const teachesWhat = (id: string) => [...new Set(templates.filter((t) => t.active && t.instructorId === id).map((t) => typeById(t.classTypeId)?.name).filter(Boolean))].join(', ');
  return (
    <div>
      <div className="tab-head"><p className="muted">Who can sign in to the studio app, and what they can do.</p><button className="btn" onClick={() => setEdit({ role: 'instructor', active: true })}><Icon name="userPlus" size={20} />Add staff</button></div>
      <div className="staff-grid">
        {staff.map((s) => (
          <button key={s.id} className={cx('card staff-card', !s.active && 'off')} onClick={() => setEdit(s)}>
            <Avatar name={s.name} photo={s.photoUrl} size={64} />
            <span className="sc-t">
              <strong>{s.name}{s.id === me.staffId && <span className="faint small"> (you)</span>}</strong>
              <span className="sc-role">{roleLabel(s.role, teaches(s.id))}</span>
              {teaches(s.id) && <span className="faint small">Teaches {teachesWhat(s.id)}</span>}
              <span className="faint small">{s.email}</span>
              {showPay && s.payPerClassCents != null && <span className="small muted">{money(s.payPerClassCents)} per class</span>}
              {!s.active && <span className="chip">Inactive</span>}
              <Slot name="staff.card" props={{ staff: s }} can={can} />
            </span>
          </button>
        ))}
      </div>
      <div className="card pad perm-card">
        <h3>What each role <em>can do</em></h3>
        <dl className="dl roles">
          <dt>Owner</dt><dd>Everything, including pay rates, ABN and payments.</dd>
          <dt>Manager</dt><dd>Everything except staff pay rates and the ABN / payment settings.</dd>
          <dt>Front desk</dt><dd>Schedule, rosters, check-in, clients, point of sale and refunds. Attendance reports only: no revenue, pay or settings.</dd>
          <dt>Instructor</dt><dd>Rosters and check-in for their own classes, client profiles (no staff notes) and sales. No refunds, revenue, pay or settings.</dd>
          <dt>Teaching</dt><dd>Anyone can teach, whatever their role. Put them on a class and it shows under “My classes” for them.</dd>
        </dl>
      </div>
      <StaffSheet s={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function StaffSheet({ s, onClose }: { s: Partial<Staff> | null; onClose: () => void }) {
  const { can, me } = useStudio();
  const [v, setV] = useState<Partial<Staff>>({});
  const [pay, setPay] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (s) { setV(s); setPay(toDollars(s.payPerClassCents)); } }, [s]);
  const showPay = can('pay');
  const roles: StaffRole[] = me.role === 'owner' ? ['owner', 'manager', 'front_desk', 'instructor'] : ['manager', 'front_desk', 'instructor'];
  const lockedOwner = v.role === 'owner' && me.role !== 'owner';
  const save = async () => {
    const r = await run(() => store.upsertStaff({
      id: v.id, name: (v.name ?? '').trim(), email: (v.email ?? '').trim().toLowerCase(), phone: v.phone || undefined, role: v.role ?? 'instructor',
      bio: v.bio || undefined, photoUrl: v.photoUrl, active: v.active !== false,
      payPerClassCents: showPay ? (pay.trim() ? toCents(pay) : undefined) : v.payPerClassCents,
    }), 'Staff saved');
    if (r) onClose();
  };
  return (
    <Sheet open={!!s} onClose={onClose} label="Staff member">
      <SheetHead title={v.id ? <>Edit <em>{v.name?.split(' ')[0]}</em></> : <>Add <em>staff</em></>} sub={v.id ? undefined : 'They sign in to the studio app with this email.'} onClose={onClose} />
      {lockedOwner ? <p className="muted">Only the owner can edit the owner's details.</p> : (
        <div className="form-grid">
          <label className="field"><span>Name</span><input className="input" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
          <label className="field"><span>Role</span>
            <select className="select" value={v.role ?? 'instructor'} onChange={(e) => setV({ ...v, role: e.target.value as StaffRole })} disabled={v.id === me.staffId}>
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="field"><span>Email</span><input className="input" type="email" value={v.email ?? ''} onChange={(e) => setV({ ...v, email: e.target.value })} /></label>
          <label className="field"><span>Phone</span><input className="input" type="tel" value={v.phone ?? ''} onChange={(e) => setV({ ...v, phone: e.target.value })} /></label>
          <label className="field span2"><span>Bio (shown in the client app)</span><textarea className="textarea" rows={3} value={v.bio ?? ''} onChange={(e) => setV({ ...v, bio: e.target.value })} /></label>
          {showPay && <label className="field"><span>Pay per class</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" value={pay} onChange={(e) => setPay(e.target.value)} placeholder="0" /></div></label>}
          <label className="check span2"><input type="checkbox" checked={v.active !== false} disabled={v.id === me.staffId} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Active (can sign in and be scheduled)</span></label>
        </div>
      )}
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button>{!lockedOwner && <button className="btn" onClick={save} disabled={busy || !(v.name ?? '').trim() || !(v.email ?? '').trim()}>Save</button>}</div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ demo
function DemoTab() {
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  const go = async () => {
    const ok = await run(async () => { await store.demoReset?.(); return true; });
    if (ok) { toast('Demo data reset'); leaveSheets(() => { location.hash = '/'; }); }
  };
  return (
    <div className="card pad" style={{ maxWidth: 640 }}>
      <h3>Demo <em>data</em></h3>
      <p className="muted" style={{ marginTop: 8 }}>This is a demo with made-up clients and bookings, saved in this browser. Resetting wipes everything you've changed and starts fresh. It also resets the client app in this browser.</p>
      <button className="btn danger" style={{ marginTop: 18 }} onClick={() => setOpen(true)} disabled={!store.demoReset}><Icon name="repeat" size={20} />Reset demo data</button>
      <Confirm open={open} onClose={() => setOpen(false)} title={<>Reset the <em>demo</em>?</>} body="All demo changes are lost and the sample data is restored." confirmLabel="Reset demo" danger busy={busy} onConfirm={go} />
    </div>
  );
}
