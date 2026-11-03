# Security review

Independent review of the platform before it handles real client data (names, emails, phones, health and injury notes) and real money through Stripe. Done on `master`, 3 Nov 2026, by reading the risky parts and by testing them against a real Postgres (not just reading migrations).

Scope: tenant isolation, role escalation, payments, edge functions, client app and data, secrets in the repo. `/home/claude/libby-data` was not opened.

## Summary

| Severity | Count | Fixed | Open |
|---|---|---|---|
| High | 3 | 3 | 0 |
| Medium | 4 | 4 | 0 |
| Low | 9 | 5 | 4 (accepted or todo, listed below) |
| Info | 6 | | |

Everything high and medium is fixed in migration `2900_security_review.sql` and the edge function / app changes in the same commit, each with a regression test (`supabase/tests/security_review.sql`, `supabase/tests/functions.test.mjs`, `tests/security-review.test.ts`).

## How it was checked (repeatable)

- `supabase/audit/security_audit.sql` lists, against any database: tables without RLS, tables without the `studio_scope` policy, `SECURITY DEFINER` functions without a `search_path`, definer functions a signed-out caller can run, anon write policies, writable views, and secret tables with grants. `bash supabase/tests/run.sh` runs it and fails on any `FAIL` row. Run it by hand on the real project too: `psql "$DATABASE_URL" -X -f supabase/audit/security_audit.sql`.
- A **tenant fuzz** (`security_review.sql`, section 7): every public function that takes a uuid is called with every id that belongs to someone else (the other studio, other clients), one argument at a time, in a rolled-back sub-transaction, as a stranger, a client, an instructor, front desk and both owners. Any call that answers with data fails the run. This is what found finding H2.
- A **role probe** (not committed): every public RPC called as client, instructor and front desk with NULL arguments, to see which ones refuse on role before touching data. All staff-only RPCs refuse a client with `NOT_ALLOWED`.
- Source review of all 21 edge functions and the shared helpers.

## Findings

### High

**H1. Staff table writable by anyone through a view (fixed).**
`public.staff_public` is a simple view over `staff`. Views run with their owner's rights (so they skip RLS), and the default Supabase grants gave `anon` and `authenticated` INSERT, UPDATE and DELETE on it. A signed-out caller could rename staff, change a role to `manager`, deactivate people, delete staff, and insert staff rows into any studio. The owner-protection trigger stopped promotion to `owner` only.
Where: `0001_init.sql` / `0007_platform.sql` (view and `grant select ... to anon, authenticated`, with the default privileges adding the rest).
Fix: write privileges revoked on both views (`2900`, section 1). The audit now fails on any writable view.
Tests: `security_review.sql` section 2; the audit check `view_writable`.

**H2. Any signed-in person could read and overwrite another client's records by id (fixed).**
Six helper functions guard with `if not (is_privileged() or p_client_id = current_client_id() or ...)`. When the caller has no client row in the studio named by the `x-studio` header, `current_client_id()` is NULL, the whole expression is NULL, `not NULL` is NULL, and the refusal never runs. Anyone with a login (sign-up is open) could therefore, knowing a client's UUID:
- read their passes and credits (`credit_summary`) and bookings (`list_client_bookings`),
- read the whole client row (name, email, phone, birthday, injuries, health form) and **overwrite the waiver and health form** (`submit_waiver`),
- change their health check (`submit_health_check`), add interest (`register_interest`), probe intro eligibility.
The UUID is the only barrier. Client UUIDs were listable by anyone, because the avatars bucket allowed signed-out listing (see M3), so this chained into a full read of every client with a photo.
Where: `app.credit_summary_impl`, `app.list_client_bookings_impl`, `app.submit_waiver_impl`, `app.register_interest_impl`, `app.is_intro_eligible_impl`, `public.submit_health_check`.
Fix: each guard is now `if not coalesce((...), false)` (`2900`, section 2). I looked for the same pattern in every function that uses `current_client_id()`, `current_staff_id()`, `client_id_in()` or `staff_id_in()`; those six were the only ones.
Tests: `security_review.sql` section 3 (the exact calls, as a stranger and as a client of another studio, plus "the right people still work"), and the fuzz in section 7.

