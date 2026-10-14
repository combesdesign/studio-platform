// Stripe -> database. Deploy with --no-verify-jwt (Stripe doesn't send a Supabase login);
// every request is checked with the webhook signing secret instead.
//
// Events (tick these when creating the endpoint in Stripe):
//   checkout.session.completed, checkout.session.async_payment_succeeded -> create pass + sale (idempotent)
//   invoice.paid                     -> weekly membership renewal: extend next_billing_at + record sale
//   customer.subscription.deleted    -> membership ended: pass cancelled
//   charge.refunded                  -> record refund on the sale
//   invoice.payment_failed           -> logged (Stripe retries and emails the client, if turned on)
import { adminClient, type Db, must } from '../_shared/db.ts';
import { env, json, serve } from '../_shared/http.ts';
import { fromUnix, stripe, type StripeObject, verifyStripeSignature } from '../_shared/stripe.ts';

serve(async (req) => {
  const raw = await req.text();
  const ok = await verifyStripeSignature(raw, req.headers.get('Stripe-Signature'), env('STRIPE_WEBHOOK_SECRET'));
  if (!ok) return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);

  const event = JSON.parse(raw) as StripeObject;
  const admin = adminClient();

  // Idempotency: Stripe can deliver the same event more than once.
  const seen = must(await admin.from('stripe_events').select('id, processed_at').eq('id', event.id).maybeSingle());
  if (seen?.processed_at) return json({ received: true, duplicate: true });
  if (!seen) must(await admin.from('stripe_events').insert({ id: event.id, type: event.type }));

  try {
    await handle(admin, event);
    must(await admin.from('stripe_events').update({ processed_at: new Date().toISOString(), error: null }).eq('id', event.id));
    return json({ received: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('webhook failed', event.type, event.id, msg);
    await admin.from('stripe_events').update({ error: msg.slice(0, 500) }).eq('id', event.id);
    // 500 -> Stripe retries with backoff for up to 3 days.
    return json({ code: 'ERROR', message: msg }, 500);
  }
});

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null);

async function handle(admin: Db, event: StripeObject): Promise<void> {
  const o = event.data?.object as StripeObject;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return; // async methods: wait
      const clientId = o.metadata?.client_id ?? o.client_reference_id;
      const productId = o.metadata?.product_id;
      if (!clientId || !productId) { console.warn('checkout without our metadata', o.id); return; }

      if (idOf(o.customer)) {
        await admin.from('stripe_customers').upsert({ client_id: clientId, stripe_customer_id: idOf(o.customer) });
      }

      if (o.mode === 'subscription') {
        const subId = idOf(o.subscription);
        const invoiceId = idOf(o.invoice);
        let nextBilling: string | null = null;
        let paymentIntent: string | null = null;
        if (subId) {
          const sub = await stripe('GET', `subscriptions/${subId}`);
          nextBilling = fromUnix(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
        }
        if (invoiceId) {
          const inv = await stripe('GET', `invoices/${invoiceId}`);
          paymentIntent = idOf(inv.payment_intent);
        }
        must(await admin.rpc('create_pass_from_purchase', {
          p_client_id: clientId, p_product_id: productId, p_amount_cents: o.amount_total ?? 0, p_method: 'card_online',
          p_stripe_checkout_session_id: o.id, p_stripe_payment_intent_id: paymentIntent, p_stripe_invoice_id: invoiceId,
          p_stripe_subscription_id: subId, p_next_billing_at: nextBilling,
        }));
      } else {
        must(await admin.rpc('create_pass_from_purchase', {
          p_client_id: clientId, p_product_id: productId, p_amount_cents: o.amount_total ?? 0, p_method: 'card_online',
          p_stripe_checkout_session_id: o.id, p_stripe_payment_intent_id: idOf(o.payment_intent),
        }));
      }
      return;
    }

    case 'invoice.paid': {
      // Re-fetch with our pinned API version so the shape is predictable.
      const inv = await stripe('GET', `invoices/${o.id}`);
      const subId = idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription);
      if (!subId) return; // not a membership
      if (inv.billing_reason === 'subscription_create') return; // first payment: handled by checkout.session.completed
      const periodEnd = inv.lines?.data?.[0]?.period?.end ?? inv.period_end;
      must(await admin.rpc('record_membership_payment', {
        p_stripe_subscription_id: subId, p_stripe_invoice_id: inv.id, p_amount_cents: inv.amount_paid ?? 0,
        p_period_end: fromUnix(periodEnd), p_payment_intent_id: idOf(inv.payment_intent),
      }));
      return;
    }

    case 'customer.subscription.deleted': {
      must(await admin.rpc('end_membership_subscription', { p_stripe_subscription_id: o.id }));
      return;
    }

    case 'charge.refunded': {
      const pi = idOf(o.payment_intent);
      if (pi) must(await admin.rpc('record_stripe_refund', { p_payment_intent_id: pi, p_refunded_cents: o.amount_refunded ?? 0 }));
      return;
    }

    case 'invoice.payment_failed':
      console.warn('membership payment failed', o.id, idOf(o.customer));
      return;

    default:
      return; // ignore everything else
  }
}
