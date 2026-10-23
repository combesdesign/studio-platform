// Sends the marketing queue: campaign and automation emails (through the shared Resend sender) and texts (a stub until
// Twilio is configured), each one as its own studio: name, colours, fonts, logo, address, reply-to and footer note.
// Also the little tracking endpoint behind every email: open pixel, link clicks and one-click unsubscribe.
// Deploy with --no-verify-jwt (the tracking links are opened by inboxes); every POST is checked below.
//
//   POST (x-cron-secret)       { }                          run the scheduler (marketing_tick), then send what is queued. Every 5 minutes (supabase/marketing-cron.sql)
//   POST (staff sign-in)       { kick: true, studioId }     send what is queued now (after "Send now"); owner, manager or front desk of that studio
//   POST (staff sign-in)       { test: {...}, to, studioId } one test email or text of a campaign; owner or manager of that studio
//   GET ?k=o|c|u&m=<message id>[&l=<link index>]            open pixel, click redirect, unsubscribe
//
// Settings: RESEND_API_KEY + EMAIL_FROM (shared with send-email), APP_URL / PLATFORM_DOMAIN (links), and for real texts
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (optional SMS_DEFAULT_COUNTRY_CODE, default +61). Push is not sent here (see NOTES.md).
import { adminClient, must, userClient, type Db } from '../_shared/db.ts';
import { sendViaResend, studioLink } from '../_shared/email.ts';
import { env, HttpError, json, readJson, requireCronSecret, serve } from '../_shared/http.ts';
import { automationBlocks, buildSms, renderEmail, type EmailBrand, type RenderBlock } from './render.ts';

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;
interface Job {
  id: string; channel: 'email' | 'sms' | 'push'; source: string; to: string; subject: string | null; payload: Any; kind: 'marketing' | 'service';
  firstName: string; lastName: string;
  campaign: { name: string; subject: string; preheader: string; blocks: RenderBlock[]; body: string } | null;
  automation: { key: string; subject: string; heading: string; body: string; buttonLabel: string } | null;
  studio: { name: string; slug: string; email: string; address: string; branding: Any; customDomains: string[] | null };
  settings: { fromName: string; replyTo: string; smsSender: string; footerNote: string };
}

// ---------------------------------------------------------------- the studio's look

const HEX = /^#[0-9a-f]{3,8}$/i;
const DEFAULTS = { primary: '#2F3B4C', ink: '#1A212C', accent: '#7C8FA8', soft: '#EEF0F3', highlight: '#F3EBDD', bg: '#F7F7F4' };
const absolute = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
const fontName = (f: unknown) => (typeof f === 'string' ? f.replace(/[^\w \-]/g, '').trim() : '');

export function brandFor(studio: Job['studio']): EmailBrand {
  const c = (studio.branding?.colors ?? {}) as Record<string, unknown>;
  const pick = (k: keyof typeof DEFAULTS) => (typeof c[k] === 'string' && HEX.test(c[k] as string) ? (c[k] as string) : DEFAULTS[k]);
  const fonts = (studio.branding?.fonts ?? {}) as Record<string, unknown>;
  const logoUrl = absolute(studio.branding?.logo?.imageUrl) || absolute(studio.branding?.iconUrl);
  return {
    name: studio.name, primary: pick('primary'), ink: pick('ink'), accent: pick('accent'), soft: pick('soft'), highlight: pick('highlight'), bg: pick('bg'),
    displayFont: fontName(fonts.display), bodyFont: fontName(fonts.body), ...(logoUrl ? { logoUrl } : {}),
  };
}

/** The studio's client app: its own domain first, then <slug>.<PLATFORM_DOMAIN> or APP_URL?studio=<slug>. */
export function appLink(studio: Job['studio']): string {
  const own = (studio.customDomains ?? []).find((d) => /^[a-z0-9.-]+$/i.test(d));
  return own ? `https://${own}/` : studioLink(studio.slug, 'client') ?? Deno.env.get('APP_URL') ?? '';
}

const fnUrl = () => `${env('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/marketing-send`;

// ---------------------------------------------------------------- one message

