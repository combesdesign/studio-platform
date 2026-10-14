// Email templates + Resend sender + outbox drain. Used by send-email and send-reminders.
import { type Db, must } from './db.ts';
import { env } from './http.ts';

// deno-lint-ignore no-explicit-any
type Payload = Record<string, any>;
export interface Notification { id: string; kind: string; to_email: string | null; payload: Payload; attempts: number }

const NAVY = '#5069AC', INK = '#24345F', MIST = '#EEF2F9', BG = '#FAF8F3';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function layout(title: string, bodyHtml: string, payload: Payload): string {
  const appUrl = Deno.env.get('APP_URL') ?? '';
  const studio = esc(payload.studio_name ?? 'Snowy Pilates Club');
  return `<!doctype html><html><body style="margin:0;background:${BG};font-family:Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;padding:28px">
<tr><td style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${NAVY}">${studio}</td></tr>
<tr><td style="padding-top:12px;font-family:Georgia,serif;font-size:26px;line-height:1.2;color:${INK}">${esc(title)}</td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
${appUrl ? `<tr><td style="padding-top:20px"><a href="${esc(appUrl)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px">Open the app</a></td></tr>` : ''}
<tr><td style="padding-top:24px;font-size:12px;color:#6b7280">${esc(payload.address ?? '57 Vale Street, Cooma NSW 2630')}</td></tr>
</table></td></tr></table></body></html>`;
}

function classBox(p: Payload): string {
  return `<div style="background:${MIST};border-radius:12px;padding:14px 16px;margin:12px 0">
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
        text: `${hi}\n\nYou're booked into ${p.class_name}, ${p.when}${p.instructor ? ` with ${p.instructor}` : ''}.\n\n${p.booking_note ?? ''}\n\nCancellation policy: ${p.cancellation_policy ?? ''}`,
      };
    case 'waitlist_promoted':
      return {
        subject: `A spot opened up: ${p.class_name}, ${p.when}`,
        html: layout('You’re off the waitlist', `<p>${hi}</p><p>Good news, a spot opened up and we’ve booked you in. A credit has been used from your pass.</p>${classBox(p)}${note}${policy}`, p),
        text: `${hi}\n\nA spot opened up and you're now booked into ${p.class_name}, ${p.when}. A credit has been used from your pass.\n\nCancellation policy: ${p.cancellation_policy ?? ''}`,
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
        text: `${hi}\n\nReminder: ${p.class_name}, ${p.when}. Can't make it? Please cancel in the app so someone else can take your spot.\n\nCancellation policy: ${p.cancellation_policy ?? ''}`,
      };
    case 'receipt': {
      const items = (Array.isArray(p.items) ? p.items : []) as Payload[];
      const rows = items.map((i) => `<tr><td style="padding:4px 0">${esc(i.qty)} × ${esc(i.name)}</td><td align="right">${money(Number(i.qty) * Number(i.unit_cents))}</td></tr>`).join('');
      const gst = Number(p.gst_cents ?? 0);
      return {
        subject: `Your receipt from ${p.studio_name ?? 'Snowy Pilates Club'}`,
        html: layout('Thanks for your purchase', `<p>${hi}</p>
<table width="100%" style="font-size:14px;border-collapse:collapse">${rows}
<tr><td style="border-top:1px solid #e5e7eb;padding-top:8px"><strong>Total</strong></td><td align="right" style="border-top:1px solid #e5e7eb;padding-top:8px"><strong>${money(Number(p.total_cents))}</strong></td></tr></table>
${gst ? `<p style="font-size:13px">Total includes GST of ${money(gst)}</p>` : ''}
<p style="font-size:12px;color:#6b7280">${esc(p.studio_name)}${p.abn ? ` · ABN ${esc(p.abn)}` : ''}<br>Receipt ${esc(String(p.sale_id ?? '').slice(0, 8))}</p>`, p),
        text: `${hi}\n\n${items.map((i) => `${i.qty} x ${i.name}  ${money(Number(i.qty) * Number(i.unit_cents))}`).join('\n')}\nTotal ${money(Number(p.total_cents))}${gst ? `\nTotal includes GST of ${money(gst)}` : ''}\n${p.studio_name ?? ''}${p.abn ? ` ABN ${p.abn}` : ''}`,
      };
    }
    default:
      return { subject: 'A message from Snowy Pilates Club', html: layout('Hello', `<p>${hi}</p>`, p), text: hi };
  }
}

export async function sendViaResend(to: string, msg: { subject: string; html: string; text: string }): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env('EMAIL_FROM', 'Snowy Pilates Club <hello@snowypilatesclub.com>'),
      to: [to], subject: msg.subject, html: msg.html, text: msg.text,
      reply_to: Deno.env.get('EMAIL_REPLY_TO') ?? 'admin@snowypilatesclub.com',
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Claim pending outbox rows (optionally one id) and send them. Returns counts. */
export async function drainOutbox(admin: Db, opts: { id?: string; limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  const rows = must(await admin.rpc('claim_notifications', { p_limit: opts.limit ?? 25, p_id: opts.id ?? null })) as Notification[];
  let sent = 0, failed = 0;
  for (const n of rows ?? []) {
    try {
      if (!n.to_email) throw new Error('No email address');
      await sendViaResend(n.to_email, render(n));
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
