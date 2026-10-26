-- =============================================================================
-- Scheduled jobs (run ONCE in the Supabase SQL editor after the migrations + seed).
-- Before running: Database -> Extensions -> turn on "pg_cron" and "pg_net".
-- Replace the two placeholders first:
--   YOUR-PROJECT-REF  -> from Project Settings -> General (e.g. abcdxyzabcdxyz)
--   YOUR-CRON-SECRET  -> the same random text you set as CRON_SECRET for the edge functions
-- To see jobs: select * from cron.job;   To remove one: select cron.unschedule('job-name');
-- =============================================================================

-- Every 15 min: clear waitlists of classes that have started, expire passes, flip pause states,
-- and queue "see you soon" reminders about 2 hours before class (people who booked inside those
-- 2 hours are skipped; they've just had their confirmation).
select cron.schedule('housekeeping', '*/15 * * * *', $$
  select public.housekeeping();
  select public.queue_class_reminders(2);
$$);

-- Every 2 min: send any emails waiting in the outbox (booking confirmations, waitlist, receipts…), queue gift cards whose
-- send date has come, and send the gift card e-cards, staff cover emails and marketing (commerce_outbox, payroll_outbox, marketing campaigns and automations).
-- (The database webhook in GO-LIVE.md sends them instantly; this is the safety net.)
select cron.schedule('send-emails', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{"flush":true}'::jsonb
  );
$$);

-- Every Sunday 3am (UTC): make the next 4 weeks of classes from the weekly timetable.
select cron.schedule('generate-classes', '0 3 * * 0', $$
  select public.generate_sessions(current_date, current_date + 28);
$$);

-- Daily just after midnight Sydney (14:05 UTC = 12:05am AEST / 1:05am AEDT): bring Stripe in line with
-- membership pauses that start or end today, before any weekly charge for the day goes out.
select cron.schedule('sync-memberships', '5 14 * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/manage-membership',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{"all":true}'::jsonb
  );
$$);

-- Weekly: tidy emails older than 90 days.
select cron.schedule('prune-emails', '30 3 * * 1', $$ select public.prune_notifications(90); $$);
