-- =============================================================================
-- 1200: marketing (ROADMAP B2), part 1: tables, row security and the audience logic.
--   * segments (saved client filters), client tags, email + SMS campaigns, automations
--   * marketing_messages: the send log. One row per message queued or sent, campaign or automation. It is also the
--     idempotency record: unique (studio_id, dedupe_key) means the same message is never queued twice.
--   * the audience functions: app.marketing_facts (who a client is, as marketing sees them), app.marketing_rule_ok
--     (does a segment rule match), app.marketing_audience (a whole filter), app.marketing_automation_hits (who each
--     automation should message now). src/features/marketing/segments.ts mirrors these rule for rule.
-- Every table is studio-scoped (app.scope_table). Staff read through RLS; ALL writes go through the marketing_*
-- functions in 1201, so a campaign can't be marked "sent" or an opt-in bypassed by a hand-made request.
-- Marketing sends only ever reach clients with marketing_opt_in = true. Automations marked 'service' (about a pass or
-- pause the client already holds) are the one exception, see app.marketing_automation_kind.
-- =============================================================================

-- ----------------------------------------------------------------------------- tables

create table public.marketing_settings (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete restrict,
  from_name text not null default '' check (char_length(from_name) <= 200),
  reply_to text not null default '' check (char_length(reply_to) <= 200),
  sms_sender text not null default '' check (char_length(sms_sender) <= 200),
  footer_note text not null default '' check (char_length(footer_note) <= 200),
  updated_at timestamptz not null default now()
);
select app.scope_table('marketing_settings');

create table public.marketing_segments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 60),
  description text check (char_length(description) <= 140),
  filter jsonb not null default '{"match":"all","rules":[]}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default app.now(),
  foreign key (studio_id, created_by) references public.staff (studio_id, id) on delete set null (created_by)
);
create unique index marketing_segments_name_key on public.marketing_segments (studio_id, lower(name));
select app.scope_table('marketing_segments');

create table public.marketing_client_tags (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  tag text not null check (char_length(tag) between 1 and 24),
  primary key (studio_id, client_id, tag),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
create index marketing_client_tags_tag_idx on public.marketing_client_tags (studio_id, lower(tag));
select app.scope_table('marketing_client_tags');

create table public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  channel text not null check (channel in ('email', 'sms')),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  segment_id uuid,
  segment_name text,
  filter_at_send jsonb,
  subject text,
  preheader text,
  blocks jsonb not null default '[]'::jsonb,
  body text,
  scheduled_for timestamptz,
  sent_at timestamptz,
  audience integer not null default 0,
  skipped integer not null default 0,
  unsubscribed integer not null default 0,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default app.now(),
  updated_at timestamptz not null default app.now(),
  foreign key (studio_id, segment_id) references public.marketing_segments (studio_id, id) on delete set null (segment_id),
  foreign key (studio_id, created_by) references public.staff (studio_id, id) on delete set null (created_by)
);
create index marketing_campaigns_due_idx on public.marketing_campaigns (scheduled_for) where status = 'scheduled';
select app.scope_table('marketing_campaigns');

create table public.marketing_automations (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  key text not null check (key in ('welcome', 'welcome_followup', 'intro_ending', 'pack_low', 'winback', 'birthday', 'after_first_class', 'paused_ending')),
  enabled boolean not null default true,
  channel text not null default 'email' check (channel in ('email', 'sms')),
  delay_days integer not null default 0 check (delay_days between 0 and 365),
  subject text not null default '' check (char_length(subject) <= 150),
  heading text not null default '' check (char_length(heading) <= 120),
  body text not null default '' check (char_length(body) <= 3000),
  button_label text not null default '' check (char_length(button_label) <= 40),
  updated_at timestamptz not null default app.now(),
  primary key (studio_id, key)
);
select app.scope_table('marketing_automations');

