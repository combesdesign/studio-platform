/**
 * The client-facing class emails: their default wording, the merge tags a studio can use when it edits them, and the
 * renderer. Pure (no Deno, no DOM) so the same code runs in the demo, in the Settings > Emails preview and in the edge
 * functions. supabase/functions/_shared/emails.ts is a byte-for-byte copy (tests/libby-feedback-2.test.ts checks it):
 * edit this file, then `cp src/domain/emails.ts supabase/functions/_shared/emails.ts`.
 *
 * What a studio can change per email: on/off, the subject and the intro paragraph. The heading, class box, booking
 * note and cancellation policy stay as they are. Defaults are the wording the app has always sent.
 */

// deno-lint-ignore no-explicit-any
export type EmailPayload = Record<string, any>;
export interface RenderedEmail { subject: string; html: string; text: string }

export type EmailKind =
  | 'booking_confirmed' | 'waitlist_joined' | 'waitlist_promoted' | 'booking_cancelled' | 'class_cancelled' | 'class_reminder' | 'welcome';

export interface EmailOverride { enabled?: boolean; subject?: string | null; intro?: string | null }

export interface EmailDef {
  kind: EmailKind;
  label: string;
  /** When it goes out, in plain English. */
  when: string;
  /** Big title inside the email. Not editable. */
  heading: string;
  subject: string;
  intro: string;
  /** Tags that mean something in this email (the common ones always work). */
  tags: string[];
  /** The button under the email. */
  cta: string;
}

export const EMAIL_TAGS: { tag: string; label: string; example: string }[] = [
  { tag: 'first_name', label: 'First name', example: 'Hannah' },
  { tag: 'studio_name', label: 'Studio name', example: 'Snowy Pilates Club' },
  { tag: 'class_name', label: 'Class name', example: 'Mat Essentials' },
  { tag: 'class_time', label: 'Class day and time', example: '6:00am Tue 28 Oct' },
  { tag: 'class_clock', label: 'Class start time', example: '6:00am' },
  { tag: 'instructor', label: 'Instructor', example: 'Julia' },
  { tag: 'reason', label: 'Reason (if you gave one)', example: ' (our instructor is unwell)' },
  { tag: 'credit_note', label: 'What happens to the credit', example: ' Your credit is back on your pass.' },
];

export const EMAIL_DEFS: EmailDef[] = [
  {
    kind: 'booking_confirmed', label: 'Booking confirmed', when: 'Right after a client books a class.', heading: 'You’re booked in',
    subject: 'You\'re booked: {class_name}, {class_time}', intro: 'See you on the mat.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'waitlist_joined', label: 'You’re on the waitlist', when: 'When a client joins the waitlist for a full class.', heading: 'You’re on the waitlist',
    subject: 'You\'re on the waitlist: {class_name}, {class_time}',
    intro: 'You’re on the waitlist for this class. If a spot opens up, we’ll book you in and email you straight away.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'waitlist_promoted', label: 'Waitlist spot opened, you’re in', when: 'When a spot opens and the client is booked in from the waitlist.', heading: 'You’re off the waitlist',
    subject: 'A spot opened up: {class_name}, {class_time}',
    intro: 'Good news, a spot opened up and we’ve booked you in. A credit has been used from your pass.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'booking_cancelled', label: 'Booking cancelled', when: 'When a client cancels their own booking (late cancels get their own wording).', heading: 'Booking cancelled',
    subject: 'Booking cancelled: {class_name}, {class_time}', intro: 'Your booking has been cancelled.{credit_note}',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor', 'credit_note'], cta: 'Open the app',
  },
  {
    kind: 'class_cancelled', label: 'Class cancelled by the studio', when: 'When the studio cancels a class that clients were booked into.', heading: 'Class cancelled',
    subject: 'Class cancelled: {class_name}, {class_time}', intro: 'Sorry, we’ve had to cancel this class{reason}. Any credit you used is back on your pass.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor', 'reason'], cta: 'Open the app',
  },
  {
    kind: 'class_reminder', label: 'Class reminder', when: 'A set time before each class.', heading: 'See you soon',
    subject: 'See you soon: {class_name} at {class_clock}', intro: 'Just a reminder about your class today.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'class_clock', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'welcome', label: 'Welcome to the studio', when: 'The first time someone signs up. Skipped when the Welcome automation in Marketing is on and they said yes to news and offers (that email covers it).', heading: 'Welcome',
    subject: 'Welcome to {studio_name}',
    intro: 'We’re so glad you’re here. Your first class is easy: open the app, pick a time and book.\n\nNot sure where to start? Send us a message and we’ll point you to the right class.',
    tags: ['first_name', 'studio_name'], cta: 'Book your first class',
  },
];

