-- =============================================================================
-- Libby's feedback, round two (27 Oct).
--
--  1. Client emails that were missing: "You're on the waitlist" (trigger on bookings), "Booking cancelled" (the client cancels;
--     late cancels get their own wording) and "Welcome to the studio" (first sign-up). The existing three (booking confirmed,
--     waitlist promoted, class cancelled by the studio) already fire through app.notify.
--  2. Settings > Emails: email_templates holds a studio's own wording (subject, intro) and an on/off switch per email. The edge
--     functions read it (supabase/functions/_shared/email.ts) and app.notify skips an email the studio turned off.
--  3. Automations Libby ran by hand: "Intro offer check-in" (N days into the intro offer, default 7 of 14). The Welcome
--     automation in Marketing stays the owner of the welcome email for anyone who opted in; the transactional welcome only goes
--     when that automation is off (or the marketing feature was never opened) or the client didn't opt in.
--  4. Google review nudge every N classes (reviews_settings.google_ask_*): a marketing automation ('review_ask') that emails the
--     link after a client's Nth, 2Nth ... check-in, at most once every 60 days, and never again once they've clicked.
--  5. One-off text to a client (marketing_send_text): sent through the marketing SMS provider (Twilio, or the logging stub),
--     logged in the client's message history.
-- =============================================================================

-- A throwaway helper (as in 2400): rewrite part of an existing function, failing loudly if the text isn't found.
create function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;

-- ----------------------------------------------------------------------------- 2. the studio's own email wording
create table public.email_templates (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete cascade,
  kind text not null check (kind in ('booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome')),
  enabled boolean not null default true,
  subject text check (subject is null or char_length(subject) <= 150),
  intro text check (intro is null or char_length(intro) <= 1500),
  updated_at timestamptz not null default now(),
  primary key (studio_id, kind)
);
select app.scope_table('email_templates');
create policy email_templates_read on public.email_templates for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.email_templates to authenticated;

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('booking_confirmed', 'waitlist_promoted', 'class_cancelled', 'receipt', 'class_reminder', 'late_cancel', 'waitlist_joined', 'booking_cancelled', 'welcome'));

-- Is this email switched on for the studio? (No row = on.)
create function app.email_on(p_studio uuid, p_kind text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select t.enabled from public.email_templates t where t.studio_id = p_studio and t.kind = p_kind), true)
$$;

-- app.notify (a booking's email) now respects the switch.
select app.patch_function('app.notify(uuid, text, jsonb)'::regprocedure,
  $q$if r.booking_id is null or coalesce(r.email, '') = '' then return; end if;$q$,
  $q$if r.booking_id is null or coalesce(r.email, '') = '' or not app.email_on(r.studio_id, p_kind) then return; end if;$q$);

-- An email about a client rather than a booking (the welcome).
create function app.notify_client(p_client_id uuid, p_kind text, p_extra jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select c.id as client_id, c.studio_id, c.email, c.first_name, ss.name as studio_name, ss.address, sd.slug, sd.email as studio_email
    into r
    from public.clients c
    join public.studios sd on sd.id = c.studio_id
    left join public.studio_settings ss on ss.studio_id = c.studio_id
   where c.id = p_client_id;
  if r.client_id is null or coalesce(r.email, '') = '' or not app.email_on(r.studio_id, p_kind) then return; end if;
  insert into public.notifications (studio_id, client_id, kind, to_email, payload)
  values (r.studio_id, r.client_id, p_kind, r.email, jsonb_build_object(
    'first_name', r.first_name, 'studio_name', coalesce(r.studio_name, ''), 'studio_slug', r.slug, 'studio_email', r.studio_email, 'address', r.address) || p_extra);
end $$;

-- "You're on the waitlist" and "Booking cancelled" (the client cancelled; not when the studio cancels the class or staff cancel for them).
create function app.booking_email_triggers() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'waitlisted' then
      perform app.notify(new.id, 'waitlist_joined', jsonb_build_object('waitlist_position', new.waitlist_position));
    end if;
  elsif new.status in ('cancelled', 'late_cancelled') and old.status = 'booked'
        and public.current_client_id() is not null and public.current_staff_id() is null
        and not exists (select 1 from public.class_sessions s where s.id = new.session_id and s.status = 'cancelled') then
    perform app.notify(new.id, 'booking_cancelled',
      jsonb_build_object('late', new.status = 'late_cancelled', 'credit_returned', new.status = 'cancelled' and new.pass_id is not null));
  end if;
  return null;
end $$;
create trigger bookings_email_insert after insert on public.bookings for each row execute function app.booking_email_triggers();
create trigger bookings_email_status after update of status on public.bookings for each row when (old.status is distinct from new.status) execute function app.booking_email_triggers();

-- "Welcome to the studio": the first time someone signs in to a client account (a new sign-up, or a client the studio added who now
-- creates their login). Not for dependants. Marketing's Welcome automation owns the welcome for opted-in clients while it is on.
create function app.client_welcome_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is null or new.archived or new.guardian_client_id is not null or coalesce(new.email, '') = '' then return null; end if;
  if tg_op = 'UPDATE' and old.user_id is not null then return null; end if;
  if new.marketing_opt_in and exists (
       select 1 from public.marketing_settings ms
         join public.marketing_automations a on a.studio_id = ms.studio_id and a.key = 'welcome'
        where ms.studio_id = new.studio_id and a.enabled and a.channel = 'email') then
    return null;   -- the Welcome automation sends it
  end if;
  perform app.notify_client(new.id, 'welcome');
  return null;
end $$;
create trigger clients_welcome_insert after insert on public.clients for each row execute function app.client_welcome_trigger();
create trigger clients_welcome_login after update of user_id on public.clients for each row execute function app.client_welcome_trigger();

create function public.list_email_templates() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can see this.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'enabled', t.enabled, 'subject', t.subject, 'intro', t.intro) order by t.kind)
                     from public.email_templates t where t.studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