-- The send log and idempotency record: campaign recipients, automation sends and inbox notifications.
create table public.marketing_messages (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  channel text not null check (channel in ('email', 'sms', 'push')),
  source text not null check (source in ('campaign', 'automation', 'inbox')),
  campaign_id uuid,
  automation_key text,
  ref_name text not null default '',
  to_address text not null default '',
  subject text,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  error text,
  provider_id text,
  created_at timestamptz not null default app.now(),
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  unsubscribed_at timestamptz,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, campaign_id) references public.marketing_campaigns (studio_id, id) on delete cascade
);
create unique index marketing_messages_dedupe_key on public.marketing_messages (studio_id, dedupe_key);
create index marketing_messages_queue_idx on public.marketing_messages (created_at) where status = 'queued';
create index marketing_messages_campaign_idx on public.marketing_messages (studio_id, campaign_id);
create index marketing_messages_client_idx on public.marketing_messages (studio_id, client_id, created_at desc);
select app.scope_table('marketing_messages');

-- Two-way inbox: one thread per client per studio.
create table public.marketing_threads (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  created_at timestamptz not null default app.now(),
  last_message_at timestamptz not null default app.now(),
  last_message_preview text not null default '',
  last_from text not null default 'client' check (last_from in ('client', 'staff')),
  staff_unread integer not null default 0 check (staff_unread >= 0),
  client_unread integer not null default 0 check (client_unread >= 0),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
create unique index marketing_threads_client_key on public.marketing_threads (studio_id, client_id);
create index marketing_threads_recent_idx on public.marketing_threads (studio_id, last_message_at desc);
select app.scope_table('marketing_threads');

create table public.marketing_thread_messages (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  thread_id uuid not null,
  client_id uuid not null,
  sender text not null check (sender in ('client', 'staff')),
  staff_id uuid,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default app.now(),
  foreign key (studio_id, thread_id) references public.marketing_threads (studio_id, id) on delete cascade,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete set null (staff_id)
);
create index marketing_thread_messages_idx on public.marketing_thread_messages (thread_id, created_at);
select app.scope_table('marketing_thread_messages');

-- Push devices (web push subscriptions and Capacitor APNs / FCM tokens), per studio. The older public.push_tokens
-- table (0001) has no studio, so marketing doesn't use it.
create table public.marketing_push_devices (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid,
  staff_id uuid,
  platform text not null check (platform in ('web', 'ios', 'android')),
  token text not null check (char_length(token) between 1 and 2000),
  keys jsonb,
  user_agent text,
  created_at timestamptz not null default app.now(),
  last_seen_at timestamptz not null default app.now(),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade
);
create unique index marketing_push_devices_token_key on public.marketing_push_devices (studio_id, token);
create index marketing_push_devices_user_idx on public.marketing_push_devices (studio_id, user_id);
select app.scope_table('marketing_push_devices');

-- ----------------------------------------------------------------------------- row security
-- Staff read what their role allows; clients read only their own thread. Nobody writes tables directly.

create policy marketing_settings_read on public.marketing_settings for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create policy marketing_segments_read on public.marketing_segments for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create policy marketing_client_tags_read on public.marketing_client_tags for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create policy marketing_campaigns_read on public.marketing_campaigns for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create policy marketing_automations_read on public.marketing_automations for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create policy marketing_messages_read on public.marketing_messages for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk'));
create policy marketing_threads_read on public.marketing_threads for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk') or client_id = app.client_id_in(studio_id));
create policy marketing_thread_messages_read on public.marketing_thread_messages for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager', 'front_desk') or client_id = app.client_id_in(studio_id));
create policy marketing_push_devices_read on public.marketing_push_devices for select to authenticated
  using (user_id = auth.uid() or app.has_role_in(studio_id, 'owner', 'manager'));

do $$
declare t text;
begin
  foreach t in array array['marketing_settings', 'marketing_segments', 'marketing_client_tags', 'marketing_campaigns', 'marketing_automations',
                           'marketing_messages', 'marketing_threads', 'marketing_thread_messages', 'marketing_push_devices']
  loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
-- Push subscription keys are secrets: staff read counts through marketing_push_status, never the tokens.
revoke select on public.marketing_push_devices from authenticated;
grant select (id, studio_id, user_id, client_id, staff_id, platform, created_at, last_seen_at) on public.marketing_push_devices to authenticated;

-- Realtime (Supabase channels): new inbox messages reach the studio app and the client app straight away.
-- RLS applies to realtime, so each side only receives its own rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.marketing_threads, public.marketing_thread_messages;
  end if;
end $$;

-- ----------------------------------------------------------------------------- small helpers

-- Staff permission by feature action (src/features/marketing/permissions.ts).
create function app.marketing_need(p_action text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_action = 'manage' and public.has_role('owner', 'manager') then return; end if;
  if p_action in ('view', 'inbox') and public.has_role('owner', 'manager', 'front_desk') then return; end if;
  perform app.fail('NOT_ALLOWED', 'Your role doesn''t have access to that.');
end $$;

-- {{first_name}} style merge tags; unknown tags become empty.
create function app.marketing_merge(p_text text, p_vars jsonb) returns text
language plpgsql immutable as $$
declare t text := coalesce(p_text, ''); k text; v text;
begin
  for k, v in select * from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    t := regexp_replace(t, '\{\{\s*' || regexp_replace(k, '[^a-zA-Z0-9_]', '', 'g') || '\s*\}\}', replace(replace(coalesce(v, ''), '\', '\\'), '&', '\&'), 'gi');
  end loop;
  return regexp_replace(t, '\{\{\s*[a-z0-9_]+\s*\}\}', '', 'gi');
end $$;

-- 'service' automations are about something the client already holds (their pack, their pause); everything else is marketing.
create function app.marketing_automation_kind(p_key text) returns text
language sql immutable as $$
  select case when p_key in ('pack_low', 'paused_ending') then 'service' else 'marketing' end
$$;

create function app.marketing_default_automations()
returns table (key text, enabled boolean, channel text, delay_days integer, subject text, heading text, body text, button_label text)
language sql immutable as $$
  values
  ('welcome', true, 'email', 0, 'Welcome to {{studio_name}}', 'Welcome, *{{first_name}}*',
   E'We’re so glad you’re here.\n\nYour first class is easy: open the app, pick a time and book. If you’re not sure where to start, say hi in Messages and we’ll point you to the right class.', 'Book your first class'),
  ('welcome_followup', true, 'email', 3, 'A few tips for your first week', 'Settling *in*',
   E'Most of our clients make it a habit by booking the week ahead on a Sunday night and choosing classes they’ll really get to.\n\nTurn on notifications in the app and you’ll hear first when a spot opens. Questions about what to bring or which class to try? Reply in Messages any time.', 'See the timetable'),
  ('intro_ending', true, 'email', 3, 'Your intro offer ends {{ends_on}}', 'Keep the *momentum*',
   E'Hi {{first_name}}, your intro offer finishes on {{ends_on}}. If you’ve been enjoying it, a membership or a class pack keeps you in the routine.\n\nHave a look at the options in the app, or message us and we’ll help you pick.', 'See the options'),
  ('pack_low', true, 'email', 7, 'Your {{pack_name}} is running low', 'Almost *there*',
   E'Hi {{first_name}}, a quick heads up: your {{pack_name}} has {{pack_summary}}.\n\nBook your next class while you still have credits, or top up in the app so you never miss a session.', 'Open the app'),
  ('winback', true, 'email', 30, 'We miss you at {{studio_name}}', 'Come back *soon*',
   E'Hi {{first_name}}, it’s been a little while since your last class on {{last_visit}}. Life gets busy, we get it.\n\nWhenever you’re ready, we’d love to see you again. Have a look at this week’s timetable and grab a spot.', 'See the timetable'),
  ('birthday', true, 'email', 0, 'Happy birthday, {{first_name}}', 'Happy *birthday*',
   E'Everyone at {{studio_name}} is wishing you a wonderful day.\n\nTreat yourself to a class this week. You’ve earned it.', 'Book a class'),
  ('after_first_class', true, 'email', 1, 'How was your first class?', 'Nice *work*',
   E'Hi {{first_name}}, thanks for coming in. First classes can feel like a lot, and you did it.\n\nIf you have questions about what to try next, just reply in Messages. When you’re ready, grab your next class in the app.', 'Book your next class'),
  ('paused_ending', true, 'email', 3, 'Your membership restarts {{pause_ends}}', 'Welcome *back*',
   E'Hi {{first_name}}, your membership pause ends on {{pause_ends}} and billing starts again then.\n\nIf you need a little longer, message us before then and we’ll sort it out.', 'Open the app')
$$;

-- A studio's first touch: settings row, the starter segments and all automations (on, default copy).
create function app.marketing_ensure(p_studio uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.marketing_settings (studio_id) values (p_studio) on conflict do nothing;
  get diagnostics n = row_count;
  if n = 1 then
    insert into public.marketing_segments (studio_id, name, description, filter)
    select p_studio, s.name, s.description, s.filter::jsonb
      from (values
        ('Active members', 'Everyone with a running membership.', '{"match":"all","rules":[{"type":"active_member"}]}'),
        ('Pack running low', 'One credit left, or a pack expiring this week.', '{"match":"all","rules":[{"type":"pack_low","credits":1,"days":7}]}'),
        ('No visit in 30 days', 'Came before, then went quiet.', '{"match":"all","rules":[{"type":"no_visit","days":30}]}'),
        ('Intro offer clients', 'New clients on their intro offer.', '{"match":"all","rules":[{"type":"intro"}]}'),
        ('Birthday this month', 'Birthdays in the current month.', '{"match":"all","rules":[{"type":"birthday_month"}]}'),
        ('Opted into marketing', 'Everyone who said yes to news and offers.', '{"match":"all","rules":[{"type":"opted_in"}]}'),
        ('VIP', 'Clients you have tagged VIP.', '{"match":"all","rules":[{"type":"tag","tag":"VIP"}]}')
      ) s(name, description, filter)
    on conflict do nothing;
  end if;
  insert into public.marketing_automations (studio_id, key, enabled, channel, delay_days, subject, heading, body, button_label)
  select p_studio, d.key, d.enabled, d.channel, d.delay_days, d.subject, d.heading, d.body, d.button_label
    from app.marketing_default_automations() d
  on conflict do nothing;
end $$;

-- ----------------------------------------------------------------------------- the audience

create type app.marketing_fact as (
  client_id uuid, first_name text, last_name text, email text, phone text, opt_in boolean, birthday date,
  joined_at timestamptz, first_visit_at timestamptz, last_visit_at timestamptz, visits integer,
  active_member boolean, paused_until date, packs jsonb, intro jsonb, tags text[]
);

-- Mirrors computePassStatus (src/domain/rules.ts) for the states marketing cares about.
create function app.marketing_pass_state(p public.passes, p_now timestamptz, p_today date) returns text
language sql immutable as $$
  select case
    when p.status = 'cancelled' then 'cancelled'
    when p.expires_at is not null and p_now >= p.expires_at then 'expired'
    when p.kind <> 'membership' and p.credits is not null and p.credits_used >= p.credits then 'used_up'
    when p.paused_from is not null and p_today >= p.paused_from and p_today <= coalesce(p.paused_until, date '9999-12-31') then 'paused'
    else 'active' end
$$;

create function app.marketing_facts(p_studio uuid, p_now timestamptz) returns setof app.marketing_fact
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_today date := (p_now at time zone app.studio_tz(p_studio))::date;
begin
  return query
  with visits as (
    select b.client_id, min(coalesce(b.checked_in_at, s.starts_at)) as first_at, max(coalesce(b.checked_in_at, s.starts_at)) as last_at, count(*)::integer as n
      from public.bookings b
      join public.class_sessions s on s.id = b.session_id and s.studio_id = b.studio_id
     where b.studio_id = p_studio and b.status = 'checked_in' and coalesce(b.checked_in_at, s.starts_at) <= p_now
     group by b.client_id),
  ps as (
    select p.*, app.marketing_pass_state(p, p_now, v_today) as st from public.passes p where p.studio_id = p_studio)
  select c.id, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.birthday, c.created_at,
         v.first_at, v.last_at, coalesce(v.n, 0),
         exists (select 1 from ps where ps.client_id = c.id and ps.kind = 'membership' and ps.st = 'active'),
         (select max(ps.paused_until) from ps where ps.client_id = c.id and ps.kind = 'membership' and ps.st = 'paused' and ps.paused_until is not null),
         coalesce((select jsonb_agg(jsonb_build_object('id', ps.id, 'name', ps.name, 'remaining', ps.credits - ps.credits_used, 'expires_at', ps.expires_at)
                                    order by ps.expires_at nulls last, ps.id)
                     from ps where ps.client_id = c.id and ps.kind in ('pack', 'dropin') and ps.credits is not null and ps.st = 'active'
                                   and ps.credits - ps.credits_used > 0), '[]'::jsonb),
         (select jsonb_build_object('id', ps.id, 'name', ps.name, 'ends_at', ps.expires_at)
            from ps where ps.client_id = c.id and ps.kind = 'intro' and ps.st = 'active' order by ps.purchased_at, ps.id limit 1),
         coalesce((select array_agg(t.tag order by t.tag) from public.marketing_client_tags t where t.studio_id = p_studio and t.client_id = c.id), '{}'::text[])
    from public.clients c
    left join visits v on v.client_id = c.id
   where c.studio_id = p_studio and not c.archived;
end $$;

-- One segment rule against one client. Rule shape (see types.ts SegmentRule): { type, not?, days?, credits?, tag? }.
create function app.marketing_rule_ok(f app.marketing_fact, r jsonb, p_now timestamptz, p_tz text) returns boolean
language plpgsql stable as $$
declare ok boolean;
begin
  ok := case r ->> 'type'
    when 'active_member' then f.active_member
    when 'pack_low' then exists (
      select 1 from jsonb_array_elements(f.packs) p
       where (p ->> 'remaining')::integer <= coalesce((r ->> 'credits')::integer, 1)
          or ((p ->> 'expires_at') is not null and (p ->> 'expires_at')::timestamptz <= p_now + make_interval(days => coalesce((r ->> 'days')::integer, 7))))
    when 'no_visit' then f.last_visit_at is not null and f.last_visit_at <= p_now - make_interval(days => coalesce((r ->> 'days')::integer, 30))
    when 'intro' then f.intro is not null
    when 'birthday_month' then f.birthday is not null and extract(month from f.birthday) = extract(month from (p_now at time zone p_tz))
    when 'opted_in' then f.opt_in
    when 'tag' then coalesce(r ->> 'tag', '') <> '' and exists (select 1 from unnest(f.tags) x where lower(x) = lower(r ->> 'tag'))
    when 'new_client' then f.joined_at >= p_now - make_interval(days => coalesce((r ->> 'days')::integer, 30))
    else false end;
  ok := coalesce(ok, false);
  return case when coalesce((r ->> 'not')::boolean, false) then not ok else ok end;
end $$;

-- Checks a filter and returns it in canonical form, or raises INVALID.
create function app.marketing_clean_filter(p_filter jsonb) returns jsonb
language plpgsql immutable as $$
declare r jsonb; out_rules jsonb := '[]'::jsonb; t text; o jsonb;
begin
  if p_filter is null or jsonb_typeof(p_filter) <> 'object' then return '{"match":"all","rules":[]}'::jsonb; end if;
  if jsonb_typeof(coalesce(p_filter -> 'rules', '[]'::jsonb)) <> 'array' then perform app.fail('INVALID', 'The rules need to be a list.'); end if;
  if jsonb_array_length(coalesce(p_filter -> 'rules', '[]'::jsonb)) > 12 then perform app.fail('INVALID', 'That''s a lot of rules. Keep it to 12 or fewer.'); end if;
  for r in select * from jsonb_array_elements(coalesce(p_filter -> 'rules', '[]'::jsonb)) loop
    t := r ->> 'type';
    if t is null or t not in ('active_member', 'pack_low', 'no_visit', 'intro', 'birthday_month', 'opted_in', 'tag', 'new_client') then
      perform app.fail('INVALID', 'One of the rules isn''t recognised.');
    end if;
    o := jsonb_build_object('type', t);
    if coalesce((r ->> 'not')::boolean, false) then o := o || '{"not":true}'; end if;
    if t in ('no_visit', 'new_client') then o := o || jsonb_build_object('days', least(730, greatest(1, coalesce((r ->> 'days')::integer, 30)))); end if;
    if t = 'pack_low' then
      o := o || jsonb_build_object('credits', least(100, greatest(0, coalesce((r ->> 'credits')::integer, 1))),
                                   'days', least(730, greatest(1, coalesce((r ->> 'days')::integer, 7))));
    end if;
    if t = 'tag' then
      if btrim(coalesce(r ->> 'tag', '')) = '' then perform app.fail('INVALID', 'Pick a tag for the tag rule.'); end if;
      o := o || jsonb_build_object('tag', left(btrim(r ->> 'tag'), 24));
    end if;
    out_rules := out_rules || jsonb_build_array(o);
  end loop;
  return jsonb_build_object('match', case when p_filter ->> 'match' = 'any' then 'any' else 'all' end, 'rules', out_rules);
end $$;

create function app.marketing_audience(p_studio uuid, p_filter jsonb, p_now timestamptz) returns setof app.marketing_fact
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tz text := app.studio_tz(p_studio);
  v_rules jsonb := coalesce(p_filter -> 'rules', '[]'::jsonb);
  v_any boolean := coalesce(p_filter ->> 'match', 'all') = 'any';
begin
  return query
  select f.* from app.marketing_facts(p_studio, p_now) f
   where jsonb_array_length(v_rules) = 0
      or case when v_any
              then exists (select 1 from jsonb_array_elements(v_rules) r where app.marketing_rule_ok(f, r, p_now, v_tz))
              else not exists (select 1 from jsonb_array_elements(v_rules) r where not app.marketing_rule_ok(f, r, p_now, v_tz)) end;
end $$;

-- Who should each enabled automation message right now? Caller filters by reachability and the sent log.
-- Windows: an event qualifies from its trigger time for 7 days (so a missed day is caught up), and the sent log
-- (unique dedupe_key) stops anyone getting the same message twice.
create function app.marketing_automation_hits(p_studio uuid, p_now timestamptz)
returns table (automation_key text, client_id uuid, dedupe_key text, reason text, vars jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  a record;
  v_tz text := app.studio_tz(p_studio);
  v_today date := (p_now at time zone app.studio_tz(p_studio))::date;
  v_grace constant integer := 7;
begin
  for a in select * from public.marketing_automations m where m.studio_id = p_studio and m.enabled order by m.key loop
    if a.key in ('welcome', 'welcome_followup') then
      return query
      select a.key, f.client_id, a.key || ':' || f.client_id::text,
             case when p_now - f.joined_at < interval '1 day' then 'Joined today'
                  else 'Joined ' || floor(extract(epoch from p_now - f.joined_at) / 86400)::integer || ' days ago' end,
             '{}'::jsonb
        from app.marketing_facts(p_studio, p_now) f
       where f.joined_at + make_interval(days => a.delay_days) <= p_now
         and p_now < f.joined_at + make_interval(days => a.delay_days + v_grace);

    elsif a.key = 'intro_ending' then
      return query
      select a.key, f.client_id, 'intro_ending:' || f.client_id::text || ':' || (f.intro ->> 'id'),
             'Intro offer ends ' || to_char((f.intro ->> 'ends_at')::timestamptz at time zone v_tz, 'Dy FMDD Mon'),
             jsonb_build_object('ends_on', to_char((f.intro ->> 'ends_at')::timestamptz at time zone v_tz, 'Dy FMDD Mon'))
        from app.marketing_facts(p_studio, p_now) f
       where f.intro is not null and (f.intro ->> 'ends_at') is not null
         and (f.intro ->> 'ends_at')::timestamptz - make_interval(days => a.delay_days) <= p_now
         and p_now < (f.intro ->> 'ends_at')::timestamptz;

    elsif a.key = 'pack_low' then
      return query
      select a.key, f.client_id, 'pack_low:' || f.client_id::text || ':' || (m.p ->> 'id'),
             (m.p ->> 'name') || ': ' || ((m.p ->> 'remaining')::integer || case when (m.p ->> 'remaining')::integer = 1 then ' class' else ' classes' end || ' left')
               || coalesce(', expiring ' || to_char((m.p ->> 'expires_at')::timestamptz at time zone v_tz, 'Dy FMDD Mon'), ''),
             jsonb_build_object('pack_name', m.p ->> 'name',
               'pack_summary', (m.p ->> 'remaining')::integer || case when (m.p ->> 'remaining')::integer = 1 then ' class' else ' classes' end || ' left'
                 || coalesce(', expiring ' || to_char((m.p ->> 'expires_at')::timestamptz at time zone v_tz, 'Dy FMDD Mon'), ''))
        from app.marketing_facts(p_studio, p_now) f
        cross join lateral (
          select e.p from jsonb_array_elements(f.packs) with ordinality as e(p, ord)
           where (e.p ->> 'remaining')::integer <= 1
              or ((e.p ->> 'expires_at') is not null and (e.p ->> 'expires_at')::timestamptz <= p_now + make_interval(days => a.delay_days))
           order by e.ord limit 1) m;

    elsif a.key = 'winback' then
      return query
      select a.key, f.client_id, 'winback:' || f.client_id::text || ':' || to_char(f.last_visit_at at time zone v_tz, 'YYYY-MM-DD'),
             'Last class ' || to_char(f.last_visit_at at time zone v_tz, 'Dy FMDD Mon'),
             jsonb_build_object('last_visit', to_char(f.last_visit_at at time zone v_tz, 'Dy FMDD Mon'))
        from app.marketing_facts(p_studio, p_now) f
       where f.last_visit_at is not null
         and f.last_visit_at + make_interval(days => a.delay_days) <= p_now
         and p_now < f.last_visit_at + make_interval(days => a.delay_days + v_grace);

    elsif a.key = 'birthday' then
      return query
      select a.key, f.client_id, 'birthday:' || f.client_id::text || ':' || to_char(v_today + a.delay_days, 'YYYY'),
             case when a.delay_days = 0 then 'Birthday today' else 'Birthday in ' || a.delay_days || ' days' end, '{}'::jsonb
        from app.marketing_facts(p_studio, p_now) f
       where f.birthday is not null and to_char(f.birthday, 'MM-DD') = to_char(v_today + a.delay_days, 'MM-DD');

    elsif a.key = 'after_first_class' then
      return query
      select a.key, f.client_id, 'after_first_class:' || f.client_id::text,
             'First class ' || to_char(f.first_visit_at at time zone v_tz, 'Dy FMDD Mon'), '{}'::jsonb
        from app.marketing_facts(p_studio, p_now) f
       where f.first_visit_at is not null
         and f.first_visit_at + make_interval(days => a.delay_days) <= p_now
         and p_now < f.first_visit_at + make_interval(days => a.delay_days + v_grace);

    elsif a.key = 'paused_ending' then
      return query
      select a.key, f.client_id, 'paused_ending:' || f.client_id::text || ':' || to_char(f.paused_until, 'YYYY-MM-DD'),
             'Pause ends ' || to_char(f.paused_until, 'Dy FMDD Mon'),
             jsonb_build_object('pause_ends', to_char(f.paused_until, 'Dy FMDD Mon'))
        from app.marketing_facts(p_studio, p_now) f
       where f.paused_until is not null and v_today + a.delay_days >= f.paused_until and v_today <= f.paused_until;
    end if;
  end loop;
end $$;

-- The hits not yet sent, with who they are, what they'd get and whether they can be reached.
create function app.marketing_plan_automations(p_studio uuid, p_now timestamptz)
returns table (automation_key text, automation_name text, client_id uuid, client_name text, channel text, to_address text, subject text,
               preview text, reason text, dedupe_key text, vars jsonb, kind text, reachable boolean, why text)
language sql stable security definer set search_path = public, pg_temp as $$
  with h as (
    select * from app.marketing_automation_hits(p_studio, p_now) x
     where not exists (select 1 from public.marketing_messages m where m.studio_id = p_studio and m.dedupe_key = x.dedupe_key)),
  f as (select * from app.marketing_facts(p_studio, p_now)),
  s as (select name from public.studios where id = p_studio)
  select h.automation_key,
         case h.automation_key when 'welcome' then 'Welcome' when 'welcome_followup' then 'Welcome, part two' when 'intro_ending' then 'Intro offer ending soon'
           when 'pack_low' then 'Pack running low or expiring' when 'winback' then 'Win-back' when 'birthday' then 'Birthday'
           when 'after_first_class' then 'After their first class' else 'Membership pause ending' end,
         h.client_id, btrim(f.first_name || ' ' || f.last_name), a.channel,
         case a.channel when 'sms' then coalesce(f.phone, '') else coalesce(f.email, '') end,
         app.marketing_merge(a.subject, v.vars),
         left(regexp_replace(app.marketing_merge(a.body, v.vars), '\s+', ' ', 'g'), 200),
         h.reason, h.dedupe_key, v.vars, app.marketing_automation_kind(h.automation_key),
         (app.marketing_automation_kind(h.automation_key) = 'service' or f.opt_in)
           and case a.channel when 'sms' then btrim(coalesce(f.phone, '')) <> '' else btrim(coalesce(f.email, '')) <> '' end,
         case when app.marketing_automation_kind(h.automation_key) = 'marketing' and not f.opt_in then 'Not opted into marketing'
              when a.channel = 'sms' and btrim(coalesce(f.phone, '')) = '' then 'No mobile number'
              when a.channel = 'email' and btrim(coalesce(f.email, '')) = '' then 'No email address' else null end
    from h
    join f on f.client_id = h.client_id
    join public.marketing_automations a on a.studio_id = p_studio and a.key = h.automation_key
    cross join s
    cross join lateral (select h.vars || jsonb_build_object('first_name', f.first_name, 'last_name', f.last_name, 'studio_name', s.name) as vars) v
$$;

-- Queue the reachable ones (idempotent: the unique dedupe_key turns repeats into no-ops). Returns how many were queued.
create function app.marketing_queue_automations(p_studio uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.marketing_messages (studio_id, client_id, channel, source, automation_key, ref_name, to_address, subject, payload, dedupe_key, created_at)
  select p_studio, p.client_id, p.channel, 'automation', p.automation_key, p.automation_name, p.to_address, p.subject, p.vars, p.dedupe_key, p_now
    from app.marketing_plan_automations(p_studio, p_now) p
   where p.reachable
  on conflict (studio_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Only our own functions and the service role call anything in the app schema.
revoke execute on function app.marketing_need(text), app.marketing_merge(text, jsonb), app.marketing_automation_kind(text),
  app.marketing_default_automations(), app.marketing_ensure(uuid), app.marketing_pass_state(public.passes, timestamptz, date),
  app.marketing_facts(uuid, timestamptz), app.marketing_rule_ok(app.marketing_fact, jsonb, timestamptz, text), app.marketing_clean_filter(jsonb),
  app.marketing_audience(uuid, jsonb, timestamptz), app.marketing_automation_hits(uuid, timestamptz),
  app.marketing_plan_automations(uuid, timestamptz), app.marketing_queue_automations(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function app.marketing_need(text), app.marketing_merge(text, jsonb), app.marketing_automation_kind(text),
  app.marketing_default_automations(), app.marketing_ensure(uuid), app.marketing_pass_state(public.passes, timestamptz, date),
  app.marketing_facts(uuid, timestamptz), app.marketing_rule_ok(app.marketing_fact, jsonb, timestamptz, text), app.marketing_clean_filter(jsonb),
  app.marketing_audience(uuid, jsonb, timestamptz), app.marketing_automation_hits(uuid, timestamptz),
  app.marketing_plan_automations(uuid, timestamptz), app.marketing_queue_automations(uuid, timestamptz)
  to service_role;
