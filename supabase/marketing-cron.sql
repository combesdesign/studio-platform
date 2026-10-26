-- =============================================================================
-- Marketing schedule (run ONCE in the Supabase SQL editor, like cron.sql).
-- Sending needs no job of its own: the existing 'send-emails' job in cron.sql (and the send-reminders function) drain
-- the marketing queue with every other outbox. Each run first queues due scheduled campaigns and every studio's automations
-- (marketing_tick; the sent log stops anything going out twice), then sends what is queued.
-- Deploy the tracking / unsubscribe endpoint with:  supabase functions deploy marketing-send --no-verify-jwt
-- =============================================================================

-- Weekly, Sunday 4am UTC: tidy old inbox pushes and automation rows (campaign numbers are kept).
select cron.schedule('marketing-prune', '0 4 * * 0', $$ select public.marketing_prune(); $$);
