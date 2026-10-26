/**
 * Platform plans and gating. Plans are DATA (the `plans` table / the demo's plans), edited by Pete in the admin; this file holds
 * only the pure rules around them:
 *
 *   hasFeature(studio, key)   is this feature on for the studio's plan?  Same helper in the client app, the studio app and the data
 *                             layer (gateFeatures hides a locked feature's store). The SQL twin is app.studio_has_feature(studio, key).
 *   billingState(studio, ...) trial days left, past due banner, and when staff go read-only
 *
 * The single-studio build (STUDIO_SLUG, i.e. Snowy) has everything on and never goes read-only.
 */
import type { BillingStatus, Plan, PlatformBillingSettings, Studio, StudioPlan } from './types';

declare const __STUDIO_SLUG__: string;

/** Is this a single-studio build? Read at call time so tests can flip it. */
export function singleStudioBuild(): boolean {
  const g = globalThis as { __STUDIO_SLUG__?: unknown };
  if (typeof g.__STUDIO_SLUG__ === 'string') return g.__STUDIO_SLUG__ !== '';
  return typeof __STUDIO_SLUG__ === 'string' && __STUDIO_SLUG__ !== '';
}

/** Every feature key a plan can switch on. Editing a plan in the admin ticks these. 'core' is always on and isn't listed. */
export const FEATURE_CATALOG: { key: string; label: string; blurb: string }[] = [
  { key: 'kiosk', label: 'Check-in kiosk', blurb: 'A tablet at the door for clients to check themselves in.' },
  { key: 'reviews', label: 'Reviews', blurb: 'Ask clients how class was and keep the feedback.' },
  { key: 'marketing', label: 'Bulk email and messages', blurb: 'Email every client, segments, automations and the inbox.' },
  { key: 'support', label: 'Help and support', blurb: 'Help centre and a direct line to us.' },
  { key: 'family', label: 'Family accounts', blurb: 'Parents booking for kids and dependants.' },
  { key: 'appointments', label: 'Appointments and workshops', blurb: 'Private sessions, workshops, courses and events.' },
  { key: 'ondemand', label: 'On-demand videos', blurb: 'A video library for members.' },
  { key: 'commerce', label: 'Gift cards, promos and retail', blurb: 'Gift cards, promo codes, referrals and stock.' },
  { key: 'payroll', label: 'Payroll and cover', blurb: 'Pay rules, timesheets, clock in and class cover.' },
  { key: 'integrations', label: 'ClassPass, Gympass and Xero', blurb: 'Partner bookings and accounting export.' },
  { key: 'branded_app', label: 'Your own branded app', blurb: 'The studio’s own app in the App Store and Google Play.' },
  { key: 'custom_domain', label: 'Custom domain', blurb: 'Open the app at the studio’s own web address.' },
  { key: 'multi_location', label: 'Multiple locations', blurb: 'More than one location under one studio.' },
];
const LABELS = new Map(FEATURE_CATALOG.map((f) => [f.key, f.label]));
export const featureLabel = (key: string): string => LABELS.get(key) ?? key;

/** What hasFeature needs from a studio. */
export type PlanSubject = { plan?: Pick<StudioPlan, 'features'> | undefined } | null | undefined;

/**
 * Is `key` switched on for this studio? No key or 'core' = always. No studio yet, or a studio that isn't on a plan = everything on
 * (nothing is locked until Pete puts a studio on a plan). The single-studio build = always everything on.
 */
export function hasFeature(studio: PlanSubject, key?: string | null): boolean {
  if (!key || key === 'core') return true;
  if (singleStudioBuild()) return true;
  if (!studio || !studio.plan) return true;
  if (!FEATURE_CATALOG.some((f) => f.key === key)) return true;   // only the features plans sell are gated (a module nobody has put on a plan stays on)
  return studio.plan.features.includes(key);
}

/**
 * Wrap a store's `features` object so a feature the studio's plan lacks isn't there (store.features.payroll is undefined),
 * checked on every read so a plan change takes effect without rebuilding the store.
 */
export function gateFeatures<T extends object>(raw: T, studio: () => PlanSubject): T {
  return new Proxy(raw, {
    get: (t, k) => (typeof k === 'string' && !hasFeature(studio(), k) ? undefined : Reflect.get(t, k)),
    has: (t, k) => (typeof k === 'string' && !hasFeature(studio(), k) ? false : Reflect.has(t, k)),
    ownKeys: (t) => Reflect.ownKeys(t).filter((k) => typeof k !== 'string' || hasFeature(studio(), k)),
    getOwnPropertyDescriptor: (t, k) => (typeof k === 'string' && !hasFeature(studio(), k) ? undefined : Reflect.getOwnPropertyDescriptor(t, k)),
  });
}