export const emailDef = (k: string): EmailDef | undefined => EMAIL_DEFS.find((d) => d.kind === k);
export const isEmailKind = (k: string): k is EmailKind => EMAIL_DEFS.some((d) => d.kind === k);

/** A made-up booking for the preview and "Send me a test". */
export function samplePayload(studioName: string): EmailPayload {
  return {
    first_name: 'Hannah', studio_name: studioName, class_name: 'Mat Essentials', when: '6:00am Tue 28 Oct', instructor: 'Julia',
    cancel_reason: 'our instructor is unwell', credit_returned: true, late: false,
    cancellation_policy: 'Cancel at least 3 hours before class to keep your credit.',
  };
}

// ---------------------------------------------------------------- merge tags

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** The values for every tag, from an email's payload. */
export function emailVars(p: EmailPayload): Record<string, string> {
  const when = String(p.when ?? '');
  const creditNote = p.late ? ' It was inside the cancellation window, so the credit isn’t returned.' : p.credit_returned ? ' Your credit is back on your pass.' : '';
  return {
    first_name: String(p.first_name ?? ''), studio_name: String(p.studio_name ?? ''), class_name: String(p.class_name ?? ''),
    class_time: when, class_clock: when.split(' ')[0] ?? '', instructor: String(p.instructor ?? ''),
    reason: p.cancel_reason ? ` (${p.cancel_reason})` : '', credit_note: creditNote,
  };
}

/** {first_name} and {{first_name}} both work; an unknown tag disappears. */
export function mergeEmailText(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}|\{\s*([a-z_]+)\s*\}/gi, (_m, a: string | undefined, b: string | undefined) => vars[(a ?? b ?? '').toLowerCase()] ?? '');
}

/** The studio's wording if it changed it, else the default. Always merged. */
export function emailText(kind: EmailKind, field: 'subject' | 'intro', p: EmailPayload, ov?: EmailOverride | null): string {
  const def = emailDef(kind)!;
  const custom = ov?.[field];
  const raw = typeof custom === 'string' && custom.trim() ? custom : def[field];
  return mergeEmailText(raw, emailVars(p)).trim();
}

// ---------------------------------------------------------------- layout

const PLATFORM_NAME = 'Studio Platform';
const DEFAULT_THEME = { primary: '#2F3B4C', ink: '#1A212C', soft: '#EEF0F3', bg: '#F7F7F4' };
const HEX = /^#[0-9a-f]{3,8}$/i;
export function theme(p: EmailPayload): typeof DEFAULT_THEME {
  const b = (p.brand ?? {}) as Record<string, unknown>;
  const pick = (k: keyof typeof DEFAULT_THEME) => (typeof b[k] === 'string' && HEX.test(b[k] as string) ? (b[k] as string) : DEFAULT_THEME[k]);
  return { primary: pick('primary'), ink: pick('ink'), soft: pick('soft'), bg: pick('bg') };
}
export const escapeHtml = esc;
const studioName = (p: EmailPayload) => String(p.studio_name ?? PLATFORM_NAME);
const absoluteUrl = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

