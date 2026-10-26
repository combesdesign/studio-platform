// Stripe Connect per studio (docs/PLATFORM.md). Two modes:
//   single  - the default, and always for a STUDIO_SLUG build: one Stripe account on our own keys (Snowy today). Nothing here applies.
//   connect - STRIPE_CONNECT=1 on the multi-studio platform: each studio is paid into its own Standard connected account
//             (direct charges: every Stripe call for a studio carries Stripe-Account: acct_...). A studio that hasn't connected
//             yet can't take card payments; the client app tells people to pay at the studio.
import { type Db, must } from './db.ts';
import { HttpError } from './http.ts';

export const NOT_SET_UP_MESSAGE = 'Online payments aren’t set up yet, pay at the studio.';

/** Connect mode: STRIPE_CONNECT=1 and not a single-studio (STUDIO_SLUG) deployment. */
export function connectMode(): boolean {
  return Deno.env.get('STRIPE_CONNECT') === '1' && !(Deno.env.get('STUDIO_SLUG') ?? '').trim();
}

/** Optional platform fee in basis points (100 = 1%) from PLATFORM_FEE_BPS. The pitch is no fee, so the default is 0. */
export function platformFeeBps(): number {
  const n = Math.floor(Number(Deno.env.get('PLATFORM_FEE_BPS') ?? 0));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 0;
}

/** How to talk to Stripe for one studio. `account` is undefined in single mode. */
export interface PayAs { account?: string; feeBps: number }

/**
 * Single mode: {} (our own keys, no header). Connect mode: the studio's connected account, or a friendly 409 PAYMENTS_NOT_SET_UP
 * if the studio hasn't connected (or Stripe hasn't switched charges on yet).
 */
export async function payAs(admin: Db, studioId: string, notSetUp = NOT_SET_UP_MESSAGE): Promise<PayAs> {
  if (!connectMode()) return { feeBps: 0 };
  const row = must(await admin.from('studio_stripe').select('stripe_account_id, charges_enabled').eq('studio_id', studioId).maybeSingle()) as
    { stripe_account_id: string | null; charges_enabled: boolean } | null;
  if (!row?.stripe_account_id || !row.charges_enabled) throw new HttpError(409, 'PAYMENTS_NOT_SET_UP', notSetUp);
  return { account: row.stripe_account_id, feeBps: platformFeeBps() };
}

/** Application fee for a one-off payment of `cents` (undefined = none). Only on connected accounts. */
export function feeCents(pay: PayAs, cents: number): number | undefined {
  if (!pay.account || pay.feeBps <= 0) return undefined;
  const fee = Math.round((cents * pay.feeBps) / 10000);
  return fee > 0 ? fee : undefined;
}

/** Application fee for a subscription, as a percentage (bps / 100). */
export function feePercent(pay: PayAs): number | undefined {
  return pay.account && pay.feeBps > 0 ? pay.feeBps / 100 : undefined;
}

/** Which studio owns this connected account? null if we don't know it. */
export async function studioForAccount(admin: Db, account: string): Promise<string | null> {
  const row = must(await admin.from('studio_stripe').select('studio_id').eq('stripe_account_id', account).maybeSingle()) as { studio_id: string } | null;
  return row?.studio_id ?? null;
}

/** The status the studio app shows (same shape as public.my_stripe_status()). */
export interface ConnectStatus { connectMode: boolean; connected: boolean; accountId: string | null; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }

export function statusOf(row: { stripe_account_id?: string | null; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean } | null): ConnectStatus {
  return {
    connectMode: connectMode(), connected: !!row?.stripe_account_id && !!row.charges_enabled, accountId: row?.stripe_account_id ?? null,
    chargesEnabled: !!row?.charges_enabled, payoutsEnabled: !!row?.payouts_enabled, detailsSubmitted: !!row?.details_submitted,
  };
}
