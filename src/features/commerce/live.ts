/**
 * Live (Supabase) implementation of CommerceStore. Tables and RPCs: supabase/migrations/1300_commerce_tables.sql,
 * 1301_commerce_gift_promo.sql and 1302_commerce_referral_stock.sql. Every change goes through an RPC (same rules and
 * error codes as demo.ts); the RPCs hand back jsonb in snake_case and the mappers here turn it into the shared types.
 *
 * Money out of the studio's hands:
 *  - buyGiftCard makes a *pending* card, then asks the `commerce-checkout` edge function for a Stripe Checkout URL.
 *    The stripe-webhook calls public.commerce_activate_gift_card(card id, payment intent, checkout session) when the
 *    payment lands (service role). Until that function is deployed buying online says so instead of faking a sale.
 *  - purchaseWithCodes records a sale when the codes cover the whole price. If something is left to pay the RPC raises
 *    PAYMENT_REQUIRED (see NOTES.md › commerce for the request to wire Stripe to codes).
 *  - The till (holdCodes / settleHold) never takes money itself: it reserves the codes, the sale goes through
 *    checkout_cart, and the hold turns into a redemption once a sale carrying "ref <token>" exists.
 */
import './permissions';
import { registerLiveFeature, type LiveFeatureContext } from '../../data/supabase/features';
import { money } from '../../shared/format';
import type { ISODate, ISODateTime, PaymentMethod, Sale, SaleItem } from '../../shared/types';
import { holdNote } from './logic';
import type {
  AdjustStockInput, BuyGiftCardInput, BuyGiftCardResult, CommerceSettings, CommerceStore, GiftCard, GiftCardDetail, GiftCardEntry, GiftCardLookup,
  GiftCardSource, GiftCardState, GiftCardStatus, HoldInput, HoldResult, MyReferral, Promo, PromoRedemption, PromoStatus, PromoWithUsage,
  PurchaseWithCodesInput, PurchaseWithCodesResult, Quote, QuoteInput, ReferralRow, ReferralStats, RetailItem, SellGiftCardInput, StockAdjustment,
  StockReason, StockReport, StockStatus,
} from './types';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- row mappers (snake_case jsonb -> the shared types)

const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));
const num = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));
const iso = (v: unknown): ISODateTime | undefined => (v == null || v === '' ? undefined : new Date(String(v)).toISOString());
const day = (v: unknown): ISODate | undefined => (v == null || v === '' ? undefined : String(v).slice(0, 10));
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const arr = (v: unknown): Row[] => (Array.isArray(v) ? v.map(obj) : []);
/** Drop undefined values: the shared types use optional fields, not nulls. */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export function toSettings(r: Row): CommerceSettings {
  return {
    giftCardAmounts: (Array.isArray(r.gift_card_amounts) ? r.gift_card_amounts : []).map(Number),
    giftCardMinCents: Number(r.gift_card_min_cents), giftCardMaxCents: Number(r.gift_card_max_cents),
    giftCardExpiryMonths: Number(r.gift_card_expiry_months), referralEnabled: r.referral_enabled === true,
    referralRewardKind: r.referral_reward_kind === 'gift_card' ? 'gift_card' : 'credit', referralRewardCents: Number(r.referral_reward_cents),
    lowStockDefault: Number(r.low_stock_default),
  };
}

export function toCard(r: Row): GiftCard {
  return clean<GiftCard>({
    id: String(r.id), code: String(r.code), status: String(r.status) as GiftCardStatus, state: String(r.state) as GiftCardState,
    kind: r.kind === 'credit' ? 'credit' : 'gift_card', source: String(r.source) as GiftCardSource, initialCents: Number(r.initial_cents),
    balanceCents: Number(r.balance_cents), recipientName: str(r.recipient_name), recipientEmail: str(r.recipient_email), message: str(r.message),
    fromName: str(r.from_name), purchaserClientId: str(r.purchaser_client_id), purchaserName: str(r.purchaser_name), ownerClientId: str(r.owner_client_id),
    sendOn: day(r.send_on), sentAt: iso(r.sent_at), createdAt: iso(r.created_at) ?? new Date(0).toISOString(), expiresAt: iso(r.expires_at), saleId: str(r.sale_id),
  });
}
const toEntry = (r: Row): GiftCardEntry => clean<GiftCardEntry>({
  id: String(r.id), at: iso(r.at)!, kind: String(r.kind) as GiftCardEntry['kind'], cents: Number(r.cents), state: r.state === 'held' ? 'held' : 'posted',
  note: str(r.note), saleId: str(r.sale_id), staffId: str(r.staff_id), staffName: str(r.staff_name), clientId: str(r.client_id),
});
const toDetail = (r: Row): GiftCardDetail => ({ ...toCard(r), entries: arr(r.entries).map(toEntry) });

