-- =============================================================================
-- 1201: marketing, part 2: the RPCs the apps call (store.features.marketing in src/features/marketing/live.ts).
-- Every function works in the current studio (x-studio header), checks the caller's role (marketing.view /
-- marketing.manage / marketing.inbox, see permissions.ts) and returns camelCase JSON shaped like types.ts.
-- Writes happen only here. Sending is queued into marketing_messages; the marketing-send edge function delivers.
-- =============================================================================

-- ----------------------------------------------------------------------------- JSON helpers

create function app.marketing_iso(p timestamptz) returns text
language sql immutable as $$
  select case when p is null then null else to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
$$;

-- A whole filter against one client.
create function app.marketing_filter_ok(f app.marketing_fact, p_filter jsonb, p_now timestamptz, p_tz text) returns boolean
language sql stable as $$
  select case
    when jsonb_array_length(coalesce(p_filter -> 'rules', '[]'::jsonb)) = 0 then true
    when coalesce(p_filter ->> 'match', 'all') = 'any'
      then exists (select 1 from jsonb_array_elements(p_filter -> 'rules') r where app.marketing_rule_ok(f, r, p_now, p_tz))
    else not exists (select 1 from jsonb_array_elements(p_filter -> 'rules') r where not app.marketing_rule_ok(f, r, p_now, p_tz)) end
$$;

create function app.marketing_segment_json(s public.marketing_segments) returns jsonb
language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', s.id, 'name', s.name, 'description', s.description, 'createdAt', app.marketing_iso(s.created_at)))
         || jsonb_build_object('filter', s.filter)
$$;

create function app.marketing_campaign_json(c public.marketing_campaigns) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'name', c.name, 'channel', c.channel, 'status', c.status, 'segmentId', c.segment_id, 'segmentName', c.segment_name,
    'subject', case when c.channel = 'email' then c.subject end, 'preheader', case when c.channel = 'email' then c.preheader end,
    'body', case when c.channel = 'sms' then c.body end,
    'scheduledFor', app.marketing_iso(c.scheduled_for), 'sentAt', app.marketing_iso(c.sent_at), 'createdAt', app.marketing_iso(c.created_at),
    'createdByName', c.created_by_name))
  || case when c.channel = 'email' then jsonb_build_object('blocks', c.blocks) else '{}'::jsonb end
  || jsonb_build_object('stats', (
       select jsonb_build_object(
         'audience', c.audience, 'skipped', c.skipped, 'unsubscribed', c.unsubscribed,
         'sent', count(*) filter (where m.status = 'sent'), 'failed', count(*) filter (where m.status = 'failed'),
         'opened', count(*) filter (where m.opened_at is not null), 'clicked', count(*) filter (where m.clicked_at is not null))
         from public.marketing_messages m where m.studio_id = c.studio_id and m.campaign_id = c.id))
$$;

create function app.marketing_log_json(m public.marketing_messages) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', m.id, 'channel', m.channel, 'source', m.source, 'refId', coalesce(m.campaign_id::text, m.automation_key, ''), 'refName', m.ref_name,
    'clientId', m.client_id, 'clientName', (select btrim(c.first_name || ' ' || c.last_name) from public.clients c where c.id = m.client_id),
    'to', m.to_address, 'status', m.status, 'error', m.error, 'sentAt', app.marketing_iso(m.sent_at),
    'openedAt', app.marketing_iso(m.opened_at), 'clickedAt', app.marketing_iso(m.clicked_at), 'subject', m.subject))
$$;

create function app.marketing_automation_json(a public.marketing_automations) returns jsonb
language sql stable as $$
  select jsonb_build_object('key', a.key, 'enabled', a.enabled, 'channel', a.channel, 'delay', a.delay_days, 'subject', a.subject,
    'heading', a.heading, 'body', a.body, 'buttonLabel', a.button_label, 'updatedAt', app.marketing_iso(a.updated_at))
$$;

create function app.marketing_thread_json(t public.marketing_threads) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', t.id, 'clientId', t.client_id, 'clientName', btrim(c.first_name || ' ' || c.last_name), 'clientPhotoUrl', nullif(c.photo_url, ''),
    'lastMessageAt', app.marketing_iso(t.last_message_at), 'lastMessagePreview', t.last_message_preview, 'lastFrom', t.last_from,
    'unread', t.staff_unread))
    from public.clients c where c.id = t.client_id
$$;

create function app.marketing_tmsg_json(m public.marketing_thread_messages) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', m.id, 'threadId', m.thread_id, 'from', m.sender, 'staffName', (select s.name from public.staff s where s.id = m.staff_id),
    'body', m.body, 'at', app.marketing_iso(m.created_at)))
$$;

