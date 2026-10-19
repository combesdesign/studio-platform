// Commerce (B3): gift cards, promo codes, referral rewards and retail stock. The pure rules (logic.ts) and the demo store
// for both demo studios, including that each studio keeps its own gift cards, codes and stock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { addDays, studioDate } from '../src/shared/format';
import type { AuthUser, Client, Product } from '../src/shared/types';
import type { DataStore } from '../src/shared/store';
import {
  addMonthsIso, cleanScan, evaluatePromo, giftCardState, holdNote, makeGiftCode, normaliseGiftCode, normalisePromoCode, priceCart, promoStatus, stockStatus,
} from '../src/features/commerce/logic';
import type { CommerceStore, Promo } from '../src/features/commerce/types';

// ---------------------------------------------------------------- the rules, with no store
const promo = (over: Partial<Promo> = {}): Promo => ({
  id: 'p1', code: 'TEST', kind: 'percent', value: 10, productIds: [], newClientsOnly: false, active: true, createdAt: '2026-01-01T00:00:00.000Z', ...over,
});
const ctx = (over: Partial<Parameters<typeof evaluatePromo>[3]> = {}) => ({ today: '2026-10-19', clientId: 'c1', isNewClient: true, usesTotal: 0, usesByClient: 0, ...over });
const bad = (r: ReturnType<typeof evaluatePromo>): string => (r.ok ? 'ok' : r.message);

test('codes: gift card codes are forgiving to type and never misheard', () => {
  const code = makeGiftCode(() => 0.5);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normaliseGiftCode('abcd efgh 1234'), 'ABCD-EFGH-1234');
  assert.equal(normaliseGiftCode('oi1l-0000-0000'), '0111-0000-0000', 'O reads as 0, I and L as 1');
  assert.equal(normaliseGiftCode('ABCD-EFGH-123'), '', 'too short is not a code');
  assert.equal(normaliseGiftCode('ABCD-EFGH-123U'), '', 'U is not in the alphabet');
  assert.equal(normalisePromoCode(' welcome 10!'), 'WELCOME10');
});

test('gift cards: state comes from status, balance and expiry', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const s = (status: 'active' | 'void' | 'pending', balanceCents: number, expiresAt?: string) => giftCardState({ status, balanceCents, ...(expiresAt ? { expiresAt } : {}) }, now);
  assert.equal(s('active', 5000, '2029-10-19T00:00:00Z'), 'active');
  assert.equal(s('active', 0, '2029-10-19T00:00:00Z'), 'used');
  assert.equal(s('active', 5000, '2026-10-18T00:00:00Z'), 'expired');
  assert.equal(s('void', 5000), 'void');
  assert.equal(s('pending', 5000), 'pending');
  assert.equal(addMonthsIso('2026-08-31T00:00:00.000Z', 6), '2027-02-28T00:00:00.000Z', 'month ends are clamped, not rolled over');
});

test('gift cards: a card pays what it has and the rest is left to pay (partial redemption)', () => {
  const q = priceCart(10000, undefined, undefined, [{ code: 'AAAA-AAAA-AAAA', kind: 'gift_card', balanceCents: 4000 }]);
  assert.equal(q.giftCents, 4000);
  assert.equal(q.totalCents, 6000);
  assert.equal(q.gifts[0]!.appliedCents, 4000);
  // a card with more than the bill only pays the bill; two cards pay in the order given
  const two = priceCart(5000, undefined, undefined, [
    { code: 'AAAA-AAAA-AAAA', kind: 'credit', balanceCents: 1500 }, { code: 'BBBB-BBBB-BBBB', kind: 'gift_card', balanceCents: 9000 }, { code: 'CCCC-CCCC-CCCC', kind: 'gift_card', balanceCents: 500 },
  ]);
  assert.deepEqual(two.gifts.map((g) => [g.code, g.appliedCents]), [['AAAA-AAAA-AAAA', 1500], ['BBBB-BBBB-BBBB', 3500]]);
  assert.equal(two.totalCents, 0);
  assert.match(two.giftErrors[0]!.message, /Nothing left to pay/, 'a card that isn\'t needed is not used');
  // the promo comes off first, then cards; a bad card is reported and spends nothing; the same card twice counts once
  const withPromo = priceCart(10000, { id: 'p', code: 'X', label: '10% off', discountCents: 1000 }, undefined, [
    { code: 'AAAA-AAAA-AAAA', kind: 'gift_card', balanceCents: 2000 }, { code: 'AAAA-AAAA-AAAA', kind: 'gift_card', balanceCents: 2000 }, { code: 'ZZZZ-ZZZZ-ZZZZ', kind: 'gift_card', balanceCents: 0, error: 'Expired' },
  ]);
  assert.equal(withPromo.promoCents, 1000);
  assert.equal(withPromo.giftCents, 2000);
  assert.equal(withPromo.totalCents, 7000);
  assert.deepEqual(withPromo.giftErrors, [{ code: 'ZZZZ-ZZZZ-ZZZZ', message: 'Expired' }]);
});

