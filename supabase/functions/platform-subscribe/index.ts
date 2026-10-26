// POST { studioId?, planId, returnUrl }  (signed-in studio OWNER)  ->  { url }  or  { changed: true }
// A studio owner starts, or changes, their plan. This is the platform's own subscription (what the studio pays Pete) on the
// PLATFORM's Stripe account, not Stripe Connect: see _shared/platformBilling.ts.
//   no subscription yet  -> a Stripe Checkout session (mode subscription). If the studio still has 2+ days of free trial left,
//                           the trial carries over (Checkout's trial_end), so the first charge is the day the trial ends.
//   already subscribed   -> the subscription's price is swapped in place (prorated); nothing to open.
// The plan, status and renewal date are written by platform-webhook (and straight away here for an in-place change).
// Plans and their Stripe price ids are rows in the `plans` table, edited in the platform admin.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { applySubscription, platformBillingOn, platformStripe } from '../_shared/platformBilling.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const me = await whoami(userClient(req, String(body.studioId ?? '')));
  if (me.kind !== 'staff' || me.role !== 'owner' || !me.staff_id) throw new HttpError(403, 'NOT_ALLOWED', 'Only the studio owner can change the plan.');
  if (!platformBillingOn()) throw new HttpError(409, 'BILLING_OFF', 'This studio has its own deployment, so there’s no plan to pay for.');

  const admin = adminClient();
  const staff = must(await admin.from('staff').select('studio_id').eq('id', me.staff_id).single()) as { studio_id: string };
  const studio = must(await admin.from('studios').select('id, name, email, billing_status, billing_comped, trial_ends_at').eq('id', staff.studio_id).single()) as
    { id: string; name: string; email: string; billing_status: string | null; billing_comped: boolean; trial_ends_at: string | null };
  const plan = must(await admin.from('plans').select('id, name, stripe_price_id, active').eq('id', String(body.planId ?? '')).maybeSingle()) as
    { id: string; name: string; stripe_price_id: string | null; active: boolean } | null;
  if (!plan || !plan.active) throw new HttpError(404, 'NOT_FOUND', 'That plan isn’t available.');
  if (!plan.stripe_price_id) throw new HttpError(409, 'PLAN_NOT_ON_SALE', `${plan.name} isn’t open for sign up online yet. Please get in touch and we’ll sort it out.`);

  const billing = must(await admin.from('studio_billing').select('stripe_customer_id, stripe_subscription_id').eq('studio_id', studio.id).maybeSingle()) as
    { stripe_customer_id: string | null; stripe_subscription_id: string | null } | null;

  // Already subscribed: swap the price on the existing subscription.
  if (billing?.stripe_subscription_id && studio.billing_status !== 'cancelled') {
    const sub = await platformStripe('GET', `subscriptions/${billing.stripe_subscription_id}`);
    const item = sub.items?.data?.[0];
    if (sub.status !== 'canceled' && item) {
      const updated = await platformStripe('POST', `subscriptions/${sub.id}`, {
        items: [{ id: item.id, price: plan.stripe_price_id }], proration_behavior: 'create_prorations', cancel_at_period_end: false,
        metadata: { studio_id: studio.id, plan_id: plan.id },
      });
      await applySubscription(admin, studio.id, updated, plan.id);
      return json({ changed: true });
    }
  }

  // New subscription: make sure the studio has a Stripe customer on the platform account, then send them to Checkout.
  let customer = billing?.stripe_customer_id ?? null;
  if (!customer) {
    const c = await platformStripe('POST', 'customers', { email: studio.email || undefined, name: studio.name, metadata: { studio_id: studio.id } }, `platform-customer-${studio.id}`);
    customer = String(c.id);
    must(await admin.rpc('billing_save_customer', { p_studio: studio.id, p_customer: customer }));
  }
  const returnUrl = safeReturnUrl(body.returnUrl);
  const trialEnd = studio.billing_status === 'trialing' && !studio.billing_comped && studio.trial_ends_at ? Math.floor(Date.parse(studio.trial_ends_at) / 1000) : 0;
  const meta = { kind: 'platform_plan', studio_id: studio.id, plan_id: plan.id };
  const session = await platformStripe('POST', 'checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: studio.id, payment_method_collection: 'always', allow_promotion_codes: true,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }], success_url: returnUrl, cancel_url: returnUrl, metadata: meta,
    // Checkout needs a trial end at least 48 hours away; a shorter one just starts billing now.
    subscription_data: { metadata: meta, ...(trialEnd && trialEnd - Date.now() / 1000 > 2 * 86400 ? { trial_end: trialEnd } : {}) },
  });
  return json({ url: session.url });
});
