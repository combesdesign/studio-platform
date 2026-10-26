// POST { studioId?, returnUrl, refreshUrl? }  (signed-in studio OWNER)  ->  { url, accountId }
// Stripe Connect onboarding for a studio on the multi-studio platform. Creates the studio's Standard connected account
// (the studio owns it, keeps its own Stripe dashboard and handles its own disputes) or reuses the one it already has,
// then returns a fresh Account Link: Stripe's hosted page where the owner finishes setup. Run it again for "Finish setup".
// connect-status then brings our copy of the account's flags up to date (and stripe-webhook does too, on account.updated).
// Does nothing outside Connect mode (STRIPE_CONNECT=1, no STUDIO_SLUG): single-account deployments like Snowy use their own keys.
import { adminClient, must, userClient, whoami } from '../_shared/db.ts';
import { connectMode } from '../_shared/connect.ts';
import { HttpError, json, readJson, safeReturnUrl, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const me = await whoami(userClient(req, String(body.studioId ?? '')));
  if (me.kind !== 'staff' || me.role !== 'owner' || !me.staff_id) throw new HttpError(403, 'NOT_ALLOWED', 'Only the studio owner can connect Stripe.');
  if (!connectMode()) throw new HttpError(409, 'CONNECT_OFF', 'This app takes card payments on its own Stripe account, so there’s nothing to connect.');

  const admin = adminClient();
  const staff = must(await admin.from('staff').select('studio_id').eq('id', me.staff_id).single()) as { studio_id: string };
  const studio = must(await admin.from('studios').select('id, name, email').eq('id', staff.studio_id).single()) as { id: string; name: string; email: string };

  let accountId = (must(await admin.from('studio_stripe').select('stripe_account_id').eq('studio_id', studio.id).maybeSingle()) as { stripe_account_id: string | null } | null)?.stripe_account_id ?? null;
  if (!accountId) {
    const acct = await stripe('POST', 'accounts', {
      type: 'standard',
      email: studio.email || undefined,
      business_profile: { name: studio.name },
      metadata: { studio_id: studio.id },
    }, `connect-account-${studio.id}`);
    accountId = String(acct.id);
    must(await admin.rpc('stripe_connect_save', {
      p_studio: studio.id, p_account: accountId, p_charges: !!acct.charges_enabled, p_payouts: !!acct.payouts_enabled, p_details: !!acct.details_submitted,
    }));
  }

  const returnUrl = safeReturnUrl(body.returnUrl);
  const link = await stripe('POST', 'account_links', {
    account: accountId, type: 'account_onboarding', return_url: returnUrl, refresh_url: safeReturnUrl(body.refreshUrl ?? returnUrl),
  });
  return json({ url: link.url, accountId });
});
