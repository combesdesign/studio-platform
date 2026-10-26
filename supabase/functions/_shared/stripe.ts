// Tiny Stripe REST client (no SDK): form-encoded requests, pinned API version, webhook signatures.
import { env, HttpError } from './http.ts';

/** Pinned so responses we fetch have a known shape (webhook payloads use the endpoint's version). */
export const STRIPE_VERSION = '2024-06-20';

type Params = Record<string, unknown>;

/** Stripe's nested form encoding: a[b][0][c]=x */
export function formEncode(params: Params, prefix = '', out: URLSearchParams = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') formEncode(item as Params, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') {
      formEncode(v as Params, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export type StripeObject = Record<string, any>;

/** `account` = a connected account id (acct_...): the call is made on that account (Stripe-Account header, a direct charge). Omit for the platform's own account. */
export async function stripe(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, idempotencyKey?: string, account?: string): Promise<StripeObject> {
  const key = env('STRIPE_SECRET_KEY');
  const body = formEncode(params);
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && [...body].length ? `?${body}` : ''}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION };
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (account) headers['Stripe-Account'] = account;
  const res = await fetch(url, { method, headers, body: method === 'POST' ? body.toString() : undefined });
  const data = (await res.json().catch(() => ({}))) as StripeObject;
  if (!res.ok) {
    console.error('Stripe error', res.status, data?.error);
    throw new HttpError(502, 'PAYMENT_ERROR', data?.error?.message ?? 'The payment provider had a problem. Please try again.');
  }
  return data;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Stripe-Signature header: "t=1712345678,v1=abc...,v1=def...".
 * Signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret (whsec_...).
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v) t = v;
    if (k === 'v1' && v) sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
  return sigs.some((s) => constantTimeEqual(s, expected));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** unix seconds -> ISO */
export const fromUnix = (s: number | null | undefined): string | null => (s ? new Date(s * 1000).toISOString() : null);

/** Midnight (start of day) in Sydney for a 'YYYY-MM-DD', as unix seconds. Handles AEST/AEDT. */
export function sydneyMidnightUnix(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0);
  const off = (at: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(at)).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    return asUtc - at;
  };
  let t = guess - off(guess);
  const o2 = off(t);
  if (guess - o2 !== t) t = guess - o2;
  return Math.floor(t / 1000);
}

/** Today's date in Sydney, 'YYYY-MM-DD'. */
export function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
