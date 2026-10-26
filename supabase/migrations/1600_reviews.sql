-- Reviews and NPS after class (ROADMAP B5). Permission map (mirrors src/features/reviews/permissions.ts):
--   clients                 rate their own checked-in classes (once per booking), or say "not now"
--   reviews.view            owner, manager, instructor   the Reviews page: owner + manager read every review, an instructor only their own classes'
--   reviews.manage          owner, manager               the Google review link setting
-- Reviews are readable by those staff through RLS and written only through the RPCs below. Clients can't read the table.

-- ---------------------------------------------------------------- settings (one row per studio, made on first save)
create table public.reviews_settings (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete cascade,
  google_review_url text not null default '' check (length(google_review_url) <= 500 and (google_review_url = '' or google_review_url ~* '^https?://')),
  updated_at timestamptz not null default now()
);
select app.scope_table('reviews_settings');
create policy reviews_settings_read on public.reviews_settings for select to authenticated using (app.is_staff_of(studio_id));
grant select on public.reviews_settings to authenticated;

-- ---------------------------------------------------------------- reviews (one per booking)
create table public.reviews_entries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  session_id uuid not null,
  client_id uuid not null,
  class_type_id uuid not null,
  instructor_id uuid not null,
  client_first_name text not null default '',
  rating smallint not null check (rating between 1 and 5),
  nps smallint check (nps is null or nps between 0 and 10),
  comment text check (comment is null or length(comment) <= 1000),
  created_at timestamptz not null default now(),
  foreign key (studio_id, session_id) references public.class_sessions (studio_id, id) on delete cascade,
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade,
  foreign key (studio_id, class_type_id) references public.class_types (studio_id, id) on delete cascade,
  foreign key (studio_id, instructor_id) references public.staff (studio_id, id) on delete cascade
);
select app.scope_table('reviews_entries');
create index reviews_entries_instructor_idx on public.reviews_entries (studio_id, instructor_id, created_at desc);
create policy reviews_entries_read on public.reviews_entries for select to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')
         or (app.staff_role_in(studio_id) = 'instructor' and instructor_id = app.staff_id_in(studio_id)));
grant select on public.reviews_entries to authenticated;

-- ---------------------------------------------------------------- "not now" (never ask about this booking again)
create table public.reviews_skips (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (studio_id, client_id) references public.clients (studio_id, id) on delete cascade
);
select app.scope_table('reviews_skips');
-- RLS on, no policy and no grant: only the RPCs touch it.
revoke all on public.reviews_skips from anon, authenticated;

-- ---------------------------------------------------------------- RPCs
create or replace function public.reviews_require(p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null or not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

-- The class to ask the signed-in client about: their latest checked-in class that finished in the last 14 days
-- and hasn't been rated or skipped. Null when there isn't one.
create or replace function public.reviews_pending() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_client uuid := public.current_client_id(); r record;
begin
  if v_client is null then return null; end if;
  select b.id as booking_id, s.id as session_id, s.class_type_id, ct.name as class_name, s.instructor_id, st.name as instructor_name, s.starts_at
    into r
    from public.bookings b
    join public.class_sessions s on s.id = b.session_id
    join public.class_types ct on ct.id = s.class_type_id
    left join public.staff st on st.id = s.instructor_id
   where b.client_id = v_client and b.studio_id = app.current_studio_id() and b.status = 'checked_in'
     and s.ends_at <= app.now() and s.ends_at > app.now() - interval '14 days'
     and not exists (select 1 from public.reviews_entries e where e.booking_id = b.id)
     and not exists (select 1 from public.reviews_skips k where k.booking_id = b.id)
   order by s.starts_at desc limit 1;
  if r.booking_id is null then return null; end if;
  return to_jsonb(r);
end $$;

create or replace function public.reviews_submit(p_booking_id uuid, p_rating int, p_nps int default null, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_client uuid := public.current_client_id();
  b public.bookings; s public.class_sessions; c public.clients;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_url text;
begin
  if v_client is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that class.');
  perform app.assert_studio_open(app.current_studio_id());
  select * into b from public.bookings where id = p_booking_id and client_id = v_client;
  if b.id is null or b.status <> 'checked_in' then perform app.fail('NOT_FOUND', 'You can rate a class once you''ve been checked in.'); end if;
  if exists (select 1 from public.reviews_entries where booking_id = b.id) or exists (select 1 from public.reviews_skips where booking_id = b.id) then
    perform app.fail('ALREADY_REVIEWED', 'You''ve already answered for this class.');
  end if;
  if p_rating is null or p_rating not between 1 and 5 then perform app.fail('INVALID', 'Please choose 1 to 5 flowers.'); end if;
  if p_nps is not null and p_nps not between 0 and 10 then perform app.fail('INVALID', 'Choose a number from 0 to 10.'); end if;
  if v_comment is not null and length(v_comment) > 1000 then perform app.fail('INVALID', 'Comments can be up to 1000 characters.'); end if;
  select * into s from public.class_sessions where id = b.session_id;
  select * into c from public.clients where id = v_client;
  insert into public.reviews_entries (studio_id, booking_id, session_id, client_id, class_type_id, instructor_id, client_first_name, rating, nps, comment)
  values (app.current_studio_id(), b.id, s.id, v_client, s.class_type_id, s.instructor_id, coalesce(c.first_name, ''), p_rating, p_nps, v_comment);
  select nullif(google_review_url, '') into v_url from public.reviews_settings where studio_id = app.current_studio_id();
  return case when v_url is not null and p_nps >= 9 then jsonb_build_object('google_url', v_url) else '{}'::jsonb end;
end $$;

create or replace function public.reviews_dismiss(p_booking_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid := public.current_client_id();
begin
  if v_client is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  perform app.assert_in_studio('bookings', p_booking_id, 'We couldn''t find that class.');
  if not exists (select 1 from public.bookings where id = p_booking_id and client_id = v_client) then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if exists (select 1 from public.reviews_entries where booking_id = p_booking_id) then return; end if;
  insert into public.reviews_skips (studio_id, booking_id, client_id) values (app.current_studio_id(), p_booking_id, v_client) on conflict do nothing;
end $$;

-- p_google_url: null leaves it alone, '' turns the Google ask off.
create or replace function public.reviews_save_settings(p_google_url text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := btrim(p_google_url);
begin
  perform public.reviews_require(array['owner','manager']);
  perform app.assert_studio_open(app.current_studio_id());
  if v_url is not null and v_url <> '' and (v_url !~* '^https?://' or length(v_url) > 500) then
    perform app.fail('INVALID', 'That doesn''t look like a web address. Start it with https://');
  end if;
  insert into public.reviews_settings (studio_id, google_review_url) values (app.current_studio_id(), coalesce(v_url, ''))
    on conflict (studio_id) do update set google_review_url = coalesce(v_url, public.reviews_settings.google_review_url), updated_at = now();
  return (select to_jsonb(r) - 'studio_id' from public.reviews_settings r where studio_id = app.current_studio_id());
end $$;

revoke all on function public.reviews_require(text[]) from public, anon, authenticated;
revoke all on function public.reviews_pending(), public.reviews_submit(uuid, int, int, text), public.reviews_dismiss(uuid), public.reviews_save_settings(text) from public, anon;
grant execute on function public.reviews_pending(), public.reviews_submit(uuid, int, int, text), public.reviews_dismiss(uuid), public.reviews_save_settings(text) to authenticated;
