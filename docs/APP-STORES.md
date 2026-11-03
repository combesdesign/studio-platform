# Getting the app into the App Store and Google Play

Plain-English, Mac only. One app per studio: Snowy's is "Snowy Pilates Club", with Snowy's icon, colours and name. Everything below uses Snowy as the example. For another studio, swap `snowy` for its slug.

The app is the same booking app clients already use on the web, wrapped with Capacitor. The web app doesn't change.

**Code blockers (what the stores check inside the app)**
- [x] In-app **Delete my account** (Profile, Account). Apple 5.1.1(v) and Google need it. Built 3 Nov 2026, see section 8.
- [x] **Privacy policy and terms pages** inside the app and on the web (`#/privacy`, `#/terms`, no sign-in needed), filled in per studio. See section 8. **The wording is a draft: a lawyer has to read it before you submit.**
- [x] Privacy policy and terms linked from sign-up, the waiver step and Profile.
- [ ] Still yours to do: the on-demand video / Apple IAP decision (section 0), a lawyer's read of the policy, the store accounts, the Team ID / signing fingerprint for the `.well-known` files, and a real-phone test of the Stripe round trip and of deleting an account.

---

## 0. The one decision to make first (Pete)

**Apple's in-app purchase rule.** Apple takes a cut (15 to 30%) of anything sold inside an iPhone app that is a *digital* thing used inside the app. They don't take a cut of real-world services.

| What we sell | What Apple says | What it means |
|---|---|---|
| Classes, class packs, memberships for in-person Pilates, appointments, gift cards for classes | Guideline 3.1.3(e): services used outside the app can use other payment methods | **Fine to use Stripe.** No Apple cut. |
| On-demand video library (watch in the app) | Guideline 3.1.1: digital content used in the app must use Apple In-App Purchase (IAP) | **Probably needs IAP** on iPhone if people can buy or subscribe to it in the app. |
| A membership that bundles in-person classes *and* on-demand video | Grey area. Reviewers can read it either way. | Risky. Safest is to keep the video part separate from the money. |

**Options for on-demand video, pick one before we submit:**
1. **Leave on-demand out of the first store release.** Hide it in the app (it stays on the web). Quickest, lowest risk. *My suggestion for launch.*
2. **Make video free for people who already have a studio membership or pack**, with nothing to buy for it inside the app. Apple is generally fine with this, but the sign-up and payment for the membership has to be for the in-person service.
3. **Add Apple IAP (and Google Play Billing) for video.** Real work: a purchase plugin (RevenueCat is the usual), receipt handling on the server, and prices carry the store cut. Apple's Small Business Program drops the cut to 15% while under US$1M a year.
4. Take the risk and submit with Stripe for video. Not recommended: a rejection costs a week or two each time, and a repeat can put the account at risk.

Android is more relaxed about this for now, but Google has similar rules for digital content, so it's cleaner to treat both the same.

**Second decision: who owns the app.** Apple's guideline 4.2.6 rejects apps made from a "template" or app-generation service unless the **studio itself** submits them. Our platform is exactly that shape. So the safest setup is **each studio publishes under its own developer account** (Libby's business for Snowy), with Pete doing the building as her developer. Don't publish several studios' apps from one account of Pete's.

---

## 1. Accounts

### Apple Developer Program
- About **US$99 a year** (check the current price on developer.apple.com/programs).
- **Company (organisation)**: the app shows the business name as the seller. Needs a **D-U-N-S number** for the business (free from Dun & Bradstreet via Apple's lookup page, developer.apple.com/enroll/duns-lookup). It takes a few days to a couple of weeks. Apple may also phone to confirm the business exists, and the person enrolling must have authority to sign for it. Best for Snowy: the seller name is "Snowy Pilates Club Pty Ltd" (or whatever Libby's entity is), not Libby personally.
- **Sole trader (individual)**: quick (often same day), no D-U-N-S, but the App Store shows the person's **legal name** as the seller. If Libby trades as a sole trader with an ABN, this works, though her personal name appears.
- Enrol on a Mac with the Apple Developer app, or at developer.apple.com. Needs two-factor Apple ID.

### Google Play Console
- **US$25 once** (play.google.com/console).
- Choose **Organisation** (needs a D-U-N-S number too, and Google verifies the business) or **Personal**.
- **Personal accounts created after November 2023** must run a **closed test with at least 12 testers for 14 days in a row** before they can publish to production. Organisation accounts don't. Check Google's current rules when you start, they've changed before.
- Identity verification (ID, phone, sometimes address) can take a few days.

