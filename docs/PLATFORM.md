# Studio Platform: how it works (for Pete)

Hey Pete, this is the plain-English version of how the app now handles more than one studio. Snowy Pilates Club keeps working exactly as it does today. On top of that, you can add other studios, each with its own name, logo, colours, fonts, photos, classes, prices, staff and clients. Nobody at one studio can see anything at another.

Everything here is written for your Mac.

---

## The big picture

| Piece | Who uses it | Where it lives |
|---|---|---|
| **Client app** | Each studio's clients, on their phones | `/` (e.g. `app.snowypilatesclub.com`) |
| **Studio app** | Each studio's owner and staff | `/studio/` |
| **Platform admin** | Just you | `/admin/` |

- One database (Supabase) holds every studio. Every row belongs to a studio, and the database itself refuses to show or change another studio's rows, so a mistake in the app can't leak data between studios.
- One person can have one login across studios. For example, someone can be a client at Snowy and also at another studio, or teach at one and train at another. Each studio has its own waiver, passes and history for them, and nothing carries over.
- Each studio has its own timezone, currency and tax (GST and ABN for Australian studios). Class times, receipts and reports use the studio's own settings.

## How the app knows which studio it is

In order, the first one that matches wins:

1. **A single-studio build.** This is Snowy's setup today: the app is built with `STUDIO_SLUG=snowy` and only ever shows Snowy. There's no studio picker and no "switch studio". Use this for any studio that gets its own web address and, later, its own App Store app.
2. **A subdomain** of the platform domain, e.g. `harbour.studioplatform.app`. Or a studio's own domain (e.g. `book.harbourreformer.com.au`) listed on that studio.
3. **A link with the studio in it**: `…/#/s/harbour` or `…/?studio=harbour`. Handy for QR codes and Instagram bios.
4. **The last studio this phone used.**
5. Otherwise, the client app shows **"Find your studio"** (a searchable list of live studios), and the studio app shows the studios that person works at.

Each studio's short name in addresses (its **slug**, like `snowy` or `harbour`) is set when you create it. It's lowercase letters, numbers and dashes.

## Domains: three ways to run it

**A. One studio, its own address (Snowy today).** One Netlify site, built with `STUDIO_SLUG=snowy`, on `app.snowypilatesclub.com`. Nothing else changes. `docs/GO-LIVE.md` walks through it.

**B. Lots of studios on your platform domain.** One Netlify site for everyone:
1. Buy a domain for the platform (say `studioplatform.app`).
2. In Netlify, add these environment variables: `PLATFORM_DOMAIN=studioplatform.app`, plus `SUPABASE_URL` and `SUPABASE_ANON_KEY` as usual. Don't set `STUDIO_SLUG`.
3. In Netlify **Domain management**, add `studioplatform.app` and a **wildcard** `*.studioplatform.app`. Netlify asks you to use Netlify DNS for wildcards, and HTTPS is automatic.
4. Every studio is then at `<slug>.studioplatform.app` (client app) and `<slug>.studioplatform.app/studio/` (staff). Your admin is at `studioplatform.app/admin/`. `www` and `admin` are never studio names.
5. In Supabase **Authentication → URL Configuration → Redirect URLs**, add `https://*.studioplatform.app/**`. Also set the `PLATFORM_DOMAIN` secret on the edge functions (`supabase secrets set PLATFORM_DOMAIN=studioplatform.app`) so invite emails link to the right studio.

**C. A studio on its own domain, on the shared site.** Add their domain to the same Netlify site (they point a CNAME at Netlify), then add it to the studio's `custom_domains` in Supabase (Table Editor → `studios`). Add it to Supabase's Redirect URLs too.

You can mix these. Snowy can stay on its own build (A) while new studios use B.

## Adding a studio

1. Open `/admin/` and sign in. Your login needs to be a platform admin. The first time, add yourself in the Supabase SQL Editor:
   ```
   insert into platform_admins (user_id) select id from auth.users where email = 'YOUR-EMAIL';
   ```
2. **New studio**: name, web address (slug), email, timezone, and a starting colour palette. It starts in **Setting up**, so clients can't find it yet.
3. **Owner** tab: the owner's name and email. They get an email with a link to set their password, which opens their studio app. (If they already have a login anywhere on the platform, they just sign in with it.)
4. The owner signs in to the studio app and gets the **setup wizard**: studio details, branding (logo, colours, fonts), class types, prices (from templates: memberships, class packs, an intro offer), policies (cancellation window, waitlist cutoff, waiver), inviting staff, then **Go live**. You can also do the branding for them in the admin's **Branding** tab, with a live preview of their client app.
5. Once they're live they show up in "Find your studio" and their links work for clients.

