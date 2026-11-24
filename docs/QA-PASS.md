# QA pass, 3 Nov 2026

A full click-through of the demo on master: the Snowy single-studio build (`STUDIO_SLUG=snowy`), plus a quicker pass on the platform build with `?studio=harbour`.
Scripted with Playwright (one script per area), checking for console errors, blank screens, dead buttons, sideways scroll, clipped text, tap targets under 44px, pink, hard-coded names, and "undefined" or "NaN" text.

## What was tested

**Client app, 390x844 (and a 1280 desktop check)**
- Brand new sign up, intro offer purchase, waiver, full health form, first booking.
- Returning member (Hannah): books in two taps, quick injury check, says yes to a new injury.
- Cancel outside the window (free) and inside it (late cancel warning, with the clock moved to 4:30am).
- Waitlist join, buy a class pack, promo code, gift card purchase.
- Book a private, move it, sign up to a course.
- Parent (Sophie) books herself and her baby.
- Free online video, locked online video.
- Messages: send one. Profile rows, toggles, photo, and back navigation from every Profile row.
- Harbour: landing, every tab, appointments, family, gift cards, messages. No Snowy name, town, instructor or address showed up.

**Studio app, 1024x768 and 768x1024**
- Libby: Today, roster flags (first class, no waiver, injury, ClassPass, last credit), check in with undo, walk-in, cancel a class and restore it.
- Client profile: move the renewal date, switch membership, return a credit, send a text, message link.
- POS: pack plus merch, client, promo code (correctly refused for a non-new client), cash sale, void it, gift card sale.
- Marketing: campaign to all clients (confirm step), automations edit, inbox reply.
- Settings: every tab, Policies (health check switches), Emails, Products, Staff, Kiosk PIN.
- Reports, Payroll, Cover, Reviews, Online classes, Appointments calendar: render and audit at both sizes.
- Kiosk in and out with the PIN (wrong PIN is refused, right PIN returns to Today).
- Help button: ask a question, get an instant answer, send it to Pete.
- Grace T (instructor): sees Today, Schedule, Appointments, Clients, POS, Reports, Cover, Reviews. Settings, Payroll, Marketing and Kiosk say "Not available for your role".
- Harbour studio: every nav screen plus settings tabs, no hard-coded Snowy names.

## Fixed

