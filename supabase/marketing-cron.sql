-- =============================================================================
-- Marketing schedule (run ONCE in the Supabase SQL editor, like cron.sql). Needs pg_cron and pg_net.
-- Replace YOUR-PROJECT-REF and YOUR-CRON-SECRET first (same values as in cron.sql).
-- Deploy the function with:  supabase functions deploy marketing-send --no-verify-jwt
-- =============================================================================

-- Every 5 minutes: send scheduled campaigns that are due, queue every studio's automations (once each: the sent log
-- stops repeats), then send what is queued (emails through Resend, texts through Twilio or the stub).
select cron.schedule('marketing-send', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/marketing-send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{}'::jsonb
  );
$$);

-- Weekly, Sunday 4am UTC: tidy old inbox pushes and automation rows (campaign numbers are kept).
select cron.schedule('marketing-prune', '0 4 * * 0', $$ select public.marketing_prune(); $$);