**H3. Stored XSS through the studio logo (fixed).**
`Logo` renders `branding.logo.svg` with `dangerouslySetInnerHTML`. An owner or manager can save any JSON as their branding (`update_my_studio`), and the platform admin app previews every studio's branding. A malicious or compromised studio login could store `<svg onload=...>` and run script in every client's app for that studio and, worse, in Pete's platform admin session (full platform takeover: studios, billing plans, suspend/delete).
Where: `src/shared/brand.tsx`; `studios.branding` has no validation.
Fix, in depth: (1) the database refuses unsafe SVG on insert or update of a studio (`app.svg_is_safe`, trigger `check_studio_content`: plain shapes and text only, no script, style, foreignObject, use, image, animate, `on*` handlers, `href`, `javascript:` / `data:` values or external `url()`); (2) the app checks the same rule before rendering (`src/shared/svgsafe.ts`) and falls back to the image or text logo. The studio `website` must now be `http(s)://` (a bare domain gets `https://` added).
Tests: `security_review.sql` section 4, `tests/security-review.test.ts`.

### Medium

**M1. Test email could be sent to any address (fixed).**
`marketing-send` with `{ test, to }` let any owner or manager send an email with arbitrary content to any address through the platform's Resend account and the studio's brand: a phishing and reputation risk if a studio login is compromised. Now an email test only goes to the signed-in person's own address (their login or staff email). Front desk could never send tests.
Where: `supabase/functions/marketing-send/index.ts`. Test: `functions.test.mjs` ("a test email goes only to the person asking").

**M2. Kiosk exit PIN had no lockout (fixed).**
The 4-digit PIN is checked on the server (good), but with no limit a person at the kiosk, which is a signed-in staff session, could try all 10,000 values. Now 5 wrong tries lock the check for 5 minutes (`LOCKED`); setting a new PIN clears the lock.
Where: `public.kiosk_check_pin` (`2900`, section 5). Test: `security_review.sql` section 6.

**M3. Anyone could list every client's photo folder (fixed).**
The `avatars` bucket (public, so photo URLs work) also had a `SELECT` policy for signed-out users, so the storage list API returned every `<client uuid>/<file>` path in every studio. That leaks client UUIDs (needed for H2) and photos of identifiable people. The policy is now limited to the client themselves and staff of their studio. Photo URLs keep working (public bucket downloads do not use the policy).
Where: policy `spc_avatars_read`. Test: `security_review.sql` section 5, and `60_profiles_roles.sql` updated to match.

**M4. Wrong currency charged for non-AUD studios (fixed).**
`create-checkout` and `edit-membership` hard-coded `aud` in the Stripe price. A studio set to NZD, GBP and so on would charge its clients the right number in the wrong currency. Both now use the studio's currency (as `commerce-checkout` and `appointments-checkout` already did).
Test: `functions.test.mjs` ("charges in the studio's own currency").

### Low

| # | What | Where | Status |
|---|---|---|---|
| L1 | `partner-webhook` rejected everything (signature was a TODO). It now verifies a provisional HMAC-SHA256 header (`X-Partner-Signature: t=..,v1=..`, 5 minute window) with the studio's saved partner key. The scheme is our own until the ClassPass / Gympass agreement says how they sign: replace it then. `PARTNER_WEBHOOK_SKIP_VERIFY=true` still disables the check for local testing; it must never be set on the real project. | `partner-webhook/index.ts` | fixed (provisional) |
| L2 | The server posted web push messages to whatever https address a browser registered (blind SSRF). Now only public https hostnames (no IPs, localhost, single-label or internal names, credentials or odd ports). | `_shared/webpush.ts` | fixed |
| L3 | Instructors can read every client's full row (health form, injuries, emergency contact, birthday) in their studio, not only clients in their classes. This is the documented `clients_view` permission and RLS cannot hide columns per role. Same studio only, never another studio. Option if wanted: show instructors a roster-only view (get_roster already limits notes) and move health fields behind an owner / manager / front desk RPC. | `clients_read_own`, `src/domain/permissions.ts` | accepted, product decision |
| L4 | `studios` is readable by signed-out users (needed for "Find your studio") and includes `billing_status`, `trial_ends_at`, `past_due_since`, `billing_comped`. Anyone can see which studios are past due. Move those to the owner-only `studio_billing` table, or serve the public list through a view with only the public columns. | `studios_read` | todo (low) |
| L5 | `?demo=1` switches a live build to the local demo store. It only shows fake local data and never reaches the backend, but a crafted link could show a convincing fake of the app. Consider honouring it only on localhost or when no backend is configured. | `src/data/index.ts` | accepted |
| L6 | `marketing-send` `{ kick }` lets front desk run the whole marketing queue (all studios) once. No data leaves; it is a cost / noise lever only. | `marketing-send` | accepted |
| L7 | An SMS test can go to any number (Twilio is a stub today). Restrict to the staff member's own number before Twilio is switched on. | `marketing-send` | todo before SMS goes live |
| L8 | `support-assist` rate limit is check-then-insert, so parallel requests can slightly exceed 30 a day. The model only sees help guides and the studio's own booking settings, never client data, so there is nothing to leak across studios. | `support-assist` | accepted |
| L9 | Every table has the Supabase default `TRUNCATE`, `REFERENCES`, `TRIGGER` grants for `anon` / `authenticated`. They are not reachable through the API (PostgREST has no TRUNCATE), only over a direct database connection. | all tables | accepted |