---

## 2. Set up your Mac (once)

1. **Xcode**: Mac App Store, free, about 10 GB. Open it once, accept the licence, let it install extras. Then in Terminal: `xcode-select --install`.
2. **Android Studio**: developer.android.com/studio. Open it once and let it download the SDK. It brings its own Java.
3. **Node 22 or newer** (check with `node -v`). Easiest through Homebrew: `brew install node`.
4. **Add your Apple ID to Xcode**: Xcode, Settings, Accounts, plus.

Capacitor 8 uses Swift Package Manager for iOS, so there's no CocoaPods to install. If you see a `pod` error, it's an older Capacitor and someone should check the version in `package.json`.

---

## 3. Build the projects

In Terminal, in the project folder:

```bash
npm install
npx cap add ios
npx cap add android
npx cap sync
```

That's it for the first time. Behind the scenes:
- `capacitor.config.ts` reads the studio's name, colours and app id (for Snowy: `com.snowypilatesclub.app`). If the app build isn't there yet, it makes it.
- The studio comes from `STUDIO_SLUG` (default `snowy`). Another studio: `STUDIO_SLUG=harbour npx cap add ios`.
- The app id is worked out from the studio's website (snowypilatesclub.com becomes `com.snowypilatesclub.app`). To use another one: `APP_ID=com.something.app npm run build:app -- --studio=snowy`. **Pick it once and keep it.** Changing it later means a new app in the stores.

Day to day, after any code change:

```bash
npm run build:app -- --studio=snowy     # client-only build into dist-app/
npx cap sync                            # copies it into the iOS and Android projects
npx cap open ios                        # opens Xcode
npx cap open android                    # opens Android Studio
```

Live data: set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (and `VAPID_PUBLIC_KEY` for web push) before `build:app`, the same as the web build. Without them you get the demo version. **Never submit a demo build.**

`WEB_URL` (optional) is the studio's web app address, used for the Stripe return trip (section 5). It defaults to the studio's first custom domain, then its website. Snowy: `https://app.snowypilatesclub.com`.

### Icons and splash screens
```bash
npm run icons:app -- --studio=snowy          # makes resources/snowy/ from the studio's mark and colours
npx capacitor-assets generate --assetPath resources/snowy
```
The first command makes a 1024 icon, Android adaptive icon pieces (foreground and background) and light and dark splash images. The second drops every size into the iOS and Android projects. Run it after `cap add`, and again if the artwork changes. Look at `resources/snowy/icon-only.png` first. This is also the 1024 icon you upload to App Store Connect.

---

## 4. Things to set in the native projects (once)

