-- Cancelling a membership needs a reason (3301): required, trimmed, capped, stored on the pass for the studio to read.
-- Obviously fake data only. "Now" is Monday 19 Oct 2026, 8:00am Sydney.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

insert into public.passes (client_id, kind, name, credits, billing_interval, stripe_subscription_id, next_billing_at)
values (test.id('gus_client'), 'membership', '1 class per week', 1, 'week', 'sub_reason', '2026-10-25 09:00+11');
update public.clients set archived = false where id = test.id('gus_client');
select id as pass from public.passes where stripe_subscription_id = 'sub_reason' \gset

select test.login('gus');
select test.throws(format('select public.cancel_membership(%L, null)', :'pass'), 'INVALID', 'no reason, no cancel');
select test.throws(format('select public.cancel_membership(%L, %L)', :'pass', '   '), 'INVALID', 'a blank reason is no reason');
select test.throws(format('select public.cancel_membership(%L, %L)', :'pass', repeat('x', 301)), 'INVALID', 'reasons are capped at 300 characters');
select test.eq((select status from public.passes where id = :'pass'::uuid), 'active', 'a refused cancel leaves the membership running');

select test.eq(public.cancel_membership(:'pass'::uuid, '  Other: moving to Perth  ') ->> 'cancel_reason', 'Other: moving to Perth', 'the reason is trimmed and saved');
select test.eq((select status from public.passes where id = :'pass'::uuid), 'cancelled', 'membership cancelled');
select test.ok((select cancelled_at is not null from public.passes where id = :'pass'::uuid), 'when it was cancelled is saved');
select test.eq((public.cancel_membership(:'pass'::uuid, 'Too expensive') ->> 'cancel_reason'), 'Other: moving to Perth', 'cancelling again keeps the first reason');

-- the studio reads it on the client's membership
select test.login('libby');
select test.eq((select cancel_reason from public.passes where id = :'pass'::uuid), 'Other: moving to Perth', 'owner sees the reason');
select test.admin();
select test.eq((select details ->> 'reason' from public.audit_log where action = 'cancel_membership' and entity_id = :'pass' order by at desc limit 1), 'Other: moving to Perth', 'the audit trail has it too');

rollback;