### Info (checked, fine)

- **RLS everywhere.** Every public table has RLS on; every studio-owned table has the restrictive `studio_scope` policy and the `aa_guard_studio` trigger. The 11 tables without `studio_scope` are platform-level or deny-all (no policy), and are listed in the audit.
- **Definer functions** all set a `search_path`. Signed-out callers can run only six public definer helpers (`has_role`, `is_staff`, ...). `app.*` helpers are executable by `anon` but the `app` schema must not be an exposed API schema (checklist below); `app.make_default_location` is the only one that writes.
- **Role checks.** Every staff-only RPC refuses a client; owner-only actions (pay period, tax, ABN, roles, staff pay) refuse managers and instructors. `clients` direct updates cannot change credits, role, guardian, `waiver_signed_at`, health fields, `intro_ineligible` or `archived` (the `guard_client` trigger resets them). The `ap_can` class of bug (a permission helper that is true for everyone) was re-checked: it is `true` for any staff for "view"-type actions only.
- **Stripe.** Every webhook path verifies the signature (`stripe-webhook`, `appointments-stripe-webhook`, `platform-webhook`) with its own secret, rejects events outside the 5 minute window, and in Connect mode only accepts the Connect secret for events on a connected account and then maps `event.account` to the studio; rows (product, client, order, sale, pass, gift card) belonging to another studio are ignored. `stripe_events` makes `stripe-webhook` and `platform-webhook` idempotent; the appointments webhook relies on idempotent RPCs. Checkout amounts always come from the database (`products.price_cents`, `appointment_orders`, `commerce_gift_cards`); the client sends only ids. Refunds need owner / manager / front desk and the sale must belong to the caller's studio; the refund amount is capped by the database's `total - refunded`, and the idempotency key includes the amount and running total. `edit-membership` needs owner / manager and reads the pass as the caller, so another studio's pass is not found. `safeReturnUrl` only allows configured `APP_URL(S)`, `PLATFORM_DOMAIN` subdomains over https, and the app's own deep-link schemes. `PLATFORM_FEE_BPS` is clamped to 0..10000, applied only on connected accounts, rounded, and never taken from the client.
- **Emails.** All user-supplied text (names, messages, review comments, notes, editable subject and intro, campaign blocks) is HTML-escaped; colours must be hex; fonts are sanitised; links must be http(s), mailto or tel. Subjects go in JSON to Resend, so no header injection.
- **Secrets.** No keys, tokens or `.env` files in the repo or its git history. The build only embeds the public anon key. Edge functions never return secret values (`integrations_list_partners` returns `key_set`, not the key; the kiosk hash has no grants). The service-role client is created after the caller is authorised in every function that takes a user's request.
- **Uploads.** Buckets enforce mime type and size server-side (avatars: jpeg/png/webp, 1 MB; branding: those plus SVG, 5 MB) and write access is per folder (own client folder or studio staff; owner / manager of the studio for branding). SVG logos in the branding bucket are served from the Supabase storage origin, not the app origin, so they cannot reach app sessions.
- **CORS** is `*` on the edge functions. Acceptable: they authenticate with a bearer token, not cookies, and the webhooks use signatures.

