-- Online classes: on-demand video library. Permission map (mirrors src/features/ondemand/permissions.ts):
--   clients                  watch: a video is unlocked when it is free, or the client has an active pass from a product flagged "includes online classes"
--   ondemand.manage          owner, manager   add, edit, publish, reorder and delete videos; choose which products include online access
-- The tables are readable by owner and manager only. Clients get videos through ondemand_list_videos(), which withholds the video address
-- from locked rows, and every write goes through the RPCs below.

-- ---------------------------------------------------------------- videos
create table public.ondemand_videos (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 120),
  description text not null default '' check (length(description) <= 1000),
  instructor text not null default '' check (length(instructor) <= 80),
  duration_min integer not null check (duration_min between 1 and 600),
  level text not null default 'All levels' check (length(level) <= 40),
  category text not null check (length(btrim(category)) between 1 and 40),
  thumbnail_url text not null default '' check (length(thumbnail_url) <= 500 and thumbnail_url !~* '^\s*(javascript|data|vbscript):'),
  -- A Vimeo or YouTube link (unlisted is fine) or a direct video file address.
  video_url text not null check (
    length(video_url) <= 500 and (
      video_url ~* '^https?://([a-z0-9-]+\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com)/'
      or video_url ~* '^https?://[^?#\s]+\.(mp4|m4v|webm|mov|ogv)([?#].*)?$')),
  published boolean not null default false,
  free boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select app.scope_table('ondemand_videos');
create index ondemand_videos_order_idx on public.ondemand_videos (studio_id, sort_order, created_at);
create policy ondemand_videos_read on public.ondemand_videos for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.ondemand_videos to authenticated;

-- ---------------------------------------------------------------- which products include online classes (keyed by product_id)
create table public.ondemand_products (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  product_id uuid not null,
  primary key (studio_id, product_id),
  foreign key (studio_id, product_id) references public.products (studio_id, id) on delete cascade
);
select app.scope_table('ondemand_products');
create policy ondemand_products_read on public.ondemand_products for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.ondemand_products to authenticated;

-- ---------------------------------------------------------------- plays (one row per client and video)
create table public.ondemand_views (
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  video_id uuid not null,
  client_id uuid not null,
  views integer not null default 1 check (views > 0),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (video_id, client_id),
  foreign key (studio_id, video_id) references public.ondemand_videos (studio_id, id) on delete cascade,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
select app.scope_table('ondemand_views');
-- RLS on, no policy and no grant: only the RPCs touch it.
revoke all on public.ondemand_views from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public.ondemand_require_manage() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('owner', 'manager') then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

-- Does this client hold an active pass from a flagged product? Active, not paused, and not past its end date.
create or replace function public.ondemand_client_has_access(p_client uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.passes p
      join public.ondemand_products op on op.studio_id = p.studio_id and op.product_id = p.product_id
     where p.client_id = p_client and p.studio_id = app.current_studio_id()
       and p.status = 'active' and (p.expires_at is null or p.expires_at > app.now()))
$$;

-- ---------------------------------------------------------------- client: the library
-- { access: bool, videos: [...] }: published videos in the studio's order. `locked` is per row, and video_url is only present when unlocked.
create or replace function public.ondemand_list_videos() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_client uuid := public.current_client_id();
  v_manage boolean := public.has_role('owner', 'manager');
  v_access boolean;
begin
  if v_client is null and not v_manage then perform app.fail('AUTH_REQUIRED', 'Please sign in to watch online classes.'); end if;
  v_access := v_manage or public.ondemand_client_has_access(v_client);
  return jsonb_build_object('access', v_access, 'videos', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id, 'title', v.title, 'description', v.description, 'instructor', v.instructor, 'duration_min', v.duration_min,
      'level', v.level, 'category', v.category, 'thumbnail_url', v.thumbnail_url, 'free', v.free,
      'locked', not (v.free or v_access),
      'video_url', case when v.free or v_access then v.video_url end,
      'last_watched_at', (select w.last_at from public.ondemand_views w where w.video_id = v.id and w.client_id = v_client))
      order by v.sort_order, v.created_at, v.id)
    from public.ondemand_videos v
    where v.studio_id = app.current_studio_id() and v.published), '[]'::jsonb));
