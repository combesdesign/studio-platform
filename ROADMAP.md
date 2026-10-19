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
- [ ] Private and duet appointments:
  - instructor availability
  - bookable slots
  - pricing and appointment packs
  - buffer times
- [ ] Workshops, courses (multi-session) and events with their own pricing, capacity and sign-up
- [ ] Spot or mat selection (optional, per class)

### B2 Marketing and messaging
- [ ] Email campaigns, using segments built from client filters
- [ ] SMS campaigns, with an SMS provider stub
- [ ] Automations:
  - welcome series
  - intro offer ending
  - pack running low or expiring
  - win-back after X days
  - birthday
  - post-first-class
- [ ] Two-way inbox (studio ⇄ client messages in the app)
- [ ] Push notifications (Capacitor and web push)

### B3 Selling extras
- [x] Gift cards: buy, send and redeem, with balance tracking
- [x] Promo codes: % or $ off, limits, expiry, per product
- [x] Referral rewards
- [x] Retail stock: inventory counts, low-stock alerts, barcode scanning at the POS

### B4 Staff and payroll
- [x] Sub and cover requests (post a class, staff claim it, the owner approves)
- [x] Pay rules: per class, per head, tiers, hourly
- [x] Timesheets and clock-in
- [x] Payroll export (CSV for Xero and others)

### B5 More Momence parity (after B1–B4)
- [ ] On-demand video library and on-demand subscriptions
- [ ] Family and child accounts on one profile
- [ ] Multi-location and rooms
- [ ] Check-in kiosk mode (an iPad clients tap themselves)
- [ ] Reviews and NPS after class
- [ ] ClassPass and Gympass: needs a partner agreement. Build the hooks and stub the integration.
- [ ] Accounting export to Xero
- [ ] Stripe Terminal card reader at the POS

## Phase C: launch-readiness (Snowy and platform)
- [ ] Capacitor wrap for the App Store and Google Play (per studio for white-label apps, or one shared app with studio pick)
- [ ] Real accounts: Supabase, Stripe and Resend, plus a Stripe test-mode run-through
- [ ] Momence data import (waiting on Libby's export)
- [ ] Final independent review and security pass
