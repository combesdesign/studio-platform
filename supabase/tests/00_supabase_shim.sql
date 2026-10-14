-- TEST ONLY. Never run this on a real Supabase project (it already has all of this).
-- A tiny stand-in for the bits of Supabase our migrations depend on, so we can run
-- migrations + RLS tests on plain PostgreSQL 16.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants table + function privileges to the API roles by default and relies on RLS.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Same definitions Supabase uses (claims come from the request JWT via PostgREST).
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create publication supabase_realtime;

-- Supabase Storage: just the two tables and the helper our policies use.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid default auth.uid(),
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
grant execute on all functions in schema storage to anon, authenticated, service_role;
