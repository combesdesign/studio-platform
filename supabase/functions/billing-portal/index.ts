// POST { returnUrl } (signed-in client) -> { url }
// Stripe's hosted page where clients update their card or see invoices.
// Turn the portal on first: Stripe Dashboard -> Settings -> Billing -> Customer portal.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  const body = await readJson(req);
  const me = await whoami(userClient(req));
  if (me.kind !== 'client' || !me.client_id) throw new HttpError(403, 'NOT_ALLOWED', 'Only client accounts have billing.');
  const row = must(await adminClient().from('stripe_customers').select('stripe_customer_id').eq('client_id', me.client_id).maybeSingle());
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'You don’t have any saved payment details yet.');
  const session = await stripe('POST', 'billing_portal/sessions', { customer: row.stripe_customer_id, return_url: safeReturnUrl(body.returnUrl) });
  return json({ url: session.url });
});
