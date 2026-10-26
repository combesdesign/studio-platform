-- In-app help and support (ROADMAP "Support that's actually good"). Permission map (mirrors src/features/support/permissions.ts):
--   support.use   owner, manager, front_desk, instructor   ask for help, follow up on your own requests, read their threads
--   support.all   owner, manager                           read every request from their own studio
--   platform admins (public.platform_admins)               read and reply to every studio's requests, pin urgent ones, set the status banner
-- There are no problem categories: a request is free text, an urgent flag and the context the app attaches (route, app version, browser).
-- Writes go through the RPCs below. The staff apps read the tables (RLS). The one platform-wide table (support_status) has no studio.
--
-- Urgent requests: there is no generic outbox that can email a platform address (the outboxes are per studio and per kind), so this
-- migration does not queue an email. See NOTES.md > support for the one-line database webhook that alerts Pete's phone.

-- ---------------------------------------------------------------- requests
create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  studio_name text not null default '',
  created_by uuid not null default auth.uid(),
  staff_id uuid,
  staff_name text not null default '',
  staff_role text not null default '',
  body text not null check (length(body) between 1 and 4000),
  urgent boolean not null default false,
  status text not null default 'open' check (status in ('open', 'waiting', 'resolved')),
  route text not null default '' check (length(route) <= 300),
  app_version text not null default '' check (length(app_version) <= 40),
  user_agent text not null default '' check (length(user_agent) <= 400),
  screenshot text check (screenshot is null or (length(screenshot) <= 900000 and screenshot ~ '^data:image/(jpeg|png|webp);base64,')),
  reply_by timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete set null (staff_id)
);
select app.scope_table('support_requests');
create index support_requests_inbox_idx on public.support_requests (urgent desc, created_at desc);
create index support_requests_studio_idx2 on public.support_requests (studio_id, created_at desc);

create policy support_requests_read on public.support_requests for select to authenticated
  using (created_by = auth.uid() or app.has_role_in(studio_id, 'owner', 'manager'));
create policy support_requests_platform on public.support_requests for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());
revoke all on public.support_requests from anon, authenticated;
grant select, insert, update on public.support_requests to authenticated;

-- ---------------------------------------------------------------- the thread
create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  request_id uuid not null,
  from_platform boolean not null default false,
  author_name text not null default '',
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (studio_id, request_id) references public.support_requests (studio_id, id) on delete cascade
);
select app.scope_table('support_messages');
create index support_messages_request_idx on public.support_messages (request_id, created_at);

-- A message is visible whenever its request is (RLS on the request applies to this subquery too).
create policy support_messages_read on public.support_messages for select to authenticated
  using (exists (select 1 from public.support_requests r where r.id = support_messages.request_id));
create policy support_messages_platform on public.support_messages for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());
revoke all on public.support_messages from anon, authenticated;
grant select, insert, update on public.support_messages to authenticated;