### Android: `android/app/src/main/AndroidManifest.xml`
Inside the main `<activity>`, add the link handlers (section 5), and make sure the app can use the internet and show notifications:
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### iOS: Xcode
1. Open `ios/App/App.xcworkspace` with `npx cap open ios`.
2. Click the **App** target, **Signing & Capabilities**: tick **Automatically manage signing**, choose your **Team**.
3. Press **+ Capability** and add **Push Notifications** and **Associated Domains** (section 5).
4. **Info** tab, **URL Types**: add one with Identifier and URL Schemes both set to the app id (`com.snowypilatesclub.app`).
5. Set **Display Name** (it's the name under the icon) and a **Version** (1.0.0) and **Build** (1).
6. Minimum iOS: leave the Capacitor default.

---

## 5. Stripe and links: how people get back into the app

**Opening links.** Stripe pages and other websites open in the phone's in-app browser (Capacitor Browser), not inside our app. `mailto:` and `tel:` links go to the phone's own apps.

**Coming back after paying.** Stripe needs a web address to return to, and a phone can't return to `capacitor://localhost`. So:

1. The app tells Stripe to return to a tiny page on the studio's web address: `https://app.snowypilatesclub.com/open.html?scheme=com.snowypilatesclub.app&to=/passes?paid=...` (it is deployed with the normal web build).
2. That page opens the app using the **custom URL scheme** `com.snowypilatesclub.app://open?to=...`. (The scheme is the same as the app id.)
3. The app catches it (Capacitor's `appUrlOpen`), closes the in-app browser and goes to the right screen (`#/passes?paid=...`). Hash routes such as `#/class/<id>` and `#/passes` all work this way.

That works with no extra setup beyond the **URL Types** step above (iOS) and the intent filter below (Android). It shows a flash of the "Taking you back" page.

**Smoother: universal links (iOS) and app links (Android).** The phone opens the app straight from the https address, and the page never shows. Needs a file on the studio's web host:

- iOS: add the **Associated Domains** capability with `applinks:app.snowypilatesclub.com`, and host `https://app.snowypilatesclub.com/.well-known/apple-app-site-association` (no file extension, served as JSON) containing your Team ID and app id:
  ```json
  { "applinks": { "details": [ { "appIDs": ["TEAMID.com.snowypilatesclub.app"], "components": [ { "/": "/open.html" } ] } ] } }
  ```
- Android: host `https://app.snowypilatesclub.com/.well-known/assetlinks.json` with the app's signing certificate fingerprint (Play Console, Setup, App signing shows the SHA-256):
  ```json
  [ { "relation": ["delegate_permission/common.handle_all_urls"],
      "target": { "namespace": "android_app", "package_name": "com.snowypilatesclub.app", "sha256_cert_fingerprints": ["AA:BB:..."] } } ]
  ```
  and in the manifest `<activity>`:
  ```xml
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="app.snowypilatesclub.com" android:pathPrefix="/open.html" />
  </intent-filter>
  <intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.snowypilatesclub.app" />
  </intent-filter>
  ```
  (The second one is the custom scheme.) Put the two `.well-known` files in `public/.well-known/` so the web build serves them, then redeploy the web app. Netlify may need `Content-Type: application/json` set for the apple one.

**Server note.** The Stripe functions only accept return addresses on the allowed list (`APP_URLS` in the Supabase function settings). The studio's web address is already on it, so the bridge page is accepted.

---

## 6. Push notifications

The server sends to the phones itself (`supabase/functions/_shared/nativepush.ts`, called from `deliverPush`). **Android goes through Firebase Cloud Messaging (FCM). iPhone goes straight to Apple (APNs)**, so the iPhone app needs no Firebase code. Each part switches on by itself when its settings exist, and does nothing without them. Dead tokens (app deleted, token expired) are removed automatically.

Do the steps below on your Mac in a browser. Replace `snowypilatesclub` with the studio's id where it shows.

### A. Android: Firebase and the service account
1. Go to console.firebase.google.com and sign in with the Google account that will own the project (for Snowy, Libby's).
2. **Add project**, name it "Snowy Pilates Club", you can turn Google Analytics off, **Create project**.
3. On the project home click the **Android** icon. Package name: `com.snowypilatesclub.app` (it must match the app id exactly). Register the app.
4. **Download `google-services.json`** and put it in `android/app/` in the project. Skip the SDK steps Firebase shows, Capacitor handles those. Run `npx cap sync` again.
5. Back in Firebase: the cog next to Project Overview, **Project settings**, **Service accounts** tab, **Generate new private key**, **Generate key**. A `.json` file downloads. Treat it like a password: don't email it, don't put it in the repo.
6. Check the **Firebase Cloud Messaging API (V1)** is enabled: Project settings, **Cloud Messaging** tab. It says Enabled. If not, click the three dots and enable it.
7. Put the whole file's contents into Supabase (section D) as `FCM_SERVICE_ACCOUNT`.

### B. iPhone: the APNs key
1. Go to developer.apple.com/account, **Certificates, Identifiers & Profiles**, **Keys**, the plus button.
2. Name it "Snowy push", tick **Apple Push Notifications service (APNs)**, **Continue**, **Register**.
3. **Download** the `.p8` file. **Apple only lets you download it once**, so keep it somewhere safe (a password manager is good). Write down the **Key ID** shown on the page.
4. Your **Team ID** is on the Membership details page (developer.apple.com/account, Membership). It is 10 characters.
5. Make sure the app's identifier (Identifiers, `com.snowypilatesclub.app`) has **Push Notifications** ticked, and that you added the **Push Notifications** capability in Xcode (section 4).
6. One key works for every app in the same developer account, and for both sandbox and production.

### C. Open the .p8 so you can paste it
On the Mac, in Terminal:
```bash
cat ~/Downloads/AuthKey_ABC123DEFG.p8 | pbcopy
```
That copies the whole key (including the BEGIN and END lines) to the clipboard, ready to paste.

### D. Put the settings into Supabase
In the Supabase dashboard: your project, **Edge Functions**, **Secrets** (or Project settings, Edge Functions, Secrets), **Add new secret** for each:

| Name | Value | For |
|---|---|---|
| `FCM_SERVICE_ACCOUNT` | the whole service-account `.json` file, pasted | Android |
| `APNS_KEY_P8` | the whole `.p8` file, pasted (the clipboard from step C) | iPhone |
| `APNS_KEY_ID` | the 10-character Key ID | iPhone |
| `APNS_TEAM_ID` | your 10-character Team ID | iPhone |
| `APNS_BUNDLE_ID` | `com.snowypilatesclub.app` (the app id) | iPhone, single-studio build |
| `APNS_BUNDLE_IDS` | optional, for the multi-studio platform: `{"snowy":"com.snowypilatesclub.app","harbour":"com.harbour.app"}`. A studio listed here uses its own id, others fall back to `APNS_BUNDLE_ID`. | iPhone |
| `APNS_SANDBOX` | `1` only while testing a build installed straight from Xcode. Leave it out for TestFlight and the App Store. | iPhone |

Or from Terminal if you use the Supabase CLI: `supabase secrets set APNS_KEY_ID=ABC123DEFG APNS_TEAM_ID=TEAM123456 APNS_BUNDLE_ID=com.snowypilatesclub.app` and `supabase secrets set APNS_KEY_P8="$(cat ~/Downloads/AuthKey_ABC123DEFG.p8)" FCM_SERVICE_ACCOUNT="$(cat ~/Downloads/snowy-proj-firebase-adminsdk.json)"`. Secrets apply to the functions straight away, no redeploy.

Web push (the website) still uses `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (GO-LIVE step 9b). All three kinds can be on together.

### E. Test it
1. Install the app on a real phone (push doesn't work in the iOS simulator for APNs tokens, and the Android emulator needs Google Play images). Sign in, open Profile and turn **Notifications** on.
2. Have the studio reply to that client in the inbox. The next scheduled run sends it (within a few minutes).
3. Nothing arrived? In Supabase, table `marketing_messages`, look at the push row: `provider_id` says `push:1` (sent), `skipped-no-keys` (that kind of phone has no settings yet), `expired` (token was dead and got removed), or `error` has the reason (`APNs 403 InvalidProviderToken` means the Key ID / Team ID / .p8 don't match; `APNs 400 DeviceTokenNotForTopic` is treated as dead, so check `APNS_BUNDLE_ID` against the app id and that sandbox matches the build).

### Why APNs directly for iPhone
Capacitor's push plugin gives the app a raw Apple token on iPhone and an FCM token on Android. Sending iPhone through FCM as well would mean adding the Firebase iOS SDK and a second plugin to the app, and re-registering every existing token. Direct APNs needs only the key above and about 50 lines on the server. It assumes the function runtime's `fetch` speaks HTTP/2 (APNs refuses HTTP/1.1). Deno, which Supabase Edge Functions run on, does that automatically. This is untested against Apple here: the tests use a fake fetch.

Apple also wants a good reason to ask for notifications. The app asks gently, after a first booking.

---

## 7. Signing, TestFlight and internal testing

### iPhone: TestFlight
1. In **App Store Connect** (appstoreconnect.apple.com) create the app: My Apps, plus, New App. Platform iOS, name, primary language **English (Australia)**, bundle ID = `com.snowypilatesclub.app`, SKU any text.
2. In Xcode, pick **Any iOS Device (arm64)** at the top, then **Product, Archive**.
3. When the Organizer opens, **Distribute App, App Store Connect, Upload**. Let Xcode manage signing.
4. After a few minutes the build appears in App Store Connect, **TestFlight**. Answer the export compliance question (the app only uses standard HTTPS, so "no" to custom encryption; or add `ITSAppUsesNonExemptEncryption = NO` in Info).
5. Add **Internal Testers** (people on your App Store Connect team, up to 100, no review needed) or **External Testers** (anyone by email or link, needs a quick beta review first).
6. Testers install the **TestFlight** app and tap Install.

### Android: internal testing
1. In Android Studio: **Build, Generate Signed App Bundle / APK, Android App Bundle**. Create a new **keystore** the first time. **Back the keystore and its passwords up somewhere safe (not in the repo).** Losing it makes updating the app very hard. (Or turn on Play App Signing, which Google recommends, and upload with an upload key.)
2. In **Play Console**, Create app: name, English (Australia), App, Free.
3. **Testing, Internal testing, Create new release**, upload the `.aab`, add testers' emails (up to 100), save and roll out. Testers get a link and install from Play.
4. Personal account? Run **Closed testing** with 12 testers for 14 days as well (section 1).

Each new upload needs a higher **version code / build number**. iOS: bump **Build**. Android: `versionCode` in `android/app/build.gradle`.

---

## 8. Privacy, the forms you have to fill in

**Privacy policy (built).** Every studio's app has its own privacy policy and terms, built from a template in `src/shared/legal.ts` and filled in with the studio's name, ABN, contact email and address from Settings. They open in the app (Profile, Account; the sign-up form; the waiver step) and are public web pages that work signed out:

- Privacy policy: `https://<the studio's app address>/#/privacy` (Snowy: `https://app.snowypilatesclub.com/#/privacy`)
- Terms of use: `https://<the studio's app address>/#/terms`

Use the privacy link as the **Privacy Policy URL** in App Store Connect and Play Console, and in the app's store listing. It covers what is collected (health and injury information is named as sensitive information under the Australian Privacy Act), why, who it is shared with (Supabase, Stripe, Resend, Anthropic for the studio Help feature only, Twilio if SMS is on), where it is stored, how long it is kept, access and correction, deleting an account, and complaints to the OAIC.

**The template is a draft.** It says so at the top of the file. A lawyer must read it, and the studio (Libby for Snowy) must check the facts in it are true for them (who they share with, where data is stored, how long they keep records) before you submit. A studio can also paste its own text over either page in Settings, Policies, and that is shown instead.

**Account deletion (built).** Profile, Account, **Delete my account** explains what happens in plain English (the login is removed, personal details, photos and health info are deleted or made anonymous, booking and sales records stay anonymised for tax, active memberships are cancelled in Stripe) and then does it. Studio owners can do the same for a client who asks, from the client's Edit details sheet in the studio app. Behind it is the `delete-account` edge function, which you deploy with the others (`supabase functions deploy delete-account`). Google also wants a **web address where someone can ask for deletion**: use the privacy policy link, whose "Deleting your account" section explains both the in-app button and emailing the studio.

### Apple: App Privacy ("nutrition label") in App Store Connect
Say **yes, we collect data**, and for each, **linked to the user, not used for tracking**:
- **Contact info**: name, email, phone number
- **Health and fitness**: health (the health form)
- **Purchases**: purchase history (passes, memberships)
- **User content**: customer support (messages to the studio)
- **Identifiers**: user ID
- **Usage / diagnostics**: only if we add analytics or crash reporting (we don't today)
Purposes: app functionality. No tracking, so no App Tracking Transparency prompt needed. Payment card details go to Stripe and never touch our servers (still mention Stripe in the policy).

### Google: Data safety
Same list: personal info (name, email, phone), health info, financial info (purchase history; card details handled by Stripe), messages. "Data is encrypted in transit": yes. "You can request data deletion": yes (link the deletion page). Not shared with third parties for advertising. Content rating questionnaire: pick fitness, no violence, no user-generated public content: should come out as everyone.

### Other store forms
- **Age rating**: 4+ on Apple, Everyone on Google.
- **Export compliance**: standard encryption only.
- **Sign in with Apple**: only needed if the app offers other social logins (Google, Facebook). It uses email and password only, so not needed.
- **Support URL**: the studio website or contact page. **Marketing URL**: the website.

---

## 9. Screenshots you need

Simulator screenshots are fine (in Xcode: Product, Destination, pick a device, run, then Cmd+S in the Simulator saves a screenshot). Use the demo build with realistic data. Don't show real clients.

**Apple** (App Store Connect, per language):
- iPhone **6.9-inch** (iPhone 16/17 Pro Max): 1320 x 2868. Required, 3 to 10 shots. Other iPhone sizes are scaled from it.
- **iPad 13-inch** (2064 x 2752) only if the app runs on iPad (it does by default). You can turn iPad off in Xcode (Deployment Info) to skip these.
- Suggested set: timetable, a class sheet, booking confirmed, passes, profile, messages.

**Google Play**:
- **Phone** screenshots: 2 to 8, 9:16 or similar, each side 320 to 3840 px.
- **App icon** 512 x 512 PNG (make from `resources/snowy/icon-only.png`).
- **Feature graphic** 1024 x 500 (a banner at the top of the listing: Snowy logo on the navy or the hero photo).
- 7-inch and 10-inch tablet screenshots are optional but help if you target tablets.

---

## 10. Review tips (so the first go doesn't bounce)

1. **Give the reviewers a login.** Apple and Google can't create an account like a real client. In App Store Connect, App Review Information, add a **demo account** (an email and password for a client with some classes and a pass) and a short note: "Book mat Pilates classes at Snowy Pilates Club, Cooma NSW." Make sure that account works on the live build.
2. **Not just a website in a box** (guideline 4.2). Reviewers reject thin wrappers. Ours has push notifications, an in-app browser for payments, native status bar and back button, and a proper booking flow, so say so in the review notes.
3. **Explain payments** in the review notes: "Payments are for real-world Pilates classes and memberships delivered in person in Cooma, so they use Stripe under guideline 3.1.3(e)." Then the video decision from section 0.
4. **Health information**: say why it's collected (class safety). The privacy policy is already linked in the app (Profile, Account; sign-up; the waiver step); add the link in App Store Connect too.
5. **Account deletion** is in the app (Profile, Account, Delete my account). Say where it is in the review notes, and make sure the demo login you give reviewers is one you can afford to have deleted: they may try it, so keep a spare.
6. **Don't mention other platforms** or "Android" in the iPhone listing, and don't show other brands.
7. **Test on a real phone** through TestFlight first. Check: sign in, book, buy a pass (full Stripe trip and back), cancel, the waiver, notification switch.
8. **First review takes 1 to 3 days on average** for Apple, sometimes a week. Google's first review can take several days for new accounts.
9. If rejected, reply in Resolution Center. Most first rejections are missing demo logins, privacy details or the IAP question.

---

## 11. Draft store listing: Snowy Pilates Club

Friendly Australian English. Edit freely. Character limits are Apple's and Google's.

**App name** (30 max): `Snowy Pilates Club`

**Subtitle** (iOS, 30 max): `Mat Pilates in Cooma`

**Promotional text** (iOS, 170 max, can change any time without a review):
`New term, new classes. Book a spot, check your pass and keep your health info up to date, all in one calm little place.`

**Short description** (Google Play, 80 max): `Book mat Pilates classes at Snowy Pilates Club in Cooma.`

**Description** (iOS 4000 max, Google 4000 max):

> Movement isn't a chore. Snowy Pilates Club is the feel-good mat Pilates studio in the heart of Cooma, and this is your pocket version of it.
>
> Book your spot in seconds, see what's on this week, and get a reminder before class so you can just turn up and feel great.
>
> WHAT YOU CAN DO
> • Browse the timetable and book classes in a couple of taps
> • Join the waitlist when a class is full, and we'll let you know if a spot opens up
> • Buy class packs and memberships, and see exactly how many classes you have left
> • Cancel or change a booking, with the rules explained clearly
> • Keep your health info and waiver up to date, so your instructor knows how to look after you
> • Book for family, and manage your details in one place
> • Message the studio and get class updates
>
> DESIGNED FOR EVERY BODY
> Whether it's your first Pilates class or your hundredth, our classes are friendly, welcoming and built so every body can feel strong from the inside out. Mums and bubs, strength and sculpt, and everything in between.
>
> FIND US
> 57 Vale Street, Cooma NSW 2630
>
> Questions? Say hi at hello@snowypilatesclub.com.

**Keywords** (iOS, 100 max, comma separated, no spaces after commas, don't repeat words from the name):
`pilates,cooma,mat,fitness,classes,booking,studio,wellness,snowy mountains,mums,strength,stretch,yoga,health`

**Category**: Primary **Health & Fitness**. Secondary **Lifestyle** (iOS). Google Play: **Health & Fitness**, tags like Fitness, Pilates.

**Support URL**: `https://snowypilatesclub.com` &nbsp; **Privacy policy URL**: `https://app.snowypilatesclub.com/#/privacy` (built into the app, section 8; get the wording reviewed first) &nbsp; **Terms URL**: `https://app.snowypilatesclub.com/#/terms`

**What's new** (first release): `Welcome to the Snowy Pilates Club app. Book classes, manage your passes and stay in the loop, all in one place.`

**Copyright**: `2026 Snowy Pilates Club`

**Age rating**: 4+ / Everyone. **Price**: Free (purchases are for in-person classes via Stripe, not in-app purchases).

---

## Quick reference

| I want to... | Run |
|---|---|
| Build the app files | `npm run build:app -- --studio=snowy` |
| Copy into the native projects | `npx cap sync` |
| Make icons and splash | `npm run icons:app -- --studio=snowy` then `npx capacitor-assets generate --assetPath resources/snowy` |
| Open Xcode / Android Studio | `npx cap open ios` / `npx cap open android` |
| Another studio | `STUDIO_SLUG=harbour` in front of any `npx cap` command, and `--studio=harbour` on the npm scripts |
