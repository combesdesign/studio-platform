-- Check-in kiosk (ROADMAP B5): the studio's 4-digit exit PIN. That's all the kiosk stores; it checks clients in with
-- the core check-in. Permission map (mirrors src/features/kiosk/permissions.ts):
--   kiosk.use     owner, manager, front_desk   is a PIN set? check a PIN
--   kiosk.manage  owner, manager               set or remove the PIN
-- The PIN is kept hashed (bcrypt) and no policy lets anyone read the table: it is only reached through these RPCs.

create table public.kiosk_settings (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);
select app.scope_table('kiosk_settings');
-- RLS is on and there is deliberately no policy and no grant: nobody reads the hash directly.
revoke all on public.kiosk_settings from anon, authenticated;

create or replace function public.kiosk_require(p_roles text[]) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null or not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
end $$;

create or replace function public.kiosk_has_pin() returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.kiosk_require(array['owner','manager','front_desk']);
  return exists (select 1 from public.kiosk_settings where studio_id = app.current_studio_id());
end $$;

-- p_pin null removes the PIN.
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
    on conflict (studio_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
end $$;

create or replace function public.kiosk_check_pin(p_pin text) returns boolean
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare h text;
begin
  perform public.kiosk_require(array['owner','manager','front_desk']);
  select pin_hash into h from public.kiosk_settings where studio_id = app.current_studio_id();
  return h is not null and p_pin is not null and crypt(p_pin, h) = h;
end $$;

revoke all on function public.kiosk_require(text[]) from public, anon, authenticated;
revoke all on function public.kiosk_has_pin(), public.kiosk_set_pin(text), public.kiosk_check_pin(text) from public, anon;
grant execute on function public.kiosk_has_pin(), public.kiosk_set_pin(text), public.kiosk_check_pin(text) to authenticated;
