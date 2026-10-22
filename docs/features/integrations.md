# Integrations: ClassPass and Gympass

Code: `src/features/integrations/`. SQL: `supabase/migrations/1700`–`1701_integrations_*.sql`. Edge function: `supabase/functions/partner-webhook/`.

## Read this first: a partner agreement is needed

**ClassPass and Gympass only send their members to a studio that has signed a partner agreement with them.** Nothing in this app can get around that. The agreement is what gives a studio:

- its **partner ID** (how the partner names the studio),
- an **API key** (and how requests are signed),
- the **real webhook format** (what a booking or a cancellation looks like),
- their **schedule feed rules** (how the studio's classes appear on the partner's app).

What is built here is the studio's side of the plumbing, with a made-up request format, so the rest (settings, spots held, the roster badge) can be built and tried first. **Until an agreement is signed, leave both partners switched off.** The webhook function is also off by default and rejects every call (see below).

## What is built

| Piece | Where | Notes |
|---|---|---|
| Settings › Partners | `studio/partners.tsx` | Partner on/off, your studio ID at the partner, API key (**write-only**), spots held per class type |
| Spots held | `integrations_reserved` | How many spots in each class of a class type a partner may take. A partner booking is refused beyond that, and when the class is full |
| Partner bookings | `integrations_partner_bookings` | An ordinary booking (booked, no pass used) plus a row saying `source = 'classpass' / 'gympass'`. The roster shows a badge |
| Partner clients | `integrations_partner_clients` | Each partner member becomes an ordinary client row (name only, no email, so nothing is ever emailed to them) |
| Webhook | `supabase/functions/partner-webhook/` | A stub. See "Going live" |
| Demo | `demoPartnerBook` | Settings › Partners › "Try it (demo)" pretends a partner sent a booking, with the same rules as the database |

### API keys
Keys are saved by `integrations_save_partner` (owner only) into `integrations_secrets`, a table with row security on and **no policy and no grant**: the app can send a key but never read one. The webhook function reads it with the service role. The UI only ever shows "saved". The demo never keeps the key at all. (The key is stored as plain text in that locked table: if you want it encrypted at rest, move it to Supabase Vault.)

### Spots held
"Held" means the number of spots a partner is **allowed to book** into each class of a class type. It does **not** yet stop direct clients taking those spots: the booking engine counts `capacity` the same for everyone, and that is core code. Until the core booking rules know about held spots, set the numbers lower than the class's capacity so direct clients can't fill the room first. The Settings screen says this. (Request for the lead: subtract unused held spots from direct bookings' `spotsLeft`, in `book_class` and the demo engine.)

## Going live (when an agreement exists)

1. Get the partner ID, API key, signing scheme, webhook format and the way partner classes map to ours.
2. In Settings › Partners, switch the partner on, enter the ID and (as owner) the key, and set the spots held.
3. Write `verifySignature()` in `supabase/functions/partner-webhook/index.ts` (it is marked `TODO(partner agreement)`; today it returns false for everything). Look the key up in `integrations_secrets` by the studio found from the partner ID, compare in constant time, and reject old timestamps.
4. Adapt the request parsing to the partner's real format, and map their class id to our `class_sessions.id` (the `session_id` field is ours, provisional).
5. Set `PARTNER_WEBHOOK_ENABLED=true` for the function and deploy it: `supabase functions deploy partner-webhook --no-verify-jwt`. **Never** set `PARTNER_WEBHOOK_SKIP_VERIFY` on a real project: it exists only for the local tests.
6. Test with the partner's sandbox before any real member books.

The database functions the webhook calls (`integrations_partner_book`, `integrations_partner_cancel`) are granted to the service role only. They check the partner is switched on for that studio, the partner ID belongs to exactly one studio, spots are held, the class isn't full, cancelled or started, and they are safe to repeat (the same partner booking id twice is one booking).
