// POST { returnUrl } (signed-in client) -> { url }
// Stripe's hosted page where clients update their card or see invoices.
// Turn the portal on first: Stripe Dashboard -> Settings -> Billing -> Customer portal.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  const body = await readJson(req);
  const me = await whoami(userClient(req, String(body.studioId ?? '')));
  if (me.kind !== 'client' || !me.client_id) throw new HttpError(403, 'NOT_ALLOWED', 'Only client accounts have billing.');
  const admin = adminClient();
  const row = must(await admin.from('stripe_customers').select('stripe_customer_id').eq('client_id', me.client_id).maybeSingle());
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'You don’t have any saved payment details yet.');
  const studio = must(await admin.from('clients').select('studio_id').eq('id', me.client_id).single()) as { studio_id: string };
  const pay = await payAs(admin, studio.studio_id);   // Connect mode: the portal lives on the studio's own Stripe account
  const session = await stripe('POST', 'billing_portal/sessions', { customer: row.stripe_customer_id, return_url: safeReturnUrl(body.returnUrl) }, undefined, pay.account);
  return json({ url: session.url });
});
