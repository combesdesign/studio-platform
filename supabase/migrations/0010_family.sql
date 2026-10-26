-- 0010_family.sql: family and child accounts (ROADMAP B5), core range.
--
-- A dependant (a child, or a partner without their own login) is an ordinary clients row with guardian_client_id set to the parent.
-- No login, usually no email. Bookings, rosters, check-in, reports and the kiosk work for them with no changes.
--
-- The rules (docs/features/family.md):
--   * One level only: a parent can't be a dependant, and a dependant can't have dependants. Same studio.
--   * A guardian can read and edit their dependants, read their passes and bookings, and book, cancel and sign the waiver for them.
--   * Credits: a dependant spends their own passes first, then the parent's passes that are family-shareable.
--     Shareable = the product says so (copied onto the pass at purchase); if it doesn't say, packs and drop-ins are, memberships
--     and intro offers are not. A dependant on a non-shareable parent pass needs a pass of their own (the parent can buy it).
--   * Staff (owner, manager, front desk) manage anyone's family.
-- Everything is scoped to the studio like the rest of the schema (the x-studio header, app.client_id_in(studio_id)).

-- ----------------------------------------------------------------------------- columns
alter table public.clients  add column if not exists guardian_client_id uuid references public.clients(id) on delete restrict;
alter table public.products add column if not exists family_shareable boolean;   -- null = the default for the kind
alter table public.passes   add column if not exists family_shareable boolean;   -- copied from the product at purchase
create index if not exists clients_guardian_idx on public.clients (guardian_client_id) where guardian_client_id is not null;