test('promo codes: expiry, start date, paused and used up', () => {
  const lines = [{ productId: 'pack', cents: 10000 }];
  assert.equal(evaluatePromo(promo({ endsOn: '2026-10-19' }), lines, undefined, ctx()).ok, true, 'the end date itself still works');
  assert.equal(bad(evaluatePromo(promo({ endsOn: '2026-10-18' }), lines, undefined, ctx())), 'That code has expired.');
  assert.match(bad(evaluatePromo(promo({ startsOn: '2026-11-05' }), lines, undefined, ctx())), /^That code starts on/);
  assert.equal(bad(evaluatePromo(promo({ active: false }), lines, undefined, ctx())), 'That code isn’t valid.');
  assert.equal(bad(evaluatePromo(undefined, lines, undefined, ctx())), 'That code isn’t valid.');
  assert.equal(bad(evaluatePromo(promo({ maxUses: 5 }), lines, undefined, ctx({ usesTotal: 5 }))), 'That code has been fully claimed.');
  assert.equal(evaluatePromo(promo({ maxUses: 5 }), lines, undefined, ctx({ usesTotal: 4 })).ok, true);
  assert.equal(promoStatus(promo({ endsOn: '2026-10-18' }), '2026-10-19', 0), 'expired');
  assert.equal(promoStatus(promo({ startsOn: '2026-10-20' }), '2026-10-19', 0), 'scheduled');
  assert.equal(promoStatus(promo({ maxUses: 2 }), '2026-10-19', 2), 'used_up');
  assert.equal(promoStatus(promo({ active: false }), '2026-10-19', 0), 'paused');
  assert.equal(promoStatus(promo(), '2026-10-19', 0), 'live');
});

test('promo codes: per client limits and new clients only', () => {
  const lines = [{ productId: 'pack', cents: 10000 }];
  const newOnly = promo({ newClientsOnly: true });
  assert.equal(evaluatePromo(newOnly, lines, undefined, ctx()).ok, true);
  assert.match(bad(evaluatePromo(newOnly, lines, undefined, ctx({ isNewClient: false }))), /new clients only/);
  assert.equal(bad(evaluatePromo(newOnly, lines, undefined, ctx({ isNewClient: false }), 'staff')), 'That code is for new clients only.');
  assert.equal(bad(evaluatePromo(newOnly, lines, undefined, { today: '2026-10-19', usesTotal: 0, usesByClient: 0 }, 'staff')), 'Add a client to use this code.', 'the till needs a client for a client-only code');
  assert.equal(bad(evaluatePromo(newOnly, lines, undefined, { today: '2026-10-19', usesTotal: 0, usesByClient: 0 })), 'Sign in to use this code.');
  const once = promo({ maxUsesPerClient: 1 });
  assert.equal(evaluatePromo(once, lines, undefined, ctx({ usesByClient: 0 })).ok, true);
  assert.equal(bad(evaluatePromo(once, lines, undefined, ctx({ usesByClient: 1 }))), 'You’ve already used that code.');
  assert.equal(bad(evaluatePromo(once, lines, undefined, ctx({ usesByClient: 1 }), 'staff')), 'This client has already used that code.');
});

test('promo codes: per product, percent and amount, never more than the cart', () => {
  const lines = [{ productId: 'pack', cents: 10000 }, { productId: 'socks', cents: 2000 }];
  const pct = evaluatePromo(promo({ value: 15 }), lines, undefined, ctx());
  assert.deepEqual(pct, { ok: true, discountCents: 1800 }, '15% of $120');
  const onlyPack = evaluatePromo(promo({ value: 10, productIds: ['pack'] }), lines, undefined, ctx());
  assert.deepEqual(onlyPack, { ok: true, discountCents: 1000 }, 'only the listed product counts');
  assert.equal(bad(evaluatePromo(promo({ productIds: ['membership'] }), lines, undefined, ctx())), 'That code doesn’t apply to anything in this cart.');
  assert.match(bad(evaluatePromo(promo({ productIds: ['pack'] }), [], 5000, ctx())), /only applies to certain products/, 'no lines, so a product-limited code can\'t apply');
  assert.deepEqual(evaluatePromo(promo({ kind: 'amount', value: 99999 }), [], 3000, ctx()), { ok: true, discountCents: 3000 }, '$ off is capped at the cart');
  assert.deepEqual(evaluatePromo(promo({ value: 33 }), [], 1000, ctx()), { ok: true, discountCents: 330 });
});

test('retail: stock status and scanner input', () => {
  assert.equal(stockStatus(null, 5), 'untracked');
  assert.equal(stockStatus(0, 5), 'out');
  assert.equal(stockStatus(5, 5), 'low');
  assert.equal(stockStatus(6, 5), 'ok');
  assert.equal(cleanScan('\u0002 9300600010016\r\n'), '9300600010016');
});