create function app.marketing_settings_json(p_studio uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('fromName', coalesce(s.from_name, ''), 'replyTo', coalesce(s.reply_to, ''), 'smsSender', coalesce(s.sms_sender, ''),
                            'footerNote', coalesce(s.footer_note, ''))
    from (select 1) x left join public.marketing_settings s on s.studio_id = p_studio
$$;

-- ----------------------------------------------------------------------------- campaign checks + sending

-- Blocks: a list of known block types, links that start with https://, mailto:, tel: or the app link.
create function app.marketing_clean_blocks(p_blocks jsonb) returns jsonb
language plpgsql immutable as $$
declare b jsonb; out_blocks jsonb := '[]'::jsonb; i integer := 0; o jsonb;
begin
  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' then return '[]'::jsonb; end if;
  if jsonb_array_length(p_blocks) > 40 then perform app.fail('INVALID', 'That''s a lot of blocks. Keep it to 40 or fewer.'); end if;
  for b in select * from jsonb_array_elements(p_blocks) loop
    i := i + 1;
    if coalesce(b ->> 'type', '') not in ('heading', 'text', 'image', 'button', 'divider') then
      perform app.fail('INVALID', 'One of the blocks isn''t recognised.');
    end if;
    if coalesce(b ->> 'url', '') <> '' and btrim(b ->> 'url') !~* '^(https?://|mailto:|tel:|\{\{\s*app_url\s*\}\})' then
      perform app.fail('INVALID', 'Links need to start with https:// (or be the app link).');
    end if;
    o := jsonb_build_object('id', coalesce(nullif(b ->> 'id', ''), 'b' || i), 'type', b ->> 'type');
    if b ? 'text' then o := o || jsonb_build_object('text', left(b ->> 'text', 5000)); end if;
    if b ? 'src' then o := o || jsonb_build_object('src', left(b ->> 'src', 1000)); end if;
    if b ? 'alt' then o := o || jsonb_build_object('alt', left(b ->> 'alt', 200)); end if;
    if b ? 'label' then o := o || jsonb_build_object('label', left(b ->> 'label', 80)); end if;
    if b ? 'url' then o := o || jsonb_build_object('url', left(btrim(b ->> 'url'), 1000)); end if;
    out_blocks := out_blocks || jsonb_build_array(o);
  end loop;
  return out_blocks;
end $$;

-- Everything a recipient will see is there (the same checks as validateCampaign forSend in validate.ts).
create function app.marketing_check_send(c public.marketing_campaigns) returns void
language plpgsql stable as $$
begin
  if c.channel = 'email' then
    if btrim(coalesce(c.subject, '')) = '' then perform app.fail('INVALID', 'Add a subject line before sending.'); end if;
    if not exists (select 1 from jsonb_array_elements(c.blocks) b
                    where (b ->> 'type' in ('heading', 'text') and btrim(coalesce(b ->> 'text', '')) <> '')
                       or (b ->> 'type' = 'image' and btrim(coalesce(b ->> 'src', '')) <> '')
                       or (b ->> 'type' = 'button' and btrim(coalesce(b ->> 'label', '')) <> '' and btrim(coalesce(b ->> 'url', '')) <> '')) then
      perform app.fail('INVALID', 'Add some content before sending.');
    end if;
    if exists (select 1 from jsonb_array_elements(c.blocks) b
                where b ->> 'type' = 'button' and (btrim(coalesce(b ->> 'label', '')) = '' or btrim(coalesce(b ->> 'url', '')) = '')) then
      perform app.fail('INVALID', 'Your button needs a label and a link.');
    end if;
    if exists (select 1 from jsonb_array_elements(c.blocks) b where b ->> 'type' = 'image' and btrim(coalesce(b ->> 'src', '')) = '') then
      perform app.fail('INVALID', 'One of your images has no picture yet.');
    end if;
  else
    if btrim(coalesce(c.body, '')) = '' then perform app.fail('INVALID', 'Write the text message before sending.'); end if;
    if char_length(c.body) > 600 then perform app.fail('INVALID', 'That text is too long. Keep it to 4 message parts (about 600 characters) or fewer.'); end if;
  end if;
end $$;

-- Freeze the audience and queue one message per reachable, opted-in client. Marketing only ever goes to opt-ins.
create function app.marketing_start_campaign(p_id uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.marketing_campaigns;
  v_filter jsonb;
  v_seg text;
  v_total integer;
  v_queued integer;
begin
  select * into c from public.marketing_campaigns where id = p_id for update;
  if c.status not in ('draft', 'scheduled') then return 0; end if;
  select s.filter, s.name into v_filter, v_seg from public.marketing_segments s where s.id = c.segment_id;
  v_filter := coalesce(v_filter, '{"match":"all","rules":[]}'::jsonb);

  select count(*) into v_total from app.marketing_audience(c.studio_id, v_filter, p_now);
  insert into public.marketing_messages (studio_id, client_id, channel, source, campaign_id, ref_name, to_address, subject, payload, dedupe_key, created_at)
  select c.studio_id, f.client_id, c.channel, 'campaign', c.id, c.name,
         case c.channel when 'sms' then btrim(f.phone) else btrim(f.email) end,
         case when c.channel = 'email' then app.marketing_merge(c.subject, jsonb_build_object('first_name', f.first_name, 'last_name', f.last_name, 'studio_name', st.name)) end,
         jsonb_build_object('first_name', f.first_name, 'last_name', f.last_name),
         'c:' || c.id || ':' || f.client_id, p_now
    from app.marketing_audience(c.studio_id, v_filter, p_now) f
    cross join (select name from public.studios where id = c.studio_id) st
   where f.opt_in and case c.channel when 'sms' then btrim(coalesce(f.phone, '')) <> '' else btrim(coalesce(f.email, '')) <> '' end
  on conflict (studio_id, dedupe_key) do nothing;
  get diagnostics v_queued = row_count;

  update public.marketing_campaigns
     set status = case when v_queued = 0 then 'sent' else 'sending' end, sent_at = p_now, scheduled_for = null,
         filter_at_send = v_filter, segment_name = coalesce(v_seg, segment_name, 'All clients'),
         audience = v_queued, skipped = v_total - v_queued, updated_at = p_now
   where id = c.id;
  return v_queued;
end $$;

-- ----------------------------------------------------------------------------- segments + tags

create function public.marketing_list_segments() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  v_now timestamptz := app.now();
  v_tz text := app.studio_tz(app.current_studio_id());
  v_facts app.marketing_fact[];
begin
  perform app.marketing_need('view');
  perform app.marketing_ensure(v_studio);
  v_facts := array(select f from app.marketing_facts(v_studio, v_now) f);
  return coalesce((
    select jsonb_agg(app.marketing_segment_json(s) || jsonb_build_object(
             'count', (select count(*) from unnest(v_facts) f where app.marketing_filter_ok(f, s.filter, v_now, v_tz)),
             'optedIn', (select count(*) from unnest(v_facts) f where f.opt_in and app.marketing_filter_ok(f, s.filter, v_now, v_tz)))
           order by s.created_at, lower(s.name))
      from public.marketing_segments s where s.studio_id = v_studio), '[]'::jsonb);
end $$;

create function public.marketing_preview_audience(p_filter jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id(); v_filter jsonb;
begin
  perform app.marketing_need('view');
  v_filter := app.marketing_clean_filter(p_filter);
  return (
    with hit as (select * from app.marketing_audience(v_studio, v_filter, app.now()))
    select jsonb_build_object(
      'count', (select count(*) from hit), 'optedIn', (select count(*) from hit where opt_in),
      'sample', coalesce((select jsonb_agg(jsonb_build_object('clientId', x.client_id, 'firstName', x.first_name, 'lastName', x.last_name, 'optIn', x.opt_in))
                            from (select * from hit order by lower(first_name), lower(last_name), client_id limit 6) x), '[]'::jsonb)));
end $$;

create function public.marketing_save_segment(p_id uuid, p_name text, p_description text, p_filter jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_desc text := nullif(left(btrim(coalesce(p_description, '')), 140), '');
  v_filter jsonb;
  s public.marketing_segments;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(v_studio);
  perform app.marketing_ensure(v_studio);
  if v_name = '' then perform app.fail('INVALID', 'Give the segment a name.'); end if;
  if char_length(v_name) > 60 then perform app.fail('INVALID', 'Segment names can be up to 60 characters.'); end if;
  v_filter := app.marketing_clean_filter(p_filter);
  if exists (select 1 from public.marketing_segments where studio_id = v_studio and lower(name) = lower(v_name) and id is distinct from p_id) then
    perform app.fail('INVALID', 'You already have a segment with that name.');
  end if;
  if p_id is not null then
    perform app.assert_in_studio('marketing_segments', p_id, 'We couldn''t find that segment.');
    update public.marketing_segments set name = v_name, description = v_desc, filter = v_filter
     where id = p_id and studio_id = v_studio returning * into s;
    if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that segment.'); end if;
  else
    insert into public.marketing_segments (studio_id, name, description, filter, created_by)
    values (v_studio, v_name, v_desc, v_filter, public.current_staff_id()) returning * into s;
  end if;
  return app.marketing_segment_json(s);
end $$;

create function public.marketing_delete_segment(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id();
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(v_studio);
  perform app.assert_in_studio('marketing_segments', p_id, 'We couldn''t find that segment.');
  if not exists (select 1 from public.marketing_segments where id = p_id and studio_id = v_studio) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that segment.');
  end if;
  if exists (select 1 from public.marketing_campaigns where segment_id = p_id and status in ('draft', 'scheduled')) then
    perform app.fail('INVALID', 'A draft or scheduled campaign still uses this segment. Change or delete that campaign first.');
  end if;
  delete from public.marketing_segments where id = p_id and studio_id = v_studio;
end $$;

create function public.marketing_list_tags() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('tag', x.tag, 'count', x.n) order by x.n desc, x.tag)
      from (select min(t.tag) as tag, count(*) as n
              from public.marketing_client_tags t join public.clients c on c.id = t.client_id and not c.archived
             where t.studio_id = app.current_studio_id() group by lower(t.tag)) x), '[]'::jsonb);
end $$;

create function public.marketing_get_client_tags(p_client_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('view');
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  if not exists (select 1 from public.clients where id = p_client_id and studio_id = app.current_studio_id()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  return coalesce((select jsonb_agg(tag order by tag) from public.marketing_client_tags
                    where studio_id = app.current_studio_id() and client_id = p_client_id), '[]'::jsonb);
end $$;

create function public.marketing_set_client_tags(p_client_id uuid, p_tags text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id(); v_clean text[] := '{}'; t text; x text;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(v_studio);
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  if not exists (select 1 from public.clients where id = p_client_id and studio_id = v_studio) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  foreach x in array coalesce(p_tags, '{}') loop
    t := left(btrim(regexp_replace(coalesce(x, ''), '\s+', ' ', 'g')), 24);
    if t = '' or exists (select 1 from unnest(v_clean) y where lower(y) = lower(t)) then continue; end if;
    v_clean := v_clean || t;
  end loop;
  if cardinality(v_clean) > 10 then perform app.fail('INVALID', 'A client can have up to 10 tags.'); end if;
  delete from public.marketing_client_tags where studio_id = v_studio and client_id = p_client_id;
  insert into public.marketing_client_tags (studio_id, client_id, tag) select v_studio, p_client_id, u from unnest(v_clean) u;
  return to_jsonb(v_clean);
end $$;

-- ----------------------------------------------------------------------------- campaigns

create function public.marketing_list_campaigns() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('view');
  return coalesce((
    select jsonb_agg(app.marketing_campaign_json(c)
             order by case c.status when 'scheduled' then 0 when 'draft' then 1 else 2 end, coalesce(c.sent_at, c.scheduled_for, c.created_at) desc)
      from public.marketing_campaigns c where c.studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

create function public.marketing_get_campaign(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.marketing_campaigns;
begin
  perform app.marketing_need('view');
  select * into c from public.marketing_campaigns where id = p_id and studio_id = app.current_studio_id();
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that campaign.'); end if;
  return jsonb_build_object(
    'campaign', app.marketing_campaign_json(c),
    'segment', (select app.marketing_segment_json(s) from public.marketing_segments s where s.id = c.segment_id),
    'recipients', coalesce((select jsonb_agg(app.marketing_log_json(m) order by m.sent_at desc nulls last, m.created_at desc)
                              from (select * from public.marketing_messages m where m.studio_id = c.studio_id and m.campaign_id = c.id
                                     order by m.sent_at desc nulls last, m.created_at desc limit 200) m), '[]'::jsonb));
end $$;

create function public.marketing_save_campaign(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  v_id uuid := nullif(p_input ->> 'id', '')::uuid;
  v_name text := btrim(coalesce(p_input ->> 'name', ''));
  v_channel text := case when p_input ->> 'channel' = 'sms' then 'sms' else 'email' end;
  v_seg uuid := nullif(p_input ->> 'segmentId', '')::uuid;
  v_seg_name text := 'All clients';
  v_blocks jsonb;
  c public.marketing_campaigns;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(v_studio);
  if v_name = '' then perform app.fail('INVALID', 'Give the campaign a name so you can find it later.'); end if;
  if char_length(v_name) > 80 then perform app.fail('INVALID', 'Campaign names can be up to 80 characters.'); end if;
  if v_seg is not null then
    perform app.assert_in_studio('marketing_segments', v_seg, 'We couldn''t find that segment.');
    select name into v_seg_name from public.marketing_segments where id = v_seg and studio_id = v_studio;
    if v_seg_name is null then perform app.fail('NOT_FOUND', 'We couldn''t find that segment.'); end if;
  end if;
  v_blocks := case when v_channel = 'email' then app.marketing_clean_blocks(p_input -> 'blocks') else '[]'::jsonb end;
  if v_id is not null then
    perform app.assert_in_studio('marketing_campaigns', v_id, 'We couldn''t find that campaign.');
    select * into c from public.marketing_campaigns where id = v_id and studio_id = v_studio for update;
    if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that campaign.'); end if;
    if c.status <> 'draft' then
      perform app.fail('INVALID', case when c.status = 'scheduled' then 'Unschedule this campaign before changing it.'
                                       else 'Sent campaigns can''t be changed. Duplicate it to send something similar.' end);
    end if;
    update public.marketing_campaigns set
      name = v_name, channel = v_channel, segment_id = v_seg, segment_name = v_seg_name,
      subject = case when v_channel = 'email' then left(btrim(coalesce(p_input ->> 'subject', '')), 150) end,
      preheader = case when v_channel = 'email' then left(btrim(coalesce(p_input ->> 'preheader', '')), 140) end,
      blocks = v_blocks,
      body = case when v_channel = 'sms' then left(btrim(replace(coalesce(p_input ->> 'body', ''), E'\r\n', E'\n')), 1000) end,
      updated_at = app.now()
     where id = v_id returning * into c;
  else
    insert into public.marketing_campaigns (studio_id, name, channel, segment_id, segment_name, subject, preheader, blocks, body, created_by, created_by_name)
    values (v_studio, v_name, v_channel, v_seg, v_seg_name,
            case when v_channel = 'email' then left(btrim(coalesce(p_input ->> 'subject', '')), 150) end,
            case when v_channel = 'email' then left(btrim(coalesce(p_input ->> 'preheader', '')), 140) end,
            v_blocks,
            case when v_channel = 'sms' then left(btrim(replace(coalesce(p_input ->> 'body', ''), E'\r\n', E'\n')), 1000) end,
            public.current_staff_id(), (select name from public.staff where id = public.current_staff_id()))
    returning * into c;
  end if;
  return app.marketing_campaign_json(c);
end $$;

create function public.marketing_delete_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.marketing_campaigns;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('marketing_campaigns', p_id, 'We couldn''t find that campaign.');
  select * into c from public.marketing_campaigns where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that campaign.'); end if;
  if c.status in ('sent', 'sending', 'failed') then perform app.fail('INVALID', 'Sent campaigns are kept so your numbers stay right.'); end if;
  delete from public.marketing_campaigns where id = p_id;
end $$;

create function public.marketing_send_campaign(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.marketing_campaigns; v_filter jsonb; n integer;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('marketing_campaigns', p_id, 'We couldn''t find that campaign.');
  select * into c from public.marketing_campaigns where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that campaign.'); end if;
  if c.status not in ('draft', 'scheduled') then perform app.fail('INVALID', 'That campaign has already gone out.'); end if;
  perform app.marketing_check_send(c);
  v_filter := coalesce((select filter from public.marketing_segments where id = c.segment_id), '{"match":"all","rules":[]}'::jsonb);
  select count(*) into n from app.marketing_audience(c.studio_id, v_filter, app.now()) f
   where f.opt_in and case c.channel when 'sms' then btrim(coalesce(f.phone, '')) <> '' else btrim(coalesce(f.email, '')) <> '' end;
  if n = 0 then perform app.fail('INVALID', 'Nobody in this audience has opted into marketing yet, so there''s no one to send to.'); end if;
  perform app.marketing_start_campaign(c.id, app.now());
  return (select app.marketing_campaign_json(x) from public.marketing_campaigns x where x.id = c.id);
end $$;

create function public.marketing_schedule_campaign(p_id uuid, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.marketing_campaigns;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('marketing_campaigns', p_id, 'We couldn''t find that campaign.');
  select * into c from public.marketing_campaigns where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that campaign.'); end if;
  if c.status not in ('draft', 'scheduled') then perform app.fail('INVALID', 'That campaign has already gone out.'); end if;
  perform app.marketing_check_send(c);
  if p_at is null then perform app.fail('INVALID', 'Pick a date and time.'); end if;
  if p_at < app.now() + interval '1 minute' then perform app.fail('INVALID', 'Pick a time in the future.'); end if;
  if p_at > app.now() + interval '365 days' then perform app.fail('INVALID', 'Pick a time within the next year.'); end if;
  update public.marketing_campaigns set status = 'scheduled', scheduled_for = p_at, updated_at = app.now() where id = p_id returning * into c;
  return app.marketing_campaign_json(c);
end $$;

create function public.marketing_unschedule_campaign(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.marketing_campaigns;
begin
  perform app.marketing_need('manage');
  perform app.assert_in_studio('marketing_campaigns', p_id, 'We couldn''t find that campaign.');
  select * into c from public.marketing_campaigns where id = p_id and studio_id = app.current_studio_id() for update;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that campaign.'); end if;
  if c.status <> 'scheduled' then perform app.fail('INVALID', 'That campaign isn''t scheduled.'); end if;
  update public.marketing_campaigns set status = 'draft', scheduled_for = null, updated_at = app.now() where id = p_id returning * into c;
  return app.marketing_campaign_json(c);
end $$;

-- ----------------------------------------------------------------------------- automations

create function public.marketing_list_automations() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id();
begin
  perform app.marketing_need('view');
  perform app.marketing_ensure(v_studio);
  return coalesce((
    select jsonb_agg(app.marketing_automation_json(a) || jsonb_build_object('sentLast30Days', (
             select count(*) from public.marketing_messages m
              where m.studio_id = v_studio and m.source = 'automation' and m.automation_key = a.key and m.status = 'sent'
                and m.sent_at >= app.now() - interval '30 days'))
           order by array_position(array['welcome', 'welcome_followup', 'intro_ending', 'pack_low', 'winback', 'birthday', 'after_first_class', 'paused_ending'], a.key))
      from public.marketing_automations a where a.studio_id = v_studio), '[]'::jsonb);
end $$;

create function public.marketing_save_automation(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  a public.marketing_automations;
  v_min integer; v_max integer; v_delay integer;
  v_body text;
begin
  perform app.marketing_need('manage');
  perform app.assert_studio_open(v_studio);
  perform app.marketing_ensure(v_studio);
  select * into a from public.marketing_automations where studio_id = v_studio and key = p_input ->> 'key' for update;
  if a.key is null then perform app.fail('NOT_FOUND', 'We couldn''t find that automation.'); end if;
  select lo, hi into v_min, v_max from (values ('welcome', 0, 14), ('welcome_followup', 1, 21), ('intro_ending', 1, 10), ('pack_low', 1, 30),
    ('winback', 7, 180), ('birthday', 0, 7), ('after_first_class', 0, 7), ('paused_ending', 1, 14)) d(k, lo, hi) where d.k = a.key;
  if p_input ? 'enabled' then a.enabled := coalesce((p_input ->> 'enabled')::boolean, a.enabled); end if;
  if p_input ? 'channel' then a.channel := case when p_input ->> 'channel' = 'sms' then 'sms' else 'email' end; end if;
  if p_input ? 'delay' then
    v_delay := round((p_input ->> 'delay')::numeric);
    if v_delay is null or v_delay < v_min or v_delay > v_max then perform app.fail('INVALID', format('Choose between %s and %s days.', v_min, v_max)); end if;
    a.delay_days := v_delay;
  end if;
  if p_input ? 'subject' then a.subject := btrim(p_input ->> 'subject'); end if;
  if p_input ? 'heading' then a.heading := btrim(p_input ->> 'heading'); end if;
  if p_input ? 'body' then v_body := btrim(replace(p_input ->> 'body', E'\r\n', E'\n')); a.body := v_body; end if;
  if p_input ? 'buttonLabel' then a.button_label := btrim(p_input ->> 'buttonLabel'); end if;
  if char_length(a.subject) > 150 or char_length(a.heading) > 120 or char_length(a.body) > 3000 or char_length(a.button_label) > 40 then
    perform app.fail('INVALID', 'That''s too long. Keep it a little shorter.');
  end if;
  if a.enabled then
    if a.channel = 'email' and a.subject = '' then perform app.fail('INVALID', 'Add a subject line first.'); end if;
    if a.body = '' then perform app.fail('INVALID', 'Write the message first.'); end if;
    if a.channel = 'sms' and char_length(a.body) > 600 then perform app.fail('INVALID', 'That text is too long for an SMS. Keep it to about 600 characters.'); end if;
  end if;
  update public.marketing_automations set enabled = a.enabled, channel = a.channel, delay_days = a.delay_days, subject = a.subject,
         heading = a.heading, body = a.body, button_label = a.button_label, updated_at = app.now()
   where studio_id = v_studio and key = a.key returning * into a;
  return app.marketing_automation_json(a);
end $$;

-- Dry run: who would get what right now. Real run: queue them (once each, the sent log stops repeats).
create function public.marketing_run_automations(p_dry_run boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id(); v_now timestamptz := app.now(); v_plan jsonb;
begin
  perform app.marketing_need(case when coalesce(p_dry_run, true) then 'view' else 'manage' end);
  perform app.marketing_ensure(v_studio);
  select jsonb_build_object(
    'dryRun', coalesce(p_dry_run, true),
    'items', coalesce(jsonb_agg(jsonb_build_object('key', p.automation_key, 'automationName', p.automation_name, 'clientId', p.client_id,
               'clientName', p.client_name, 'channel', p.channel, 'to', p.to_address, 'subject', p.subject, 'preview', p.preview,
               'reason', p.reason, 'dedupeKey', p.dedupe_key)
               order by array_position(array['welcome', 'welcome_followup', 'intro_ending', 'pack_low', 'winback', 'birthday', 'after_first_class', 'paused_ending'], p.automation_key), p.client_name)
             filter (where p.reachable), '[]'::jsonb),
    'skipped', coalesce(jsonb_agg(jsonb_build_object('key', p.automation_key, 'clientName', p.client_name, 'why', p.why) order by p.client_name)
             filter (where not p.reachable), '[]'::jsonb))
    into v_plan
    from app.marketing_plan_automations(v_studio, v_now) p;
  if not coalesce(p_dry_run, true) then
    perform app.assert_studio_open(v_studio);
    perform app.marketing_queue_automations(v_studio, v_now);
  end if;
  return v_plan;
end $$;

create function public.marketing_message_log(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('view');
  return coalesce((
    select jsonb_agg(app.marketing_log_json(m) order by coalesce(m.sent_at, m.created_at) desc)
      from (select * from public.marketing_messages
             where studio_id = app.current_studio_id() and source in ('campaign', 'automation')
             order by coalesce(sent_at, created_at) desc limit least(greatest(coalesce(p_limit, 50), 1), 500)) m), '[]'::jsonb);
end $$;

-- ----------------------------------------------------------------------------- inbox

-- Post a message in a client's thread (creating the thread), and queue a push to the other side's devices.
create function app.marketing_post(p_studio uuid, p_client uuid, p_sender text, p_staff uuid, p_body text) returns public.marketing_thread_messages
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_body text := btrim(replace(coalesce(p_body, ''), E'\r\n', E'\n'));
  t public.marketing_threads;
  m public.marketing_thread_messages;
  v_now timestamptz := app.now();
begin
  if v_body = '' then perform app.fail('INVALID', 'Write a message first.'); end if;
  if char_length(v_body) > 2000 then perform app.fail('INVALID', 'Messages can be up to 2,000 characters.'); end if;
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
  -- Push notification for the other side, if they have a device registered (sent by the marketing-push function).
  if exists (select 1 from public.marketing_push_devices d where d.studio_id = p_studio
              and case when p_sender = 'staff' then d.client_id = p_client else d.staff_id is not null end) then
    insert into public.marketing_messages (studio_id, client_id, channel, source, ref_name, subject, payload, dedupe_key, created_at)
    values (p_studio, p_client, 'push', 'inbox', 'Message', null,
            jsonb_build_object('audience', case when p_sender = 'staff' then 'client' else 'staff' end, 'threadId', t.id, 'messageId', m.id,
                               'preview', left(regexp_replace(v_body, '\s+', ' ', 'g'), 120)),
            'inbox:' || m.id, v_now)
    on conflict (studio_id, dedupe_key) do nothing;
  end if;
  return m;
end $$;

create function public.marketing_list_threads() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('inbox');
  return coalesce((
    select jsonb_agg(app.marketing_thread_json(t) order by t.last_message_at desc)
      from public.marketing_threads t join public.clients c on c.id = t.client_id and not c.archived
     where t.studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

create function public.marketing_get_thread(p_client_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.marketing_threads;
begin
  perform app.marketing_need('inbox');
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  if not exists (select 1 from public.clients where id = p_client_id and studio_id = app.current_studio_id()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  select * into t from public.marketing_threads where studio_id = app.current_studio_id() and client_id = p_client_id;
  return jsonb_build_object(
    'thread', case when t.id is null then null else app.marketing_thread_json(t) end,
    'messages', coalesce((select jsonb_agg(app.marketing_tmsg_json(m) order by m.created_at, m.id)
                            from public.marketing_thread_messages m where m.thread_id = t.id), '[]'::jsonb));
end $$;

create function public.marketing_send_staff_message(p_client_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id();
begin
  perform app.marketing_need('inbox');
  perform app.assert_studio_open(v_studio);
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  if not exists (select 1 from public.clients where id = p_client_id and studio_id = v_studio) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  return app.marketing_tmsg_json(app.marketing_post(v_studio, p_client_id, 'staff', public.current_staff_id(), p_body));
end $$;

create function public.marketing_mark_thread_read(p_client_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('inbox');
  update public.marketing_threads set staff_unread = 0
   where studio_id = app.current_studio_id() and client_id = p_client_id and staff_unread <> 0;
end $$;

create function public.marketing_inbox_unread() returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('inbox');
  return coalesce((select sum(t.staff_unread)::integer from public.marketing_threads t join public.clients c on c.id = t.client_id and not c.archived
                    where t.studio_id = app.current_studio_id()), 0);
end $$;

-- The signed-in client's own conversation.
create function app.marketing_me() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid := public.current_client_id();
begin
  if v is null then perform app.fail('NOT_ALLOWED', 'Sign in to message the studio.'); end if;
  return v;
end $$;

create function public.marketing_my_thread() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.marketing_threads;
begin
  select * into t from public.marketing_threads where studio_id = app.current_studio_id() and client_id = app.marketing_me();
  if t.id is null then return jsonb_build_object('messages', '[]'::jsonb, 'unread', 0); end if;
  return jsonb_build_object('threadId', t.id, 'unread', t.client_unread,
    'messages', coalesce((select jsonb_agg(app.marketing_tmsg_json(m) order by m.created_at, m.id)
                            from public.marketing_thread_messages m where m.thread_id = t.id), '[]'::jsonb));
end $$;

create function public.marketing_send_my_message(p_body text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid := app.marketing_me();
begin
  perform app.assert_studio_open(app.current_studio_id());
  return app.marketing_tmsg_json(app.marketing_post(app.current_studio_id(), v_client, 'client', null, p_body));
end $$;

create function public.marketing_mark_my_thread_read() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.marketing_threads set client_unread = 0
   where studio_id = app.current_studio_id() and client_id = app.marketing_me() and client_unread <> 0;
end $$;

create function public.marketing_my_unread() returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid := public.current_client_id();
begin
  if v is null then return 0; end if;
  return coalesce((select client_unread from public.marketing_threads where studio_id = app.current_studio_id() and client_id = v), 0);
end $$;

-- ----------------------------------------------------------------------------- push devices

create function public.marketing_push_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id(); v_staff boolean := public.is_staff();
begin
  if auth.uid() is null then perform app.fail('NOT_ALLOWED', 'Sign in first.'); end if;
  return jsonb_build_object(
    'registered', exists (select 1 from public.marketing_push_devices where studio_id = v_studio and user_id = auth.uid()),
    'needsKeys', true,
    'devices', (select jsonb_build_object('web', count(*) filter (where platform = 'web'), 'ios', count(*) filter (where platform = 'ios'),
                                          'android', count(*) filter (where platform = 'android'))
                  from public.marketing_push_devices where studio_id = v_studio and (v_staff or user_id = auth.uid())));
end $$;

create function public.marketing_register_push(p_platform text, p_token text, p_keys jsonb default null, p_user_agent text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id();
begin
  if auth.uid() is null or not app.is_member_of(v_studio) then perform app.fail('NOT_ALLOWED', 'Sign in first.'); end if;
  if coalesce(p_platform, '') not in ('web', 'ios', 'android') then perform app.fail('INVALID', 'Unknown device type.'); end if;
  if coalesce(p_token, '') = '' or char_length(p_token) > 2000 then perform app.fail('INVALID', 'That device can''t be registered.'); end if;
  insert into public.marketing_push_devices (studio_id, user_id, client_id, staff_id, platform, token, keys, user_agent)
  values (v_studio, auth.uid(), public.current_client_id(), public.current_staff_id(), p_platform, p_token, p_keys, left(p_user_agent, 300))
  on conflict (studio_id, token) do update set user_id = excluded.user_id, client_id = excluded.client_id, staff_id = excluded.staff_id,
    platform = excluded.platform, keys = excluded.keys, user_agent = excluded.user_agent, last_seen_at = app.now();
end $$;

create function public.marketing_unregister_push(p_token text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then perform app.fail('NOT_ALLOWED', 'Sign in first.'); end if;
  delete from public.marketing_push_devices where studio_id = app.current_studio_id() and token = p_token and user_id = auth.uid();
end $$;

-- ----------------------------------------------------------------------------- settings

create function public.marketing_get_settings() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.marketing_need('view');
  perform app.marketing_ensure(app.current_studio_id());
  return app.marketing_settings_json(app.current_studio_id());
end $$;

create function public.marketing_update_settings(p_patch jsonb) returns jsonb
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
  return app.marketing_settings_json(v_studio);
end $$;

-- ----------------------------------------------------------------------------- grants

revoke execute on function app.marketing_iso(timestamptz), app.marketing_filter_ok(app.marketing_fact, jsonb, timestamptz, text),
  app.marketing_segment_json(public.marketing_segments), app.marketing_campaign_json(public.marketing_campaigns),
  app.marketing_log_json(public.marketing_messages), app.marketing_automation_json(public.marketing_automations),
  app.marketing_thread_json(public.marketing_threads), app.marketing_tmsg_json(public.marketing_thread_messages),
  app.marketing_settings_json(uuid), app.marketing_clean_blocks(jsonb), app.marketing_check_send(public.marketing_campaigns),
  app.marketing_start_campaign(uuid, timestamptz), app.marketing_post(uuid, uuid, text, uuid, text), app.marketing_me()
  from public, anon, authenticated;
grant execute on function app.marketing_iso(timestamptz), app.marketing_filter_ok(app.marketing_fact, jsonb, timestamptz, text),
  app.marketing_segment_json(public.marketing_segments), app.marketing_campaign_json(public.marketing_campaigns),
  app.marketing_log_json(public.marketing_messages), app.marketing_automation_json(public.marketing_automations),
  app.marketing_thread_json(public.marketing_threads), app.marketing_tmsg_json(public.marketing_thread_messages),
  app.marketing_settings_json(uuid), app.marketing_clean_blocks(jsonb), app.marketing_check_send(public.marketing_campaigns),
  app.marketing_start_campaign(uuid, timestamptz), app.marketing_post(uuid, uuid, text, uuid, text), app.marketing_me()
  to service_role;

revoke execute on function public.marketing_list_segments, public.marketing_preview_audience, public.marketing_save_segment,
  public.marketing_delete_segment, public.marketing_list_tags, public.marketing_get_client_tags, public.marketing_set_client_tags,
  public.marketing_list_campaigns, public.marketing_get_campaign, public.marketing_save_campaign, public.marketing_delete_campaign,
  public.marketing_send_campaign, public.marketing_schedule_campaign, public.marketing_unschedule_campaign,
  public.marketing_list_automations, public.marketing_save_automation, public.marketing_run_automations, public.marketing_message_log,
  public.marketing_list_threads, public.marketing_get_thread, public.marketing_send_staff_message, public.marketing_mark_thread_read,
  public.marketing_inbox_unread, public.marketing_my_thread, public.marketing_send_my_message, public.marketing_mark_my_thread_read,
  public.marketing_my_unread, public.marketing_push_status, public.marketing_register_push, public.marketing_unregister_push,
  public.marketing_get_settings, public.marketing_update_settings
  from public, anon;
grant execute on function public.marketing_list_segments, public.marketing_preview_audience, public.marketing_save_segment,
  public.marketing_delete_segment, public.marketing_list_tags, public.marketing_get_client_tags, public.marketing_set_client_tags,
  public.marketing_list_campaigns, public.marketing_get_campaign, public.marketing_save_campaign, public.marketing_delete_campaign,
  public.marketing_send_campaign, public.marketing_schedule_campaign, public.marketing_unschedule_campaign,
  public.marketing_list_automations, public.marketing_save_automation, public.marketing_run_automations, public.marketing_message_log,
  public.marketing_list_threads, public.marketing_get_thread, public.marketing_send_staff_message, public.marketing_mark_thread_read,
  public.marketing_inbox_unread, public.marketing_my_thread, public.marketing_send_my_message, public.marketing_mark_my_thread_read,
  public.marketing_my_unread, public.marketing_push_status, public.marketing_register_push, public.marketing_unregister_push,
  public.marketing_get_settings, public.marketing_update_settings
  to authenticated;