function toSale(r: Row): Sale {
  const items: SaleItem[] = arr(r.items).map((x) => clean<SaleItem>({ productId: str(x.product_id), name: String(x.name), qty: Number(x.qty ?? 1), unitCents: Number(x.unit_cents) }));
  return clean<Sale>({
    id: String(r.id), clientId: str(r.client_id), items, totalCents: Number(r.total_cents), method: String(r.method) as PaymentMethod, staffId: str(r.staff_id),
    createdAt: iso(r.created_at)!, stripePaymentIntentId: str(r.stripe_payment_intent_id), refundedAt: iso(r.refunded_at), refundedCents: num(r.refunded_cents) || undefined, note: str(r.note),
  });
}

export function toPromo(r: Row): Promo {
  return clean<Promo>({
    id: String(r.id), code: String(r.code), description: str(r.description), kind: r.kind === 'amount' ? 'amount' : 'percent', value: Number(r.value),
    productIds: (Array.isArray(r.product_ids) ? r.product_ids : []).map(String), startsOn: day(r.starts_on), endsOn: day(r.ends_on),
    maxUses: num(r.max_uses), maxUsesPerClient: num(r.max_uses_per_client), newClientsOnly: r.new_clients_only === true, active: r.active !== false,
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
  });
}
const toPromoUsage = (r: Row): PromoWithUsage => clean<PromoWithUsage>({
  ...toPromo(r), status: String(r.status) as PromoStatus, uses: Number(r.uses ?? 0), discountCents: Number(r.discount_cents ?? 0), lastUsedAt: iso(r.last_used_at),
});
const toRedemption = (r: Row): PromoRedemption => clean<PromoRedemption>({
  id: String(r.id), promoId: String(r.promo_id), code: String(r.code), clientId: str(r.client_id), clientName: str(r.client_name) ?? (r.client_id ? 'Former client' : undefined),
  saleId: str(r.sale_id), discountCents: Number(r.discount_cents), at: iso(r.at)!,
});

export function toQuote(r: Row): Quote {
  const p = r.promo ? obj(r.promo) : undefined;
  const promoLabel = p ? (p.kind === 'amount' ? `${money(Number(p.value))} off` : `${Number(p.value)}% off`) : '';
  return clean<Quote>({
    subtotalCents: Number(r.subtotal_cents),
    promo: p ? { id: String(p.id), code: String(p.code), label: promoLabel, discountCents: Number(p.discount_cents) } : undefined,
    promoError: str(r.promo_error),
    gifts: arr(r.gifts).map((g) => ({ code: String(g.code), appliedCents: Number(g.applied_cents), balanceCents: Number(g.balance_cents), kind: g.kind === 'credit' ? 'credit' as const : 'gift_card' as const })),
    giftErrors: arr(r.gift_errors).map((g) => ({ code: String(g.code), message: String(g.message) })),
    promoCents: Number(r.promo_cents), giftCents: Number(r.gift_cents), totalCents: Number(r.total_cents),
  });
}

const toItem = (r: Row): RetailItem => clean<RetailItem>({
  productId: String(r.product_id), name: String(r.name), priceCents: Number(r.price_cents), active: r.active !== false, stock: r.stock == null ? null : Number(r.stock),
  sku: str(r.sku), barcode: str(r.barcode), lowAt: Number(r.low_at), lowStockAt: num(r.low_stock_at), status: String(r.status) as StockStatus,
});
const toLog = (r: Row): StockAdjustment => clean<StockAdjustment>({
  id: String(r.id), productId: String(r.product_id), productName: String(r.product_name), delta: Number(r.delta), before: Number(r.before), after: Number(r.after),
  reason: String(r.reason) as StockReason, note: str(r.note), staffId: str(r.staff_id), staffName: str(r.staff_name), at: iso(r.at)!,
});
const toRefRow = (r: Row): ReferralRow => clean<ReferralRow>({
  id: String(r.id), referrerClientId: String(r.referrer_client_id), referrerName: String(r.referrer_name), referredClientId: String(r.referred_client_id), referredName: String(r.referred_name),
  status: r.status === 'rewarded' ? 'rewarded' : 'pending', createdAt: iso(r.created_at)!, rewardedAt: iso(r.rewarded_at), rewardCents: num(r.reward_cents),
});

