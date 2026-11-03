-- 3001: a studio can replace the built-in privacy policy / terms (src/shared/legal.ts) with its own text (Settings > Policies).
-- Blank = use the template. Readable like the rest of studio_settings (the policy page works signed out); written by owners and
-- managers through the existing settings_write policy.
alter table public.studio_settings add column if not exists privacy_policy_text text;
alter table public.studio_settings add column if not exists terms_text text;
