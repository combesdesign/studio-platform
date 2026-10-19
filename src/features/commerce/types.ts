/**
 * Commerce feature: selling extras: gift cards, promo codes, referrals, retail stock (ROADMAP B3).
 * Owner: the commerce feature agent. Everything for this feature lives in src/features/commerce/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1300_commerce_*.sql (range 1300–1399), tests supabase/tests/commerce_*.sql.
 *
 * Money is integer cents in the studio's currency. Codes are case-insensitive: promo codes are stored
 * UPPERCASE (WELCOME10), gift card codes are 12 characters shown as XXXX-XXXX-XXXX.
 */
import type { Cents, ID, ISODate, ISODateTime, Sale } from '../../shared/types';

// ------------------------------------------------------------------------------------------------ settings
export interface CommerceSettings {
  /** Amount buttons in the client app's "Buy a gift card" (cents). */
  giftCardAmounts: Cents[];
  giftCardMinCents: Cents;
  giftCardMaxCents: Cents;
  /** 0 = never expires. Australian law says at least 3 years, so 36 is the default. */
  giftCardExpiryMonths: number;
  referralEnabled: boolean;
  /** 'credit' lands on the referrer's account (used first at checkout), 'gift_card' is a normal gift card they can share. */
  referralRewardKind: 'credit' | 'gift_card';
  referralRewardCents: Cents;
  /** Retail items at or below this many are "low" unless the item has its own level. */
  lowStockDefault: number;
}

// ------------------------------------------------------------------------------------------------ gift cards
/** pending = bought online but not paid yet (live only). */
export type GiftCardStatus = 'pending' | 'active' | 'void';
/** What staff and clients see: derived from status, balance and expiry. */
export type GiftCardState = 'pending' | 'active' | 'used' | 'expired' | 'void';
export type GiftCardSource = 'purchase' | 'pos' | 'referral' | 'studio';

export interface GiftCardEntry {
  id: ID;
  at: ISODateTime;
  /** issue = money in, redeem = used at checkout, adjust = staff correction, void = balance written off, refund = put back. */
  kind: 'issue' | 'redeem' | 'adjust' | 'void' | 'refund';
  /** Signed: redeem is negative. */
  cents: Cents;
  /** held = reserved by a till/checkout that hasn't finished; released = never happened. Only posted + held count. */
  state: 'posted' | 'held' | 'released';
  note?: string;
  saleId?: ID;
  staffId?: ID;
  staffName?: string;
  clientId?: ID;
}

export interface GiftCard {
  id: ID;
  /** XXXX-XXXX-XXXX. Staff see it in full; clients see their own cards in full. */
  code: string;
  status: GiftCardStatus;
  state: GiftCardState;
  /** 'credit' = account credit owned by one client (referral rewards); 'gift_card' = a normal card. */
  kind: 'gift_card' | 'credit';
  source: GiftCardSource;
  initialCents: Cents;
  /** What can be spent right now (posted + held). */
  balanceCents: Cents;
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
  /** Who it's from, as written on the card. */
  fromName?: string;
  purchaserClientId?: ID;
  purchaserName?: string;
  ownerClientId?: ID;
  /** Studio date the email goes (or went) out. */
  sendOn?: ISODate;
  sentAt?: ISODateTime;
  createdAt: ISODateTime;
  expiresAt?: ISODateTime;
  saleId?: ID;
}

export interface GiftCardDetail extends GiftCard {
  entries: GiftCardEntry[];
}

/** What a code check tells a till or a client (no personal details). */
export interface GiftCardLookup {
  code: string;
  state: GiftCardState;
  balanceCents: Cents;
  expiresAt?: ISODateTime;
  kind: 'gift_card' | 'credit';
}

export interface BuyGiftCardInput {
  amountCents: Cents;
  recipientName: string;
  recipientEmail: string;
  message?: string;
  /** Studio date to send it. Defaults to today. */
  sendOn?: ISODate;
  /** Defaults to the buyer's first name. */
  fromName?: string;
}
export interface BuyGiftCardResult {
  card: GiftCard;
  sale?: Sale;
  /** Live: where to pay (Stripe Checkout). The card turns active when payment lands. */
  checkoutUrl?: string;
}
export interface SellGiftCardInput {
  amountCents: Cents;
  /** 'comp' issues a free card (no sale). */
  method: 'card_reader' | 'cash' | 'card_online' | 'comp';
  clientId?: ID;
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
  fromName?: string;
  sendOn?: ISODate;
}

