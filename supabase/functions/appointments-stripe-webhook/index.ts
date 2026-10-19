// Stripe -> database for appointment / pack / workshop orders (appointments feature, ROADMAP B1).
// A second webhook endpoint in Stripe pointing here, deployed with --no-verify-jwt; signed with its own secret
// (APPOINTMENTS_STRIPE_WEBHOOK_SECRET, falling back to STRIPE_WEBHOOK_SECRET if the same endpoint secret is reused).
//
// Events (tick these when creating the endpoint):
//   checkout.session.completed, checkout.session.async_payment_succeeded -> appointments_complete_order (idempotent)
//   checkout.session.expired, checkout.session.async_payment_failed      -> appointments_expire_order (frees the held slot)
// Sessions without metadata.appointments_order_id belong to the core webhook and are ignored here.
// Refunds need nothing extra: the core webhook's charge.refunded records them on the sale by payment intent.
import { adminClient, type Db, must } from '../_shared/db.ts';
import { env, json, serve } from '../_shared/http.ts';
import { type StripeObject, verifyStripeSignature } from '../_shared/stripe.ts';

serve(async (req) => {
  const raw = await req.text();
  const secret = Deno.env.get('APPOINTMENTS_STRIPE_WEBHOOK_SECRET') || env('STRIPE_WEBHOOK_SECRET');
  const ok = await verifyStripeSignature(raw, req.headers.get('Stripe-Signature'), secret);
  if (!ok) return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);

  const event = JSON.parse(raw) as StripeObject;
  try {
    await handle(adminClient(), event);
    return json({ received: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('appointments webhook failed', event.type, event.id, msg);
    return json({ code: 'ERROR', message: msg }, 500); // Stripe retries; completing an order twice is harmless
  }
});

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null);

async function handle(admin: Db, event: StripeObject): Promise<void> {
  const o = event.data?.object as StripeObject;
  const orderId = o?.metadata?.appointments_order_id as string | undefined;
  if (!orderId) return;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return; // async methods: wait
      must(await admin.rpc('appointments_complete_order', {
        p_order_id: orderId, p_session_id: o.id, p_payment_intent_id: idOf(o.payment_intent), p_amount_cents: o.amount_total ?? null,
      }));
      return;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      must(await admin.rpc('appointments_expire_order', { p_order_id: orderId }));
      return;
    default:
      return;
  }
}
