// Email templates + Resend sender + outbox drain. Used by send-email and send-reminders.
import { type Db, must } from './db.ts';
import { drainMarketing } from './marketing.ts';
import { env } from './http.ts';
import { escapeHtml as esc, isEmailKind, layout as baseLayout, money, renderEmail, samplePayload, theme } from './emails.ts';

// deno-lint-ignore no-explicit-any
type Payload = Record<string, any>;
export interface Notification { id: string; kind: string; to_email: string | null; payload: Payload; attempts: number; studio_id?: string | null }

// Every email is sent as its own studio (name, colours, logo, address, currency, timezone, policy text). These are only the
// neutral platform defaults for a studio with no branding yet (same values as PLATFORM_BRANDING in src/shared/branding.ts).
const PLATFORM_NAME = 'Studio Platform';

const studioName = (p: Payload) => String(p.studio_name ?? PLATFORM_NAME);
const absoluteUrl = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

/** The shared shell (src/domain/emails.ts); the button goes to APP_URL unless the payload says otherwise. */
function layout(title: string, bodyHtml: string, payload: Payload): string {
  return baseLayout(title, bodyHtml, payload, Deno.env.get('APP_URL') ?? '');
}

/** Has the studio switched this email off (Settings > Emails)? A test email always goes. */
export function switchedOff(kind: string, p: Payload): boolean {
  if (p.is_test || !isEmailKind(kind)) return false;
  return (p.email_overrides as Record<string, { enabled?: boolean }> | undefined)?.[kind]?.enabled === false;
}

export function render(n: Notification): { subject: string; html: string; text: string } {
  const out = renderOne(n);
  return n.payload?.is_test ? { ...out, subject: `[Test] ${out.subject}` } : out;   // "Send me a test" in Settings > Emails
}

function renderOne(n: Notification): { subject: string; html: string; text: string } {
  // A test email carries only who it's for; the made-up booking, sale or gift card comes from the shared sample.
  const p: Payload = n.payload?.is_test ? { ...samplePayload(String(n.payload?.studio_name ?? PLATFORM_NAME), n.kind), ...n.payload } : (n.payload ?? {});
  const hi = p.first_name ? `Hi ${esc(p.first_name)},` : 'Hi,';
  // The editable client emails (classes, receipts, gift cards, appointments, events) live in emails.ts, with the studio's own wording.
  const clientEmail = renderEmail(n.kind, p, undefined, Deno.env.get('APP_URL') ?? '');
  if (clientEmail) return clientEmail;
  switch (n.kind) {
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
      if (switchedOff(n.kind, out.payload ?? {})) {   // the studio turned this email off after it was queued: close it without sending
        must(await admin.rpc('finish_notification', { p_id: n.id, p_error: null }));
        continue;
      }
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
// Feature outboxes: commerce_outbox (gift card e-cards), payroll_outbox (cover request emails to staff), marketing_messages
// (campaigns and automations: _shared/marketing.ts) and
// support_alert_outbox (urgent support requests to the platform's own SUPPORT_ALERT_EMAIL).
// Each email is sent as the row's own studio: its name, colours, address and reply-to come from the studios row.
// ---------------------------------------------------------------------------------------------------------------
interface StudioInfo {
  slug: string; name: string; email: string; address: string; currency: string; locale: string; timezone: string; brand: Record<string, string>;
  logoUrl: string; taxId: string; taxIdLabel: string; taxName: string;
  /** The studio's own wording for the class emails (Settings > Emails), by email kind. */
  emailOverrides: Record<string, { enabled: boolean; subject: string | null; intro: string | null }>;
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
    taxId: r.tax_id ?? '', taxIdLabel: r.tax_id_label ?? '', taxName: r.tax_name ?? '', emailOverrides: {},
  };
  const ov = (must(await admin.from('email_templates').select('kind, enabled, subject, intro').eq('studio_id', id)) ?? []) as { kind: string; enabled: boolean; subject: string | null; intro: string | null }[];
  for (const o of ov) info.emailOverrides[o.kind] = { enabled: o.enabled, subject: o.subject, intro: o.intro };
  cache.set(id, info);
  return info;
}

/** The studio's details as email payload fields (empty ones left out so they never blank a value the row already has). */
function studioPayload(st: StudioInfo): Payload {
  const o: Payload = {
    studio_name: st.name, address: st.address, brand: st.brand, currency: st.currency, locale: st.locale, timezone: st.timezone,
    logo_url: st.logoUrl, tax_id: st.taxId, tax_id_label: st.taxIdLabel, tax_name: st.taxName, email_overrides: st.emailOverrides,
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
      const msg = prep(r, st);
      if (switchedOff(msg.kind, msg.payload)) {   // switched off in Settings > Emails: close the row without sending
        must(await admin.rpc(finish, { p_id: r.id, p_error: null }));
        continue;
      }
      await sendViaResend(r.to_email, render(msg), { fromName: st.name, replyTo: st.email || undefined });
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
  must(await admin.rpc('appointments_queue_reminders'));   // each studio's own reminder lead time (Settings › Appointments)
  must(await admin.rpc('appointments_waitlist_sweep'));   // lapse waitlist offers by the clock and offer the place to the next person
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
  // Marketing: queue due scheduled campaigns and each studio's automations (once each, the sent log stops repeats), then send the queue.
  const d = await drainMarketing(admin, limit * 2);
  const apptRows = (must(await admin.rpc('appointments_claim_outbox', { p_limit: limit })) ?? []) as OutboxRow[];
  const e = await drainOne(admin, apptRows, 'appointments_finish_outbox', (r, st) => ({
    id: r.id, kind: r.kind, to_email: r.to_email, attempts: 0,
    payload: { ...r.payload, ...base(r, st), cta_url: studioLink(st.slug, 'client'), cta_label: 'Open the app' },
  }));
  return { sent: a.sent + b.sent + c.sent + d.sent + e.sent, failed: a.failed + b.failed + c.failed + d.failed + e.failed };
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