// ---------------------------------------------------------------- argument builders (shared types -> snake_case)

function quoteArgs(i: QuoteInput): Row {
  return {
    ...(i.clientId ? { client_id: i.clientId } : {}),
    ...(i.items?.length ? { items: i.items.map((x) => ({ product_id: x.productId, qty: x.qty })) } : {}),
    ...(i.subtotalCents != null ? { subtotal_cents: Math.round(i.subtotalCents) } : {}),
    ...(i.promoCode ? { promo_code: i.promoCode } : {}), ...(i.giftCodes?.length ? { gift_codes: i.giftCodes } : {}),
  };
}

registerLiveFeature({
  name: 'commerce',
  create: (ctx: LiveFeatureContext): CommerceStore => {
    const rpc = async (name: string, args?: Record<string, unknown>): Promise<Row> => obj(await ctx.rpc(name, args));
    const list = async (name: string, args?: Record<string, unknown>): Promise<Row[]> => arr(await ctx.rpc(name, args));
    /** Whether the signed-in person is a client (clients price for themselves; staff price for a client). */
    const who = async (): Promise<'client' | 'staff'> => ((await ctx.currentUser())?.kind === 'client' ? 'client' : 'staff');

    return {
      // ---- settings
      getSettings: () => ctx.read(async () => toSettings(await rpc('commerce_get_settings'))),
      updateSettings: (patch) => ctx.write(async () => {
        const p: Row = {};
        if (patch.giftCardAmounts !== undefined) p.gift_card_amounts = patch.giftCardAmounts;
        if (patch.giftCardMinCents !== undefined) p.gift_card_min_cents = patch.giftCardMinCents;
        if (patch.giftCardMaxCents !== undefined) p.gift_card_max_cents = patch.giftCardMaxCents;
        if (patch.giftCardExpiryMonths !== undefined) p.gift_card_expiry_months = patch.giftCardExpiryMonths;
        if (patch.referralEnabled !== undefined) p.referral_enabled = patch.referralEnabled;
        if (patch.referralRewardKind !== undefined) p.referral_reward_kind = patch.referralRewardKind;
        if (patch.referralRewardCents !== undefined) p.referral_reward_cents = patch.referralRewardCents;
        if (patch.lowStockDefault !== undefined) p.low_stock_default = patch.lowStockDefault;
        return toSettings(await rpc('commerce_update_settings', { p_patch: p }));
      }),

      // ---- gift cards
      listGiftCards: () => ctx.read(async () => (await list('commerce_list_gift_cards')).map(toCard)),
      getGiftCard: (id) => ctx.read(async () => toDetail(await rpc('commerce_get_gift_card', { p_id: id }))),
      lookupGiftCard: (code) => ctx.read(async (): Promise<GiftCardLookup> => {
        const r = await rpc('commerce_lookup_gift_card', { p_code: code });
        return clean<GiftCardLookup>({ code: String(r.code), state: String(r.state) as GiftCardState, balanceCents: Number(r.balance_cents), expiresAt: iso(r.expires_at), kind: r.kind === 'credit' ? 'credit' : 'gift_card' });
      }),
      myGiftCards: () => ctx.read(async () => (await list('commerce_my_gift_cards')).map(toCard)),
      buyGiftCard: (input: BuyGiftCardInput) => ctx.write(async (): Promise<BuyGiftCardResult> => {
        const r = await rpc('commerce_buy_gift_card', {
          p_input: {
            amount_cents: input.amountCents, recipient_name: input.recipientName, recipient_email: input.recipientEmail,
            ...(input.message ? { message: input.message } : {}), ...(input.sendOn ? { send_on: input.sendOn } : {}), ...(input.fromName ? { from_name: input.fromName } : {}),
          },
        });
        const card = toCard(obj(r.card));
        // The card stays pending until Stripe confirms payment (the webhook calls commerce_activate_gift_card).
        const here = typeof location !== 'undefined' ? location.href.split('#')[0] : '';
        let url: string | undefined;
        try {
          const res = (await ctx.sb.functions.invoke('commerce-checkout', { body: { cardId: card.id, studioId: ctx.studioId, returnUrl: `${here}#/gift-cards` } })) as { data?: Row; error?: unknown };
          url = str(obj(res.data).url);
          if (!url && res.error) {
            // Connect: this studio hasn't connected Stripe yet. Say so plainly (the pending card is never switched on).
            const c = obj(obj(res.error).context) as { json?: () => Promise<unknown> };
            const j = typeof c.json === 'function' ? obj(await c.json().catch(() => ({}))) : {};
            if (str(j.code) === 'PAYMENTS_NOT_SET_UP') throw ctx.error('PAYMENTS_NOT_SET_UP', str(j.message) || 'Online payments aren’t set up yet, pay at the studio.');
          }
        } catch (e) { if ((e as { code?: string } | null)?.code === 'PAYMENTS_NOT_SET_UP') throw e; /* anything else: handled below */ }
        if (!url) throw ctx.error('PAYMENT_UNAVAILABLE', 'Paying for gift cards online isn’t switched on yet. Please ask the studio to sell you one at the front desk.');
        return { card, checkoutUrl: url };
      }),
      sellGiftCard: (input: SellGiftCardInput) => ctx.write(async () => {
        const r = await rpc('commerce_sell_gift_card', {
          p_input: {
            amount_cents: input.amountCents, method: input.method, ...(input.clientId ? { client_id: input.clientId } : {}),
            ...(input.recipientName ? { recipient_name: input.recipientName } : {}), ...(input.recipientEmail ? { recipient_email: input.recipientEmail } : {}),
            ...(input.message ? { message: input.message } : {}), ...(input.fromName ? { from_name: input.fromName } : {}), ...(input.sendOn ? { send_on: input.sendOn } : {}),
          },
        });
        return { card: toCard(obj(r.card)), ...(r.sale ? { sale: toSale(obj(r.sale)) } : {}) };
      }),
      voidGiftCard: (id, reason) => ctx.write(async () => toDetail(await rpc('commerce_void_gift_card', { p_id: id, p_reason: reason }))),
      adjustGiftCard: (id, deltaCents, reason) => ctx.write(async () => toDetail(await rpc('commerce_adjust_gift_card', { p_id: id, p_delta_cents: deltaCents, p_reason: reason }))),
      resendGiftCard: (id, email) => ctx.write(async () => toCard(await rpc('commerce_resend_gift_card', { p_id: id, p_email: email ?? null }))),

      // ---- promo codes
      listPromos: () => ctx.read(async () => (await list('commerce_list_promos')).map(toPromoUsage)),
      upsertPromo: (p) => ctx.write(async () => toPromo(await rpc('commerce_upsert_promo', {
        p_promo: {
          ...(p.id ? { id: p.id } : {}), code: p.code, description: p.description ?? null, kind: p.kind, value: p.value, product_ids: p.productIds ?? [],
          starts_on: p.startsOn ?? null, ends_on: p.endsOn ?? null, max_uses: p.maxUses ?? null, max_uses_per_client: p.maxUsesPerClient ?? null,
          new_clients_only: !!p.newClientsOnly, active: !!p.active,
        },
      }))),
      promoRedemptions: (promoId) => ctx.read(async () => (await list('commerce_promo_redemptions', { p_promo_id: promoId ?? null })).map(toRedemption)),

      // ---- using codes
      quote: (input) => ctx.read(async () => toQuote(await rpc('commerce_quote', { p_input: quoteArgs(input), p_who: await who() }))),
      holdCodes: (input: HoldInput) => ctx.write(async (): Promise<HoldResult> => {
        const r = await rpc('commerce_hold_codes', { p_input: { ...quoteArgs(input), ...(input.token ? { token: input.token } : {}) } });
        const quote = toQuote(obj(r.quote));
        const token = String(r.token);
        return { token, quote, note: holdNote(quote, token) };
      }),
      settleHold: (token) => ctx.write(async () => { await ctx.rpc('commerce_settle_hold', { p_token: token }); }),
      purchaseWithCodes: (input: PurchaseWithCodesInput) => ctx.write(async (): Promise<PurchaseWithCodesResult> => {
        const r = await rpc('commerce_purchase_with_codes', { p_product_id: input.productId, p_promo_code: input.promoCode ?? null, p_gift_codes: input.giftCodes ?? [] });
        return { sale: toSale(obj(r.sale)), quote: toQuote(obj(r.quote)) };
      }),

      // ---- referrals
      myReferral: () => ctx.read(async (): Promise<MyReferral> => {
        const r = await rpc('commerce_my_referral');
        return clean<MyReferral>({
          enabled: r.enabled === true, code: String(r.code), rewardKind: r.reward_kind === 'gift_card' ? 'gift_card' : 'credit', rewardCents: Number(r.reward_cents),
          referrals: arr(r.referrals).map((x) => ({ name: String(x.name), status: x.status === 'rewarded' ? 'rewarded' as const : 'pending' as const, at: iso(x.at)! })),
          earnedCents: Number(r.earned_cents ?? 0), referredBy: str(r.referred_by),
        });
      }),
      claimReferral: (code) => ctx.write(async () => ({ referrerName: String((await rpc('commerce_claim_referral', { p_code: code })).referrer_name ?? 'your friend') })),
      referralStats: () => ctx.read(async (): Promise<ReferralStats> => {
        const r = await rpc('commerce_referral_stats');
        return {
          enabled: r.enabled === true, rewardKind: r.reward_kind === 'gift_card' ? 'gift_card' : 'credit', rewardCents: Number(r.reward_cents),
          referrals: Number(r.referrals), rewarded: Number(r.rewarded), pending: Number(r.pending), rewardCentsPaid: Number(r.reward_cents_paid),
          top: arr(r.top).map((t) => ({ clientId: String(t.client_id), name: String(t.name), referrals: Number(t.referrals), rewarded: Number(t.rewarded) })),
          recent: arr(r.recent).map(toRefRow),
        };
      }),

      // ---- retail stock
      listRetail: () => ctx.read(async () => (await list('commerce_list_retail')).map(toItem)),
      updateRetail: (productId, patch) => ctx.write(async () => toItem(await rpc('commerce_update_retail', {
        p_product_id: productId,
        p_patch: {
          ...(patch.sku !== undefined ? { sku: patch.sku } : {}), ...(patch.barcode !== undefined ? { barcode: patch.barcode } : {}),
          ...(patch.lowStockAt !== undefined ? { low_stock_at: patch.lowStockAt } : {}),
        },
      }))),
      adjustStock: (input: AdjustStockInput) => ctx.write(async () => toItem(await rpc('commerce_adjust_stock', {
        p_input: {
          product_id: input.productId, reason: input.reason, ...(input.delta !== undefined ? { delta: input.delta } : {}),
          ...(input.setTo !== undefined ? { set_to: input.setTo } : {}), ...(input.note ? { note: input.note } : {}),
        },
      }))),
      stockLog: (opts) => ctx.read(async () => (await list('commerce_stock_log', { p_product_id: opts?.productId ?? null, p_limit: opts?.limit ?? 100 })).map(toLog)),
      findRetail: (code) => ctx.read(async () => {
        const r = await ctx.rpc('commerce_find_retail', { p_code: code });
        return r ? toItem(obj(r)) : null;
      }),
      stockReport: (range) => ctx.read(async (): Promise<StockReport> => {
        const r = await rpc('commerce_stock_report', { p_from: range.from, p_to: range.to });
        const rows = arr(r.rows).map((x): StockReport['rows'][number] => clean({
          productId: String(x.product_id), name: String(x.name), sku: str(x.sku), onHand: x.on_hand == null ? null : Number(x.on_hand), valueCents: Number(x.value_cents),
          sold: Number(x.sold), received: Number(x.received), writtenOff: Number(x.written_off), status: String(x.status) as StockStatus,
        }));
        return {
          from: range.from, to: range.to, rows,
          totals: {
            units: rows.reduce((n, x) => n + (x.onHand ?? 0), 0), valueCents: rows.reduce((n, x) => n + x.valueCents, 0), sold: rows.reduce((n, x) => n + x.sold, 0),
            low: rows.filter((x) => x.status === 'low').length, out: rows.filter((x) => x.status === 'out').length,
          },
        };
      }),
    };
  },
});
