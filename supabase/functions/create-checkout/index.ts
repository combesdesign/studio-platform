// POST { productId, returnUrl, cancelUrl?, clientId? }  (signed-in client; clientId = one of their dependants)  ->  { url }
// Starts a Stripe Checkout Session. Packs / intro / drop-in / retail = one-off payment.
// Memberships = weekly subscription. Apple Pay / Google Pay show up automatically in Checkout.
// The pass is created by stripe-webhook when Stripe confirms payment (never here).
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { feeCents, feePercent, payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const user = userClient(req, String(body.studioId ?? ''));
  const me = await whoami(user);
  if (me.kind !== 'client' || !me.client_id) throw new HttpError(403, 'NOT_ALLOWED', 'Online checkout is for client accounts. Use the till in the studio app.');
  const payerId = me.client_id;
  // Family accounts: a parent can buy a pass for a dependant (the pass lands on the dependant). Anyone else's id is refused.
  let clientId = payerId;
  const forId = String(body.clientId ?? '');
  if (forId && forId !== payerId) {
    const dep = must(await adminClient().from('clients').select('id').eq('id', forId).eq('guardian_client_id', payerId).eq('archived', false).maybeSingle());
    if (!dep) throw new HttpError(403, 'NOT_ALLOWED', 'You can only buy for yourself and your family.');
    clientId = forId;
  }

  const admin = adminClient();
  const product = must(await admin.from('products').select('*').eq('id', String(body.productId ?? '')).maybeSingle());
  if (!product || !product.active) throw new HttpError(404, 'NOT_FOUND', 'That product isn’t available.');
  if (product.price_cents <= 0) throw new HttpError(400, 'INVALID', 'That product can’t be bought online.');
  // Connect mode: paid into the studio's own Stripe account (a friendly 409 if it hasn't connected). Single mode: our own keys, as ever.
  const pay = await payAs(admin, product.studio_id);

  if (product.kind === 'intro' || product.new_clients_only) {
    const ok = must(await user.rpc('is_intro_eligible', { p_client_id: clientId }));
    if (!ok) throw new HttpError(409, 'INTRO_NOT_ELIGIBLE', 'The intro offer is for new clients only.');
  }

  const client = must(await admin.from('clients').select('id, email, first_name, last_name, phone').eq('id', payerId).single());   // the parent pays
  const clientStudio = must(await admin.from('clients').select('studio_id').eq('id', clientId).single()) as { studio_id?: string };
  if (clientStudio?.studio_id && product.studio_id && clientStudio.studio_id !== product.studio_id) throw new HttpError(404, 'NOT_FOUND', 'That product isn’t available.');
  const studioName: string = clientStudio?.studio_id
    ? ((must(await admin.from('studios').select('name').eq('id', clientStudio.studio_id).maybeSingle()) as { name?: string } | null)?.name ?? 'Studio')
    : 'Studio';

  // One Stripe customer per client (so cards are remembered and the billing portal works).
  let customerId: string | undefined = must(await admin.from('stripe_customers').select('stripe_customer_id').eq('client_id', payerId).maybeSingle())?.stripe_customer_id;
  if (!customerId) {
    const cust = await stripe('POST', 'customers', {
      email: client.email, name: `${client.first_name} ${client.last_name}`.trim(), phone: client.phone ?? undefined,
      metadata: { client_id: payerId },
    }, `customer-${payerId}`, pay.account);
    customerId = cust.id as string;
    must(await admin.from('stripe_customers').upsert({ client_id: payerId, stripe_customer_id: customerId }));
  }

  const successUrl = safeReturnUrl(body.returnUrl);
  const cancelUrl = safeReturnUrl(body.cancelUrl ?? `${successUrl.split('#')[0]}#/passes`);
  const isMembership = product.kind === 'membership';
  const metadata = { client_id: clientId, product_id: product.id, kind: product.kind };

  // A saved Stripe price belongs to one Stripe account, so on a connected account we always send the price itself.
  const lineItem = product.stripe_price_id && !pay.account
    ? { price: product.stripe_price_id, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: 'aud',
          unit_amount: product.price_cents, // GST-inclusive, as advertised
          product_data: { name: `${studioName}: ${product.name}`, metadata: { product_id: product.id } },
          ...(isMembership ? { recurring: { interval: product.billing_interval === 'month' ? 'month' : 'week' } } : {}),
        },
      };

  const session = await stripe('POST', 'checkout/sessions', {
    mode: isMembership ? 'subscription' : 'payment',
    customer: customerId,
    client_reference_id: clientId,
    line_items: [lineItem],
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: 'true',
    ...(isMembership
      ? { subscription_data: { metadata, description: product.name, application_fee_percent: feePercent(pay) } }
      // No receipt_email: the app sends its own receipt (with the ABN and GST line), so clients don't get two.
      : { payment_intent_data: { metadata, description: product.name, application_fee_amount: feeCents(pay, product.price_cents) } }),
  }, undefined, pay.account);

  return json({ url: session.url });
});
