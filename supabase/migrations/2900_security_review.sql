-- =============================================================================
-- 2900: security review fixes (docs/SECURITY-REVIEW.md).
--
--   1. staff_public / sessions_with_counts are read-only views. They were auto-updatable and ran with the owner's
--      rights, so anyone (even signed out) could UPDATE or DELETE staff rows through them, past RLS.
--   2. A person with no client row in the studio they name could read and overwrite another client's records by id
--      (credit summary, bookings, waiver and health form, health check, interest list, intro eligibility). The guard
--      `if not (a or b or c)` is NULL, not false, when the caller has no client id, so the refusal never ran.
--   3. A studio's logo SVG is rendered as markup, so it is checked on the way in (no scripts, handlers or external
--      references) and its website must be http(s).
--   4. The avatars bucket no longer lets signed-out people list every client's photo path.
--   5. The kiosk exit PIN locks for 5 minutes after 5 wrong tries.
-- =============================================================================

-- ----------------------------------------------------------------------------- 1. read-only views
revoke all on public.staff_public, public.sessions_with_counts from public, anon, authenticated;
grant select on public.staff_public, public.sessions_with_counts to anon, authenticated;

-- ----------------------------------------------------------------------------- 2. NULL-safe guards
CREATE OR REPLACE FUNCTION app.is_intro_eligible_impl(p_client_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_client uuid := coalesce(p_client_id, public.current_client_id());
begin
  if v_client is null then return true; end if;  -- not signed up yet = new client
  if not coalesce((app.is_privileged() or v_client = public.current_client_id() or public.is_staff()), false) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  return not exists (select 1 from public.clients where id = v_client and intro_ineligible)
     and not exists (select 1 from public.passes where client_id = v_client);
end $function$;

CREATE OR REPLACE FUNCTION app.submit_waiver_impl(p_client_id uuid, p_health jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_now timestamptz := app.now();
begin
  if not coalesce((app.is_privileged() or p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id) or public.is_staff()), false) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  update public.clients
     set health_form = coalesce(p_health, '{}'::jsonb) || jsonb_build_object('submittedAt', v_now),
         waiver_signed_at = v_now,
         injuries = coalesce(nullif(trim(p_health ->> 'injuries'), ''), injuries)
   where id = p_client_id;
  if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;
  return (select to_jsonb(c) - 'intro_ineligible' - 'momence_id' from public.clients c where id = p_client_id);
end $function$;

CREATE OR REPLACE FUNCTION app.register_interest_impl(p_class_type_id uuid, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_client uuid := coalesce(p_client_id, public.current_client_id()); r public.class_interest;
begin
  if v_client is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  if not coalesce((app.is_privileged() or v_client = public.current_client_id() or public.has_role('owner', 'manager', 'front_desk')), false) then
    perform app.fail('NOT_ALLOWED', 'You can only register interest for yourself.');
  end if;
  if not exists (select 1 from public.class_types where id = p_class_type_id) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that class.');
  end if;
  if not exists (select 1 from public.clients where id = v_client) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  insert into public.class_interest (client_id, class_type_id, created_at) values (v_client, p_class_type_id, app.now())
  on conflict (client_id, class_type_id) do nothing;
  select * into r from public.class_interest where client_id = v_client and class_type_id = p_class_type_id;
  return jsonb_build_object('client_id', r.client_id, 'class_type_id', r.class_type_id, 'created_at', r.created_at);
end $function$;

CREATE OR REPLACE FUNCTION app.credit_summary_impl(p_client_id uuid, p_session_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := app.now();
  s public.class_sessions;
  v_at timestamptz;
  p public.passes;
  v_rem int;
  v_out jsonb := '[]'::jsonb;
  v_label text;
  v_guardian uuid := app.guardian_of(p_client_id);
begin
  if not coalesce((app.is_privileged() or p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id)
          or public.has_role('owner','manager','front_desk','instructor')), false) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  if p_session_id is not null then
    select * into s from public.class_sessions where id = p_session_id;
    if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  end if;
  v_at := coalesce(s.starts_at, v_now);

  for p in select * from public.passes
            where (client_id = p_client_id or (client_id = v_guardian and app.pass_family_shareable(passes)))
              and (status in ('active','paused')
                   or (status = 'cancelled' and kind = 'membership' and next_billing_at > v_now))
            order by (client_id <> p_client_id),
                     case when credits is null then 0 when kind = 'membership' then 1 else 2 end,
                     (activated_at is null), expires_at nulls last, purchased_at
  loop
    if s.id is not null then
      continue when not app.pass_usable(p, s.starts_at, s.class_type_id, v_now);
    else
      continue when app.effective_expiry(p, v_now) is not null and app.effective_expiry(p, v_now) <= v_now;
    end if;
    v_rem := app.pass_remaining(p, v_at);
    continue when s.id is not null and v_rem is not null and v_rem <= 0;
    continue when s.id is null and p.kind <> 'membership' and v_rem is not null and v_rem <= 0;
    v_label := case
      when s.id is null and p.paused_from is not null and p.paused_from <= app.local_date(v_now)
           and (p.paused_until is null or p.paused_until >= app.local_date(v_now))
        then 'Paused' || coalesce(' until ' || to_char(p.paused_until, 'Dy FMDD Mon'), '')
      when p.no_classes then 'Online only'
      when v_rem is null then 'Unlimited'
      when p.kind = 'membership' then format('%s of %s left this week', greatest(v_rem, 0), p.credits)
      else format('%s of %s left', v_rem, p.credits) end;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'pass', app.pass_json(p.id), 'remaining', case when v_rem is null then null else greatest(v_rem, 0) end,
      'label', v_label, 'shared', p.client_id <> p_client_id,
      'expiresAt', case when p.status = 'cancelled' and p.kind = 'membership' then p.next_billing_at else p.expires_at end));
  end loop;
  return v_out;
