// POST { cardId, studioId?, returnUrl, cancelUrl? }  (signed-in client who bought the card)  ->  { url }
// Starts a Stripe Checkout Session for a *pending* gift card (made by public.commerce_buy_gift_card).
// The card is switched on by stripe-webhook (commerce_activate_gift_card) once Stripe confirms payment, never here.
import { adminClient, must, userClient } from '../_shared/db.ts';
import { feeCents, payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const { data: who } = await userClient(req).auth.getUser();
  const uid = who?.user?.id;
  if (!uid) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.');

  const admin = adminClient();
  const card = must(await admin.from('commerce_gift_cards').select('id, studio_id, status, initial_cents, purchaser_client_id, recipient_name').eq('id', String(body.cardId ?? '')).maybeSingle());
  if (!card || (body.studioId && body.studioId !== card.studio_id)) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that gift card.');
  // Only the person who is buying it (their login must own the purchasing client row).
  const buyer = card.purchaser_client_id
    ? must(await admin.from('clients').select('id, email, first_name, last_name').eq('id', card.purchaser_client_id).eq('user_id', uid).maybeSingle())
    : null;
  if (!buyer) throw new HttpError(403, 'NOT_ALLOWED', 'That gift card isn’t yours to pay for.');
  if (card.status !== 'pending') throw new HttpError(409, 'INVALID', card.status === 'active' ? 'That gift card is already paid for.' : 'That gift card isn’t waiting for payment.');

  const studio = must(await admin.from('studios').select('id, name, currency, status').eq('id', card.studio_id).single());
  if (studio.status === 'suspended') throw new HttpError(403, 'STUDIO_CLOSED', 'This studio isn’t taking orders right now.');

  const pay = await payAs(admin, card.studio_id);

  // One Stripe customer per client, shared with create-checkout.
  let customerId: string | undefined = must(await admin.from('stripe_customers').select('stripe_customer_id').eq('client_id', buyer.id).maybeSingle())?.stripe_customer_id;
  if (!customerId) {
    const cust = await stripe('POST', 'customers', {
      email: buyer.email, name: `${buyer.first_name} ${buyer.last_name}`.trim(), metadata: { client_id: buyer.id },
    }, `customer-${buyer.id}`, pay.account);
    customerId = cust.id as string;
    must(await admin.from('stripe_customers').upsert({ client_id: buyer.id, stripe_customer_id: customerId }));
  }

  const successUrl = safeReturnUrl(body.returnUrl);
  const cancelUrl = safeReturnUrl(body.cancelUrl ?? successUrl);
  const metadata = { kind: 'gift_card', card_id: card.id, studio_id: card.studio_id, client_id: buyer.id };

  const session = await stripe('POST', 'checkout/sessions', {
    mode: 'payment',
    customer: customerId,
    client_reference_id: buyer.id,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(studio.currency || 'AUD').toLowerCase(),
        unit_amount: card.initial_cents,
        product_data: { name: `${studio.name}: gift card${card.recipient_name ? ` for ${card.recipient_name}` : ''}` },
      },
    }],
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
    payment_intent_data: { metadata, description: 'Gift card', application_fee_amount: feeCents(pay, card.initial_cents) },
  }, undefined, pay.account);

  return json({ url: session.url });
});
