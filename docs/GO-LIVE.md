# Going live: Snowy Pilates Club app

Hey Pete, this is the step-by-step for switching the app from demo mode to the real thing so Libby can drop Momence. There's no coding, just a fair bit of copy and paste. Budget a quiet afternoon for parts 1–10. Then follow the launch plan in part 12, which runs about three to four weeks from first test to cancelling Momence.

Everything here is written for your Mac. Wherever you see `THIS-STYLE` text, swap in your own value.

The code is now a multi-studio platform (see `docs/PLATFORM.md`), but Snowy is set up here as a **single-studio app**: one Netlify site built for Snowy only, on Snowy's own web address. Libby and her clients never see a studio picker or anything about other studios. Snowy is studio #1 in the database, so if you add more studios later, nothing here needs redoing.

**What you're setting up**

| Piece | What it does | Rough cost (check current pricing) |
|---|---|---|
| Supabase | The database, logins, photo storage and the little server bits ("edge functions") | Free to start, about US$25/month on Pro |
| Stripe | Card payments, Apple Pay and Google Pay, weekly membership billing | Per transaction only |
| Resend | Sends the emails (booking confirmations, receipts, reminders) | Free up to about 3,000/month (100 a day) |
| Netlify | Hosts the app (you already use it for the website) | Free |

Prices change all the time, so **check current pricing** on each site before you sign up. There's a cost rundown at the end.

---

## Before you start

1. Make a secure note somewhere safe (Apple Passwords, 1Password, etc.) called **"Snowy app keys"**. You'll paste a handful of keys into it as you go.
2. Make up a long random password for the scheduled jobs. Open Terminal (Cmd+Space, type "Terminal", Enter) and run:
   ```
   openssl rand -hex 24
   ```
   Save what it prints in your note as **CRON_SECRET**.
3. Pick the app's web address. The suggestion is **app.snowypilatesclub.com** for clients, with the studio app at **app.snowypilatesclub.com/studio/**. You can start with the Netlify address (like `snowy-app.netlify.app`) and add the nice one later.

---

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com), sign up (GitHub login is easiest) and click **New project**.
2. Organisation: make one called "Snowy Pilates Club". Ideally Libby owns it and you're invited as a member.
3. Name it `snowy-pilates-club`. For the database password, click **Generate** and save it in your note.
4. **Region: Sydney (ap-southeast-2).** This one matters. It's faster for Cooma and keeps client data in Australia.
5. Give it about 2 minutes to finish setting up.
6. Go to **Project Settings → API** (it may be called **API Keys** or **Data API**) and copy these into your note:
   - **Project URL** (`https://abcdefgh.supabase.co`). The `abcdefgh` bit is your **project ref**.
   - **anon / public** key. This one's safe to put in the app.
   - **service_role / secret** key. **Keep this one secret.** It never goes in the app, in Netlify or in an email.

## 2. Set up the database

The easiest way for a one-off is copy and paste (option A).

**Option A: SQL Editor**

