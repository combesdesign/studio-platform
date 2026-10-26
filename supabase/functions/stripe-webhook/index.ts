// Stripe -> database. Deploy with --no-verify-jwt (Stripe doesn't send a Supabase login);
// every request is checked with the webhook signing secret instead.
//
// Events (tick these when creating the endpoint in Stripe):
//   checkout.session.completed, checkout.session.async_payment_succeeded -> create pass + sale (idempotent);
//                                    a gift card checkout (metadata.kind = 'gift_card') switches the card on instead
//   invoice.paid                     -> weekly membership renewal: extend next_billing_at + record sale
//   customer.subscription.deleted    -> membership ended: pass cancelled
//   charge.refunded                  -> record refund on the sale
//   invoice.payment_failed           -> logged (Stripe retries and emails the client, if turned on)
//   account.updated                  -> Connect only: keeps the studio's charges_enabled / payouts_enabled / details_submitted in sync
//
// Stripe Connect (STRIPE_CONNECT=1, see _shared/connect.ts): add a second endpoint in Stripe, "Events on Connected accounts",
// pointing here, with its own signing secret STRIPE_CONNECT_WEBHOOK_SECRET. Each event carries `event.account`, which maps to
// the studio (studio_stripe.stripe_account_id); every handler then only touches that studio's rows, and Stripe lookups are made
// on that account. In single-account mode (the default, and Snowy) none of this applies and behaviour is unchanged.
import { adminClient, type Db, must } from '../_shared/db.ts';
import { connectMode, studioForAccount } from '../_shared/connect.ts';
import { env, json, serve } from '../_shared/http.ts';
import { fromUnix, stripe, type StripeObject, verifyStripeSignature } from '../_shared/stripe.ts';

/** Who an event is for: in Connect mode the studio that owns event.account (and the account to call Stripe on). */
interface Ctx { studioId: string | null; account?: string }

serve(async (req) => {
  const raw = await req.text();
  const sig = req.headers.get('Stripe-Signature');
  const connect = connectMode();
  let viaConnectSecret = false;
  let ok = false;
  if (connect) {
    const cs = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET');
    if (cs) { ok = await verifyStripeSignature(raw, sig, cs); viaConnectSecret = ok; }
    const ps = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    if (!ok && ps) ok = await verifyStripeSignature(raw, sig, ps);
  } else {
    ok = await verifyStripeSignature(raw, sig, env('STRIPE_WEBHOOK_SECRET'));
  }
  if (!ok) return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);

  const event = JSON.parse(raw) as StripeObject;
  const admin = adminClient();

  // Connect: the account on the event decides the studio. Events on a connected account must be signed with the Connect secret.
  let ctx: Ctx = { studioId: null };
  if (connect) {
    if (!event.account) return json({ received: true, ignored: 'not a connected account event' });
    if (!viaConnectSecret) return json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' }, 400);
    const studioId = await studioForAccount(admin, String(event.account));
    if (!studioId) return json({ received: true, ignored: 'unknown account' });
    ctx = { studioId, account: String(event.account) };
  }

  // Idempotency: Stripe can deliver the same event more than once.
  const seen = must(await admin.from('stripe_events').select('id, processed_at').eq('id', event.id).maybeSingle());
  if (seen?.processed_at) return json({ received: true, duplicate: true });
  if (!seen) must(await admin.from('stripe_events').insert({ id: event.id, type: event.type }));

  try {
    await handle(admin, event, ctx);
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

/** Connect: is this row (found by `col` = `val`) in the event's studio? Unknown rows pass, the database call then says so as it always did. */
async function inStudio(admin: Db, ctx: Ctx, table: string, col: string, val: unknown): Promise<boolean> {
  if (!ctx.studioId || !val) return true;
  const row = must(await admin.from(table).select('studio_id').eq(col, val).maybeSingle()) as { studio_id: string } | null;
  return !row || row.studio_id === ctx.studioId;
}
const wrongStudio = (what: string, id: unknown) => console.warn(`connect event for another studio's ${what}, ignored`, id);

async function handle(admin: Db, event: StripeObject, ctx: Ctx): Promise<void> {
  const o = event.data?.object as StripeObject;
  switch (event.type) {
    case 'account.updated': {
      if (!ctx.studioId || o.id !== ctx.account) return;
      must(await admin.rpc('stripe_connect_save', {
        p_studio: ctx.studioId, p_account: ctx.account, p_charges: !!o.charges_enabled, p_payouts: !!o.payouts_enabled, p_details: !!o.details_submitted,
      }));
      return;
    }

    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return; // async methods: wait
      if (o.metadata?.kind === 'gift_card') {
        // commerce_activate_gift_card is safe to repeat: an active card (and its sale) is returned as is.
        if (!o.metadata.card_id) { console.warn('gift card checkout without a card id', o.id); return; }
        if (!(await inStudio(admin, ctx, 'commerce_gift_cards', 'id', o.metadata.card_id))) return wrongStudio('gift card', o.metadata.card_id);
        must(await admin.rpc('commerce_activate_gift_card', {
          p_card_id: o.metadata.card_id, p_payment_intent: idOf(o.payment_intent), p_checkout_session: o.id,
        }));
        return;
      }
      const clientId = o.metadata?.client_id ?? o.client_reference_id;
      const productId = o.metadata?.product_id;
      if (!clientId || !productId) { console.warn('checkout without our metadata', o.id); return; }
      if (!(await inStudio(admin, ctx, 'products', 'id', productId)) || !(await inStudio(admin, ctx, 'clients', 'id', clientId))) return wrongStudio('product or client', productId);

      if (idOf(o.customer)) {
        await admin.from('stripe_customers').upsert({ client_id: clientId, stripe_customer_id: idOf(o.customer) });
      }

      if (o.mode === 'subscription') {
        const subId = idOf(o.subscription);
        const invoiceId = idOf(o.invoice);
        let nextBilling: string | null = null;
        let paymentIntent: string | null = null;
        if (subId) {
          const sub = await stripe('GET', `subscriptions/${subId}`, {}, undefined, ctx.account);
          nextBilling = fromUnix(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
        }
        if (invoiceId) {
          const inv = await stripe('GET', `invoices/${invoiceId}`, {}, undefined, ctx.account);
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
      const inv = await stripe('GET', `invoices/${o.id}`, {}, undefined, ctx.account);
      const subId = idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription);
      if (!subId) return; // not a membership
      if (inv.billing_reason === 'subscription_create') return; // first payment: handled by checkout.session.completed
      if (!(await inStudio(admin, ctx, 'passes', 'stripe_subscription_id', subId))) return wrongStudio('membership', subId);
      const periodEnd = inv.lines?.data?.[0]?.period?.end ?? inv.period_end;
      must(await admin.rpc('record_membership_payment', {
        p_stripe_subscription_id: subId, p_stripe_invoice_id: inv.id, p_amount_cents: inv.amount_paid ?? 0,
        p_period_end: fromUnix(periodEnd), p_payment_intent_id: idOf(inv.payment_intent),
      }));
      return;
    }

    case 'customer.subscription.deleted': {
      if (!(await inStudio(admin, ctx, 'passes', 'stripe_subscription_id', o.id))) return wrongStudio('membership', o.id);
      must(await admin.rpc('end_membership_subscription', { p_stripe_subscription_id: o.id }));
      return;
    }

    case 'charge.refunded': {
      const pi = idOf(o.payment_intent);
      if (pi && !(await inStudio(admin, ctx, 'sales', 'stripe_payment_intent_id', pi))) return wrongStudio('sale', pi);
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
