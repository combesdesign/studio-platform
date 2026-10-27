// Owner / manager edits a membership that bills through Stripe: move the renewal date, or move the client to another membership.
// Stripe is changed first (so it stays the truth for billing), then the database via the edit_membership_date / change_membership
// RPCs as the signed-in person (they check the role again and write the history + audit log).
//
//   POST { studioId, passId, action: 'renewal_date', date: 'YYYY-MM-DD' }
//        -> subscription trial_end = that day's Sydney midnight, proration_behavior 'none'. A subscription's billing cycle anchor can't
//           be set to a future date directly (billing_cycle_anchor only takes 'now' or 'unchanged' on an update), so Stripe's standard
//           way to move the next charge is a trial_end, which moves the next invoice with nothing charged in between.
//   POST { studioId, passId, action: 'change_plan', productId, prorate?: boolean, immediately?: boolean }
//        -> the subscription item's price is swapped. proration_behavior 'none' (the default: the new price starts at the next
//           invoice, nothing charged or credited), or 'always_invoice' when prorate is on (the difference is charged now, or credited
//           to their Stripe balance). `immediately` only changes when credits + the weekly allowance switch in OUR database.
// A membership with no Stripe subscription (taken at the desk) skips Stripe and only changes the database.
// Connect mode: every Stripe call carries the studio's connected account (payAs).
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { type StripeObject, stripe, sydneyMidnightUnix, sydneyToday } from '../_shared/stripe.ts';

const MAX_DAYS = 60;

interface PassRow {
  id: string; studio_id: string; client_id: string; product_id: string | null; kind: string; status: string; name: string;
  price_cents: number; billing_interval: string | null; stripe_subscription_id: string | null; next_billing_at: string | null;
}
interface ProductRow {
  id: string; studio_id: string; kind: string; name: string; price_cents: number; active: boolean; billing_interval: string | null; stripe_price_id: string | null;
}

serve(async (req) => {
  const body = await readJson(req);
  const studioId = String(body.studioId ?? '');
  const user = userClient(req, studioId);
  const me = await whoami(user);
  if (me.kind !== 'staff' || !['owner', 'manager'].includes(me.role ?? '')) throw new HttpError(403, 'NOT_ALLOWED', 'Only the owner or a manager can edit a membership.');

  const admin = adminClient();
  // Read the pass as the signed-in person, so another studio's pass is simply not found.
  const p = must(await user.from('passes')
    .select('id, studio_id, client_id, product_id, kind, status, name, price_cents, billing_interval, stripe_subscription_id, next_billing_at')
    .eq('id', String(body.passId ?? '')).maybeSingle()) as PassRow | null;
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that membership.');
  if (p.kind !== 'membership' || p.status === 'cancelled' || p.status === 'expired') throw new HttpError(400, 'INVALID', 'Only a membership that’s still billing can be edited.');

  const action = String(body.action ?? '');
  if (action === 'renewal_date') return json(await renewalDate(user, admin, p, String(body.date ?? '')));
  if (action === 'change_plan') return json(await changePlan(user, admin, p, String(body.productId ?? ''), body.prorate === true, body.immediately === true));
  throw new HttpError(400, 'INVALID', 'Unknown change.');
});

async function renewalDate(user: ReturnType<typeof userClient>, admin: ReturnType<typeof adminClient>, p: PassRow, date: string) {
  const today = sydneyToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new HttpError(400, 'INVALID', 'Choose a valid date.');
  const max = new Date(Date.parse(`${today}T00:00:00Z`) + MAX_DAYS * 864e5).toISOString().slice(0, 10);
  if (date <= today || date > max) throw new HttpError(400, 'INVALID', `Pick a renewal date after today and within the next ${MAX_DAYS} days.`);
  const at = sydneyMidnightUnix(date);

  let nextAt = new Date(at * 1000).toISOString();
  if (p.stripe_subscription_id) {
    const pay = await payAs(admin, p.studio_id);
    const sub = await stripe('GET', `subscriptions/${p.stripe_subscription_id}`, {}, undefined, pay.account);
    if (sub.status === 'canceled') throw new HttpError(400, 'INVALID', 'That subscription has already ended in Stripe.');
    const done = await stripe('POST', `subscriptions/${p.stripe_subscription_id}`, { trial_end: at, proration_behavior: 'none' }, undefined, pay.account);
    if (done.trial_end) nextAt = new Date(Number(done.trial_end) * 1000).toISOString();
  }
  const pass = must(await user.rpc('edit_membership_date', { p_pass_id: p.id, p_next_billing_at: nextAt }));
  return { pass };
}

async function changePlan(user: ReturnType<typeof userClient>, admin: ReturnType<typeof adminClient>, p: PassRow, productId: string, prorate: boolean, immediately: boolean) {
  const prod = must(await user.from('products').select('id, studio_id, kind, name, price_cents, active, billing_interval, stripe_price_id').eq('id', productId).maybeSingle()) as ProductRow | null;
  if (!prod || prod.kind !== 'membership' || !prod.active) throw new HttpError(400, 'INVALID', 'Choose one of the studio’s current memberships.');
  if (prod.id === p.product_id) throw new HttpError(400, 'INVALID', 'They’re already on that membership.');
  if ((prod.billing_interval ?? 'week') !== (p.billing_interval ?? 'week')) throw new HttpError(400, 'INVALID', 'That membership bills on a different schedule, so it can’t be swapped in.');

  let prorationCents = 0;
  if (p.stripe_subscription_id) {
    const pay = await payAs(admin, p.studio_id);
    const sub = await stripe('GET', `subscriptions/${p.stripe_subscription_id}`, {}, undefined, pay.account);
    if (sub.status === 'canceled') throw new HttpError(400, 'INVALID', 'That subscription has already ended in Stripe.');
    const item = sub.items?.data?.[0];
    if (!item?.id) throw new HttpError(502, 'PAYMENT_ERROR', 'We couldn’t find this membership’s plan in Stripe.');
    // Same price shape as create-checkout: a saved Stripe price on the platform's own account, otherwise the price itself.
    const price = prod.stripe_price_id && !pay.account
      ? { price: prod.stripe_price_id }
      : { price_data: {
          currency: 'aud', unit_amount: prod.price_cents,
          product_data: { name: prod.name, metadata: { product_id: prod.id } },
          recurring: { interval: prod.billing_interval === 'month' ? 'month' : 'week' },
        } };
    const done = await stripe('POST', `subscriptions/${p.stripe_subscription_id}`, {
      items: [{ id: item.id, ...price }],
      proration_behavior: prorate ? 'always_invoice' : 'none',
      metadata: { product_id: prod.id },
      description: prod.name,
    }, undefined, pay.account);
    if (prorate && done) prorationCents = prorationFromItem(sub, prod.price_cents);
  }
  const pass = must(await user.rpc('change_membership', { p_pass_id: p.id, p_product_id: prod.id, p_immediately: immediately, p_proration_cents: prorationCents }));
  return { pass };
}

/** Our own estimate of the difference (for the history line only); Stripe works out the real amount on its invoice. */
function prorationFromItem(sub: StripeObject, newCents: number): number {
  const item = sub.items?.data?.[0];
  const oldCents = Number(item?.price?.unit_amount ?? 0);
  const start = Number(sub.current_period_start ?? 0), end = Number(sub.current_period_end ?? 0);
  const now = Date.now() / 1000;
  if (!oldCents || end <= start || end <= now) return 0;
  return Math.round(((newCents - oldCents) * (end - now)) / (end - start));
}
