-- Notice board (src/features/notices): short notices staff post for clients, shown at the top of the client timetable.
-- Permission map (mirrors src/features/notices/permissions.ts):
--   everyone in the studio   read the notices that are still showing (no "show until" date, or today and later)
--   owner, manager           read them all (including finished ones), post, edit, pin and remove, through the RPCs below
-- Nobody writes the table directly. Another studio's people see and change nothing (scope_table's x-studio policy).

create table public.notices (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 80),
  body text not null default '' check (char_length(body) <= 300),
  link_url text check (link_url is null or (char_length(link_url) <= 500 and link_url ~* '^https?://')),
  show_until date,
  pinned boolean not null default false,
  created_at timestamptz not null default app.now(),
  updated_at timestamptz not null default app.now()
);
select app.scope_table('notices');
create index notices_order_idx on public.notices (studio_id, pinned desc, created_at desc);
create function app.notice_visible(p_studio uuid, p_until date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_until is null or p_until >= app.local_date(app.now()) or app.has_role_in(p_studio, 'owner', 'manager')
$$;
revoke execute on function app.notice_visible(uuid, date) from public, anon;
grant execute on function app.notice_visible(uuid, date) to authenticated, service_role;
create policy notices_read on public.notices for select to authenticated
  using (app.is_member_of(studio_id) and app.notice_visible(studio_id, show_until));
grant select on public.notices to authenticated;

create function app.notice_json(n public.notices) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'linkUrl', n.link_url,
    'showUntil', n.show_until, 'pinned', n.pinned, 'createdAt', n.created_at, 'updatedAt', n.updated_at)
$$;

-- Post a notice (no id) or change one (with id). Owner and manager only.
create function public.notices_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n public.notices;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_title text := btrim(coalesce(p ->> 'title', ''));
  v_body text := btrim(coalesce(p ->> 'body', ''));
  v_link text := nullif(btrim(coalesce(p ->> 'linkUrl', '')), '');
  v_until_text text := nullif(btrim(coalesce(p ->> 'showUntil', '')), '');
  v_until date;
  v_pinned boolean := coalesce((p ->> 'pinned')::boolean, false);
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can post notices.'); end if;
  perform app.assert_studio_open(app.current_studio_id());
  if v_title = '' then perform app.fail('INVALID', 'Give the notice a title.'); end if;
  if char_length(v_title) > 80 then perform app.fail('INVALID', 'Keep the title to 80 characters or fewer.'); end if;
  if char_length(v_body) > 300 then perform app.fail('INVALID', 'Keep the text to 300 characters or fewer.'); end if;
  if v_link is not null and (v_link !~* '^https?://' or char_length(v_link) > 500) then
    perform app.fail('INVALID', 'That doesn''t look like a web address. Start it with https://');
  end if;
  if v_until_text is not null then
    if v_until_text !~ '^\d{4}-\d{2}-\d{2}$' then perform app.fail('INVALID', 'Pick a valid "show until" date.'); end if;
    v_until := v_until_text::date;
    if v_until < app.local_date(app.now()) then perform app.fail('INVALID', 'The "show until" date can''t be in the past.'); end if;
  end if;
  if v_id is not null then
    perform app.assert_in_studio('notices', v_id, 'We couldn''t find that notice.');
    update public.notices set title = v_title, body = v_body, link_url = v_link, show_until = v_until, pinned = v_pinned, updated_at = app.now()
     where id = v_id and studio_id = app.current_studio_id() returning * into n;
  else
    insert into public.notices (title, body, link_url, show_until, pinned) values (v_title, v_body, v_link, v_until, v_pinned) returning * into n;
  end if;
  return app.notice_json(n);
end $$;

create function public.notices_set_pinned(p_id uuid, p_pinned boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.notices;
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can pin notices.'); end if;
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('notices', p_id, 'We couldn''t find that notice.');
  update public.notices set pinned = coalesce(p_pinned, false), updated_at = app.now()
   where id = p_id and studio_id = app.current_studio_id() returning * into n;
  return app.notice_json(n);
end $$;

create function public.notices_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can remove notices.'); end if;
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('notices', p_id, 'We couldn''t find that notice.');
  delete from public.notices where id = p_id and studio_id = app.current_studio_id();
end $$;

revoke execute on function app.notice_json(public.notices) from public, anon, authenticated;
revoke all on function public.notices_save(jsonb), public.notices_set_pinned(uuid, boolean), public.notices_remove(uuid) from public, anon;
grant execute on function public.notices_save(jsonb), public.notices_set_pinned(uuid, boolean), public.notices_remove(uuid) to authenticated;