1. In Supabase, open **SQL Editor → New query**.
2. Open `supabase/migrations/0001_init.sql` from this project in TextEdit or VS Code. Select all, copy, paste it into the editor and click **Run**. You should see "Success. No rows returned".
3. Do the same for each of these, **in this order**:
   1. `supabase/migrations/0002_booking.sql`
   2. `supabase/migrations/0003_money.sql`
   3. `supabase/migrations/0004_outbox.sql`
   4. `supabase/migrations/0005_alignment.sql`
   5. `supabase/migrations/0006_profiles_permissions.sql`. This one also creates the **avatars** photo bucket (see step 5 below).
   6. `supabase/migrations/0007_platform.sql`. This makes the database multi-studio: it adds the `studios` table with **Snowy as studio #1** (and the default), tags every row with its studio, and creates the **branding** photo bucket. It's the biggest file, so give it a few seconds.
   7. `supabase/seed.sql`. This adds the studio settings, class types, prices, the team, and Snowy's look (logo, colours, fonts, photos and wording, exactly as in the demo).
   If more migration files turn up later (they're numbered, like `1100_appointments_….sql`), run them in number order after these.
4. Check it worked: open **Table Editor**. You should see `studios` (1 row: `snowy`, status `live`), `class_types` (3 rows), `products` (10 rows) and `staff` (Libby, Julia, Grace T and Grace P).
5. Check the photo bucket: open **Storage**. There should be a bucket called **avatars** marked **Public**. That's where client profile photos go. Anyone with a photo's link can see it, clients can only upload into their own folder, and staff can upload for anyone. If it's not there, re-run `0006_profiles_permissions.sql`.

**Option B: the Supabase CLI.** You'll need the CLI for part 8 anyway, so if you install it first you can do this instead:
```
brew install supabase/tap/supabase
cd ~/path/to/snowy-app
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```
Then paste `supabase/seed.sql` into the SQL Editor and run it.

> Never run anything from `supabase/tests/` on the real project. Those files are only for testing on a computer.

## 3. Fill in the studio details

In **Table Editor**:

1. `studio_settings`: add Libby's **ABN** and the studio **phone**. Have Libby read the waiver text, health questions and cancellation policy, because they go out in emails. She can change all of this later in the studio app under Settings.
2. `staff`: put each person's **real email** in the `email` column. That's how their login finds them. The roles are already set:
   - **Libby**: `owner` (everything, including pay rates, ABN and GST)
   - **Julia** and **Grace T**: `instructor` (their own classes' rosters and check-in, client profiles, the till, attendance reports)
   - **Grace P**: `front_desk`. That covers the schedule, every roster, check-in, clients, staff notes, the till and refunds, and attendance reports. It doesn't include revenue, pay or settings. She still teaches Mums + Bubs. Anyone can be the instructor on a class whatever their role, and pay reports go by who taught each class.
3. The look: Libby can change the logo, colours, fonts, photos and welcome wording herself in the studio app under **Settings → Branding**. It starts out exactly as the demo looks.
4. Timetable: the easiest way is the studio app (Schedule → weekly timetable) once you're signed in as Libby (part 5). When you add a weekly slot, its classes appear straight away, and a Sunday job keeps four weeks ahead topped up. Set Grace P as the instructor on the Mums + Bubs slot.

## 4. Login settings (Authentication)

1. **Authentication → Providers (or Sign In / Providers) → Email**: make sure it's on.
   - **Confirm email: ON.** People have to tap a link before they can sign in, which stops anyone signing up as someone else.
   - Minimum password length: **8**.
2. **Authentication → URL Configuration**:
   - **Site URL**: `https://app.snowypilatesclub.com` (or your Netlify address for now).
   - **Redirect URLs**: add all of these:
     - `https://app.snowypilatesclub.com/**`
     - `https://YOUR-NETLIFY-SITE.netlify.app/**`
     - `capacitor://localhost/**` and `https://localhost/**` (for the App Store/Google Play versions later)
3. **Authentication → Emails → SMTP Settings**: turn on **custom SMTP** using Resend. Set up Resend first (part 7), then come back. Supabase's built-in email only sends a few emails an hour, so sign-ups would get stuck without this.
   - Host `smtp.resend.com`, port `465`, username `resend`, password = your Resend API key
   - Sender email `hello@snowypilatesclub.com`, sender name `Snowy Pilates Club`
4. **Authentication → Rate Limits**: raise "emails sent per hour" to about **100** for launch week, because lots of people will sign up at once.
5. **Authentication → Emails → Templates**: optionally tweak the "Confirm signup", "Reset password" and "Invite user" wording so it sounds like the studio. Reset and invite links open the app's own "Choose a new password" screen, then sign the person straight in.

## 5. Give the staff their logins

The simplest way is to make each login yourself with a temporary password.

1. Make sure their email is in the `staff` table first (part 3).
2. **Authentication → Users → Add user → Create new user**. Enter the **same email**, a temporary password, and tick **Auto Confirm User**.
3. That's it. The login links itself to their staff profile. Send them the temporary password privately (a text is fine) and ask them to change it with "Forgot password" on the sign-in screen.
4. Do this for Libby, Julia, Grace T and **Grace P** (front desk).
   - Or, instead of a temporary password: **Add user → Send invitation**. They get an email, tap the link, see "Welcome to the team" and choose their own password. The link opens the Site URL (the client app), which then points staff to the studio app.
5. Check it in the SQL Editor:
   ```
   select name, role, email, user_id is not null as linked from staff;
   ```
   Everyone should show `linked = true`, and Grace P should be `front_desk`.
6. Staff sign in at **/studio/** (for example `app.snowypilatesclub.com/studio/`). The client app at `/` only takes client accounts, and the studio app only takes staff, just like the demo.

If someone made a client account with their staff email before you added them to `staff`, no stress. Adding or updating their staff row links the existing login.

## 6. Stripe

1. Create the account at [stripe.com](https://stripe.com) **in Libby's business name**: her ABN, the business bank account and her as the representative. You can help her through it, but it's her account, her money and her payouts.
2. **Settings → Business → Public details**: name "Snowy Pilates Club", a support email, and a statement descriptor like `SNOWY PILATES`.
3. **Settings → Branding**: upload the logo and set the accent colour to `#5069AC`.
4. **Settings → Payment methods**: cards, **Apple Pay** and **Google Pay** should be on by default. You can also turn on **BECS Direct Debit** if Libby wants members paying straight from their bank account. The app handles both.
5. **Settings → Billing → Customer portal**: switch it on. Allow "update payment method" and "view invoices". Leave cancelling turned **off** in the portal, so cancellations go through the app and follow the studio's rules.
6. **Settings → Billing → Subscriptions and emails**: turn on "Send emails when card payments fail" and Smart Retries.
7. **No need to create products or prices.** The app sends each price to Stripe at checkout, using the prices in the studio app.
   - A price change only affects **new** memberships. Existing weekly memberships keep their old price unless you change them in Stripe.
   - Weekly membership billing starts the day someone joins online, which is when they pay their first week. If they cancel, it keeps working until the end of the week they've paid for.
8. Start in **Test mode** (the toggle at the top). Copy **Developers → API keys → Secret key** (`sk_test_...`) into your note as `STRIPE_SECRET_KEY`.
9. **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`
   - After saving, click **Reveal signing secret** (`whsec_...`) and save it as `STRIPE_WEBHOOK_SECRET`.

Fees are roughly **1.7% + 30c** per domestic card payment (international cards cost more). **Check current pricing.**

### Snowy stays on its own Stripe account (single-account mode)

Everything in this part is Snowy's **own** Stripe account and keys, and that doesn't change when you add other studios to the platform. Don't set `STRIPE_CONNECT` for Snowy's functions. The Settings → Payments tab (the "Connect Stripe" button for new studios) isn't in the single-studio Snowy build, and card payments, memberships, refunds and the billing portal all use `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as above.

If Snowy ever shares one Supabase project with the multi-studio platform, the platform's Connect mode would apply to Snowy too (Snowy would need to connect its own Stripe like any studio). To avoid that, keep Snowy in its own Supabase project (as this guide sets up), or set `STUDIO_SLUG=snowy` as a function secret so those functions stay on Snowy's keys. Platform steps for other studios are in `docs/PLATFORM.md` → Card payments: Stripe Connect.

## 7. Resend (emails)

1. Sign up at [resend.com](https://resend.com).
2. Go to **Domains → Add domain** and add `snowypilatesclub.com`. Resend will show you 3 or 4 DNS records.
3. Add those records wherever the domain's DNS lives. That's probably Netlify (**Domains → snowypilatesclub.com → DNS settings → Add new record**), or else the registrar you bought the domain from. Copy each one exactly.
4. Back in Resend, click **Verify**. It can take anywhere from a few minutes to a few hours.
5. **API Keys → Create** (sending access). Save it as `RESEND_API_KEY`.
6. Now go back and finish part 4, step 3 (Supabase SMTP).

## 8. Deploy the server functions

These are the little server bits in `supabase/functions/`: checkout, the Stripe webhook, emails, reminders, membership pause/cancel, refunds, the billing portal and staff invites.

1. Install the Supabase CLI if you haven't already. It needs [Homebrew](https://brew.sh):
   ```
   brew install supabase/tap/supabase
   ```
2. In Terminal:
   ```
   cd ~/path/to/snowy-app
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```
3. Set the secrets. It's one long command, so paste your values in:
   ```
   supabase secrets set \
     STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     RESEND_API_KEY=re_... \
     EMAIL_FROM="Snowy Pilates Club <hello@snowypilatesclub.com>" \
     EMAIL_REPLY_TO=admin@snowypilatesclub.com \
     APP_URL=https://app.snowypilatesclub.com \
     APP_URLS=https://app.snowypilatesclub.com,https://YOUR-NETLIFY-SITE.netlify.app \
     CRON_SECRET=THE-RANDOM-ONE-FROM-BEFORE \
     SUPPORT_ALERT_EMAIL=you@yourphone.com
   ```
   `SUPPORT_ALERT_EMAIL` is where an urgent help request from a studio is emailed (page, person, message and a link to the admin inbox at `/admin/#/support`). Use an address that buzzes your phone. Optional later: `SUPPORT_ALERT_SMS_WEBHOOK=https://...`, a URL the same alert is POSTed to as JSON, for an SMS service. Leave it out for now.
   **Help assistant (optional).** The Help sheet's "Ask" button gives an instant written answer. Without a key it quietly falls back to the best-matching help guide, so you can skip this until you want it. To switch it on: `ANTHROPIC_API_KEY=sk-ant-...` (from console.anthropic.com), and optionally `SUPPORT_ASSIST_MODEL` (default `claude-haiku-5-5`). Deploy `supabase functions deploy support-assist` as well. It is capped at 30 questions per person per day. Rough cost with Haiku: each question sends the help guides plus a short reply, a few cents per hundred questions, so a studio's team would cost cents a month. It never sees client data, only the question, the page name and the studio's booking and cancel settings.
   Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` automatically. No key is ever written into the code.
4. Deploy them all:
   ```
   supabase functions deploy create-checkout
   supabase functions deploy commerce-checkout
   supabase functions deploy billing-portal
   supabase functions deploy refund-payment
   supabase functions deploy invite-user
   supabase functions deploy support-assist
   supabase functions deploy stripe-webhook --no-verify-jwt
   supabase functions deploy send-email --no-verify-jwt
   supabase functions deploy send-reminders --no-verify-jwt
   supabase functions deploy manage-membership --no-verify-jwt
   ```
   - `--no-verify-jwt` is also set in `supabase/config.toml`. Those functions check their own secret (Stripe's signature or the CRON_SECRET) instead of a login.
   - If the CLI complains about Docker, try adding `--use-api` to the end of each line, or install Docker Desktop for Mac.

## 9. Instant emails and scheduled jobs

1. **Database → Extensions**: turn on **pg_cron** and **pg_net**.
2. **Instant emails**: go to **Database → Webhooks → Create a new hook**:
   - Name `send-email`, table `notifications`, events: **Insert**
   - Type: **Supabase Edge Functions**, function `send-email`, method POST
   - HTTP headers: add `x-cron-secret` = your CRON_SECRET
3. **Scheduled jobs**: open `supabase/cron.sql` and replace `YOUR-PROJECT-REF` and `YOUR-CRON-SECRET` (each appears twice). Paste it into the SQL Editor and run it. That sets up:
   - every 15 minutes: clear waitlists once class starts, expire old passes, and queue **class reminders about 2 hours before**
   - every 2 minutes: send any emails still waiting (a safety net for the instant webhook)
   - Sundays: make the next 4 weeks of classes from the timetable
   - just after midnight each night: tell Stripe about membership pauses starting or ending that day
   - weekly: tidy up old emails
4. Check it worked: `select jobname, schedule from cron.job;` should list 5 jobs.

## 9b. Push notifications (optional, can be switched on any time)

The app and the server are ready for web push (a notification on a client's phone or laptop when the studio replies). It stays off until you add a set of keys. Nothing breaks without them: the notification switch in Profile stays hidden and queued pushes just wait (they're tidied up after 30 days).

1. **Make the keys.** In Terminal on your Mac:
   ```
   npx web-push generate-vapid-keys
   ```
   It prints a **Public Key** and a **Private Key**. Keep the private one secret, like a password. Make them once and keep them: if you change them later, everyone has to switch notifications on again.
2. **Give the server the keys** (same place as step 8):
   ```
   supabase secrets set \
     VAPID_PUBLIC_KEY=THE-PUBLIC-KEY \
     VAPID_PRIVATE_KEY=THE-PRIVATE-KEY \
     VAPID_SUBJECT=mailto:admin@snowypilatesclub.com
   ```
   `VAPID_SUBJECT` is a contact address for the push services (a `mailto:` or `https://` link). No redeploy needed for the functions that already exist.
3. **Give the app the public key only.** In Netlify, **Environment variables**, add `VAPID_PUBLIC_KEY` = the same public key (never the private one), then redeploy. The key is baked in at build time, so it has to be there before the build.
4. Check it: open the client app on a phone, **Profile**, switch on **Notifications**, then reply from the studio inbox. On iPhone, the app has to be added to the home screen first (Safari, Share, Add to Home Screen) or the switch stays hidden.

How it's sent: the full encrypted way (the message is encrypted to each device, so the push service can't read it), using the browser's built-in crypto and no extra packages. A device that registered without encryption keys gets a plain "You have a new message" that opens Messages. Devices that have gone (uninstalled, permission removed) are cleaned up automatically. Phone-app notifications (Apple and Google) aren't built yet.

## 10. Point the app at the real backend (Netlify)

The app is a separate Netlify site from the marketing website.

1. In Netlify, go to **Add new site → Import from Git** and choose the app repo.
2. Build command: `npm run build`. Publish directory: `dist`.
3. **Site configuration → Environment variables**: add
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = the **anon / public** key (never the service_role one)
   - `VAPID_PUBLIC_KEY` = the public push key from step 9b (leave it out until you switch push on)
   - `STUDIO_SLUG` = `snowy`. This makes it Snowy's own app: Snowy's name, icon colours and look from the very first second, and no studio picker. (Leave out `PLATFORM_DOMAIN`. That's only for the multi-studio setup in `docs/PLATFORM.md`.)
4. Deploy. With those two set, the app switches from demo to live by itself. You can still see the demo any time by adding `?demo=1` to the address.
5. **Domain management → Add a domain**: `app.snowypilatesclub.com`. Netlify gives you a DNS record to add, and HTTPS is automatic.

## 11. Test everything in Stripe test mode

Use your own email, then a second one (the Gmail `you+test@gmail.com` trick works).

1. Sign up as a client, confirm the email and sign in.
2. Add a profile photo (Profile → tap the circle). It should show up on the roster in the studio app, and as a file under **Storage → avatars**.
3. Sign the waiver and health form.
4. Buy the intro offer with test card **4242 4242 4242 4242** (any future expiry, any CVC). The pass should appear within a few seconds and a receipt email should arrive.
5. Book a class. The confirmation email should include the cancellation policy.
6. Fill a class (set capacity to 1 in the studio app) and join the waitlist with the second account. Cancel the first booking, and the waitlisted person should be booked and emailed.
7. Cancel more than 3 hours out and the credit comes back. Cancel inside 3 hours and the credit is lost.
8. Buy a weekly membership. In Stripe → Subscriptions it should show as weekly.
9. Pause the membership in the app. Stripe should show the subscription as paused from the pause start date.
10. Tap "Register interest" on Strength + Sculpt. It's saved for the studio (in the `class_interest` table for now).
11. Studio app as **Grace P (front desk)**: check someone in on another instructor's class, sell grip socks for cash, and refund an online sale (the refund should appear in Stripe). Reports should show attendance but no revenue or pay.
12. Studio app as an **instructor**: they can only open their own classes' rosters and see no revenue.
13. Cancel a class from the studio app. Everyone's credit comes back and they get an email.
14. Forgot password: request a reset and tap the link. The app asks for a new password.

If something doesn't arrive, look here:
- **Edge Functions → (function) → Logs** in Supabase
- the `stripe_events` table (`error` column) for webhook problems, plus Stripe → Webhooks → your endpoint for failed deliveries (you can resend them from there)
- the `notifications` table (`error` column) for emails that didn't send

## 12. The launch plan

### Week 0: test with staff and 5 to 10 friendly clients

1. Keep Stripe in **test mode**. Get Libby, Julia, both Graces and 5 to 10 regulars to sign up, book, cancel and buy with the test card. Fix anything confusing before real money is involved.
2. Run the "Test everything" list (part 11) once more on a phone.
3. Delete the test clients and passes, or just leave them archived.
4. Flip Stripe to **live mode**:
   1. Create a live webhook endpoint (part 6, step 9).
   2. Update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with the live values (part 8, step 3).
   3. Do one real $30 purchase and refund it.

### Switch day: Momence export, import, and stop selling in Momence (all on the same day)

Pick a quiet day and do these in one sitting, so nobody buys a pass in Momence after the export.

1. **Stop selling in Momence first**: turn off online purchases and memberships sign-ups (or hide the shop). Bookings for already-sold passes can carry on.
2. **Export from Momence**: **customers** (CSV) and **active memberships and class packs** (CSV). Momence's menus move around, so if you can't find them, ask their support for a "customers export" and an "active memberships/packs export".
3. **Import into the new app**:
   1. Open `supabase/import/momence_import.sql`. The top of the file lists the column names it expects.
   2. Run that whole file once in the SQL Editor. It creates two empty "staging" tables.
   3. In Numbers or Excel, rename each CSV's header row to match the expected names, delete any columns you don't need, then export as CSV.
   4. Go to **Table Editor → import_momence_clients → Insert → Import data from CSV**. Do the same for `import_momence_passes`.
   5. Run `momence_import.sql` again. It copies everyone in and prints a summary, including any passes it couldn't match to a client email. Running it again is safe, because nobody gets added twice.
   6. Spot-check 5 to 10 clients in the studio app against Momence (credits left, expiry dates).
   7. When you're happy, delete the staging tables (the last two lines of the file).
4. **What happens to imported people:**
   - Their packs keep their credits and Momence expiry dates.
   - They can't take the intro offer, because they're not new.
   - **Memberships can't bring card details across from Momence.** Imported memberships keep working until their paid-up date. Members need to re-join the same membership in the app before then, and Libby cancels them in Momence at the same time so nobody pays twice.

### Invite everyone: email with a set-password link

1. Send all imported clients an email from Libby (Gmail, Mailchimp, whatever she uses). The button goes to the app's **Join** page, where they choose their password:
   **`https://app.snowypilatesclub.com/#/signup`**
2. Suggested wording:
   > **We've moved to our own app!** Tap below, join with **the same email you used for Momence** and choose a password. Your passes and credits are already waiting for you. Members: please re-join your membership in the app this week. We'll cancel your Momence one so you're never charged twice.
   > **[Set up my account →]**
3. When they confirm their email, their account links itself to their imported profile and history.
   - For a handful of people (or anyone who's stuck), you can also use **Authentication → Users → Add user → Send invitation** with their Momence email. The link opens the app on "Welcome to the new Snowy Pilates app – set a password to see your credits", and once they save a password they're signed in with their passes waiting.
4. Resend's free plan sends about 100 emails a day, and every sign-up sends a confirmation email. Either send the invite in batches of about 40 a day, or upgrade Resend for the launch month (**check current pricing**).

### Point everything at the new app

1. **Website**: change the "Book" and "See the schedule" buttons from Momence to `https://app.snowypilatesclub.com`.
2. **Instagram**: update the link in bio (and any Linktree) to the app.
3. **Front desk QR code**: make a QR code for `https://app.snowypilatesclub.com` (any QR generator, or Canva) and put it on a little sign at the desk: "Book your next class: scan me".

### Run both systems side by side for 2 to 3 weeks

1. Staff check people in and sell in the new studio app. Momence is only for anyone still finishing an old booking.
2. Each day, glance at the studio app's Today screen for anyone with "no waiver". Ask them to sign it in the app before their next class.
3. Chase members who haven't re-joined in the app before their Momence paid-up date.
4. Keep an eye on the `notifications` and `stripe_events` tables for errors (part 11).

### Cancel Momence

When nobody has needed Momence for a week or so, and every member is billing through Stripe, export one last copy of everything from Momence for the records, then cancel the subscription.

## 13. Installing the client app

**Now: install from a link (free, works today).** The client app is a web app that installs like a normal app:
- **iPhone**: open the app link in **Safari**, tap the **Share** button, then **Add to Home Screen**. It gets the Snowy icon and opens full screen.
- **Android**: open the link in **Chrome**, then tap **Install app** (or ⋮ → **Add to Home screen**).
- Put this in the invite email and on the front-desk sign. The app's Profile screen also shows iPhone users how.

**Later: App Store and Google Play.** The app is built so it can be wrapped as a real store app with **Capacitor** without rewriting it. When Libby wants that:
1. **Apple Developer Program**: about **US$99 a year**. Sign up **in Libby's business name** (as an organisation, which needs a free D-U-N-S number for the business).
2. **Google Play Console**: about **US$25 once**, also in Libby's business name.
3. The iPhone version is built with **Xcode** on your Mac (free from the Mac App Store). The Android version is built with Android Studio (free).
4. Classes are real-world services, so Apple lets the app keep using Stripe. There's no App Store cut on passes.
5. Apple reviews every app, and they like store apps to feel native (push notifications help). Allow a week or two for the first approval.

**Check current pricing** for both developer accounts before signing up.

## Linking from the website

The marketing website can send people straight into the right spot in the booking app. These links all open directly. If the person is signed out they're asked to sign in or join first, then carry on to the page they clicked.

| Link | What it does |
|---|---|
| `https://book.snowypilatesclub.com/` | The timetable |
| `https://book.snowypilatesclub.com/#/class/<sessionId>` | Opens that class, ready to book |
| `https://book.snowypilatesclub.com/#/passes` | The passes and memberships page |
| `https://book.snowypilatesclub.com/#/passes?product=<productId>` | Opens that product's checkout |
| `https://book.snowypilatesclub.com/#/passes?intro=1` | Opens the intro offer (new clients only, otherwise it just shows the passes) |
| `https://book.snowypilatesclub.com/#/signup` | The join / create account screen |

Example: `https://book.snowypilatesclub.com/#/passes?product=3f2b1c9e-0000-0000-0000-000000000000`. Product IDs are the `id` column of the `products` table and class IDs the `id` of `class_sessions` in Supabase.

**Website button to link**

| Website button | Link |
|---|---|
| Book a class | `https://book.snowypilatesclub.com/` |
| Join today (on each membership) | `https://book.snowypilatesclub.com/#/passes?product=<that membership's productId>` |
| Buy now (on each pack) | `https://book.snowypilatesclub.com/#/passes?product=<that pack's productId>` |
| Claim your intro offer | `https://book.snowypilatesclub.com/#/passes?intro=1` |

## 14. Backups

- **Supabase Pro (about US$25/month)** includes daily backups kept for 7 days, and the project never gets "paused". Once real money and bookings are flowing, it's worth it. **Check current pricing.**
- **On the free plan** there are no backups you can restore, and a project can be paused after about a week with no activity. A busy studio won't hit that, but the summer break might. To be safe on free:
  - Once a week, export sales and clients as CSVs from **Reports → Export** in the studio app, and save them in a shared Google Drive or iCloud folder.
  - Or take a full database copy from Terminal: `supabase db dump -f snowy-backup-$(date +%F).sql`. Add `--data-only` for just the data.
- Stripe keeps its own full record of every payment, so the money side is never only in this database.

## 15. Monthly costs (check current pricing)

| | Now (Momence) | New setup |
|---|---|---|
| Booking software | ~$300/month | $0 (Supabase free) or ~A$40/month (Supabase Pro, US$25) |
| Emails | included | $0 on Resend's free plan (about 3,000/month, 100/day); Pro is about US$20/month if you outgrow it |
| Hosting | included | $0 (Netlify free) |
| Card fees | Momence's rate | Stripe, about 1.7% + 30c per domestic card payment, no monthly fee |
| App stores (later) | n/a | Apple about US$99/year, Google Play about US$25 once |

For example, about 150 weekly memberships averaging $45 is roughly 600 charges a month. Stripe fees on that come to about 600 × (1.7% × $45 + $0.30) ≈ **$640/month**. Card fees exist on any platform, so compare them with what Momence charges per transaction today, not with zero.

## Quick reference

| Thing | Where |
|---|---|
| Change prices, classes, timetable, staff, policies | Studio app |
| Change the logo, colours, fonts, photos, welcome wording | Studio app → Settings → Branding |
| Adding other studios later | `docs/PLATFORM.md` |
| Who can do what | `RULES.md` → Staff permissions. The database enforces the same rules as the studio app. |
| Profile photos | Supabase → Storage → avatars |
| Who registered interest in a coming-soon class | SQL Editor: `select * from class_interest;` (a studio screen can come later) |
| Payment problems | Stripe dashboard, plus the `stripe_events` table |
| Email problems | Resend → Logs, plus the `notifications` table |
| Server logs | Supabase → Edge Functions → Logs |
| Database tests (for a developer) | `bash supabase/tests/run.sh` (runs on a local Postgres and never touches the real one) |