-- ----------------------------------------------------------------------------- helpers
create or replace function app.guardian_of(p_client uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select guardian_client_id from public.clients where id = p_client
$$;

-- Is the signed-in client the parent of this person? (In that person's own studio.)
create or replace function app.is_guardian_of(p_client uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select d.guardian_client_id is not null and d.guardian_client_id = app.client_id_in(d.studio_id)
                     from public.clients d where d.id = p_client), false)
$$;

create or replace function app.pass_family_shareable(p public.passes) returns boolean
language sql immutable as $$ select coalesce(p.family_shareable, p.kind in ('pack', 'dropin')) $$;

-- A new pass takes the product's "family-shareable" flag with it.
create or replace function app.pass_take_shareable() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.family_shareable is null and new.product_id is not null then
    select family_shareable into new.family_shareable from public.products where id = new.product_id;
  end if;
  return new;
end $$;
drop trigger if exists pass_take_shareable on public.passes;
create trigger pass_take_shareable before insert on public.passes for each row execute function app.pass_take_shareable();

-- One level, same studio, no loops. Even service-role writes can't break it.
create or replace function app.check_guardian() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.clients;
begin
  if new.guardian_client_id is null then return new; end if;
  select * into g from public.clients where id = new.guardian_client_id;
  if g.id is null or g.studio_id is distinct from new.studio_id or g.id = new.id then
    perform app.fail('INVALID', 'The parent has to be a client of the same studio.');
  end if;
  if g.guardian_client_id is not null then perform app.fail('INVALID', 'A dependant can''t have dependants of their own.'); end if;
  if tg_op = 'UPDATE' and exists (select 1 from public.clients where guardian_client_id = new.id) then
    perform app.fail('INVALID', 'Someone with dependants of their own can''t be a dependant.');
  end if;
  return new;
end $$;
drop trigger if exists check_guardian on public.clients;
create trigger check_guardian before insert or update of guardian_client_id on public.clients for each row execute function app.check_guardian();

-- Client self-edits (0007 rules) plus: nobody but staff moves a person between families.
create or replace function app.guard_client() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if app.has_role_in(old.studio_id, 'owner', 'manager', 'front_desk') then return new; end if;
  new.id := old.id;
  new.user_id := old.user_id;
  new.email := old.email;
  new.created_at := old.created_at;
  new.source := old.source;
  new.archived := old.archived;
  new.intro_ineligible := old.intro_ineligible;
  new.momence_id := old.momence_id;
  new.waiver_signed_at := old.waiver_signed_at;
  new.health_form := old.health_form;
  new.guardian_client_id := old.guardian_client_id;
  if new.photo_url is distinct from old.photo_url and new.photo_url is not null
     and position('/avatars/' || old.id::text || '/' in new.photo_url) = 0 then
    raise exception 'INVALID: Please upload your photo through the app.' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------- RLS: a guardian reads and writes their dependants
drop policy if exists clients_read_own on public.clients;
create policy clients_read_own on public.clients for select to authenticated
  using (user_id = auth.uid() or app.is_staff_of(studio_id)
         or (guardian_client_id is not null and guardian_client_id = app.client_id_in(studio_id)));

drop policy if exists clients_update_own on public.clients;
create policy clients_update_own on public.clients for update to authenticated
  using (user_id = auth.uid() or (guardian_client_id is not null and guardian_client_id = app.client_id_in(studio_id)))
  with check (user_id = auth.uid() or (guardian_client_id is not null and guardian_client_id = app.client_id_in(studio_id)));

-- Adding a dependant: only under yourself, no login, and the waiver goes through submit_waiver (never self-declared).
drop policy if exists clients_guardian_insert on public.clients;
create policy clients_guardian_insert on public.clients for insert to authenticated
  with check (guardian_client_id is not null and guardian_client_id = app.client_id_in(studio_id)
              and user_id is null and not archived and source = 'app' and waiver_signed_at is null and health_form is null);

drop policy if exists passes_read on public.passes;
create policy passes_read on public.passes for select to authenticated
  using (client_id = app.client_id_in(studio_id) or app.is_staff_of(studio_id) or app.is_guardian_of(client_id));

drop policy if exists pass_adjustments_read on public.pass_adjustments;
create policy pass_adjustments_read on public.pass_adjustments for select to authenticated
  using (app.is_staff_of(studio_id)
         or exists (select 1 from public.passes p where p.id = pass_id and (p.client_id = app.client_id_in(p.studio_id) or app.is_guardian_of(p.client_id))));

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings for select to authenticated
  using (
    client_id = app.client_id_in(studio_id)
    or app.is_guardian_of(client_id)
    or app.has_role_in(studio_id, 'owner','manager','front_desk')
    or (app.has_role_in(studio_id, 'instructor') and exists (
          select 1 from public.class_sessions s where s.id = session_id and s.instructor_id = app.staff_id_in(studio_id)))
  );

-- ----------------------------------------------------------------------------- credits: own passes first, then the parent's shareable ones
create or replace function app.best_pass(p_client uuid, p_starts timestamptz, p_class_type uuid, p_now timestamptz)
returns public.passes language sql stable security definer set search_path = public, pg_temp as $$
  select p.* from public.passes p
   where (p.client_id = p_client or (p.client_id = app.guardian_of(p_client) and app.pass_family_shareable(p)))
     and app.pass_usable(p, p_starts, p_class_type, p_now)
     and coalesce(app.pass_remaining(p, p_starts), 1) > 0
   order by (p.client_id <> p_client),   -- their own first
            case when p.credits is null then 0 when p.kind = 'membership' then 1 else 2 end,
            (p.activated_at is null),
            p.expires_at asc nulls last,
            p.purchased_at asc
   limit 1
$$;

-- Patch an existing function by swapping some of its text (so we change exactly what we mean to and nothing else).
create or replace function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;

-- book_class: a parent may book for a dependant (a pass of the dependant's, or a shareable pass of the parent's).
select app.patch_function('public.book_class(uuid, uuid, uuid, boolean, boolean, boolean)'::regprocedure,
  $q$if p_client_id is not null and p_client_id <> v_client then perform app.fail('NOT_ALLOWED', 'You can only book for yourself.'); end if;$q$,
  $q$if p_client_id is not null and p_client_id <> v_client then
      if app.is_guardian_of(p_client_id) then v_client := p_client_id;
      else perform app.fail('NOT_ALLOWED', 'You can only book for yourself and your family.'); end if;
    end if;$q$);
select app.patch_function('public.book_class(uuid, uuid, uuid, boolean, boolean, boolean)'::regprocedure,
  $q$perform 1 from public.passes where client_id = v_client for update;$q$,
  $q$perform 1 from public.passes where client_id in (v_client, coalesce(app.guardian_of(v_client), v_client)) for update;$q$);
select app.patch_function('public.book_class(uuid, uuid, uuid, boolean, boolean, boolean)'::regprocedure,
  $q$select * into p from public.passes where id = p_pass_id and client_id = v_client;$q$,
  $q$select * into p from public.passes where id = p_pass_id
       and (client_id = v_client or (client_id = app.guardian_of(v_client) and app.pass_family_shareable(passes)));$q$);

-- cancel_booking and leave_waitlist: the parent can cancel their dependant's booking.
select app.patch_function('public.cancel_booking(uuid, boolean, boolean)'::regprocedure,
  $q$if b.client_id is distinct from public.current_client_id() then perform$q$,
  $q$if b.client_id is distinct from public.current_client_id() and not app.is_guardian_of(b.client_id) then perform$q$);
select app.patch_function('app.leave_waitlist_impl(uuid)'::regprocedure,
  $q$b.client_id is distinct from public.current_client_id() and not app.can_staff_session(s)$q$,
  $q$b.client_id is distinct from public.current_client_id() and not app.is_guardian_of(b.client_id) and not app.can_staff_session(s)$q$);

-- bookings list, waiver
select app.patch_function('app.list_client_bookings_impl(uuid, text, text[])'::regprocedure,
  $q$p_client_id = public.current_client_id()$q$, $q$p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id)$q$);