test('till holds: the note carries the reference that finds the sale', () => {
  const q = priceCart(5000, { id: 'p', code: 'WELCOME10', label: '10% off', discountCents: 500 }, undefined, [{ code: 'ABCD-EFGH-JKMN', kind: 'gift_card', balanceCents: 1000 }]);
  const note = holdNote(q, 'habc2345');
  assert.match(note, /Promo WELCOME10/);
  assert.match(note, /••••-••••-JKMN/);
  assert.ok(note.endsWith('ref habc2345'));
  assert.equal(holdNote(priceCart(5000, undefined, undefined, []), 'habc2345'), '', 'nothing used, nothing to find');
});

// ---------------------------------------------------------------- the demo store, both studios
let NOW = new Date('2026-10-18T21:00:00Z'); // Mon 19 Oct 2026, 8am Sydney
function platform() {
  NOW = new Date('2026-10-18T21:00:00Z');
  return createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
}
interface Desk { s: DataStore; c: CommerceStore; owner: AuthUser; asOwner(): Promise<void>; as(u: AuthUser): Promise<void>; today(): string; newClient(first: string): Promise<Client>; member(first: string, productKind?: Product['kind']): Promise<Client> }
async function desk(p: ReturnType<typeof createDemoPlatform>, slug: string): Promise<Desk> {
  const studio = await p.findStudio({ slug });
  assert.ok(studio, slug);
  const s = p.forStudio(studio);
  const owner = (await s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'owner')!;
  await s.demoSignInAs!(owner);
  const c = s.features.commerce!;
  assert.ok(c, `${slug}: commerce is registered`);
  const d: Desk = {
    s, c, owner, asOwner: async () => { await s.demoSignInAs!(owner); }, as: async (u) => { await s.demoSignInAs!(u); },
    today: () => studioDate(NOW),
    newClient: async (first) => {
      await d.asOwner();
      return s.upsertClient({ firstName: first, lastName: 'Test', email: `${first.toLowerCase()}.${slug}@example.com`, marketingOptIn: false, waiverSignedAt: NOW.toISOString() });
    },
    member: async (first, kind = 'dropin') => {
      const cl = await d.newClient(first);
      const prod = (await s.listProducts()).find((x) => x.kind === kind)!;
      await s.purchase({ clientId: cl.id, productId: prod.id, method: 'cash' });
      return cl;
    },
  };
  return d;
}
const clientUser = (c: Client): AuthUser => ({ kind: 'client', clientId: c.id, email: c.email, name: c.firstName });
const SLUGS = ['snowy', 'harbour'];

test('demo: both studios are seeded with a WELCOME10 code, gift cards, referrals and a low-stock item', async () => {
  const p = platform();
  const seen: Record<string, number[]> = {};
  for (const slug of SLUGS) {
    const { c } = await desk(p, slug);
    const promos = await c.listPromos();
    const w = promos.find((x) => x.code === 'WELCOME10');
    assert.ok(w, `${slug}: WELCOME10 exists`);
    assert.equal(w.status, 'live');
    assert.equal(w.newClientsOnly, true);
    assert.equal(w.kind, 'percent');
    assert.ok(w.uses > 0, `${slug}: it has been used`);
    assert.ok(promos.some((x) => x.status === 'expired') && promos.some((x) => x.status === 'paused'), `${slug}: a past and a paused code`);

    const cards = await c.listGiftCards();
    assert.ok(cards.some((x) => x.state === 'active' && x.balanceCents > 0 && x.balanceCents < x.initialCents), `${slug}: a part-used card`);
    assert.ok(cards.some((x) => x.state === 'used') && cards.some((x) => x.state === 'void') && cards.some((x) => x.state === 'expired'), `${slug}: used, void and expired cards`);
    assert.ok(cards.some((x) => x.kind === 'credit'), `${slug}: referral credit`);
    assert.equal(new Set(cards.map((x) => x.code)).size, cards.length, `${slug}: codes are unique`);

    const stock = await c.listRetail();
    assert.ok(stock.some((x) => x.status === 'low'), `${slug}: a low-stock item`);
    const withBarcode = stock.find((x) => x.barcode)!;
    assert.equal((await c.findRetail(withBarcode.barcode!))?.productId, withBarcode.productId, `${slug}: scanning a barcode finds the item`);
    assert.ok((await c.referralStats()).rewarded >= 1, `${slug}: a rewarded referral`);
    seen[slug] = [cards.length, promos.length, stock.length];
  }
  const snowySettings = await (await desk(p, 'snowy')).c.getSettings();
  const harbourSettings = await (await desk(p, 'harbour')).c.getSettings();
  assert.notDeepEqual(snowySettings.giftCardAmounts, harbourSettings.giftCardAmounts, 'each studio has its own amounts');
});