/** The cheapest active plan that includes `key` and costs more than the studio's current plan: "Available on Studio Plus". */
export function upgradePlanFor(plans: Plan[], studio: PlanSubject & { plan?: StudioPlan | undefined }, key: string): Plan | undefined {
  const cur = studio?.plan?.priceCents ?? -1;
  return plans.filter((p) => p.active && p.features.includes(key) && p.priceCents > cur).sort((a, b) => a.priceCents - b.priceCents)[0]
    ?? plans.filter((p) => p.active && p.features.includes(key)).sort((a, b) => a.priceCents - b.priceCents)[0];
}

export interface BillingState {
  /** False when there's no billing (single-studio build, or a studio not on the platform's billing yet). */
  enabled: boolean;
  status: BillingStatus | null;
  /** Whole days left of the trial (0 once it's over); null if not trialing. */
  trialDaysLeft: number | null;
  /** Shown to staff across the studio app: nothing, a friendly trial nudge, or a past-due / ended notice. */
  banner: 'trial' | 'trial_ended' | 'past_due' | 'cancelled' | null;
  /** Staff can look but not change anything. Clients can still book. */
  readOnly: boolean;
  /** When staff go read-only (past due and trial ended only). */
  readOnlyOn?: string;
}

const DAY = 86_400_000;

export function billingState(studio: Pick<Studio, 'billingStatus' | 'trialEndsAt' | 'pastDueSince' | 'billingComped'> | null | undefined, settings: Pick<PlatformBillingSettings, 'graceDays'>, now: Date): BillingState {
  const none: BillingState = { enabled: false, status: null, trialDaysLeft: null, banner: null, readOnly: false };
  if (singleStudioBuild() || !studio?.billingStatus) return none;
  const t = now.getTime();
  const grace = Math.max(0, Math.floor(settings.graceDays)) * DAY;
  const s = studio.billingStatus;
  if (s === 'cancelled') return { enabled: true, status: s, trialDaysLeft: null, banner: 'cancelled', readOnly: true };
  if (s === 'past_due') {
    const since = studio.pastDueSince ? Date.parse(studio.pastDueSince) : t;
    const on = since + grace;
    return { enabled: true, status: s, trialDaysLeft: null, banner: 'past_due', readOnly: t >= on, readOnlyOn: new Date(on).toISOString() };
  }
  if (s === 'trialing') {
    const end = studio.trialEndsAt ? Date.parse(studio.trialEndsAt) : Number.POSITIVE_INFINITY;
    if (end < t) {
      const on = end + grace;
      return { enabled: true, status: s, trialDaysLeft: 0, banner: 'trial_ended', readOnly: t >= on, readOnlyOn: new Date(on).toISOString() };
    }
    const left = Number.isFinite(end) ? Math.max(0, Math.ceil((end - t) / DAY)) : null;
    return { enabled: true, status: s, trialDaysLeft: left, banner: left !== null && left <= 7 && !studio.billingComped ? 'trial' : null, readOnly: false };
  }
  return { enabled: true, status: s, trialDaysLeft: null, banner: null, readOnly: false };
}

/** Monthly recurring revenue: active (and past due) studios on a paid plan, not comped, not still on a free trial. */
export function mrrCents(studios: Pick<Studio, 'plan' | 'billingStatus' | 'billingComped'>[]): number {
  let sum = 0;
  for (const s of studios) {
    if (!s.plan || s.billingComped) continue;
    if (s.billingStatus === 'active' || s.billingStatus === 'past_due') sum += s.plan.priceCents;
  }
  return sum;
}

export const planOf = (p: Plan): StudioPlan => ({ id: p.id, name: p.name, priceCents: p.priceCents, features: [...p.features] });

/** The three draft plans (Pete can change every part of them in the admin). Matches the rows seeded by 0012_platform_billing.sql. */
const STUDIO_FEATURES = ['core', 'kiosk', 'reviews', 'marketing', 'support', 'family'];
const PLUS_FEATURES = [...STUDIO_FEATURES, 'appointments', 'ondemand', 'commerce', 'payroll', 'integrations'];
const SIGNATURE_FEATURES = [...PLUS_FEATURES, 'branded_app', 'custom_domain', 'multi_location'];
export const DRAFT_PLANS: Plan[] = [
  { id: 'plan_studio', key: 'studio', name: 'Studio', priceCents: 9900, features: STUDIO_FEATURES, sortOrder: 10, active: true },
  { id: 'plan_studio_plus', key: 'studio_plus', name: 'Studio Plus', priceCents: 17900, features: PLUS_FEATURES, sortOrder: 20, active: true },
  { id: 'plan_signature', key: 'signature', name: 'Signature', priceCents: 29900, features: SIGNATURE_FEATURES, sortOrder: 30, active: true },
];
export const DEFAULT_BILLING_SETTINGS: PlatformBillingSettings = { trialDays: 14, graceDays: 14 };
