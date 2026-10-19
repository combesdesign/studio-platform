/**
 * Demo implementation of CommerceStore, plugged into the demo store (registerDemoFeature).
 * Everything lives in the studio's `features.commerce` slice, so it persists, syncs across tabs and resets with the demo.
 * Gift cards keep a balance ledger; promo codes and gift cards used at the till are *held* until the sale lands
 * (the sale's note carries "ref <token>"), so a half-finished cart never spends anything.
 */
import './permissions';
import { registerDemoFeature } from '../../data/demo/features';
import { isIntroEligible } from '../../domain/rules';
import { addDays, money, studioDate } from '../../shared/format';
import type { Client, ID, ISODate, ISODateTime, Product, Sale } from '../../shared/types';
import type {
  AdjustStockInput, BuyGiftCardInput, CommerceSettings, CommerceStore, GiftCard, GiftCardDetail, GiftCardEntry, GiftCardLookup,
  HoldInput, HoldResult, MyReferral, Promo, PromoRedemption, PromoWithUsage, PurchaseWithCodesInput, Quote, QuoteInput,
  ReferralRow, ReferralStats, RetailItem, SellGiftCardInput, StockAdjustment, StockReport,
} from './types';
import {
  EMAIL_RE, HOLD_MINUTES, addMonthsIso, evaluatePromo, giftCardState, holdNote, holdRef, makeGiftCode, makeHoldToken,
  maskGiftCode, normaliseGiftCode, normalisePromoCode, priceCart, promoStatus, stockStatus, type GiftInput, type PromoLine,
} from './logic';

// ------------------------------------------------------------------------------------------------ slice
type Entry = GiftCardEntry & { token?: string };
interface CardRec extends Omit<GiftCard, 'balanceCents' | 'state'> { entries: Entry[] }
interface RedemptionRec { id: ID; promoId: ID; code: string; clientId?: ID; saleId?: ID; discountCents: number; at: ISODateTime; state: 'posted' | 'held'; token?: string }
interface RetailMeta { sku?: string; barcode?: string; lowStockAt?: number }
interface ReferralRec { id: ID; referrerClientId: ID; referredClientId: ID; status: 'pending' | 'rewarded'; createdAt: ISODateTime; rewardedAt?: ISODateTime; rewardCents?: number; cardId?: ID }
interface Slice {
  settings: CommerceSettings;
  cards: CardRec[];
  promos: Promo[];
  redemptions: RedemptionRec[];
  refCodes: Record<ID, string>;
  referrals: ReferralRec[];
  retail: Record<ID, RetailMeta>;
  stockLog: StockAdjustment[];
}

export function defaultSettings(slug?: string): CommerceSettings {
  const harbour = slug === 'harbour';
  return {
    giftCardAmounts: harbour ? [7500, 15000, 25000] : [5000, 10000, 15000], giftCardMinCents: harbour ? 5000 : 2000, giftCardMaxCents: 50000,
    giftCardExpiryMonths: 36, referralEnabled: true, referralRewardKind: 'credit', referralRewardCents: harbour ? 1500 : 1000, lowStockDefault: 5,
  };
}
const emptySlice = (slug?: string): Slice => ({ settings: defaultSettings(slug), cards: [], promos: [], redemptions: [], refCodes: {}, referrals: [], retail: {}, stockLog: [] });

const DAY = 86_400_000;
const REASONS = ['received', 'count', 'damaged', 'lost', 'returned', 'other'];