test('gift card: balance, partial redemption at the till, an abandoned cart, void and expiry', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const { s, c } = d;
    const products = await s.listProducts();
    const single = products.find((x) => x.kind === 'dropin')!;
    const pack = products.filter((x) => x.kind === 'pack').sort((a, b) => b.priceCents - a.priceCents)[0]!;
    const buyer = await d.member('Buyer');
    const sold = await c.sellGiftCard({ amountCents: 5000, method: 'cash', clientId: buyer.id });
    const code = sold.card.code;
    assert.equal(sold.card.balanceCents, 5000, `${slug}: full balance`);
    assert.equal(sold.sale?.totalCents, 5000, `${slug}: selling a card is a sale`);
    assert.equal((await c.lookupGiftCard(code.toLowerCase().replace(/-/g, ''))).balanceCents, 5000, `${slug}: lookup forgives case and dashes`);

    // a class bought with the card: the hold reserves it straight away, the sale makes it real
    const user = await d.newClient('Guest');
    const hold = await c.holdCodes({ clientId: user.id, items: [{ productId: single.id, qty: 1 }], giftCodes: [code] });
    assert.equal(hold.quote.giftCents, single.priceCents, `${slug}: the card covers the class`);
    assert.equal(hold.quote.totalCents, 0);
    assert.equal((await c.lookupGiftCard(code)).balanceCents, 5000 - single.priceCents, `${slug}: reserved while the sale is open`);
    await s.checkoutCart({ clientId: user.id, items: [{ productId: single.id, qty: 1 }], method: 'card_reader', discountCents: hold.quote.giftCents + hold.quote.promoCents, note: hold.note });
    await c.settleHold(hold.token);
    const detail = await c.getGiftCard(sold.card.id);
    const redeems = detail.entries.filter((e) => e.kind === 'redeem');
    assert.equal(redeems.length, 1, `${slug}: one redemption`);
    assert.equal(redeems[0]!.state, 'posted');
    assert.equal(redeems[0]!.cents, -single.priceCents);
    assert.ok(redeems[0]!.saleId, `${slug}: linked to the sale`);
    assert.equal(detail.balanceCents, 5000 - single.priceCents);

    // the remaining balance part-pays a bigger cart: the rest is left to pay
    const left = 5000 - single.priceCents;
    const half = await c.quote({ items: [{ productId: pack.id, qty: 1 }], giftCodes: [code] });
    assert.equal(half.giftCents, left, `${slug}: uses only what's left`);
    assert.equal(half.totalCents, pack.priceCents - left);
    // a second till can't spend what the first has reserved
    const first = await c.holdCodes({ items: [{ productId: pack.id, qty: 1 }], giftCodes: [code] });
    const second = await c.quote({ items: [{ productId: pack.id, qty: 1 }], giftCodes: [code] });
    assert.match(second.giftErrors[0]!.message, /no balance left/, `${slug}: a held card is spent`);
    // walking away gives the money back
    await c.settleHold(first.token);
    assert.equal((await c.lookupGiftCard(code)).balanceCents, left, `${slug}: abandoned cart releases the hold`);

    // staff corrections
    const adj = await c.adjustGiftCard(sold.card.id, -500, 'Typo at the till');
    assert.equal(adj.balanceCents, left - 500);
    await assert.rejects(() => c.adjustGiftCard(sold.card.id, -999999, 'Too much'), /below \$0/);
    await assert.rejects(() => c.adjustGiftCard(sold.card.id, 100, ' '), /reason/);

    // expiry: 36 months on the card has run out
    const exp = await c.sellGiftCard({ amountCents: 5000, method: 'comp' });
    NOW = new Date('2029-11-01T00:00:00Z');
    assert.equal((await c.lookupGiftCard(exp.card.code)).state, 'expired', `${slug}: expired after 36 months`);
    assert.match((await c.quote({ subtotalCents: 1000, giftCodes: [exp.card.code] })).giftErrors[0]!.message, /expired/);
    NOW = new Date('2026-10-18T21:00:00Z');

    // void writes the balance off
    const v = await c.voidGiftCard(sold.card.id, 'Replaced');
    assert.equal(v.state, 'void');
    assert.equal(v.balanceCents, 0);
    assert.match((await c.quote({ subtotalCents: 1000, giftCodes: [code] })).giftErrors[0]!.message, /voided/);
    await assert.rejects(() => c.voidGiftCard(sold.card.id, 'again'), /already voided/);
  }
});

