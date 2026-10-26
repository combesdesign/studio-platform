// Email templates + Resend sender + outbox drain. Used by send-email and send-reminders.
import { type Db, must } from './db.ts';
import { env } from './http.ts';

// deno-lint-ignore no-explicit-any
type Payload = Record<string, any>;
export interface Notification { id: string; kind: string; to_email: string | null; payload: Payload; attempts: number; studio_id?: string | null }

// Every email is sent as its own studio (name, colours, logo, address, currency, timezone, policy text). These are only the
// neutral platform defaults for a studio with no branding yet (same values as PLATFORM_BRANDING in src/shared/branding.ts).
const PLATFORM_NAME = 'Studio Platform';
const DEFAULT_THEME = { primary: '#2F3B4C', ink: '#1A212C', soft: '#EEF0F3', bg: '#F7F7F4' };
const DEFAULT_CURRENCY = 'AUD';
const DEFAULT_LOCALE = 'en-AU';
const HEX = /^#[0-9a-f]{3,8}$/i;
function theme(p: Payload): typeof DEFAULT_THEME {
  const b = (p.brand ?? {}) as Record<string, unknown>;
  const pick = (k: keyof typeof DEFAULT_THEME) => (typeof b[k] === 'string' && HEX.test(b[k] as string) ? (b[k] as string) : DEFAULT_THEME[k]);
  return { primary: pick('primary'), ink: pick('ink'), soft: pick('soft'), bg: pick('bg') };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
/** Money in the studio's own currency and locale (falls back to the platform default if either is unusable). */
function money(cents: number, p: Payload = {}): string {
  const amount = (Number.isFinite(cents) ? cents : 0) / 100;
  try {
    return new Intl.NumberFormat(String(p.locale ?? DEFAULT_LOCALE), { style: 'currency', currency: String(p.currency ?? DEFAULT_CURRENCY) }).format(amount);
  } catch {
    return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: DEFAULT_CURRENCY }).format(amount);
  }
}
const studioName = (p: Payload) => String(p.studio_name ?? PLATFORM_NAME);
const absoluteUrl = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

function layout(title: string, bodyHtml: string, payload: Payload): string {
  const { primary: NAVY, ink: INK, bg: BG } = theme(payload);
  const appUrl = payload.cta_url === null ? '' : String(payload.cta_url ?? Deno.env.get('APP_URL') ?? '');
  const ctaLabel = String(payload.cta_label ?? 'Open the app');
  const studio = esc(studioName(payload));
  const logo = absoluteUrl(payload.logo_url);
  const header = logo ? `<img src="${esc(logo)}" alt="${studio}" height="36" style="display:block;border:0;height:36px;width:auto">` : studio;
  return `<!doctype html><html><body style="margin:0;background:${BG};font-family:Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;padding:28px">
<tr><td style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${NAVY}">${header}</td></tr>
<tr><td style="padding-top:12px;font-family:Georgia,serif;font-size:26px;line-height:1.2;color:${INK}">${esc(title)}</td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
${appUrl ? `<tr><td style="padding-top:20px"><a href="${esc(appUrl)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px">${esc(ctaLabel)}</a></td></tr>` : ''}
${payload.address ? `<tr><td style="padding-top:24px;font-size:12px;color:#6b7280">${esc(payload.address)}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
}

const policyText = (p: Payload) => (p.cancellation_policy ? `\n\nCancellation policy: ${p.cancellation_policy}` : '');

function classBox(p: Payload): string {
  return `<div style="background:${theme(p).soft};border-radius:12px;padding:14px 16px;margin:12px 0">
<strong>${esc(p.class_name)}</strong><br>${esc(p.when)}${p.instructor ? ` with ${esc(p.instructor)}` : ''}</div>`;
}

