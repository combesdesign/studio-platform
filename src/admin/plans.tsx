/**
 * Platform admin: plans and billing. Pete edits the plans (name, monthly price in AUD, Stripe price id, the feature keys each one
 * switches on), the trial length and past-due grace period, sees every studio's plan, billing status and the MRR total, and can put
 * a studio on a plan by hand (comp / free, e.g. Snowy). All of it is data in the plans table; nothing about plans lives in code.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { BillingStatus, Plan, PlatformBillingSettings, Studio } from '../shared/types';
import { platform } from '../data';
import { Accented } from '../shared/brand';
import { useToast } from '../shared/react';
import { money } from '../shared/format';
import { FEATURE_CATALOG, mrrCents } from '../shared/plans';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((data) => live && setState({ data }), (e) => live && setState({ error: msg(e) }));
    const off = platform.subscribe(() => setN((x) => x + 1));
    return () => { live = false; off(); };
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export const BILLING_LABEL: Record<BillingStatus, { label: string; tone: string }> = {
  trialing: { label: 'Trial', tone: 'cream' }, active: { label: 'Active', tone: 'ok' }, past_due: { label: 'Past due', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'danger' },
};

/** Plan name + billing status for a studio, for lists. */
export function PlanBadge({ studio }: { studio: Studio }) {
  if (!studio.billingStatus) return <span className="muted small">No plan</span>;
  const b = BILLING_LABEL[studio.billingStatus];
  return (
    <span className="ad-plan-cell">
      <strong>{studio.plan?.name ?? 'Plan'}</strong>
      <span><span className={`chip ${b.tone}`}>{b.label}</span>{studio.billingComped ? <span className="muted small"> comp</span> : null}</span>
    </span>
  );
}

/** Studios' MRR, shown on the list and the plans page. */
export function MrrLine({ studios }: { studios: Studio[] }) {
  const paying = studios.filter((s) => !s.billingComped && (s.billingStatus === 'active' || s.billingStatus === 'past_due')).length;
  return <>{money(mrrCents(studios))} MRR from {paying} paying {paying === 1 ? 'studio' : 'studios'}</>;
}

// ------------------------------------------------------------------ the plans page
export function PlansPage() {
  const plans = useLoad(() => platform.listPlans({ includeInactive: true }), []);
  const settings = useLoad(() => platform.getBillingSettings(), []);
  const studios = useLoad(() => platform.listStudios({ includeAll: true }), []);
  const [adding, setAdding] = useState(false);
  const list = plans.data ?? [];
  const sts = studios.data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of sts) if (s.billingStatus) c[s.billingStatus] = (c[s.billingStatus] ?? 0) + 1;
    return c;
  }, [studios.data]);
  return (
    <div className="stack lg">
      <div className="ad-head">
        <div>
          <p className="eyebrow"><MrrLine studios={sts} /> · {counts.trialing ?? 0} trialing · {counts.past_due ?? 0} past due</p>
          <h1><Accented text="Plans and *billing*" /></h1>
        </div>
        <button className="btn" onClick={() => setAdding(true)} disabled={adding}>Add a plan</button>
      </div>
      <p className="muted ad-narrow">What each plan costs and switches on lives here, not in the code. Studios see these on Settings, Plan and billing. Put each plan’s Stripe price id in once you’ve made the products in Stripe (see docs/PLATFORM.md).</p>
      {(plans.error || studios.error) && <p className="form-error">{plans.error || studios.error}</p>}
      <BillingSettings value={settings.data} onSaved={settings.reload} />
      <div className="ad-plans">
        {adding && <PlanEditor key="new" plan={null} onDone={() => { setAdding(false); plans.reload(); }} />}
        {list.map((p) => <PlanEditor key={p.id} plan={p} studioCount={sts.filter((s) => s.planId === p.id).length} onDone={plans.reload} />)}
      </div>
    </div>
  );
}

function BillingSettings({ value, onSaved }: { value: PlatformBillingSettings | undefined; onSaved: () => void }) {
  const toast = useToast();
  const [trial, setTrial] = useState<14 | 30>(14);
  const [grace, setGrace] = useState('14');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (value) { setTrial(value.trialDays); setGrace(String(value.graceDays)); } }, [value]);
  const dirty = !!value && (value.trialDays !== trial || String(value.graceDays) !== grace);
  const save = async () => {
    setBusy(true);
    try { await platform.saveBillingSettings({ trialDays: trial, graceDays: Number(grace) }); toast('Billing settings saved'); onSaved(); }
    catch (x) { toast(msg(x)); } finally { setBusy(false); }
  };
  return (
    <section className="card pad ad-settings" aria-label="Trial and grace period">
      <div className="field"><span>Free trial for new studios</span>
        <div className="seg" role="radiogroup" aria-label="Free trial length">
          {([14, 30] as const).map((d) => <button key={d} type="button" role="radio" aria-checked={trial === d} className={trial === d ? 'on' : ''} onClick={() => setTrial(d)}>{d} days</button>)}
        </div>
      </div>
      <label className="field"><span>Grace period when a payment is overdue (days)</span>
        <input className="input" type="number" min={0} max={90} value={grace} onChange={(e) => setGrace(e.target.value)} />
        <small className="muted">After this, the studio app goes read-only for staff. Clients can still book.</small>
      </label>
      {dirty && <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>}
    </section>
  );
}

