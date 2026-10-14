# Going live: Snowy Pilates Club app

Hey Pete, this is the step-by-step for switching the app from demo mode to the real thing, so Libby can drop Momence. No coding needed, just a lot of copy and paste. Budget a quiet afternoon for steps 1 to 10, then a week or two of running both systems side by side.

Everything here is on a Mac. Where you see `THIS-STYLE` text, swap in your own value.

**What you're setting up**

| Piece | What it does | Rough cost |
|---|---|---|
| Supabase | The database, logins, and the small server bits ("edge functions") | Free to start, US$25/month on Pro |
| Stripe | Card payments, Apple Pay/Google Pay, weekly membership billing | Per transaction only |
| Resend | Sends the emails (booking confirmations, receipts, reminders) | Free up to a few thousand a month |
| Netlify | Hosts the app (you already use it for the website) | Free |

Prices change, so **check current pricing** on each site. There's a full cost rundown at the end.

---

## Before you start

1. Make a note somewhere safe (1Password, Apple Passwords, etc.) called **"Snowy app keys"**. You'll paste a handful of keys and secrets into it as you go.
2. Make up a long random password for scheduled jobs. Open Terminal (Cmd+Space, type "Terminal") and run:
   ```
   openssl rand -hex 24
   ```
   Save the result in your note as **CRON_SECRET**.
3. Decide the app's web address. The suggestion is **app.snowypilatesclub.com** for clients (with the studio app at **app.snowypilatesclub.com/studio/**). You can start with the Netlify address (like `snowy-app.netlify.app`) and add the nice one later.

---

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com), sign up (GitHub login is easiest) and click **New project**.
2. Organisation: make one called "Snowy Pilates Club". Ideally Libby owns it, with you invited as a member.
3. Name: `snowy-pilates-club`. Database password: click **Generate**, then save it in your note.
4. **Region: Sydney (ap-southeast-2).** This one matters for speed, and it keeps client data in Australia.
5. Wait about 2 minutes for it to finish setting up.
6. Go to **Project Settings → API** and copy these into your note:
   - **Project URL** (`https://abcdefgh.supabase.co`). The `abcdefgh` part is your **project ref**.
   - **anon public** key. This is safe to put in the app.
   - **service_role** key. **This one is secret.** It never goes in the app, Netlify or an email.

## 2. Set up the database

Option A is copy and paste, which is the easiest way for a one-off.

1. In Supabase, open **SQL Editor → New query**.
2. Open `supabase/migrations/0001_init.sql` from this project in TextEdit (or VS Code). Select all, copy, paste it into the editor and click **Run**. You should see "Success. No rows returned".
3. Do the same, in order, for:
   - `supabase/migrations/0002_booking.sql`
   - `supabase/migrations/0003_money.sql`
   - `supabase/migrations/0004_outbox.sql`
   - `supabase/seed.sql` (studio settings, class types, prices and the team)
4. Check it worked: open **Table Editor**. You should see tables like `class_types` (3 rows), `products` (10 rows) and `staff` (Libby, Julia, Grace T, Grace P).

Option B uses the Supabase CLI. You'll need the CLI for step 8 anyway, so if you install it first you can do this instead:
```
brew install supabase/tap/supabase
cd ~/path/to/snowy-app
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```
Then paste `supabase/seed.sql` into the SQL editor and run it.

> Never run anything from `supabase/tests/`. Those files are for testing on a computer only.

## 3. Fill in the studio details

In **Table Editor**:

1. `studio_settings`: add Libby's **ABN** and the studio **phone**. Check the waiver text and health questions too. They're sensible defaults, so get Libby to read them and change anything she wants. She can also do this later in the studio app under Settings.
2. `staff`: put each person's **real email** in the `email` column. This is how their login finds them. Add anyone missing (role is one of `owner`, `manager`, `front_desk` or `instructor`).
3. Timetable: the easiest way is the studio app (Schedule → weekly timetable) once you're logged in as Libby (step 5). Each weekly slot creates classes automatically every Sunday night, for 4 weeks ahead.

## 4. Login settings (Authentication)

