# Studio rules (the app must follow these)

These are Snowy Pilates Club's real policies, taken from snowypilatesclub.com. Where the studio hasn't decided yet, the default is marked **(default)**. Every default is a setting Libby can change.

## Classes
- **Mat Essentials:** all levels, 55 min, the signature class. Bookable.
- **Mums + Bubs:** 45 min, postnatal. Booking note: "Mums must have clearance from a women's health professional before booking. Bring a blanket, mat, bouncer or pram for bub. Crawling babies need to be in a seat or pram." Bookable.
- **Strength + Sculpt:** 50 min. Coming soon (`bookable: false`). The client app shows "Coming soon – register interest".
- Capacity is 14 mats **(default)**.
- Clients can see and book 14 days ahead **(default)**.
- Timezone is Australia/Sydney. All times show as e.g. "6:00am Tue 14 Oct".

## Products (prices include GST)

**Memberships.** Billed weekly by direct debit. They activate from the first booking and give credits per week (Monday–Sunday, studio time). Unused weekly credits don't roll over.
- 1 Class Per Week Membership: $22/week (1 credit a week)
- 2 Classes Per Week Membership: $40/week (2 credits a week). **Recommended**
- 3 Classes Per Week Membership: $55/week (3 credits a week)
- Unlimited Membership: $69/week (unlimited)
- Online membership: on-demand videos only, no studio classes (kept as is; see the on-demand notes).

**Packs.** The expiry clock starts at the first booking, not at purchase.
- Single class: $30. 1 credit, expires 61 days from first use. **(default)** (Libby's price list gives no expiry for this one; kept as it was.)
- 4 class pack: $100. 4 credits, expires after 2 months (61 days) from first use.
- 8 class pack: $190. 8 credits, expires after 4 months (122 days) from first use.

**Intro offer.**
- Intro offer, 2 weeks unlimited: $49. Single use, expires after 14 days (from the first booking).
- New clients only: someone who has never held any class pass.
- One per client.

**Retail (sample, default):** Grip socks $20, Water bottle $15.

## Booking
- Booking takes 1 credit from the best eligible pass. A pass is eligible when it's active, not paused, not expired, covers the class type, and has credits left (for memberships, credits left in the week of the class). Priority order:
  1. Unlimited (membership or intro)
  2. Membership with weekly credits left
  3. The pack or drop-in that expires soonest (passes not yet activated count as expiring last)
- The client can pick a specific pass instead.
- The first booking on a pass that hasn't been activated yet activates it: `activatedAt = now`, `expiresAt = now + validityDays`.
- A client can only hold one booking per class, whether booked or waitlisted.
- Classes can't be booked once they've started. Staff can still add people up to the end of class.
- No eligible credit means the error `NO_CREDITS`. The UI then offers the shop.
- A client must sign the waiver before their first booking (error `WAIVER_REQUIRED`). Staff bookings skip this check but flag `no_waiver` on the roster.
- Order in the app: choose the class, then the pass (the best one is already selected, or buy one), then the health step only if it's needed, then confirm.
  - First-timers (no waiver yet): waiver, plus the long health questions when "Long health form for first-timers" is on **(default on)**.
  - Anyone who has attended before (a checked-in booking): "Any new injuries or health changes since last time?" One tap, No by default; a Yes saves a dated note to their injuries and flags `health_update` on the roster until they're next checked in. Asked at most once every `quickHealthCheckDays` **(default 30)**, and only when "Quick health check for returning clients" is on **(default on)**. The waiver or any earlier check counts as the last check.

## Waitlist
- When a class is full, clients join the waitlist. No credit is taken.
- When a spot opens, the first person on the waitlist who has an eligible credit is booked automatically. They get a confirmation email or push notification, and the credit is taken then.
- Automatic booking stops 1 hour before class (`waitlistCutoffHours`). A spot that opens later stays open, and the waitlist stays as it is.
- When the class starts, any remaining waitlist entries are set to `removed`.

## Cancelling
- Cancel more than 3 hours before the start (`cancelWindowHours`): status `cancelled`, credit returned.
- Cancel within 3 hours: status `late_cancelled`, credit lost. Fee is $0 **(default)** (`lateCancelFeeCents`).
- No-show: status `no_show`, credit lost. Fee is $0 **(default)**.
- Staff can waive the penalty. The credit is returned and the status is `cancelled`.
- Returning a credit to a pack means `creditsUsed - 1`. For memberships and unlimited passes, the cancelled booking simply no longer counts towards that week.
- If the studio cancels a class, every booking becomes `removed`, credits are returned, and clients are notified.

## Check-in
- Staff tap to check in (`checked_in`). They can undo it.
- After class, anyone still `booked` can be marked `no_show` in one action ("Mark rest as no-show").
- Roster flags:
  - `first_class`: no previous checked-in bookings
  - `no_waiver`
  - `injury`: has injuries text
  - `birthday`: birthday this week
  - `last_credit`: the pack has 0 left after this class
  - `pass_expiring`: the pass expires within 7 days

## Memberships
- Pause: from/until dates. No billing, no booking while paused. **(default)** minimum 1 week.
- Cancel: stops future billing. The membership stays usable until `nextBillingAt`.
- Billing in demo mode: `nextBillingAt = activatedAt + 7 days` (weekly). In live mode, Stripe subscriptions handle billing.
- Owner and manager can edit a membership from the client's profile (every change is written to the pass history, and to the audit log in live):
  - Move the renewal date: after today, within 60 days. Nothing is charged or credited in between; weekly billing carries on from the new date.
  - Move to a different membership (same billing interval): no proration by default, or charge/credit the difference now. Credits and the weekly allowance switch at the next billing date, or straight away if chosen. Cancelled or expired memberships can't be edited.

## Staff permissions
- Grace P is set up as **front desk** (she also teaches Mums + Bubs). Any staff member can be the instructor on a class, whatever their role.
- **Owner:** everything.
- **Manager:** everything except staff pay rates and studio settings for the ABN, bank and Stripe.
- **Front desk:** schedule, rosters, check-in, clients, POS. No reports revenue and no pay.
- **Instructor:**
  - their own classes' rosters and check-in
  - client profiles (including injuries, but not staff notes about payments)
  - no POS refunds, no reports revenue, no settings

## Receipts
Receipts show "Snowy Pilates Club", the ABN, "Total includes GST of $X" (1/11 of the total) and the items.