## Before go-live checklist

Keys and secrets
- [ ] Rotate everything that has ever been pasted into a chat, note or terminal: Supabase service-role key and JWT secret if exposed, Stripe secret keys, all webhook signing secrets, Resend key, VAPID keys, `CRON_SECRET`, Anthropic key. Use new live-mode Stripe keys, not the test ones from `GO-LIVE.md`.
- [ ] Set `CRON_SECRET` to a long random value (32+ characters) and use the same in `cron.sql` / `pg_net` jobs.
- [ ] Never set `PARTNER_WEBHOOK_SKIP_VERIFY` and leave `PARTNER_WEBHOOK_ENABLED` unset until a partner agreement exists.
- [ ] The service-role key lives only in Supabase function secrets. Check Netlify env vars: only `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

Supabase settings
- [ ] Authentication > Providers > Email: **Confirm email ON**. The staff and client linking trigger only links on a confirmed address; with confirmation off, anyone could sign up with the owner's email and become the owner.
- [ ] Authentication > Password: **leaked password protection ON** (Pro plan), minimum length 10 or more.
- [ ] Authentication > Rate limits: keep the defaults or tighter for sign-in, sign-up, OTP and email sending; add CAPTCHA (hCaptcha or Turnstile) to sign-up.
- [ ] Authentication > URL Configuration: Site URL and Redirect URLs are your real domains only (`https://*.studioplatform.app/**` plus custom domains), no localhost.
- [ ] Settings > API > Exposed schemas: **only `public`** (never `app`, `auth`, `storage` internals beyond the default). Extra schemas must not include `app`.
- [ ] Run `supabase/audit/security_audit.sql` on the live project; no `FAIL` rows.
- [ ] Email: custom SMTP (Resend) with SPF, DKIM and DMARC on the sending domain.
- [ ] Add yourself to `platform_admins` once, from the SQL editor, and turn on MFA for your Supabase, Stripe, Netlify, GitHub, Resend and domain accounts.
- [ ] Storage: confirm buckets `avatars` (1 MB, jpeg/png/webp) and `branding` (5 MB) exist with those limits.

Stripe
- [ ] Separate webhook endpoints, each with its own signing secret set as a function secret: `stripe-webhook` (`STRIPE_WEBHOOK_SECRET`, or the Connect one `STRIPE_CONNECT_WEBHOOK_SECRET` in Connect mode), `appointments-stripe-webhook` (`APPOINTMENTS_STRIPE_WEBHOOK_SECRET`), `platform-webhook` (`PLATFORM_BILLING_WEBHOOK_SECRET`). Send a Stripe test event to each and confirm a wrong secret is refused (400) and a right one is accepted.
- [ ] Deploy `stripe-webhook`, `appointments-stripe-webhook`, `platform-webhook`, `send-email`, `send-reminders`, `manage-membership`, `marketing-send`, `partner-webhook` with `--no-verify-jwt` (as in `config.toml`) and everything else **with** JWT verification.
- [ ] `APP_URL` / `APP_URLS` / `PLATFORM_DOMAIN` are set to your real addresses (they gate the checkout return links).
- [ ] If you charge a platform fee, set `PLATFORM_FEE_BPS` deliberately (default 0).
- [ ] Do one live card payment and one refund per studio before launch.

Backups and recovery
- [ ] Supabase: daily backups on (Pro), point-in-time recovery if you can; test a restore once into a throwaway project.
- [ ] Keep a copy of the migrations (they are in git) and the Stripe export of customers somewhere that is not the same account.
- [ ] Decide who gets paged if the webhook starts failing (`stripe_events.error` is where failures are recorded).

Privacy
- [ ] Privacy policy and terms linked in the apps: health and injury notes are sensitive information under the Australian Privacy Act; state what is collected, who sees it (all staff at the studio), and how to ask for deletion.
- [ ] Decide on finding L3 (instructors seeing all clients' health notes) before onboarding studios with larger teams.
