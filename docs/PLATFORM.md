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

**Payments:** each studio needs its own Stripe account for card payments, so the money goes to them. Today the app's Stripe setup is single-account (Snowy's). Connecting each studio's own Stripe (Stripe Connect) is a later step on the roadmap. Until then, new studios can use the app for bookings and take payments at the desk.

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
| Make someone a platform admin | `insert into platform_admins (user_id) select id from auth.users where email = '…';` |
