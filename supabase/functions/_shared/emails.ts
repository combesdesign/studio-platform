/**
 * The client-facing emails (class, receipt, gift card, appointment and event emails): their default wording, the merge tags a studio can use when it edits them, and the
 * renderer. Pure (no Deno, no DOM) so the same code runs in the demo, in the Settings > Emails preview and in the edge
 * functions. supabase/functions/_shared/emails.ts is a byte-for-byte copy (tests/libby-feedback-2.test.ts checks it):
 * edit this file, then `cp src/domain/emails.ts supabase/functions/_shared/emails.ts`.
 *
 * What a studio can change per email: on/off, the subject and the intro paragraph. The heading, class or session box, booking
 * note, receipt lines, gift card code and cancellation policy stay as they are. Defaults are the wording the app has always sent.
 */

// deno-lint-ignore no-explicit-any
export type EmailPayload = Record<string, any>;
export interface RenderedEmail { subject: string; html: string; text: string }

export type EmailKind =
  | 'booking_confirmed' | 'waitlist_joined' | 'waitlist_promoted' | 'booking_cancelled' | 'class_cancelled' | 'class_reminder' | 'welcome'
  | 'receipt' | 'gift_card'
  | 'appointment_confirmed' | 'appointment_cancelled' | 'appointment_moved' | 'appointment_reminder'
  | 'event_registered' | 'event_cancelled' | 'event_reminder' | 'waitlist_offer'
  | 'message_reply';

export interface EmailOverride { enabled?: boolean; subject?: string | null; intro?: string | null }

export interface EmailDef {
  kind: EmailKind;
  /** Heading in the Settings > Emails list. */
  group: 'Classes' | 'Payments' | 'Appointments' | 'Events' | 'Messages';
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
  { tag: 'session_name', label: 'Session or event name', example: 'Private Reformer' },
  { tag: 'session_time', label: 'Session day and time', example: '10:00am Wed 29 Oct' },
  { tag: 'what', label: 'Session, workshop, course or event', example: 'session' },
  { tag: 'location', label: 'Room or location', example: 'Studio A' },
  { tag: 'amount', label: 'Amount paid', example: '$120.00' },
  { tag: 'paid_note', label: 'Payment note (blank if free)', example: ' You paid $120.00.' },
  { tag: 'previous_time', label: 'The old time (when moved)', example: '9:00am Wed 29 Oct' },
  { tag: 'claim_by', label: 'Held until (waitlist offer)', example: '8:00pm Mon 27 Oct' },
  { tag: 'cancel_lead', label: 'Who cancelled, in a sentence', example: 'Your session has been cancelled.' },
  { tag: 'cancel_note', label: 'What happens to the credit or payment', example: ' Your credit is back on your pack.' },
  { tag: 'total', label: 'Total paid', example: '$115.00' },
  { tag: 'receipt_number', label: 'Receipt number', example: 'A1B2C3D4' },
  { tag: 'recipient_name', label: 'Gift card recipient', example: 'Maya' },
  { tag: 'from_name', label: 'Who sent the gift card', example: 'Hank' },
  { tag: 'gift_amount', label: 'Gift card value', example: '$100.00' },
];