-- p_patch: any of { enabled, subject, intro }. A blank subject or intro goes back to the default wording.
create function public.save_email_template(p_kind text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  t public.email_templates;
  v_subject text; v_intro text;
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can change the emails.'); end if;
  perform app.assert_studio_open(v_studio);
  if p_kind is null or p_kind not in ('booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome') then
    perform app.fail('NOT_FOUND', 'We couldn''t find that email.');
  end if;
  select * into t from public.email_templates where studio_id = v_studio and kind = p_kind;
  if t.kind is null then t.studio_id := v_studio; t.kind := p_kind; t.enabled := true; end if;
  if p_patch ? 'enabled' then t.enabled := coalesce((p_patch ->> 'enabled')::boolean, t.enabled); end if;
  if p_patch ? 'subject' then
    v_subject := nullif(btrim(coalesce(p_patch ->> 'subject', '')), '');
    if char_length(coalesce(v_subject, '')) > 150 then perform app.fail('INVALID', 'The subject is a bit long. Keep it under 150 characters.'); end if;
    t.subject := v_subject;
  end if;
  if p_patch ? 'intro' then
    v_intro := nullif(btrim(replace(coalesce(p_patch ->> 'intro', ''), E'\r\n', E'\n')), '');
    if char_length(coalesce(v_intro, '')) > 1500 then perform app.fail('INVALID', 'The intro is a bit long. Keep it under 1500 characters.'); end if;
    t.intro := v_intro;
  end if;
  if t.enabled and t.subject is null and t.intro is null then
    delete from public.email_templates where studio_id = v_studio and kind = p_kind;
  else
    insert into public.email_templates (studio_id, kind, enabled, subject, intro) values (v_studio, p_kind, t.enabled, t.subject, t.intro)
    on conflict (studio_id, kind) do update set enabled = excluded.enabled, subject = excluded.subject, intro = excluded.intro, updated_at = now();
  end if;
  return jsonb_build_object('kind', p_kind, 'enabled', t.enabled, 'subject', t.subject, 'intro', t.intro);
end $$;

-- "Send me a test": queues the email (a made-up booking, whatever the on/off switch says) to the signed-in staff member's own address.
create function public.send_test_email(p_kind text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  st public.staff;
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can send test emails.'); end if;
  if p_kind is null or p_kind not in ('booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome') then
    perform app.fail('NOT_FOUND', 'We couldn''t find that email.');
  end if;
  select * into st from public.staff where id = public.current_staff_id();
  if st.id is null or coalesce(st.email, '') = '' then perform app.fail('INVALID', 'Add an email address to your staff profile first.'); end if;
  insert into public.notifications (studio_id, client_id, kind, to_email, payload)
  values (v_studio, null, p_kind, st.email, jsonb_build_object(
    'is_test', true, 'first_name', split_part(btrim(st.name), ' ', 1), 'class_name', 'Mat Essentials', 'when', app.fmt_when_tz(app.now() + interval '2 days', app.tz()),
    'instructor', 'Julia', 'cancel_reason', 'our instructor is unwell', 'credit_returned', true, 'late', false,
    'cancellation_policy', (select cancellation_policy_text from public.studio_settings where studio_id = v_studio),
    'waitlist_policy', (select waitlist_policy_text from public.studio_settings where studio_id = v_studio)));
  return jsonb_build_object('to', st.email);
end $$;

-- ----------------------------------------------------------------------------- 3 + 4. two more marketing automations
alter table public.marketing_automations drop constraint marketing_automations_key_check;
alter table public.marketing_automations add constraint marketing_automations_key_check
  check (key in ('welcome', 'welcome_followup', 'intro_ending', 'pack_low', 'winback', 'birthday', 'after_first_class', 'paused_ending', 'intro_checkin', 'review_ask'));

select app.patch_function('app.marketing_default_automations()'::regprocedure,
  $q$we’ll sort it out.', 'Open the app')$q$,
  $q$we’ll sort it out.', 'Open the app'),
  ('intro_checkin', true, 'email', 7, 'How are you finding it, {{first_name}}?', 'How’s it *going*?',
   E'Hi {{first_name}}, you’re about halfway through your intro offer, so we wanted to check in. How are you finding it?\n\nIf you’ve found a class or a time you love, here’s what to book next: another session this week keeps the momentum going, and your offer runs until {{ends_on}}. Not sure what suits you? Reply in Messages and we’ll point you to the right class.', 'Book your next class'),
  ('review_ask', true, 'email', 0, 'Would you leave us a Google review?', 'A small *favour*',
   E'Hi {{first_name}}, you’ve been to {{class_count}} classes at {{studio_name}} now, which is so good to see.\n\nIf you’re enjoying it, a quick Google review helps other people find us and means the world to a small studio. It takes about a minute.', 'Leave a Google review')$q$);

-- Studios that already use Marketing get the two new automations (on, default copy).
insert into public.marketing_automations (studio_id, key, enabled, channel, delay_days, subject, heading, body, button_label)
select ms.studio_id, d.key, d.enabled, d.channel, d.delay_days, d.subject, d.heading, d.body, d.button_label
  from public.marketing_settings ms cross join app.marketing_default_automations() d
 where d.key in ('intro_checkin', 'review_ask')
on conflict do nothing;

-- The scheduler's lists: names, display order and the allowed delay.
select app.patch_function('app.marketing_plan_automations(uuid, timestamptz)'::regprocedure,
  $q$when 'after_first_class' then 'After their first class' else 'Membership pause ending' end$q$,
  $q$when 'after_first_class' then 'After their first class' when 'intro_checkin' then 'Intro offer check-in'
           when 'review_ask' then 'Google review ask' else 'Membership pause ending' end$q$);
select app.patch_function('public.marketing_list_automations()'::regprocedure,
  $q$'after_first_class', 'paused_ending'], a.key)$q$, $q$'after_first_class', 'paused_ending', 'intro_checkin', 'review_ask'], a.key)$q$);