// ------------------------------------------------------------------------------------------------ promo codes
export interface Promo {
  id: ID;
  /** UPPERCASE, no spaces: WELCOME10. */
  code: string;
  description?: string;
  kind: 'percent' | 'amount';
  /** percent: 1–100. amount: cents. */
  value: number;
  /** Empty = every product. Otherwise the discount only counts these. */
  productIds: ID[];
  startsOn?: ISODate;
  endsOn?: ISODate;
  maxUses?: number;
  maxUsesPerClient?: number;
  newClientsOnly: boolean;
  active: boolean;
  createdAt: ISODateTime;
}
export type PromoStatus = 'live' | 'scheduled' | 'expired' | 'paused' | 'used_up';
export interface PromoWithUsage extends Promo {
  status: PromoStatus;
  uses: number;
  discountCents: Cents;
  lastUsedAt?: ISODateTime;
}
export interface PromoRedemption {
  id: ID;
  promoId: ID;
  code: string;
  clientId?: ID;
  clientName?: string;
  saleId?: ID;
  discountCents: Cents;
  at: ISODateTime;
}

// ------------------------------------------------------------------------------------------------ checkout with codes
export interface QuoteInput {
  /** Staff pricing for a client; clients always price for themselves. */
  clientId?: ID;
  /** The cart. Prices come from the store, never from the caller. */
  items?: { productId: ID; qty: number }[];
  /** Only when the lines aren't known (a till that can't tell us): codes limited to specific products won't apply. */
  subtotalCents?: Cents;
  promoCode?: string;
  giftCodes?: string[];
}
export interface QuoteGift { code: string; appliedCents: Cents; balanceCents: Cents; kind: 'gift_card' | 'credit' }
export interface Quote {
  subtotalCents: Cents;
  promo?: { id: ID; code: string; label: string; discountCents: Cents };
  promoError?: string;
  gifts: QuoteGift[];
  giftErrors: { code: string; message: string }[];
  promoCents: Cents;
  giftCents: Cents;
  /** Left to pay by card or cash. */
  totalCents: Cents;
}

export interface HoldInput extends QuoteInput {
  /** The same token again updates the hold; omit it for a new one. */
  token?: string;
}
export interface HoldResult {
  token: string;
  quote: Quote;
  /** Put this in the sale's note: it's how the redemption finds its sale. */
  note: string;
}
export interface PurchaseWithCodesInput {
  productId: ID;
  promoCode?: string;
  giftCodes?: string[];
}
export interface PurchaseWithCodesResult {
  sale?: Sale;
  quote: Quote;
  /** Live: some is left to pay, so go to Stripe Checkout. Nothing is recorded until payment lands. */
  checkoutUrl?: string;
}

// ------------------------------------------------------------------------------------------------ referrals
export interface ReferralRow {
  id: ID;
  referrerClientId: ID;
  referrerName: string;
  referredClientId: ID;
  referredName: string;
  status: 'pending' | 'rewarded';
  createdAt: ISODateTime;
  rewardedAt?: ISODateTime;
  rewardCents?: Cents;
}
export interface MyReferral {
  enabled: boolean;
  code: string;
  rewardKind: 'credit' | 'gift_card';
  rewardCents: Cents;
  /** Friends who joined with my code. */
  referrals: { name: string; status: 'pending' | 'rewarded'; at: ISODateTime }[];
  earnedCents: Cents;
  /** Set when I joined with someone's code. */
  referredBy?: string;
}
export interface ReferralStats {
  enabled: boolean;
  rewardKind: 'credit' | 'gift_card';
  rewardCents: Cents;
  referrals: number;
  rewarded: number;
  pending: number;
  rewardCentsPaid: Cents;
  top: { clientId: ID; name: string; referrals: number; rewarded: number }[];
  recent: ReferralRow[];
}

