# Roadmap: from the Snowy app to a Momence-style platform

Pete's decision on 15 Oct:
- **Libby keeps her own Snowy Pilates Club app for now.**
- **Separately, the same codebase becomes a platform:** one shared system where many studios each get their own branding, apps and data, like Momence.

**One codebase, two deployments:**
- The Snowy deployment is one studio, with its own Supabase project.
- The platform deployment is multi-studio.

Every feature built from here lands in both.

## Done
- [x] Client app (PWA): timetable, booking, waitlist, cancellations, passes, shop, waiver, profile, photos, back navigation, password screens
- [x] Studio app: today, roster/check-in, schedule and recurring timetable, clients, POS, reports, settings, roles
- [x] Booking engine and demo store (fake data), tests
- [x] Live backend: Supabase schema, RLS, booking RPCs, Stripe and email edge functions, Momence import, GO-LIVE guide
- [x] Snowy brand pass (matches snowypilatesclub.com)

## Phase A: platform foundation (do first, everything else builds on it)
- [x] A1 Multi-studio data model:
  - a `Studio` record (slug, name, timezone, currency, contact, ABN/tax)
  - `studio_id` on every table
  - RLS by studio membership
  - a client can belong to several studios
- [x] A2 White-label branding per studio:
  - logo, wordmark, colours, fonts, photos, phrases, welcome copy, app name and icons
  - Snowy becomes studio config #1, looking exactly as it does now
- [x] A3 Studio resolution: which studio by subdomain, path (`/s/<slug>`) or build config. Timezone and currency come from the studio, not hard-coded.
- [x] A4 Platform admin (Pete): create a studio, set branding, invite its owner, see all studios, billing status
- [x] A5 Studio onboarding wizard: details → branding → classes → pricing → policies → staff → go live
- [x] A6 Demo with 2+ studios (Snowy plus a different-looking sample studio) to prove white-label

## Phase B: Momence features
### B1 Appointments and events
- [x] Private and duet appointments:
  - [x] instructor availability
  - [x] bookable slots
  - [x] pricing and appointment packs
  - [x] buffer times
  - [x] client booking and cancelling with the studio's policy windows, studio calendar, confirmation and reminder emails
- [x] Workshops, courses (multi-session) and events with their own pricing, capacity and sign-up (demo payment, live through Stripe Checkout)
- [ ] Spot or mat selection (optional, per class): not started. It needs its own table and RPCs (a spot per booking), so it isn't cheap through `client.class` / `roster.entry` alone. See NOTES.md › appointments.

### B2 Marketing and messaging
- [x] Email campaigns, using segments built from client filters
- [x] SMS campaigns, with an SMS provider stub
- [x] Automations:
  - [x] welcome series
  - [x] intro offer ending
  - [x] pack running low or expiring
  - [x] win-back after X days
  - [x] birthday
  - [x] post-first-class
- [x] Two-way inbox (studio ⇄ client messages in the app)
- [x] Push notifications (Capacitor and web push): device registration and the queue are built; delivery is stubbed until VAPID / FCM keys exist

### B3 Selling extras
- [x] Gift cards: buy, send and redeem, with balance tracking
  - [x] Pay online (Stripe Checkout, switched on by the webhook)
  - [x] E-card emailed on its send date, as the studio
  - [x] Refunds put gift card amounts and retail stock back
- [x] Promo codes: % or $ off, limits, expiry, per product
- [x] Referral rewards
- [x] Retail stock: inventory counts, low-stock alerts, barcode scanning at the POS

### B4 Staff and payroll
- [x] Sub and cover requests (post a class, staff claim it, the owner approves)
  - [x] Emails to eligible staff when posted, claimed or approved
- [x] Pay rules: per class, per head, tiers, hourly
- [x] Timesheets and clock-in
- [x] Payroll export (CSV for Xero and others)

### B5 More Momence parity (after B1–B4)
- [x] On-demand video library and on-demand subscriptions (built: `src/features/ondemand`; Pete 26 Oct: an "Online classes" section for Mums + Bubs starters and busy clients who can't make it in)
- [x] Family and child accounts on one profile
- [x] Multi-location and rooms (see NOTES.md > locations)
- [x] Check-in kiosk mode (an iPad clients tap themselves)
  - [x] Exit lockout: 5 wrong PINs lock exit for 5 minutes
- [x] Reviews and NPS after class
- [x] ClassPass and Gympass: needs a partner agreement. Build the hooks and stub the integration.
  - [x] Settings tab (partner IDs, write-only keys), spots held per class type, roster badge, webhook stub (signature check left as a TODO)
- [x] Accounting export to Xero
- [ ] Stripe Terminal card reader at the POS

## Support that's actually good (Libby: Momence support is horrible)
Libby's pain points: Momence only offers a fixed list of problems (hers often isn't on it), and they're US-based so replies come overnight.
- [x] No problem menus: always a free-text "tell us what's wrong" box (the assistant can suggest answers, never force a category)
- [x] Australian-based support in AEST/AEDT business hours; urgent "can't take bookings" issues flagged to Pete's phone straight away (email now; SMS webhook ready)
- [x] Every request gets an instant reply (assistant answer or "got it, a human will reply by X") so nobody's left wondering
- [x] In-app "Help" button in the studio app: message us directly, with a screenshot and the page they were on attached automatically
- [x] Help assistant: answers how-to questions instantly from our own help docs, then hands off to a real person ("Ask" in the Help sheet; needs `ANTHROPIC_API_KEY`, falls back to the best help article without it)
- [x] Short help centre: a 1-minute guide for each common job (add a class, refund, change a pass)
- [x] Response promise shown in the app (e.g. reply within 1 business day), plus a status page when something's down
- [x] Studio owners can safely "undo" common mistakes (cancelled class, wrong sale) without needing support (Stripe refunds can't be undone, see NOTES.md `## undo`)
- [ ] Onboarding call and data import done for them, not left as a DIY job

## Selling it to other studios (Pete, 27 Oct)
- [ ] Pick a platform name (check domain + AU trademark before committing)
- [ ] Plans and pricing (discuss with Pete once the main build is done; draft was ~$99 / $179 / $299 but could go higher, Libby pays ~$300/mo for a low Momence plan; what each plan includes is open): simple tiers, bulk email to ALL clients included in every plan (Momence restricts this), no platform fee on top of Stripe, few add-ons
- [x] Plan gating in the platform (which features each plan unlocks) + platform billing (prices and plans are editable data in the admin, see docs/PLATFORM.md)
- [ ] "Switching is easy" PDF guide for prospects: steps from Momence/Mindbody/etc, what we move for them, cost comparison

## Phase C: launch-readiness (Snowy and platform)
- [ ] Capacitor wrap for the App Store and Google Play (per studio for white-label apps, or one shared app with studio pick)
- [ ] Real accounts: Supabase, Stripe and Resend, plus a Stripe test-mode run-through
- [ ] Momence data import (waiting on Libby's export)
- [ ] Final independent review and security pass