**Payments:** each studio is paid into its **own** Stripe account (Stripe Connect), set up by the owner in the studio app. See "Card payments: Stripe Connect" below. Until a studio has connected, its clients see "Online payments aren't set up yet, pay at the studio", and the studio can still take payments at the desk.

## Card payments: Stripe Connect

Two modes, picked by the edge function settings (not the app build):

| Mode | When | What happens |
|---|---|---|
| **Single account** (the default) | No `STRIPE_CONNECT` setting, or the functions have `STUDIO_SLUG` set | One Stripe account on your own keys, exactly as Snowy runs today. Nothing in this section applies. |
| **Connect** | `STRIPE_CONNECT=1` on the multi-studio platform | Every studio is paid into its own Stripe account. |

**How it works.** Each studio connects a **Standard** account: the studio owns the Stripe account, keeps its own Stripe dashboard, and handles its own disputes and payouts (the simplest liability model for you). Clients pay with **direct charges**: every Stripe call for a studio (customer, checkout, billing portal, refund, membership pause/cancel) carries that studio's `Stripe-Account` header, so the money lands in the studio's account, not yours. Gift cards, appointments, workshops, memberships and packs all work the same way.

The link and its status live in `studio_stripe` (one row per studio: `stripe_account_id`, `charges_enabled`, `payouts_enabled`, `details_submitted`). It's separate from the `studios` table on purpose: the studio list is public, and only the studio's **owner** can read their own Stripe row. Nobody writes it from an app; the edge functions do.

