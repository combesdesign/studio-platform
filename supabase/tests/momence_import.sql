-- The Momence import with a FAKE export in the real layout. run.sh first runs scripts/momence-convert.mts on
-- tests/fixtures/momence, then this loads the two CSVs it wrote into the staging tables and runs the import (three times).
\o /dev/null
begin;
\ir ../import/momence_import.sql
\o /dev/null
\set clients_csv :momence_dir/momence_clients.csv
\set passes_csv :momence_dir/momence_passes.csv
-- (server-side COPY: psql doesn't expand variables inside \copy. The throwaway server runs on this machine.)
copy public.import_momence_clients from :'clients_csv' with (format csv, header true);
copy public.import_momence_passes from :'passes_csv' with (format csv, header true);
select test.eq((select count(*) from public.import_momence_clients)::int, 12, 'fixture: 12 client rows staged');
select test.eq((select count(*) from public.import_momence_passes)::int, 9, 'fixture: 9 pass rows staged');
\ir ../import/momence_import.sql
\ir ../import/momence_import.sql
\ir ../import/momence_import.sql
\o /dev/null

-- clients
select test.eq((select count(*) from public.clients where source = 'import')::int, 12, 'momence: 12 clients (11 customers + 1 member missing from the customers file), none doubled by re-runs');
select test.eq((select first_name || '/' || last_name || '/' || phone || '/' || created_at::date from public.clients where email = 'hannah.hill@example.test'),
               'Hannah/Hill/+61411000111/2025-12-18', 'momence: names trimmed, email lower-cased, join date from "December 18th 2025"');
select test.eq((select count(*) from public.clients where lower(email) = 'noah@example.test')::int, 1, 'momence: same email twice in the customers file is one client');
select test.ok(exists (select 1 from public.clients where email = 'ruby.reid@example.test' and first_name = 'Ruby'), 'momence: a member missing from the customers file still becomes a client');
select test.ok(not (select marketing_opt_in from public.clients where email = 'hannah.hill@example.test'), 'momence: nobody is opted in to marketing by the import');

-- memberships: product, weekly credits, next billing date kept
select test.eq((select p.name || '/' || p.credits || '/' || p.billing_interval || '/' || p.next_billing_at || '/' || p.expires_at
                  from public.passes p join public.clients c on c.id = p.client_id where c.email = 'hannah.hill@example.test'),
               '2 classes per week/2/week/2026-11-10 00:00:00+11/2026-11-11 00:00:00+11', 'momence: 2/week membership, next billing 10 Nov (Sydney), usable through that day');
select test.ok((select p.product_id = (select id from public.products where kind = 'membership' and credits = 2) and p.cancel_at_period_end and p.stripe_subscription_id is null and p.status = 'active'
                  from public.passes p join public.clients c on c.id = p.client_id where c.email = 'hannah.hill@example.test'),
               'momence: linked to the 2/week product, no Stripe subscription yet so it ends unless they re-join');
select test.eq((select next_billing_at from public.passes p join public.clients c on c.id = p.client_id
                 where c.email = 'noah@example.test' and p.kind = 'membership'), '2026-11-05 00:00+11'::timestamptz, 'momence: 3/week membership keeps its billing date');

-- two memberships: both kept, flagged once
select test.eq((select count(*) from public.passes p join public.clients c on c.id = p.client_id where c.email = 'mia@example.test' and p.kind = 'membership' and p.status = 'active')::int, 2, 'momence: two memberships are both kept');
select test.eq((select credits from public.passes p join public.clients c on c.id = p.client_id where c.email = 'mia@example.test' and p.credits = 1), 1, 'momence: ...one of them 1/week');
select test.ok((select n.notes like 'Two memberships from Momence:%Check which one to keep%' from public.client_notes n join public.clients c on c.id = n.client_id where c.email = 'mia@example.test'), 'momence: the client is flagged for staff');
select test.eq((select length(n.notes) - length(replace(n.notes, 'Two memberships', '')) from public.client_notes n join public.clients c on c.id = n.client_id where c.email = 'mia@example.test'), length('Two memberships'), 'momence: re-running doesn''t repeat the flag');

-- intro offer
select test.ok((select p.kind = 'intro' and p.activated_at is null and p.expires_at is null and p.validity_days = 14 and p.credits is null
                  from public.passes p join public.clients c on c.id = p.client_id where c.email = 'ivy.irwin@example.test'),
               'momence: intro with no expiry hasn''t started: its 14 days begin at the first booking');
select test.eq((select p.expires_at from public.passes p join public.clients c on c.id = p.client_id where c.email = 'jack.jones@gmail.test' and p.kind = 'intro'),
               '2026-11-10 00:00+11'::timestamptz, 'momence: started intro keeps its expiry (end of 9 Nov, Sydney)');
select test.ok((select count(*) = 3 and bool_and(intro_ineligible) from public.clients where email in ('ivy.irwin@example.test', 'jack.jones@gmail.test', '1a2b3c4d5e@autogenerated.momence.com')),
               'momence: anyone who had the intro offer is marked as already having had it');

-- made-up emails
select test.ok((select n.notes like 'Needs a real email%' from public.client_notes n join public.clients c on c.id = n.client_id where c.email = '1a2b3c4d5e@autogenerated.momence.com'), 'momence: made-up email flagged for staff follow-up');
select test.ok(not exists (select 1 from public.client_notes n join public.clients c on c.id = n.client_id where c.email = 'hannah.hill@example.test' and n.notes like 'Needs a real email%'), 'momence: real emails aren''t flagged');
insert into public.notifications (client_id, kind, to_email, payload)
  select id, 'booking_confirmed', email, '{}'::jsonb from public.clients where email in ('1a2b3c4d5e@autogenerated.momence.com', 'hannah.hill@example.test');
select test.ok((select sent_at is not null and error like 'Skipped%' from public.notifications where to_email like '%autogenerated.momence.com'), 'momence: an email to a made-up address is marked skipped, never sent');
select test.ok((select sent_at is null and error is null from public.notifications where to_email = 'hannah.hill@example.test'), 'momence: a real address still gets its email');

-- totals and re-runs
select test.eq((select count(*) from public.passes where momence_id is not null)::int, 9, 'momence: 9 passes, none doubled by running the import three times');
select test.eq((select count(*) from public.passes p join public.clients c on c.id = p.client_id where c.email = 'ruby.reid@example.test')::int, 1, 'momence: the missing-from-customers member has her membership');
rollback;
