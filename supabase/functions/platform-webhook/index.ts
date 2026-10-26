// Stripe -> database, for PLATFORM subscriptions (what studios pay Pete). Deploy with --no-verify-jwt; every request is checked
// with PLATFORM_BILLING_WEBHOOK_SECRET (a different secret from STRIPE_WEBHOOK_SECRET / STRIPE_CONNECT_WEBHOOK_SECRET, which belong to
// the studios' own client payments in stripe-webhook). In Stripe: Developers -> Webhooks -> Add endpoint on the PLATFORM account,
// "Events on your account", pointing here. Events to tick:
//   checkout.session.completed            a studio finished Checkout for a plan
//   customer.subscription.created / .updated / .deleted
//   invoice.paid, invoice.payment_failed  keep the status right when a renewal succeeds or fails
// Each one ends in public.billing_apply(), which sets the studio's plan_id and billing_status (trialing, active, past_due, cancelled).
// A studio whose payment fails is past_due (banner, then read-only for staff after the grace period); paying again makes it active.
import { adminClient, type Db, must } from '../_shared/db.ts';
import { env, json, serve } from '../_shared/http.ts';
import { applySubscription, platformBillingOn, platformStripe, studioOfSubscription } from '../_shared/platformBilling.ts';
import { type StripeObject, verifyStripeSignature } from '../_shared/stripe.ts';

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null);

serve(async (req) => {
  if (!platformBillingOn()) return json({ received: true, ignored: 'single-studio deployment' });
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get('Stripe-Signature'), env('PLATFORM_BILLING_WEBHOOK_SECRET')))) {
    return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);
  }
  const event = JSON.parse(raw) as StripeObject;
  const admin = adminClient();

  // Stripe can deliver the same event more than once.
  const seen = must(await admin.from('stripe_events').select('id, processed_at').eq('id', event.id).maybeSingle());
  if (seen?.processed_at) return json({ received: true, duplicate: true });
  if (!seen) must(await admin.from('stripe_events').insert({ id: event.id, type: event.type }));

  try {
    await handle(admin, event);
    must(await admin.from('stripe_events').update({ processed_at: new Date().toISOString(), error: null }).eq('id', event.id));
    return json({ received: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('platform webhook failed', event.type, event.id, msg);
    await admin.from('stripe_events').update({ error: msg.slice(0, 500) }).eq('id', event.id);
    return json({ code: 'ERROR', message: msg }, 500);   // Stripe retries with backoff
  }
});

/** Fetch the subscription fresh (our pinned API version, current status) and apply it to its studio. Not ours = ignored. */
async function sync(admin: Db, subId: string | null, hintPlan?: string | null): Promise<void> {
  if (!subId) return;
  const sub = await platformStripe('GET', `subscriptions/${subId}`);
  const studioId = await studioOfSubscription(admin, sub);
  if (!studioId) { console.warn('platform webhook: subscription is not one of ours, ignored', subId); return; }
  await applySubscription(admin, studioId, sub, hintPlan);
}

async function handle(admin: Db, event: StripeObject): Promise<void> {
  const o = event.data?.object as StripeObject;
  switch (event.type) {
    case 'checkout.session.completed':
      if (o.metadata?.kind !== 'platform_plan' || o.mode !== 'subscription') return;
      return sync(admin, idOf(o.subscription), o.metadata.plan_id);

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const studioId = await studioOfSubscription(admin, o);
      if (!studioId) { console.warn('platform webhook: subscription is not one of ours, ignored', o.id); return; }
      await applySubscription(admin, studioId, o);
      return;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed':
      return sync(admin, idOf(o.subscription) ?? idOf(o.parent?.subscription_details?.subscription));

    default:
      return;
  }
}