**What the owner sees.** Studio app → **Settings → Payments** (owners only; the tab isn't there on a single-studio build like Snowy) shows **Connect Stripe**, **Finish setup** or **Connected ✓**. The setup wizard has a **Payments** step before Go live that does the same thing (it can be skipped). The button opens Stripe's own onboarding page and brings them back. Coming back refreshes the status from Stripe.

**What a client sees if the studio hasn't connected:** "Online payments aren't set up yet, pay at the studio." Nothing is charged.

### Setting it up (once, on your platform Stripe account)

1. In the Stripe dashboard, open **Connect** and turn it on for your platform account (**Settings → Connect settings**). Choose the platform profile questions as they come up; you're a platform that onboards businesses, and they use **Standard** accounts (they log in to Stripe themselves).
2. **Settings → Connect → Branding**: upload your platform icon and logo and set the colour. Studios see this on the Stripe onboarding page, so use the platform's name rather than Snowy's.
3. **Settings → Connect → Onboarding options**: leave "Standard" on; the app creates the accounts for you, so there's no sign-up link to share.
4. **Developers → Webhooks → Add endpoint**, and under "Listen to" choose **Events on Connected accounts** (not "Your account"):
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`, and **`account.updated`** (this keeps each studio's status right)
   - Save it and **Reveal signing secret**. That's `STRIPE_CONNECT_WEBHOOK_SECRET`. It's a different secret from the ordinary endpoint's.
   - If you use the appointments feature, add a second Connect endpoint for `.../functions/v1/appointments-stripe-webhook` with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired` and `checkout.session.async_payment_failed`. It uses the same `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Set the secrets on the edge functions, then redeploy:
   ```
   supabase secrets set STRIPE_CONNECT=1 \
     STRIPE_SECRET_KEY=sk_live_... \
     STRIPE_CONNECT_WEBHOOK_SECRET=whsec_... \
     PLATFORM_DOMAIN=studioplatform.app \
     APP_URL=https://studioplatform.app
   ```
   The app only sends people back to addresses it trusts after Stripe: `PLATFORM_DOMAIN` covers every studio's subdomain (`harbour.studioplatform.app`), `APP_URL` is the fallback. A studio on its own custom domain also needs that address added to `APP_URLS` (a comma-separated list). `STRIPE_SECRET_KEY` is **your platform's** key, not a studio's.
6. Deploy the two new functions: `supabase functions deploy connect-onboard` and `supabase functions deploy connect-status`. Run `supabase db push` for migration `0011_stripe_connect.sql`. `stripe-webhook` and `appointments-stripe-webhook` stay `--no-verify-jwt`.
7. Each studio's **customer portal** (Stripe → Settings → Billing → Customer portal) is switched on in the studio's own Stripe account, by the studio. Ask them to do it once, same as Snowy's setup in GO-LIVE.

### Settings (edge function secrets)

| Name | What it does |
|---|---|
| `STRIPE_CONNECT` | `1` turns Connect mode on. Leave it out for single-account. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Signing secret of the "Events on Connected accounts" endpoint. |
| `STRIPE_WEBHOOK_SECRET` | Optional in Connect mode (your own account's events aren't used for anything), required in single-account mode. |
| `PLATFORM_FEE_BPS` | Optional platform fee in basis points (100 = 1%), taken from each card payment and subscription via Stripe's application fee. Default 0. The pitch is no platform fee; the option is just there. |
| `STUDIO_SLUG` | If set, the functions stay in single-account mode whatever `STRIPE_CONNECT` says. |

### Notes

- A studio's Stripe account is created the first time its owner clicks **Connect Stripe**, then reused (**Finish setup** carries on where they stopped). Their email and business name are pre-filled from the studio's details.
- Webhook events carry the connected account, which maps to the studio. Every handler then only touches that studio's rows, so one studio can never sell into, or refund, another's.
- Switching a studio to a different Stripe account later isn't supported by the app (saved customers and prices belong to the old account). Ask a developer.
- Existing clients, passes and sales are untouched. Only new payments use the connected account.

## Plans and billing

What a studio pays you (the monthly plan) is separate from what its clients pay the studio (Stripe Connect, above). Plans, prices and what each plan switches on are **rows in a table, not code**, so you can change them without a developer.

**Plans.** Platform admin (`/admin/`) → **Plans**. Each plan has a name, monthly price (AUD), a Stripe price id, an order and a list of switches (check-in kiosk, reviews, bulk email, support, family accounts, appointments, on-demand videos, gift cards and retail, payroll, ClassPass and Xero, branded app, custom domain, multiple locations). The first draft is Studio $99, Studio Plus $179 and Signature $299; edit freely. Bulk email is in every plan. The bookings, passes, POS and reports basics are always on.

**Trial and grace.** Same page: free trial for new studios (14 or 30 days) and the grace period (default 14 days). A new studio starts on the cheapest plan with a free trial.

**What a studio sees.** Studio app → **Settings → Plan and billing** (owners; not on a single-studio build): current plan, trial days left, **Manage billing**, and a comparison of the plans with a Choose button. A feature the plan doesn't include shows a calm "Available on Studio Plus" page where its screen would be, not an error.

**Past due.** If a payment fails, staff see a banner. After the grace period the studio app goes read-only for staff (they can look, not change). Clients can still book. Paying again lifts it at once. A cancelled plan, or a trial that ended with no plan chosen and the grace period used up, is read-only the same way.

**Manual plans.** Admin → a studio → **Plan** tab: set its plan and status by hand, and tick **Comped** for a studio that doesn't pay (Snowy is on Signature, comped). The studio list shows each studio's plan and status, and the Plans page shows monthly recurring revenue (paying studios only, comped ones count as $0).

**Snowy's own build** (`STUDIO_SLUG=snowy`) has every feature on, always, and no billing screens.

### Setting it up (once, on your platform Stripe account)

This is the platform's own Stripe account (the one Connect sits on), not a studio's. Never use a studio's keys here.

1. **Products:** in Stripe → Product catalogue, make one product per plan (Studio, Studio Plus, Signature) with a **monthly recurring price in AUD**. Copy each price id (`price_...`).
2. Paste each price id into **Admin → Plans → Stripe price id**. A plan with no price id shows in the comparison but can't be bought online yet.
3. **Customer portal:** Stripe → Settings → Billing → Customer portal (on the platform account). Turn on updating payment methods, viewing invoices and cancelling. Plan changes are done in the app, so you can leave plan switching off in the portal.
4. **Developers → Webhooks → Add endpoint**, under "Listen to" choose **Events on your account** (not Connected accounts):
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/platform-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
   - Reveal the signing secret. That's `PLATFORM_BILLING_WEBHOOK_SECRET`. It is a different secret from the studios' client-payment ones.
5. Set the secrets, then deploy:
   ```
   supabase secrets set PLATFORM_STRIPE_SECRET_KEY=sk_live_... PLATFORM_BILLING_WEBHOOK_SECRET=whsec_...
   supabase db push
   supabase functions deploy platform-subscribe platform-portal
   supabase functions deploy platform-webhook --no-verify-jwt
   ```
   `db push` applies `0012_platform_billing.sql` and `2100_plan_gating.sql`. The functions that staff use (refunds, marketing sends, invites) also need a redeploy so they know about read-only: `supabase functions deploy refund-payment marketing-send invite-user`.

| Name | What it does |
|---|---|
| `PLATFORM_STRIPE_SECRET_KEY` | Your platform's Stripe key for plan billing. In Connect mode it falls back to `STRIPE_SECRET_KEY` (which is the same account), otherwise it's required. |
| `PLATFORM_BILLING_WEBHOOK_SECRET` | Signing secret of the "Events on your account" endpoint for `platform-webhook`. |
| `STUDIO_SLUG` | If set, there's no billing at all: the functions say so and nothing is ever read-only. |

**How a plan change flows.** The owner picks a plan → `platform-subscribe` opens Stripe Checkout (their free trial carries over if more than 2 days are left, so the first charge is the day it ends). Stripe tells `platform-webhook`, which sets the studio's plan and status (trialing, active, past due, cancelled). A studio already subscribed switches in place, prorated, with no Checkout. The webhook is the only thing that moves a studio to cancelled or past due.

**Notes.** Billing fields on a studio (plan, status, trial end) are public like the rest of the studio list; the Stripe ids and renewal date are owner-only (`my_billing()`, `studio_billing`). A studio created any other way than the admin's **Add a studio** has no plan, so nothing is locked for it.

## Suspending a studio

In the admin, open the studio and click **Suspend studio**. Clients see a polite "taking a break" page and can't book. Staff can still sign in and look, but can't change anything. Nothing is deleted, and **Reopen studio** puts it straight back.

## Snowy is studio #1

- Its look lives in `src/data/studios/snowy.ts` (logo, colours, fonts, photos, the marquee phrases, the welcome line). The live database gets the same record from `supabase/seed.sql`. If you change the file, run `node scripts/studio-sql.mjs snowy --write` to refresh the seed. The seed only fills in branding that's empty, so it never overwrites changes Libby made in the studio app.
- Libby can now change her own branding in the studio app under **Settings → Branding**.

## The demo

The demo (no Supabase set up, or `?demo=1`) has two studios so you can see the white-labelling: **Snowy Pilates Club** (exactly the old demo data) and **Harbour Reformer Co.** (a made-up reformer studio in Double Bay, deep green and sand, different fonts). The admin demo signs you in as **pete@studioplatform.example**. Demo data is stored in the browser, and **Settings → Demo → Reset demo data** in the studio app puts everything back.

## Later: each studio's own app in the App Store

The apps are built to be wrapped with Capacitor (no browser-only tricks), and a single-studio build already has everything a store listing needs:

1. Build with `STUDIO_SLUG=<slug> node build.mjs`. The app's name, icon colour and home-screen name come from that studio's branding.
2. Wrap `dist/` with Capacitor, with the studio's icon and splash screen.
3. Each studio's app is published under **their own** Apple and Google developer accounts (Apple prefers this for white-label apps, and it keeps reviews and payouts theirs). Budget a day per studio for the first one and an hour or two after that.

Nothing about the database changes for this. It's the same platform with a different front door.

## Quick reference

| What | Where |
|---|---|
| Studio list, new studio, branding, owner, suspend | `/admin/` |
| Snowy's branding file | `src/data/studios/snowy.ts` |
| Refresh Snowy's branding in the seed | `node scripts/studio-sql.mjs snowy --write` |
| Single-studio build | `STUDIO_SLUG=snowy node build.mjs` |
| Multi-studio build with subdomains | `PLATFORM_DOMAIN=studioplatform.app node build.mjs` |
| Studios table | Supabase → Table Editor → `studios` |
| A studio's Stripe connection | Supabase → Table Editor → `studio_stripe` (owner sees theirs in Settings → Payments) |
| Plans, prices, trial and grace, MRR | `/admin/` → Plans (table: `plans`) |
| A studio's plan and billing | `/admin/` → studio → Plan (tables: `studios`, `studio_billing`) |
| Make someone a platform admin | `insert into platform_admins (user_id) select id from auth.users where email = '…';` |
