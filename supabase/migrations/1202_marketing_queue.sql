-- =============================================================================
-- 1202: marketing, part 3: the send queue, tracking and the scheduler (service role only).
--   marketing_claim     the marketing-send / marketing-push edge functions take a batch of queued messages,
--                       with everything needed to render them (SKIP LOCKED, like claim_notifications in 0004)
--   marketing_finish    record the result (sent, or retry up to 5 attempts, then failed)
--   marketing_track     open pixel, link click, one-click unsubscribe (marketing-track edge function)
--   marketing_tick      the scheduler (supabase/marketing-cron.sql): due scheduled campaigns go out and every studio
--                       that uses marketing has its automations queued. Idempotent: the sent log's unique
--                       dedupe_key means running it twice (or every 15 minutes) never sends anything twice.
-- =============================================================================

create function app.marketing_job_json(m public.marketing_messages) returns jsonb
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
    'devices', case when m.channel = 'push' then coalesce((
        select jsonb_agg(jsonb_build_object('id', d.id, 'platform', d.platform, 'token', d.token, 'keys', d.keys))
          from public.marketing_push_devices d
         where d.studio_id = m.studio_id
           and case when m.payload ->> 'audience' = 'staff'
                    then exists (select 1 from public.staff st where st.id = d.staff_id and st.active and st.role in ('owner', 'manager', 'front_desk'))
                    else d.client_id = m.client_id end), '[]'::jsonb) end)
    from public.clients c, public.studios s
   where c.id = m.client_id and s.id = m.studio_id
$$;

create function public.marketing_claim(p_channels text[], p_limit integer default 50, p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Marketing sender only.'); end if;
  -- Someone who opted out after a message was queued never gets it (service messages still go).
  update public.marketing_messages m set status = 'skipped', error = 'Opted out before sending'
    from public.clients c
   where m.status = 'queued' and c.id = m.client_id and not c.marketing_opt_in
     and (m.source = 'campaign' or (m.source = 'automation' and app.marketing_automation_kind(m.automation_key) = 'marketing'));
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

-- Campaigns whose queue has drained are 'sent'.
create function app.marketing_settle_campaigns() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.marketing_campaigns c set status = 'sent', updated_at = now()
   where c.status = 'sending'
     and not exists (select 1 from public.marketing_messages m where m.studio_id = c.studio_id and m.campaign_id = c.id and m.status = 'queued')
$$;

create function public.marketing_finish(p_id uuid, p_error text default null, p_provider_id text default null, p_links jsonb default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Marketing sender only.'); end if;
  update public.marketing_messages set
    status = case when p_error is null then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
    sent_at = case when p_error is null then now() else sent_at end,
    error = left(p_error, 500),
    provider_id = coalesce(p_provider_id, provider_id),
    payload = case when p_links is not null then payload || jsonb_build_object('links', p_links) else payload end,
    claimed_at = case when p_error is null then claimed_at end
   where id = p_id;
  perform app.marketing_settle_campaigns();
end $$;

-- Open / click / unsubscribe from an email. p_link is the link's index in the rendered email (click only).
-- Returns where a click goes (looked up from what we sent, so the tracker can't be used as an open redirect).
create function public.marketing_track(p_id uuid, p_kind text, p_link integer default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.marketing_messages; v_url text;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Tracker only.'); end if;
  select * into m from public.marketing_messages where id = p_id;
  if m.id is null then return jsonb_build_object('ok', false); end if;
  if p_kind = 'open' then
    update public.marketing_messages set opened_at = coalesce(opened_at, now()) where id = p_id;
  elsif p_kind = 'click' then
    v_url := m.payload -> 'links' ->> p_link;
    update public.marketing_messages set clicked_at = coalesce(clicked_at, now()), opened_at = coalesce(opened_at, now()) where id = p_id;
  elsif p_kind = 'unsubscribe' then
    if m.unsubscribed_at is null then
      update public.marketing_messages set unsubscribed_at = now() where id = p_id;
      if m.campaign_id is not null then
        update public.marketing_campaigns set unsubscribed = unsubscribed + 1 where id = m.campaign_id;
      end if;
    end if;
    update public.clients set marketing_opt_in = false where id = m.client_id;
  else
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'url', v_url, 'studioName', (select name from public.studios where id = m.studio_id));
end $$;

-- The scheduler. Studios that have never opened Marketing (no settings row) are left alone, so switching the
-- cron on never surprises a studio with automations it hasn't seen.
create function public.marketing_tick(p_now timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, app.now());
  c record; s record;
  v_campaigns integer := 0; v_auto integer := 0;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  for c in select x.id, x.studio_id from public.marketing_campaigns x
            join public.studios st on st.id = x.studio_id and st.status <> 'suspended'
           where x.status = 'scheduled' and x.scheduled_for <= v_now order by x.scheduled_for loop
    perform app.use_studio(c.studio_id);
    perform app.marketing_start_campaign(c.id, v_now);
    v_campaigns := v_campaigns + 1;
  end loop;
  for s in select ms.studio_id from public.marketing_settings ms
            join public.studios st on st.id = ms.studio_id and st.status <> 'suspended' loop
    perform app.use_studio(s.studio_id);
    v_auto := v_auto + app.marketing_queue_automations(s.studio_id, v_now);
  end loop;
  perform app.use_studio(null);
  perform app.marketing_settle_campaigns();
  return jsonb_build_object('campaigns', v_campaigns, 'automations', v_auto);
end $$;

-- Old message rows aren't needed forever; campaign totals stay right (sent/open counts come from rows, so keep a year).
create function public.marketing_prune(p_days integer default 400) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Scheduled job only.'); end if;
  delete from public.marketing_messages where source = 'inbox' and created_at < now() - interval '30 days';
  delete from public.marketing_messages where source = 'automation' and created_at < now() - make_interval(days => greatest(p_days, 60));
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function app.marketing_job_json(public.marketing_messages), app.marketing_settle_campaigns() from public, anon, authenticated;
grant execute on function app.marketing_job_json(public.marketing_messages), app.marketing_settle_campaigns() to service_role;
revoke execute on function public.marketing_claim, public.marketing_finish, public.marketing_track, public.marketing_tick, public.marketing_prune
  from public, anon, authenticated;
grant execute on function public.marketing_claim, public.marketing_finish, public.marketing_track, public.marketing_tick, public.marketing_prune
  to service_role;
