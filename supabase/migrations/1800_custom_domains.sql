-- Custom domains (ROADMAP: platform backlog "custom-domain admin screen"). The column already exists
-- (studios.custom_domains, 0007); platform admins save it through platform_update_studio from the admin app
-- (Studio > Domains). This makes the column safe to write:
--   - every domain is lower-cased, trimmed and checked to be a real host name (no protocol, path or port)
--   - no duplicates inside a studio, at most 10 per studio
--   - a domain can belong to only one studio, or opening it couldn't tell whose app it is
-- It is a trigger, so it covers every way of writing the column without changing platform_update_studio.
create or replace function app.check_custom_domains() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare d text; v text[] := '{}';
begin
  if tg_op = 'UPDATE' and new.custom_domains is not distinct from old.custom_domains then return new; end if;
  foreach d in array coalesce(new.custom_domains, '{}') loop
    d := regexp_replace(lower(btrim(d)), '\.$', '');
    if d = '' then continue; end if;
    if length(d) > 253 or d !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then
      perform app.fail('INVALID', format('"%s" isn''t a valid domain name. Use something like app.example.com, without https:// or a path.', left(d, 80)));
    end if;
    if not (d = any(v)) then v := v || d; end if;
  end loop;
  if cardinality(v) > 10 then perform app.fail('INVALID', 'A studio can have up to 10 custom domains.'); end if;
  if exists (select 1 from public.studios s, unnest(s.custom_domains) x where s.id <> new.id and lower(x) = any(v)) then
    perform app.fail('DOMAIN_TAKEN', 'One of those domains is already linked to another studio.');
  end if;
  new.custom_domains := v;
  return new;
end $$;

drop trigger if exists studios_check_domains on public.studios;
create trigger studios_check_domains before insert or update of custom_domains on public.studios
  for each row execute function app.check_custom_domains();
revoke all on function app.check_custom_domains() from public, anon, authenticated;
