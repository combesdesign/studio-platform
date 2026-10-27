-- =============================================================================
-- 2800: messaging, finished.
--   1. Who can use the inbox: marketing_settings.inbox_access (owner | owner_manager | no_instructors | all_staff). The default,
--      no_instructors (owner, manager, front desk), is what the inbox always did. Enforced in app.marketing_need, in the row
--      policies for threads and messages, and when picking which staff devices get a push.
--   2. Email alerts, both switchable in Settings > Marketing:
--        email_studio  "Email me when a client messages": an email to the studio's contact email (the owner's if there is none)
--        email_client  "Email clients when we reply": an email to the client, only when they have no web push device and web push
--                      is configured (the sender passes p_push_on to marketing_claim)
--      Both are queued by app.marketing_post into marketing_messages (source 'inbox', channel 'email') and leave through the
--      existing drain. At most one per conversation per audience every 15 minutes, so a back-and-forth doesn't spam.
--      The switches (and the studio's Settings > Emails switch for the client email) are checked again when the queue is claimed.
--   3. 'message_reply' joins the editable emails (Settings > Emails), so the studio can reword or switch off the client email.
-- =============================================================================

alter table public.marketing_settings
  add column inbox_access text not null default 'no_instructors' check (inbox_access in ('owner', 'owner_manager', 'no_instructors', 'all_staff')),
  add column email_studio boolean not null default true,
  add column email_client boolean not null default true;

-- ----------------------------------------------------------------------------- 1. inbox access

create function app.marketing_inbox_roles(p_studio uuid) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select case coalesce((select s.inbox_access from public.marketing_settings s where s.studio_id = p_studio), 'no_instructors')
    when 'owner' then array['owner']
    when 'owner_manager' then array['owner', 'manager']
    when 'all_staff' then array['owner', 'manager', 'front_desk', 'instructor']
    else array['owner', 'manager', 'front_desk'] end
$$;

-- Is the signed-in person staff of this studio with a role the inbox setting lets in?
create function app.marketing_inbox_ok(p_studio uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(app.staff_role_in(p_studio) = any (app.marketing_inbox_roles(p_studio)), false)
$$;
revoke execute on function app.marketing_inbox_roles(uuid), app.marketing_inbox_ok(uuid) from public, anon;
grant execute on function app.marketing_inbox_roles(uuid), app.marketing_inbox_ok(uuid) to authenticated, service_role;

create or replace function app.marketing_need(p_action text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_feature('marketing');
  if p_action = 'manage' and public.has_role('owner', 'manager') then return; end if;
  if p_action = 'view' and public.has_role('owner', 'manager', 'front_desk') then return; end if;
  if p_action = 'inbox' and app.marketing_inbox_ok(app.current_studio_id()) then return; end if;
  perform app.fail('NOT_ALLOWED', 'Your role doesn''t have access to that.');
end $$;

drop policy marketing_threads_read on public.marketing_threads;
create policy marketing_threads_read on public.marketing_threads for select to authenticated
  using (app.marketing_inbox_ok(studio_id) or client_id = app.client_id_in(studio_id));
drop policy marketing_thread_messages_read on public.marketing_thread_messages;
create policy marketing_thread_messages_read on public.marketing_thread_messages for select to authenticated
  using (app.marketing_inbox_ok(studio_id) or client_id = app.client_id_in(studio_id));

-- Any staff member can ask whether they may use the inbox (the UI hides it when not), without reading the settings.
create function public.marketing_inbox_access() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_staff_of(app.current_studio_id()) then perform app.fail('NOT_ALLOWED', 'Staff only.'); end if;
  return jsonb_build_object(
    'access', coalesce((select s.inbox_access from public.marketing_settings s where s.studio_id = app.current_studio_id()), 'no_instructors'),
    'allowed', app.marketing_inbox_ok(app.current_studio_id()));
end $$;
revoke execute on function public.marketing_inbox_access() from public, anon;
grant execute on function public.marketing_inbox_access() to authenticated;

-- ----------------------------------------------------------------------------- settings (adds the three new ones)

create or replace function app.marketing_settings_json(p_studio uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('fromName', coalesce(s.from_name, ''), 'replyTo', coalesce(s.reply_to, ''), 'smsSender', coalesce(s.sms_sender, ''),
                            'footerNote', coalesce(s.footer_note, ''), 'inboxAccess', coalesce(s.inbox_access, 'no_instructors'),
                            'emailStudio', coalesce(s.email_studio, true), 'emailClient', coalesce(s.email_client, true))
    from (select 1) x left join public.marketing_settings s on s.studio_id = p_studio
$$;

create or replace function public.marketing_update_settings(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id(); k text; v text;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(v_studio);
  perform app.marketing_ensure(v_studio);
  foreach k in array array['fromName', 'replyTo', 'smsSender', 'footerNote'] loop
    if not (p_patch ? k) then continue; end if;
    v := btrim(coalesce(p_patch ->> k, ''));
    if char_length(v) > 200 then perform app.fail('INVALID', 'That''s a bit long. Keep it under 200 characters.'); end if;
    if k = 'replyTo' and v <> '' and v !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then perform app.fail('INVALID', 'Enter a valid reply-to email address.'); end if;
    update public.marketing_settings set
      from_name = case when k = 'fromName' then v else from_name end, reply_to = case when k = 'replyTo' then v else reply_to end,
      sms_sender = case when k = 'smsSender' then v else sms_sender end, footer_note = case when k = 'footerNote' then v else footer_note end,
      updated_at = app.now()
     where studio_id = v_studio;
  end loop;
  if p_patch ? 'inboxAccess' then
    v := coalesce(p_patch ->> 'inboxAccess', '');
    if v not in ('owner', 'owner_manager', 'no_instructors', 'all_staff') then perform app.fail('INVALID', 'Pick who can use the inbox.'); end if;
    update public.marketing_settings set inbox_access = v, updated_at = app.now() where studio_id = v_studio;
  end if;
  if p_patch ? 'emailStudio' then
    update public.marketing_settings set email_studio = coalesce((p_patch ->> 'emailStudio')::boolean, true), updated_at = app.now() where studio_id = v_studio;
  end if;
  if p_patch ? 'emailClient' then
    update public.marketing_settings set email_client = coalesce((p_patch ->> 'emailClient')::boolean, true), updated_at = app.now() where studio_id = v_studio;
  end if;
  return app.marketing_settings_json(v_studio);
end $$;

-- ----------------------------------------------------------------------------- 3. the editable client email

create or replace function app.editable_email_kinds() returns text[]
language sql immutable as $$
  select array['booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome',
               'receipt', 'gift_card', 'appointment_confirmed', 'appointment_cancelled', 'appointment_moved', 'appointment_reminder',
               'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer', 'message_reply']
$$;
alter table public.email_templates drop constraint email_templates_kind_check;
alter table public.email_templates add constraint email_templates_kind_check check (kind = any (app.editable_email_kinds()));
-- "Send me a test" for it goes through the notifications queue like the class tests (the edge function fills in a made-up reply).
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('booking_confirmed', 'waitlist_promoted', 'class_cancelled', 'receipt', 'class_reminder', 'late_cancel', 'waitlist_joined', 'booking_cancelled', 'welcome', 'gift_card', 'message_reply'));

-- ----------------------------------------------------------------------------- 2. the alerts (queued when a message is posted)

create or replace function app.marketing_post(p_studio uuid, p_client uuid, p_sender text, p_staff uuid, p_body text) returns public.marketing_thread_messages
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body text := btrim(replace(coalesce(p_body, ''), E'\r\n', E'\n'));
  v_preview text;
  t public.marketing_threads;
  m public.marketing_thread_messages;
  v_now timestamptz := app.now();
  v_to text;
  v_email_on boolean;
begin
  if v_body = '' then perform app.fail('INVALID', 'Write a message first.'); end if;
  if char_length(v_body) > 2000 then perform app.fail('INVALID', 'Messages can be up to 2,000 characters.'); end if;
  v_preview := left(regexp_replace(v_body, '\s+', ' ', 'g'), 120);
  insert into public.marketing_threads (studio_id, client_id, created_at, last_message_at)
  values (p_studio, p_client, v_now, v_now)
  on conflict (studio_id, client_id) do update set last_message_at = excluded.last_message_at
  returning * into t;
  insert into public.marketing_thread_messages (studio_id, thread_id, client_id, sender, staff_id, body, created_at)
  values (p_studio, t.id, p_client, p_sender, p_staff, v_body, v_now) returning * into m;
  update public.marketing_threads set
    last_message_at = v_now, last_message_preview = left(regexp_replace(v_body, '\s+', ' ', 'g'), 140), last_from = p_sender,
    staff_unread = case when p_sender = 'client' then staff_unread + 1 else 0 end,
    client_unread = case when p_sender = 'staff' then client_unread + 1 else 0 end
   where id = t.id;
  -- Push notification for the other side, if they have a device registered (staff: only roles the inbox setting lets in).
  if exists (select 1 from public.marketing_push_devices d where d.studio_id = p_studio
              and case when p_sender = 'staff' then d.client_id = p_client
                       else exists (select 1 from public.staff st where st.id = d.staff_id and st.active and st.role = any (app.marketing_inbox_roles(p_studio))) end) then
    insert into public.marketing_messages (studio_id, client_id, channel, source, ref_name, subject, payload, dedupe_key, created_at)
    values (p_studio, p_client, 'push', 'inbox', 'Message', null,
            jsonb_build_object('audience', case when p_sender = 'staff' then 'client' else 'staff' end, 'threadId', t.id, 'messageId', m.id, 'preview', v_preview),
            'inbox:' || m.id, v_now)
    on conflict (studio_id, dedupe_key) do nothing;
  end if;
  -- Email alert, at most one per conversation per audience every 15 minutes.
  if p_sender = 'client' then
    select coalesce(ms.email_studio, true) into v_email_on from (select 1) x left join public.marketing_settings ms on ms.studio_id = p_studio;
    select coalesce(nullif(btrim(s.email), ''), (select nullif(btrim(st.email), '') from public.staff st where st.studio_id = p_studio and st.role = 'owner' and st.active order by st.created_at limit 1))
      into v_to from public.studios s where s.id = p_studio;
  else
    select coalesce(ms.email_client, true) into v_email_on from (select 1) x left join public.marketing_settings ms on ms.studio_id = p_studio;
    select nullif(btrim(c.email), '') into v_to from public.clients c where c.id = p_client;
  end if;
  if v_email_on and v_to is not null and not exists (
       select 1 from public.marketing_messages x
        where x.studio_id = p_studio and x.source = 'inbox' and x.channel = 'email'
          and x.payload ->> 'audience' = case when p_sender = 'client' then 'staff' else 'client' end
          and x.payload ->> 'threadId' = t.id::text and x.created_at > v_now - interval '15 minutes') then
    insert into public.marketing_messages (studio_id, client_id, channel, source, ref_name, to_address, subject, payload, dedupe_key, created_at)
    values (p_studio, p_client, 'email', 'inbox', 'Message', v_to, null,
            jsonb_build_object('audience', case when p_sender = 'client' then 'staff' else 'client' end, 'threadId', t.id, 'messageId', m.id, 'preview', v_preview,
                               'staffName', (select s.name from public.staff s where s.id = p_staff)),
            'inbox-email:' || m.id, v_now)
    on conflict (studio_id, dedupe_key) do nothing;
  end if;
  return m;
end $$;

-- The job the sender gets: the staff push audience follows the inbox setting, and the studio's email wording comes along.
create or replace function app.marketing_job_json(m public.marketing_messages) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', m.id, 'studioId', m.studio_id, 'channel', m.channel, 'source', m.source, 'to', m.to_address, 'subject', m.subject,
    'payload', m.payload, 'clientId', m.client_id, 'firstName', c.first_name, 'lastName', c.last_name,
    'kind', case when m.source = 'automation' then app.marketing_automation_kind(m.automation_key) when m.source = 'campaign' then 'marketing' else 'service' end,
    'campaign', (select jsonb_build_object('name', x.name, 'subject', x.subject, 'preheader', x.preheader, 'blocks', x.blocks, 'body', x.body)
                   from public.marketing_campaigns x where x.id = m.campaign_id),
    'automation', (select jsonb_build_object('key', a.key, 'subject', a.subject, 'heading', a.heading, 'body', a.body, 'buttonLabel', a.button_label)
                     from public.marketing_automations a where a.studio_id = m.studio_id and a.key = m.automation_key),
    'studio', jsonb_build_object('name', s.name, 'slug', s.slug, 'email', s.email, 'address', s.address, 'branding', s.branding,
                                 'customDomains', to_jsonb(s.custom_domains)),
    'settings', app.marketing_settings_json(m.studio_id),
    'emailOverrides', case when m.source = 'inbox' then coalesce((select jsonb_object_agg(t.kind, jsonb_build_object('enabled', t.enabled, 'subject', t.subject, 'intro', t.intro))
                                                                    from public.email_templates t where t.studio_id = m.studio_id and t.kind = 'message_reply'), '{}'::jsonb) end,
    'devices', case when m.channel = 'push' then coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'platform', d.platform, 'token', d.token, 'keys', d.keys))
          from public.marketing_push_devices d
         where d.studio_id = m.studio_id
           and case when m.payload ->> 'audience' = 'staff'
                    then exists (select 1 from public.staff st where st.id = d.staff_id and st.active and st.role = any (app.marketing_inbox_roles(m.studio_id)))
                    else d.client_id = m.client_id end), '[]'::jsonb) end)
    from public.clients c, public.studios s
   where c.id = m.client_id and s.id = m.studio_id