test('gift card: a client buys one for a friend, and sees their own cards only', async () => {
  const p = platform();
  const d = await desk(p, 'snowy');
  const alice = await d.newClient('Alice');
  const bob = await d.newClient('Bob');
  await d.as(clientUser(alice));
  const today = d.today();
  await assert.rejects(() => d.c.buyGiftCard({ amountCents: 100, recipientName: 'Mel', recipientEmail: 'mel@example.com' }), /Gift cards are/);
  await assert.rejects(() => d.c.buyGiftCard({ amountCents: 5000, recipientName: 'Mel', recipientEmail: 'nope' }), /email/);
  await assert.rejects(() => d.c.buyGiftCard({ amountCents: 5000, recipientName: 'Mel', recipientEmail: 'mel@example.com', sendOn: addDays(today, -1) }), /past/);
  const now = await d.c.buyGiftCard({ amountCents: 5000, recipientName: 'Mel', recipientEmail: 'mel@example.com', message: 'Happy birthday' });
  assert.ok(now.card.sentAt, 'a card for today goes out straight away');
  const later = await d.c.buyGiftCard({ amountCents: 3000, recipientName: 'Tom', recipientEmail: 'tom@example.com', sendOn: addDays(today, 3) });
  assert.equal(later.card.sentAt, undefined, 'a scheduled card waits');
  assert.equal((await d.c.myGiftCards()).length, 2);
  NOW = new Date(NOW.getTime() + 4 * 86_400_000);
  assert.ok((await d.c.myGiftCards()).find((x) => x.id === later.card.id)?.sentAt, 'it goes out on its day');
  await d.as(clientUser(bob));
  assert.equal((await d.c.myGiftCards()).length, 0, 'someone else sees none of them');
  await assert.rejects(() => d.c.listGiftCards(), 'clients can\'t list every card');
  await assert.rejects(() => d.c.updateSettings({ giftCardMaxCents: 99999999 }), 'clients can\'t change the shop settings');
});

test('promo codes: limits, expiry and new clients only through the store, and what a redemption counts', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const { s, c } = d;
    const products = await s.listProducts();
    const pack = products.find((x) => x.kind === 'pack')!;
    const single = products.find((x) => x.kind === 'dropin')!;
    const today = d.today();

    await assert.rejects(() => c.upsertPromo({ code: 'x', kind: 'percent', value: 10, productIds: [], newClientsOnly: false, active: true }), /3 to 20/);
    await assert.rejects(() => c.upsertPromo({ code: 'BIG', kind: 'percent', value: 150, productIds: [], newClientsOnly: false, active: true }), /between 1 and 100/);
    await assert.rejects(() => c.upsertPromo({ code: 'WELCOME10', kind: 'percent', value: 5, productIds: [], newClientsOnly: false, active: true }), /already a code/);
    await assert.rejects(() => c.upsertPromo({ code: 'BACKWARDS', kind: 'percent', value: 5, productIds: [], newClientsOnly: false, active: true, startsOn: addDays(today, 5), endsOn: addDays(today, 1) }), /end date/);

    const nu = await c.upsertPromo({ code: ' fresh20 ', kind: 'percent', value: 20, productIds: [pack.id], endsOn: addDays(today, 10), maxUsesPerClient: 1, newClientsOnly: true, active: true });
    assert.equal(nu.code, 'FRESH20');
    const cap = await c.upsertPromo({ code: 'CAP1', kind: 'amount', value: 500, productIds: [], maxUses: 1, newClientsOnly: false, active: true });
    const once = await c.upsertPromo({ code: 'ONCE', kind: 'percent', value: 10, productIds: [], maxUsesPerClient: 1, newClientsOnly: false, active: true });
    const later = await c.upsertPromo({ code: 'LATER', kind: 'percent', value: 10, productIds: [], startsOn: addDays(today, 5), newClientsOnly: false, active: true });

    const fresh = await d.newClient('Fresh');
    const old = await d.member('Old');
    const old2 = await d.member('Older');
    const cart = [{ productId: pack.id, qty: 1 }];

    // new clients only
    const q1 = await c.quote({ clientId: fresh.id, items: cart, promoCode: 'fresh20' });
    assert.equal(q1.promoCents, Math.round(pack.priceCents * 0.2), `${slug}: 20% off the pack`);
    assert.equal(q1.totalCents, pack.priceCents - q1.promoCents);
    assert.equal((await c.quote({ clientId: old.id, items: cart, promoCode: 'FRESH20' })).promoError, 'That code is for new clients only.', `${slug}: members don't get it`);
    assert.equal((await c.quote({ items: cart, promoCode: 'FRESH20' })).promoError, 'Add a client to use this code.', `${slug}: the till needs a client`);
    assert.match((await c.quote({ clientId: fresh.id, items: [{ productId: single.id, qty: 1 }], promoCode: 'FRESH20' })).promoError!, /doesn’t apply/, `${slug}: only the listed product`);
    assert.equal((await c.quote({ clientId: fresh.id, items: cart, promoCode: 'NOSUCH' })).promoError, 'That code isn’t valid.');
    assert.match((await c.quote({ clientId: fresh.id, items: cart, promoCode: 'LATER' })).promoError!, /starts on/);
    assert.equal((await c.quote({ clientId: fresh.id, subtotalCents: 3000, promoCode: 'ONCE' })).promoCents, 300);

    // a redemption is counted once the sale lands, not before
    const hold = await c.holdCodes({ clientId: old.id, items: [{ productId: single.id, qty: 1 }], promoCode: 'ONCE' });
    await s.checkoutCart({ clientId: old.id, items: [{ productId: single.id, qty: 1 }], method: 'cash', discountCents: hold.quote.promoCents, note: hold.note });
    await c.settleHold(hold.token);
    assert.equal((await c.listPromos()).find((x) => x.id === once.id)!.uses, 1, `${slug}: used once`);
    assert.equal((await c.quote({ clientId: old.id, subtotalCents: 3000, promoCode: 'ONCE' })).promoError, 'This client has already used that code.', `${slug}: once per client`);
    assert.equal((await c.quote({ clientId: old2.id, subtotalCents: 3000, promoCode: 'ONCE' })).promoCents, 300, `${slug}: someone else still can`);
    const abandoned = await c.holdCodes({ clientId: old2.id, subtotalCents: 3000, promoCode: 'ONCE' });
    await c.settleHold(abandoned.token);
    assert.equal((await c.listPromos()).find((x) => x.id === once.id)!.uses, 1, `${slug}: an abandoned cart doesn't count`);

    // total uses
    const capHold = await c.holdCodes({ clientId: old.id, items: [{ productId: single.id, qty: 1 }], promoCode: 'CAP1' });
    await s.checkoutCart({ clientId: old.id, items: [{ productId: single.id, qty: 1 }], method: 'cash', discountCents: capHold.quote.promoCents, note: capHold.note });
    await c.settleHold(capHold.token);
    assert.equal((await c.quote({ clientId: old2.id, subtotalCents: 3000, promoCode: 'CAP1' })).promoError, 'That code has been fully claimed.', `${slug}: a one-use code is gone`);
    assert.equal((await c.listPromos()).find((x) => x.id === cap.id)!.status, 'used_up');
    assert.equal((await c.promoRedemptions(cap.id)).length, 1);

    // a pass bought with the code at the till takes the new-client status away
    const fHold = await c.holdCodes({ clientId: fresh.id, items: cart, promoCode: 'FRESH20' });
    await s.checkoutCart({ clientId: fresh.id, items: cart, method: 'card_reader', discountCents: fHold.quote.promoCents, note: fHold.note });
    await c.settleHold(fHold.token);
    assert.equal((await c.quote({ clientId: fresh.id, items: cart, promoCode: 'FRESH20' })).promoError, 'That code is for new clients only.', `${slug}: not new any more`);

    // expiry
    NOW = new Date(NOW.getTime() + 11 * 86_400_000);
    const stranger = await d.newClient('Stranger');
    assert.equal((await c.quote({ clientId: stranger.id, items: cart, promoCode: 'FRESH20' })).promoError, 'That code has expired.', `${slug}: past its end date`);
    assert.equal((await c.listPromos()).find((x) => x.id === nu.id)!.status, 'expired');
    assert.equal((await c.quote({ clientId: stranger.id, subtotalCents: 3000, promoCode: 'LATER' })).promoCents, 300, `${slug}: LATER has started by now`);
    NOW = new Date('2026-10-18T21:00:00Z');
  }
});

