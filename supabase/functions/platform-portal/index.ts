// POST { studioId?, returnUrl }  (signed-in studio OWNER)  ->  { url }
// Stripe's billing portal for the studio's own plan subscription (card, invoices, cancel), on the PLATFORM's Stripe account.
// Turn the portal on first: Stripe Dashboard -> Settings -> Billing -> Customer portal, on the platform account.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { platformBillingOn, platformStripe } from '../_shared/platformBilling.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const me = await whoami(userClient(req, String(body.studioId ?? '')));
  if (me.kind !== 'staff' || me.role !== 'owner' || !me.staff_id) throw new HttpError(403, 'NOT_ALLOWED', 'Only the studio owner can manage billing.');
  if (!platformBillingOn()) throw new HttpError(409, 'BILLING_OFF', 'This studio has its own deployment, so there’s no plan to pay for.');
  const admin = adminClient();
  const staff = must(await admin.from('staff').select('studio_id').eq('id', me.staff_id).single()) as { studio_id: string };
  const row = must(await admin.from('studio_billing').select('stripe_customer_id').eq('studio_id', staff.studio_id).maybeSingle()) as { stripe_customer_id: string | null } | null;
  if (!row?.stripe_customer_id) throw new HttpError(404, 'NOT_FOUND', 'There’s no billing to manage yet. Choose a plan first.');
  const session = await platformStripe('POST', 'billing_portal/sessions', { customer: row.stripe_customer_id, return_url: safeReturnUrl(body.returnUrl) });
  return json({ url: session.url });
});
