// POST { action: 'start' | 'status' | 'cancel', ... }   (any staff who can use the till)
// Takes a card-present payment on a studio's Stripe Terminal smart reader, driven from the server.
//   start  { readerId, attemptId, clientId?, items: [{productId, qty}], discountCents?, note? }
//          The amount is worked out in the database from the cart (terminal_quote), never from the app. Creates a card_present
//          PaymentIntent, saves the cart against it, and tells the reader to collect (process_payment_intent). -> { paymentId, amountCents }
//   status { paymentId }  the app polls this. Looks at Stripe and records the sale once the payment has gone through. -> { state, ... }
//   cancel { paymentId }  clears the reader (cancel_action) and cancels the PaymentIntent. -> { state }
// stripe-webhook records the same sale (terminal.reader.action_succeeded, payment_intent.succeeded); terminal_record_sale makes
// sure it only ever happens once. Connect mode: calls carry the studio's Stripe-Account.
import { adminClient, must, userClient } from '../_shared/db.ts';
import { assertStudioWritable } from '../_shared/billing.ts';
import { feeCents, payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';
import { abandonTerminal, getPayment, requireStaffStudio, settleTerminal, studioReader, TERMINAL_TIMEOUT_MS } from '../_shared/terminal.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const user = userClient(req, String(body.studioId ?? ''));
  const admin = adminClient();
  const staff = await requireStaffStudio(admin, user);
  const action = String(body.action ?? '');
  const pay = await payAs(admin, staff.studioId, 'Connect your Stripe account first (Settings > Payments).');

  if (action === 'start') {
    await assertStudioWritable(admin, staff.studioId);
    const reader = await studioReader(admin, staff.studioId, String(body.readerId ?? ''));
    const attemptId = String(body.attemptId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!attemptId) throw new HttpError(400, 'INVALID', 'Missing attempt id.');
    const items = (Array.isArray(body.items) ? body.items : []).map((i) => {
      const o = i as { productId?: unknown; qty?: unknown };
      return { product_id: String(o.productId ?? ''), qty: Math.max(1, Math.floor(Number(o.qty) || 1)) };
    });
    const clientId = body.clientId ? String(body.clientId) : null;
    const discount = Math.max(0, Math.floor(Number(body.discountCents) || 0));
    // The amount comes from the cart, here, in the database. Whatever the app thinks the total is doesn't matter.
    const amount = Number(must(await user.rpc('terminal_quote', { p_client_id: clientId, p_items: items, p_discount_cents: discount })));
    if (!(amount > 0)) throw new HttpError(400, 'INVALID', 'There’s nothing to charge. Use Comp for a free sale.');
    const studio = must(await admin.from('studios').select('currency').eq('id', staff.studioId).maybeSingle()) as { currency?: string } | null;

    const intent = await stripe('POST', 'payment_intents', {
      amount, currency: String(studio?.currency || 'AUD').toLowerCase(), payment_method_types: ['card_present'], capture_method: 'automatic',
      description: 'Studio desk sale', metadata: { kind: 'pos_terminal', studio_id: staff.studioId, staff_id: staff.staffId },
      application_fee_amount: feeCents(pay, amount),
    }, `terminal-pi-${staff.studioId}-${attemptId}`, pay.account);
    const pi = String(intent.id);
    const existing = await getPayment(admin, pi);
    if (existing) return json({ paymentId: pi, amountCents: existing.amount_cents });   // the same attempt sent twice
    must(await admin.from('terminal_payments').insert({
      payment_intent_id: pi, studio_id: staff.studioId, reader_id: reader.reader_id, client_id: clientId, cart: items,
      discount_cents: discount, note: String(body.note ?? '').trim().slice(0, 400) || null, staff_id: staff.staffId, amount_cents: amount,
    }));
    try {
      await stripe('POST', `terminal/readers/${reader.reader_id}/process_payment_intent`, { payment_intent: pi }, undefined, pay.account);
    } catch (e) {
      await admin.rpc('terminal_mark', { p_payment_intent: pi, p_status: 'failed', p_failure: 'The reader didn’t respond.' });
      try { await stripe('POST', `payment_intents/${pi}/cancel`, {}, undefined, pay.account); } catch { /* it expires on its own */ }
      throw new HttpError(409, 'READER_UNAVAILABLE', 'The card reader didn’t respond. Check it is on, awake and on the wifi, then try again.');
    }
    return json({ paymentId: pi, amountCents: amount });
  }

  if (action === 'status' || action === 'cancel') {
    const pi = String(body.paymentId ?? '');
    const row = await getPayment(admin, pi);
    if (!row || row.studio_id !== staff.studioId) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that payment.');   // another studio's payment looks like it doesn't exist
    if (action === 'cancel') return json(await abandonTerminal(admin, pi, pay, 'canceled'));
    const settled = await settleTerminal(admin, pi, pay);
    if (settled?.state === 'pending' && Date.now() - new Date(row.created_at).getTime() > TERMINAL_TIMEOUT_MS) return json(await abandonTerminal(admin, pi, pay, 'timeout'));
    return json(settled);
  }

  throw new HttpError(400, 'INVALID', 'Unknown action.');
});