test('promo codes: a client buys a pass with a code, and a $ off code can\'t go below zero', async () => {
  const p = platform();
  const d = await desk(p, 'snowy');
  const pack = (await d.s.listProducts()).find((x) => x.kind === 'pack')!;
  const single = (await d.s.listProducts()).find((x) => x.kind === 'dropin')!;
  await d.c.upsertPromo({ code: 'TAKE5', kind: 'amount', value: 500, productIds: [], newClientsOnly: false, active: true, maxUsesPerClient: 1 });
  await d.c.upsertPromo({ code: 'HUGE', kind: 'amount', value: 999900, productIds: [single.id], newClientsOnly: false, active: true });
  const cl = await d.newClient('Casey');
  await d.as(clientUser(cl));
  await assert.rejects(() => d.c.purchaseWithCodes({ productId: pack.id, promoCode: 'NOSUCH' }), /isn’t valid/);
  const r = await d.c.purchaseWithCodes({ productId: pack.id, promoCode: 'take5' });
  assert.equal(r.sale!.totalCents, pack.priceCents - 500, 'the sale carries the discount');
  assert.match(r.sale!.note ?? '', /Promo TAKE5/);
  assert.equal((await d.s.listPasses(cl.id)).length, 1, 'she gets her pass');
  await assert.rejects(() => d.c.purchaseWithCodes({ productId: pack.id, promoCode: 'TAKE5' }), /already used/);
  const free = await d.c.purchaseWithCodes({ productId: single.id, promoCode: 'HUGE' });
  assert.equal(free.sale!.totalCents, 0, 'the code takes off at most the price');
  assert.equal(free.quote.promoCents, single.priceCents);
});

