// Stripe Terminal helpers shared by terminal-readers, terminal-pay and stripe-webhook.
// One card-present attempt = one PaymentIntent = one terminal_payments row (see 3100_terminal.sql).
// The sale is recorded by the terminal_record_sale RPC, which locks the row, so the status poll and the webhook can both
// call settleTerminal() and the sale still lands exactly once.
import { type Db, must, whoami } from './db.ts';
import { HttpError } from './http.ts';
import type { PayAs } from './connect.ts';
import { stripe, type StripeObject } from './stripe.ts';

export type TerminalState = 'pending' | 'succeeded' | 'declined' | 'canceled' | 'timeout' | 'failed' | 'paid_unrecorded';

/** What the app gets back (camel-cased fields; sale and passes are the database's JSON, mapped by the store). */
export interface TerminalOutcome { state: TerminalState; message?: string; amountCents?: number; sale?: unknown; passes?: unknown[] }

/** A reader that hasn't answered for this long is given up on (the app also stops waiting). */
export const TERMINAL_TIMEOUT_MS = 150_000;

export interface Staff { staffId: string; role: string; studioId: string; name: string }

/** The signed-in staff member and the studio they're acting in. */
export async function requireStaffStudio(admin: Db, user: Db): Promise<Staff> {
  const me = await whoami(user);
  if (me.kind !== 'staff' || !me.staff_id) throw new HttpError(403, 'NOT_ALLOWED', 'This is for studio staff.');
  const row = must(await admin.from('staff').select('studio_id').eq('id', me.staff_id).maybeSingle()) as { studio_id: string } | null;
  if (!row) throw new HttpError(403, 'NOT_ALLOWED', 'This is for studio staff.');
  return { staffId: me.staff_id, role: me.role ?? '', studioId: row.studio_id, name: me.name };
}

/** A reader of this studio, or a 404 (a reader that belongs to another studio looks like one that doesn't exist). */
export async function studioReader(admin: Db, studioId: string, readerId: string): Promise<{ reader_id: string; label: string }> {
  const row = must(await admin.from('terminal_readers').select('reader_id, label').eq('reader_id', readerId).eq('studio_id', studioId).maybeSingle());
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that card reader.');
  return row;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null);

interface PaymentRow { payment_intent_id: string; studio_id: string; reader_id: string; amount_cents: number; status: string; failure: string | null; result: StripeObject | null; created_at: string }

export const getPayment = async (admin: Db, pi: string): Promise<PaymentRow | null> =>
  must(await admin.from('terminal_payments').select('*').eq('payment_intent_id', pi).maybeSingle()) as PaymentRow | null;

function outcomeOf(row: PaymentRow, res?: StripeObject | null): TerminalOutcome {
  const result = res ?? row.result;
  if (result?.sale) return { state: 'succeeded', amountCents: row.amount_cents, sale: result.sale, passes: result.passes ?? [] };
  if (result?.unrecorded || row.status === 'paid_unrecorded') {
    return { state: 'paid_unrecorded', amountCents: row.amount_cents, message: 'The card was charged, but the sale couldn’t be recorded (something in the cart changed). Check Stripe before trying again.' };
  }
  if (row.status === 'declined') return { state: 'declined', message: row.failure || 'The card was declined.' };
  if (row.status === 'canceled') return { state: row.failure === 'timeout' ? 'timeout' : 'canceled', message: row.failure === 'timeout' ? 'The reader didn’t get a card in time.' : undefined };
  if (row.status === 'failed') return { state: 'failed', message: row.failure || 'The payment didn’t go through.' };
  return { state: 'pending' };
}

/** Record the sale if Stripe says the payment went through. Safe to call any number of times, from anywhere. */
export async function recordPaid(admin: Db, pi: string, paidCents?: number | null): Promise<TerminalOutcome | null> {
  const res = must(await admin.rpc('terminal_record_sale', { p_payment_intent: pi, p_paid_cents: paidCents ?? null })) as StripeObject | null;
  const row = await getPayment(admin, pi);
  if (!row) return null;
  return outcomeOf(row, res);
}

/** Look at the payment in Stripe and bring our row up to date (sale recorded, declined, or still waiting). */
export async function settleTerminal(admin: Db, pi: string, pay: PayAs): Promise<TerminalOutcome | null> {
  const row = await getPayment(admin, pi);
  if (!row) return null;
  if (row.status === 'succeeded' || row.status === 'paid_unrecorded') return outcomeOf(row);
  const intent = await stripe('GET', `payment_intents/${pi}`, {}, undefined, pay.account);
  if (intent.status === 'succeeded') return recordPaid(admin, pi, intent.amount_received ?? intent.amount);
  if (intent.status === 'canceled') { await admin.rpc('terminal_mark', { p_payment_intent: pi, p_status: 'canceled', p_failure: null }); }
  else if (intent.status === 'requires_payment_method' && intent.last_payment_error) {
    await admin.rpc('terminal_mark', { p_payment_intent: pi, p_status: 'declined', p_failure: intent.last_payment_error.message ?? 'The card was declined.' });
  }
  return outcomeOf((await getPayment(admin, pi)) ?? row);
}

/** Stop waiting: clear the reader, cancel the PaymentIntent, and mark the attempt. If the card got through in the meantime, the sale is recorded instead. */
export async function abandonTerminal(admin: Db, pi: string, pay: PayAs, why: 'canceled' | 'timeout'): Promise<TerminalOutcome | null> {
  const row = await getPayment(admin, pi);
  if (!row) return null;
  if (row.status === 'succeeded' || row.status === 'paid_unrecorded') return outcomeOf(row);
  try { await stripe('POST', `terminal/readers/${row.reader_id}/cancel_action`, {}, undefined, pay.account); } catch (e) { console.warn('cancel_action failed', e instanceof Error ? e.message : e); }
  try {
    const intent = await stripe('GET', `payment_intents/${pi}`, {}, undefined, pay.account);
    if (intent.status === 'succeeded') return recordPaid(admin, pi, intent.amount_received ?? intent.amount);
    if (intent.status !== 'canceled') await stripe('POST', `payment_intents/${pi}/cancel`, {}, undefined, pay.account);
  } catch (e) { console.warn('cancel PaymentIntent failed', e instanceof Error ? e.message : e); }
  await admin.rpc('terminal_mark', { p_payment_intent: pi, p_status: 'canceled', p_failure: why === 'timeout' ? 'timeout' : null });
  return outcomeOf((await getPayment(admin, pi)) ?? row);
}

/** The PaymentIntent id on a terminal.reader.action_* event's reader object. */
export const intentOfReader = (reader: StripeObject): string | null => idOf(reader?.action?.process_payment_intent?.payment_intent);