end $$;

-- Client pressed play. Refused while locked. Staff previewing aren't counted.
create or replace function public.ondemand_record_view(p_video_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid := public.current_client_id(); v public.ondemand_videos;
begin
  if v_client is null and not public.has_role('owner', 'manager') then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  perform app.assert_in_studio('ondemand_videos', p_video_id, 'We couldn''t find that video.');
  select * into v from public.ondemand_videos where id = p_video_id and published;
  if v.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that video.'); end if;
  if v_client is null then return; end if;
  if not (v.free or public.ondemand_client_has_access(v_client)) then perform app.fail('LOCKED', 'Unlock this video with an Online membership.'); end if;
  insert into public.ondemand_views (studio_id, video_id, client_id) values (app.current_studio_id(), v.id, v_client)
    on conflict (video_id, client_id) do update set views = public.ondemand_views.views + 1, last_at = now();
end $$;

-- ---------------------------------------------------------------- staff: library
create or replace function public.ondemand_admin_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.ondemand_require_manage();
  return coalesce((
    select jsonb_agg(to_jsonb(v) - 'studio_id' - 'created_at' - 'updated_at'
      || jsonb_build_object('views', coalesce((select sum(w.views) from public.ondemand_views w where w.video_id = v.id), 0))
      order by v.sort_order, v.created_at, v.id)
    from public.ondemand_videos v where v.studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

-- p_id null adds (at the end), otherwise edits.
create or replace function public.ondemand_save_video(
  p_id uuid, p_title text, p_description text, p_instructor text, p_duration_min int, p_level text,
  p_category text, p_thumbnail_url text, p_video_url text, p_published boolean, p_free boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_cat text := btrim(coalesce(p_category, ''));
  v_url text := btrim(coalesce(p_video_url, ''));
  v_id uuid := p_id;
begin
  perform public.ondemand_require_manage();
  perform app.assert_studio_open(app.current_studio_id());
  if v_title = '' or length(v_title) > 120 then perform app.fail('INVALID', 'Give the video a title (up to 120 characters).'); end if;
  if v_cat = '' or length(v_cat) > 40 then perform app.fail('INVALID', 'Choose a category (up to 40 characters).'); end if;
  if p_duration_min is null or p_duration_min not between 1 and 600 then perform app.fail('INVALID', 'Enter the length in whole minutes (1 to 600).'); end if;
  if length(v_url) > 500 or not (v_url ~* '^https?://([a-z0-9-]+\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com)/'
                                 or v_url ~* '^https?://[^?#\s]+\.(mp4|m4v|webm|mov|ogv)([?#].*)?$') then
    perform app.fail('INVALID', 'Paste a Vimeo or YouTube link, or a direct .mp4 link.');
  end if;
  if length(coalesce(p_description, '')) > 1000 then perform app.fail('INVALID', 'The description can be up to 1000 characters.'); end if;
  if length(coalesce(p_instructor, '')) > 80 then perform app.fail('INVALID', 'The instructor name can be up to 80 characters.'); end if;
  if p_thumbnail_url ~* '^\s*(javascript|data|vbscript):' or length(coalesce(p_thumbnail_url, '')) > 500 then perform app.fail('INVALID', 'That thumbnail address doesn''t look right.'); end if;
  if p_id is null then
    insert into public.ondemand_videos (studio_id, title, description, instructor, duration_min, level, category, thumbnail_url, video_url, published, free, sort_order)
    values (app.current_studio_id(), v_title, coalesce(p_description, ''), coalesce(p_instructor, ''), p_duration_min, coalesce(nullif(btrim(p_level), ''), 'All levels'),
            v_cat, coalesce(btrim(p_thumbnail_url), ''), v_url, coalesce(p_published, false), coalesce(p_free, false),
            coalesce((select max(sort_order) from public.ondemand_videos where studio_id = app.current_studio_id()), 0) + 10)
    returning id into v_id;
  else
    perform app.assert_in_studio('ondemand_videos', p_id, 'We couldn''t find that video.');
    update public.ondemand_videos set title = v_title, description = coalesce(p_description, ''), instructor = coalesce(p_instructor, ''), duration_min = p_duration_min,
           level = coalesce(nullif(btrim(p_level), ''), 'All levels'), category = v_cat, thumbnail_url = coalesce(btrim(p_thumbnail_url), ''), video_url = v_url,
           published = coalesce(p_published, false), free = coalesce(p_free, false), updated_at = now()
     where id = p_id;
  end if;
  return (select to_jsonb(v) - 'studio_id' - 'created_at' - 'updated_at'
            || jsonb_build_object('views', coalesce((select sum(w.views) from public.ondemand_views w where w.video_id = v.id), 0))
            from public.ondemand_videos v where v.id = v_id);
end $$;

create or replace function public.ondemand_set_published(p_id uuid, p_published boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.ondemand_require_manage();
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('ondemand_videos', p_id, 'We couldn''t find that video.');
  update public.ondemand_videos set published = coalesce(p_published, false), updated_at = now() where id = p_id;
end $$;

-- p_ids: every video of the studio, once, in the new order.
create or replace function public.ondemand_reorder(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform public.ondemand_require_manage();
  perform app.assert_studio_open(app.current_studio_id());
  if (select count(distinct x) from unnest(p_ids) x) <> coalesce(array_length(p_ids, 1), 0) then perform app.fail('INVALID', 'That order doesn''t match the videos.'); end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    perform app.assert_in_studio('ondemand_videos', v_id, 'We couldn''t find that video.');
  end loop;
  update public.ondemand_videos v set sort_order = o.n * 10
    from unnest(p_ids) with ordinality as o(id, n) where v.id = o.id;
end $$;

create or replace function public.ondemand_delete_video(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.ondemand_require_manage();
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('ondemand_videos', p_id, 'We couldn''t find that video.');
  delete from public.ondemand_videos where id = p_id;
end $$;

-- ---------------------------------------------------------------- staff: which products include online access
-- Replaces the whole set. Returns the product ids saved.
create or replace function public.ondemand_save_products(p_product_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform public.ondemand_require_manage();
  perform app.assert_studio_open(app.current_studio_id());
  foreach v_id in array coalesce(p_product_ids, '{}') loop
    perform app.assert_in_studio('products', v_id, 'One of those products no longer exists.');
  end loop;
  delete from public.ondemand_products where studio_id = app.current_studio_id() and not (product_id = any(coalesce(p_product_ids, '{}')));
  insert into public.ondemand_products (studio_id, product_id)
    select app.current_studio_id(), x from unnest(coalesce(p_product_ids, '{}')) x on conflict do nothing;
  return coalesce((select jsonb_agg(product_id) from public.ondemand_products where studio_id = app.current_studio_id()), '[]'::jsonb);
end $$;

revoke all on function public.ondemand_require_manage(), public.ondemand_client_has_access(uuid) from public, anon, authenticated;
revoke all on function public.ondemand_list_videos(), public.ondemand_record_view(uuid), public.ondemand_admin_list(),
  public.ondemand_save_video(uuid, text, text, text, int, text, text, text, text, boolean, boolean), public.ondemand_set_published(uuid, boolean),
  public.ondemand_reorder(uuid[]), public.ondemand_delete_video(uuid), public.ondemand_save_products(uuid[]) from public, anon;
grant execute on function public.ondemand_list_videos(), public.ondemand_record_view(uuid), public.ondemand_admin_list(),
  public.ondemand_save_video(uuid, text, text, text, int, text, text, text, text, boolean, boolean), public.ondemand_set_published(uuid, boolean),
  public.ondemand_reorder(uuid[]), public.ondemand_delete_video(uuid), public.ondemand_save_products(uuid[]) to authenticated;
