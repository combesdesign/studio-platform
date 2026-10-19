/** Small helpers the commerce screens (client and studio) share. No React in here. */
import { store } from '../../data';
import { LOCALE, dateFormat } from '../../shared/format';
import type { ISODate, ISODateTime } from '../../shared/types';
import type { CommerceStore, GiftCardState, PromoStatus, StockStatus } from './types';

/** The commerce store, or undefined when this studio's build doesn't have it. */
export const commerce = (): CommerceStore | undefined => store.features.commerce;

/** For loaders: the store, or a friendly error the screen's error block can show. */
export function needCommerce(): CommerceStore {
  const c = commerce();
  if (!c) throw new Error('Gift cards and promo codes aren’t available just yet.');
  return c;
}

const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** '14 Oct 2026'. Works for a studio date (YYYY-MM-DD) or a timestamp, always in the studio's timezone. */
export function dmy(s: ISODate | ISODateTime): string {
  if (isDateOnly(s)) return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${s}T12:00:00Z`));
  return dateFormat({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));
}
/** '14 Oct'. */
export function dm(s: ISODate | ISODateTime): string {
  if (isDateOnly(s)) return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${s}T12:00:00Z`));
  return dateFormat({ day: 'numeric', month: 'short' }).format(new Date(s));
}
/** '14 Oct, 3:05pm' for ledger rows. */
export function dmTime(iso: ISODateTime): string {
  return `${dm(iso)}, ${dateFormat({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\s?([ap]m)/i, (_m, x: string) => x.toLowerCase())}`;
}

/** Copy to the clipboard, falling back to a hidden textarea for older browsers. Returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}

export const GIFT_STATE_TONE: Record<GiftCardState, 'ok' | 'warn' | 'danger' | ''> = { pending: 'warn', active: 'ok', used: '', expired: 'warn', void: 'danger' };
export const PROMO_STATUS_LABEL: Record<PromoStatus, string> = { live: 'Live', scheduled: 'Scheduled', expired: 'Ended', paused: 'Paused', used_up: 'Fully claimed' };
export const PROMO_STATUS_TONE: Record<PromoStatus, 'ok' | 'warn' | 'danger' | ''> = { live: 'ok', scheduled: 'warn', expired: '', paused: '', used_up: 'warn' };
export const STOCK_STATUS_LABEL: Record<StockStatus, string> = { ok: 'In stock', low: 'Low', out: 'Out of stock', untracked: 'Not tracked' };
export const STOCK_STATUS_TONE: Record<StockStatus, 'ok' | 'warn' | 'danger' | ''> = { ok: 'ok', low: 'warn', out: 'danger', untracked: '' };

/** '1234' -> '12.34' for a money input, '' for 0/empty. */
export const centsToInput = (c: number | undefined | null): string => (c == null || c === 0 ? '' : (c / 100).toFixed(c % 100 ? 2 : 0));
/** '12.5' -> 1250, NaN-safe. */
export function inputToCents(s: string): number {
  const n = parseFloat((s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** The share link for a referral code: this page's address with ?ref=CODE (keeping ?studio= and friends). */
export function referralLink(code: string): string {
  try {
    const u = new URL(location.href);
    u.hash = '';
    u.searchParams.set('ref', code);
    return u.toString();
  } catch { return `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}`; }
}
