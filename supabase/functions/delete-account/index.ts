// "Delete my account" (Apple 5.1.1(v) / Google Play). Docs: NOTES.md "Account deletion".
//
//   POST { studioId, clientId? }   signed in. No clientId = the caller deletes their own account in this studio.
//                                   With clientId = the studio's OWNER deleting a client on request.
//
// Order matters, and every step can be repeated safely (so a failure half way is fixed by trying again):
//   1. account_deletion_plan (as the caller): the database decides who may, and says what lives outside it.
//   2. Stripe: cancel the subscriptions straight away (already cancelled = fine), then delete the Stripe customers (best effort).
//   3. Storage: delete their avatar files.
//   4. account_delete_apply (service role): anonymise, cancel bookings and passes, scrub, audit.
//   5. Auth: delete the sign-in user only if nothing else (another studio, staff) still uses it. Otherwise only this studio's link was removed.
import { adminClient, must, userClient } from '../_shared/db.ts';
import { payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

interface Plan {
  studio_id: string; client_id: string; by: 'self' | 'owner'; already_deleted: boolean; user_id: string | null;
  subscriptions: string[]; stripe_customers: string[]; avatar_paths: string[];
}

serve(async (req) => {
  const body = await readJson(req);
  const user = userClient(req, String(body.studioId ?? ''));
  const admin = adminClient();
  const authUserId = await callerId(user);

  const plan = must(await user.rpc('account_deletion_plan', { p_client_id: body.clientId ? String(body.clientId) : null })) as Plan;

  if (plan.subscriptions.length || plan.stripe_customers.length) {
    const pay = await payAs(admin, plan.studio_id);
    for (const sub of plan.subscriptions) {
      const cur = await stripe('GET', `subscriptions/${sub}`, {}, undefined, pay.account);
      if (cur.status !== 'canceled') await stripe('DELETE', `subscriptions/${sub}`, {}, undefined, pay.account);
    }
    for (const cus of plan.stripe_customers) {
      // Their payment records stay with Stripe; this removes the saved name, email and cards. Already gone is fine.
      try { await stripe('DELETE', `customers/${cus}`, {}, undefined, pay.account); } catch (e) { console.error('stripe customer delete', cus, e); }
    }
  }

  if (plan.avatar_paths.length) {
    const { error } = await admin.storage.from('avatars').remove(plan.avatar_paths);
    if (error) { console.error('avatar delete', error); throw new HttpError(500, 'ERROR', 'We couldn’t remove your photo. Please try again.'); }
  }

  const done = must(await admin.rpc('account_delete_apply', { p_client_id: plan.client_id, p_actor_user_id: authUserId, p_by: plan.by })) as
    { user_id: string | null; delete_auth_user: boolean };

  if (done.delete_auth_user && done.user_id) {
    const { error } = await admin.auth.admin.deleteUser(done.user_id);
    if (error && !/not.?found/i.test(error.message ?? '')) { console.error('auth delete', error); throw new HttpError(500, 'ERROR', 'We removed your details but couldn’t finish closing your login. Please try again.'); }
  }
  return json({ deleted: true, loginRemoved: !!done.delete_auth_user });
});

async function callerId(user: ReturnType<typeof userClient>): Promise<string | null> {
  const { data } = await user.auth.getUser();
  return data?.user?.id ?? null;
}