export const EMAIL_DEFS: EmailDef[] = [
  {
    kind: 'booking_confirmed', group: 'Classes', label: 'Booking confirmed', when: 'Right after a client books a class.', heading: 'You’re booked in',
    subject: 'You\'re booked: {class_name}, {class_time}', intro: 'See you on the mat.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'waitlist_joined', group: 'Classes', label: 'You’re on the waitlist', when: 'When a client joins the waitlist for a full class.', heading: 'You’re on the waitlist',
    subject: 'You\'re on the waitlist: {class_name}, {class_time}',
    intro: 'You’re on the waitlist for this class. If a spot opens up, we’ll book you in and email you straight away.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'waitlist_promoted', group: 'Classes', label: 'Waitlist spot opened, you’re in', when: 'When a spot opens and the client is booked in from the waitlist.', heading: 'You’re off the waitlist',
    subject: 'A spot opened up: {class_name}, {class_time}',
    intro: 'Good news, a spot opened up and we’ve booked you in. A credit has been used from your pass.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'booking_cancelled', group: 'Classes', label: 'Booking cancelled', when: 'When a client cancels their own booking (late cancels get their own wording).', heading: 'Booking cancelled',
    subject: 'Booking cancelled: {class_name}, {class_time}', intro: 'Your booking has been cancelled.{credit_note}',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor', 'credit_note'], cta: 'Open the app',
  },
  {
    kind: 'class_cancelled', group: 'Classes', label: 'Class cancelled by the studio', when: 'When the studio cancels a class that clients were booked into.', heading: 'Class cancelled',
    subject: 'Class cancelled: {class_name}, {class_time}', intro: 'Sorry, we’ve had to cancel this class{reason}. Any credit you used is back on your pass.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'instructor', 'reason'], cta: 'Open the app',
  },
  {
    kind: 'class_reminder', group: 'Classes', label: 'Class reminder', when: 'A set time before each class.', heading: 'See you soon',
    subject: 'See you soon: {class_name} at {class_clock}', intro: 'Just a reminder about your class today.',
    tags: ['first_name', 'studio_name', 'class_name', 'class_time', 'class_clock', 'instructor'], cta: 'Open the app',
  },
  {
    kind: 'welcome', group: 'Classes', label: 'Welcome to the studio', when: 'The first time someone signs up. Skipped when the Welcome automation in Marketing is on and they said yes to news and offers (that email covers it).', heading: 'Welcome',
    subject: 'Welcome to {studio_name}',
    intro: 'We’re so glad you’re here. Your first class is easy: open the app, pick a time and book.\n\nNot sure where to start? Send us a message and we’ll point you to the right class.',
    tags: ['first_name', 'studio_name'], cta: 'Book your first class',
  },
  {
    kind: 'receipt', group: 'Payments', label: 'Receipt', when: 'After a client pays for a pass, a class or something from the shop.', heading: 'Thanks for your purchase',
    subject: 'Your receipt from {studio_name}', intro: 'Here’s your receipt.',
    tags: ['first_name', 'studio_name', 'total', 'receipt_number'], cta: 'Open the app',
  },
  {
    kind: 'gift_card', group: 'Payments', label: 'Gift card (to the recipient)', when: 'When a gift card is sent to the person receiving it.', heading: 'You’ve been given a gift card',
    subject: '{from_name} sent you a {studio_name} gift card', intro: '{from_name} has sent you a gift card for {studio_name}.',
    tags: ['recipient_name', 'from_name', 'studio_name', 'gift_amount'], cta: 'Open the app',
  },
  {
    kind: 'appointment_confirmed', group: 'Appointments', label: 'Appointment confirmed', when: 'Right after a private or duet session is booked.', heading: 'You’re booked in',
    subject: 'You\'re booked: {session_name}, {session_time}', intro: 'Your {what} is confirmed.{paid_note}',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what', 'amount', 'paid_note'], cta: 'Open the app',
  },
  {
    kind: 'appointment_cancelled', group: 'Appointments', label: 'Appointment cancelled', when: 'When an appointment is cancelled, by the client or by the studio.', heading: 'Cancelled',
    subject: 'Cancelled: {session_name}, {session_time}', intro: '{cancel_lead}{cancel_note}',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what', 'cancel_lead', 'cancel_note'], cta: 'Open the app',
  },
  {
    kind: 'appointment_moved', group: 'Appointments', label: 'Appointment moved', when: 'When an appointment is moved to another time, by the client or by staff.', heading: 'Your session has moved',
    subject: 'Moved: {session_name}, {session_time}', intro: 'Your {what} has been moved to a new time. Nothing else changes: it’s still paid for.',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'previous_time', 'instructor', 'location', 'what'], cta: 'Open the app',
  },
  {
    kind: 'appointment_reminder', group: 'Appointments', label: 'Appointment reminder', when: 'A set time before the appointment (Settings › Appointments).', heading: 'See you soon',
    subject: 'See you soon: {session_name}, {session_time}', intro: 'Just a reminder about your {what}.',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what'], cta: 'Open the app',
  },
  {
    kind: 'event_registered', group: 'Events', label: 'Event registered', when: 'Right after someone signs up for a workshop, course or event.', heading: 'You’re in',
    subject: 'You\'re booked: {session_name}, {session_time}', intro: 'Your {what} is confirmed.{paid_note}',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what', 'amount', 'paid_note'], cta: 'Open the app',
  },
  {
    kind: 'event_cancelled', group: 'Events', label: 'Event cancelled', when: 'When a registration is cancelled, or the studio cancels the event.', heading: 'Cancelled',
    subject: 'Cancelled: {session_name}, {session_time}', intro: '{cancel_lead}{cancel_note}',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what', 'cancel_lead', 'cancel_note'], cta: 'Open the app',
  },
  {
    kind: 'event_reminder', group: 'Events', label: 'Event reminder', when: 'A set time before the event (Settings › Appointments).', heading: 'See you soon',
    subject: 'See you soon: {session_name}, {session_time}', intro: 'Just a reminder about your {what}.',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what'], cta: 'Open the app',
  },
  {
    kind: 'waitlist_offer', group: 'Events', label: 'Event waitlist: a place opened', when: 'When a place opens in a full event and it is held for the next person in line.', heading: 'A place has opened up',
    subject: 'A place opened up: {session_name}', intro: 'Good news, a place has opened up in the {what} you were waiting for.',
    tags: ['first_name', 'studio_name', 'session_name', 'session_time', 'instructor', 'location', 'what', 'claim_by', 'amount'], cta: 'Open the app',
  },
  {
    kind: 'message_reply', group: 'Messages', label: 'We replied to your message', when: 'When the studio replies to a client in Messages and the client doesn’t have notifications on. At most one every 15 minutes per conversation. Also switched by Settings › Marketing.', heading: 'You have a reply',
    subject: '{studio_name} replied to your message', intro: '{studio_name} has replied to your message. Open Messages in the app to read it and write back.',
    tags: ['first_name', 'studio_name'], cta: 'Open Messages',
  },
];