/** Small deterministic PRNG so a reseeded demo always has the same cards (and the same codes). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------------------------------------ seed
registerDemoFeature({
  name: 'commerce',
  seed: ({ studio, state, now }): Slice => {
    const slice = emptySlice(studio.slug);
    if (studio.slug !== 'snowy' && studio.slug !== 'harbour') return slice;
    const harbour = studio.slug === 'harbour';
    const rnd = mulberry(harbour ? 7117 : 5115);
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString();
    const dayOf = (daysFromNow: number): ISODate => addDays(studioDate(now), daysFromNow);
    const byName = (first: string) => state.clients.find((c) => c.firstName === first);
    const others = state.clients.filter((c) => !['Chloe', 'Hannah', 'Mia', 'Jess', 'Olive', 'Jack', 'Lucas', 'Priya'].includes(c.firstName));
    const other = (i: number): Client | undefined => (others.length ? others[i % others.length] : undefined);
    const nameOf = (c?: Client) => (c ? `${c.firstName} ${c.lastName}`.trim() : '');
    let n = 0;
    const id = (p: string) => `${p}_cm${(++n).toString(36)}${harbour ? 'h' : 's'}`;
    const codes = new Set<string>();
    const code = () => { let c = makeGiftCode(rnd); while (codes.has(c)) c = makeGiftCode(rnd); codes.add(c); return c; };
    const expiry = (daysAgo: number) => addMonthsIso(at(daysAgo), slice.settings.giftCardExpiryMonths);

    // ---- retail: SKUs and barcodes, plus low-stock items
    const addProduct = (p: Product) => { state.products.push(p); };
    if (harbour) {
      const socks = state.products.find((p) => p.id === 'hb_pr_socks');
      if (socks) socks.stock = 3;
      addProduct({ id: 'hb_pr_towel', kind: 'retail', name: 'Reformer towel', description: 'Quick-dry towel in a soft sand colour.', priceCents: 1800, stock: 14, active: true, sortOrder: 31 });
      addProduct({ id: 'hb_pr_bottle', kind: 'retail', name: 'Steel water bottle', description: 'Insulated, keeps water cold all class.', priceCents: 3200, stock: 10, active: true, sortOrder: 32 });
      slice.retail = {
        hb_pr_socks: { sku: 'HB-SOCK', barcode: '9300700020012' }, hb_pr_towel: { sku: 'HB-TOWEL', barcode: '9300700020029' }, hb_pr_bottle: { sku: 'HB-BOTTLE', barcode: '9300700020036', lowStockAt: 4 },
      };
    } else {
      const bottle = state.products.find((p) => p.id === 'pr_bottle');
      if (bottle) bottle.stock = 4;
      addProduct({ id: 'pr_tote', kind: 'retail', name: 'Canvas tote bag', description: 'Sturdy canvas tote for your gear.', priceCents: 2800, stock: 2, active: true, sortOrder: 32 });
      addProduct({ id: 'pr_ring', kind: 'retail', name: 'Pilates ring', description: 'Light resistance ring for mat work.', priceCents: 3500, stock: 9, active: true, sortOrder: 33 });
      slice.retail = {
        pr_socks: { sku: 'GRIP-SOCK', barcode: '9300600010016' }, pr_bottle: { sku: 'BOTTLE-INS', barcode: '9300600010023', lowStockAt: 5 },
        pr_tote: { sku: 'TOTE-CVS', barcode: '9300600010030', lowStockAt: 3 }, pr_ring: { sku: 'RING-LT', barcode: '9300600010047' },
      };
    }
    const owner = state.staff.find((s) => s.role === 'owner');
    const log = (productId: ID, productName: string, delta: number, after: number, reason: StockAdjustment['reason'], daysAgo: number, note?: string) => {
      slice.stockLog.push({ id: id('sl'), productId, productName, delta, before: after - delta, after, reason, ...(note ? { note } : {}), ...(owner ? { staffId: owner.id, staffName: owner.name } : {}), at: at(daysAgo) });
    };
    for (const p of state.products.filter((x) => x.kind === 'retail')) {
      if (p.stock == null) continue;
      if (p.id === 'pr_tote') { log(p.id, p.name, 12, 12, 'received', 41, 'First order in'); log(p.id, p.name, -2, 10, 'damaged', 20, 'Stitching came undone'); log(p.id, p.name, -8, 2, 'count', 6, 'Stocktake: counted 2 on the shelf'); }
      else if (p.id === 'pr_bottle') { log(p.id, p.name, 24, 24, 'received', 55, 'Opening stock'); log(p.id, p.name, -20, 4, 'count', 5, 'Stocktake'); }
      else if (p.id === 'hb_pr_socks') { log(p.id, p.name, 40, 40, 'received', 50, 'Opening stock'); log(p.id, p.name, -37, 3, 'count', 4, 'Stocktake'); }
      else log(p.id, p.name, p.stock, p.stock, 'received', 30 + Math.floor(rnd() * 20), 'Opening stock');
    }
    slice.stockLog.sort((a, b) => b.at.localeCompare(a.at));

    // ---- promo codes
    const packIds = harbour ? ['hb_pr_drop', 'hb_pr_p5', 'hb_pr_p10'] : ['pr_drop', 'pr_p4', 'pr_p8'];
    const welcome: Promo = { id: id('pm'), code: 'WELCOME10', description: 'New client welcome', kind: 'percent', value: 10, productIds: packIds, startsOn: dayOf(-60), endsOn: dayOf(180), maxUsesPerClient: 1, newClientsOnly: true, active: true, createdAt: at(60) };
    const seasonal: Promo = harbour
      ? { id: id('pm'), code: 'REFORM20', description: 'Autumn 10 pack offer', kind: 'amount', value: 2000, productIds: ['hb_pr_p10'], startsOn: dayOf(-10), endsOn: dayOf(24), maxUses: 40, newClientsOnly: false, active: true, createdAt: at(10) }
      : { id: id('pm'), code: 'SPRING5', description: 'Spring into it', kind: 'amount', value: 500, productIds: [], startsOn: dayOf(-14), endsOn: dayOf(20), maxUses: 50, newClientsOnly: false, active: true, createdAt: at(14) };
    const old: Promo = { id: id('pm'), code: 'WINTER20', description: 'Winter warm-up', kind: 'percent', value: 20, productIds: packIds, startsOn: dayOf(-95), endsOn: dayOf(-30), maxUses: 60, newClientsOnly: false, active: true, createdAt: at(95) };
    const paused: Promo = { id: id('pm'), code: 'FRIENDS15', description: 'Bring-a-friend week', kind: 'percent', value: 15, productIds: [], maxUsesPerClient: 1, newClientsOnly: false, active: false, createdAt: at(120) };
    slice.promos = [welcome, seasonal, old, paused];
    const useRows = (p: Promo, count: number, startAgo: number, spanDays: number, amounts: number[]) => {
      for (let i = 0; i < count; i++) {
        const c = other(i * 3 + p.code.length);
        slice.redemptions.push({ id: id('rd'), promoId: p.id, code: p.code, ...(c ? { clientId: c.id } : {}), discountCents: amounts[i % amounts.length] as number, at: at(startAgo - Math.floor((i / Math.max(1, count - 1)) * spanDays)), state: 'posted' });
      }
    };
    useRows(welcome, harbour ? 6 : 14, 52, 50, harbour ? [550, 1200, 1950] : [300, 1000, 1900]);
    useRows(seasonal, harbour ? 7 : 12, 12, 11, harbour ? [2000] : [500]);
    useRows(old, harbour ? 12 : 31, 90, 58, harbour ? [2400, 3900, 1500] : [2000, 3800, 600]);

    // ---- gift cards
    const a = other(2), b = other(5), c3 = other(8);
    const card = (r: Omit<CardRec, 'id' | 'code' | 'entries' | 'status' | 'kind'> & Partial<Pick<CardRec, 'status' | 'kind'>>, entries: Omit<Entry, 'id' | 'state'>[]): CardRec => {
      const rec: CardRec = { id: id('gc'), code: code(), status: 'active', kind: 'gift_card', ...r, entries: entries.map((e) => ({ id: id('ge'), state: 'posted' as const, ...e })) };
      slice.cards.push(rec);
      return rec;
    };
    const big = harbour ? 15000 : 10000;
    card({ source: 'purchase', initialCents: big, recipientName: harbour ? 'Georgia Lane' : 'Mel Anderson', recipientEmail: harbour ? 'georgia.lane@example.com' : 'mel.anderson@example.com',
      message: harbour ? 'Happy birthday G! First reformer class is on me.' : 'Happy birthday Mel! Can’t wait to see you on the mat.', fromName: a?.firstName ?? 'A friend',
      ...(a ? { purchaserClientId: a.id, purchaserName: nameOf(a) } : {}), sendOn: studioDate(new Date(at(20))), sentAt: at(20), createdAt: at(20), expiresAt: expiry(20) },
    [{ at: at(20), kind: 'issue', cents: big, note: 'Bought in the app' }, { at: at(8), kind: 'redeem', cents: -(harbour ? 4200 : 3000), note: harbour ? 'Single reformer class' : 'Single class' }]);
    card({ source: 'pos', initialCents: harbour ? 10000 : 5000, createdAt: at(9), expiresAt: expiry(9) }, [{ at: at(9), kind: 'issue', cents: harbour ? 10000 : 5000, note: 'Sold at the front desk (cash)' }]);
    card({ source: 'purchase', initialCents: harbour ? 25000 : 15000, recipientName: harbour ? 'Ellie Marsh' : 'Anna Lowe', recipientEmail: harbour ? 'ellie.marsh@example.com' : 'anna.lowe@example.com',
      message: 'Treat yourself. You’ve earned it.', fromName: b?.firstName ?? 'A friend', ...(b ? { purchaserClientId: b.id, purchaserName: nameOf(b) } : {}),
      sendOn: dayOf(5), createdAt: at(2), expiresAt: expiry(2) }, [{ at: at(2), kind: 'issue', cents: harbour ? 25000 : 15000, note: 'Bought in the app' }]);
    card({ source: 'purchase', initialCents: 3000, recipientName: 'Tom Ellis', recipientEmail: 'tom.ellis@example.com', message: 'Thanks for everything!', fromName: c3?.firstName ?? 'A friend',
      ...(c3 ? { purchaserClientId: c3.id, purchaserName: nameOf(c3) } : {}), sendOn: studioDate(new Date(at(45))), sentAt: at(45), createdAt: at(45), expiresAt: expiry(45) },
    [{ at: at(45), kind: 'issue', cents: 3000, note: 'Bought in the app' }, { at: at(30), kind: 'redeem', cents: -3000, note: 'Used on a class pack' }]);
    card({ source: 'studio', status: 'void', initialCents: 2500, recipientName: 'Duplicate order', createdAt: at(30), expiresAt: expiry(30) },
      [{ at: at(30), kind: 'issue', cents: 2500, note: 'Bought twice by mistake' }, { at: at(29), kind: 'void', cents: -2500, note: 'Voided: duplicate purchase, refunded' }]);
    card({ source: 'pos', initialCents: 2000, createdAt: addMonthsIso(at(0), -37), expiresAt: addMonthsIso(at(0), -1) }, [{ at: addMonthsIso(at(0), -37), kind: 'issue', cents: 2000, note: 'Sold at the front desk' }]);

    // ---- referrals: the member persona has earned a credit, and the brand-new persona was referred by her
    const member = byName(harbour ? 'Jack' : 'Hannah');
    const newbie = byName(harbour ? 'Olive' : 'Chloe');
    const friend = byName(harbour ? 'Lucas' : 'Mia');
    const reward = slice.settings.referralRewardCents;
    const refCodeFor = (c: Client) => `${c.firstName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)}-${makeGiftCode(rnd).slice(0, 4)}`;
    if (member && friend) {
      slice.refCodes[member.id] = refCodeFor(member);
      const credit = card({ source: 'referral', kind: 'credit', initialCents: reward, ownerClientId: member.id, recipientName: nameOf(member), message: `Thanks for introducing ${friend.firstName}.`, createdAt: at(6), expiresAt: expiry(6) },
        [{ at: at(6), kind: 'issue', cents: reward, note: `Referral reward: ${nameOf(friend)} bought a first pass` }]);
      slice.referrals.push({ id: id('rf'), referrerClientId: member.id, referredClientId: friend.id, status: 'rewarded', createdAt: at(10), rewardedAt: at(6), rewardCents: reward, cardId: credit.id });
      if (newbie) slice.referrals.push({ id: id('rf'), referrerClientId: member.id, referredClientId: newbie.id, status: 'pending', createdAt: at(1) });
    }
    const second = other(6), third = other(7);
    if (second && third && second.id !== third.id) {
      slice.refCodes[second.id] = refCodeFor(second);
      const cr = card({ source: 'referral', kind: 'credit', initialCents: reward, ownerClientId: second.id, recipientName: nameOf(second), createdAt: at(25), expiresAt: expiry(25) },
        [{ at: at(25), kind: 'issue', cents: reward, note: `Referral reward: ${nameOf(third)} bought a first pass` }, { at: at(12), kind: 'redeem', cents: -reward, note: 'Used on a single class' }]);
      slice.referrals.push({ id: id('rf'), referrerClientId: second.id, referredClientId: third.id, status: 'rewarded', createdAt: at(32), rewardedAt: at(25), rewardCents: reward, cardId: cr.id });
    }
    slice.cards.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return slice;
  },

  create: (ctx): CommerceStore => {
    // ---------------------------------------------------------------- helpers
    const S = (): Slice => {
      const s = ctx.slice<Partial<Slice>>();
      const d = emptySlice(ctx.studio().slug);
      for (const k of Object.keys(d) as (keyof Slice)[]) if (s[k] === undefined) (s as Record<string, unknown>)[k] = d[k];
      return s as Slice;
    };
    const core = () => ctx.core();
    const now = () => ctx.now();
    const today = (): ISODate => studioDate(now());
    const err = ctx.error;
    const clientOf = (cid?: ID) => (cid ? core().state.clients.find((c) => c.id === cid) : undefined);
    const nameOf = (cid?: ID) => { const c = clientOf(cid); return c ? `${c.firstName} ${c.lastName}`.trim() : undefined; };
    const staffNameOf = (sid?: ID) => core().state.staff.find((s) => s.id === sid)?.name;
    const clientMe = () => { const u = ctx.me(); if (u.kind !== 'client') throw err('NOT_ALLOWED', 'Sign in as a client to do that.'); return u; };
    const requireStaff = (a: string) => ctx.requireStaff(a);

    const balanceOf = (c: CardRec) => c.entries.filter((e) => e.state !== 'released').reduce((n, e) => n + e.cents, 0);
    const toCard = (c: CardRec): GiftCard => {
      const { entries: _entries, ...rest } = c;
      const balanceCents = balanceOf(c);
      return { ...rest, balanceCents, state: giftCardState({ status: c.status, balanceCents, ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}) }, now()) };
    };
    const toDetail = (c: CardRec): GiftCardDetail => ({
      ...toCard(c),
      entries: c.entries.filter((e) => e.state !== 'released').map(({ token: _token, ...e }): GiftCardEntry => e).sort((a, b) => b.at.localeCompare(a.at)),
    });

    // ---------------------------------------------------------------- housekeeping (runs at the start of every call)
    /** Holds become real once their sale exists, and are dropped if nothing claims them in time (or when `drop` says the till is done). */
    function reconcile(drop?: string) {
      const s = S();
      const sales = core().state.sales;
      const t = now().getTime();
      const saleFor = (token?: string) => (token ? sales.find((x) => x.note?.includes(holdRef(token))) : undefined);
      const stale = (at: ISODateTime) => t - Date.parse(at) > HOLD_MINUTES * 60_000;
      for (const c of s.cards) {
        c.entries = c.entries.filter((e) => {
          if (e.state !== 'held') return true;
          const sale = saleFor(e.token);
          if (sale) {
            if (sale.method === 'comp') return false;
            e.state = 'posted'; e.saleId = sale.id; delete e.token;
            return true;
          }
          return !((drop && e.token === drop) || stale(e.at));
        });
      }
      s.redemptions = s.redemptions.filter((r) => {
        if (r.state !== 'held') return true;
        const sale = saleFor(r.token);
        if (sale) {
          if (sale.method === 'comp') return false;
          r.state = 'posted'; r.saleId = sale.id; delete r.token;
          return true;
        }
        return !((drop && r.token === drop) || stale(r.at));
      });
    }
    /** Scheduled gift card emails go out on their day (the demo just records the send). */
    function sendDue() {
      const s = S();
      for (const c of s.cards) {
        if (c.status === 'active' && c.recipientEmail && !c.sentAt && (!c.sendOn || c.sendOn <= today())) c.sentAt = now().toISOString();
      }
    }
    /** A referred friend's first paid pass earns the referrer their reward. */
    function settleReferrals() {
      const s = S();
      if (!s.settings.referralEnabled) return;
      const st = core().state;
      for (const r of s.referrals) {
        if (r.status !== 'pending') continue;
        const paid = st.passes
          .filter((p) => p.clientId === r.referredClientId && p.purchasedAt >= r.createdAt)
          .sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt))
          .find((p) => {
            const sale = st.sales.find((x) => x.id === st.passSale[p.id]);
            return sale ? sale.method !== 'comp' && sale.items.reduce((n, i) => n + i.unitCents * i.qty, 0) > 0 : p.priceCents > 0;
          });
        if (!paid) continue;
        const cents = s.settings.referralRewardCents;
        const friend = clientOf(r.referredClientId);
        const card = issue({
          source: 'referral', kind: s.settings.referralRewardKind === 'credit' ? 'credit' : 'gift_card', cents, ownerClientId: r.referrerClientId,
          recipientName: nameOf(r.referrerClientId) ?? 'Referrer', message: `Thanks for introducing ${friend?.firstName ?? 'a friend'}.`,
          note: `Referral reward: ${friend ? `${friend.firstName} ${friend.lastName}`.trim() : 'a friend'} bought a first pass`,
        });
        r.status = 'rewarded'; r.rewardedAt = now().toISOString(); r.rewardCents = cents; r.cardId = card.id;
      }
    }
    const tick = (drop?: string) => { reconcile(drop); sendDue(); settleReferrals(); };

    // ---------------------------------------------------------------- creating cards
    function uniqueCode(): string {
      const s = S();
      let c = makeGiftCode();
      while (s.cards.some((x) => x.code === c)) c = makeGiftCode();
      return c;
    }
    function issue(o: {
      source: CardRec['source']; kind?: CardRec['kind']; cents: number; note: string; recipientName?: string; recipientEmail?: string; message?: string;
      fromName?: string; purchaserClientId?: ID; ownerClientId?: ID; sendOn?: ISODate; saleId?: ID; staffId?: ID;
    }): CardRec {
      const s = S();
      const at = now().toISOString();
      const months = s.settings.giftCardExpiryMonths;
      const sendNow = !!o.recipientEmail && (!o.sendOn || o.sendOn <= today());
      const rec: CardRec = {
        id: ctx.newId('gc'), code: uniqueCode(), status: 'active', kind: o.kind ?? 'gift_card', source: o.source, initialCents: o.cents,
        ...(o.recipientName ? { recipientName: o.recipientName } : {}), ...(o.recipientEmail ? { recipientEmail: o.recipientEmail } : {}),
        ...(o.message ? { message: o.message } : {}), ...(o.fromName ? { fromName: o.fromName } : {}),
        ...(o.purchaserClientId ? { purchaserClientId: o.purchaserClientId, purchaserName: nameOf(o.purchaserClientId) ?? '' } : {}),
        ...(o.ownerClientId ? { ownerClientId: o.ownerClientId } : {}),
        ...(o.recipientEmail ? { sendOn: o.sendOn ?? today() } : {}), ...(sendNow ? { sentAt: at } : {}),
        createdAt: at, ...(months > 0 ? { expiresAt: addMonthsIso(at, months) } : {}), ...(o.saleId ? { saleId: o.saleId } : {}),
        entries: [{ id: ctx.newId('ge'), at, kind: 'issue', cents: o.cents, state: 'posted', note: o.note, ...(o.saleId ? { saleId: o.saleId } : {}), ...(o.staffId ? { staffId: o.staffId, staffName: staffNameOf(o.staffId) ?? '' } : {}) }],
      };
      s.cards.unshift(rec);
      return rec;
    }
    function validateNewCard(amountCents: number, email: string | undefined, sendOn: ISODate | undefined, message: string | undefined, recipientRequired: boolean, recipientName?: string) {
      const set = S().settings;
      if (!Number.isInteger(amountCents) || amountCents < set.giftCardMinCents || amountCents > set.giftCardMaxCents) {
        throw err('INVALID', `Gift cards are ${money(set.giftCardMinCents)} to ${money(set.giftCardMaxCents)}.`);
      }
      if (recipientRequired && !recipientName?.trim()) throw err('INVALID', 'Who is the gift card for?');
      if (email && !EMAIL_RE.test(email.trim())) throw err('INVALID', 'That email address doesn’t look right.');
      if (recipientRequired && !email?.trim()) throw err('INVALID', 'Add the email address to send it to.');
      if (sendOn && !/^\d{4}-\d{2}-\d{2}$/.test(sendOn)) throw err('INVALID', 'Choose a valid send date.');
      if (sendOn && sendOn < today()) throw err('INVALID', 'The send date can’t be in the past.');
      if (sendOn && sendOn > addDays(today(), 365)) throw err('INVALID', 'Choose a send date within the next year.');
      if ((message ?? '').length > 400) throw err('INVALID', 'Keep the message under 400 characters.');
    }
    function pushSale(o: { clientId?: ID; cents: number; method: Sale['method']; staffId?: ID; note: string }): Sale {
      const sale: Sale = {
        id: ctx.newId('sa'), items: [{ name: 'Gift card', qty: 1, unitCents: o.cents }], totalCents: o.cents, method: o.method, createdAt: now().toISOString(),
        ...(o.clientId ? { clientId: o.clientId } : {}), ...(o.staffId ? { staffId: o.staffId } : {}), note: o.note,
      };
      core().state.sales.push(sale);
      return sale;
    }

    // ---------------------------------------------------------------- pricing a cart
    function priceLines(input: QuoteInput): { lines: PromoLine[]; subtotal: number } {
      const state = core().state;
      const lines: PromoLine[] = [];
      for (const it of input.items ?? []) {
        const p = state.products.find((x) => x.id === it.productId);
        if (!p || !p.active) throw err('NOT_FOUND', 'One of those products isn’t available.');
        const qty = Math.max(1, Math.floor(it.qty || 1));
        lines.push({ productId: p.id, cents: p.priceCents * qty });
      }
      const subtotal = lines.length ? lines.reduce((n, l) => n + l.cents, 0) : Math.max(0, Math.round(input.subtotalCents ?? 0));
      return { lines, subtotal };
    }
    function buildQuote(input: QuoteInput, clientId: ID | undefined, who: 'client' | 'staff'): Quote {
      const s = S();
      const { lines, subtotal } = priceLines(input);
      let promo: { id: ID; code: string; label: string; discountCents: number } | undefined;
      let promoError: string | undefined;
      const pc = normalisePromoCode(input.promoCode ?? '');
      if (pc) {
        const p = s.promos.find((x) => x.code === pc);
        const used = p ? s.redemptions.filter((r) => r.promoId === p.id) : [];
        const res = evaluatePromo(p, lines, lines.length ? undefined : subtotal, {
          today: today(), ...(clientId ? { clientId, isNewClient: isIntroEligible(clientId, core().state.passes) } : {}),
          usesTotal: used.length, usesByClient: clientId ? used.filter((r) => r.clientId === clientId).length : 0,
        }, who);
        if (res.ok && p) promo = { id: p.id, code: p.code, label: p.kind === 'percent' ? `${p.value}% off` : `${money(p.value)} off`, discountCents: res.discountCents };
        else if (!res.ok) promoError = res.message;
      }
      const gifts: GiftInput[] = [];
      for (const raw of input.giftCodes ?? []) {
        const code = normaliseGiftCode(raw);
        if (!code) { gifts.push({ code: (raw ?? '').trim().toUpperCase(), kind: 'gift_card', balanceCents: 0, error: 'That doesn’t look like a gift card code. They’re 12 letters and numbers.' }); continue; }
        const card = s.cards.find((c) => c.code === code);
        if (!card || (card.kind === 'credit' && card.ownerClientId !== clientId)) { gifts.push({ code, kind: 'gift_card', balanceCents: 0, error: 'We couldn’t find a gift card with that code.' }); continue; }
        const view = toCard(card);
        let error: string | undefined;
        if (view.state === 'void') error = 'That gift card has been voided.';
        else if (view.state === 'expired') error = 'That gift card has expired.';
        else if (view.state === 'used') error = 'That gift card has no balance left.';
        else if (view.state === 'pending') error = 'That gift card isn’t active yet.';
        gifts.push({ code, kind: card.kind, balanceCents: view.balanceCents, ...(error ? { error } : {}) });
      }
      return priceCart(subtotal, promo, promoError, gifts);
    }
    const quoteFor = (input: QuoteInput): { q: Quote; clientId?: ID } => {
      const u = ctx.me();
      if (u.kind === 'client') return { q: buildQuote(input, u.clientId, 'client'), clientId: u.clientId };
      requireStaff('commerce.sell');
      return { q: buildQuote(input, input.clientId, 'staff'), ...(input.clientId ? { clientId: input.clientId } : {}) };
    };
    /** Take the redemptions for a priced cart. state 'held' (till) or 'posted' (sale already made). */
    function record(q: Quote, o: { clientId?: ID; state: 'held' | 'posted'; token?: string; saleId?: ID; note?: string; staffId?: ID }) {
      const s = S();
      const at = now().toISOString();
      if (q.promo && q.promoCents > 0) {
        s.redemptions.push({ id: ctx.newId('rd'), promoId: q.promo.id, code: q.promo.code, ...(o.clientId ? { clientId: o.clientId } : {}), discountCents: q.promoCents, at, state: o.state, ...(o.token ? { token: o.token } : {}), ...(o.saleId ? { saleId: o.saleId } : {}) });
      }
      for (const g of q.gifts) {
        const card = s.cards.find((c) => c.code === g.code);
        if (!card) continue;
        card.entries.push({
          id: ctx.newId('ge'), at, kind: 'redeem', cents: -g.appliedCents, state: o.state, note: o.note ?? 'Used at checkout',
          ...(o.token ? { token: o.token } : {}), ...(o.saleId ? { saleId: o.saleId } : {}), ...(o.clientId ? { clientId: o.clientId } : {}),
          ...(o.staffId ? { staffId: o.staffId, staffName: staffNameOf(o.staffId) ?? '' } : {}),
        });
      }
    }

    // ---------------------------------------------------------------- retail
    const meta = (productId: ID): RetailMeta => S().retail[productId] ?? {};
    const toItem = (p: Product): RetailItem => {
      const m = meta(p.id);
      const lowAt = m.lowStockAt ?? S().settings.lowStockDefault;
      return {
        productId: p.id, name: p.name, priceCents: p.priceCents, active: p.active, stock: p.stock ?? null, ...(m.sku ? { sku: m.sku } : {}), ...(m.barcode ? { barcode: m.barcode } : {}),
        lowAt, ...(m.lowStockAt != null ? { lowStockAt: m.lowStockAt } : {}), status: stockStatus(p.stock, lowAt),
      };
    };
    const retailProduct = (pid: ID): Product => {
      const p = core().state.products.find((x) => x.id === pid && x.kind === 'retail');
      if (!p) throw err('NOT_FOUND', 'We couldn’t find that product.');
      return p;
    };

    // ---------------------------------------------------------------- referrals
    function refCode(clientId: ID): string {
      const s = S();
      const existing = s.refCodes[clientId];
      if (existing) return existing;
      const c = clientOf(clientId);
      const base = (c?.firstName ?? 'FRIEND').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'FRIEND';
      let code = `${base}-${makeGiftCode().slice(0, 4)}`;
      while (Object.values(s.refCodes).includes(code)) code = `${base}-${makeGiftCode().slice(0, 4)}`;
      s.refCodes[clientId] = code;
      return code;
    }
    const refRow = (r: ReferralRec): ReferralRow => ({
      id: r.id, referrerClientId: r.referrerClientId, referrerName: nameOf(r.referrerClientId) ?? 'Former client', referredClientId: r.referredClientId,
      referredName: nameOf(r.referredClientId) ?? 'Former client', status: r.status, createdAt: r.createdAt, ...(r.rewardedAt ? { rewardedAt: r.rewardedAt } : {}),
      ...(r.rewardCents != null ? { rewardCents: r.rewardCents } : {}),
    });

    // ---------------------------------------------------------------- the store
    return {
      // ---- settings
      getSettings: () => ctx.read(() => { ctx.me(); return { ...S().settings }; }),
      updateSettings: (patch) => ctx.write(() => {
        requireStaff('commerce.manage');
        const s = S();
        const next = { ...s.settings, ...patch };
        const amounts = [...new Set((next.giftCardAmounts ?? []).map((n) => Math.round(Number(n))))].filter((n) => n > 0).sort((a, b) => a - b);
        if (amounts.length === 0 || amounts.length > 6) throw err('INVALID', 'Add between one and six gift card amounts.');
        if (!(next.giftCardMinCents > 0) || next.giftCardMaxCents < next.giftCardMinCents) throw err('INVALID', 'The smallest gift card must be less than the largest.');
        if (amounts.some((a) => a < next.giftCardMinCents || a > next.giftCardMaxCents)) throw err('INVALID', 'The amount buttons must sit between the smallest and largest gift card.');
        if (!(next.giftCardExpiryMonths >= 0 && next.giftCardExpiryMonths <= 120)) throw err('INVALID', 'Expiry is between 0 (never) and 120 months.');
        if (!(next.referralRewardCents >= 0)) throw err('INVALID', 'The referral reward can’t be negative.');
        if (next.referralEnabled && next.referralRewardCents <= 0) throw err('INVALID', 'Set a referral reward above $0, or turn referrals off.');
        if (!['credit', 'gift_card'].includes(next.referralRewardKind)) throw err('INVALID', 'Choose how referral rewards are paid.');
        if (!(next.lowStockDefault >= 0)) throw err('INVALID', 'The low-stock level can’t be negative.');
        s.settings = { ...next, giftCardAmounts: amounts, lowStockDefault: Math.round(next.lowStockDefault) };
        return { ...s.settings };
      }),

      // ---- gift cards
      listGiftCards: () => ctx.read(() => {
        requireStaff('commerce.view');
        tick();
        return S().cards.map(toCard).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }),
      getGiftCard: (cardId) => ctx.read(() => {
        requireStaff('commerce.view');
        tick();
        const c = S().cards.find((x) => x.id === cardId);
        if (!c) throw err('NOT_FOUND', 'We couldn’t find that gift card.');
        return toDetail(c);
      }),
      lookupGiftCard: (raw) => ctx.read((): GiftCardLookup => {
        const u = ctx.me();
        if (u.kind === 'staff') requireStaff('commerce.sell');
        tick();
        const code = normaliseGiftCode(raw);
        const c = code ? S().cards.find((x) => x.code === code) : undefined;
        if (!c || (c.kind === 'credit' && !(u.kind === 'client' && c.ownerClientId === u.clientId))) throw err('NOT_FOUND', 'We couldn’t find a gift card with that code.');
        const v = toCard(c);
        return { code: c.code, state: v.state, balanceCents: v.balanceCents, kind: c.kind, ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}) };
      }),
      myGiftCards: () => ctx.read(() => {
        const u = clientMe();
        tick();
        const email = (clientOf(u.clientId)?.email ?? '').toLowerCase();
        return S().cards
          .filter((c) => c.purchaserClientId === u.clientId || c.ownerClientId === u.clientId || (!!email && c.recipientEmail?.toLowerCase() === email && c.status !== 'pending' && !!c.sentAt))
          .map(toCard).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }),
      buyGiftCard: (input: BuyGiftCardInput) => ctx.write(() => {
        const u = clientMe();
        tick();
        const sendOn = input.sendOn || today();
        validateNewCard(input.amountCents, input.recipientEmail, sendOn, input.message, true, input.recipientName);
        const me = clientOf(u.clientId);
        const sale = pushSale({ clientId: u.clientId, cents: input.amountCents, method: 'card_online', note: 'Gift card (online)' });
        const card = issue({
          source: 'purchase', cents: input.amountCents, recipientName: input.recipientName.trim(), recipientEmail: input.recipientEmail.trim(),
          ...(input.message?.trim() ? { message: input.message.trim() } : {}), fromName: (input.fromName?.trim() || me?.firstName || '').trim(),
          purchaserClientId: u.clientId, sendOn, saleId: sale.id, note: 'Bought in the app',
        });
        sale.note = `Gift card ${maskGiftCode(card.code)}`;
        return { card: toCard(card), sale };
      }),
      sellGiftCard: (input: SellGiftCardInput) => ctx.write(() => {
        const st = requireStaff('commerce.sell');
        tick();
        if (input.method === 'comp') requireStaff('commerce.manage');
        validateNewCard(input.amountCents, input.recipientEmail || undefined, input.sendOn, input.message, false);
        if (input.clientId && !clientOf(input.clientId)) throw err('NOT_FOUND', 'We couldn’t find that client.');
        const sale = input.method === 'comp' ? undefined : pushSale({ ...(input.clientId ? { clientId: input.clientId } : {}), cents: input.amountCents, method: input.method, staffId: st.id, note: 'Gift card' });
        const card = issue({
          source: input.method === 'comp' ? 'studio' : 'pos', cents: input.amountCents, ...(input.recipientName?.trim() ? { recipientName: input.recipientName.trim() } : {}),
          ...(input.recipientEmail?.trim() ? { recipientEmail: input.recipientEmail.trim() } : {}), ...(input.message?.trim() ? { message: input.message.trim() } : {}),
          ...(input.fromName?.trim() ? { fromName: input.fromName.trim() } : {}), ...(input.clientId ? { purchaserClientId: input.clientId } : {}),
          ...(input.sendOn ? { sendOn: input.sendOn } : {}), ...(sale ? { saleId: sale.id } : {}), staffId: st.id,
          note: input.method === 'comp' ? 'Complimentary card from the studio' : `Sold at the front desk (${input.method === 'cash' ? 'cash' : 'card'})`,
        });
        if (sale) sale.note = `Gift card ${maskGiftCode(card.code)}`;
        return { card: toCard(card), ...(sale ? { sale } : {}) };
      }),
      voidGiftCard: (cardId, reason) => ctx.write(() => {
        const st = requireStaff('commerce.manage');
        tick();
        const c = S().cards.find((x) => x.id === cardId);
        if (!c) throw err('NOT_FOUND', 'We couldn’t find that gift card.');
        if (c.status === 'void') throw err('INVALID', 'That gift card is already voided.');
        if (!reason?.trim()) throw err('INVALID', 'Add a reason so there’s a record of why.');
        const bal = balanceOf(c);
        c.status = 'void';
        c.entries.push({ id: ctx.newId('ge'), at: now().toISOString(), kind: 'void', cents: -Math.max(0, bal), state: 'posted', note: `Voided: ${reason.trim()}`, staffId: st.id, staffName: st.name });
        return toDetail(c);
      }),
      adjustGiftCard: (cardId, deltaCents, reason) => ctx.write(() => {
        const st = requireStaff('commerce.manage');
        tick();
        const c = S().cards.find((x) => x.id === cardId);
        if (!c) throw err('NOT_FOUND', 'We couldn’t find that gift card.');
        if (c.status !== 'active') throw err('INVALID', 'Only active gift cards can be adjusted.');
        if (!Number.isInteger(deltaCents) || deltaCents === 0) throw err('INVALID', 'Enter an amount to add or take off.');
        if (!reason?.trim()) throw err('INVALID', 'Add a reason so there’s a record of why.');
        if (balanceOf(c) + deltaCents < 0) throw err('INVALID', `That would take the balance below $0. There’s ${money(balanceOf(c), { cents: true })} on it.`);
        c.entries.push({ id: ctx.newId('ge'), at: now().toISOString(), kind: 'adjust', cents: deltaCents, state: 'posted', note: reason.trim(), staffId: st.id, staffName: st.name });
        return toDetail(c);
      }),
      resendGiftCard: (cardId, email) => ctx.write(() => {
        requireStaff('commerce.sell');
        tick();
        const c = S().cards.find((x) => x.id === cardId);
        if (!c) throw err('NOT_FOUND', 'We couldn’t find that gift card.');
        if (c.status !== 'active') throw err('INVALID', 'Only active gift cards can be sent.');
        const to = (email ?? c.recipientEmail ?? '').trim();
        if (!EMAIL_RE.test(to)) throw err('INVALID', 'Add an email address to send it to.');
        c.recipientEmail = to;
        c.sentAt = now().toISOString();
        return toCard(c);
      }),

      // ---- promo codes
      listPromos: () => ctx.read(() => {
        requireStaff('commerce.view');
        tick();
        const s = S();
        const t = today();
        return s.promos.map((p): PromoWithUsage => {
          const used = s.redemptions.filter((r) => r.promoId === p.id && r.state === 'posted');
          const claimed = s.redemptions.filter((r) => r.promoId === p.id).length;
          const last = used.map((r) => r.at).sort().pop();
          return { ...p, status: promoStatus(p, t, claimed), uses: used.length, discountCents: used.reduce((n, r) => n + r.discountCents, 0), ...(last ? { lastUsedAt: last } : {}) };
        }).sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
      }),
      upsertPromo: (input) => ctx.write(() => {
        requireStaff('commerce.manage');
        const s = S();
        const code = normalisePromoCode(input.code);
        if (code.length < 3 || code.length > 20) throw err('INVALID', 'Codes are 3 to 20 letters or numbers, like WELCOME10.');
        if (s.promos.some((p) => p.code === code && p.id !== input.id)) throw err('INVALID', 'There’s already a code with that name.');
        if (input.kind === 'percent' ? !(Number.isInteger(input.value) && input.value >= 1 && input.value <= 100) : !(Number.isInteger(input.value) && input.value > 0)) {
          throw err('INVALID', input.kind === 'percent' ? 'Percent off is between 1 and 100.' : 'Enter a dollar amount above $0.');
        }
        if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw err('INVALID', 'The end date is before the start date.');
        for (const k of ['maxUses', 'maxUsesPerClient'] as const) {
          const v = input[k];
          if (v != null && !(Number.isInteger(v) && v >= 1)) throw err('INVALID', 'Limits need to be a whole number of 1 or more.');
        }
        const productIds = [...new Set(input.productIds ?? [])];
        for (const pid of productIds) if (!core().state.products.some((p) => p.id === pid)) throw err('NOT_FOUND', 'One of those products no longer exists.');
        const clean = {
          code, kind: input.kind, value: input.value, productIds, newClientsOnly: !!input.newClientsOnly, active: !!input.active,
          ...(input.description?.trim() ? { description: input.description.trim() } : {}), ...(input.startsOn ? { startsOn: input.startsOn } : {}), ...(input.endsOn ? { endsOn: input.endsOn } : {}),
          ...(input.maxUses != null ? { maxUses: input.maxUses } : {}), ...(input.maxUsesPerClient != null ? { maxUsesPerClient: input.maxUsesPerClient } : {}),
        };
        const existing = input.id ? s.promos.find((p) => p.id === input.id) : undefined;
        if (input.id && !existing) throw err('NOT_FOUND', 'We couldn’t find that promo code.');
        if (existing) {
          for (const k of Object.keys(existing) as (keyof Promo)[]) if (k !== 'id' && k !== 'createdAt') delete (existing as unknown as Record<string, unknown>)[k];
          Object.assign(existing, clean);
          for (const r of s.redemptions) if (r.promoId === existing.id) r.code = code;
          return { ...existing };
        }
        const p: Promo = { id: ctx.newId('pm'), createdAt: now().toISOString(), ...clean };
        s.promos.push(p);
        return { ...p };
      }),
      promoRedemptions: (promoId) => ctx.read(() => {
        requireStaff('commerce.view');
        tick();
        return S().redemptions.filter((r) => r.state === 'posted' && (!promoId || r.promoId === promoId))
          .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
          .map((r): PromoRedemption => ({ id: r.id, promoId: r.promoId, code: r.code, ...(r.clientId ? { clientId: r.clientId, clientName: nameOf(r.clientId) ?? 'Former client' } : {}), ...(r.saleId ? { saleId: r.saleId } : {}), discountCents: r.discountCents, at: r.at }));
      }),

      // ---- using codes
      quote: (input) => ctx.read(() => { tick(); return quoteFor(input).q; }),
      holdCodes: (input: HoldInput) => ctx.write((): HoldResult => {
        requireStaff('commerce.sell');
        if (input.token && !/^h[a-z0-9]{6,12}$/.test(input.token)) throw err('INVALID', 'That till reference isn’t valid.');
        tick(input.token);
        const token = input.token ?? makeHoldToken();
        const { q, clientId } = quoteFor(input);
        record(q, { ...(clientId ? { clientId } : {}), state: 'held', token, note: 'Held at the till' });
        return { token, quote: q, note: holdNote(q, token) };
      }),
      settleHold: (token) => ctx.write(() => { requireStaff('commerce.sell'); tick(token); }),
      purchaseWithCodes: (input: PurchaseWithCodesInput) => ctx.write(() => {
        const u = clientMe();
        tick();
        const q = buildQuote({ items: [{ productId: input.productId, qty: 1 }], ...(input.promoCode ? { promoCode: input.promoCode } : {}), ...(input.giftCodes?.length ? { giftCodes: input.giftCodes } : {}) }, u.clientId, 'client');
        if (q.promoError) throw err('INVALID', q.promoError);
        if (q.giftErrors[0]) throw err('INVALID', q.giftErrors[0].message);
        const note = holdNote(q, makeHoldToken());
        const { sale } = core().engine.checkout({
          clientId: u.clientId, items: [{ productId: input.productId, qty: 1 }], method: 'card_online',
          ...(q.promoCents + q.giftCents > 0 ? { discountCents: q.promoCents + q.giftCents } : {}), ...(note ? { note } : {}),
        });
        record(q, { clientId: u.clientId, state: 'posted', saleId: sale.id, note: `Used on ${sale.items[0]?.name ?? 'a purchase'}` });
        settleReferrals();
        return { sale, quote: q };
      }),

      // ---- referrals
      myReferral: () => ctx.read((): MyReferral => {
        const u = clientMe();
        tick();
        const s = S();
        const mine = s.referrals.filter((r) => r.referrerClientId === u.clientId);
        const by = s.referrals.find((r) => r.referredClientId === u.clientId);
        const referredBy = by ? clientOf(by.referrerClientId)?.firstName : undefined;
        return {
          enabled: s.settings.referralEnabled, code: refCode(u.clientId), rewardKind: s.settings.referralRewardKind, rewardCents: s.settings.referralRewardCents,
          referrals: mine.map((r) => ({ name: clientOf(r.referredClientId)?.firstName ?? 'A friend', status: r.status, at: r.createdAt })).sort((a, b) => b.at.localeCompare(a.at)),
          earnedCents: mine.reduce((n, r) => n + (r.rewardCents ?? 0), 0), ...(referredBy ? { referredBy } : {}),
        };
      }),
      claimReferral: (raw) => ctx.write(() => {
        const u = clientMe();
        tick();
        const s = S();
        if (!s.settings.referralEnabled) throw err('INVALID', 'Referrals aren’t running at the moment.');
        const code = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
        const referrerId = Object.entries(s.refCodes).find(([, c]) => c === code)?.[0];
        if (!code || !referrerId) throw err('NOT_FOUND', 'We couldn’t find that referral code. Check it with your friend.');
        if (referrerId === u.clientId) throw err('INVALID', 'That’s your own code. Share it with a friend instead.');
        if (s.referrals.some((r) => r.referredClientId === u.clientId)) throw err('INVALID', 'You’ve already joined with a friend’s code.');
        if (!isIntroEligible(u.clientId, core().state.passes)) throw err('INVALID', 'Referral codes are for new clients, and you’ve already had a pass.');
        s.referrals.push({ id: ctx.newId('rf'), referrerClientId: referrerId, referredClientId: u.clientId, status: 'pending', createdAt: now().toISOString() });
        return { referrerName: clientOf(referrerId)?.firstName ?? 'your friend' };
      }),
      referralStats: () => ctx.read((): ReferralStats => {
        requireStaff('commerce.view');
        tick();
        const s = S();
        const byRef = new Map<ID, { referrals: number; rewarded: number }>();
        for (const r of s.referrals) {
          const x = byRef.get(r.referrerClientId) ?? { referrals: 0, rewarded: 0 };
          x.referrals++; if (r.status === 'rewarded') x.rewarded++;
          byRef.set(r.referrerClientId, x);
        }
        return {
          enabled: s.settings.referralEnabled, rewardKind: s.settings.referralRewardKind, rewardCents: s.settings.referralRewardCents,
          referrals: s.referrals.length, rewarded: s.referrals.filter((r) => r.status === 'rewarded').length, pending: s.referrals.filter((r) => r.status === 'pending').length,
          rewardCentsPaid: s.referrals.reduce((n, r) => n + (r.rewardCents ?? 0), 0),
          top: [...byRef.entries()].map(([clientId, v]) => ({ clientId, name: nameOf(clientId) ?? 'Former client', ...v })).sort((a, b) => b.rewarded - a.rewarded || b.referrals - a.referrals).slice(0, 5),
          recent: [...s.referrals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12).map(refRow),
        };
      }),

      // ---- retail stock
      listRetail: () => ctx.read(() => {
        requireStaff('commerce.stock');
        return core().state.products.filter((p) => p.kind === 'retail').map(toItem).sort((a, b) => a.name.localeCompare(b.name));
      }),
      updateRetail: (productId, patch) => ctx.write(() => {
        requireStaff('commerce.stock');
        const p = retailProduct(productId);
        const s = S();
        const m = (s.retail[productId] ??= {});
        for (const f of ['sku', 'barcode'] as const) {
          if (patch[f] === undefined) continue;
          const v = (patch[f] ?? '').trim();
          if (!v) { delete m[f]; continue; }
          if (v.length > 40) throw err('INVALID', 'Keep that under 40 characters.');
          if (Object.entries(s.retail).some(([pid, x]) => pid !== productId && x[f]?.toLowerCase() === v.toLowerCase())) {
            throw err('INVALID', `Another product already has that ${f === 'sku' ? 'SKU' : 'barcode'}.`);
          }
          m[f] = v;
        }
        if (patch.lowStockAt !== undefined) {
          if (patch.lowStockAt === null) delete m.lowStockAt;
          else if (Number.isInteger(patch.lowStockAt) && patch.lowStockAt >= 0) m.lowStockAt = patch.lowStockAt;
          else throw err('INVALID', 'The low-stock level is a whole number, 0 or more.');
        }
        return toItem(p);
      }),
      adjustStock: (input: AdjustStockInput) => ctx.write(() => {
        const st = requireStaff('commerce.stock');
        const p = retailProduct(input.productId);
        if (!REASONS.includes(input.reason)) throw err('INVALID', 'Choose a reason.');
        if ((input.delta === undefined) === (input.setTo === undefined)) throw err('INVALID', 'Enter how many to add or take off, or the new count.');
        let after: number;
        if (input.setTo !== undefined) {
          if (!Number.isInteger(input.setTo) || input.setTo < 0) throw err('INVALID', 'The count is a whole number, 0 or more.');
          after = input.setTo;
        } else {
          if (p.stock == null) throw err('INVALID', 'Stock isn’t tracked for this product yet. Do a stocktake to set the first count.');
          const delta = input.delta as number;
          if (!Number.isInteger(delta) || delta === 0) throw err('INVALID', 'Enter how many to add or take off.');
          after = p.stock + delta;
          if (after < 0) throw err('INVALID', `There are only ${p.stock} in stock.`);
        }
        const before = p.stock ?? 0;
        if (after === p.stock) throw err('INVALID', 'That’s the same as the current count.');
        p.stock = after;
        S().stockLog.unshift({
          id: ctx.newId('sl'), productId: p.id, productName: p.name, delta: after - before, before, after, reason: input.reason,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}), staffId: st.id, staffName: st.name, at: now().toISOString(),
        });
        return toItem(p);
      }),
      stockLog: (opts) => ctx.read(() => {
        requireStaff('commerce.stock');
        return S().stockLog.filter((l) => !opts?.productId || l.productId === opts.productId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts?.limit ?? 100);
      }),
      findRetail: (raw) => ctx.read(() => {
        requireStaff('commerce.sell');
        const code = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase();
        if (!code) return null;
        const s = S();
        const hit = core().state.products.find((p) => p.kind === 'retail' && p.active && (s.retail[p.id]?.barcode?.toLowerCase() === code || s.retail[p.id]?.sku?.toLowerCase() === code));
        return hit ? toItem(hit) : null;
      }),
      stockReport: (range) => ctx.read((): StockReport => {
        requireStaff('commerce.stock');
        const s = S();
        const st = core().state;
        const inRange = (iso: ISODateTime) => { const d = studioDate(iso); return d >= range.from && d <= range.to; };
        const sold = new Map<ID, number>();
        for (const sale of st.sales) if (inRange(sale.createdAt)) for (const it of sale.items) if (it.productId) sold.set(it.productId, (sold.get(it.productId) ?? 0) + it.qty);
        const rows = st.products.filter((p) => p.kind === 'retail').map((p) => {
          const item = toItem(p);
          const entries = s.stockLog.filter((l) => l.productId === p.id && inRange(l.at));
          return {
            productId: p.id, name: p.name, ...(item.sku ? { sku: item.sku } : {}), onHand: p.stock ?? null, valueCents: (p.stock ?? 0) * p.priceCents,
            sold: sold.get(p.id) ?? 0, received: entries.filter((l) => l.reason === 'received' && l.delta > 0).reduce((n, l) => n + l.delta, 0),
            writtenOff: entries.filter((l) => (l.reason === 'damaged' || l.reason === 'lost') && l.delta < 0).reduce((n, l) => n - l.delta, 0), status: item.status,
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return {
          from: range.from, to: range.to, rows,
          totals: {
            units: rows.reduce((n, r) => n + (r.onHand ?? 0), 0), valueCents: rows.reduce((n, r) => n + r.valueCents, 0), sold: rows.reduce((n, r) => n + r.sold, 0),
            low: rows.filter((r) => r.status === 'low').length, out: rows.filter((r) => r.status === 'out').length,
          },
        };
      }),
    };
  },
});
