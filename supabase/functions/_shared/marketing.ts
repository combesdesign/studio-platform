// Marketing sender shared by the existing drains: send-email (flush) and send-reminders call drainMarketing() as part of
// drainFeatureOutboxes, so campaigns and automations leave through the same scheduled drain as every other email.
// Each message goes out as its own studio (name, colours, fonts, logo, address, reply-to, footer note). Marketing emails carry
// an unsubscribe link; texts are a stub until Twilio is configured. The marketing-send function is only the tracking endpoint,
// the "send now" kick and test sends.
import type { Db } from './db.ts';
import { must } from './db.ts';
import { sendViaResend, studioLink } from './email.ts';
import { env } from './http.ts';
import { sendWebPush, vapidFromEnv } from './webpush.ts';
import { escapeHtml, layout, renderEmail as renderClientEmail, type EmailOverride } from './emails.ts';
import { automationBlocks, buildSms, mergeTags, renderEmail, type EmailBrand, type RenderBlock } from './marketing-render.ts';

export { renderEmail, buildSms, mergeTags };
export type { RenderBlock };

// deno-lint-ignore no-explicit-any
export type Any = Record<string, any>;
export interface Job {
  id: string; channel: 'email' | 'sms' | 'push'; source: string; to: string; subject: string | null; payload: Any; kind: 'marketing' | 'service';
  firstName: string; lastName: string; clientId?: string;
  /** push only: the devices to send to (marketing_job_json) */
  devices?: { id: string; platform: 'web' | 'ios' | 'android'; token: string; keys: { p256dh?: string; auth?: string } | null }[];
  campaign: { name: string; subject: string; preheader: string; blocks: RenderBlock[]; body: string } | null;
  automation: { key: string; subject: string; heading: string; body: string; buttonLabel: string } | null;
  studio: { name: string; slug: string; email: string; address: string; branding: Any; customDomains: string[] | null };
  settings: { fromName: string; replyTo: string; smsSender: string; footerNote: string; inboxAccess?: string; emailStudio?: boolean; emailClient?: boolean };
  /** inbox emails only: the studio's own wording for the client email (Settings > Emails) */
  emailOverrides?: Record<string, EmailOverride>;
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

export const fnUrl = () => `${env('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/marketing-send`;

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
export async function sendSms(to: string, body: string, from: string): Promise<string> {
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

export function varsFor(job: Job): Record<string, string> {
  return { ...(job.payload ?? {}), first_name: job.firstName, last_name: job.lastName, studio_name: job.studio.name, app_url: appLink(job.studio) } as Record<string, string>;
}

// ---------------------------------------------------------------- inbox emails

/**
 * The two emails around the inbox. To the studio: "<Client> sent you a message", a snippet and a link to that thread (not editable).
 * To the client: the studio's editable 'message_reply' email (Settings > Emails), with a link to Messages. Both are service
 * messages, so no unsubscribe link; the queue has already applied the 15-minute batching and the switches.
 */
export function buildInboxEmail(job: Job): { subject: string; html: string; text: string } {
  const preview = String(job.payload?.preview ?? '').trim();
  const b = brandFor(job.studio);
  const base: Any = {
    studio_name: job.studio.name, address: job.studio.address, brand: { primary: b.primary, ink: b.ink, soft: b.soft, bg: b.bg },
    ...(b.logoUrl ? { logo_url: b.logoUrl } : {}), first_name: job.firstName, preview,
  };
  if (job.payload?.audience === 'staff') {
    const who = `${job.firstName} ${job.lastName}`.trim() || 'A client';
    const root = (studioLink(job.studio.slug, 'studio') ?? Deno.env.get('APP_URL') ?? '').replace(/#.*$/, '');
    const url = root ? `${root}#/marketing/inbox/${job.clientId ?? ''}` : '';
    const quote = preview ? `<blockquote style="margin:12px 0;padding:8px 14px;border-left:3px solid ${b.primary};color:#4b5563">${escapeHtml(preview)}</blockquote>` : '';
    return {
      subject: `${who} sent you a message`,
      html: layout('New message', `<p><strong>${escapeHtml(who)}</strong> sent you a message in Messages.</p>${quote}`, { ...base, cta_url: url || null, cta_label: 'Open the inbox' }),
      text: `${who} sent you a message.${preview ? `\n\n“${preview}”` : ''}${url ? `\n\nOpen the inbox: ${url}` : ''}`,
    };
  }
  const root = appLink(job.studio).replace(/#.*$/, '');
  const out = renderClientEmail('message_reply', { ...base, cta_url: root ? `${root}#/messages` : null }, job.emailOverrides?.message_reply);
  if (!out) throw new Error('message_reply email missing');
  return out;
}

// ---------------------------------------------------------------- push

/** Web push is on when VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are all set. Until then push rows simply wait in the queue. */
export const vapid = () => vapidFromEnv((k) => Deno.env.get(k));

/** What the notification says. Client replies open #/messages in the client app; staff alerts open that client's thread in the studio app. */
export function pushPayload(job: Job): { title: string; body: string; url: string; tag: string } {
  const toStaff = job.payload?.audience === 'staff';
  const preview = String(job.payload?.preview ?? '').slice(0, 120);
  if (toStaff) {
    const who = `${job.firstName} ${job.lastName}`.trim() || 'A client';
    const base = studioLink(job.studio.slug, 'studio') ?? Deno.env.get('APP_URL') ?? '';
    return { title: `${who} sent a message`, body: preview, url: `${base.replace(/#.*$/, '')}#/marketing/inbox/${job.clientId ?? ''}`, tag: `thread-${job.payload?.threadId ?? job.clientId ?? 'x'}` };
  }
  return { title: job.studio.name, body: preview || 'You have a new message', url: `${appLink(job.studio).replace(/#.*$/, '')}#/messages`, tag: `thread-${job.payload?.threadId ?? 'x'}` };
}

/** Send one queued push to each of the person's web devices; drop devices the push service says are gone (404 / 410). */
async function deliverPush(admin: Db, job: Job): Promise<{ providerId?: string; links?: (string | null)[] }> {
  const keys = vapid();
  if (!keys) throw new Error('Web push is not configured');
  const devices = (job.devices ?? []).filter((d) => d.platform === 'web');
  if (!devices.length) return { providerId: job.devices?.length ? 'no-web-devices' : 'no-devices' }; // native sending (APNs / FCM) isn't built
  const payload = pushPayload(job);
  let ok = 0, gone = 0;
  const errors: string[] = [];
  for (const d of devices) {
    const r = await sendWebPush({ endpoint: d.token, keys: d.keys }, payload, keys, { topic: payload.tag });
    if (r.ok) ok++;
    else if (r.expired) {
      gone++;
      must(await admin.from('marketing_push_devices').delete().eq('id', d.id));
    } else errors.push(r.error ?? 'failed');
  }
  if (!ok && errors.length) throw new Error(errors[0]); // every live device failed: retry later (up to 5 attempts)
  return { providerId: ok ? `webpush:${ok}` : gone ? 'expired' : 'no-devices' };
}

async function deliver(job: Job): Promise<{ providerId?: string; links?: (string | null)[] }> {
  if (!job.to) throw new Error(job.channel === 'sms' ? 'No mobile number' : 'No email address');
  const vars = varsFor(job);
  if (job.channel === 'sms') {
    // A one-off text from staff (source 'inbox') goes out exactly as written; campaigns and automations merge their tags and add the opt-out line.
    const body = job.source === 'inbox' ? String(job.payload?.body ?? '') : buildSms(job.campaign?.body ?? job.automation?.body ?? '', vars, { marketing: job.kind === 'marketing' });
    return { providerId: await sendSms(job.to, body, job.settings.smsSender) };
  }
  if (job.source === 'inbox') {
    await sendViaResend(job.to, buildInboxEmail(job), { fromName: job.settings.fromName || job.studio.name, replyTo: job.settings.replyTo || job.studio.email || undefined });
    return {};
  }
  const m = buildEmail(job, vars);
  const subject = mergeTags((job.subject ?? '').trim() || job.campaign?.subject || job.automation?.subject || '', vars).trim() || job.studio.name;
  await sendViaResend(job.to, { subject, html: m.html, text: m.text }, { fromName: job.settings.fromName || job.studio.name, replyTo: job.settings.replyTo || job.studio.email || undefined });
  return { links: m.links };
}

// ---------------------------------------------------------------- the queue

export async function drainMarketing(admin: Db, limit = 50): Promise<{ sent: number; failed: number }> {
  // Due scheduled campaigns and automations are queued first (idempotent: the sent log's unique key stops repeats).
  must(await admin.rpc('marketing_tick'));
  const jobs = (must(await admin.rpc('marketing_claim', { p_channels: vapid() ? ['email', 'sms', 'push'] : ['email', 'sms'], p_limit: limit, p_push_on: Boolean(vapid()) })) ?? []) as Job[];
  let sent = 0, failed = 0;
  for (const job of jobs) {
    try {
      const r = job.channel === 'push' ? await deliverPush(admin, job) : await deliver(job);
      must(await admin.rpc('marketing_finish', { p_id: job.id, p_error: null, p_provider_id: r.providerId ?? null, p_links: r.links ? { urls: r.links } : null }));
      sent++;
    } catch (e) {
      failed++;
      console.error('marketing send failed', job.id, e);
      must(await admin.rpc('marketing_finish', { p_id: job.id, p_error: e instanceof Error ? e.message.slice(0, 500) : String(e), p_provider_id: null, p_links: null }));
    }
  }
  return { sent, failed };
}

