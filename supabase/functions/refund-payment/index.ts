// POST { saleId, amountCents?, cancelPass?, reason? }  (owner / manager / front desk)
// Refunds an online card payment in Stripe, then records Stripe's refunded total on the sale.
// Stripe's charge.refunded webhook records the same total, so it's safe whichever lands first.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { assertStudioWritable } from '../_shared/billing.ts';
import { payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  const body = await readJson(req);
  const user = userClient(req, String(body.studioId ?? ''));
  const me = await whoami(user);
  if (me.kind !== 'staff' || !['owner', 'manager', 'front_desk'].includes(me.role ?? '')) {
    throw new HttpError(403, 'NOT_ALLOWED', 'You don’t have permission to refund.');
  }
  const admin = adminClient();
  const saleId = String(body.saleId ?? '');
  const sale = must(await admin.from('sales').select('*').eq('id', saleId).maybeSingle());
  if (!sale) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that sale.');
  if (!sale.stripe_payment_intent_id) throw new HttpError(400, 'INVALID', 'This sale wasn’t paid online.');
  // Staff refund their own studio's sales only.
  const mine = must(await admin.from('staff').select('studio_id').eq('id', me.staff_id).maybeSingle()) as { studio_id: string } | null;
  if (mine && sale.studio_id && mine.studio_id !== sale.studio_id) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that sale.');
  await assertStudioWritable(admin, sale.studio_id);   // overdue plan past the grace period: staff can't change things
  const pay = await payAs(admin, sale.studio_id, 'This studio’s Stripe account isn’t connected, so card payments can’t be refunded from here.');

  const left = sale.total_cents - (sale.refunded_cents ?? 0);
  const amount = body.amountCents === null || body.amountCents === undefined ? left : Number(body.amountCents);
  if (!(amount > 0) || amount > left) throw new HttpError(400, 'INVALID', 'That’s more than is left to refund on this sale.');

  const refund = await stripe('POST', 'refunds', {
    payment_intent: sale.stripe_payment_intent_id, amount,
    metadata: { sale_id: saleId, staff_id: me.staff_id ?? '', reason: String(body.reason ?? '').slice(0, 400) },
  }, `refund-${saleId}-${(sale.refunded_cents ?? 0)}-${amount}`, pay.account);

  // Record Stripe's running total for this payment (absolute, so it doesn't matter whether the
  // charge.refunded webhook gets there first).
  const charge = refund.charge ? await stripe('GET', `charges/${typeof refund.charge === 'string' ? refund.charge : refund.charge.id}`, {}, undefined, pay.account) : null;
  const total = Number(charge?.amount_refunded ?? (sale.refunded_cents ?? 0) + amount);
  const updated = must(await admin.rpc('record_stripe_refund', {
    p_payment_intent_id: sale.stripe_payment_intent_id, p_refunded_cents: total,
    p_cancel_pass: !!body.cancelPass, p_reason: `${String(body.reason ?? '') || 'no reason given'} (by ${me.name})`,
  }));

  if (body.cancelPass) {
    // Stop future membership billing straight away.
    const subs = must(await admin.from('passes').select('stripe_subscription_id').eq('sale_id', saleId).not('stripe_subscription_id', 'is', null)) as { stripe_subscription_id: string }[];
    for (const s of subs) await stripe('DELETE', `subscriptions/${s.stripe_subscription_id}`, {}, undefined, pay.account);
  }
  return json({ sale: updated });
});