export function render(n: Notification): { subject: string; html: string; text: string } {
  const p = n.payload ?? {};
  const hi = p.first_name ? `Hi ${esc(p.first_name)},` : 'Hi,';
  const policy = p.cancellation_policy ? `<p style="font-size:13px;color:#4b5563"><strong>Cancellation policy:</strong> ${esc(p.cancellation_policy)}</p>` : '';
  const note = p.booking_note ? `<p style="font-size:13px">${esc(p.booking_note)}</p>` : '';
  switch (n.kind) {
    case 'booking_confirmed':
      return {
        subject: `You're booked: ${p.class_name}, ${p.when}`,
        html: layout('You’re booked in', `<p>${hi}</p><p>See you on the mat.</p>${classBox(p)}${note}${policy}`, p),
        text: `${hi}\n\nYou're booked into ${p.class_name}, ${p.when}${p.instructor ? ` with ${p.instructor}` : ''}.${p.booking_note ? `\n\n${p.booking_note}` : ''}${policyText(p)}`,
      };
    case 'waitlist_promoted':
      return {
        subject: `A spot opened up: ${p.class_name}, ${p.when}`,
        html: layout('You’re off the waitlist', `<p>${hi}</p><p>Good news, a spot opened up and we’ve booked you in. A credit has been used from your pass.</p>${classBox(p)}${note}${policy}`, p),
        text: `${hi}\n\nA spot opened up and you're now booked into ${p.class_name}, ${p.when}. A credit has been used from your pass.${policyText(p)}`,
      };
    case 'class_cancelled':
      return {
        subject: `Class cancelled: ${p.class_name}, ${p.when}`,
        html: layout('Class cancelled', `<p>${hi}</p><p>Sorry, we’ve had to cancel this class${p.cancel_reason ? ` (${esc(p.cancel_reason)})` : ''}. Any credit you used is back on your pass.</p>${classBox(p)}<p>Jump into the app to book another time.</p>`, p),
        text: `${hi}\n\nSorry, we've had to cancel ${p.class_name}, ${p.when}${p.cancel_reason ? ` (${p.cancel_reason})` : ''}. Any credit you used is back on your pass.`,
      };
    case 'class_reminder':
      return {
        subject: `See you soon: ${p.class_name} at ${String(p.when ?? '').split(' ')[0]}`,
        html: layout('See you soon', `<p>${hi}</p><p>Just a reminder about your class today.</p>${classBox(p)}${note}<p style="font-size:13px;color:#4b5563">Can’t make it? Please cancel in the app so someone on the waitlist can take your spot.</p>${policy}`, p),
        text: `${hi}\n\nReminder: ${p.class_name}, ${p.when}. Can't make it? Please cancel in the app so someone else can take your spot.${policyText(p)}`,
      };
    case 'receipt': {
      const items = (Array.isArray(p.items) ? p.items : []) as Payload[];
      const rows = items.map((i) => `<tr><td style="padding:4px 0">${esc(i.qty)} × ${esc(i.name)}</td><td align="right">${money(Number(i.qty) * Number(i.unit_cents), p)}</td></tr>`).join('');
      const gst = Number(p.gst_cents ?? 0);
      const taxName = String(p.tax_name ?? 'tax');
      const taxId = p.abn || p.tax_id;
      const taxLabel = String(p.tax_id_label ?? 'Tax ID');
      return {
        subject: `Your receipt from ${studioName(p)}`,
        html: layout('Thanks for your purchase', `<p>${hi}</p>
<table width="100%" style="font-size:14px;border-collapse:collapse">${rows}
<tr><td style="border-top:1px solid #e5e7eb;padding-top:8px"><strong>Total</strong></td><td align="right" style="border-top:1px solid #e5e7eb;padding-top:8px"><strong>${money(Number(p.total_cents), p)}</strong></td></tr></table>
${gst ? `<p style="font-size:13px">Total includes ${esc(taxName)} of ${money(gst, p)}</p>` : ''}
<p style="font-size:12px;color:#6b7280">${esc(studioName(p))}${taxId ? ` · ${esc(taxLabel)} ${esc(taxId)}` : ''}<br>Receipt ${esc(String(p.sale_id ?? '').slice(0, 8))}</p>`, p),
        text: `${hi}\n\n${items.map((i) => `${i.qty} x ${i.name}  ${money(Number(i.qty) * Number(i.unit_cents), p)}`).join('\n')}\nTotal ${money(Number(p.total_cents), p)}${gst ? `\nTotal includes ${taxName} of ${money(gst, p)}` : ''}\n${studioName(p)}${taxId ? ` ${taxLabel} ${taxId}` : ''}`,
      };
    }
    case 'gift_card': {
      // To the person receiving the card. Everything (name, colours, address) comes from the studio, never hard-coded.
      const studio = String(p.studio_name ?? 'the studio');
      const amount = money(Number(p.amount_cents ?? 0), p);
      const who = p.recipient_name ? `Hi ${esc(p.recipient_name)},` : 'Hi,';
      const from = p.from_name ? String(p.from_name) : '';
      const t = theme(p);
      const expires = p.expires_at ? new Date(String(p.expires_at)).toLocaleDateString(String(p.locale ?? DEFAULT_LOCALE), { day: 'numeric', month: 'long', year: 'numeric', timeZone: String(p.timezone ?? 'UTC') }) : '';
      const msg = p.message ? `<div style="border-left:3px solid ${t.primary};padding:4px 0 4px 14px;margin:14px 0;font-style:italic">${esc(p.message).replace(/\n/g, '<br>')}</div>` : '';
      return {
        subject: from ? `${from} sent you a ${studio} gift card` : `You've been sent a ${studio} gift card`,
        html: layout('You’ve been given a gift card', `<p>${who}</p>
<p>${from ? `${esc(from)} has sent you` : 'You’ve been sent'} a gift card for <strong>${esc(studio)}</strong>.</p>${msg}
<div style="background:${t.soft};border-radius:12px;padding:18px 16px;margin:14px 0;text-align:center">
<div style="font-size:13px">Gift card value</div>
<div style="font-family:Georgia,serif;font-size:32px;line-height:1.2">${amount}</div>
<div style="font-size:13px;margin-top:10px">Your code</div>
<div style="font-family:Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px"><strong>${esc(p.code)}</strong></div></div>
<p style="font-size:13px">Use it online or show this code at the front desk to book classes or pick up something from the shop.${expires ? ` Valid until ${esc(expires)}.` : ''}</p>`,
          p),
        text: `${who.replace(/<[^>]*>/g, '')}\n\n${from ? `${from} has sent you` : "You've been sent"} a gift card for ${studio}.\n\n${p.message ? `"${p.message}"\n\n` : ''}Value: ${amount}\nCode: ${p.code}\n\nUse it online or show the code at the front desk.${expires ? ` Valid until ${expires}.` : ''}`,
      };
    }
    case 'cover_requested':
    case 'cover_claimed':
    case 'cover_approved':
    case 'cover_declined': {
      const cls = `${p.class_name}, ${p.when}`;
      const reason = p.reason ? ` Reason: ${esc(p.reason)}` : '';
      const note = p.note ? `<p style="font-size:13px">Note: ${esc(p.note)}</p>` : '';
      const box = `<div style="background:${theme(p).soft};border-radius:12px;padding:14px 16px;margin:12px 0"><strong>${esc(p.class_name)}</strong><br>${esc(p.when)}</div>`;
      const m = {
        cover_requested: { subject: `Cover needed: ${cls}`, title: 'Can you cover a class?',
          body: `<p>${esc(p.requested_by)} is looking for someone to cover this class.${reason}</p>${box}<p>Open the app to claim it if you can take it.</p>`,
          text: `${p.requested_by} is looking for someone to cover ${cls}.${p.reason ? ` Reason: ${p.reason}` : ''} Open the app to claim it if you can take it.` },
        cover_claimed: { subject: `Cover claimed: ${cls}`, title: 'A cover request needs approving',
          body: `<p>${esc(p.claimed_by)} has offered to cover ${esc(p.requested_by)}’s class.</p>${box}<p>Open the app to approve or decline.</p>`,
          text: `${p.claimed_by} has offered to cover ${p.requested_by}'s class, ${cls}. Open the app to approve or decline.` },
        cover_approved: { subject: `Cover approved: ${cls}`, title: 'Cover sorted',
          body: `<p>${esc(p.claimed_by)} is now teaching this class (covering ${esc(p.requested_by)}).</p>${box}${note}`,
          text: `${p.claimed_by} is now teaching ${cls} (covering ${p.requested_by}).` },
        cover_declined: { subject: `Cover not approved: ${cls}`, title: 'Cover not approved',
          body: `<p>Your offer to cover ${esc(p.requested_by)}’s class wasn’t approved, so it’s open to others again.</p>${box}${note}`,
          text: `Your offer to cover ${p.requested_by}'s class, ${cls}, wasn't approved.` },
      }[n.kind]!;
      return { subject: m.subject, html: layout(m.title, `<p>${p.to_name ? `Hi ${esc(p.to_name)},` : 'Hi,'}</p>${m.body}`, p), text: m.text };
    }
    default:
      return { subject: `A message from ${studioName(p)}`, html: layout('Hello', `<p>${hi}</p>`, p), text: hi };
  }
}

