# Appointments and events (B1)

Studio app: **Appointments** in the nav (week calendar, Workshops and events, Hours), a tab in Settings (booking rules, session types, packs), a Today widget, and a Private sessions card on each client's profile. Client app: **Privates and events** under Profile (Book, Events, Mine) and a banner on the timetable.

- **Session types**: a private (1 person) or duet (up to 2, priced per person) with a length, a buffer kept free afterwards, a price, the instructors who offer it, and an optional note shown before booking.
- **Hours and slots**: each instructor sets weekly hours (several windows a day) and time off. Open times are every start on the slot grid inside those hours, minus classes they teach, other appointments plus buffers, and time off; clients also need the minimum notice and can only book inside the horizon. Staff can book closer in and further out.
- **Packs**: "5 privates" style credit packs, one credit per person per session, optional expiry counted from first use, optionally limited to some session types. Clients buy them in the app; the front desk sells them from the client's profile.
- **Booking and cancelling**: clients pay with a credit or by card; the front desk also takes cash, the card reader or comps. Cancelling in time returns the credit or queues a refund; inside the studio's cancel window the credit or payment is kept (staff can waive that). Staff mark sessions done or no-show.
- **Workshops, courses and events**: a title, price (0 for free), capacity, host, location, 1 or more sessions (a course is bought once for all of them) and its own refund cut-off. Clients sign up and pay in the app, staff add people, take attendance per session, and can cancel the event (everyone is cancelled and refunds are marked due).
- **Emails** (as the studio): confirmation, cancellation and a reminder 24 hours before, for both appointments and events, through `appointments_outbox` and the existing drains.
- **Money**: every payment is a core sale (receipts, reports and refunds just work). Live online payment goes through Stripe Checkout (`appointments-checkout`, `appointments-stripe-webhook`); a slot or place is held briefly while the client pays.

Code: `src/features/appointments/`; SQL `supabase/migrations/1100_*` to `1103_*`; functions `supabase/functions/appointments-checkout` and `appointments-stripe-webhook`; email templates in `supabase/functions/_shared/email.ts`; tests `tests/appointments.test.ts`, `supabase/tests/appointments_rpcs.sql`.
Permissions: `appointments.view` (all staff; instructors only see their own sessions), `appointments.own` (own hours, mark own sessions), `appointments.book` (owner, manager, front desk), `appointments.manage` (owner, manager).