end $function$;

CREATE OR REPLACE FUNCTION app.list_client_bookings_impl(p_client_id uuid, p_when text DEFAULT 'all'::text, p_statuses text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_now timestamptz := app.now();
begin
  if not coalesce((app.is_privileged() or p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id) or public.is_staff()), false) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  return coalesce((
    select jsonb_agg(
      (to_jsonb(b) - 'reminder_sent_at' - 'updated_at') || jsonb_build_object(
        'session', to_jsonb(sw), 'class_type', to_jsonb(ct),
        'instructor', (select to_jsonb(sp) from public.staff_public sp where sp.id = sw.instructor_id))
      order by case when p_when = 'past' then null else sw.starts_at end asc,
               case when p_when = 'past' then sw.starts_at end desc)
    from public.bookings b
    join public.sessions_with_counts sw on sw.id = b.session_id
    join public.class_types ct on ct.id = sw.class_type_id
    where b.client_id = p_client_id
      and (p_statuses is null or b.status = any(p_statuses))
      and (p_when = 'all' or (p_when = 'upcoming' and sw.starts_at >= v_now) or (p_when = 'past' and sw.starts_at < v_now))
  ), '[]'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.submit_health_check(p_client_id uuid, p_changes boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_now timestamptz := app.now();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_line text;
begin
  perform app.assert_in_studio('clients', p_client_id, 'We couldn''t find that client.');
  if not coalesce((app.is_privileged() or p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id) or public.is_staff()), false) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that client.');
  end if;
  if coalesce(p_changes, false) and v_note is null then perform app.fail('INVALID', 'Tell us a little about what''s changed.'); end if;
  if coalesce(p_changes, false) then
    v_line := to_char(app.local_date(v_now), 'FMDD Mon YYYY') || ': ' || v_note;
    update public.clients
       set health_checked_at = v_now,
           health_update = jsonb_build_object('note', v_note, 'at', v_now),
           injuries = case when nullif(trim(coalesce(injuries, '')), '') is null then v_line else trim(injuries) || E'\n' || v_line end
     where id = p_client_id;
  else
    update public.clients set health_checked_at = v_now where id = p_client_id;
  end if;
  if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;
  return (select to_jsonb(c) - 'intro_ineligible' - 'momence_id' from public.clients c where id = p_client_id);
end $function$;

-- ----------------------------------------------------------------------------- 3. branding is data, not markup
-- Elements and attributes a text or path logo needs. Anything else (script, style, foreignObject, use, image, a, animate,
-- on* handlers, href, javascript:/data: values, external url()) makes the whole logo unsafe.
create or replace function app.svg_is_safe(p_svg text) returns boolean
language plpgsql immutable set search_path = pg_catalog as $$
declare t text; a text;
begin
  if p_svg is null or p_svg = '' then return true; end if;
  if length(p_svg) > 200000 then return false; end if;
  if p_svg ~ '<!|<\?' then return false; end if;
  for t in select lower(m[1]) from regexp_matches(p_svg, '<\s*/?\s*([a-zA-Z][a-zA-Z0-9:_-]*)', 'g') m loop
    if t not in ('svg','g','path','circle','ellipse','rect','line','polyline','polygon','text','tspan','defs','lineargradient','radialgradient','stop','clippath','mask','title','desc') then
      return false;
    end if;
  end loop;
  for a in select lower(m[1]) from regexp_matches(p_svg, '[\s"''/]([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=', 'g') m loop
    if a like 'on%' or a in ('href','xlink:href','src','srcdoc','action','formaction') then return false; end if;
  end loop;
  if p_svg ~* 'javascript:|vbscript:|data:|expression\s*\(|@import|url\s*\(\s*[''"]?\s*(https?:|//|data:)' then return false; end if;
  return true;
end $$;
grant execute on function app.svg_is_safe(text) to anon, authenticated, service_role;

create or replace function app.check_studio_content() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not app.svg_is_safe(new.branding #>> '{logo,svg}') then
    perform app.fail('INVALID', 'That logo can''t be used. Upload a plain logo image or use the text logo.');
  end if;
  if new.website is not null then
    new.website := btrim(new.website);
    if new.website = '' then new.website := null;
    elsif new.website !~* '^https?://[^\s<>"'']+$' then
      if new.website ~* '^[a-z][a-z0-9+.-]*:' or new.website ~ '[\s<>"'']' then
        perform app.fail('INVALID', 'The website should start with https://');
      end if;
      new.website := 'https://' || new.website;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists check_studio_content on public.studios;
create trigger check_studio_content before insert or update of branding, website on public.studios
  for each row execute function app.check_studio_content();

-- ----------------------------------------------------------------------------- 4. avatars: no listing for everyone
-- The bucket stays public (photo URLs work without a policy); this only stops anyone listing every client's folder.
drop policy if exists spc_avatars_read on storage.objects;
create policy spc_avatars_read on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and app.can_write_avatar((storage.foldername(name))[1]));

-- ----------------------------------------------------------------------------- 5. kiosk PIN lockout
alter table public.kiosk_settings add column if not exists fail_count integer not null default 0;
alter table public.kiosk_settings add column if not exists locked_until timestamptz;

create or replace function public.kiosk_check_pin(p_pin text) returns boolean
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare k public.kiosk_settings; v_ok boolean;
begin
  perform public.kiosk_require(array['owner','manager','front_desk']);
  select * into k from public.kiosk_settings where studio_id = app.current_studio_id() for update;
  if k.studio_id is null then return false; end if;
  if k.locked_until is not null and k.locked_until > now() then
    perform app.fail('LOCKED', 'Too many tries. Wait a few minutes and try again.');
  end if;
  v_ok := p_pin is not null and crypt(p_pin, k.pin_hash) = k.pin_hash;
  if v_ok then
    if k.fail_count <> 0 or k.locked_until is not null then
      update public.kiosk_settings set fail_count = 0, locked_until = null where studio_id = k.studio_id;
    end if;
  else
    update public.kiosk_settings
       set fail_count = case when k.fail_count + 1 >= 5 then 0 else k.fail_count + 1 end,
           locked_until = case when k.fail_count + 1 >= 5 then now() + interval '5 minutes' else null end
     where studio_id = k.studio_id;
  end if;
  return v_ok;
end $$;
revoke all on function public.kiosk_check_pin(text) from public, anon;
grant execute on function public.kiosk_check_pin(text) to authenticated;

-- Setting a new PIN also clears any lock.
create or replace function public.kiosk_set_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform public.kiosk_require(array['owner','manager']);
  perform app.assert_studio_open(app.current_studio_id());
  if p_pin is null then
    delete from public.kiosk_settings where studio_id = app.current_studio_id();
    return;
  end if;
  if p_pin !~ '^[0-9]{4}$' then perform app.fail('INVALID', 'The PIN is 4 numbers.'); end if;
  insert into public.kiosk_settings (studio_id, pin_hash) values (app.current_studio_id(), crypt(p_pin, gen_salt('bf')))
    on conflict (studio_id) do update set pin_hash = excluded.pin_hash, updated_at = now(), fail_count = 0, locked_until = null;
end $$;
revoke all on function public.kiosk_set_pin(text) from public, anon;
grant execute on function public.kiosk_set_pin(text) to authenticated;
