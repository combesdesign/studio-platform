// Sends queued emails (booking confirmations, waitlist promotions, class cancelled, reminders, receipts)
// from the notifications outbox via Resend. Deploy with --no-verify-jwt; callers must send x-cron-secret.
//
// Called by:
//   - a Database Webhook on INSERT into public.notifications (instant), body { type: 'INSERT', record: {...} }
//   - pg_cron every 2 minutes (safety net), body { flush: true }   (see supabase/cron.sql)
import { adminClient } from '../_shared/db.ts';
import { drainOutbox } from '../_shared/email.ts';
import { json, readJson, requireCronSecret, serve } from '../_shared/http.ts';

serve(async (req) => {
  requireCronSecret(req);
  const body = await readJson(req);
  const record = body.record as { id?: string } | undefined;
  const result = await drainOutbox(adminClient(), record?.id ? { id: record.id, limit: 1 } : { limit: 50 });
  return json(result);
});
