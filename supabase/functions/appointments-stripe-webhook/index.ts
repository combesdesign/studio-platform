// Stripe -> database for appointment / pack / workshop orders (appointments feature, ROADMAP B1).
// A second webhook endpoint in Stripe pointing here, deployed with --no-verify-jwt; signed with its own secret
// (APPOINTMENTS_STRIPE_WEBHOOK_SECRET, falling back to STRIPE_WEBHOOK_SECRET if the same endpoint secret is reused).
//
// Events (tick these when creating the endpoint):
//   checkout.session.completed, checkout.session.async_payment_succeeded -> appointments_complete_order (idempotent)
//   checkout.session.expired, checkout.session.async_payment_failed      -> appointments_expire_order (frees the held slot)
// Sessions without metadata.appointments_order_id belong to the core webhook and are ignored here.
// Stripe Connect (STRIPE_CONNECT=1): add this endpoint under "Events on Connected accounts" too, signed with STRIPE_CONNECT_WEBHOOK_SECRET.
// event.account maps to the studio, and an order is only completed or released if it belongs to that studio.
// Refunds need nothing extra: the core webhook's charge.refunded records them on the sale by payment intent.
import { adminClient, type Db, must } from '../_shared/db.ts';
import { connectMode, studioForAccount } from '../_shared/connect.ts';
import { env, json, serve } from '../_shared/http.ts';
import { type StripeObject, verifyStripeSignature } from '../_shared/stripe.ts';

serve(async (req) => {
  const raw = await req.text();
  const sig = req.headers.get('Stripe-Signature');
  const connect = connectMode();
  const connectSecret = connect ? Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET') : undefined;
  const viaConnect = !!connectSecret && await verifyStripeSignature(raw, sig, connectSecret);
  const ok = viaConnect || await verifyStripeSignature(raw, sig, Deno.env.get('APPOINTMENTS_STRIPE_WEBHOOK_SECRET') || env('STRIPE_WEBHOOK_SECRET'));
  if (!ok) return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);

  const event = JSON.parse(raw) as StripeObject;
  try {
    const admin = adminClient();
    let studioId: string | null = null;
    if (connect) {
      if (!event.account) return json({ received: true, ignored: 'not a connected account event' });
      if (!viaConnect) return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);
      studioId = await studioForAccount(admin, String(event.account));
      if (!studioId) return json({ received: true, ignored: 'unknown account' });
    }
    await handle(admin, event, studioId);
    return json({ received: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('appointments webhook failed', event.type, event.id, msg);
    return json({ code: 'ERROR', message: msg }, 500); // Stripe retries; completing an order twice is harmless
  }
});

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null);

async function handle(admin: Db, event: StripeObject, studioId: string | null): Promise<void> {
  const o = event.data?.object as StripeObject;
  const orderId = o?.metadata?.appointments_order_id as string | undefined;
  if (!orderId) return;
  if (studioId) {
    const order = must(await admin.from('appointment_orders').select('studio_id').eq('id', orderId).maybeSingle()) as { studio_id: string } | null;
    if (order && order.studio_id !== studioId) { console.warn('connect event for another studio\'s order, ignored', orderId); return; }
  }
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