/** The shell every email shares. `defaultUrl` is the button's link when the payload doesn't name one (cta_url null = no button). */
export function layout(title: string, bodyHtml: string, payload: EmailPayload, defaultUrl = ''): string {
  const { primary: NAVY, ink: INK, bg: BG } = theme(payload);
  const appUrl = payload.cta_url === null ? '' : String(payload.cta_url ?? defaultUrl ?? '');
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

export function classBox(p: EmailPayload): string {
  return `<div style="background:${theme(p).soft};border-radius:12px;padding:14px 16px;margin:12px 0">
<strong>${esc(p.class_name)}</strong><br>${esc(p.when)}${p.instructor ? ` with ${esc(p.instructor)}` : ''}</div>`;
}

const paragraphs = (text: string) => text.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).map((t) => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`).join('');

/**
 * Render one of the editable class emails. Returns null for any other kind. `defaultUrl` is where the button goes if the
 * payload has no cta_url. The studio's saved wording comes in as `ov` (or payload.email_overrides[kind]).
 */
export function renderClassEmail(kind: string, p: EmailPayload, ov?: EmailOverride | null, defaultUrl = ''): RenderedEmail | null {
  if (!isEmailKind(kind)) return null;
  const def = emailDef(kind)!;
  const o = ov ?? (p.email_overrides as Record<string, EmailOverride> | undefined)?.[kind];
  const subject = emailText(kind, 'subject', p, o) || emailText(kind, 'subject', p, null);
  const intro = emailText(kind, 'intro', p, o);
  const hi = p.first_name ? `Hi ${esc(p.first_name)},` : 'Hi,';
  const policy = p.cancellation_policy ? `<p style="font-size:13px;color:#4b5563"><strong>Cancellation policy:</strong> ${esc(p.cancellation_policy)}</p>` : '';
  const waitPolicy = p.waitlist_policy ? `<p style="font-size:13px;color:#4b5563"><strong>How the waitlist works:</strong> ${esc(p.waitlist_policy)}</p>` : '';
  const note = p.booking_note ? `<p style="font-size:13px">${esc(p.booking_note)}</p>` : '';
  const policyText = p.cancellation_policy ? `\n\nCancellation policy: ${p.cancellation_policy}` : '';
  const withCta = { ...p, cta_label: p.cta_label ?? def.cta };
  const textBox = `${p.class_name}, ${p.when}${p.instructor ? ` with ${p.instructor}` : ''}`;
  const hiText = hi.replace(/<[^>]*>/g, '').replace(/&#39;/g, '\'');
  let body: string;
  let text: string;
  let title = def.heading;
  switch (kind) {
    case 'booking_confirmed':
      body = `<p>${hi}</p>${paragraphs(intro)}${classBox(p)}${note}${policy}`;
      text = `${hiText}\n\n${intro}\n\n${textBox}${p.booking_note ? `\n\n${p.booking_note}` : ''}${policyText}`;
      break;
    case 'waitlist_joined':
      body = `<p>${hi}</p>${paragraphs(intro)}${classBox(p)}${waitPolicy}${policy}`;
      text = `${hiText}\n\n${intro}\n\n${textBox}${p.waitlist_policy ? `\n\nHow the waitlist works: ${p.waitlist_policy}` : ''}${policyText}`;
      break;
    case 'waitlist_promoted':
      body = `<p>${hi}</p>${paragraphs(intro)}${classBox(p)}${note}${policy}`;
      text = `${hiText}\n\n${intro}\n\n${textBox}${policyText}`;
      break;
    case 'booking_cancelled':
      body = `<p>${hi}</p>${paragraphs(intro)}${classBox(p)}<p>Jump into the app any time to book another class.</p>`;
      text = `${hiText}\n\n${intro}\n\n${textBox}`;
      break;
    case 'class_cancelled':
      body = `<p>${hi}</p>${paragraphs(intro)}${classBox(p)}<p>Jump into the app to book another time.</p>`;
      text = `${hiText}\n\n${intro}\n\n${textBox}`;
      break;
    case 'class_reminder':
      body = `<p>${hi}</p>${paragraphs(intro)}${classBox(p)}${note}<p style="font-size:13px;color:#4b5563">Can’t make it? Please cancel in the app so someone on the waitlist can take your spot.</p>${policy}`;
      text = `${hiText}\n\n${intro}\n\n${textBox}\n\nCan't make it? Please cancel in the app so someone else can take your spot.${policyText}`;
      break;
    default: // welcome
      title = `Welcome to ${studioName(p)}`;
      body = `<p>${hi}</p>${paragraphs(intro)}`;
      text = `${hiText}\n\n${intro}`;
  }
  return { subject, html: layout(title, body, withCta, defaultUrl), text };
}