-- ---------------------------------------------------------------- platform status banner (one row for the whole platform, no studio)
create table public.support_status (
  id boolean primary key default true check (id),
  message text not null default '' check (length(message) <= 200),
  tone text not null default 'info' check (tone in ('info', 'warn')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.support_status enable row level security;
create policy support_status_read on public.support_status for select to anon, authenticated using (true);
revoke all on public.support_status from anon, authenticated;
grant select on public.support_status to anon, authenticated;
insert into public.support_status (id) values (true) on conflict do nothing;

-- ---------------------------------------------------------------- RPCs
-- Studio staff: send a request. Returns the new request row.
create or replace function public.support_send(
  p_body text, p_urgent boolean default false, p_screenshot text default null, p_route text default '',
  p_app_version text default '', p_user_agent text default '', p_reply_by timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  s public.staff; r public.support_requests;
  v_body text := trim(coalesce(p_body, ''));
begin
  select * into s from public.staff where user_id = auth.uid() and active and studio_id = v_studio;
  if s.id is null then perform app.fail('NOT_ALLOWED', 'Only studio staff can ask for help here.'); end if;
  perform app.assert_studio_open(v_studio);
  if v_body = '' then perform app.fail('INVALID', 'Tell us what''s going on first.'); end if;
  if length(v_body) > 4000 then perform app.fail('INVALID', 'That''s a bit long. Please keep it under 4000 characters.'); end if;
  if p_screenshot is not null and (length(p_screenshot) > 900000 or p_screenshot !~ '^data:image/(jpeg|png|webp);base64,') then
    perform app.fail('INVALID', 'That photo isn''t one we can use. Try a smaller screenshot.');
  end if;
  insert into public.support_requests (studio_id, studio_name, created_by, staff_id, staff_name, staff_role, body, urgent, route, app_version, user_agent, screenshot, reply_by)
  values (v_studio, (select name from public.studios where id = v_studio), auth.uid(), s.id, s.name, s.role, v_body, coalesce(p_urgent, false),
          left(coalesce(p_route, ''), 300), left(coalesce(p_app_version, ''), 40), left(coalesce(p_user_agent, ''), 400), p_screenshot,
          case when coalesce(p_urgent, false) then null else p_reply_by end)
  returning * into r;
  insert into public.support_messages (studio_id, request_id, from_platform, author_name, body) values (v_studio, r.id, false, s.name, v_body);
  return to_jsonb(r);
end $$;

-- Studio staff: add to one of your threads (an owner or manager can add to any request from their studio). Re-opens it.
create or replace function public.support_follow(p_request_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  s public.staff; r public.support_requests;
  v_body text := trim(coalesce(p_body, ''));
begin
  select * into s from public.staff where user_id = auth.uid() and active and studio_id = v_studio;
  if s.id is null then perform app.fail('NOT_ALLOWED', 'Only studio staff can reply here.'); end if;
  select * into r from public.support_requests where id = p_request_id and studio_id = v_studio
     and (created_by = auth.uid() or s.role in ('owner', 'manager'));
  if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that request.'); end if;
  if v_body = '' then perform app.fail('INVALID', 'Write your reply first.'); end if;
  if length(v_body) > 4000 then perform app.fail('INVALID', 'That''s a bit long. Please keep it under 4000 characters.'); end if;
  insert into public.support_messages (studio_id, request_id, from_platform, author_name, body) values (v_studio, r.id, false, s.name, v_body);
  update public.support_requests set status = 'open', updated_at = now() where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

-- Platform admin: reply in a studio's thread. The status goes to 'waiting' unless one is given.
create or replace function public.support_admin_reply(p_request_id uuid, p_body text, p_status text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.support_requests; v_body text := trim(coalesce(p_body, ''));
begin
  perform app.require_platform_admin();
  select * into r from public.support_requests where id = p_request_id;
  if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that request.'); end if;
  if v_body = '' then perform app.fail('INVALID', 'Write your reply first.'); end if;
  if length(v_body) > 4000 then perform app.fail('INVALID', 'That''s a bit long. Please keep it under 4000 characters.'); end if;
  if p_status is not null and p_status not in ('open', 'waiting', 'resolved') then perform app.fail('INVALID', 'Unknown status.'); end if;
  perform app.use_studio(r.studio_id);
  insert into public.support_messages (studio_id, request_id, from_platform, author_name, body)
  values (r.studio_id, r.id, true, coalesce(nullif((select raw_user_meta_data ->> 'first_name' from auth.users where id = auth.uid()), ''), 'Support'), v_body);
  update public.support_requests set status = coalesce(p_status, 'waiting'), updated_at = now() where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.support_admin_set_status(p_request_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.support_requests;
begin
  perform app.require_platform_admin();
  if p_status not in ('open', 'waiting', 'resolved') then perform app.fail('INVALID', 'Unknown status.'); end if;
  select * into r from public.support_requests where id = p_request_id;
  if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that request.'); end if;
  perform app.use_studio(r.studio_id);
  update public.support_requests set status = p_status, updated_at = now() where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

-- Platform admin: set (or clear, with an empty message) the status banner every studio app shows.
create or replace function public.support_admin_set_banner(p_message text, p_tone text default 'info') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text := trim(coalesce(p_message, '')); r public.support_status;
begin
  perform app.require_platform_admin();
  if length(v_msg) > 200 then perform app.fail('INVALID', 'Keep the status message under 200 characters.'); end if;
  if p_tone not in ('info', 'warn') then perform app.fail('INVALID', 'Unknown tone.'); end if;
  insert into public.support_status (id, message, tone, updated_at, updated_by) values (true, v_msg, p_tone, now(), auth.uid())
  on conflict (id) do update set message = excluded.message, tone = excluded.tone, updated_at = now(), updated_by = auth.uid()
  returning * into r;
  return to_jsonb(r);
end $$;

revoke execute on function public.support_send, public.support_follow, public.support_admin_reply, public.support_admin_set_status, public.support_admin_set_banner from public, anon;
grant execute on function public.support_send, public.support_follow, public.support_admin_reply, public.support_admin_set_status, public.support_admin_set_banner to authenticated;