function PlanEditor({ plan, studioCount, onDone }: { plan: Plan | null; studioCount?: number; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan ? (plan.priceCents / 100).toFixed(2).replace(/\.00$/, '') : '');
  const [priceId, setPriceId] = useState(plan?.stripePriceId ?? '');
  const [features, setFeatures] = useState<string[]>(plan?.features ?? ['core']);
  const [order, setOrder] = useState(String(plan?.sortOrder ?? ''));
  const [active, setActive] = useState(plan?.active ?? true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = !plan || name !== plan.name || Math.round(Number(price) * 100) !== plan.priceCents || priceId !== (plan.stripePriceId ?? '')
    || order !== String(plan.sortOrder) || active !== plan.active || [...features].sort().join() !== [...plan.features].sort().join();
  const toggle = (k: string) => setFeatures((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const cents = Math.round(Number(price) * 100);
      if (!Number.isFinite(cents) || cents < 0) throw new Error('The monthly price needs to be a dollar amount.');
      await platform.savePlan({
        ...(plan ? { id: plan.id } : {}), name: name.trim(), priceCents: cents, stripePriceId: priceId.trim(),
        features: features.includes('core') ? features : ['core', ...features], active, ...(order !== '' ? { sortOrder: Number(order) } : {}),
      });
      toast(plan ? `${name.trim()} saved` : `${name.trim()} added`);
      onDone();
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <form className="card pad stack ad-plan" onSubmit={save} data-testid={`plan-${plan?.key ?? 'new'}`}>
      <div className="ad-plan-top">
        <label className="field"><span>Plan name</span><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Monthly price (AUD)</span><input className="input" type="number" min={0} step="0.01" inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="field"><span>Stripe price id</span><input className="input" placeholder="price_…" value={priceId} onChange={(e) => setPriceId(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label className="field ad-order"><span>Order</span><input className="input" type="number" value={order} onChange={(e) => setOrder(e.target.value)} /></label>
      </div>
      <fieldset className="ad-feats">
        <legend>Switches on</legend>
        {FEATURE_CATALOG.map((f) => (
          <label key={f.key} className="check ad-feat" title={f.blurb}>
            <input type="checkbox" checked={features.includes(f.key)} onChange={() => toggle(f.key)} /><span>{f.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="ad-plan-foot">
        <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Studios can choose this plan</span></label>
        {studioCount !== undefined && <span className="muted small">{studioCount} {studioCount === 1 ? 'studio' : 'studios'} on it</span>}
        <span className="grow" />
        {err && <span className="form-error" role="alert">{err}</span>}
        <button className="btn" disabled={busy || !dirty}>{busy ? 'Saving…' : plan ? 'Save plan' : 'Add plan'}</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ one studio's plan (set by hand)
export function StudioPlanTab({ studio }: { studio: Studio }) {
  const toast = useToast();
  const plans = useLoad(() => platform.listPlans({ includeInactive: true }), []);
  const [planId, setPlanId] = useState(studio.planId ?? '');
  const [status, setStatus] = useState<BillingStatus>(studio.billingStatus ?? 'active');
  const [comped, setComped] = useState(studio.billingComped ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setPlanId(studio.planId ?? ''); setStatus(studio.billingStatus ?? 'active'); setComped(studio.billingComped ?? true); }, [studio.planId, studio.billingStatus, studio.billingComped]);
  const list = plans.data ?? [];
  const cur = list.find((p) => p.id === studio.planId);
  const save = async () => {
    setBusy(true); setErr('');
    try { await platform.setStudioPlan(studio.id, { planId, status, comped }); toast(`${studio.name} is on ${list.find((p) => p.id === planId)?.name ?? 'the plan'}`); }
    catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="ad-grid">
      <section className="card pad">
        <h3>Plan and billing</h3>
        <dl className="ad-dl">
          <dt>Plan</dt><dd>{cur ? `${cur.name} · ${money(cur.priceCents)} a month` : studio.plan?.name ?? 'None'}</dd>
          <dt>Status</dt><dd>{studio.billingStatus ? <span className={`chip ${BILLING_LABEL[studio.billingStatus].tone}`}>{BILLING_LABEL[studio.billingStatus].label}</span> : '·'}</dd>
          <dt>Paying</dt><dd>{studio.billingComped ? 'No: set by hand (comp or free)' : studio.billingStatus === 'trialing' ? 'Not yet (free trial)' : studio.billingStatus ? 'Yes, through Stripe' : '·'}</dd>
          {studio.trialEndsAt && <><dt>Trial ends</dt><dd>{new Date(studio.trialEndsAt).toLocaleDateString()}</dd></>}
          {studio.pastDueSince && <><dt>Past due since</dt><dd>{new Date(studio.pastDueSince).toLocaleDateString()}</dd></>}
          <dt>Switched on</dt><dd>{studio.plan ? studio.plan.features.filter((f) => f !== 'core').map((f) => FEATURE_CATALOG.find((c) => c.key === f)?.label ?? f).join(', ') || 'Core only' : 'Everything (no plan)'}</dd>
        </dl>
      </section>
      <section className="card pad stack">
        <h3>Set the plan by hand</h3>
        <p className="muted small">For a comp, a free studio like Snowy, or to fix a status. “Set by hand” means there is no Stripe subscription behind it. A studio that later subscribes replaces it.</p>
        <label className="field"><span>Plan</span>
          <select className="select" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="" disabled>Choose a plan</option>
            {list.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.priceCents)}{p.active ? '' : ' (retired)'}</option>)}
          </select>
        </label>
        <label className="field"><span>Status</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as BillingStatus)}>
            {(Object.keys(BILLING_LABEL) as BillingStatus[]).map((k) => <option key={k} value={k}>{BILLING_LABEL[k].label}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={comped} onChange={(e) => setComped(e.target.checked)} /><span>Set by hand (comp or free, no Stripe subscription)</span></label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <div className="row"><button className="btn" onClick={save} disabled={busy || !planId}>{busy ? 'Saving…' : 'Save plan'}</button></div>
      </section>
    </div>
  );
}