test('referrals: a friend joins with a code and the referrer is rewarded on their first paid pass', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const { s, c } = d;
    const reward = (await c.getSettings()).referralRewardCents;
    const pack = (await s.listProducts()).find((x) => x.kind === 'pack')!;
    const ref = await d.newClient('Referrer');
    const friend = await d.newClient('Friend');
    const freebie = await d.newClient('Freebie');
    const veteran = await d.member('Veteran');

    await d.as(clientUser(ref));
    const mine = await c.myReferral();
    assert.match(mine.code, /^REFERRER-[0-9A-Z]{4}$/, `${slug}: a code made from her name`);
    assert.equal((await c.myReferral()).code, mine.code, 'it stays the same');
    await assert.rejects(() => c.claimReferral(mine.code), /own code/);

    await d.as(clientUser(veteran));
    await assert.rejects(() => c.claimReferral(mine.code), /new clients/, `${slug}: only new clients can join`);
    await d.as(clientUser(friend));
    await assert.rejects(() => c.claimReferral('NOBODY-0000'), /couldn’t find/);
    assert.equal((await c.claimReferral(mine.code.toLowerCase())).referrerName, 'Referrer');
    await assert.rejects(() => c.claimReferral(mine.code), /already joined/);
    await d.as(clientUser(freebie));
    await c.claimReferral(mine.code);

    // nothing yet
    await d.as(clientUser(ref));
    let r = await c.myReferral();
    assert.deepEqual(r.referrals.map((x) => x.status).sort(), ['pending', 'pending']);
    assert.equal(r.earnedCents, 0);

    // a free (comp) pass doesn't earn it; a paid pass does
    await d.asOwner();
    await s.purchase({ clientId: freebie.id, productId: pack.id, method: 'comp' });
    await d.as(clientUser(ref));
    assert.equal((await c.myReferral()).earnedCents, 0, `${slug}: a comp pass earns nothing`);
    await d.asOwner();
    await s.purchase({ clientId: friend.id, productId: pack.id, method: 'card_reader' });
    await d.as(clientUser(ref));
    r = await c.myReferral();
    assert.equal(r.earnedCents, reward, `${slug}: the reward is paid`);
    assert.deepEqual(r.referrals.map((x) => x.status).sort(), ['pending', 'rewarded']);
    const credit = (await c.myGiftCards()).find((x) => x.kind === 'credit' && x.createdAt === NOW.toISOString() && x.source === 'referral');
    assert.ok(credit, `${slug}: credit lands on her account`);
    assert.equal(credit.balanceCents, reward);
    assert.equal((await c.myReferral()).earnedCents, reward, 'looking again doesn\'t pay twice');

    // credit is hers alone, and spendable at checkout
    assert.equal((await c.quote({ subtotalCents: 5000, giftCodes: [credit.code] })).giftCents, reward, `${slug}: she can spend it`);
    await d.as(clientUser(veteran));
    assert.match((await c.quote({ subtotalCents: 5000, giftCodes: [credit.code] })).giftErrors[0]!.message, /couldn’t find/, `${slug}: nobody else can`);
    await d.asOwner();
    const stats = await c.referralStats();
    assert.ok(stats.rewarded >= 2 && stats.pending >= 1, `${slug}: staff see the totals`);
    assert.equal(stats.top[0]!.rewarded >= 1, true);
  }
});

test('referrals: switched off in settings, nobody can join', async () => {
  const p = platform();
  const d = await desk(p, 'snowy');
  const ref = await d.newClient('Ref');
  const friend = await d.newClient('Pal');
  await d.as(clientUser(ref));
  const code = (await d.c.myReferral()).code;
  await d.asOwner();
  await assert.rejects(() => d.c.updateSettings({ referralRewardCents: 0 }), /above \$0/);
  await d.c.updateSettings({ referralEnabled: false });
  await d.as(clientUser(friend));
  await assert.rejects(() => d.c.claimReferral(code), /aren’t running/);
});

