// POST { kind: 'appointment' | 'pack' | 'event', booking?, packId?, eventId?, returnUrl, cancelUrl?, studioId }  (signed-in client)  ->  { url }
// Appointments feature (ROADMAP B1). Holds the slot / workshop place for 30 minutes (appointments_hold_order, run AS THE CLIENT so
// all the booking rules apply), then starts a Stripe Checkout Session for it. Nothing is booked here: the
// appointments-stripe-webhook completes the order when Stripe confirms the payment (appointments_complete_order).
// A separate function from create-checkout because that one only sells core products (and the core is not ours to change).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { adminClient, must } from '../_shared/db.ts';
import { feeCents, payAs } from '../_shared/connect.ts';
import { env, HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.');
  const studio = String(body.studioId ?? req.headers.get('x-studio') ?? '');
  // The client's own session, for the studio the app is bound to (the x-studio header scopes every RPC).
  const user = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth, ...(studio ? { 'x-studio': studio } : {}) } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const kind = String(body.kind ?? '');
  const booking = (body.booking && typeof body.booking === 'object' ? body.booking : {}) as Record<string, unknown>;
  const order = must(await user.rpc('appointments_hold_order', {
    p_kind: kind,
    p_type_id: booking.typeId ?? null, p_staff_id: booking.staffId ?? null, p_starts_at: booking.startsAt ?? null,
    p_people: booking.people ?? 1, p_note: booking.note ?? null,
    p_pack_id: body.packId ?? null,
    p_event_id: body.eventId ?? null,
  })) as { orderId: string; clientId: string; studioId: string; kind: string; title: string; amountCents: number; currency: string; studioName: string };

  const admin = adminClient();
  try {
    const pay = await payAs(admin, order.studioId);
    const client = must(await admin.from('clients').select('id, email, first_name, last_name, phone').eq('id', order.clientId).single());
    let customerId: string | undefined = must(await admin.from('stripe_customers').select('stripe_customer_id').eq('client_id', order.clientId).maybeSingle())?.stripe_customer_id;
    if (!customerId) {
      const cust = await stripe('POST', 'customers', {
        email: client.email, name: `${client.first_name} ${client.last_name}`.trim(), phone: client.phone ?? undefined,
        metadata: { client_id: order.clientId },
      }, `customer-${order.clientId}`, pay.account);
      customerId = cust.id as string;
      must(await admin.from('stripe_customers').upsert({ client_id: order.clientId, stripe_customer_id: customerId }));
    }

    const successUrl = safeReturnUrl(body.returnUrl);
    const cancelUrl = safeReturnUrl(body.cancelUrl ?? successUrl.replace(/([?&])paid=[^&#]*/, '$1cancelled=1'));
    // No client_id / product_id in the metadata on purpose: the core stripe-webhook ignores sessions without them.
    const metadata = { appointments_order_id: order.orderId, studio_id: order.studioId, kind: order.kind };
    const session = await stripe('POST', 'checkout/sessions', {
      mode: 'payment',
      customer: customerId,
      client_reference_id: order.clientId,
      line_items: [{
        quantity: 1,
        price_data: { currency: order.currency || 'aud', unit_amount: order.amountCents, product_data: { name: `${order.studioName}: ${order.title}` } },
      }],
      metadata,
      payment_intent_data: { metadata, description: order.title, application_fee_amount: feeCents(pay, order.amountCents) },
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Stripe's minimum; the hold in the database lasts the same 30 minutes.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60 + 30,
    }, `appointments-order-${order.orderId}`, pay.account);
    must(await admin.rpc('appointments_attach_checkout', { p_order_id: order.orderId, p_session_id: session.id }));
    return json({ url: session.url });
  } catch (e) {
    // Couldn't get to Stripe: let the slot go straight away rather than holding it for 30 minutes.
    await admin.rpc('appointments_expire_order', { p_order_id: order.orderId });
    throw e;
  }
});
