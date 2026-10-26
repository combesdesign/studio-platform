# Agent notes

## engine

**Status:** done. `npx tsc -p tsconfig.core.json`, `npm test` (27 tests) and `node build.mjs` all pass. I also checked it in Chromium: booking in the client tab shows up on the studio tab's roster, and the two apps keep separate sign-ins.

### What's where
- `src/domain/` has pure rules with no storage or DOM, and `now` is always passed in. Import from `src/domain` (index re-exports everything).
  - `rules.ts`: `checkPassForSession` (eligibility), `selectBestPass` / `comparePassPriority`, `activatePass`, `cancellationOutcome`, `canAutoPromote` / `pickWaitlistPromotion`, `isIntroEligible`, `creditLabel`, `remainingCredits`, `weeklyUsed`, `computePassStatus` / `isPassCurrent`, `rosterFlags`, `birthdayInWeek`.
  - `schedule.ts`: `generateSessions` (DST-safe, idempotent). Session ids are deterministic: `se_<templateId>_<yyyymmdd>`.
  - `report.ts`: `buildReport`, `salesCsv`, `clientsCsv`, `allocateSale`.
  - `permissions.ts`: `can(role, action)` plus the `PERMISSIONS` matrix. **UIs can use `can()` to hide buttons.**
  - `time.ts`: `studioDay()`, a cached `studioDate`.
- `src/data/demo/` has `index.ts` (`createDemoStore(opts?)`, which handles auth, permissions, persistence and latency), `engine.ts` (the operations), `seed.ts` and `fixtures.ts` (settings, staff, class types, products, timetable).
  - `createDemoStore({ now?, storage?, latencyMs?, app?, initialState? })`. The zero-arg call works as before.
- State is kept in localStorage under `spc-demo-v1`, plus `spc-demo-v1:rev` for cross-tab sync. If localStorage throws, it falls back to memory.
- Auth is stored under `spc-demo-auth-client` or `spc-demo-auth-studio`, picked by `location.pathname.includes('/studio')`.
- `subscribe()` fires after every mutation, on 'storage' events from other tabs, and after lazy housekeeping.
- Every call has 80–150ms of simulated latency.

### Quick-login personas (any password)
| Who | Email | State |
|---|---|---|
| Chloe Bennett | chloe.bennett@example.com | Brand new. No waiver, no passes, intro eligible. |
| Hannah Mitchell | hannah.mitchell@example.com | 2/week membership, "1 of 2 left this week". |
| Jess Walker | jess.walker@example.com | 4 class pack with 1 left. Her next booking shows `last_credit`. |
| Mia Roberts | mia.roberts@example.com | Intro offer (unlimited). 2 classes done, 1 booked. |
| Libby (owner) | libby@snowypilatesclub.com | |
| Julia (instructor) | julia@snowypilatesclub.com | |
| Grace T (instructor) | grace.t@snowypilatesclub.com | |
| Grace P (instructor) | grace.p@snowypilatesclub.com | Runs Mums + Bubs. |

Other seeded cases worth testing against:
- **Margaret Hollis:** imported, no waiver, booked in by staff, so she shows the `no_waiver` flag on the roster.
- **Isla Grant:** signed up 2 days ago, no passes.
- **Lucy Campbell:** membership paused for the next 2 weeks.
- **Matilda Hughes:** cancelled membership, still usable until `nextBillingAt`.
- **Kate Anderson and Ruby Murphy:** birthdays this week.
- **Full classes:** the next Sat 8am and one 6pm this week are full, each with 3 on the waitlist.
- **Cancelled classes:** next week's Fri 6am is cancelled, and a past Thu 6am class was cancelled 2 weeks ago.
- **Sales history:** 6 weeks of check-ins, no-shows, late cancels and sales, including a refund and a goodwill credit adjustment.

**Signing in:**
- `signIn` on the studio app only accepts staff emails, and on the client app only client emails. Otherwise it throws `NOT_ALLOWED`.
- `demoSignInAs` accepts anyone.

### Things the UI agents must know
- **photoUrl** has no leading slash, e.g. `img/libby.webp`. The client app uses it as is. The studio app must prefix it with `../`, or resolve it against `document.baseURI`'s root.
- **Error codes** (`StoreError.code`):

  | Group | Codes |
  |---|---|
  | Auth | `AUTH_REQUIRED` (not signed in), `NOT_ALLOWED`, `INVALID_LOGIN`, `EMAIL_TAKEN` |
  | Lookups and input | `NOT_FOUND`, `INVALID` (validation; the message is user-friendly) |
  | Booking | `WAIVER_REQUIRED`, `NO_CREDITS` (offer the shop), `ALREADY_BOOKED`, `TOO_LATE` (class started, or ended for staff), `TOO_EARLY` (beyond `bookingWindowDays`, clients only), `NOT_BOOKABLE` (Strength + Sculpt), `CLASS_CANCELLED`, `CLASS_FULL` (only from `moveBooking`; `bookClass` waitlists instead) |
  | Shop | `INTRO_NOT_ELIGIBLE`, `OUT_OF_STOCK` |

- **Who counts as staff:** the signed-in user's kind decides. If a staff member is signed in, `bookClass` and `cancelBooking` act as staff: no waiver check, can add people until the class ends, and the `allowOverCapacity` / `skipCredit` / `waivePenalty` options work. Clients passing those options get `NOT_ALLOWED`.
- **Permissions** (`can()`):
  - Instructors can only roster, check in, book or cancel for classes where `session.instructorId` is them.
  - Instructors can make POS sales (Grace P does front desk) but can't refund.
  - Instructors and front desk get `getReport` with the revenue fields set to 0, and pay (`payCents`) is 0 for anyone below owner/manager. Hide those cards by role.
  - Front desk and instructors also lose access to the `sales_view`, `export_sales`, `settings` and `products` actions, so check `can()` before showing those screens.
  - `listStaff` strips `payPerClassCents` unless the viewer is owner or manager, and strips email and phone for clients and signed-out users.
  - Clients and instructors never see `staffNotes`.
- **Roster order:**
  1. booked and checked in, by name
  2. `no_show`
  3. `late_cancelled`
  4. waitlist by position

  Cancelled and removed bookings are left out.
- **Waitlist positions** are renumbered 1..n on every change, so show `waitlistPosition` as is.
- **`cancelBooking` on a waitlisted booking** behaves like `leaveWaitlist`.
- **`markNoShow`** only works on `booked` bookings and isn't time-gated. The UI should offer "Mark rest as no-show" after class.
- **`checkIn`** also works on `no_show` bookings, to correct a mistake.
- **`getCreditSummary(clientId)`** without a session returns current passes, best first, labelled for this week. Paused passes are labelled "Paused until Mon 3 Nov".
- **`getCreditSummary(clientId, sessionId)`** returns only the passes eligible for that class, best first. This is what the booking sheet should use.
- **`listPasses`** returns current passes (active, paused, or cancelled but not yet ended). `includeInactive` adds the expired, used-up and cancelled ones.

### Assumptions and deviations
- **Cancellation window:** "at least 3h before" is free, so exactly 3h00m counts as in time.
- **Membership weekly count:** booked, checked-in, no-show and late-cancelled bookings all count towards the week.
- **`pausePass`:**
  - Memberships only.
  - At least 7 days inclusive.
  - Can't start in the past.
  - Bookings on that pass inside the pause are cancelled with the credit returned.
- **`cancelMembership`:** cancels bookings at or after `nextBillingAt`. A membership that was never activated ends immediately.
- **`adjustPass`:**
  - `creditsDelta` changes the pack's total `credits`, so the label reads "5 of 5 left".
  - Not allowed on unlimited passes or weekly memberships.
  - Can't go below `creditsUsed`.
  - Each change is logged to `adjustments`.
- **`refundSale`:** `amountCents` defaults to the rest of the total. `cancelPass` cancels the passes that sale created and their future bookings.
- **Demo membership billing:**
  - Done lazily on any call: one `card_online` Sale per week, with the note "Weekly membership direct debit".
  - Skipped while paused. Stops once the membership is cancelled.
  - The purchase itself counts as week 1.
- **Comps:** `method: 'comp'` makes the sale total $0.
- **Fees:** late-cancel and no-show fees are only charged (as a Sale) if the settings are set above $0.
- **Template edits:** `upsertTemplate` and `deleteTemplate` drop that template's future sessions that have no bookings, and they regenerate on the next read. Sessions with bookings keep their old details.
- **Session generation:**
  - Clamped to between the start of the seeded history and today + 180 days.
  - `listSessions` auto-generates for the range it's asked for.
  - `upsertSession` accepts a `SessionWithCounts` and ignores the count fields.
- **Report definitions:**
  - `revenueCents` is gross sales by sale date. `refundsCents` is refunds by refund date. Show net as `revenueCents - refundsCents`.
  - `classesRun` is non-cancelled classes in range that have started.
  - Fill % is (booked + checked in + no-show) / capacity.
  - `attendees` counts checked-in only.
  - `activeMemberships` and `activePacks` are a snapshot as at now. Packs include intro and drop-ins.
- **Notifications:** the demo writes promotion and cancellation messages to `state.outbox` (internal, not exposed) instead of sending email or push.
- **Backend:** the live store can reuse the `src/domain` functions (eligibility, priority, `cancellationOutcome`, `buildReport`, `generateSessions`, `can`) in edge functions.

## client

**Status:** done. `node build.mjs` builds clean. The Playwright run-through against the real demo store passes with **0 console errors**: Chloe (new) → waiver → NO_CREDITS → buy intro → back to class → book → late cancel → join waitlist on a full class → bookings → passes → profile, plus a second pass over Hannah, Jess and Mia, the auth forms and pause/cancel membership. Screenshots are in `screenshots/client/` (and `screenshots/client/more/`).

