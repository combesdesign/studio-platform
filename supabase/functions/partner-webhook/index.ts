// ClassPass / Gympass -> database. A STUB. It is OFF unless PARTNER_WEBHOOK_ENABLED=true and it rejects every call
// until the signature check below is written.
//
// REAL USE NEEDS A PARTNER AGREEMENT. ClassPass and Gympass only let a studio take their members after signing the studio
// up as a partner. That is when they hand over the studio's partner ID, an API key, the real webhook format and how they
// sign requests. Everything below is the studio's side of that, in a provisional format of our own, so the rest of the app
// (settings, spots held, roster badge) can be built and tried first. Do not deploy this to production until
// docs/features/integrations.md has been followed.
//
// Deploy (when the time comes):  supabase functions deploy partner-webhook --no-verify-jwt
// (partners don't send a Supabase login, so the signature is the only check: that is why it must be finished first).
//
// Provisional request, POST JSON:
//   { "partner": "classpass" | "gympass",
//     "event": "booking.created" | "booking.cancelled",
//     "studio_id": "<the studio's partner ID, as saved in Settings > Partners>",
//     "booking_id": "<the partner's id for this booking: how repeats and cancels are matched>",
//     "session_id": "<our class session id>",          // TODO(partner agreement): map the partner's class id to ours
//     "member": { "id": "<partner's member id>", "first_name": "...", "last_name": "..." } }
//
// A booking creates (or reuses) a "partner client" for that member and books them into the class with no pass,
// through public.integrations_partner_book (spots held for the partner, capacity, repeats: all checked in the database).
import { adminClient, must } from '../_shared/db.ts';
import { HttpError, json, serve } from '../_shared/http.ts';

const PARTNERS = ['classpass', 'gympass'];

/**
 * TODO(partner agreement): VERIFY THE PARTNER'S SIGNATURE HERE. Not done yet, on purpose.
 *
 * What goes here depends on what the partner documents: usually an HMAC of the raw body (plus a timestamp, to stop replays)
 * made with the studio's API key and sent in a header. The studio's key is saved write-only in
 * public.integrations_secrets (service role only): look it up with the studio found from `studio_id`, then compare in
 * constant time (see timingSafeEqual in ../_shared/http.ts and verifyStripeSignature in ../_shared/stripe.ts for the pattern).
 *
 * Until it's written this returns false for everything, so the function can never create a booking in production.
 * PARTNER_WEBHOOK_SKIP_VERIFY=true switches the check off for local testing ONLY. Never set it on a real project.
 */
// deno-lint-ignore no-unused-vars
async function verifySignature(req: Request, rawBody: string, partner: string, studioPartnerId: string): Promise<boolean> {
  if (Deno.env.get('PARTNER_WEBHOOK_SKIP_VERIFY') === 'true') {
    console.warn('partner-webhook: signature check is OFF (PARTNER_WEBHOOK_SKIP_VERIFY). Local testing only.');
    return true;
  }
  return false; // TODO(partner agreement): replace with the partner's real signature check
}

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  if (Deno.env.get('PARTNER_WEBHOOK_ENABLED') !== 'true') {
    throw new HttpError(501, 'NOT_IMPLEMENTED', 'Partner bookings aren’t switched on. They need a partner agreement first.');
  }
  const raw = await req.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'INVALID', 'That isn’t JSON.'); }
  const partner = String(body.partner ?? '');
  const studioPartnerId = String(body.studio_id ?? '');
  if (!PARTNERS.includes(partner) || !studioPartnerId) throw new HttpError(400, 'INVALID', 'Missing partner or studio.');

  if (!(await verifySignature(req, raw, partner, studioPartnerId))) throw new HttpError(401, 'BAD_SIGNATURE', 'Invalid signature.');

  const admin = adminClient();
  const bookingId = String(body.booking_id ?? '');
  if (body.event === 'booking.created') {
    const m = (body.member ?? {}) as Record<string, unknown>;
    const out = must(await admin.rpc('integrations_partner_book', {
      p_partner: partner, p_partner_studio_id: studioPartnerId, p_session_id: String(body.session_id ?? ''), p_partner_booking_id: bookingId,
      p_member_ref: String(m.id ?? ''), p_first_name: String(m.first_name ?? ''), p_last_name: String(m.last_name ?? ''),
    }));
    return json(out);
  }
  if (body.event === 'booking.cancelled') {
    return json(must(await admin.rpc('integrations_partner_cancel', { p_partner: partner, p_partner_studio_id: studioPartnerId, p_partner_booking_id: bookingId })));
  }
  throw new HttpError(400, 'INVALID', 'That event isn’t one we handle.');
});