test('retail: barcode lookup, counts, low-stock alerts, the log and the report', async () => {
  const p = platform();
  for (const slug of SLUGS) {
    const d = await desk(p, slug);
    const { s, c } = d;
    const items = await c.listRetail();
    const low = items.filter((x) => x.status === 'low');
    assert.ok(low.length > 0, `${slug}: something is running low`);
    const it = low[0]!;
    assert.ok(it.stock! <= it.lowAt);

    // barcode or SKU, any case, scanner control characters dropped, inactive items not sold
    assert.equal((await c.findRetail(`\u0002${it.barcode}\r\n`))?.productId, it.productId, `${slug}: scanner input`);
    assert.equal((await c.findRetail(it.sku!.toLowerCase()))?.productId, it.productId, `${slug}: SKU, any case`);
    assert.equal(await c.findRetail('0000000000000'), null);
    assert.equal(await c.findRetail('   '), null);

    // a unique barcode and SKU per studio
    const other = items.find((x) => x.productId !== it.productId)!;
    await assert.rejects(() => c.updateRetail(other.productId, { barcode: it.barcode! }), /already has that barcode/);
    await assert.rejects(() => c.updateRetail(other.productId, { sku: it.sku!.toLowerCase() }), /already has that SKU/);
    await assert.rejects(() => c.updateRetail(other.productId, { lowStockAt: -1 }), /whole number/);
    const upd = await c.updateRetail(other.productId, { barcode: '9990000000017', lowStockAt: 20 });
    assert.equal(upd.barcode, '9990000000017');
    assert.equal(upd.lowAt, 20);
    assert.equal(upd.status, other.stock! <= 20 ? 'low' : 'ok');
    assert.equal((await c.findRetail('9990000000017'))?.productId, other.productId);
    await c.updateRetail(other.productId, { barcode: null, lowStockAt: null });
    assert.equal(await c.findRetail('9990000000017'), null, `${slug}: clearing a barcode`);

    // counts
    await assert.rejects(() => c.adjustStock({ productId: it.productId, delta: -(it.stock! + 1), reason: 'lost' }), /only \d+ in stock/);
    await assert.rejects(() => c.adjustStock({ productId: it.productId, setTo: it.stock!, reason: 'count' }), /same as the current/);
    await assert.rejects(() => c.adjustStock({ productId: it.productId, reason: 'count' }), /how many/);
    await assert.rejects(() => c.adjustStock({ productId: it.productId, delta: 1, setTo: 4, reason: 'count' }), /how many/);
    NOW = new Date(NOW.getTime() + 60_000);
    const received = await c.adjustStock({ productId: it.productId, delta: 30, reason: 'received', note: 'Order 7' });
    assert.equal(received.stock, it.stock! + 30);
    assert.equal(received.status, 'ok', `${slug}: a delivery clears the alert`);
    NOW = new Date(NOW.getTime() + 60_000);
    const counted = await c.adjustStock({ productId: it.productId, setTo: 0, reason: 'count' });
    assert.equal(counted.status, 'out');
    const log = await c.stockLog({ productId: it.productId, limit: 2 });
    assert.deepEqual(log.map((l) => [l.reason, l.delta]), [['count', -(it.stock! + 30)], ['received', 30]], `${slug}: newest first, signed changes`);
    assert.equal(log[0]!.after, 0);

    // selling counts the shelf down and refuses what isn't there
    await c.adjustStock({ productId: it.productId, setTo: 2, reason: 'count' });
    await s.checkoutCart({ items: [{ productId: it.productId, qty: 2 }], method: 'cash' });
    assert.equal((await c.listRetail()).find((x) => x.productId === it.productId)!.status, 'out');
    await assert.rejects(() => s.checkoutCart({ items: [{ productId: it.productId, qty: 1 }], method: 'cash' }));
    const rep = await c.stockReport({ from: d.today(), to: d.today() });
    const row = rep.rows.find((x) => x.productId === it.productId)!;
    assert.equal(row.sold, 2, `${slug}: the report counts what was sold`);
    assert.equal(row.onHand, 0);
    assert.equal(rep.totals.out >= 1, true);

    // front desk can run stock, instructors can scan but not count
    const julia = (await s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'instructor')!;
    await d.as(julia);
    assert.ok(await c.findRetail(it.barcode!), `${slug}: instructors can scan at the till`);
    await assert.rejects(() => c.listRetail(), `${slug}: ...but not read the stock list`);
    await assert.rejects(() => c.adjustStock({ productId: it.productId, delta: 1, reason: 'received' }));
    NOW = new Date('2026-10-18T21:00:00Z');
  }
});

test('studios keep their own gift cards, codes, stock and settings', async () => {
  const p = platform();
  const a = await desk(p, 'snowy');
  const b = await desk(p, 'harbour');
  await a.asOwner();
  const card = await a.c.sellGiftCard({ amountCents: 5000, method: 'comp' });
  // the same code in the other studio is simply unknown
  await b.asOwner();
  await assert.rejects(() => b.c.lookupGiftCard(card.card.code), /couldn’t find/);
  await assert.rejects(() => b.c.getGiftCard(card.card.id), /couldn’t find/);
  await assert.rejects(() => b.c.voidGiftCard(card.card.id, 'x'), /couldn’t find/);
  assert.match((await b.c.quote({ subtotalCents: 3000, giftCodes: [card.card.code] })).giftErrors[0]!.message, /couldn’t find/);
  assert.ok(!(await b.c.listGiftCards()).some((x) => x.id === card.card.id));
  // promos
  await a.asOwner();
  const mine = await a.c.upsertPromo({ code: 'SNOWYONLY', kind: 'percent', value: 10, productIds: [], newClientsOnly: false, active: true });
  await b.asOwner();
  assert.ok(!(await b.c.listPromos()).some((x) => x.code === 'SNOWYONLY'));
  assert.equal((await b.c.quote({ subtotalCents: 3000, promoCode: 'SNOWYONLY' })).promoError, 'That code isn’t valid.');
  await assert.rejects(() => b.c.upsertPromo({ id: mine.id, code: 'HIJACK', kind: 'percent', value: 100, productIds: [], newClientsOnly: false, active: true }), /couldn’t find/);
  // stock
  await a.asOwner();
  const snowyItem = (await a.c.listRetail())[0]!;
  await b.asOwner();
  await assert.rejects(() => b.c.adjustStock({ productId: snowyItem.productId, delta: 1, reason: 'received' }), /couldn’t find/);
  assert.equal(await b.c.findRetail(snowyItem.barcode!), null, 'a Snowy barcode finds nothing in Harbour');
  // settings
  await a.asOwner();
  await a.c.updateSettings({ referralRewardCents: 7777 });
  await b.asOwner();
  assert.notEqual((await b.c.getSettings()).referralRewardCents, 7777);
});