/** The studio's own sender name on our one sending address (EMAIL_FROM): "Harbour Reformer Co. <hello@…>". */
function fromFor(fromName?: string): string {
  const base = env('EMAIL_FROM');
  const addr = /<([^>]+)>/.exec(base)?.[1] ?? base;
  return `${(fromName || PLATFORM_NAME).replace(/[<>"]/g, '')} <${addr}>`;
}

export async function sendViaResend(to: string, msg: { subject: string; html: string; text: string }, opts: { fromName?: string; replyTo?: string } = {}): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromFor(opts.fromName),
      to: [to], subject: msg.subject, html: msg.html, text: msg.text,
      reply_to: opts.replyTo || Deno.env.get('EMAIL_REPLY_TO') || undefined, // the studio's email; the platform setting only if the studio has none
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Claim pending outbox rows (optionally one id) and send them. Returns counts. */
export async function drainOutbox(admin: Db, opts: { id?: string; limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  const main = await drainNotifications(admin, opts);
  if (opts.id) return main; // one instant email (database webhook): the sweep handles the feature outboxes
  const more = await drainFeatureOutboxes(admin, opts.limit);
  return { sent: main.sent + more.sent, failed: main.failed + more.failed };
}

async function drainNotifications(admin: Db, opts: { id?: string; limit?: number }): Promise<{ sent: number; failed: number }> {
  const rows = must(await admin.rpc('claim_notifications', { p_limit: opts.limit ?? 25, p_id: opts.id ?? null })) as Notification[];
  let sent = 0, failed = 0;
  const cache = new Map<string, StudioInfo>();
  for (const n of rows ?? []) {
    try {
      if (!n.to_email) throw new Error('No email address');
      // Send as the notification's own studio: name, colours, logo, address, currency, timezone, tax labels and reply-to.
      const st = n.studio_id ? await loadStudio(admin, cache, n.studio_id) : null;
      const out = st ? { ...n, payload: { ...n.payload, ...studioPayload(st), cta_url: n.payload?.cta_url ?? studioLink(st.slug, 'client') } } : n;
      await sendViaResend(n.to_email, render(out), st ? { fromName: st.name, replyTo: st.email || undefined } : {});
      must(await admin.rpc('finish_notification', { p_id: n.id, p_error: null }));
      sent++;
    } catch (e) {
      failed++;
      console.error('email failed', n.id, e);
      must(await admin.rpc('finish_notification', { p_id: n.id, p_error: e instanceof Error ? e.message.slice(0, 500) : String(e) }));
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------------------------------------------
// Feature outboxes: commerce_outbox (gift card e-cards), payroll_outbox (cover request emails to staff) and
// support_alert_outbox (urgent support requests to the platform's own SUPPORT_ALERT_EMAIL).
// Each email is sent as the row's own studio: its name, colours, address and reply-to come from the studios row.
// ---------------------------------------------------------------------------------------------------------------
interface StudioInfo {
  slug: string; name: string; email: string; address: string; currency: string; locale: string; timezone: string; brand: Record<string, string>;
  logoUrl: string; taxId: string; taxIdLabel: string; taxName: string;
}
interface OutboxRow { id: string; kind: string; studio_id: string; to_email: string | null; payload: Payload; to_staff_id?: string }

/** Where a link into the studio's client app / studio app goes (subdomain when PLATFORM_DOMAIN is set, else APP_URL?studio=). */
export function studioLink(slug: string, app: 'client' | 'studio'): string | null {
  const domain = (Deno.env.get('PLATFORM_DOMAIN') ?? '').trim();
  const sub = app === 'studio' ? 'studio/' : '';
  if (domain) return `https://${slug}.${domain}/${sub}`;
  const base = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
  return base ? `${base}/${sub}?studio=${encodeURIComponent(slug)}` : null;
}

async function loadStudio(admin: Db, cache: Map<string, StudioInfo>, id: string): Promise<StudioInfo> {
  const hit = cache.get(id);
  if (hit) return hit;
  const r = must(await admin.from('studios').select('slug, name, email, address, currency, locale, timezone, branding, tax_id, tax_id_label, tax_name').eq('id', id).single());
  const c = (r.branding?.colors ?? {}) as Record<string, string>;
  const info: StudioInfo = {
    slug: r.slug, name: r.name, email: r.email ?? '', address: r.address ?? '', currency: r.currency, locale: r.locale, timezone: r.timezone,
    brand: { primary: c.primary, ink: c.ink, soft: c.soft, bg: c.bg },
    logoUrl: absoluteUrl(r.branding?.logoUrl) || absoluteUrl(r.branding?.iconUrl),
    taxId: r.tax_id ?? '', taxIdLabel: r.tax_id_label ?? '', taxName: r.tax_name ?? '',
  };
  cache.set(id, info);
  return info;
}

/** The studio's details as email payload fields (empty ones left out so they never blank a value the row already has). */
function studioPayload(st: StudioInfo): Payload {
  const o: Payload = {
    studio_name: st.name, address: st.address, brand: st.brand, currency: st.currency, locale: st.locale, timezone: st.timezone,
    logo_url: st.logoUrl, tax_id: st.taxId, tax_id_label: st.taxIdLabel, tax_name: st.taxName,
  };
  for (const k of Object.keys(o)) if (o[k] === '' || o[k] === undefined) delete o[k];
  return o;
}

async function drainOne(admin: Db, rows: OutboxRow[], finish: string, prep: (r: OutboxRow, st: StudioInfo) => Notification): Promise<{ sent: number; failed: number }> {
  const cache = new Map<string, StudioInfo>();
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      if (!r.to_email) throw new Error('No email address');
      const st = await loadStudio(admin, cache, r.studio_id);
      await sendViaResend(r.to_email, render(prep(r, st)), { fromName: st.name, replyTo: st.email || undefined });
      must(await admin.rpc(finish, { p_id: r.id, p_error: null }));
      sent++;
    } catch (e) {
      failed++;
      console.error('feature email failed', finish, r.id, e);
      must(await admin.rpc(finish, { p_id: r.id, p_error: e instanceof Error ? e.message.slice(0, 500) : String(e) }));
    }
  }
  return { sent, failed };
}

/** Queue gift cards whose send date has come, then send both feature outboxes. Safe to call every couple of minutes. */
export async function drainFeatureOutboxes(admin: Db, limit = 25): Promise<{ sent: number; failed: number }> {
  must(await admin.rpc('commerce_send_due'));
  const base = (_r: OutboxRow, st: StudioInfo) => studioPayload(st);

  const cards = (must(await admin.rpc('commerce_claim_outbox', { p_limit: limit })) ?? []) as OutboxRow[];
  const a = await drainOne(admin, cards, 'commerce_finish_outbox', (r, st) => ({
    id: r.id, kind: r.kind, to_email: r.to_email, attempts: 0,
    payload: { ...r.payload, ...base(r, st), cta_url: null }, // the recipient may not be a client yet: the code is the point
  }));

  const staffRows = (must(await admin.rpc('payroll_claim_outbox', { p_limit: limit })) ?? []) as OutboxRow[];
  const names = new Map<string, string>();
  if (staffRows.length) {
    for (const s of (must(await admin.from('staff').select('id, name').in('id', staffRows.map((r) => r.to_staff_id))) ?? []) as { id: string; name: string }[]) names.set(s.id, s.name);
  }
  const b = await drainOne(admin, staffRows, 'payroll_finish_outbox', (r, st) => ({
    id: r.id, kind: r.kind, to_email: r.to_email, attempts: 0,
    payload: { ...r.payload, ...base(r, st), to_name: String(names.get(r.to_staff_id ?? '') ?? '').split(' ')[0], cta_url: studioLink(st.slug, 'studio'), cta_label: 'Open the studio app' },
  }));
  const c = await drainSupportAlerts(admin, limit);
  return { sent: a.sent + b.sent + c.sent, failed: a.failed + b.failed + c.failed };
}

/** Where the platform admin inbox lives (subdomain setup: the platform domain; single studio: APP_URL). */
export function adminSupportLink(): string | null {
  const domain = (Deno.env.get('PLATFORM_DOMAIN') ?? '').trim();
  const base = domain ? `https://${domain}` : (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
  return base ? `${base}/admin/#/support` : null;
}

/**
 * Urgent support alerts (support_alert_outbox): one email to SUPPORT_ALERT_EMAIL and, if set, a JSON POST to
 * SUPPORT_ALERT_SMS_WEBHOOK (a hook for an SMS service later). With neither set the rows simply wait.
 * A failed email is retried (up to 5 times); a failed webhook is logged and not retried, so one dead URL can't resend the email.
 */
export async function drainSupportAlerts(admin: Db, limit = 25): Promise<{ sent: number; failed: number }> {
  const to = (Deno.env.get('SUPPORT_ALERT_EMAIL') ?? '').trim();
  const hook = (Deno.env.get('SUPPORT_ALERT_SMS_WEBHOOK') ?? '').trim();
  if (!to && !hook) return { sent: 0, failed: 0 };
  const rows = (must(await admin.rpc('support_alert_claim_outbox', { p_limit: limit })) ?? []) as { id: string; request_id: string; payload: Payload; created_at: string }[];
  const link = adminSupportLink();
  let sent = 0, failed = 0;
  for (const r of rows) {
    const p = r.payload ?? {};
    const who = `${p.person || 'Someone'}${p.role ? ` (${p.role})` : ''}`;
    try {
      if (to) {
        const subject = `URGENT: ${p.studio_name || 'A studio'} needs help now`;
        const html = layout('Urgent support request', `<p><strong>${esc(p.studio_name)}</strong> marked a request urgent.</p>
          <p><strong>Who:</strong> ${esc(who)}<br><strong>Page:</strong> ${esc(p.page || '(unknown)')}</p>
          <blockquote style="margin:12px 0;padding:8px 14px;border-left:3px solid #b42318;white-space:pre-wrap">${esc(p.message)}</blockquote>
          ${link ? `<p><a href="${esc(link)}">Open the admin inbox</a></p>` : ''}`, {});
        const text = `URGENT from ${p.studio_name}\n\nWho: ${who}\nPage: ${p.page || '(unknown)'}\n\n${p.message}\n${link ? `\nAdmin inbox: ${link}` : ''}`;
        await sendViaResend(to, { subject, html, text }, { fromName: 'Studio Platform support' });
      }
      if (hook) {
        try {
          const res = await fetch(hook, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'support_urgent', requestId: r.request_id, studio: p.studio_name, person: p.person, role: p.role, message: p.message, page: p.page, inboxUrl: link, createdAt: r.created_at }),
          });
          if (!res.ok) throw new Error(`webhook ${res.status}`);
        } catch (e) {
          if (!to) throw e; // the webhook is the only channel: let the row retry
          console.error('support alert webhook failed', r.id, e);
        }
      }
      must(await admin.rpc('support_alert_finish_outbox', { p_id: r.id, p_error: null }));
      sent++;
    } catch (e) {
      failed++;
      console.error('support alert failed', r.id, e);
      must(await admin.rpc('support_alert_finish_outbox', { p_id: r.id, p_error: e instanceof Error ? e.message.slice(0, 500) : String(e) }));
    }
  }
  return { sent, failed };
}