$$;

-- The claim also closes inbox emails the studio has since switched off, and client emails that push now covers.
drop function public.marketing_claim(text[], integer, uuid);
create function public.marketing_claim(p_channels text[], p_limit integer default 50, p_id uuid default null, p_push_on boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Marketing sender only.'); end if;
  -- Someone who opted out after a message was queued never gets it (service messages still go).
  update public.marketing_messages m set status = 'skipped', error = 'Opted out before sending'
    from public.clients c
   where m.status = 'queued' and c.id = m.client_id and not c.marketing_opt_in
     and (m.source = 'campaign' or (m.source = 'automation' and app.marketing_automation_kind(m.automation_key) = 'marketing'));
  -- Inbox emails: the switch in Settings > Marketing (and, for the client's, Settings > Emails) is checked again now.
  update public.marketing_messages m set status = 'skipped',
         error = case when m.payload ->> 'audience' = 'staff' then 'Studio alerts are switched off'
                      when p_push_on and exists (select 1 from public.marketing_push_devices d where d.studio_id = m.studio_id and d.client_id = m.client_id and d.platform = 'web')
                        then 'The client gets this as a notification' else 'Client emails are switched off' end
   where m.status = 'queued' and m.source = 'inbox' and m.channel = 'email'
     and ((m.payload ->> 'audience' = 'staff' and not coalesce((select s.email_studio from public.marketing_settings s where s.studio_id = m.studio_id), true))
       or (m.payload ->> 'audience' = 'client' and (
            not coalesce((select s.email_client from public.marketing_settings s where s.studio_id = m.studio_id), true)
            or exists (select 1 from public.email_templates t where t.studio_id = m.studio_id and t.kind = 'message_reply' and not t.enabled)
            or (p_push_on and exists (select 1 from public.marketing_push_devices d where d.studio_id = m.studio_id and d.client_id = m.client_id and d.platform = 'web')))));
  with picked as (
    update public.marketing_messages m set claimed_at = now(), attempts = m.attempts + 1
     where m.id in (
       select id from public.marketing_messages
        where status = 'queued' and attempts < 5 and channel = any(p_channels)
          and (claimed_at is null or claimed_at < now() - interval '10 minutes')
          and (p_id is null or id = p_id)
        order by created_at
        limit greatest(1, least(coalesce(p_limit, 50), 200))
        for update skip locked)
    returning m.*)
  select coalesce(jsonb_agg(app.marketing_job_json(p) order by p.created_at), '[]'::jsonb) into v from picked p;
  perform app.marketing_settle_campaigns();
  return v;
end $$;
revoke execute on function public.marketing_claim(text[], integer, uuid, boolean) from public, anon, authenticated;
grant execute on function public.marketing_claim(text[], integer, uuid, boolean) to service_role;