1. **Authentication → Providers → Email**: make sure it's on.
   - **Confirm email: ON.** People have to click a link before they can sign in. This stops anyone signing up as someone else.
   - Minimum password length: **8**.
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://app.snowypilatesclub.com` (or your Netlify address for now).
   - **Redirect URLs**: add all of these:
     - `https://app.snowypilatesclub.com/**`
     - `https://YOUR-NETLIFY-SITE.netlify.app/**`
     - `capacitor://localhost/**` and `https://localhost/**` (for the iPhone/Android apps later)
     - `snowypilates://**` (the app's own link scheme, for later)
3. **Authentication → Emails → SMTP Settings**: turn on **custom SMTP** using Resend (set up Resend first, in step 7). Supabase's built-in email only sends a handful of emails an hour, so sign-ups would get stuck without this.
   - Host `smtp.resend.com`, port `465`, username `resend`, password = your Resend API key
   - Sender email `hello@snowypilatesclub.com`, sender name `Snowy Pilates Club`
4. **Authentication → Emails → Templates**: optionally tweak the wording of "Confirm signup" and "Reset password" so they sound like the studio.

## 5. Create the staff logins

1. **Authentication → Users → Add user → Send invitation**, using the **same email** you put in the `staff` table.
2. They'll get an email, set a password, and that's it. The login links itself to their staff profile automatically.
3. Check it: in SQL Editor, run
   ```
   select name, role, email, user_id is not null as linked from staff;
   ```
   Everyone who has accepted their invite shows `linked = true`.
4. Libby (owner) can now sign in at `/studio/`. Only the owner can see pay rates and change the ABN.

If someone made a client account with their staff email before you added them to `staff`, no stress. Adding or updating their staff row links the existing login (their client profile just stays unused).

## 6. Stripe

1. Create the account at [stripe.com](https://stripe.com) **in Libby's business name**: her ABN, business bank account and her as the representative. You can help her through it, but it's her account, her money and her payouts.
2. **Settings → Business → Public details**: name "Snowy Pilates Club", support email, and a statement descriptor like `SNOWY PILATES`.
3. **Settings → Branding**: upload the logo, accent colour `#5069AC`.
4. **Settings → Payment methods**: cards, **Apple Pay** and **Google Pay** should be on by default. Stripe Checkout handles the Apple Pay domain stuff itself.
5. **Settings → Billing → Customer portal**: switch it on. Allow "update payment method" and "view invoices". Leave cancelling memberships turned off in the portal, so cancellations go through the app and follow the studio's rules.
6. **Settings → Billing → Subscriptions and emails**: turn on "Send emails when card payments fail" and Smart Retries.
7. **No need to create products or prices.** The app sends each price to Stripe when someone checks out, using the prices in the `products` table. To change a price, change it in the studio app.
   - A price change only affects **new** memberships. Existing weekly subscriptions keep their old price unless you change them in Stripe.
8. Start in **Test mode** (the toggle at the top). Copy **Developers → API keys → Secret key** (`sk_test_...`) into your note as `STRIPE_SECRET_KEY`.
9. **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`
   - After saving, click **Reveal signing secret** (`whsec_...`) and save it as `STRIPE_WEBHOOK_SECRET`.

Fees are roughly **1.7% + 30c** for domestic cards (international cards cost more). **Check current pricing.**

## 7. Resend (emails)

1. Sign up at [resend.com](https://resend.com).
2. **Domains → Add domain → `snowypilatesclub.com`**. Resend shows 3 or 4 DNS records (TXT/MX/CNAME).
3. Add those records wherever the domain's DNS lives. That's probably Netlify (**Domains → snowypilatesclub.com → DNS settings → Add new record**), or else the registrar where you bought the domain. Copy each one exactly.
4. Back in Resend, click **Verify**. It can take anywhere from a few minutes to a few hours.
5. **API Keys → Create** (sending access). Save it as `RESEND_API_KEY`.
6. Now go back and finish step 4.3 (Supabase SMTP).

## 8. Deploy the server functions

These are the small server bits in `supabase/functions/`: checkout, the Stripe webhook, emails, reminders, membership pause/cancel, and refunds.

1. Install the Supabase CLI if you haven't already: `brew install supabase/tap/supabase` (needs [Homebrew](https://brew.sh)).
2. In Terminal:
   ```
   cd ~/path/to/snowy-app
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```
3. Set the secrets (one long command, so paste your values in):
   ```
   supabase secrets set \
     STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     RESEND_API_KEY=re_... \
     EMAIL_FROM="Snowy Pilates Club <hello@snowypilatesclub.com>" \
     EMAIL_REPLY_TO=admin@snowypilatesclub.com \
     APP_URL=https://app.snowypilatesclub.com \
     APP_URLS=https://app.snowypilatesclub.com,https://YOUR-NETLIFY-SITE.netlify.app \
     CRON_SECRET=THE-RANDOM-ONE-FROM-BEFORE
   ```
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.)
4. Deploy them all:
   ```
   supabase functions deploy create-checkout
   supabase functions deploy billing-portal
   supabase functions deploy refund-payment
   supabase functions deploy stripe-webhook --no-verify-jwt
   supabase functions deploy send-email --no-verify-jwt
   supabase functions deploy send-reminders --no-verify-jwt
   supabase functions deploy manage-membership --no-verify-jwt
   ```
   (`--no-verify-jwt` is already set in `supabase/config.toml` too. Those functions check their own secret instead of a login.)

## 9. Instant emails and scheduled jobs

1. **Database → Extensions**: turn on **pg_cron** and **pg_net**.
2. **Instant emails**: go to **Database → Webhooks → Create a new hook**:
   - Name `send-email`, table `notifications`, events: **Insert**
   - Type: **Supabase Edge Functions**, function `send-email`, method POST
   - HTTP headers: add `x-cron-secret` = your CRON_SECRET
3. **Scheduled jobs**: open `supabase/cron.sql`, replace `YOUR-PROJECT-REF` and `YOUR-CRON-SECRET` (each appears twice), paste it into the SQL Editor and run it. That sets up:
   - every 15 min: clear waitlists once class starts, expire old passes, queue **class reminders 2 hours before**
   - every 2 min: send any emails still waiting (a safety net for the instant webhook)
   - Sundays: create the next 4 weeks of classes from the timetable
   - daily: tell Stripe about membership pauses starting or ending that day
   - weekly: tidy up old emails
4. Check it: `select jobname, schedule from cron.job;` should list 5 jobs.

## 10. Point the app at the real backend (Netlify)

The app is a separate Netlify site from the marketing website.

1. Netlify → **Add new site → Import from Git** → choose the app repo.
2. Build command: `npm run build`. Publish directory: `dist`.
3. **Site configuration → Environment variables**: add
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = the **anon public** key (never the service_role one)
4. Deploy. With those two set, the app switches from demo to live by itself. To see the demo again at any time, add `?demo=1` to the address.
5. **Domain management → Add a domain**: `app.snowypilatesclub.com`. Netlify gives you a DNS record to add, and HTTPS is automatic.
6. On the marketing website, change the "Book" and "See the schedule" buttons from Momence to the new app when you're ready (step 13).

## 11. Test everything in Stripe test mode

Use your own email, then a second one (Gmail's `you+test@gmail.com` trick works).

- [ ] Sign up as a client, confirm the email, sign in
- [ ] Sign the waiver and health form
- [ ] Buy the intro offer with test card **4242 4242 4242 4242** (any future expiry, any CVC). The pass shows up within a few seconds and a receipt email arrives.
- [ ] Book a class and get the confirmation email (with the cancellation policy)
- [ ] Fill a class (set capacity to 1 in the studio app), join the waitlist with the second account, cancel the first booking, and the waitlisted person gets booked and emailed
- [ ] Cancel more than 3 hours out and the credit comes back. Cancel inside 3 hours and the credit is lost.
- [ ] Buy a weekly membership. In Stripe → Subscriptions you see it as weekly.
- [ ] Pause the membership in the app. In Stripe the subscription shows "paused" (from the pause start date).
- [ ] Studio app as front desk: check someone in, sell grip socks for cash, refund an online sale. In Stripe the refund appears.
- [ ] Studio app as an instructor: can only see their own classes' rosters, no revenue.
- [ ] Cancel a class from the studio app. Everyone's credit comes back and they get an email.

If something doesn't arrive, look here:
- **Edge Functions → (function) → Logs** in Supabase
- table `stripe_events` (the `error` column) for webhook problems, and Stripe → Webhooks → your endpoint for failed deliveries (you can resend them)
- table `notifications` (the `error` column) for emails that didn't send

## 12. Bring your clients across from Momence

1. In Momence, export **customers** (CSV) and a list of **active memberships and class packs** (CSV). Momence's export menus move around, so ask their support for "customers export" and "active memberships/packs export" if you can't find them.
2. Open `supabase/import/momence_import.sql`. The top of the file lists the column names it expects.
3. Run that whole file once in the SQL Editor. It creates two empty "staging" tables.
4. In Numbers or Excel, rename each CSV's header row to match the expected names (delete any columns you don't need), then export as CSV.
5. **Table Editor → import_momence_clients → Insert → Import data from CSV**. Do the same for `import_momence_passes`.
6. Run `momence_import.sql` again. It copies everyone in and prints a summary (including any passes it couldn't match to a client email). Running it again later is safe, because nobody gets added twice.
7. Spot-check 5 to 10 clients in the studio app against Momence (credits left, expiry dates).
8. When you're happy, delete the staging tables (the last two lines of the file).

What happens to imported people:
- Clients don't need a new account. When they **sign up with the same email** and confirm it, they're linked to their imported profile, passes and history.
- Imported packs keep their credits and Momence expiry date.
- **Memberships can't carry their card details over from Momence.** Imported memberships work until their paid-up date. Ask members to re-join the same membership in the app before then (an email from Libby with the link does the job), and cancel them in Momence at the same time so nobody pays twice.
- Imported clients can't take the intro offer (they're not new).

## 13. Run both systems side by side (1 to 2 weeks)

1. **Week 1**: staff use the new studio app for check-ins alongside Momence, and new clients sign up in the new app. Existing clients keep booking in Momence.
2. Re-run the import (step 12) just before switching, so recent sign-ups and pack changes come across.
3. **Switch day** (pick a quiet day):
   - Change the website buttons to the new app.
   - Turn off online booking in Momence, or set its classes to staff-only.
   - Email all clients: "We've moved to our own app! Sign up with the same email and your passes are already there."
   - Members re-join their membership in the app, and Libby cancels their Momence membership.
4. Keep Momence for one more billing cycle as a safety net, then cancel the subscription.
5. Flip Stripe to **live mode**: create a live webhook endpoint (step 6.9) and update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with the live values (step 8.3). Do one real $30 purchase and refund it to be sure.

## 14. Backups

- **Supabase Pro (US$25/month)** includes daily backups kept for 7 days, and projects never "pause". Once real money and bookings are flowing, that's worth it. **Check current pricing.**
- **On the free plan** there are no backups you can restore, and a project can be paused after about a week with no activity (a busy studio won't hit that, but holidays might). To be safe on free:
  - Once a week, the studio app's **Reports → Export** gives you sales and clients as CSVs. Save them in a shared Google Drive or iCloud folder.
  - Or a full database copy from Terminal: `supabase db dump -f snowy-backup-$(date +%F).sql` (and `--data-only` for just the data).
- Stripe keeps its own full record of every payment, so money is never only in this database.

## 15. Monthly costs (check current pricing)

| | Now (Momence) | New setup |
|---|---|---|
| Booking software | ~$300/month | $0 (Supabase free) or ~A$40/month (Supabase Pro, US$25) |
| Emails | included | $0 (Resend free tier, around 3,000 emails/month and 100/day; Pro is US$20/month if you outgrow it) |
| Hosting | included | $0 (Netlify free) |
| Card fees | Momence's rate | Stripe about 1.7% + 30c per domestic card payment (no monthly fee) |
| App stores (later) | n/a | Apple Developer US$99/year, Google Play US$25 once |

Example: about 150 weekly memberships averaging $45 is roughly 600 charges a month. Stripe fees come to about 600 × (1.7% × $45 + $0.30) ≈ **$640/month**. Card fees exist on any platform, so compare them with what Momence charges per transaction today, not with zero.

Resend's free tier caps at about 100 emails a day. A busy day of confirmations, reminders and receipts for a few hundred clients can go over that. If emails start failing with "rate limit", either upgrade Resend or switch off the reminder job (`select cron.unschedule('housekeeping');` then re-add it without the reminders line).

## Quick reference

| Thing | Where |
|---|---|
| Change prices, classes, timetable, staff, policies | Studio app |
| Who can do what | `RULES.md` → Staff permissions (enforced in the database) |
| Payment problems | Stripe dashboard, plus table `stripe_events` |
| Email problems | Resend → Logs, plus table `notifications` |
| Server logs | Supabase → Edge Functions → Logs |
| Database tests (for a developer) | `bash supabase/tests/run.sh` (runs on a local Postgres, never touches the real one) |
