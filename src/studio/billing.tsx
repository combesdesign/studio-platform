/**
 * The studio's own plan: what it pays Pete and what that switches on. Three small pieces:
 *   <Upsell feature>   calm "Available on Studio Plus" page where a locked feature's screen would be (no error)
 *   <BillingBanner>    across the top for staff: trial running out, payment overdue, or read-only
 *   <PlanPanel>        Settings -> Plan & billing: current plan, trial days left, change plan, manage billing, and what each plan includes
 * Plans come from the plans table (edited in the admin), so nothing about prices or contents is written in this file.
 */
import React from 'react';
import { platform } from '../data';
import { store, useAction, useData, useToast } from '../shared/react';
import { money, dayLong } from '../shared/format';
import { DEFAULT_BILLING_SETTINGS, FEATURE_CATALOG, billingState, featureLabel, upgradePlanFor } from '../shared/plans';
import type { BillingInfo, Plan } from '../shared/types';
import { refreshBoundStudio } from '../shared/boot';
import { Icon, Loading, PageHead, useStudio } from './ui';

const hereAt = (route: string) => `${location.href.split('#')[0]}#${route}`;
const PLAN_ROUTE = '/settings/plan';

/** "Available on Studio Plus", shown instead of a locked feature's page. */
export function Upsell({ feature }: { feature: string }) {
  const { studio, me } = useStudio();
  const plans = useData(() => store.listPlans(), []);
  const target = plans.data ? upgradePlanFor(plans.data, studio, feature) : undefined;
  const entry = FEATURE_CATALOG.find((f) => f.key === feature);
  return (
    <div className="upsell" data-testid="upsell">
      <PageHead eyebrow="Not on your plan yet" title={<>{featureLabel(feature)} is available on <em>{target?.name ?? 'a higher plan'}</em></>} />
      <section className="card pad upsell-card">
        <div className="upsell-lock"><Icon name="lock" size={22} /></div>
        <div>
          {entry && <p className="upsell-blurb">{entry.blurb}</p>}
          <p className="muted">
            {target ? <>It’s part of {target.name}{target.priceCents > 0 ? `, which is ${money(target.priceCents)} a month` : ''}. Everything you have now carries on exactly as it is.</>
              : 'It isn’t part of your current plan. Everything you have now carries on exactly as it is.'}
          </p>
          {me.role === 'owner'
            ? <div className="row" style={{ marginTop: 14 }}><a className="btn" href={`#${PLAN_ROUTE}`}>See plans<Icon name="right" size={18} /></a></div>
            : <p className="small muted" style={{ marginTop: 14 }}>Your studio owner can change the plan in Settings.</p>}
        </div>
      </section>
    </div>
  );
}

/** The studio's billing state with the platform's grace period. */
export function useBillingState() {
  const { studio } = useStudio();
  const settings = useData(() => platform.getBillingSettings(), []);
  return { state: billingState(studio, settings.data ?? DEFAULT_BILLING_SETTINGS, new Date()), studio };
}

export function BillingBanner() {
  const { me } = useStudio();
  const { state: b } = useBillingState();
  if (!b.banner) return null;
  const owner = me.role === 'owner';
  const by = b.readOnlyOn ? dayLong(b.readOnlyOn) : '';
  let text: React.ReactNode;
  if (b.readOnly) {
    text = b.banner === 'cancelled' ? 'Your plan has ended, so the studio is read-only for now. Your clients can still book.'
      : 'Your studio is read-only until the plan payment is sorted out. Your clients can still book.';
  } else if (b.banner === 'past_due') {
    text = <>The last plan payment didn’t go through. {owner ? 'Update your card' : 'Ask your studio owner to update the card'}{by ? <> by {by}</> : null} to keep editing. Your clients can still book.</>;
  } else if (b.banner === 'trial_ended') {
    text = <>Your free trial has ended. {owner ? 'Pick a plan' : 'Ask your studio owner to pick a plan'}{by ? <> by {by}</> : null} to keep editing. Your clients can still book.</>;
  } else {
    text = <>Your free trial ends in {b.trialDaysLeft} {b.trialDaysLeft === 1 ? 'day' : 'days'}. {owner ? 'Pick a plan whenever you’re ready.' : 'Your studio owner can pick a plan in Settings.'}</>;
  }
  const soft = b.banner === 'trial';
  return (
    <div className={soft ? 'billing-banner soft' : 'billing-banner'} role="status" data-testid="billing-banner">
      <Icon name={soft ? 'clock' : 'alert'} size={18} />
      <span>{text}</span>
      {owner && <a className="btn sm ghost" href={`#${PLAN_ROUTE}`}>{soft ? 'See plans' : b.banner === 'trial_ended' ? 'Choose a plan' : 'Fix billing'}</a>}
    </div>
  );
}

const statusChip = (i: BillingInfo, daysLeft: number | null) => {
  if (i.comped) return <span className="chip ok">Included with your studio</span>;
  switch (i.status) {
    case 'trialing': return <span className="chip">{daysLeft === 0 ? 'Free trial ended' : `Free trial · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`}</span>;
    case 'active': return <span className="chip ok">Active</span>;
    case 'past_due': return <span className="chip warn">Payment overdue</span>;
    default: return <span className="chip warn">Plan ended</span>;
  }
};

