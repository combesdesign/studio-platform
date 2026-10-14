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

## studio

## backend
