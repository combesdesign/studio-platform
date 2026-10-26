-- Xero export settings (ROADMAP B5): the account codes the sales export uses.
--   integrations.accounting   owner, manager   read and change the codes (mirrors src/features/integrations/permissions.ts)
-- The export itself is built in the app from the studio's sales (src/features/integrations/xero.ts); this is only the settings.

create table public.integrations_accounting (
  studio_id uuid primary key default app.current_studio_id() references public.studios(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);
select app.scope_table('integrations_accounting');
create policy integrations_accounting_read on public.integrations_accounting for select to authenticated using (app.has_role_in(studio_id, 'owner', 'manager'));
grant select on public.integrations_accounting to authenticated;

create or replace function public.integrations_save_accounting(p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; v jsonb := '{}'::jsonb; allowed text[] := array['salesAccount','gstAccount','cardOnlineAccount','cardReaderAccount','cashAccount','taxType','noTaxType','invoicePrefix'];
begin
  perform public.integrations_require(array['owner','manager']);
  perform app.assert_studio_open(app.current_studio_id());
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then perform app.fail('INVALID', 'Those settings aren''t right.'); end if;
  for k in select jsonb_object_keys(p_settings) loop
    if not (k = any(allowed)) then continue; end if;
    if jsonb_typeof(p_settings -> k) <> 'string' or length(btrim(p_settings ->> k)) > 60 then perform app.fail('INVALID', 'Keep each setting under 60 characters.'); end if;
    v := v || jsonb_build_object(k, btrim(p_settings ->> k));
  end loop;
  insert into public.integrations_accounting (studio_id, settings) values (app.current_studio_id(), v)
    on conflict (studio_id) do update set settings = public.integrations_accounting.settings || excluded.settings, updated_at = now();
  return (select settings from public.integrations_accounting where studio_id = app.current_studio_id());
end $$;

revoke all on function public.integrations_save_accounting(jsonb) from public, anon;
grant execute on function public.integrations_save_accounting(jsonb) to authenticated;