export const emailDef = (k: string): EmailDef | undefined => EMAIL_DEFS.find((d) => d.kind === k);
export const isEmailKind = (k: string): k is EmailKind => EMAIL_DEFS.some((d) => d.kind === k);

/** A made-up booking, appointment, event, sale or gift card for the preview and "Send me a test". */
export function samplePayload(studioName: string, kind?: string): EmailPayload {
  const isEvent = typeof kind === 'string' && (kind.startsWith('event_') || kind === 'waitlist_offer');
  return {
    first_name: 'Hannah', studio_name: studioName, class_name: 'Mat Essentials', when: '6:00am Tue 28 Oct', instructor: 'Julia',
    cancel_reason: 'our instructor is unwell', credit_returned: true, late: false,
    cancellation_policy: 'Cancel at least 3 hours before class to keep your credit.',
    // appointments and events
    title: isEvent ? 'Reformer Basics Workshop' : 'Private Reformer', staff: 'Julia', location: 'Studio A', event_kind: 'workshop', sessions: 1, people: 1,
    amount_cents: 12000, previous_when: '9:00am Tue 28 Oct', claim_by: '8:00pm Mon 27 Oct',
    // receipt
    items: [{ qty: 1, name: '4 class pack', unit_cents: 10500 }], total_cents: 10500, gst_cents: 955, sale_id: 'a1b2c3d4-0000-0000-0000-000000000000',
    // gift card
    recipient_name: 'Maya', from_name: 'Hank', code: 'GIFT-7K3Q-9XPM', message: 'Happy birthday! Go and stretch.',
    // message_reply
    preview: 'Yes, bring her along. The 9am Saturday class has spots open.',
  };
}

