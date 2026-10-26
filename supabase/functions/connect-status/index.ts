// POST { studioId? }  (signed-in studio OWNER)  ->  { connectMode, connected, accountId, chargesEnabled, payoutsEnabled, detailsSubmitted }
// Asks Stripe for the studio's connected account and saves its flags (charges_enabled, payouts_enabled, details_submitted),
// so Settings -> Payments is right when the owner comes back from Stripe. Outside Connect mode it just says so.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { connectMode, statusOf } from '../_shared/connect.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const me = await whoami(userClient(req, String(body.studioId ?? '')));
  if (me.kind !== 'staff' || me.role !== 'owner' || !me.staff_id) throw new HttpError(403, 'NOT_ALLOWED', 'Only the studio owner can see payment settings.');
  if (!connectMode()) return json(statusOf(null));

  const admin = adminClient();
  const staff = must(await admin.from('staff').select('studio_id').eq('id', me.staff_id).single()) as { studio_id: string };
  let row = must(await admin.from('studio_stripe').select('stripe_account_id, charges_enabled, payouts_enabled, details_submitted').eq('studio_id', staff.studio_id).maybeSingle());
  if (row?.stripe_account_id) {
    const acct = await stripe('GET', `accounts/${row.stripe_account_id}`);
    row = { stripe_account_id: row.stripe_account_id, charges_enabled: !!acct.charges_enabled, payouts_enabled: !!acct.payouts_enabled, details_submitted: !!acct.details_submitted };
    must(await admin.rpc('stripe_connect_save', {
      p_studio: staff.studio_id, p_account: row.stripe_account_id, p_charges: row.charges_enabled, p_payouts: row.payouts_enabled, p_details: row.details_submitted,
    }));
  }
  return json(statusOf(row));
});
