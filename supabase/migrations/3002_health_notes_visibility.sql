-- Who can read a client's injuries and health form (Settings > Policies > "Who can see health notes"):
--   all_staff         every active staff member of the studio
--   class_instructor  owner, managers, and the instructor of a class the client is booked into (the default)
--   owner_manager     owner and managers only
-- Clients always see their own (and a parent sees a dependant's). Staff notes are a separate table with their own rule.
--
-- RLS can't hide single columns, so the three health columns (injuries, health_form, health_update) are no longer readable
-- through the table by the app roles. They come back through public.client_health(), which applies the rule, and get_roster
-- masks them the same way. A staff member who can't read them can't overwrite them either (guard_client).
-- Columns added to public.clients later need their own `grant select (col) ... to authenticated`.

alter table public.studio_settings
  add column health_notes_visibility text not null default 'class_instructor'
  check (health_notes_visibility in ('all_staff', 'class_instructor', 'owner_manager'));

create or replace function app.can_see_health(p_client_id uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.clients;
  v_role text;
  v_vis text;
begin
  if app.is_privileged() then return true; end if;
  select * into c from public.clients where id = p_client_id;
  if c.id is null then return false; end if;
  if c.user_id is not null and c.user_id = auth.uid() then return true; end if;
  if c.guardian_client_id is not null and c.guardian_client_id = app.client_id_in(c.studio_id) then return true; end if;
  v_role := app.staff_role_in(c.studio_id);
  if v_role is null then return false; end if;
  if v_role in ('owner', 'manager') then return true; end if;
  select coalesce(ss.health_notes_visibility, 'class_instructor') into v_vis from public.studio_settings ss where ss.studio_id = c.studio_id;
  if v_vis = 'all_staff' then return true; end if;
  if v_vis = 'owner_manager' then return false; end if;
  -- class_instructor: one of their classes (not cancelled, not ended more than a day ago) has this client booked, waitlisted or checked in
  return exists (
    select 1 from public.bookings b join public.class_sessions s on s.id = b.session_id
     where b.client_id = c.id and b.status in ('booked', 'waitlisted', 'checked_in')
       and s.instructor_id = app.staff_id_in(c.studio_id) and s.status <> 'cancelled'
       and s.ends_at > app.now() - interval '1 day');
end $$;

-- ----------------------------------------------------------------------------- the table no longer hands out the health columns
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'clients' and column_name not in ('injuries', 'health_form', 'health_update');
  execute 'revoke select on public.clients from authenticated, anon';
  execute 'grant select (' || v_cols || ') on public.clients to authenticated, anon';
end $$;

-- Health fields for the clients the caller may read them for (others are left out of the result).
create or replace function public.client_health(p_client_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'injuries', c.injuries, 'health_form', c.health_form, 'health_update', c.health_update)), '[]'::jsonb)
    from public.clients c
   where c.id = any(p_client_ids) and c.studio_id = app.current_studio_id() and app.can_see_health(c.id)
$$;
revoke all on function public.client_health(uuid[]) from public, anon;
grant execute on function public.client_health(uuid[]) to authenticated;

-- ----------------------------------------------------------------------------- roster: mask the same fields and flags
alter function app.get_roster_impl(uuid) rename to get_roster_raw;
create function app.get_roster_impl(p_session_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(
    case when app.can_see_health((x.e -> 'client' ->> 'id')::uuid) then x.e
         else jsonb_set(
                jsonb_set(x.e, '{client}', (x.e -> 'client') - 'injuries' - 'health_form' - 'health_update'),
                '{flags}', coalesce((select jsonb_agg(f) from jsonb_array_elements(x.e -> 'flags') f where (f #>> '{}') not in ('injury', 'health_update')), '[]'::jsonb))
    end order by x.n), '[]'::jsonb)
  from jsonb_array_elements(app.get_roster_raw(p_session_id)) with ordinality as x(e, n)
$$;

-- ----------------------------------------------------------------------------- staff who can't read them can't overwrite them
create function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;
select app.patch_function('app.guard_client()'::regprocedure,
  $q$if app.has_role_in(old.studio_id, 'owner', 'manager', 'front_desk') then return new; end if;$q$,
  $q$if app.is_staff_of(old.studio_id) and not app.can_see_health(old.id) then
    new.injuries := old.injuries;
    new.health_form := old.health_form;
    new.health_update := old.health_update;
  end if;
  if app.has_role_in(old.studio_id, 'owner', 'manager', 'front_desk') then return new; end if;$q$);
drop function app.patch_function(regprocedure, text, text);
