// Keeps a Stripe subscription in line with the membership in our database.
// The app changes the database first (pause_pass / resume_pass / cancel_membership RPCs, which
// enforce the rules), then calls this to update Stripe.
//
//   POST { passId }      signed-in client (their own pass) or staff  -> syncs that one
//   POST { all: true }   x-cron-secret (daily pg_cron job)           -> syncs every membership,
//                        so pauses that start/end on a future date reach Stripe on the day.
//
// Pause = Stripe pause_collection { behavior: 'void' } until the day after paused_until (Sydney),
// so no weekly charges while paused. Cancel = cancel_at_period_end (keeps working until then).
import { adminClient, type Db, must, userClient } from '../_shared/db.ts';
import { HttpError, json, readJson, requireCronSecret, serve } from '../_shared/http.ts';
import { stripe, sydneyMidnightUnix, sydneyToday } from '../_shared/stripe.ts';

interface PassRow {
  id: string; status: string; kind: string; stripe_subscription_id: string | null; cancel_at_period_end: boolean;
  paused_from: string | null; paused_until: string | null; next_billing_at: string | null;
}

serve(async (req) => {
  const body = await readJson(req);
  const admin = adminClient();

  if (body.all === true) {
    requireCronSecret(req);
    const rows = must(await admin.from('passes')
      .select('id, status, kind, stripe_subscription_id, cancel_at_period_end, paused_from, paused_until, next_billing_at')
      .not('stripe_subscription_id', 'is', null)
      .in('status', ['active', 'paused', 'cancelled'])) as PassRow[];
    let synced = 0, failed = 0;
    for (const p of rows) {
      if (p.status === 'cancelled' && p.next_billing_at && Date.parse(p.next_billing_at) < Date.now() - 7 * 864e5) continue;
      try { await sync(p); synced++; } catch (e) { failed++; console.error('sync failed', p.id, e); }
    }
    return json({ synced, failed });
  }

  // Single pass: the caller must be able to see it (RLS: their own, or owner/manager/front desk).
  const passId = String(body.passId ?? '');
  const user: Db = userClient(req);
  const visible = must(await user.from('passes').select('id').eq('id', passId).maybeSingle());
  if (!visible) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that membership.');
  const p = must(await admin.from('passes')
    .select('id, status, kind, stripe_subscription_id, cancel_at_period_end, paused_from, paused_until, next_billing_at')
    .eq('id', passId).single()) as PassRow;
  if (!p.stripe_subscription_id) return json({ synced: false, reason: 'no subscription' });
  await sync(p);
  return json({ synced: true });
});

async function sync(p: PassRow): Promise<void> {
  if (!p.stripe_subscription_id) return;
  const sub = await stripe('GET', `subscriptions/${p.stripe_subscription_id}`);
  if (sub.status === 'canceled') return;

  const today = sydneyToday();
  const pausedNow = !!p.paused_from && p.paused_from <= today && (!p.paused_until || p.paused_until >= today);
  const wantCancel = p.status === 'cancelled' || p.cancel_at_period_end;

  const params: Record<string, unknown> = {};
  if (!!sub.cancel_at_period_end !== wantCancel) params.cancel_at_period_end = wantCancel ? 'true' : 'false';

  if (pausedNow && !wantCancel) {
    const resumeDay = p.paused_until ? addDay(p.paused_until) : null;
    const resumesAt = resumeDay ? sydneyMidnightUnix(resumeDay) : undefined;
    const cur = sub.pause_collection;
    if (!cur || cur.behavior !== 'void' || (resumesAt && cur.resumes_at !== resumesAt)) {
      params.pause_collection = { behavior: 'void', ...(resumesAt ? { resumes_at: resumesAt } : {}) };
    }
  } else if (sub.pause_collection) {
    params.pause_collection = ''; // empty string = resume collecting payments
  }

  if (Object.keys(params).length) await stripe('POST', `subscriptions/${p.stripe_subscription_id}`, params);
}

function addDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
