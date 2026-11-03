// ClassPass / Gympass -> database. A STUB. It is OFF unless PARTNER_WEBHOOK_ENABLED=true, and every call must carry a valid
// signature (provisional HMAC scheme below, with the studio's saved partner key) before anything is booked.
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
import { verifyStripeSignature } from '../_shared/stripe.ts';

const PARTNERS = ['classpass', 'gympass'];

/**
 * Signature check. PROVISIONAL FORMAT (of our own, until the partner agreement says how they really sign): the header
 *   X-Partner-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 * made with the studio's saved partner API key (public.integrations_secrets, service role only; saved write-only in Settings > Partners).
 * The studio is found from `studio_id` (the partner's ID for it) among ENABLED partner rows, so an unknown studio, a studio with
 * no key, or a stale timestamp (5 minutes, stops replays) is refused. Replace the header and scheme when the partner documents theirs.
 *
 * PARTNER_WEBHOOK_SKIP_VERIFY=true switches the check off for local testing ONLY. Never set it on a real project: anyone could
 * then book classes for free.
 */
async function verifySignature(req: Request, rawBody: string, partner: string, studioPartnerId: string): Promise<boolean> {
  if (Deno.env.get('PARTNER_WEBHOOK_SKIP_VERIFY') === 'true') {
    console.warn('partner-webhook: signature check is OFF (PARTNER_WEBHOOK_SKIP_VERIFY). Local testing only.');
    return true;
  }
  const header = req.headers.get('X-Partner-Signature');
  if (!header) return false;
  const admin = adminClient();
  const link = must(await admin.from('integrations_partners').select('studio_id').eq('partner', partner).eq('partner_studio_id', studioPartnerId).eq('enabled', true).maybeSingle()) as { studio_id: string } | null;
  if (!link?.studio_id) return false;
  const secret = must(await admin.from('integrations_secrets').select('api_key').eq('studio_id', link.studio_id).eq('partner', partner).maybeSingle()) as { api_key: string } | null;
  if (!secret?.api_key) return false;
  return await verifyStripeSignature(rawBody, header, secret.api_key);
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