/** Everything a plan can switch on, as rows of the comparison. Catalogue order first, then any key a plan has that we don't know. */
function comparisonRows(plans: Plan[]): { key: string; label: string }[] {
  const used = new Set(plans.flatMap((p) => p.features));
  const known = FEATURE_CATALOG.filter((f) => used.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
  const extra = [...used].filter((k) => k !== 'core' && !FEATURE_CATALOG.some((f) => f.key === k)).map((k) => ({ key: k, label: featureLabel(k) }));
  return [{ key: 'core', label: 'Bookings, passes, POS, reports' }, ...known, ...extra];
}

export function PlanPanel() {
  const { studio } = useStudio();
  const toast = useToast();
  const info = useData(() => store.getBilling(), []);
  const plans = useData(() => store.listPlans(), []);
  const { busy, run } = useAction();
  const { state } = useBillingState();

  /** The plan changed: reload so the menu, pages and locks all follow the new plan. */
  const applyChange = () => { location.hash = PLAN_ROUTE; location.reload(); };

  // Back from Stripe Checkout: the webhook may take a moment, so look again a few times.
  const returned = /[?&]checkout=done/.test(location.hash);
  React.useEffect(() => {
    if (!returned) return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      const fresh = await store.getStudio().catch(() => null);
      if (fresh) refreshBoundStudio(fresh);
      info.reload();
      if (fresh && fresh.planId !== studio.planId) { clearInterval(t); applyChange(); }
      if (n >= 4) clearInterval(t);
    }, 2500);
    toast('Thanks! Finishing setting up your plan');
    return () => clearInterval(t);
  }, [returned]);

  if (info.loading && !info.data) return <Loading />;
  const i = info.data;
  if (!i) return <p className="muted">{info.error?.message || 'We couldn’t load your plan. Please try again.'}</p>;
  if (!i.enabled) {
    return <div className="panel"><strong>Your plan</strong><p className="small muted" style={{ marginTop: 4 }}>This studio has its own deployment, so there’s no plan to pay for. Everything is switched on.</p></div>;
  }
  const list = plans.data ?? [];
  const mine = list.find((p) => p.id === i.planId);
  const rows = comparisonRows(list);

  const choose = async (p: Plan) => {
    const r = await run(() => store.startPlanCheckout(p.id, hereAt(`${PLAN_ROUTE}?checkout=done`)));
    if (r === undefined) return;            // it failed and run() showed why
    if (r && r.url) { location.href = r.url; return; }
    const fresh = await store.getStudio().catch(() => null);   // changed in place (demo, or an existing subscription)
    if (fresh) refreshBoundStudio(fresh);
    toast(`You’re on ${p.name}`);
    setTimeout(applyChange, 700);
  };
  const portal = async () => {
    const r = await run(() => store.openBillingPortal(hereAt(PLAN_ROUTE)));
    if (r && r.url) location.href = r.url;
  };

  return (
    <div className="stack plan-page" data-testid="plan-panel">
      <section className="card pad plan-now">
        <div>
          <div className="eyebrow-s">Your plan</div>
          <h2 className="plan-name">{mine?.name ?? studio.plan?.name ?? 'No plan yet'}</h2>
          <div className="plan-price">{mine ? <>{money(mine.priceCents)} <span>a month</span></> : null}</div>
        </div>
        <div className="plan-meta">
          {statusChip(i, state.trialDaysLeft)}
          {i.status === 'trialing' && i.trialEndsAt && !i.comped && <p className="small muted">{state.trialDaysLeft === 0 ? 'Choose a plan to keep going.' : `Your trial runs to ${dayLong(i.trialEndsAt)}. You won’t be charged until then.`}</p>}
          {i.status === 'past_due' && <p className="small muted">The last payment didn’t go through. Update your card in billing and we’ll pick it up again.</p>}
          {i.cancelAtPeriodEnd && i.currentPeriodEnd && <p className="small muted">Your plan ends on {dayLong(i.currentPeriodEnd)}.</p>}
          {!i.cancelAtPeriodEnd && i.currentPeriodEnd && i.status === 'active' && <p className="small muted">Next payment {dayLong(i.currentPeriodEnd)}.</p>}
          <div className="row">
            {i.hasSubscription && <button className="btn ghost" onClick={portal} disabled={busy}>Manage billing</button>}
            <a className="btn ghost" href="#plan-compare" onClick={(e) => { e.preventDefault(); document.getElementById('plan-compare')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}>Change plan</a>
          </div>
        </div>
      </section>

      <section className="card pad" id="plan-compare">
        <h3 style={{ marginBottom: 4 }}>What each plan includes</h3>
        <p className="small muted" style={{ marginBottom: 14 }}>Bulk email to all your clients is in every plan. No platform fee on your card payments.</p>
        {plans.loading && !plans.data ? <Loading /> : (
          <div className="plan-grid" style={{ ['--cols' as string]: list.length }}>
            <div className="pg-head pg-corner" />
            {list.map((p) => (
              <div key={p.id} className={p.id === i.planId ? 'pg-head on' : 'pg-head'}>
                <strong>{p.name}</strong>
                <span className="plan-price sm">{money(p.priceCents)}<span> a month</span></span>
                {p.id === i.planId
                  ? <span className="chip">Your plan</span>
                  : <button className="btn sm" onClick={() => choose(p)} disabled={busy}>{i.status === 'trialing' || !i.hasSubscription ? `Choose ${p.name}` : p.priceCents > (mine?.priceCents ?? 0) ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}</button>}
              </div>
            ))}
            {rows.map((r) => (
              <React.Fragment key={r.key}>
                <div className="pg-row">{r.label}</div>
                {list.map((p) => (
                  <div key={p.id + r.key} className={p.id === i.planId ? 'pg-cell on' : 'pg-cell'}>
                    {p.features.includes(r.key) || r.key === 'core' ? <><Icon name="check" size={18} /><span className="sr-only">Included</span></> : <span className="pg-no" aria-label="Not included">–</span>}
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
