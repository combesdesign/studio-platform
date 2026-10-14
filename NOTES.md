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
  - No drag-to-dismiss on sheets (scrim, ✕ and Esc all work).
  - Date inputs use native pickers.
  - .ics download via `<a download>` may need Capacitor's Filesystem/Share plugin once wrapped.

## studio

**Status:** done. `node build.mjs` is clean, and `tsc -p tsconfig.core.json` plus `npm test` (27) still pass. The Playwright run-through passes with **0 console errors and 0 layout problems** at 1024×768, 768×1024 and 390×844, plus the permission passes. The script lives outside the repo at `/tmp/studio-e2e/run.mjs`. It pins the clock to 4:00pm Wed 14 Oct 2026 (Sydney) so the run is repeatable, and it checks every screen for horizontal overflow, clipped text and text under 12px. Screenshots are in `screenshots/studio/`: `NN-name-<width>.png` for each size, plus `50–59` for the instructor and front-desk passes. `src/studio/e2e.mjs` has been removed.

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
- **Grace P (instructor):** no Settings, no Walk-in or New client, no edit/cancel class, no revenue, pay or sales CSV, no staff notes, refunds, pass adjustments or client edits. Other classes are locked on the schedule, and `#/class/<someone else's>` shows "Not your class".
- **Front desk** (created in Settings, signed in by email): no Settings; reports show attendance only plus Clients CSV; sees staff notes and purchases and can refund.

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

### Known gaps
- **No front-desk persona** in the demo seed. I tested front desk by adding one in Settings. *Engine:* consider adding one to `demoPersonas()`.
- **Instructors can't create clients**, because `clients_edit` isn't in their role, so Walk-in is hidden for them. RULES says "Grace P does front desk". If she should handle walk-ins, give her the front_desk role or add `clients_edit` to instructor.
- **Moving into a full class isn't possible.** You have to squeeze them in from that class's roster, or remove them and add them there.
- Card-reader payments are recorded manually; there's no Stripe Terminal yet. Refunds are only recorded, not sent to Stripe, until live.
- **The Today "passes expiring" panel** calls `listPasses` once per client. That's fine for ~50 clients. The live store may want a dedicated query.
- **Toasts persist across sign-out** for their 2.8s, which is cosmetic. The ToastProvider sits above the auth switch.
- **Full-page screenshots** show the sticky sidebar or tab bar part-way down the page. That's an artefact of the screenshot, not the app.

## backend

## lead
- Paused 14 Oct ~4:20pm for the usage limit, which resets at 8:40pm. The engine is done. Client, studio and backend were cut off part-way.
- Agent ids that can be continued: client app = aaf3687f799f69c26, backend = ab7b1b3a902feb432. The resume reminder has these two swapped, so go by this note. Studio has no id and needs a fresh agent to finish it from the code in src/studio.