// ---------------------------------------------------------------- merge tags

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Money in the studio's own currency and locale (falls back to AUD if either is unusable). */
export function money(cents: number, p: EmailPayload = {}): string {
  const amount = (Number.isFinite(cents) ? cents : 0) / 100;
  try {
    return new Intl.NumberFormat(String(p.locale ?? 'en-AU'), { style: 'currency', currency: String(p.currency ?? 'AUD') }).format(amount);
  } catch {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount);
  }
}

/** What an event or session is called in a sentence. */
const whatIs = (p: EmailPayload, isEvent: boolean) => (isEvent ? (p.event_kind === 'course' ? 'course' : p.event_kind === 'workshop' ? 'workshop' : 'event') : 'session');
const isEventKind = (kind: string) => kind.startsWith('event_') || kind === 'waitlist_offer';

/** The values for every tag, from an email's payload. */
export function emailVars(p: EmailPayload, kind = ''): Record<string, string> {
  const when = String(p.when ?? '');
  const creditNote = p.late ? ' It was inside the cancellation window, so the credit isn’t returned.' : p.credit_returned ? ' Your credit is back on your pass.' : '';
  const event = isEventKind(kind);
  const what = whatIs(p, event);
  const cents = Number(p.amount_cents ?? 0);
  const byStudio = Boolean(p.cancelled_by_studio);
  const cancelLead = byStudio ? `We’re sorry, we’ve had to cancel this ${what}${p.reason ? ` (${p.reason})` : ''}.` : `Your ${what} has been cancelled.`;
  const cancelNote = byStudio ? (p.refund_due ? ' We’ll refund what you paid.' : '')
    : p.late ? ' It was inside the cancellation window, so the credit or payment isn’t returned.'
    : p.credit_returned ? ' Your credit is back on your pack.'
    : p.refund_due ? ' We’ll refund what you paid.' : '';
  return {
    first_name: String(p.first_name ?? ''), studio_name: String(p.studio_name ?? ''), class_name: String(p.class_name ?? ''),
    class_time: when, class_clock: when.split(' ')[0] ?? '', instructor: String(p.instructor ?? p.staff ?? ''),
    reason: p.cancel_reason ? ` (${p.cancel_reason})` : '', credit_note: creditNote,
    session_name: String(p.title ?? p.class_name ?? ''), session_time: when, what, location: String(p.location ?? ''),
    amount: cents > 0 ? money(cents, p) : '', paid_note: cents > 0 ? ` You paid ${money(cents, p)}.` : '',
    previous_time: String(p.previous_when ?? ''), claim_by: String(p.claim_by ?? ''), cancel_lead: cancelLead, cancel_note: cancelNote,
    total: money(Number(p.total_cents ?? 0), p), receipt_number: String(p.sale_id ?? '').slice(0, 8),
    recipient_name: String(p.recipient_name ?? ''), from_name: String(p.from_name ?? '') || 'Someone', gift_amount: money(Number(p.amount_cents ?? 0), p),
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
  return mergeEmailText(raw, emailVars(p, kind)).trim();
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
 * Render one of the editable client emails (classes, receipts, gift cards, appointments, events). Returns null for any other
 * kind. `defaultUrl` is where the button goes if the payload has no cta_url. The studio's saved wording comes in as `ov` (or
 * payload.email_overrides[kind]). The fixed parts (class or session box, notes, policies, the code on a gift card) are added by
 * the app around the studio's subject and intro.
 */
export function renderEmail(kind: string, p: EmailPayload, ov?: EmailOverride | null, defaultUrl = ''): RenderedEmail | null {
  if (!isEmailKind(kind)) return null;
  const def = emailDef(kind)!;
  const o = ov ?? (p.email_overrides as Record<string, EmailOverride> | undefined)?.[kind];
  const subject = emailText(kind, 'subject', p, o) || emailText(kind, 'subject', p, null);
  const intro = emailText(kind, 'intro', p, o);
  const who = kind === 'gift_card' ? p.recipient_name : p.first_name;
  const hi = who ? `Hi ${esc(who)},` : 'Hi,';
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
    case 'message_reply': {
      const snippet = String(p.preview ?? '').trim();
      body = `<p>${hi}</p>${paragraphs(intro)}${snippet ? `<blockquote style="margin:12px 0;padding:8px 14px;border-left:3px solid ${theme(p).primary};color:#4b5563">${esc(snippet)}</blockquote>` : ''}`;
      text = `${hiText}\n\n${intro}${snippet ? `\n\n“${snippet}”` : ''}`;
      break;
    }
    case 'welcome':
      title = `Welcome to ${studioName(p)}`;
      body = `<p>${hi}</p>${paragraphs(intro)}`;
      text = `${hiText}\n\n${intro}`;
      break;
    case 'receipt': {
      const items = (Array.isArray(p.items) ? p.items : []) as EmailPayload[];
      const rows = items.map((i) => `<tr><td style="padding:4px 0">${esc(i.qty)} × ${esc(i.name)}</td><td align="right">${money(Number(i.qty) * Number(i.unit_cents), p)}</td></tr>`).join('');
      const gst = Number(p.gst_cents ?? 0);
      const taxName = String(p.tax_name ?? 'tax');
      const taxId = p.abn || p.tax_id;
      const taxLabel = String(p.tax_id_label ?? 'Tax ID');
      body = `<p>${hi}</p>${paragraphs(intro)}
<table width="100%" style="font-size:14px;border-collapse:collapse">${rows}
<tr><td style="border-top:1px solid #e5e7eb;padding-top:8px"><strong>Total</strong></td><td align="right" style="border-top:1px solid #e5e7eb;padding-top:8px"><strong>${money(Number(p.total_cents), p)}</strong></td></tr></table>
${gst ? `<p style="font-size:13px">Total includes ${esc(taxName)} of ${money(gst, p)}</p>` : ''}
<p style="font-size:12px;color:#6b7280">${esc(studioName(p))}${taxId ? ` · ${esc(taxLabel)} ${esc(taxId)}` : ''}<br>Receipt ${esc(String(p.sale_id ?? '').slice(0, 8))}</p>`;
      text = `${hiText}\n\n${intro}\n\n${items.map((i) => `${i.qty} x ${i.name}  ${money(Number(i.qty) * Number(i.unit_cents), p)}`).join('\n')}\nTotal ${money(Number(p.total_cents), p)}${gst ? `\nTotal includes ${taxName} of ${money(gst, p)}` : ''}\n${studioName(p)}${taxId ? ` ${taxLabel} ${taxId}` : ''}`;
      break;
    }
    case 'gift_card': {
      // To the person receiving the card (not necessarily a client yet): the code is the point, so no button unless the payload has one.
      const t = theme(p);
      const amount = money(Number(p.amount_cents ?? 0), p);
      const expires = p.expires_at ? new Date(String(p.expires_at)).toLocaleDateString(String(p.locale ?? 'en-AU'), { day: 'numeric', month: 'long', year: 'numeric', timeZone: String(p.timezone ?? 'UTC') }) : '';
      const msg = p.message ? `<div style="border-left:3px solid ${t.primary};padding:4px 0 4px 14px;margin:14px 0;font-style:italic">${esc(p.message).replace(/\n/g, '<br>')}</div>` : '';
      body = `<p>${hi}</p>${paragraphs(intro)}${msg}
<div style="background:${t.soft};border-radius:12px;padding:18px 16px;margin:14px 0;text-align:center">
<div style="font-size:13px">Gift card value</div>
<div style="font-family:Georgia,serif;font-size:32px;line-height:1.2">${amount}</div>
<div style="font-size:13px;margin-top:10px">Your code</div>
<div style="font-family:Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px"><strong>${esc(p.code)}</strong></div></div>
<p style="font-size:13px">Use it online or show this code at the front desk to book classes or pick up something from the shop.${expires ? ` Valid until ${esc(expires)}.` : ''}</p>`;
      text = `${hiText}\n\n${intro}\n\n${p.message ? `"${p.message}"\n\n` : ''}Value: ${amount}\nCode: ${p.code}\n\nUse it online or show the code at the front desk.${expires ? ` Valid until ${expires}.` : ''}`;
      break;
    }
    default: { // appointments, workshops, courses and events
      const event = isEventKind(kind);
      const v = emailVars(p, kind);
      const count = Number(p.sessions ?? 1);
      const withStaff = p.staff ? ` with ${esc(p.staff)}` : '';
      const people = Number(p.people ?? 1) > 1 ? ` · ${esc(p.people)} people` : '';
      const where = p.location ? `<br>${esc(p.location)}` : '';
      const more = event && count > 1 ? `<br>${count} sessions, starting ${esc(p.when)}` : '';
      const sessionTitle = String(p.title ?? (event ? 'your event' : 'your session'));
      const box = `<div style="background:${theme(p).soft};border-radius:12px;padding:14px 16px;margin:12px 0"><strong>${esc(sessionTitle)}</strong><br>${esc(p.when)}${withStaff}${people}${where}${more}</div>`;
      const boxText = `${sessionTitle}\n${p.when}${p.staff ? ` with ${p.staff}` : ''}${p.location ? `\n${p.location}` : ''}${event && count > 1 ? `\n${count} sessions, starting ${p.when}` : ''}`;
      const yourNote = p.note ? `<p style="font-size:13px">Your note: ${esc(p.note)}</p>` : '';
      const txt = (extra = '') => `${hiText}\n\n${intro}${extra}\n\n${boxText}${policyText}`;
      const lead = `<p>${hi}</p>${paragraphs(intro)}`;
      switch (kind) {
        case 'appointment_confirmed':
        case 'event_registered':
          title = def.heading;
          body = `${lead}${box}${yourNote}${policy}`;
          text = txt();
          break;
        case 'appointment_moved': {
          const was = p.previous_when ? `${p.previous_when}${p.previous_staff && p.previous_staff !== p.staff ? ` with ${p.previous_staff}` : ''}` : '';
          body = `${lead}${box}${was ? `<p style="font-size:13px;color:#4b5563">It was ${esc(was)}.</p>` : ''}${yourNote}${policy}`;
          text = txt(was ? ` It was ${was}.` : '');
          break;
        }
        case 'waitlist_offer': {
          const paid = Number(p.amount_cents ?? 0) > 0;
          const how = paid ? `To take it, open the app and pay ${v.amount} before then.` : 'To take it, open the app and save your spot before then.';
          const until = `It’s held for you until ${p.claim_by}. After that it goes to the next person in line.`;
          body = `${lead}${box}<p>${esc(until)}</p><p>${esc(how)}</p>${policy}`;
          text = txt(`\n\n${until} ${how}`);
          break;
        }
        case 'appointment_reminder':
        case 'event_reminder':
          body = `${lead}${box}${yourNote}<p style="font-size:13px;color:#4b5563">Can’t make it? Please cancel in the app as early as you can.</p>${policy}`;
          text = txt("\n\nCan't make it? Please cancel in the app as early as you can.");
          break;
        default: // appointment_cancelled, event_cancelled
          body = `${lead}${box}`;
          text = txt();
      }
    }
  }
  return { subject, html: layout(title, body, withCta, defaultUrl), text };
}

/** Kept for older callers: the same renderer. */
export const renderClassEmail = renderEmail;