/** Email: the studio's template, tracking links and (marketing only) an unsubscribe link. Returns what Resend needs plus the links to remember. */
export function buildEmail(job: Job, vars: Record<string, string>) {
  const blocks = job.campaign ? job.campaign.blocks ?? [] : automationBlocks(job.automation ?? { heading: '', body: '', buttonLabel: '' });
  const marketing = job.kind === 'marketing';
  const links: (string | null)[] = [];
  const hook = `${fnUrl()}?m=${job.id}`;
  const out = renderEmail({
    subject: job.subject ?? job.campaign?.subject ?? job.automation?.subject ?? '', preheader: job.campaign?.preheader, blocks, brand: brandFor(job.studio), vars,
    address: job.studio.address, footerNote: job.settings.footerNote, baseUrl: vars.app_url,
    ...(marketing ? { unsubscribeUrl: `${hook}&k=u`, reason: `You’re getting this because you said yes to news and offers from ${job.studio.name}.` } : {}),
    trackLink: (url, i) => { links[i] = url; return `${hook}&k=c&l=${i}`; }, openPixelUrl: `${hook}&k=o`,
  });
  return { ...out, links: Array.from(links, (l) => l ?? null) };
}

function e164(to: string): string {
  const t = to.replace(/[^\d+]/g, '');
  if (t.startsWith('+')) return t;
  if (t.startsWith('00')) return `+${t.slice(2)}`;
  return `${(Deno.env.get('SMS_DEFAULT_COUNTRY_CODE') ?? '+61').trim()}${t.replace(/^0/, '')}`;
}

/** Twilio when it is configured, otherwise a stub that only logs (so the queue still drains in a new studio). Returns the provider id. */
async function sendSms(to: string, body: string, from: string): Promise<string> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID'), token = Deno.env.get('TWILIO_AUTH_TOKEN'), sender = from || Deno.env.get('TWILIO_FROM') || '';
  if (!sid || !token || !sender) { console.log('sms (stub, Twilio not configured)', e164(to), body.length, 'chars'); return 'stub-sms'; }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: e164(to), From: sender, Body: body }).toString(),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return String(((await res.json()) as Any).sid ?? 'twilio');
}

function varsFor(job: Job): Record<string, string> {
  return { ...(job.payload ?? {}), first_name: job.firstName, last_name: job.lastName, studio_name: job.studio.name, app_url: appLink(job.studio) } as Record<string, string>;
}

async function deliver(job: Job): Promise<{ providerId?: string; links?: (string | null)[] }> {
  if (!job.to) throw new Error(job.channel === 'sms' ? 'No mobile number' : 'No email address');
  const vars = varsFor(job);
  if (job.channel === 'sms') {
    const body = buildSms(job.campaign?.body ?? job.automation?.body ?? '', vars, { marketing: job.kind === 'marketing' });
    return { providerId: await sendSms(job.to, body, job.settings.smsSender) };
  }
  const m = buildEmail(job, vars);
  const subject = (job.subject ?? '').trim() || job.campaign?.subject || job.automation?.subject || job.studio.name;
  await sendViaResend(job.to, { subject, html: m.html, text: m.text }, { fromName: job.settings.fromName || job.studio.name, replyTo: job.settings.replyTo || job.studio.email || undefined });
  return { links: m.links };
}

// ---------------------------------------------------------------- the queue

export async function drain(admin: Db, limit = 50): Promise<{ sent: number; failed: number }> {
  const jobs = (must(await admin.rpc('marketing_claim', { p_channels: ['email', 'sms'], p_limit: limit })) ?? []) as Job[];
  let sent = 0, failed = 0;
  for (const job of jobs) {
    try {
      const r = await deliver(job);
      must(await admin.rpc('marketing_finish', { p_id: job.id, p_error: null, p_provider_id: r.providerId ?? null, p_links: r.links ?? null }));
      sent++;
    } catch (e) {
      failed++;
      console.error('marketing send failed', job.id, e);
      must(await admin.rpc('marketing_finish', { p_id: job.id, p_error: e instanceof Error ? e.message.slice(0, 500) : String(e), p_provider_id: null, p_links: null }));
    }
  }
  return { sent, failed };
}

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
    return json(await drain(admin));
  }
  requireCronSecret(req);
  const tick = body.tick === false ? null : must(await admin.rpc('marketing_tick'));
  return json({ tick, ...(await drain(admin, Number(body.limit) || 50)) });
});