### Screens (hash routes)
- `/` **Timetable**: logo, credit pill (Unlimited / N credits / Get a pass → shop), a sticky date strip covering `bookingWindowDays` (a dot marks days you're booked), and class cards showing time, instructor photo, duration and spots / Full + join waitlist / Booked / Waitlisted #n / Finished / Cancelled. Coming-soon class types show a "Register interest" card.
- `/class/:id` opens the **class sheet** over the timetable: mats-left visual, booking note, description, instructor bio, a "Booking with" pass picker (from `getCreditSummary(clientId, sessionId)`), and a sticky footer with Book / Join waitlist / Cancel / Leave waitlist plus a policy line ("Free cancellation until 3:00pm Wed 14 Oct", or a late-cancel warning). Late cancels get a confirm screen. On success it offers an .ics add-to-calendar (data: URL, no network).
- `/bookings`: upcoming bookings, waitlists, studio-cancelled notices, past bookings with Attended / No-show / Late cancel / Cancelled, a classes-done count, and the policy accordions.
- `/passes` (`?for=<sessionId>` brings you back to that class after buying, `?paid=` is the Stripe return): pass cards (membership is navy, intro is cream, packs are white with credit dots) showing expiry, 'Starts on first booking' or 'Pause booked'. Memberships can be paused, resumed, have a pause cancelled, or be cancelled. The shop has the intro offer (only when `isIntroEligible`), memberships with weekly and per-class prices and the Recommended badge, class packs, and retail. Checkout: review → `startCheckout` (a URL redirects to it) → demo card sheet (Apple Pay-style button plus 4242 card fields, labelled "Demo – no real payment") → `purchase` → receipt (ABN, "Total includes GST of $X").
- `/profile`: your details (`upsertClient`), health + waiver (re-opens the form), purchases + receipts (`listSales`, hidden if it throws), news opt-in toggle, studio address / email / phone / website, policies, sign out, reset demo, and an iOS "Add to Home Screen" hint (Android uses `beforeinstallprompt`).
- `/waiver?then=<sessionId>` (or `?edit=1`) is a 3-step full-screen flow: about you + emergency contact → health questions (yes/no + details, pregnant/postnatal, injuries) → waiver text + typed signature. With `then`, it retries the booking afterwards, and on NO_CREDITS sends you to `/passes?for=`.
- Signed out: welcome (photo hero), sign in, sign up, forgot password, and "Try the demo as…" for the 4 client personas. Staff accounts get a "use the studio app" screen.
- `public/sw.js`: cache-first for the shell and static assets in `spc-client-<build>` (old caches are purged on activate), network-first for same-origin pages with the cached index as an offline fallback. It skips non-GET, cross-origin (Supabase/Stripe; Google Fonts are the exception and are cache-first) and `/studio/` plus `assets/studio.*`. Registered from main.tsx, not inside Capacitor. Checked: it installs 14 shell files, and the app shell renders offline.

### For the lead / others
- `format.dateTime/dayShort` gives "Wed, 14 Oct" in Chromium's ICU (with a comma), but RULES says "Tue 14 Oct". The client wraps it in `when()` (in `src/client/lib.ts`), which strips the comma. You might want to fix this in `shared/format.ts` for both apps.
- **Register interest** calls the optional `store.registerInterest?.(clientId, classTypeId)` if a store provides it. Otherwise it falls back to a mailto to `settings.email` and remembers the click in localStorage. *Backend:* consider adding it (for example, an `interest` table).
- The demo persona hints on the welcome screen depend on the order of `demoPersonas()` (new, member, pack, intro). If the list isn't exactly 4 clients, it falls back to showing email addresses.
- `upsertClient` is called with the client's own record (minus `staffNotes`). The live store must merge rather than replace, and must ignore client writes to `waiverSignedAt`, `healthForm` and `staffNotes`, the way the demo store does.
- **Live Stripe:** `startCheckout` gets `returnUrl = <app>#/passes?paid=<productId>[&for=<sessionId>]`. The app shows a "payment received" toast, and the pass appears through the webhook and subscribe.
- **Known gaps:**
  - No push notifications yet (waitlist promotion relies on email or the backend).
  - ~~No drag-to-dismiss on sheets~~ Done in the back-navigation pass below.
  - Date inputs use native pickers.
  - .ics download via `<a download>` may need Capacitor's Filesystem/Share plugin once wrapped.


### Brand pass (14 Oct)
Pete asked for the client app to feel like the new website, so it now uses the website's visual language and the shared `Logo`/`Flower`/`FlowerStars`/`Marquee` from `src/shared/brand.tsx`. It builds clean, the full Playwright run passes with **0 console errors** (Chloe: welcome → demo sign-in → class → waiver → NO_CREDITS → intro offer → book → late cancel → waitlist → bookings → passes → profile → cold-open launch; plus Hannah pausing her membership and cancelling the pause), and `npm test` still passes. Website reference screenshots are in `screenshots/client/website/`; the app's screenshots are in `screenshots/client/` (01–40).
- **Launch moment:** opening the app already signed in plays the website's logo reveal (cream + sky on navy, "Feel your best") once per session, then the navy curtain lifts away. Signed-out visitors get the reveal on the welcome hero instead, and it's skipped entirely with prefers-reduced-motion. The loading splash is navy with the flower, so there's no flash between the splash and the hero.
- **Welcome** mirrors the website hero: a full-bleed `wide.webp` with the navy gradient, the animated logo, "Join the newest club to hit *Cooma!*", a white "Join the club →" pill and a glass "Sign in" pill. Under it are the navy marquee, the italic Reena S. pull quote with flower stars, and the demo personas.
- **Timetable:** centred serif head. Strength + Sculpt "coming soon" is now the website's navy class card (photo on top, cream italic, "Register interest →").
- **Class sheet:** class photo on top, the "01" index, an "All levels welcome" tag and a serif title. The instructor shows as the website's team circle (128px photo, mist ring, role in navy, bio).
- **Shop:** a navy marquee, then the intro offer as a full-bleed band like the website ($49 with a superscript $, "Feel stronger, more confident and *enjoy movement*", "Claim your intro offer →", "New clients only."). Below that is "Find what's *best* for you" with a Memberships / Class packs toggle and the website's pricing cards: big serif price, "/week", per-class line, rule, description, "Join today" / "Buy now", and the navy **Recommended** card. Studio extras sit on a mist band.
- **Profile:** a centred hello with a mist-ringed avatar, a "Meet your *instructors*" mist band with team circles, the policies as the website's FAQ cards ("How does the waitlist work? / Waitlists ⊕"), and the website's navy footer (cream logo, italic tagline, address/email/phone/site rows of 48px).
- **Bookings:** the classes-done stat is now a navy block. Policies use the same FAQ cards. Flower marks replace the checkout tick bullets, the empty-state marks and the receipt mark. The segmented control matches the website (mist track, white thumb).
- `public/sw.js` now precaches `square.webp` and the four team photos, so the new images work offline. Checked: the shell renders offline, and the only failed request is Google Fonts.
- **For the engine agent:** the demo product descriptions in `fixtures.ts` are terse ("One class every week. Billed weekly by direct debit."). The website copy reads much better in the new pricing cards. For example, the 2-class membership says "What we recommend for those wanting to be consistent with their pilates practice! Receive 2 class credits each week." It would help to copy the website's descriptions for the memberships, packs and single class (and maybe rename "Single class" to "Single class credit").
- **For the lead:** class photos are picked by class name in `classPhoto()` (`src/client/ui.tsx`): Mums + Bubs is portrait, Strength + Sculpt is square, and everything else is wide. An optional `imageUrl` on `ClassType` would let Libby set them. Also, `index.html` has `theme-color #FAF8F3`. That's fine, but `#5069AC` would match the navy splash/hero status bar if you prefer.

### Back navigation (14 Oct)
Pete's feedback from his phone: "when I clicked on something I wanted to go back and couldn't". Every screen opened on top of the tab bar now has an obvious, always-reachable way back, and the phone/browser back button works like a native app. The lead OK'd changes to the shared `Sheet` (`src/shared/react.tsx`) and its CSS (`theme.css`), so the studio gets the same behaviour.
- **Shared Sheet:** opening a sheet pushes a history entry (same URL, a marker in `history.state`, so `useRoute`/hashchange never sees it). Back button / Android gesture closes the sheet and leaves you on the same screen. ✕, scrim and Esc pop that entry only if it's still on top. Entries left behind when one sheet swaps for another are skipped over automatically. `useBackHandler(active, onBack)` does the same for steps inside a sheet or page, and `leaveSheets(then)` closes the sheets (popping their entries) before a route change, so nothing stacks up. Esc only closes the top sheet, and nested sheets keep the body scroll lock.
- **Swipe down to close** on touch: drag the grip or the pinned header, or drag the content when it's scrolled to the top. Release past 100px or with a quick flick to close, otherwise it snaps back. Inner scrolling isn't hijacked. Off on the desktop modal layout.
- **Pinned headers:** the sheet frame no longer scrolls; `.sheet-scroll` does, and `SheetHead` (`.sheet-head`) is sticky, so back / ✕ stays visible however far you scroll (class detail, checkout, receipts, policies). It gets a hairline once content scrolls under it. Drill-downs use a back pill named after the previous screen: class detail "‹ Timetable" / "‹ Bookings" (the small time + class name fades in when scrolled), Profile › "‹ Profile" for Your details and Purchases, a receipt "‹ Purchases" (+ ✕). Steps inside sheets have a back pill and a back-button entry: out-of-credits and cancel → "‹ Mat Essentials", checkout pay → "‹ <product>", receipt → list. Modal sheets (pause, cancel membership, checkout review, register interest, success screens) keep a pinned ✕.
- **Flows:** the waiver's top bar shows "‹ Mat Essentials" / "‹ Profile" on step 1, then "‹ About you" and "‹ Your health". It goes back one step at a time (button or phone back), then out. Out of a class booking reopens that class sheet. Sign in / sign up show "‹ Welcome", forgot password shows "‹ Sign in". All of them pop history when they know where they came from (`goFlow` / `backOut` in `lib.ts`), and fall back to a replace after a reload.
- **Shop for a class:** the class sheet's "See passes" / "Shop" closes the sheet first, and the passes screen shows "‹ Mat Essentials" at the top. That and the receipt's "Back to Mat Essentials" pop back to the timetable with the class open (`reopenClass` / `takePendingClass`), so it doesn't pile up history. `#/class/:id` deep links (and the post-waiver fallback) become the timetable with that class open, so ✕ lands on the timetable and back closes the sheet.
- **Style:** one `.back-pill` (theme.css) in both apps: white pill, navy chevron, 44px tall, previous screen's name in Questrial. Top bars respect `env(safe-area-inset-top)`.
- **Checked:** Playwright at 390×844 (and the class sheet at 1024) with 0 console errors. Every sheet scrolled to the bottom keeps its back/close on screen and clickable; `page.goBack()` closes the open sheet and stays on the same route; the waiver steps; Chloe's NO_CREDITS → shop → buy → back to class → book (both via the waiver and directly); profile → health + waiver → sign → back. Screenshots `screenshots/back-nav/c01–c25`. Script (outside the repo): `/tmp/back-nav-e2e/run.mjs` (serve dist on 4195 first; args `client,studio390,studio1024`).


### Password links (15 Oct)
Launch blocker closed: reset and invite links now open an on-brand **Choose a new password** screen instead of the live store's `window.prompt`.
- `#/new-password` uses the sign-in screens' `AuthFrame` (back pill + centred logo). It has a password field with a show/hide eye (which reveals both fields), a confirm field, an "At least 8 characters" hint that ticks over, and friendly errors ("That's only 5 characters…", "Type your new password once more…", "Those two don't quite match…"). The field is marked `aria-invalid` and the error clears as you type.
- `lib.ts` registers `store.onPasswordRecovery?.()` at startup, before React renders, and queues a link that arrives early. `usePasswordLinkRoute` in `main.tsx` opens the screen: it's pushed from the demo button (so back returns there) and replaced on a real link. Leaving the route ends it, so forward doesn't reopen it, and a reload restores it via sessionStorage. While supabase-js signs a `#access_token…&type=…` link in, the app shows the navy splash rather than the welcome. An expired or used link (`#error…otp_expired`) goes to Forgot password, which explains.
- **Invite vs recovery:** the live store tells them apart (it reads `type=invite|recovery` from the link) and passes the kind to the handler. Invites (imported clients) get "Welcome to the new Snowy Pilates *app*" / "Set a password to see your credits." and "Save password and see my credits".
- After saving: a toast ("All set – your new password is saved" / "You're in! Your password is saved") and the timetable, signed in. If the store isn't signed in afterwards, you get "Sign in with your new password" and the sign-in screen.
- **Demo:** Forgot password → "Check your inbox" now has a cream **Demo: open the reset link** box. Back from the new-password screen ("‹ Inbox") returns to it. The welcome screen's demo box has "Moving over from Momence? … open Margaret's invite link".
- Also fixed: live sign-up's `CONFIRM_EMAIL` ("Almost there! We've emailed…") showed as a red error. It's now a "Check your inbox" screen. Profile › Your details shows "Saved. Check your inbox to confirm your new email" if the store flags `pendingEmail`. Email editing stays disabled ("flick the studio a message").
- Checked: Playwright at 390×844 with 0 console errors and no dialogs. Screenshots `screenshots/password/c01–c11`. Script (outside the repo): `/tmp/claude-0/-home-claude-snowy-pilates-club/8b587a1f-22e3-5c98-b901-972725dc5d69/scratchpad/pw-e2e.mjs` (serve dist on 4196).

## studio

**Status:** done. `node build.mjs` is clean, and `tsc -p tsconfig.core.json` plus `npm test` (27) still pass. The Playwright run-through passes with **0 console errors and 0 layout problems** at 1024×768, 768×1024 and 390×844, plus the permission passes. The script lives outside the repo at `/tmp/studio-e2e/run.mjs` (with `fonts.mjs`, which serves local Instrument Serif and a Questrial stand-in so screenshots aren't in fallback fonts; test-only). Serve dist on 4194 first. It pins the clock to 4:00pm Wed 14 Oct 2026 (Sydney) so the run is repeatable, and it checks every screen for horizontal overflow, clipped text and text under 12px. Screenshots are in `screenshots/studio/`: `NN-name-<width>.png` for each size, plus `50–55` for Grace T (instructor), `56–62` for Grace P (front desk who teaches) and `63` for reduced motion, at all three sizes. `src/studio/e2e.mjs` has been removed.

### Screens (hash routes under `/studio/`)
- **Sign in** shows a staff form plus the demo quick sign-in. Client accounts are bounced.
- **Today** (`#/`): greeting, stats, the "Up next / On now" card, today's classes and "Heads up" (no waiver, birthdays, passes expiring this week). Instructors only see their own classes.
- **Roster** (`#/class/:id`):
  - Big tap-to-check-in buttons with an Undo snackbar, and flag chips (injury opens the notes, no waiver opens record waiver).
  - The waitlist, and a "Not coming" list.
  - Add client: use their credit (with a pass picker), sell a pass and book, or comp. You can squeeze someone in over capacity; otherwise a full class waitlists them.
  - Walk-in: new client, sale and booking in one step.
  - Per-booking sheet: check in, no-show, cancel (with late or waive), move, book in from the waitlist, record waiver.
  - Class menu: edit class (cover instructor, time, capacity, note), "Mark rest as no-show" and cancel class.
- **Schedule** (`#/schedule[/:monday]`): week grid with add class, plus the recurring **Timetable** (`#/schedule/timetable`) to add, edit, pause or remove weekly slots.
- **Clients** (`#/clients`) has search and filters (new / no waiver / injuries). The **profile** (`#/clients/:id`) has:
  - stats and passes: adjust, pause / resume / cancel pause, cancel membership. Past packs can be adjusted (topped up or extended) too.
  - bookings, and purchases with partial or full refunds
  - details, health and waiver, and staff notes
- **POS** (`#/pos[/:clientId]`): product tiles, a cart with retail quantities, $ or % discount, card reader / cash / comp, then a receipt with the ABN and "Total includes GST of $X" (prints).
- **Reports** (`#/reports`): this week / last week / this month / last month / custom ranges, KPIs, revenue by product and method, attendance by class, busiest times, an instructor table with pay, and Sales and Clients CSV exports.
- **Settings** (`#/settings/:tab`): studio (ABN and GST are owner only), policies, class types, products, staff, and demo reset.

### Flows verified (each at all three sizes)
- Sign in as Libby, then: check in two and undo one; add a client with credit (Jess shows `last_credit`); add a comp (Chloe shows no waiver and first class); squeeze into the full class (15/14); a normal add goes to the waitlist.
- Walk-in (cash drop-in plus waiver).
- Late cancel without waiving (credit used, listed under Not coming), then with waive (credit returned).
- Move a booking. Edit a class to set a cover instructor. Cancel a class with a reason.
- Add a one-off class and a weekly template (it generates sessions).
- Search clients, record a waiver, pause a membership, top up a used-up pack (+1 credit), refund a sale.
- POS: 4-pack plus 2 grip socks, cash, $140 total, receipt showing GST $12.73. Then a new sale.
- Every report preset, and both CSV downloads.
- Settings: save and revert the policies, edit a class type, change a product price, add staff.
- Jump the clock to 7:10pm, then "Mark rest as no-show" on the 6pm class.
- Demo reset.
- **Grace T (instructor):** Today and the schedule start on her own classes; no Settings, Walk-in, New client or edit/cancel class; no revenue, pay or sales CSV; no staff notes, refunds or pass adjustments. Other classes are locked on the schedule, and `#/class/<someone else's>` shows "Not your class". She can check in on her own class.
- **Grace P (front desk who teaches Mums + Bubs):** sees every class and roster, checks in and undoes on someone else's class, Walk-in and New client, POS sale with receipt, staff notes and purchases; reports are attendance only plus Clients CSV; Settings blocked. Her sidebar says "Front desk + instructor", the greeting says "You're teaching Mums + Bubs at 10:30am", and "My classes" on Today and the schedule shows just her class.

### Fixes made in this pass
- **Permissions:** the studio's own role matrix disagreed with the engine. `roleCan` now maps UI permissions onto `can()` from `src/domain`.
  - Front desk and instructors now get attendance-only Reports. Revenue KPIs and charts, pay and the Sales CSV are hidden; front desk keeps the Clients CSV.
  - Settings tabs are gated by `products` and `staff`.
  - Roles without `clients_edit` (instructors) no longer see New client, Walk-in or Edit details. Before, those actions only failed with NOT_ALLOWED after you tried them.
  - Purchases are shown by `sales_view`, and Refund by `pos_refund`.
- **Move booking:**
  - The picker allowed full classes and classes the client was already in, which failed with CLASS_FULL or ALREADY_BOOKED. Those are now greyed out ("Full" / "Already booked" / "On waitlist").
  - Move is only offered for `booked` entries, because the engine refuses checked-in ones.
  - "Book into class" from a profile also marks classes they're already in.
- **Profile passes:**
  - Cancelled memberships that are still usable until `nextBillingAt` showed under "past passes". They now show as current with "Cancelled · ends …".
  - Status is computed with `computePassStatus`.
  - A future pause shows "Pause from …" with a "Cancel pause" button.
  - Adjust is hidden for weekly memberships (the engine refuses it) and offered on used-up or expired packs.
  - Refund stays available after a partial refund.
- **Visual:**
  - POS client email no longer runs into "Change".
  - Toasts no longer hide behind the settings save bar, and the save bar fits on phones.
  - Toasts are no longer squeezed into a narrow three-line pill on phones.
  - The POS "Checkout" bar hides once the cart is on screen.
  - The profile name no longer wraps onto two lines at iPad width.
  - Today's classes now sit above "Heads up" in the single-column layout.
  - Staff card emails no longer overflow.
  - Report bar labels have room for their notes.
  - Schedule cells drop instructor avatars at ≤1100px so names aren't clipped.
  - The move picker no longer wraps class names on phones.
  - Text under 12px was bumped up (brand tag, rail and tab-bar labels, tile badge, pass kind).
  - Long staff names wrap in the sidebar.
  - Autofocus is skipped on phones, so the keyboard doesn't scroll the sheet title away.

### Brand pass (14 Oct, evening)
Made the studio feel like the back of house of snowypilatesclub.com, using the lead's `Logo`, `Flower`, `FlowerStars`, `Marquee` and `BRAND_PHRASES`. Compared side by side with website screenshots at 1440, 1024 and 390.
- **Sign in:** the website hero. Studio photo with the navy gradient, the animated logo reveal in cream + sky, a serif line with a cream italic word, and the navy marquee with flower separators. Personas are pill rows with ringed photos.
- **Chrome:** the sidebar and phone tab bar are navy (like the site's navy bands and footer), with the inline logo in cream + sky and an italic cream "Studio". The active item is a white pill with a small flower. Buttons hover to ink like the site, with white and glass variants on navy.
- **Today:** a navy hero over the wide photo: "Good afternoon, *Libby*" (cream italic), the day's summary and a gently rotating `BRAND_PHRASES` line in italic serif. Stats use serif numerals, colour-blocked white / white / mist / cream. "Up next" is a mist block, like the site's middle class card. The live "On now" dot is a slowly turning flower, and empty states and "Heads up" use the flower.
- **Staff photos** are circles with a mist ring everywhere (sidebar, rosters, schedule, reports, staff cards), like the team section. Staff cards read like the site: serif name, "Owner + instructor", what they teach.
- **Reports:** the KPI hero is navy and attendance is mist. The charts follow the site's classes trio: white, mist, and navy with cream bars.
- **Settings › Products & pricing** mirrors "Find what's best for you": membership cards with big serif prices, "$20.00 per class", the navy **Recommended** card, the intro offer as the navy "$49" block with photo, packs in three columns, and retail rows. Settings tabs (and every segmented control) use the site's mist pill toggle.
- **Small touches:** eyebrows start with a flower, flower separators in meta lines, the schedule legend is flowers in each class colour, the loader is three bouncing flowers, the receipt uses the inline logo with flower stars, and the highlighted POS tile is the navy pick.
- **Kept out of the way:** the roster rows, check-in circles, flags and sheets are unchanged in size and position, and the motion lives only on sign-in and in the Today hero. With `prefers-reduced-motion`, the logo, marquee and loader stand still and the phrase doesn't rotate (checked in the run).

**Front desk who also teaches.** "Teaching" now comes from the timetable (`instructorId`), never from the role:
- `useStudio()` has `templates`, `teaches(staffId)` and `usualInstructor(classTypeId)`. `roleLabel()` gives "Front desk + instructor" or "Owner + instructor".
- Today: anyone who can see every roster and teaches today gets an **All classes / My classes (n)** toggle, and the greeting names their class. Instructors still see only their own.
- The schedule's **All / My classes** toggle shows for anyone who teaches (instructors start on My classes). Their own cells are tinted mist.
- New-class and new-timetable sheets default the instructor to whoever usually teaches that class type (so Mums + Bubs picks Grace P), not the first staff member with role `instructor`.
- Also fixed: `.btn.block` lost its icon gap (the `.block` utility overrode `display`).

### Known gaps
- **Moving into a full class isn't possible.** You have to squeeze them in from that class's roster, or remove them and add them there.
- Card-reader payments are recorded manually; there's no Stripe Terminal yet. Refunds are only recorded, not sent to Stripe, until live.
- **The Today "passes expiring" panel** calls `listPasses` once per client. That's fine for ~50 clients. The live store may want a dedicated query.
- **Toasts persist across sign-out** for their 2.8s, which is cosmetic. The ToastProvider sits above the auth switch.
- **Full-page screenshots** show the sticky sidebar or tab bar part-way down the page. That's an artefact of the screenshot, not the app.

### Back navigation (14 Oct)
Same work as the client app (see "Back navigation" under client): the shared `Sheet` gives every studio sheet a back-button entry, a pinned header and swipe-down on phones.
- **Page back links** use the shared `.back-pill` (44px) via `BackLink` / `PageHead back`. `ui.tsx` keeps a trail of visited routes (keyed by a per-entry stamp in `history.state`, so revisiting the same class doesn't confuse it). A back link pops history when it leads to where you came from, and its label comes from there: roster → "‹ Today", "‹ Schedule", "‹ Timetable" or the client's first name (falls back to the class date after a reload); client profile → "‹ Roster", "‹ Today" or "‹ Clients"; POS for a client → "‹ Hannah" (also on its receipt); recurring timetable → "‹ Schedule". Checked at 390 that they're visible above the bottom bar.
- **Sheets:** `SheetHead` (`.sh-head`) is sticky with an optional back pill. Multi-step sheets get "‹ step" plus a back-button entry: Add to class (options → "‹ Find a client"), Book into class (options → "‹ Pick a class"), the booking sheet's cancel / move / book-in views ("‹ Hannah"), Edit class and Cancel class opened from Class actions ("‹ Class actions"), and POS New client opened from Choose a client ("‹ Choose a client"). The More sheet now has a title and ✕.
- **Links out of sheets** (View profile, More › Reports/Settings, sign out, new client created, demo reset) use `goFromSheet` / `leaveSheets`, so the sheet's history entry is popped before the route changes and back from the next page lands cleanly.
- **History tidy-ups:** settings tabs and schedule week arrows now replace instead of push (`replaceRoute`), so back leaves the page instead of stepping through tabs or weeks. `#/clients?new=1` drops `?new=1` from the URL before the sheet opens, so back closes the sheet and doesn't reopen it. (Settings tabs are the page's own tab control, so they don't get a back link.)
- **Checked:** Playwright at 390×844 and 1024×768, 0 console errors: roster ← Today / Schedule, roster → View profile → "‹ Roster" (and browser back) returns to the roster with no sheet, client → Sell → "‹ Hannah", timetable ← Schedule, every sheet above scrolled to the bottom with back/close still visible, `page.goBack()` closing sheets in place, More › Reports → back to Today. Screenshots `screenshots/back-nav/s01–s20`.
- Removed the "Change" button from Book into class (it went back to the class list, next to the client's name); the header's "‹ Pick a class" does that now.


### Password links (15 Oct)
- `src/studio/password.tsx`: the same Choose a new password screen in the sign-in layout (the photo half is now `SignInArt`, shared with sign in). It has a "‹ Sign in" / "‹ Today" back pill, eyebrow "Password reset" / "Staff invite", and "Choose a new *password*" / "Welcome to the *team*". Password + show/hide, confirm, the 8+ hint and the same friendly errors. On phones the art shrinks to a short logo band so the form is on screen.
- It registers `store.onPasswordRecovery?.()` at startup. After saving: a toast and Today, signed in. An expired link shows its message in the sign-in error box.
- **Demo:** after "Forgot password?" the sign-in shows a **Demo: open the reset link** box (the email and that state survive going back). Under the personas there's "New to the team? Open a staff invite link".
- Checked: Playwright at 390×844 and 1024×768 with 0 console errors. Screenshots `screenshots/password/s01–s07-<width>`.

## backend

**Status:** done, as far as it can be checked without real Supabase, Stripe and Deno. `npx tsc -p tsconfig.core.json` passes, `npm test` is 27/27, and `node build.mjs` builds both the demo and a live-env build (with the supabase-js stub). `bash supabase/tests/run.sh` is all green:

```
77 20_rls · 51 30_booking · 52 40_waitlist_cancel · 78 50_session_money · 58 60_profiles_roles
4 concurrency (10 clients race for 3 spots) · 11 import template
33 live store (src/data/supabase) against this database
17 edge functions (run under Node: Deno shim, Stripe + Resend stubbed, this database)
  live store: all checks passed
  edge functions: all checks passed
ALL DATABASE TESTS PASSED          (381 checks)
```
`ONLY_LIVE=1 bash supabase/tests/run.sh` runs just the live-store and edge-function checks, which is quicker.

### What's where
- `supabase/migrations/0001–0006`, `seed.sql`, `cron.sql`, `import/momence_import.sql`, `functions/*`, `docs/GO-LIVE.md` (rewritten for Pete).
- **0006_profiles_permissions.sql** (new):
  - `clients.photo_url` (data: URLs refused by a CHECK) and the Storage bucket `avatars`. It's public read; a client may write only `<their client id>/…`, staff may write anything.
  - `guard_client` rewritten.
  - Permissions aligned with `can()`.
  - `report()` rewritten.
  - `register_interest` / `list_class_interest` RPCs (on the existing `class_interest` table).
  - `ensure_sessions` / `refresh_template_sessions` / `delete_template`.
  - Stripe-aware `cancel_membership`.
  - Reminders skip people who booked inside the 2 hours.
  - Online retail decrements stock.
  - Login-email changes sync to `clients` / `staff`.
  - `whoami` ignores archived clients.
  - Grace P is set to front desk.
- **Tests:**
  - `tests/60_profiles_roles.sql` (new).
  - `tests/live_store.test.mjs`: a static audit of every `.rpc()` name and argument, `.from()` table and column, bucket and edge-function body field against `pg_proc` / `information_schema`. It also checks mapper coverage of every field in `types.ts`, then runs ~20 behaviour checks of the real store against the database as each role.
  - `tests/fake-supabase.mjs`: a supabase-js stand-in that turns calls into SQL as the signed-in user, with RLS, like PostgREST.
  - `tests/functions.test.mjs`: runs the Deno functions under Node.
  - Mutation-checked: renaming an RPC arg, a selected column or the photo mapping, or reverting the listSessions fix, each makes the run fail.

### Bugs found and fixed
- **Clients couldn't sign their own waiver on live.** `guard_client` was SECURITY DEFINER and checked the role GUC, which stays `authenticated` inside `submit_waiver`, so it silently undid `waiver_signed_at`. Every client would have been stuck on WAIVER_REQUIRED. I reproduced this on the pre-0006 schema. `guard_client` now runs as the caller and trusts our own definer functions.
- **Live store:**
  - `listSessions` dropped cancelled classes by default. The contract says they're included unless `includeCancelled: false`.
  - `Client.photoUrl` wasn't mapped.
  - `upsertClient` replaced instead of merging: absent fields were nulled. It also sent staff-only fields for staff only, decided staff notes by `role !== 'instructor'`, and had no EMAIL_TAKEN check.
  - `upsertStaff` silently ignored pay changes by managers. It now refuses them with NOT_ALLOWED, like the demo.
  - No app separation on sign-in. Each app now uses its own `storageKey`, and staff on the client app or clients on the studio app get NOT_ALLOWED.
  - Unique-email errors are mapped to EMAIL_TAKEN.
  - Missing `can()` checks: `listClients`, `listSales` (sales_view), `exportSalesCsv` (export_sales), `exportClientsCsv` (export_clients), `refundSale`, and the schedule, product and settings writes.
  - Template edits and deletes left stale future classes. They now go through RPCs that remake unbooked future classes, the same as the demo.
  - Classes were only generated by the weekly cron. `listSessions` now calls `ensure_sessions` for the range being viewed (today to +180 days).
- **Permission drift vs `can()`:**
  - Managers can now read pay rates (`reports_pay`), and `report()` shows them pay.
  - Front desk can edit class types (`schedule`).
  - All staff can read passes (`clients_view`); instructors' client profiles use them.
  - Only the owner can change GST registration, as well as the ABN (`settings_financial`).
  - `manage-membership` now checks pass ownership or `passes_manage` itself, instead of "can see the pass".
  - Front desk (Grace P) is tested role by role in 60.
- **report()** now matches `buildReport`:
  - revenue by kind is allocated in proportion to the items, so discounts are spread and the kinds add up to revenue
  - instructor and class-type rows are sorted by classes desc
  - active memberships and packs are counted by `computePassStatus` (paused and used-up are excluded)
  - instructor pay goes by `instructor_id` whatever the role, so Grace P's Mums + Bubs is paid
- **Edge functions:**
  - Checkout no longer sets `receipt_email`, which would have sent two receipts.
  - The reminder email now includes the cancellation policy.
  - The pause sync cron moved to 14:05 UTC (just after midnight in Sydney), so a pause reaches Stripe before that day's charge.
  - Reviewed and tested, no change needed: Stripe form encoding, signature verification (including tolerance and multiple v1s), webhook idempotency (`stripe_events` plus a sales unique per checkout), the weekly subscription (`recurring[interval]=week`), `pause_collection` void/resume, refunds with an idempotency key and Stripe's absolute total, the billing portal, and all secrets read from env.

### Can't be verified here
- Real Deno/Supabase Edge Runtime, real PostgREST/Auth/Realtime/Storage HTTP, real Stripe and Resend. The fakes follow their documented behaviour, but they're fakes. In particular:
  - PostgREST's embedded-select syntax (`pass_adjustments(*)`, `sale_items(*)`)
  - Storage policies on Supabase's own `storage.objects`; the shim has the same shape and `storage.foldername()`
  - supabase-js parsing `#access_token…` while the app uses hash routing
  - Stripe event payloads on whatever API version the account defaults to (we re-fetch invoices and subscriptions with the pinned `2024-06-20`)
- GO-LIVE part 11 is the real end-to-end check. Do it in Stripe test mode first.

### Risks / decisions for the lead
- ~~No "set a new password" screen~~ Done 15 Oct: both apps have one (see "Password links" below).
- ~~A client changing their email throws `CONFIRM_EMAIL`~~ Done 15 Oct: it resolves with `pendingEmail`.
- **Stripe memberships bill from the day of purchase,** not from first booking as RULES says for the demo. A cancelled Stripe membership runs to the paid-up date even if it was never used. This is documented in GO-LIVE.
- **Resend's free plan is about 100 emails a day.** Launch week will exceed that, so GO-LIVE suggests batching invites or upgrading for a month.
- `ensure_sessions` lets any signed-in user add classes from the timetable for dates they look at. It's idempotent and only ever inserts template classes, but it is a write on read.
- **Optional extras on the live store** (not in DataStore): `billingPortal(returnUrl)`, `listClassInterest(classTypeId?)` (the demo has it too), `setNewPassword`, `onPasswordRecovery`. **Studio:** a "Registered interest" list could use `listClassInterest`. **Client:** a "Manage card" button could use `billingPortal`.
- **Lead-sanctioned edits outside my folders:**
  - added optional `registerInterest?(clientId, classTypeId)` to `DataStore` (`src/shared/store.ts`)
  - added `registerInterest` + `listClassInterest` and an optional `interest` array to `DemoState` in the demo store
  - checked: the client app's "Register interest" now records in demo state, with 0 console errors apart from blocked Google Fonts


### Password links + email change (15 Oct)
- **No more prompt once the app has a screen.** `onPasswordRecovery(handler)` hands the link to the app. A link that arrives before the handler registers is held and handed over when it does. The `window.prompt` fallback only runs if no handler is registered within `PASSWORD_HANDLER_GRACE_MS` (1.5s). Both apps register at startup, so it never runs in them.
- **Invite vs recovery:** the constructor reads `type=invite|recovery` from the address before supabase-js clears it (`passwordLinkKind()`). The handler gets `'invite'` or `'recovery'` (an optional argument; `store.ts` declares `() => void`). It fires once per link, because supabase-js re-fires SIGNED_IN when the tab regains focus.
- `setNewPassword`: under 8 characters → `INVALID`. Same password, weak password and no session/expired get friendly messages; no session → `LINK_EXPIRED`.
- **upsertClient email change no longer throws `CONFIRM_EMAIL`.** It saves, starts Supabase's confirm-new-email flow, and resolves with the client plus `pendingEmail` (`ClientSaveResult`). An email already in use → `EMAIL_TAKEN`.
- **Demo store** (`src/data/demo`): `onPasswordRecovery`, `setNewPassword` (8+ characters, then signs in whoever's link was opened, like a live link) and the demo-only `demoOpenPasswordLink(kind, email?)`. An invite with no email picks the imported Momence client (Margaret) or the newest staff member. Test: `tests/password-link.test.ts`.
- `tests/live_store.test.mjs` adds 4 checks: recovery → handler and no prompt, once only; invite kind plus an early link handed over; the prompt fallback with no handler; and `setNewPassword` rules. The email-change check now expects `pendingEmail`. `fake-supabase.mjs` records `updateUser` calls, refuses them with no session, and has a `__fireAuth(event)` test hook.
- GO-LIVE mentions "Send invitation" as an option for staff and stuck imported clients. The bulk import email still goes to `#/signup`.
- **For the lead:** consider widening `store.ts` to `onPasswordRecovery?(handler: (kind?: 'invite' | 'recovery') => void)` and adding an optional `pendingEmail?` to upsertClient's result, so the extras are in the contract. `demoOpenPasswordLink` is demo-only (the apps call it through a cast).

## lead
- Paused 14 Oct ~4:20pm for the usage limit, which resets at 8:40pm. The engine is done. Client, studio and backend were cut off part-way.
- Agent ids that can be continued: client app = aaf3687f799f69c26, backend = ab7b1b3a902feb432. The resume reminder has these two swapped, so go by this note. Studio has no id and needs a fresh agent to finish it from the code in src/studio.

## lead (15 Oct)
- **Client profile photos:** the client app's Profile → tap the avatar → pick a photo. It's centre-cropped to a 320px JPEG (`src/shared/photo.ts`) and saved as `Client.photoUrl`. The studio shows it on rosters, the client list and profile, POS, booking sheets and Today.
  - **Live backend TODO:** upload to a Supabase Storage `avatars` bucket (owner-only write, staff read) and store the public URL. Don't keep data URLs in Postgres.

## platform
Phase A (A1–A6) is in, plus the feature-module convention for the four feature agents. Snowy looks exactly as before: before/after Playwright screenshots (390 and 1024, every client and studio screen) are pixel-identical, except the new **Settings → Branding** tab and, on the multi-studio build only, a "Switch studio" row on the client Profile.

- **Data model.** `Studio` + `StudioBranding` in `src/shared/types.ts`. `store` (from `src/data`) is bound to one studio (`bindStudio`), `platform` is the `PlatformStore` (directory, cross-studio sign-in, memberships, admin). `DataStore` gained `studioId`, `features`, `getStudio`, `updateStudio`, `uploadBrandingImage?`.
- **SQL** (`0007_platform.sql`): `studios` (Snowy = `57d10000-…0001`, default), `platform_admins`, `studio_id` on every table backfilled to Snowy, composite same-studio FKs, guard trigger, restrictive `x-studio` RLS scope, studio-scoped RPCs and helpers, `branding` bucket, `platform_*` RPCs, `update_my_studio`, `my_studios`, `join_studio`, and `app.scope_table()` for feature tables. Tests: `supabase/tests/70_platform.sql` (studio A vs B isolation for staff, clients, RPCs, storage, webhook). Feature SQL tests `supabase/tests/<feature>_*.sql` are picked up by run.sh.
- **Branding** (`src/shared/branding.ts`, `brand.tsx`, `theme.css`): role tokens → runtime CSS variables; Google Fonts per studio; logos as animated path sets, SVG, image or generated text logo. Studio configs in `src/data/studios/` (Snowy, Harbour). `scripts/studio-sql.mjs snowy --write` copies Snowy's branding into `seed.sql` (fills empty branding only). The live store also falls back to the built-in config for an empty row.
- **Resolution** (`src/shared/resolve.ts`, `boot.tsx`): build `STUDIO_SLUG` → subdomain of `PLATFORM_DOMAIN` / custom domain → `#/s/<slug>` / `?studio=` → remembered → picker (client "Find your studio", studio "which studio?" + switcher).
- **Admin** (`/admin/`, `src/admin`): studio list + stats, new studio (palettes), branding editor with live client preview, invite owner (`platform_invite_owner` + new `invite-user` edge function), suspend/reopen.
- **Onboarding** (`src/studio/onboarding.tsx`, `#/welcome/:step`): details, branding, class types, pricing templates, policies, staff, go live.
- **Demo**: one key `spc-demo-v4` holds every studio; Snowy unchanged, Harbour Reformer Co. (Double Bay, deep green/sand, Gloock + Work Sans, own personas), Pete as `pete@studioplatform.example`.
- **Features**: `src/features/{appointments,marketing,commerce,payroll}` stubs, registries in `src/shared/registry.ts`, slots via `<Slot>`, demo/live hooks, `registerPermissions`. Full how-to in AGENTS.md › How to add a feature. A throwaway "hello" feature proved a nav item + route + demo store + permission end to end, then was removed.
- **Fixed on the way**: the demo `listSessions` generated classes in the app's current timezone instead of the studio's (wrong for non-Sydney studios); Harbour's pack persona lost her last credit to the seeded waitlist.
- Tests: `tests/platform.test.ts` (isolation, joining a second studio, admin create/invite/go live/suspend, feature hook + permissions, Snowy's exact tokens, resolution order, per-studio formatting), plus `invite-user` and `scope_table` checks.

### Per-studio home screen identity (multi-studio build)
`src/shared/pwa.ts`, called from `boot.tsx` after the studio is bound, only when there is no `STUDIO_SLUG` (the single-studio Snowy build still gets its manifest and icons from `build.mjs` and `public/`, untouched). It builds the web app manifest at runtime (blob URL: name, short name, theme and background colours, `start_url` with `?studio=<slug>`, 192 and 512 icons) and sets `apple-touch-icon` and the iOS title. Icons: the studio's `iconUrl` on the client app, otherwise drawn on a canvas from branding (primary colour with the mark path, or the name's initials in the display font; the studio app uses the ink colour). Pure parts (`pwaIdentity`, `manifestFor`, `initialsFor`) are tested in `tests/platform.test.ts`. Gap: iOS reads the touch icon when "Add to Home Screen" is tapped, which works for the generated data URL, but nobody has tried it on a real phone yet; the manifest `id` is the start URL.

### Platform backlog (not done)
- Stripe Connect per studio: checkout and webhooks still use one Stripe account (Snowy's). New studios can't take card payments until then.
- Edge functions and email templates still default some wording to Snowy (sender name from env); make them read the studio row. (The gift card and cover emails already do; booking, reminder and receipt emails still fall back to Snowy's colours and sender.)
- `cron.sql`: `generate_sessions` / `housekeeping` run as the service role; check they loop every studio (they currently rely on the privileged path) and add a test.
- ~~Custom domains: admin UI to add them~~ done: Domains tab on each studio in the admin, see below.
- ~~Per-studio PWA manifest/icons on the multi-studio build~~ done: `src/shared/pwa.ts`, see below.
- Billing status for studios in the admin (A4 mentions it): not built, there's no platform billing yet.
- Studio-level analytics in the admin beyond the three stats.

## payroll
Staff and payroll (ROADMAP B4), all in `src/features/payroll/`; short spec in `docs/features/payroll.md`.
- **Built**: cover/sub requests (post, claim, approve or auto-approve, approval swaps the class's instructor), pay rules (flat, per head, tiered, hourly, session-type rate), timesheets with clock in/out and owner approval, weekly or fortnightly pay periods with adjustments, mark paid (saved snapshot) and reopen, Xero-friendly CSV. Studio screens: Cover, Payroll (Pay periods / Timesheets / Pay rules), Settings > Payroll, clock widget. Demo seed for both Snowy and Harbour.
- **One calculation**: `calc.ts` is used by the demo and live stores, so they agree. Live reads inputs from `payroll_period_inputs` and the RLS-protected tables; every change goes through an RPC (`1401_payroll_rpcs.sql`) with the same error codes as the demo.
- **Tests**: `tests/payroll.test.ts` (calc, CSV, demo for both studios), `supabase/tests/payroll_flow.sql` (RPC rules, roles, cross-studio isolation).
- **Gaps / to know**: no client-app UI (it's staff-only, `client/index.tsx` is intentionally empty); cover notifications are in-app on demo and queued in `payroll_outbox` on live; `send-email` now drains that outbox (1402 claim/finish RPCs) and emails the eligible staff when a cover request is posted, claimed, approved or declined, as the row's studio; no core slots or hooks were needed; the live store is exercised through the SQL tests, not the fake-supabase live test.

## commerce
Gift cards, promo codes, referral rewards and retail stock with barcodes (ROADMAP B3). Code in `src/features/commerce/`, SQL in `supabase/migrations/1300–1302_commerce_*.sql`, tests in `tests/commerce.test.ts` and `supabase/tests/commerce_{flow,isolation}.sql`.
- **Staff**: Shop (`#/shop/<tab>`: gift cards, promo codes, referrals, retail stock + report), Settings › Shop, a low-stock Today widget, a gift-card/credit card on the client profile, and POS extras (barcode/SKU entry, camera scan where supported, gift card tiles, a promo/gift-card box on the cart).
- **Clients**: Profile › Gift cards (list, balance check, buy with an e-card preview), Profile › Bring a friend (code + friends), "Have a code?" on the Passes tab, and `?ref=CODE` links are claimed once signed in.
- **Rules** live in `logic.ts` (demo + UI + tests) and are mirrored in SQL. Permissions: `commerce.view/sell/manage/stock` (same map in `app.commerce_need`).
- **Till holds**: `holdCodes` reserves a promo/gift card for a cart and returns a note containing `ref <token>`; put it on the sale (`checkoutCart` note), then `settleHold(token)`. The hold becomes a redemption once a sale with that ref exists, and is dropped if abandoned or after 30 minutes. Balance = posted + held entries, so two tills can't spend the same money.
- **Referral reward** is paid (credit or gift card, per settings) when the referred friend's first non-comp paid pass exists; checked on every commerce call.
- **Live**: all RPCs are `public.commerce_*` (studio-scoped, security definer, `authenticated` only); tables are readable by staff only and written only through the RPCs. `live.ts` was checked against a real migrated database with the fake supabase client.
- **Online gift cards (done)**: `commerce-checkout` edge function (`{cardId, studioId, returnUrl}` -> `{url}`) checks the signed-in client is the card's purchaser and that it's still pending, then makes a Stripe Checkout in the studio's currency named after the studio, with `metadata.kind = 'gift_card'`. `stripe-webhook` sees that kind and calls `commerce_activate_gift_card(card, payment_intent, checkout_session)`, which is idempotent (an active card is returned as is, one sale per checkout session), on top of the `stripe_events` check.
- **Gift card emails (done)**: `send-email` (the 2 minute sweep, and `send-reminders`) now also runs `commerce_send_due()` (queues cards whose send date has come, in each studio's own timezone; no more waiting for someone to open the shop) and drains `commerce_outbox` through `commerce_claim_outbox` / `commerce_finish_outbox` (1303, SKIP LOCKED, 5 tries). The e-card is rendered by `_shared/email.ts` as the card's studio: name as sender and heading, its colours (`branding.colors`), address and reply-to from the `studios` row. Nothing is hard-coded to Snowy there. The one-off "instant" database webhook still only sends `notifications`; feature outboxes go out on the next sweep (at most 2 minutes).
- **Refunds undo commerce (done)**: migration 1304 wraps `public.refund_sale` and `public.record_stripe_refund`. When a sale is refunded IN FULL, retail items go back on the shelf (tracked stock only, a "returned" line in the stock log) and any gift card or credit used on the sale gets its amount back (a `refund` entry). Safe to repeat. Partial refunds change nothing; promo redemptions are not reversed (optional, left out). A sale paid only with codes has a $0 total, so `refund_sale` now lets staff mark it refunded (no money) so it can be undone, once. Demo: `DemoFeature.afterRefund` hook (called by `refundSale`), commerce implements it; `engine.refund` allows the same $0 case. Tests: `supabase/tests/commerce_refund.sql`, `tests/commerce.test.ts` (both studios).
- **Gaps / requests for the lead**
  - Promo/gift card + card payment online: `purchaseWithCodes` only completes when the codes cover the whole price, otherwise `PAYMENT_REQUIRED`. It needs `create-checkout` to take a held quote (or a Stripe coupon).
  - Stripe is still one account (Snowy's), so `commerce-checkout` is Snowy-only in practice until Connect per studio (platform backlog).
  - A promo code used on a refunded sale still counts as used.

## kiosk (23 Oct)
- **Check-in kiosk (ROADMAP B5, done)**: `src/features/kiosk/`. "Kiosk mode" in the studio nav (owner, manager, front desk: `kiosk.use`) opens `#/kiosk`, a full-screen layer over the staff app in the studio's own branding (logo, mark, colours, fonts). It lists classes starting within 60 minutes or running (`logic.ts`, tested in `tests/kiosk.test.ts`), then names (or search by first name), and checks in with the core `store.checkIn`. Confirmation: "You're in, Hannah! Enjoy class" with the studio mark. Only first name + last initial are shown; no waiver or first class shows "Please see the front desk"; injuries and notes never reach the screen. Idle for 90 seconds goes back to the class list; the browser back button can't leave (it bounces back to the kiosk).
- **Exit**: 4-digit PIN set in Settings > Kiosk (`kiosk.manage`: owner, manager). With no PIN set, exit asks for the signed-in staff member's password through `store.signIn`. Demo keeps the PIN in the studio's demo slice. Live: migration `1500_kiosk_pin.sql`, one table `kiosk_settings` (bcrypt hash, no read access) and RPCs `kiosk_has_pin` / `kiosk_set_pin` / `kiosk_check_pin`; tests `supabase/tests/kiosk_pin.sql` (roles, hashing, Snowy vs Harbour).
- **Exit lockout (done)**: 5 wrong PINs in a row lock the exit for 5 minutes with a friendly message ("Too many tries. Exit is locked for 5 minutes. Please see the front desk…"); the keypad greys out and the countdown rounds up in minutes. Logic is pure (`afterPinTry`, `lockMinutesLeft` in `logic.ts`, tested). The count and lock time are kept in this device's localStorage per studio, so a reload doesn't reset them. It's a front-desk guard, not a server rule: clearing site data resets it.
- **Gaps**: Not true full screen on iPad Safari: add the studio app to the Home Screen to hide the browser bar. Kiosk uses the staff member signed in on the iPad, so give the front desk their own login. Smoke-tested on `?studio=snowy` at 1024; Harbour not run separately.

## reviews (23 Oct)
- **Reviews and NPS after class (ROADMAP B5, done)**: `src/features/reviews/`, SQL `supabase/migrations/1600_reviews.sql`, tests `tests/reviews.test.ts` and `supabase/tests/reviews_flow.sql` (rules, roles, Snowy vs Harbour).
- **Client**: a card at the top of the timetable (slot `client.timetable`): "How was Mat Essentials with Julia?", 1 to 5 flowers, optional comment, "Would you recommend us?" 0 to 10, and "Not now". It asks about the client's latest checked-in class that has finished (within 14 days), once per booking; answering or "Not now" both stop it. A 9 or 10 gets a "Share it on Google too" button when the studio saved a link.
- **Studio**: nav "Reviews" (`reviews.view`: owner, manager, instructor): average rating per class type and per instructor, NPS (promoters 9 to 10 minus detractors 0 to 6) with a bar, latest comments, 30 / 90 days / all time. Owner and manager see everything; an instructor only their own classes (demo store and RLS both enforce it). Front desk has no access. Settings > Reviews (`reviews.manage`) holds the optional Google review link (web addresses only; empty = off).
- **Live**: tables `reviews_entries` (one per booking, readable by staff through RLS), `reviews_settings`, `reviews_skips` (no grants); RPCs `reviews_pending`, `reviews_submit`, `reviews_dismiss`, `reviews_save_settings`. Maths is `calc.ts`, shared by demo, live and UI.
- **Demo seed**: both studios get reviews for most past checked-in classes; each client's latest class is left unrated so the card shows (Hannah, Jess, Mia at Snowy; Lucas at Harbour). The Google link starts empty in both.
- **Gaps**: only the first name is shown with a comment (no way to hide it); no reply-to-review or email nudge; clients see the card on the timetable only, not on the Bookings tab.

## integrations: ClassPass / Gympass (23 Oct)
- **Hooks built, integration stubbed (ROADMAP B5)**: `src/features/integrations/`, SQL `supabase/migrations/1700_integrations_tables.sql` + `1701_integrations_rpcs.sql`, edge function `supabase/functions/partner-webhook/`, tests `tests/integrations.test.ts`, `supabase/tests/integrations_flow.sql` (roles, write-only keys, webhook functions, Snowy vs Harbour) and a case in `supabase/tests/functions.test.mjs`. Full write-up and go-live steps in `docs/features/integrations.md`.
- **A real partner agreement is needed** before any of it can be used with ClassPass or Gympass (they supply the partner ID, API key, signing scheme and webhook format). The Settings tab says so; so do the docs and the function header.
- **Settings › Partners** (owner, manager): switch each partner on, your studio ID at the partner, API key (owner only, **write-only**: stored in `integrations_secrets`, a table with no grants, read only by the edge function; the demo never keeps it), and spots held per class type. Demo studios are seeded with one partner each (Snowy: ClassPass, Harbour: Gympass), spots held and a few partner bookings; "Try it (demo)" pretends a partner booking arrives.
- **Roster**: partner bookings get a ClassPass / Gympass badge (slot `roster.entry`) and the roster shows "ClassPass: 2 of 2 held spots booked" (slot `roster.header`). A partner booking is a normal booking (booked, no pass used, core `source` 'staff') plus a row in `integrations_partner_bookings` whose `source` is 'classpass' / 'gympass'. I did not widen the core `bookings.source` check or the `Booking['source']` type (lead-owned); the partner source lives in the feature table instead.
- **Webhook stub**: off unless `PARTNER_WEBHOOK_ENABLED=true`, and `verifySignature()` is a clearly marked TODO that rejects everything (`PARTNER_WEBHOOK_SKIP_VERIFY=true` skips it for local tests only). It calls `integrations_partner_book` / `integrations_partner_cancel` (service role only): a partner member becomes a client row (no email, so nothing is ever emailed to them), spots held and capacity are checked, repeats are safe. Not added to the deploy list in GO-LIVE.md on purpose.
- **Held spots now apply to direct clients (done, 26 Oct)**: unfilled held spots (held minus partner bookings in that class, for switched-on partners) are kept back from direct clients. Clients book against, and see, capacity minus those spots; staff, the roster and Today keep the real numbers; partner bookings can still use them; the waitlist is never promoted into a held spot. Core stays feature-agnostic through a capacity adjuster: `src/domain/capacity.ts` (`directFull`, `directSpotsLeft`), `DemoFeature.heldBack(state, session)` in the demo (engine `book`, `promote`, `withCounts`; the store asks for the client view when nobody staff is signed in), and in SQL `1703_integrations_held_spots.sql` with `app.capacity_hooks` + `app.held_back_spots(session)` (integrations registers `app.integrations_held_back`). 1703 re-creates `book_class`, `app.promote_waitlist` and `sessions_with_counts` from their 0007 versions with only the "held" lines changed, so a later change to those in core has to keep them. Staff booking and `move_booking` use the real capacity on purpose. Tests: `tests/integrations.test.ts`, `supabase/tests/integrations_held_spots.sql`.
- **Other gaps**: partner class-id mapping and the real payload are provisional; no payout or revenue tracking per partner; partner members show "No waiver" / "First class" flags on the roster (true, they sign at the desk).

## integrations: Xero export (23 Oct)
- **Xero sales export (ROADMAP B5, done)**: in the `integrations` feature (`xero.ts` for the formats, `studio/xero.tsx` for the screen, `1702_integrations_accounting.sql` for the settings). Settings › Xero export (owner, manager: `integrations.accounting`). There's no Reports slot in the core, so it is a settings tab; ask the lead for a `reports.export` slot if it should sit on the Reports screen.
- **Two formats** (pure functions, built in the browser from `store.listSales`, so demo and live are the same code): **Sales invoices** (Xero's invoice import: `*ContactName ... *InvoiceNumber, Reference, *InvoiceDate, *DueDate, *Description, *Quantity, *UnitAmount, *AccountCode, *TaxType, TaxAmount ... Currency`; one row per item, unit amount excludes GST, GST on its own column, payment method in Reference, a promo or gift card shows as a Discount line; refunded sales are left out, make a credit note in Xero) and **Manual journals** (`*Narration, *Date, Description, *AccountCode, *TaxRate, *Amount ...`; one balanced journal per studio day and payment method: debit the payment account, credit Sales, credit the GST account; refunds come off on the day they were made). Dates are DD/MM/YYYY. Comp and imported sales are left out; the screen says how many sales were skipped and why.
- **Settings**: account codes per studio (sales 200, GST 820, card online 091, card reader 092, cash 090, tax type `GST on Income`, journal tax rate `BAS Excluded`, invoice prefix `POS-`: Xero's usual Australian codes, so change them to match the studio's chart). Table `integrations_accounting`, RPC `integrations_save_accounting` (unknown keys dropped, codes under 60 chars).
- **Tests**: `tests/xero.test.ts` (the CSV format: columns, GST, methods, codes, balanced journals, refunds), `supabase/tests/integrations_accounting.sql` (roles, validation, Snowy vs Harbour). Smoke-tested downloads on both demo studios.
- **Gaps**: the formats follow Xero's published import templates from memory and haven't been imported into a real Xero org: have the bookkeeper try one file first. Whether journal amounts are GST-inclusive differs by import option in Xero, so the journal posts GST on its own line with a no-tax rate to avoid depending on it (the invoice export is the one that feeds the BAS). A sale refunded after the end of the chosen dates isn't in that export (sales are listed by sale date). Gift cards sold are exported as ordinary income lines.
- **Custom domains in the admin (done)**: new Domains tab on each studio (`src/admin/main.tsx` `DomainsPage`, helpers in `src/admin/domains.ts`). Add and remove (inline confirm) domains, saved with `platform.updateStudioAsAdmin(id, { customDomains })` to the existing `custom_domains` column, same code in demo and live. The typed text is tidied (`https://Book.X.com/a` becomes `book.x.com`) and refused in plain words if it's an IP, not a valid host, on the platform domain, already on this studio, or already linked to another studio. The panel shows the DNS steps for the latest domain: CNAME to `<slug>.<PLATFORM_DOMAIN>` for a sub-domain, ALIAS/ANAME (or Netlify's A record) for a root domain, then the Netlify "domain alias" step, the Supabase Redirect URLs step, and a check. Matches docs/PLATFORM.md section C.
- **Domains, database side** (`1800_custom_domains.sql`): trigger on `studios.custom_domains` lowercases, trims, de-dupes, checks the host name, caps at 10 and refuses a domain another studio has (`DOMAIN_TAKEN`), whichever way it's written. `supabase/tests/domains_flow.sql` covers it, including who can change it and anon lookup by domain for Snowy vs Harbour. `tests/domains.test.ts` covers the helpers.
- **Domains gaps**: the demo store has no checks of its own, only the admin screen does. The screen can't verify DNS from the browser, so it says nothing is live until DNS is set. Adding the domain in Netlify and Supabase Redirect URLs is still manual. Also fixed the admin tab strip pushing the page wider than a phone.

## ondemand (26 Oct)
- **What**: online classes (on-demand video), `src/features/ondemand/`. Client "Online" tab (5th tab, order 35): category chips, video cards with thumbnail and duration, "Recently watched" row, player screen (`#/online/:id`), calm "Unlock with Online membership" card that goes to `/passes`. Studio: "Online classes" nav (`ondemand.manage`, owner and manager) with add, edit, publish/unpublish, reorder (up/down), delete and a views count; Settings › Online classes ticks which products include online access.
- **Access**: a video is unlocked if it is marked free (anyone signed in) or the client has an active, unpaused, unexpired pass from a ticked product. The ticked products live in the feature's own table `ondemand_products` (keyed by product_id), so core types are untouched. Locked rows come back with `locked: true` and no address (demo `toClientVideo`, live `ondemand_list_videos`). Clients can't read the tables, so a locked address can't leak. Owner and manager preview everything (not counted as views).
- **Hosting**: studio pastes a Vimeo or YouTube link (unlisted is fine, Vimeo `/id/hash` handled) or a direct .mp4/.webm URL. Nothing loads from the host until the client presses play (YouTube uses youtube-nocookie, Vimeo `dnt=1`); mp4 uses `<video>`. **Later**: Mux or Cloudflare Stream can be added for protected hosting (signed playback URLs): store a playback id instead of a URL and have `ondemand_list_videos` return a short-lived signed URL; the `Player` is the only place that needs to change.
- **Seed**: Snowy 6 videos (two free, incl. "Mums + Bubs: getting started") and a seeded "Online membership" product ($19 a month, `pr_online`); `pr_online` and Unlimited are ticked. Hannah has two recently watched. Harbour 4 videos, "Unlimited reformer" ticked. Video URLs are public sample mp4s and one public YouTube link.
- **Live**: `1900_ondemand.sql` (videos, products flags, views; RPCs `ondemand_list_videos`, `ondemand_record_view`, `ondemand_admin_list`, `ondemand_save_video`, `ondemand_set_published`, `ondemand_reorder`, `ondemand_delete_video`, `ondemand_save_products`), `live.ts`. Tests: `tests/ondemand.test.ts`, `supabase/tests/ondemand_flow.sql` (locked vs unlocked, views, roles, Snowy vs Harbour).
- **Requests for the lead / gaps**: (1) DONE 27 Oct: a `noClasses` flag on `Product` and `Pass` (shared types). `checkPassForSession` refuses such a pass for any class (so booking, waitlist promotion and the staff booking sheet skip it), `isUnlimited` is false for it, `creditLabel` says "Online only", the timetable credit pill ignores it (a member with only that pass sees "Get a pass"), and shop/POS/settings text says "Online classes only". Live: `0008_no_classes_products.sql` (`products.no_classes`, `passes.no_classes` copied in `app.create_pass`, `app.pass_usable` refuses it, `credit_summary` labels it). The Products editor has an "Online only" tick, so a live owner makes the Online membership there. Demo: Snowy's seeded `pr_online` is flagged (the old `ct_online` class-type trick is gone). Tests in `tests/ondemand.test.ts`. (2) Purchase of a flagged product happens through the normal shop and Stripe flow, no change needed. (3) "Recently watched" is by last play, no resume position (embeds don't report it). (4) Thumbnails are paths or URLs, no upload yet.

## support (26 Oct)
- **What**: in-app help and support, `src/features/support/`. Studio app: a floating Help button (every staff role) opens a sheet with one free-text box ("What's going on?"), up to 3 matching help articles as you type (keyword + fuzzy, no AI, "Did this answer it?" Yes/Not quite), an "Urgent: clients can't book or pay" toggle, an optional photo (downscaled to a small JPEG) and an "attached automatically" list (page, studio, name and role, app version, browser). **No categories anywhere.** Send gives an instant on-screen promise: "Got it. Pete will reply by 11:20am today" (or "We've been alerted and are on it now" when urgent). "My requests" shows each thread and Pete's replies (also on `#/help`, with the 10 searchable guides, deep links `#/help/<slug>`).
- **Reply-by maths** (`hours.ts`, tests in `tests/support.test.ts`): 2 business hours, Mon to Fri 9am to 5pm in `SUPPORT_TZ` = Australia/Sydney (`config.ts`, never the studio's). After 5pm, weekends and closed dates (`SUPPORT_CLOSED_DATES`, empty: add public holidays) wait for the next opening, so Fri 6pm becomes Mon 11am. The time is shown in the viewing studio's own timezone.
- **Admin** (`src/admin/main.tsx`: one import, one route `#/support`, one nav link with an open count): inbox of every studio's requests, newest first, urgent unresolved ones pinned and red; context (page, version, device, full user agent, studio id), screenshot, thread, reply box with "after sending" status, open / waiting / resolved buttons, and the platform status banner editor ("Payments are slow right now, we're on it"). The banner is a slim bar above the studio app for everyone signed in as staff (dismissable per message).
- **Hooks used**: the studio app has no slot for always-on elements, so `studio/index.tsx` mounts its own tiny React root (`#support-root`, before `#root`) for the button, sheet and banner. It only shows when a staff member is signed in (checked every 3 seconds, no core change).
- **Demo**: unlike other features the data is NOT in a studio's demo state: the admin inbox must see every studio at once, so it is one shared list in localStorage (`spc-support-demo-v1`, `demoDb.ts`), seeded for Snowy and Harbour. `demoReset` does not clear it (clear the key by hand).
- **Live**: `2000_support.sql`: `support_requests` and `support_messages` (studio_id, `app.scope_table`, RLS: the author reads their own, owner and manager read the studio's, platform admins read and write everything), `support_status` (the one platform-wide banner row, no studio, readable by anyone, written only by RPC). RPCs `support_send`, `support_follow`, `support_admin_reply`, `support_admin_set_status`, `support_admin_set_banner` (admin ones use `app.require_platform_admin()` then `app.use_studio()`). Test: `supabase/tests/support_isolation.sql`. The admin inbox borrows the platform's signed-in supabase client (`platform.shared.sb`, a private field read at runtime) because `PlatformStore` has no support methods; the lead may want proper ones.
- **Urgent alert (done, 27 Oct)**: `2001_support_alert_outbox.sql`: a platform-level `support_alert_outbox` (no studio scope, service role only; a trigger on `support_requests` queues one row per urgent request, with studio, person, role, message and page), plus `support_alert_claim_outbox` / `support_alert_finish_outbox` (same shape as the payroll ones). Drained by `drainSupportAlerts` in `supabase/functions/_shared/email.ts`, called from `drainFeatureOutboxes`, so both `send-reminders` and `send-email` (flush) send it. Env: `SUPPORT_ALERT_EMAIL` (the recipient; unset = alerts wait in the table) and optional `SUPPORT_ALERT_SMS_WEBHOOK` (a URL that gets a JSON POST: kind, requestId, studio, person, role, message, page, inboxUrl, createdAt; a failing webhook is logged, not retried, when the email went; it retries only if it is the sole channel). Both in docs/GO-LIVE.md. The email links to `/admin/#/support` (`PLATFORM_DOMAIN` or `APP_URL`). Demo mode sends nothing. Test: `supabase/tests/functions.test.mjs`. ROADMAP line ticked (email now; SMS webhook ready). `SUPPORT_EMAIL` in `config.ts` is only the address shown to studios.
- **Help assistant (done, 27 Oct)**: an "Ask" button next to "Send to Pete" in the Help sheet (never on keystroke; editing the text clears the answer). It shows a calm "Quick answer" card (label says it is written automatically) with "That fixed it" (closes the sheet) and "Still need help → send to Pete" (sends the request with `The help assistant suggested: ...` appended to the body via `withAssistContext` in `assist.ts`, so no RPC or schema change; the admin inbox shows it in the message). The text box always stays, no categories. `SupportStore.assist({question, page})` returns `{answer, suggestHuman, link?}`. **Demo**: no API call, `articleAnswer` (`assist.ts`) builds it from the best article (summary, first 3 steps, link to `#/help/<slug>`; "send it to Pete" when nothing fits). **Live**: `live.ts` calls the `support-assist` edge function; a 501 (no key), 502 or network failure falls back to the same article answer, 429 shows the cap message. Edge function `supabase/functions/support-assist`: `{question, page, studioId}`, JWT + active staff of that studio (else 403), plain `fetch` to the Anthropic Messages API (`ANTHROPIC_API_KEY`, `SUPPORT_ASSIST_MODEL` default `claude-haiku-5-5`, `max_tokens` 400), system prompt = all help articles + the studio's booking window, cancel window and late fee + plain-Australian-English rules ("if unsure or it needs a human, say so, never invent features"), model replies JSON `{answer, suggestHuman}` (parsed leniently). Cap 30 per person per rolling 24h via `support_assist_log` (`2002_support_assist_log.sql`, ids and times only, service role only). **Articles copy**: edge functions can't import from `src/`, so `supabase/functions/_shared/help-articles.ts` is a generated copy; after editing `articles.ts` run `node --import tsx scripts/sync-help-articles.mts` (a test in `tests/support.test.ts` fails if they drift). Tests: `supabase/tests/functions.test.mjs` (fake Anthropic fetch: answer, model env, no key 501, 502, non-staff 403/401, cap 429) and `tests/support.test.ts`. Env in docs/GO-LIVE.md. Screenshot: `screenshots/support/assist-1024.png`.
- **Gaps**: screenshots are stored as a data URL column (under 900k characters), fine for a few a day, move to Storage if it grows. App version is a constant (`APP_VERSION` in `config.ts`), bump it with releases. The status banner shows in the studio app only (not the client app). Undo and onboarding stay unticked.

## undo (27 Oct)
- **What staff can undo**: (1) **Undo snack, 10 seconds** (was 5, `SnackProvider` in `src/studio/ui.tsx`) after check-in, no-show (one, or "Mark rest as no-show"), a staff cancel or late cancel, and removing someone from the waitlist. Undo reverses it exactly: the credit is taken again if it had come back, the person the waitlist auto-booked into the spot goes back to their old place in line (and gets their credit back), a late-cancel or no-show fee is taken off, and if the spot has since gone or the pass has no credit left it says so instead of squeezing them in. (2) **Restore class**: button on a cancelled class's roster. Rebooks everyone who was booked (credits taken again, emailed), puts the waitlist back in order, then lets the normal waitlist rules fill any spare spot. Anyone who booked another class at that time, has no credit left, was rebooked by hand or is archived is NOT rebooked and is listed (with a link) for staff. (3) **Return credit**: button on a late cancel or no-show in the client's Bookings list; it becomes a normal cancel, credit back, any fee refunded. (4) **Void sale**: on the POS receipt ("Made a mistake? Void sale") and on the client's Purchases. Only today's sales paid by cash, card reader or comp, only if no class has been used on the pass. The confirm sheet is built from a dry run and says in plain English what happens (takings, pass cancelled, stock back, what to hand back). It is a full refund plus a "Refund: Voided: reason" note, so retail stock and gift card or credit amounts go back through the existing refund path, and reports and Xero show it as a refund on the same day.
- **What can NOT be undone (on purpose)**: Stripe refunds (money has left, a card payment can't be pulled back), so Void refuses card sales and tells staff to use Refund; voiding a sale older than today (use Refund); a pass that has already been used. Also not covered: moving a booking, cancelling a membership, pausing a pass, and a late-cancel or no-show fee that was really charged to a card (live has no such charge yet, fees only exist in the demo, so there's nothing to reverse there). If fees go live via Stripe, "Return credit" must refund the fee through Stripe first.
- **How (no new tables)**: bookings now remember `prior_status` and `prior_waitlist_position` (set by a trigger on every status change), and class sessions remember `cancelled_at`. Undo uses those plus the existing status flags. Demo does the same in `Engine.setStatus`; the fee sale of a no-show or late cancel is tracked in `DemoState.penaltyFees`, the class cancel time in `DemoState.sessionCancelledAt` (both optional, no storage-key bump).
- **Store** (`src/shared/store.ts`, all OPTIONAL, staff only): `undoNoShow`, `undoCancelBooking(id, { demotePromotedId })` (pass `CancelResult.promoted.id`), `waivePenalty`, `restoreSession`, `voidSale(id, { reason, dryRun })`. Result types `UndoCancelResult`, `RestoreSessionResult`, `VoidResult`. `Booking` got optional `priorStatus` / `priorWaitlistPosition`. A `voidSale` dry run is a read (no write, no refetch loop).
- **Live**: `supabase/migrations/0009_undo.sql` (next free core number): RPCs `undo_no_show`, `undo_cancel_booking`, `waive_penalty`, `restore_session`, `void_sale(sale, reason, dry_run)`. Permissions mirror what they reverse: the booking ones use `app.staff_booking_for_update` (front desk, manager, owner, or the instructor of that class), restore uses the cancel-class rule (owner, manager, front desk), void uses the refund rule (owner, manager, front desk). Each checks the studio (`assert_in_studio`, `assert_studio_open`) and writes `app.audit` (`undo_no_show`, `undo_cancel_booking`, `waive_penalty`, `restore_session`, `void_sale`). The demo has no audit log, so nothing is written there.
- **Tests**: `tests/undo.test.ts` (9 tests: credits, capacity, waitlist order, fees, permissions after each undo and refusal), `supabase/tests/undo_flow.sql` (all five RPCs plus a second studio being refused), `scripts/undo-check.mjs` (Playwright, 1024px, `?studio=snowy`, screenshots in `screenshots/undo/`).
- **Core files touched (outside the studio app)**: `src/shared/store.ts` and `src/shared/types.ts` (optional additions only), `src/data/demo/engine.ts` and `index.ts`, `src/data/supabase/index.ts`, `0009_undo.sql`. UI: new `src/studio/undo.tsx`, edits in `roster.tsx`, `clients.tsx`, `pos.tsx`, `ui.tsx`, `studio.css`.
- **Gaps**: restore emails use the "booking confirmed" template in live (there's no "class is back on" template). Restore only rebooks people who were booked or waitlisted when the studio cancelled; anyone who left earlier stays removed. Instructors can undo on their own classes in the database, but the client profile's Return credit button is shown to roles with every roster (owner, manager, front desk). Undo of a late cancel from the toast needs the class not to have finished.
