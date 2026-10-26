// Platform billing: what a studio pays Pete for its plan. This runs on the PLATFORM's own Stripe account, never on a studio's
// connected account (that's Stripe Connect, _shared/connect.ts, for the studio's own clients). Separate settings on purpose:
//   PLATFORM_STRIPE_SECRET_KEY        the platform's key (falls back to STRIPE_SECRET_KEY only in Connect mode, where that IS the platform key)
//   PLATFORM_BILLING_WEBHOOK_SECRET   signing secret of the "Events on your account" endpoint for platform-webhook
// Off for a single-studio deployment (STUDIO_SLUG), like Snowy's own: nothing to pay there.
import { type Db, must } from './db.ts';
import { connectMode } from './connect.ts';
import { env, HttpError } from './http.ts';
import { fromUnix, stripe, type StripeObject } from './stripe.ts';

export function platformBillingOn(): boolean {
  return !(Deno.env.get('STUDIO_SLUG') ?? '').trim();
}

export function platformKey(): string {
  const k = Deno.env.get('PLATFORM_STRIPE_SECRET_KEY');
  if (k) return k;
  if (connectMode()) return env('STRIPE_SECRET_KEY');
  throw new HttpError(500, 'CONFIG', 'Server setting PLATFORM_STRIPE_SECRET_KEY is missing.');
}

export const platformStripe = (method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<StripeObject> =>
  stripe(method, path, params, idempotencyKey, undefined, platformKey());

export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';

/** Stripe subscription status -> ours. null = not a state we act on yet (incomplete: the first payment hasn't happened). */
export function mapStatus(s: unknown): BillingStatus | null {
  switch (s) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due': case 'unpaid': return 'past_due';
    case 'canceled': case 'incomplete_expired': return 'cancelled';
    default: return null;
  }
}

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null);

/** Which studio does this subscription belong to? Its metadata first, else the ids we stored. null if it isn't ours. */
export async function studioOfSubscription(admin: Db, sub: StripeObject): Promise<string | null> {
  const meta = sub.metadata?.studio_id;
  if (typeof meta === 'string' && meta) {
    const ok = must(await admin.from('studios').select('id').eq('id', meta).maybeSingle());
    return ok ? meta : null;
  }
  const bySub = must(await admin.from('studio_billing').select('studio_id').eq('stripe_subscription_id', sub.id).maybeSingle()) as { studio_id: string } | null;
  if (bySub) return bySub.studio_id;
  const cust = idOf(sub.customer);
  const byCust = cust ? must(await admin.from('studio_billing').select('studio_id').eq('stripe_customer_id', cust).maybeSingle()) as { studio_id: string } | null : null;
  return byCust?.studio_id ?? null;
}

/** The plan row a subscription is for: by the Stripe price on its first item, else the plan id we put in its metadata. */
export async function planOfSubscription(admin: Db, sub: StripeObject, hint?: string | null): Promise<string | null> {
  const price = sub.items?.data?.[0]?.price?.id;
  if (price) {
    const p = must(await admin.from('plans').select('id').eq('stripe_price_id', price).maybeSingle()) as { id: string } | null;
    if (p) return p.id;
  }
  const meta = hint ?? sub.metadata?.plan_id;
  return typeof meta === 'string' && meta ? meta : null;
}

/** Write what Stripe says about a subscription onto the studio (plan, status, trial, renewal), through billing_apply. */
export async function applySubscription(admin: Db, studioId: string, sub: StripeObject, planHint?: string | null): Promise<BillingStatus | null> {
  const status = mapStatus(sub.status);
  if (!status) return null;
  must(await admin.rpc('billing_apply', {
    p_studio: studioId, p_plan: await planOfSubscription(admin, sub, planHint), p_status: status, p_customer: idOf(sub.customer),
    p_subscription: sub.id, p_period_end: fromUnix(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end),
    p_cancel_at_period_end: !!sub.cancel_at_period_end, p_trial_end: fromUnix(sub.trial_end),
  }));
  return status;
}
