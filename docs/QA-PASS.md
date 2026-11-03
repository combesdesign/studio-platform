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