select app.patch_function('public.marketing_run_automations(boolean)'::regprocedure,
  $q$'after_first_class', 'paused_ending'], p.automation_key)$q$, $q$'after_first_class', 'paused_ending', 'intro_checkin', 'review_ask'], p.automation_key)$q$);
select app.patch_function('public.marketing_save_automation(jsonb)'::regprocedure,
  $q$('paused_ending', 1, 14)) d(k, lo, hi)$q$, $q$('paused_ending', 1, 14), ('intro_checkin', 1, 13), ('review_ask', 0, 14)) d(k, lo, hi)$q$);

-- Who qualifies. intro_checkin: N days after their intro offer started counting (its expiry minus its length), while it is still running.
-- review_ask: after a client's Nth, 2Nth ... check-in (class ended 3 hours ago), if the studio switched it on in Settings > Reviews, at most
-- once every 60 days, and never again once they've clicked the link.
select app.patch_function('app.marketing_automation_hits(uuid, timestamptz)'::regprocedure,
  $q$    elsif a.key = 'paused_ending' then$q$,
  $q$    elsif a.key = 'intro_checkin' then
      return query
      select a.key, f.client_id, 'intro_checkin:' || f.client_id::text || ':' || (f.intro ->> 'id'),
             'About ' || a.delay_days || ' days into their intro offer',
             jsonb_build_object('ends_on', to_char((f.intro ->> 'ends_at')::timestamptz at time zone v_tz, 'Dy FMDD Mon'))
        from app.marketing_facts(p_studio, p_now) f
        join public.passes ps on ps.id = (f.intro ->> 'id')::uuid
       where f.intro is not null and (f.intro ->> 'ends_at') is not null
         and (f.intro ->> 'ends_at')::timestamptz > p_now
         and (f.intro ->> 'ends_at')::timestamptz - make_interval(days => coalesce(ps.validity_days, 14)) + make_interval(days => a.delay_days) <= p_now
         and p_now < (f.intro ->> 'ends_at')::timestamptz - make_interval(days => coalesce(ps.validity_days, 14)) + make_interval(days => a.delay_days + v_grace);

    elsif a.key = 'review_ask' then
      return query
      with rs as (
        select r.google_ask_every as every_n, r.google_review_url as url from public.reviews_settings r
         where r.studio_id = p_studio and r.google_ask_enabled and r.google_review_url <> ''),
      v as (
        select b.client_id, row_number() over (partition by b.client_id order by coalesce(b.checked_in_at, s.starts_at), b.id) as n, s.ends_at as done_at
          from public.bookings b
          join public.class_sessions s on s.id = b.session_id and s.studio_id = b.studio_id
         where b.studio_id = p_studio and b.status = 'checked_in'),
      hit as (
        select distinct on (v.client_id) v.client_id, v.n
          from v cross join rs
         where v.n % rs.every_n = 0
           and v.done_at + interval '3 hours' + make_interval(days => a.delay_days) <= p_now
           and p_now < v.done_at + interval '3 hours' + make_interval(days => a.delay_days + v_grace)
         order by v.client_id, v.n desc)
      select a.key, h.client_id, 'review_ask:' || h.client_id::text || ':' || h.n, 'Class number ' || h.n,
             jsonb_build_object('class_count', h.n, 'review_url', rs.url)
        from hit h cross join rs
       where not exists (select 1 from public.marketing_messages m
                          where m.studio_id = p_studio and m.client_id = h.client_id and m.automation_key = 'review_ask' and m.status in ('queued', 'sent')
                            and (m.clicked_at is not null or m.created_at > p_now - interval '60 days'));

    elsif a.key = 'paused_ending' then$q$);

