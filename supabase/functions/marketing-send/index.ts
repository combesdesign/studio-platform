// Sends the marketing queue: campaign and automation emails (through the shared Resend sender) and texts (a stub until
// Twilio is configured), each one as its own studio: name, colours, fonts, logo, address, reply-to and footer note.
// Also the little tracking endpoint behind every email: open pixel, link clicks and one-click unsubscribe.
// Deploy with --no-verify-jwt (the tracking links are opened by inboxes); every POST is checked below.
//
//   POST (x-cron-secret)       { }                          optional manual run: queue what is due (marketing_tick) + send. The normal path is the
//                                                           existing drains: send-email (flush) and send-reminders (drainFeatureOutboxes)
//   POST (staff sign-in)       { kick: true, studioId }     send what is queued now (after "Send now"); owner, manager or front desk of that studio
//   POST (staff sign-in)       { test: {...}, to, studioId } one test email or text of a campaign; owner or manager of that studio
//   GET ?k=o|c|u&m=<message id>[&l=<link index>]            open pixel, click redirect, unsubscribe
//
// Settings: RESEND_API_KEY + EMAIL_FROM (shared with send-email), APP_URL / PLATFORM_DOMAIN (links), and for real texts
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (optional SMS_DEFAULT_COUNTRY_CODE, default +61). Push is not sent here (see NOTES.md).
import { adminClient, must, userClient, type Db } from '../_shared/db.ts';
import { sendViaResend } from '../_shared/email.ts';
import { HttpError, json, readJson, requireCronSecret, serve } from '../_shared/http.ts';
import { brandFor, buildSms, drainMarketing, renderEmail, sendSms, varsFor, type Any, type Job, type RenderBlock } from '../_shared/marketing.ts';

// ---------------------------------------------------------------- who is asking (staff calls)

async function staffOf(req: Request, admin: Db, studioId: string, roles: string[]): Promise<{ name: string }> {
  const caller = userClient(req);
  const { data: who } = await caller.auth.getUser();
  const uid = who?.user?.id;
  if (!uid) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.');
  const mine = must(await admin.from('staff').select('role, name').eq('studio_id', studioId).eq('user_id', uid).eq('active', true)) as { role: string; name: string }[];
  const hit = mine.find((s) => roles.includes(s.role));
  if (!hit) throw new HttpError(403, 'NOT_ALLOWED', 'You don’t have permission to do that.');
  return { name: hit.name };
}

async function sendTest(admin: Db, studioId: string, to: string, t: Any, staffName: string): Promise<void> {
  const s = must(await admin.from('studios').select('name, slug, email, address, branding, custom_domains').eq('id', studioId).single()) as Any;
  const st = (must(await admin.from('marketing_settings').select('from_name, reply_to, sms_sender, footer_note').eq('studio_id', studioId).maybeSingle()) ?? {}) as Any;
  const studio = { name: s.name, slug: s.slug, email: s.email ?? '', address: s.address ?? '', branding: s.branding ?? {}, customDomains: s.custom_domains ?? null } as Job['studio'];
  const settings = { fromName: String(st.from_name ?? ''), replyTo: String(st.reply_to ?? ''), smsSender: String(st.sms_sender ?? ''), footerNote: String(st.footer_note ?? '') };
  const job = { firstName: staffName.split(' ')[0] || 'there', lastName: '', studio, payload: {} } as unknown as Job;
  const vars = varsFor(job);
  if (t.channel === 'sms') { await sendSms(to, buildSms(String(t.body ?? ''), vars, { marketing: true }), settings.smsSender); return; }
  const subject = String(t.subject ?? '');
  const out = renderEmail({
    subject, preheader: String(t.preheader ?? ''), blocks: (t.blocks ?? []) as RenderBlock[], brand: brandFor(studio), vars, address: studio.address,
    footerNote: settings.footerNote, baseUrl: vars.app_url, reason: `This is a test of a message from ${studio.name}. Nobody else received it.`,
  });
  await sendViaResend(to, { subject: `[Test] ${subject || studio.name}`, html: out.html, text: out.text }, { fromName: settings.fromName || studio.name, replyTo: settings.replyTo || studio.email || undefined });
}

// ---------------------------------------------------------------- tracking (GET)

const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const page = (title: string, body: string) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:Georgia,serif;max-width:440px;margin:18vh auto;padding:0 20px;text-align:center;color:#222"><h1 style="font-weight:400">${esc(title)}</h1><p style="font-family:Helvetica,Arial,sans-serif;line-height:1.5">${body}</p>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

async function track(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const kind = ({ o: 'open', c: 'click', u: 'unsubscribe' } as Record<string, string>)[u.searchParams.get('k') ?? ''];
  const id = u.searchParams.get('m') ?? '';
  if (!kind || !UUID.test(id)) return new Response('Not found', { status: 404 });
  const link = u.searchParams.get('l');
  const r = must(await adminClient().rpc('marketing_track', { p_id: id, p_kind: kind, p_link: link !== null && /^\d{1,3}$/.test(link) ? Number(link) : null })) as Any;
  if (kind === 'open') return new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
  if (kind === 'click') return r.url && /^https?:\/\//i.test(r.url) ? new Response(null, { status: 302, headers: { Location: r.url, 'Cache-Control': 'no-store' } }) : new Response('Not found', { status: 404 });
  return r.ok
    ? page('You’re unsubscribed', `You won’t get news and offers from ${esc(r.studioName ?? 'this studio')} any more. You can turn them back on in the app any time. Messages about your own classes and passes will still reach you.`)
    : page('That link has expired', 'Open the app and switch off news and offers in your profile.');
}

// ---------------------------------------------------------------- entry

serve(async (req) => {
  if (req.method === 'GET') return await track(req);
  const body = await readJson(req);
  const admin = adminClient();
  if (body.kick || body.test) {
    const studioId = String(body.studioId ?? '');
    if (!UUID.test(studioId)) throw new HttpError(400, 'INVALID', 'Missing studio.');
    if (body.test) {
      const staff = await staffOf(req, admin, studioId, ['owner', 'manager']);
      const to = String(body.to ?? '').trim();
      if (!to) throw new HttpError(400, 'INVALID', 'Enter where to send the test.');
      await sendTest(admin, studioId, to, body.test as Any, staff.name);
      return json({ ok: true });
    }
    await staffOf(req, admin, studioId, ['owner', 'manager', 'front_desk']);
    return json(await drainMarketing(admin));
  }
  requireCronSecret(req);
  return json(await drainMarketing(admin, Number(body.limit) || 50));
});