1. `?demo=1` forced demo data on live builds. It now only works when the build has no Supabase URL, or when built with `ALLOW_DEMO_PARAM=1`. Test in `tests/demo-param.test.ts`.
2. Studio sidebar was cut off on iPad. At 1024x768 and in portrait with every feature on, Settings and Sign out were unreachable because the sidebar didn't scroll. It now scrolls, and the nav tightens on short screens so it fits in portrait.
3. The health form asked about pregnancy twice (the studio's own question, then a fixed one). It now asks once, using the studio's question when it has one.
4. A brand new client with no pass saw "You're out of credits". It now says "You'll need a pass".
5. Privates and events always said "Back to Profile", even from the Timetable or Bookings. It now goes back to where you came from.
6. Tap targets under 44px, client: small buttons, the "Get a pass" credit pill, switches, and the "Sign in" and "Create an account" text links.
7. Tap targets under 44px, studio: Sign out, filter pills (All classes / My classes, Calendar, date ranges), Add class on a day, Approve and Claim, small buttons in Online classes, email tag chips, POS cart steppers and remove buttons, text links, colour hex boxes, the Help "Browse all help" link, the logo at 768 wide.
8. Pay buttons showed "Pay $120.00" in some places and "Pay $49" in others. Now the same everywhere (cents only when there are cents).
9. "Charlotte un-checked" now reads "Check-in undone for Charlotte".

## Left for later

- Email and campaign editors show raw merge tags like `{{first_name}}` and `{{app_url}}`. There's a hint line, but a non-technical owner might prefer friendly chips.
- Inline email and phone links in the client profile are small to tap (they're now padded, but worth a look on a real iPad).
- Sheets stay open if the address changes underneath them (only matters if someone edits the URL by hand).
- Locations and Plan settings tabs only exist on the platform build (the Snowy build hides them, by design).
- The unread Messages badge on the client Profile was not re-clicked in this pass (covered by the existing messaging test).
- Real push notification toggle only shows when a VAPID key is set, so it was not tested here.

Screenshots from this pass are in `screenshots/qa/`.

## Running the E2E regression suite

16 journeys in `tests/e2e/` (new client, member quick book, cancel credits, waitlist, POS and void, gift card, privates and workshops, parent and dependant, messages, membership edits, cancel and restore a class, kiosk, card reader, instructor access, Harbour, delete account).

```
ln -sfn /opt/npm-tools/node_modules node_modules   # once per fresh container (no npm registry)
npm run test:e2e                # builds the Snowy and platform apps, serves them, runs every journey, exits non-zero on any failure
npm run test:e2e -- 05 12       # only the journeys whose file name contains 05 or 12
E2E_JOBS=1 npm run test:e2e     # one at a time (default 4 in parallel)
```

- Each journey is its own file and its own browser process with empty storage, a pinned demo clock (a Tuesday, 8:00am Sydney) and fresh demo data. Client journeys run at 390x844, studio ones at 1024x768. Journeys 15 and 16 use the platform build (`?studio=harbour`), the rest the Snowy single-studio build.
- Any console error or page error fails the journey (blocked Google Fonts and the missing `sw.js` are ignored).
- On a failure a screenshot per page goes to `screenshots/e2e-failures/` (gitignored).
- To work on one journey without rebuilding every time: build into two folders, serve them with `python3 -m http.server 4173` (Snowy) and `4174` (platform), then `node tests/e2e/05-pos-void.e2e.mjs`. Override the addresses with `E2E_SNOWY_URL` and `E2E_PLATFORM_URL`.
- Helpers are in `tests/e2e/lib.mjs`. Use `eventually()` and locator waits, never fixed sleeps. After closing a sheet, `settled(page)` waits for the app's history step-back to land before the next navigation.

### Found by the E2E suite

- Closing a sheet right after another one could step the studio off the page (back to Today) because two history back steps were issued for one sheet (`src/shared/react.tsx`). Fixed: the deferred step-back is skipped while one of its own is still in flight.
- Dependants' bookings do not show on the parent's Bookings tab (only the parent's own do). The parent sees them in the class sheet and the studio roster. Not changed, flagged for a decision.

## Round 3: random sequences and the permissions matrix (24 Nov 2026)

Two database-level suites, both plain SQL in `supabase/tests/` and picked up by `bash supabase/tests/run.sh` (they run against the fixtures, each in its own rolled-back transaction).

### `invariants_random.sql`: random operations, invariants checked after every step
- Seven classes (capacity 1 to 4, spots on for the mat class, two classes without spots), six fake clients (packs, memberships, one with no pass), front desk, owner. Every step is one of: book (auto pass or a chosen one), client cancel (inside and outside the 3h window, waitlisted or booked), front desk cancel (with or without waiving), leave waitlist, studio cancel and restore a class, buy a pack/single/membership at the desk, refund a sale (with or without cancelling the pass), no-show, waive a penalty, undo no-show, undo cancel, move a booking, staff booking, check in, adjust credits, resize a class, cancel a membership, and the clock moving on.
- Invariants after every step: booked never above capacity, spots real and unique; no client with two live bookings in one class; per pack `credits_used` = starting use + bookings that consume a credit, `credits` = purchased + adjustments, never negative, `used_up` only when used up; a membership never above its weekly allowance; waitlist positions exactly 1..n and only on waitlisted bookings; nobody promoted twice and a promoted booking took a credit; after a client or staff cancellation before the cutoff, no free spot is left with a waitlisted client who holds a usable pass; a studio-cancelled class has no live booking and no booking still holding a credit; refunds never above what was paid.
- Seeded with `setseed(sin(seed))` and nothing else random, so a failure prints the seed and step and replays exactly. Default: seeds 9, 11 and 29, 300 steps each (900 operations). Reproduce or try others: `psql ... -v inv_seeds='7,99' -v inv_steps=400 -f supabase/tests/invariants_random.sql` (after shim, migrations, seed and fixtures).
- Result: seeds 9, 11 and 29 pass. While building it, seeds 1 to 40 at 300 steps (12,000 operations) were run until clean after the fixes below.

### `permissions_matrix.sql`: every role against every RPC and every table
- Roles: anon, a client (alice), the client who owns the data (bob), the class instructor (julia), another instructor (gracet), front desk, manager, owner, platform admin, a client of another studio, the owner of another studio, and a signed-in stranger who belongs nowhere.
- Functions: the list comes from the catalogue (258 public functions). One missing from `test.pm_rpc_expect` fails the test, and so does one that is no longer there. 200 are callable by signed-in users: each is called as all 12 roles (2,400 verdicts) with arguments pointing at real Snowy rows, then as the other studio's people with no header, and as Snowy's people against Harbour with Harbour's header (Harbour's owner is the control: wherever he gets in, nobody from Snowy may; 155 functions controlled). 57 are service-only (grants checked) and one is a variadic helper. anon may run only the six identity helpers.
- Tables: all 90 tables and 2 views get a generic row per studio (checks dropped and FK triggers off, in the rolled-back transaction only), then each of 9 roles tries to read (any row, all rows), insert, update and delete it (`test.pm_table_expect`, reviewed by hand and grouped by pattern). New tables must be classified. Also checked: RLS on everywhere, the `studio_scope` restrictive policy on every table with a studio (or the table is closed to clients entirely), nothing handed to anon beyond the public catalogue, and the other studio's people, and Snowy's people against Harbour, see and change nothing beyond what a stranger can, with Snowy's header, no header or Harbour's.
- Health notes: under each of the three settings (default owner, managers and that class's instructor; owners and managers only; all staff) who gets them through `client_health` and the class roster; nobody, owner included, through the raw columns; the other studio's people never. A new function that mentions the health columns fails the test until someone reviews it.
- To see the observed matrix instead of asserting (when reviewing a change): `psql ... -v pm_dump=1 -f supabase/tests/permissions_matrix.sql`.
- Limits: the call is judged by the first error, so a function with a gate after argument validation, or a gate on part of the payload (`payroll_update_settings`, `update_my_studio`), is only as well checked as its sample arguments. Those have their own tests.
- Result: all checks pass; the matrix found no permission holes.

### Bugs found and fixed (`supabase/migrations/3200_round3_fixes.sql`, regression assertions in `invariants_random.sql`, plus `tests/undo.test.ts` for the demo engine)
1. **Undo no-show overbooked a class.** A no-show doesn't hold a spot, so someone else could book it, and undoing the no-show then put the class over capacity. It now refuses with `CLASS_FULL`, the same as undoing a cancellation. The demo engine had the same hole and got the same fix.
2. **Undo no-show and check-in of a no-show hit a raw unique-key error** when the client had booked the class again. Both now say `ALREADY_BOOKED`.
3. **A late cancel lost its credit for good when the studio then cancelled the class.** The database kept the forfeited credit (the demo engine already returned it). The late cancel now becomes a plain cancel and the credit comes back; restoring the class doesn't put them back in.

### Design questions (not changed)
- Buying a pass while on a waitlist with a spot already free doesn't promote you. Promotion only runs when a booking is cancelled, the class grows, a class is restored or housekeeping runs, so a spot can sit empty with a ready person waiting.
- Checking in a no-show (a late arrival) into a full class is allowed and overbooks the class. Left alone because staff do this on purpose; undo no-show, which is a correction, now refuses.
- A client marked no-show can book the same class again (no-show isn't a live booking) and pays for it twice.
- Instructors can read the bookings and credit summary of any client, not just clients in their classes, while health notes are limited to their classes. Probably fine, worth a decision.
- `integrations_save_partner` is owner only, `integrations_save_accounting` owner and manager. `update_my_studio` lets a manager change studio details. Matches the permission map as written, flagged in case it isn't what you meant.
- Any signed-in user can call `ensure_sessions`, which generates timetable sessions up to 180 days ahead for the studio. Idempotent, but it is open.
- `notifications`, `stripe_customers` and `support_assist_log` have no `studio_scope` policy. Safe today because they have no policies and no client grants at all; the test now fails if a policy or grant is ever added without one.