-- ----------------------------------------------------------------------------- 4. the Google review ask, in Settings > Reviews
alter table public.reviews_settings add column google_ask_enabled boolean not null default false;
alter table public.reviews_settings add column google_ask_every integer not null default 5 check (google_ask_every between 1 and 100);

drop function public.reviews_save_settings(text);
-- p_google_url: null leaves it alone, '' turns the Google link (and the ask) off. p_ask_enabled / p_ask_every: null leaves them alone.
create function public.reviews_save_settings(p_google_url text default null, p_ask_enabled boolean default null, p_ask_every integer default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url text := btrim(p_google_url);
  s public.reviews_settings;
begin
  perform public.reviews_require(array['owner','manager']);
  perform app.assert_studio_open(app.current_studio_id());
  if v_url is not null and v_url <> '' and (v_url !~* '^https?://' or length(v_url) > 500) then
    perform app.fail('INVALID', 'That doesn''t look like a web address. Start it with https://');
  end if;
  if p_ask_every is not null and p_ask_every not between 1 and 100 then perform app.fail('INVALID', 'Ask every 1 to 100 classes.'); end if;
  insert into public.reviews_settings (studio_id, google_review_url) values (app.current_studio_id(), '') on conflict (studio_id) do nothing;
  select * into s from public.reviews_settings where studio_id = app.current_studio_id() for update;
  if v_url is not null then s.google_review_url := v_url; end if;
  if p_ask_every is not null then s.google_ask_every := p_ask_every; end if;
  if p_ask_enabled is not null then s.google_ask_enabled := p_ask_enabled; end if;
  if s.google_review_url = '' then s.google_ask_enabled := false; end if;
  if p_ask_enabled and s.google_review_url = '' then perform app.fail('INVALID', 'Add your Google review link first.'); end if;
  update public.reviews_settings set google_review_url = s.google_review_url, google_ask_enabled = s.google_ask_enabled, google_ask_every = s.google_ask_every, updated_at = now()
   where studio_id = s.studio_id;
  return (select to_jsonb(r) - 'studio_id' from public.reviews_settings r where studio_id = app.current_studio_id());
end $$;
revoke all on function public.reviews_save_settings(text, boolean, integer) from public, anon;
grant execute on function public.reviews_save_settings(text, boolean, integer) to authenticated;

-- ----------------------------------------------------------------------------- 5. one-off texts
alter table public.marketing_thread_messages add column channel text not null default 'app' check (channel in ('app', 'sms'));
select app.patch_function('app.marketing_tmsg_json(public.marketing_thread_messages)'::regprocedure,
  $q$'body', m.body, 'at'$q$, $q$'body', m.body, 'channel', m.channel, 'at'$q$);

-- Staff text to one client: logged in their message history, sent by the marketing drain (Twilio, or the logging stub). Needs a mobile number.
create function public.marketing_send_text(p_client_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_studio uuid := app.current_studio_id();
  v_body text := btrim(replace(coalesce(p_body, ''), E'\r\n', E'\n'));
  v_now timestamptz := app.now();
  c public.clients;
  t public.marketing_threads;
  m public.marketing_thread_messages;
begin
  perform app.marketing_need('inbox');
  perform app.assert_studio_open(v_studio);
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  select * into c from public.clients where id = p_client_id and studio_id = v_studio;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;
  if btrim(coalesce(c.phone, '')) = '' then perform app.fail('NO_PHONE', format('%s doesn''t have a mobile number saved.', c.first_name)); end if;
  if v_body = '' then perform app.fail('INVALID', 'Write a message first.'); end if;
  if char_length(v_body) > 480 then perform app.fail('INVALID', 'Texts can be up to 480 characters (3 texts).'); end if;
  insert into public.marketing_threads (studio_id, client_id, created_at, last_message_at) values (v_studio, p_client_id, v_now, v_now)
    on conflict (studio_id, client_id) do update set last_message_at = excluded.last_message_at returning * into t;
  insert into public.marketing_thread_messages (studio_id, thread_id, client_id, sender, staff_id, body, channel, created_at)
    values (v_studio, t.id, p_client_id, 'staff', public.current_staff_id(), v_body, 'sms', v_now) returning * into m;
  update public.marketing_threads set last_message_at = v_now, last_message_preview = left(regexp_replace('Text: ' || v_body, '\s+', ' ', 'g'), 140),
         last_from = 'staff', staff_unread = 0 where id = t.id;
  insert into public.marketing_messages (studio_id, client_id, channel, source, ref_name, to_address, payload, dedupe_key, created_at)
    values (v_studio, p_client_id, 'sms', 'inbox', 'Text', btrim(c.phone), jsonb_build_object('body', v_body, 'messageId', m.id), 'sms:' || m.id, v_now);
  return app.marketing_tmsg_json(m);
end $$;
revoke all on function public.marketing_send_text(uuid, text) from public, anon;
grant execute on function public.marketing_send_text(uuid, text) to authenticated;

revoke all on function app.email_on(uuid, text), app.notify_client(uuid, text, jsonb), app.booking_email_triggers(), app.client_welcome_trigger()
  from public, anon, authenticated;
grant execute on function app.email_on(uuid, text), app.notify_client(uuid, text, jsonb) to service_role;
revoke all on function public.list_email_templates(), public.save_email_template(text, jsonb), public.send_test_email(text) from public, anon;
grant execute on function public.list_email_templates(), public.save_email_template(text, jsonb), public.send_test_email(text) to authenticated;

drop function app.patch_function(regprocedure, text, text);
