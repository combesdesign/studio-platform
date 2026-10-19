/**
 * Commerce rules with no storage and no DOM, so the demo store, the UI and the tests all agree.
 * (The live store enforces the same rules inside Postgres: supabase/migrations/1300_commerce_*.sql.)
 */
import { dayShort, money, studioDate } from '../../shared/format';
import type { Cents, ID, ISODate, ISODateTime } from '../../shared/types';
import type { GiftCardState, GiftCardStatus, Promo, PromoStatus, Quote, QuoteGift, StockStatus } from './types';

// ------------------------------------------------------------------------------------------------ gift card codes
/** Crockford-style base32: no I, L, O or U, so a code read out over the phone isn't misheard. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 12 random characters as XXXX-XXXX-XXXX. `rand` returns [0, 1). */
export function makeGiftCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[Math.floor(rand() * 32) % 32];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
/** What someone typed -> the stored form (or '' if it can't be a gift card code). Forgives lower case, spaces, dashes, O/0 and I/L/1 mix-ups. */
export function normaliseGiftCode(input: string): string {
  const s = (input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 12 || /[U]/.test(s)) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
/** '••••-••••-JKMN': enough to recognise a card on a receipt without printing the whole code. */
export const maskGiftCode = (code: string): string => `••••-••••-${code.slice(-4)}`;

export function normalisePromoCode(input: string): string {
  return (input ?? '').toUpperCase().replace(/[^0-9A-Z_-]/g, '');
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------------------------------------------ gift card state
export function addMonthsIso(iso: ISODateTime, months: number): ISODateTime {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // 31 Aug + 6 months -> end of Feb, not March
  return d.toISOString();
}

export function giftCardState(c: { status: GiftCardStatus; balanceCents: Cents; expiresAt?: ISODateTime }, now: Date): GiftCardState {
  if (c.status === 'void') return 'void';
  if (c.status === 'pending') return 'pending';
  if (c.expiresAt && new Date(c.expiresAt).getTime() <= now.getTime()) return 'expired';
  return c.balanceCents <= 0 ? 'used' : 'active';
}
export const GIFT_STATE_LABEL: Record<GiftCardState, string> = { pending: 'Awaiting payment', active: 'Active', used: 'Used up', expired: 'Expired', void: 'Voided' };

/** A held reservation older than this is dropped if no sale claims it. */
export const HOLD_MINUTES = 30;

// ------------------------------------------------------------------------------------------------ promo codes
export interface PromoLine { productId: ID | null; cents: Cents }
export interface PromoContext {
  today: ISODate;
  clientId?: ID;
  /** undefined = no client, so we can't tell. */
  isNewClient?: boolean;
  usesTotal: number;
  usesByClient: number;
}
export type PromoResult = { ok: true; discountCents: Cents } | { ok: false; message: string };

export function promoStatus(p: Promo, today: ISODate, usesTotal: number): PromoStatus {
  if (!p.active) return 'paused';
  if (p.endsOn && today > p.endsOn) return 'expired';
  if (p.startsOn && today < p.startsOn) return 'scheduled';
  if (p.maxUses != null && usesTotal >= p.maxUses) return 'used_up';
  return 'live';
}

const dateWords = (d: ISODate) => dayShort(new Date(`${d}T12:00:00Z`)).replace(/^\w+ /, '');

export function promoLabel(p: Promo): string {
  const off = p.kind === 'percent' ? `${p.value}% off` : `${money(p.value)} off`;
  return p.description ? `${off} · ${p.description}` : off;
}
/** Check a promo code against a cart and work out the discount. Messages are written for whoever is looking at the screen. */
export function evaluatePromo(p: Promo | undefined, lines: PromoLine[], subtotalOnly: Cents | undefined, ctx: PromoContext, who: 'client' | 'staff' = 'client'): PromoResult {
  if (!p || !p.active) return { ok: false, message: 'That code isn’t valid.' };
  if (p.endsOn && ctx.today > p.endsOn) return { ok: false, message: 'That code has expired.' };
  if (p.startsOn && ctx.today < p.startsOn) return { ok: false, message: `That code starts on ${dateWords(p.startsOn)}.` };
  if (p.maxUses != null && ctx.usesTotal >= p.maxUses) return { ok: false, message: 'That code has been fully claimed.' };
  if ((p.newClientsOnly || p.maxUsesPerClient != null) && !ctx.clientId) {
    return { ok: false, message: who === 'staff' ? 'Add a client to use this code.' : 'Sign in to use this code.' };
  }
  if (p.newClientsOnly && ctx.isNewClient === false) {
    return { ok: false, message: who === 'staff' ? 'That code is for new clients only.' : 'That code is for new clients only. Thanks for being part of the club!' };
  }
  if (p.maxUsesPerClient != null && ctx.usesByClient >= p.maxUsesPerClient) {
    return { ok: false, message: who === 'staff' ? 'This client has already used that code.' : 'You’ve already used that code.' };
  }
  let eligible: Cents;
  if (p.productIds.length === 0) {
    eligible = lines.length ? lines.reduce((n, l) => n + l.cents, 0) : subtotalOnly ?? 0;
  } else if (lines.length) {
    eligible = lines.filter((l) => l.productId && p.productIds.includes(l.productId)).reduce((n, l) => n + l.cents, 0);
    if (eligible <= 0) return { ok: false, message: 'That code doesn’t apply to anything in this cart.' };
  } else {
    return { ok: false, message: 'That code only applies to certain products. Add them to the cart first.' };
  }
  if (eligible <= 0) return { ok: false, message: 'There’s nothing to take this off yet.' };
  const discountCents = p.kind === 'percent' ? Math.round((eligible * Math.min(100, Math.max(0, p.value))) / 100) : Math.min(eligible, Math.max(0, p.value));
  return discountCents > 0 ? { ok: true, discountCents } : { ok: false, message: 'There’s nothing to take this off yet.' };
}

// ------------------------------------------------------------------------------------------------ pricing a cart
export interface GiftInput { code: string; kind: 'gift_card' | 'credit'; balanceCents: Cents; error?: string }

/** Spend gift cards, in the order given, against what's left after the promo. */
export function priceCart(subtotalCents: Cents, promo: { id: ID; code: string; label: string; discountCents: Cents } | undefined, promoError: string | undefined, gifts: GiftInput[]): Quote {
  const promoCents = Math.min(subtotalCents, promo?.discountCents ?? 0);
  let due = subtotalCents - promoCents;
  const applied: QuoteGift[] = [];
  const giftErrors: Quote['giftErrors'] = [];
  const seen = new Set<string>();
  for (const g of gifts) {
    if (seen.has(g.code)) continue;
    seen.add(g.code);
    if (g.error) { giftErrors.push({ code: g.code, message: g.error }); continue; }
    if (due <= 0) { giftErrors.push({ code: g.code, message: 'Nothing left to pay, so this card wasn’t used.' }); continue; }
    const take = Math.min(due, g.balanceCents);
    due -= take;
    applied.push({ code: g.code, appliedCents: take, balanceCents: g.balanceCents, kind: g.kind });
  }
  const giftCents = applied.reduce((n, g) => n + g.appliedCents, 0);
  return {
    subtotalCents, ...(promo ? { promo: { ...promo, discountCents: promoCents } } : {}), ...(promoError ? { promoError } : {}),
    gifts: applied, giftErrors, promoCents, giftCents, totalCents: subtotalCents - promoCents - giftCents,
  };
}

// ------------------------------------------------------------------------------------------------ retail stock
export function stockStatus(stock: number | null | undefined, lowAt: number): StockStatus {
  if (stock == null) return 'untracked';
  if (stock <= 0) return 'out';
  return stock <= lowAt ? 'low' : 'ok';
}
export const STOCK_REASON_LABEL = {
  received: 'Stock received', count: 'Stocktake', damaged: 'Damaged', lost: 'Lost or stolen', returned: 'Customer return', other: 'Other',
} as const;

/** Scanner and keyboard input: trim, and drop the control characters some scanners add. */
export const cleanScan = (s: string): string => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();

export const today = (now: Date): ISODate => studioDate(now);

// ------------------------------------------------------------------------------------------------ till holds
/** The sale's note carries "ref <token>", which is how a hold finds the sale it belongs to. */
export const holdRef = (token: string): string => `ref ${token}`;
export function holdNote(q: Quote, token: string): string {
  const parts: string[] = [];
  if (q.promo && q.promoCents > 0) parts.push(`Promo ${q.promo.code} −${money(q.promoCents, { cents: true })}`);
  for (const g of q.gifts) parts.push(`${g.kind === 'credit' ? 'Credit' : 'Gift card'} ${maskGiftCode(g.code)} −${money(g.appliedCents, { cents: true })}`);
  return parts.length ? `${parts.join(' · ')} · ${holdRef(token)}` : '';
}
export const isHoldToken = (t: string): boolean => /^h[a-z0-9]{6,12}$/.test(t);
export function makeHoldToken(rand: () => number = Math.random): string {
  let s = 'h';
  for (let i = 0; i < 7; i++) s += 'abcdefghjkmnpqrstvwxyz23456789'[Math.floor(rand() * 30)];
  return s;
}
