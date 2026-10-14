// Scheduled job: queue "see you soon" emails for classes starting within 2 hours, tidy up
// (waitlists of started classes, expired passes), then send whatever is in the outbox.
// Deploy with --no-verify-jwt; callers must send x-cron-secret.
//
// You can schedule this with pg_cron + pg_net every 15 minutes:
//   select cron.schedule('reminders', '*/15 * * * *', $$
//     select net.http_post(url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-reminders',
//       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','YOUR-CRON-SECRET'),
//       body := '{}'::jsonb) $$);
// (supabase/cron.sql does the same work with plain SQL jobs, which is all you need; use one or the other.)
import { adminClient, must } from '../_shared/db.ts';
import { drainOutbox } from '../_shared/email.ts';
import { json, requireCronSecret, serve } from '../_shared/http.ts';

serve(async (req) => {
  requireCronSecret(req);
  const admin = adminClient();
  const tidy = must(await admin.rpc('housekeeping'));
  const queued = must(await admin.rpc('queue_class_reminders', { p_hours: 2 }));
  const sent = await drainOutbox(admin, { limit: 100 });
  return json({ tidy, queued, ...sent });
});
