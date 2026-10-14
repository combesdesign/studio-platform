-- The Momence import template: run it, load sample CSV rows, run it again (twice, to check it's re-runnable).
\o /dev/null
begin;
\ir ../import/momence_import.sql
\o /dev/null
insert into public.import_momence_clients (momence_id, first_name, last_name, email, phone, birthday, joined_on, marketing_opt_in, injuries, staff_notes, has_purchased_before) values
  ('m100', 'Hannah', 'Hill', 'Hannah@Example.test ', '0411 111 111', '14/03/1990', '2024-02-01', 'yes', 'Sore lower back', 'Prefers front row', 'yes'),
  ('m101', 'Ivy', 'Irwin', 'ivy@example.test', '', '', '05/06/2025', 'no', '', '', 'no'),
  ('m102', 'Alice', 'Dupe', 'alice@example.test', '', '', '', '', '', '', 'yes');   -- already in the new app
insert into public.import_momence_passes (email, pass_name, kind, credits_total, credits_left, expires_on, paid_until, momence_id) values
  ('hannah@example.test', '8 Class Pack', '', '8', '5', '30/11/2026', '', 'p1'),
  ('hannah@example.test', '2 classes per week', 'membership', '', '', '', '2026-10-27', 'p2'),
  ('ivy@example.test', '4 class pack', 'pack', '4', '4', '', '', 'p3'),
  ('nobody@example.test', 'Single class', '', '1', '1', '', '', 'p4');
\ir ../import/momence_import.sql
\ir ../import/momence_import.sql
\o /dev/null
select test.eq((select count(*) from public.clients where source = 'import')::int, 2, 'import: two new clients (Alice already existed)');
select test.eq((select birthday from public.clients where email = 'hannah@example.test'), '1990-03-14'::date, 'import: Australian date format parsed');
select test.ok((select intro_ineligible and marketing_opt_in from public.clients where email = 'hannah@example.test'), 'import: past buyers can''t take the intro offer');
select test.ok((select not intro_ineligible from public.clients where email = 'ivy@example.test') = false, 'import: anyone with a pass is not intro eligible');
select test.eq((select notes from public.client_notes n join public.clients c on c.id = n.client_id where c.email = 'hannah@example.test'), 'Prefers front row', 'import: staff notes');
select test.eq((select credits || '/' || credits_used from public.passes p join public.clients c on c.id = p.client_id
                 where c.email = 'hannah@example.test' and p.kind = 'pack'), '8/3', 'import: pack credits left');
select test.eq((select expires_at from public.passes p join public.clients c on c.id = p.client_id
                 where c.email = 'hannah@example.test' and p.kind = 'pack'), '2026-12-01 00:00+11'::timestamptz, 'import: pack keeps its expiry (end of that day, Sydney)');
select test.ok((select credits = 2 and cancel_at_period_end and stripe_subscription_id is null from public.passes p join public.clients c on c.id = p.client_id
                 where c.email = 'hannah@example.test' and p.kind = 'membership'), 'import: membership mapped to 2/week, ends unless they re-join');
select test.ok((select activated_at is null and expires_at is null from public.passes p join public.clients c on c.id = p.client_id
                 where c.email = 'ivy@example.test'), 'import: untouched pack starts its clock at first booking');
select test.eq((select count(*) from public.passes where momence_id is not null)::int, 3, 'import: re-running doesn''t duplicate; unknown emails skipped');
select test.anon();
select test.throws($$select * from public.import_momence_clients$$, '42501', 'import: staging tables are not readable through the API');
select test.admin();
rollback;