select app.patch_function('app.submit_waiver_impl(uuid, jsonb)'::regprocedure,
  $q$p_client_id = public.current_client_id()$q$, $q$p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id)$q$);

-- credit_summary: what a person can spend (their own passes, plus a parent's shareable ones). 'shared' marks the parent's.
create or replace function app.credit_summary_impl(p_client_id uuid, p_session_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
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
  if not (app.is_privileged() or p_client_id = public.current_client_id() or app.is_guardian_of(p_client_id)
          or public.has_role('owner','manager','front_desk','instructor')) then
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
end $$;

-- ----------------------------------------------------------------------------- RPCs
-- The guardian's client row for the signed-in parent, or staff acting for someone (clients_edit = owner, manager, front desk).
create or replace function app.family_actor(p_guardian uuid) returns public.clients
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g public.clients;
begin
  select * into g from public.clients where id = p_guardian;
  if g.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that client.'); end if;
  if app.has_role_in(g.studio_id, 'owner', 'manager', 'front_desk') or app.is_privileged() then return g; end if;
  if g.user_id is distinct from auth.uid() or g.user_id is null then
    perform app.fail('NOT_ALLOWED', 'You can only manage your own family.');
  end if;
  return g;
end $$;

-- Add (p_id null) or edit a dependant. Returns the client row. The parent is the emergency contact; the parent signs the waiver.
create or replace function public.save_dependant(
  p_guardian_id uuid, p_id uuid, p_first_name text, p_last_name text default null, p_birthday date default null, p_injuries text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g public.clients; d public.clients;
  v_first text := trim(coalesce(p_first_name, ''));
  v_last text;
  v_by_staff boolean;
begin
  perform app.assert_in_studio('clients', p_guardian_id, 'We couldn''t find that client.');
  g := app.family_actor(p_guardian_id);
  v_by_staff := g.user_id is distinct from auth.uid();
  if g.archived then perform app.fail('NOT_ALLOWED', 'This client account is archived.'); end if;
  if g.guardian_client_id is not null then perform app.fail('INVALID', 'A dependant can''t have dependants of their own.'); end if;
  if v_first = '' then perform app.fail('INVALID', 'Please enter a first name.'); end if;
  if p_birthday is not null and p_birthday > app.local_date(app.now()) then perform app.fail('INVALID', 'Please enter a valid date of birth.'); end if;
  v_last := coalesce(nullif(trim(coalesce(p_last_name, '')), ''), g.last_name);
  if p_id is not null then
    select * into d from public.clients where id = p_id and guardian_client_id = g.id;
    if d.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that person.'); end if;
  end if;
  if exists (select 1 from public.clients c where c.guardian_client_id = g.id and not c.archived and c.id is distinct from p_id
               and lower(c.first_name) = lower(v_first) and lower(c.last_name) = lower(v_last)) then
    perform app.fail('INVALID', format('%s is already in your family.', v_first));
  end if;

  if d.id is not null then
    update public.clients set first_name = v_first, last_name = v_last, birthday = p_birthday,
           injuries = nullif(trim(coalesce(p_injuries, '')), '')
     where id = d.id returning * into d;
  else
    insert into public.clients (studio_id, first_name, last_name, email, birthday, injuries, source, guardian_client_id,
                                emergency_contact_name, emergency_contact_phone)
    values (g.studio_id, v_first, v_last, '', p_birthday, nullif(trim(coalesce(p_injuries, '')), ''),
            case when v_by_staff then 'staff' else 'app' end, g.id,
            case when g.phone is not null then trim(g.first_name || ' ' || g.last_name) end, g.phone)
    returning * into d;
  end if;
  return to_jsonb(d) - 'intro_ineligible' - 'momence_id' - 'user_id';
end $$;

-- Remove a dependant: archive them (their history stays). Blocked while they have upcoming classes.
create or replace function public.remove_dependant(p_dependant_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.clients;
begin
  perform app.assert_in_studio('clients', p_dependant_id, 'We couldn''t find that person.');
  select * into d from public.clients where id = p_dependant_id;
  if d.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that person.'); end if;
  if d.guardian_client_id is null then perform app.fail('INVALID', 'That isn''t a dependant.'); end if;
  perform app.family_actor(d.guardian_client_id);
  if exists (select 1 from public.bookings b join public.class_sessions s on s.id = b.session_id
              where b.client_id = d.id and b.status in ('booked','waitlisted','checked_in') and s.starts_at >= app.now()) then
    perform app.fail('INVALID', format('Cancel %s''s upcoming classes first, then remove them.', d.first_name));
  end if;
  update public.clients set archived = true where id = d.id;
end $$;

-- Book several people (the parent and/or dependants) into one class, all or nothing. Result is in the order of p_client_ids.
-- A failure names the person ("Mia needs a pass for this class") and rolls everything back.
create or replace function public.book_attendees(p_session_id uuid, p_client_ids uuid[], p_pass_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[] := (select coalesce(array_agg(x order by o), '{}') from (select x, min(o) o from unnest(p_client_ids) with ordinality t(x, o) group by x) u);
  v_me uuid := public.current_client_id();
  v_id uuid; v_name text; v_out jsonb := '[]'::jsonb; v_msg text;
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  if v_me is null then perform app.fail('AUTH_REQUIRED', 'Please sign in to book.'); end if;
  if cardinality(v_ids) = 0 then perform app.fail('INVALID', 'Choose who''s coming.'); end if;
  foreach v_id in array v_ids loop
    if v_id <> v_me and not app.is_guardian_of(v_id) then perform app.fail('NOT_ALLOWED', 'You can only book for yourself and your family.'); end if;
  end loop;
  foreach v_id in array v_ids loop
    select first_name into v_name from public.clients where id = v_id;
    begin
      v_out := v_out || jsonb_build_array(public.book_class(p_session_id, p_pass_id, v_id));
    exception when others then
      v_msg := sqlerrm;
      if v_msg like 'NO_CREDITS:%' then
        perform app.fail('NO_CREDITS', case when v_id = v_me then 'You need a class pass to book this class.' else format('%s needs a pass for this class.', v_name) end);
      elsif v_msg like 'WAIVER_REQUIRED:%' and v_id <> v_me then
        perform app.fail('WAIVER_REQUIRED', format('%s''s waiver and health form needs signing first.', v_name));
      elsif v_msg like 'ALREADY_BOOKED:%' and v_id <> v_me then
        perform app.fail('ALREADY_BOOKED', format('%s is already booked into this class.', v_name));
      else
        raise;
      end if;
    end;
  end loop;
  return v_out;
end $$;

-- ----------------------------------------------------------------------------- grants
drop function app.patch_function(regprocedure, text, text);
-- Only the new internals are locked away (the policies need app.is_guardian_of); existing grants are left as they are.
revoke execute on function app.guardian_of(uuid), app.is_guardian_of(uuid), app.pass_family_shareable(public.passes),
  app.pass_take_shareable(), app.check_guardian(), app.family_actor(uuid) from public, anon, authenticated;
grant execute on function app.is_guardian_of(uuid), app.pass_family_shareable(public.passes) to anon, authenticated;
grant execute on function app.guardian_of(uuid), app.is_guardian_of(uuid), app.pass_family_shareable(public.passes),
  app.pass_take_shareable(), app.check_guardian(), app.family_actor(uuid) to service_role;
revoke execute on function public.save_dependant, public.remove_dependant, public.book_attendees from public, anon;
grant execute on function public.save_dependant, public.remove_dependant, public.book_attendees to authenticated, service_role;