// ------------------------------------------------------------------------------------------------ retail stock
export type StockReason = 'received' | 'count' | 'damaged' | 'lost' | 'returned' | 'other';
export type StockStatus = 'ok' | 'low' | 'out' | 'untracked';
export interface RetailItem {
  productId: ID;
  name: string;
  priceCents: Cents;
  active: boolean;
  /** null = stock isn't tracked for this product. */
  stock: number | null;
  sku?: string;
  barcode?: string;
  /** The level this item counts as low at (its own, else the studio default). */
  lowAt: number;
  /** Its own level, if set. */
  lowStockAt?: number;
  status: StockStatus;
}
export interface StockAdjustment {
  id: ID;
  productId: ID;
  productName: string;
  delta: number;
  before: number;
  after: number;
  reason: StockReason;
  note?: string;
  staffId?: ID;
  staffName?: string;
  at: ISODateTime;
}
export interface AdjustStockInput {
  productId: ID;
  /** Add (+) or remove (−) this many. Give delta or setTo. */
  delta?: number;
  /** A stocktake: set the count to exactly this. */
  setTo?: number;
  reason: StockReason;
  note?: string;
}
export interface StockReport {
  from: ISODate;
  to: ISODate;
  rows: {
    productId: ID;
    name: string;
    sku?: string;
    onHand: number | null;
    valueCents: Cents;
    sold: number;
    received: number;
    writtenOff: number;
    status: StockStatus;
  }[];
  totals: { units: number; valueCents: Cents; sold: number; low: number; out: number };
}

// ------------------------------------------------------------------------------------------------ the store
/** What the apps can call as store.features.commerce. Add methods here; implement them in demo.ts and live.ts. */
export interface CommerceStore {
  // ---- settings (anyone signed in can read; owner/manager change)
  getSettings(): Promise<CommerceSettings>;
  updateSettings(patch: Partial<CommerceSettings>): Promise<CommerceSettings>;

  // ---- gift cards
  /** Staff: every card, newest first. */
  listGiftCards(): Promise<GiftCard[]>;
  getGiftCard(id: ID): Promise<GiftCardDetail>;
  /** Balance check by code (staff, or a signed-in client). */
  lookupGiftCard(code: string): Promise<GiftCardLookup>;
  /** Client: cards I bought, received on my email, or own as credit. */
  myGiftCards(): Promise<GiftCard[]>;
  /** Client: buy one online. Demo takes a fake card; live returns a Stripe Checkout URL. */
  buyGiftCard(input: BuyGiftCardInput): Promise<BuyGiftCardResult>;
  /** Till: sell (or comp) a card. */
  sellGiftCard(input: SellGiftCardInput): Promise<{ card: GiftCard; sale?: Sale }>;
  voidGiftCard(id: ID, reason: string): Promise<GiftCardDetail>;
  /** Add (+) or take off (−) balance, with a reason. */
  adjustGiftCard(id: ID, deltaCents: Cents, reason: string): Promise<GiftCardDetail>;
  /** Send the email again (optionally to a new address). */
  resendGiftCard(id: ID, email?: string): Promise<GiftCard>;

  // ---- promo codes
  listPromos(): Promise<PromoWithUsage[]>;
  upsertPromo(p: Omit<Promo, 'id' | 'createdAt' | 'code'> & { id?: ID; code: string }): Promise<Promo>;
  promoRedemptions(promoId?: ID): Promise<PromoRedemption[]>;

  // ---- using codes
  /** Price a cart with a promo code and/or gift cards. Never throws for a bad code: the reason is in the quote. */
  quote(input: QuoteInput): Promise<Quote>;
  /** Till: reserve the codes for a cart. Call again with the same token when the cart changes. */
  holdCodes(input: HoldInput): Promise<HoldResult>;
  /** Till: the cart is done. If the sale went through the holds become real, otherwise they're released. */
  settleHold(token: string): Promise<void>;
  /** Client shop: buy a product using a promo code and/or gift cards (validated and recorded on the server). */
  purchaseWithCodes(input: PurchaseWithCodesInput): Promise<PurchaseWithCodesResult>;

  // ---- referrals
  myReferral(): Promise<MyReferral>;
  /** Client: join with a friend's code. Only new clients, once. */
  claimReferral(code: string): Promise<{ referrerName: string }>;
  referralStats(): Promise<ReferralStats>;

  // ---- retail stock
  listRetail(): Promise<RetailItem[]>;
  updateRetail(productId: ID, patch: { sku?: string | null; barcode?: string | null; lowStockAt?: number | null }): Promise<RetailItem>;
  adjustStock(input: AdjustStockInput): Promise<RetailItem>;
  stockLog(opts?: { productId?: ID; limit?: number }): Promise<StockAdjustment[]>;
  /** Till: the item whose barcode or SKU is exactly this (null if none). */
  findRetail(code: string): Promise<RetailItem | null>;
  stockReport(range: { from: ISODate; to: ISODate }): Promise<StockReport>;
}

declare module '../../shared/store' {
  interface FeatureStores { commerce: CommerceStore }
}
