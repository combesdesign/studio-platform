/** Passes tab: my passes + memberships, the shop, checkout and receipts. */
import React, { useEffect, useMemo, useState } from 'react';
import type { CreditSummary, PurchaseResult } from '../shared/store';
import type { Pass, Product, Sale } from '../shared/types';
import { store, useData, useToast, errorMessage, Sheet } from '../shared/react';
import { addDays, gstOf, money, studioDate } from '../shared/format';
import { Accent, CardSkeletons, Empty, ErrorBlock, Flower, Icon, ScreenHead, SheetHead, Skeleton, useApp } from './ui';
import { daysLeft, dateOnlyShort, dateShortNoDay, expiryLabel, perClass, productWhat, queryOf, validityWords, when } from './lib';

type Nav = (to: string, o?: { replace?: boolean }) => void;

export function Passes({ nav, path }: { nav: Nav; path: string }) {
  const app = useApp();
  const toast = useToast();
  const cid = app.client.id;
  const q = queryOf(path);
  const forId = q.get('for') || undefined;
  const paid = q.get('paid');
  const passes = useData(() => store.listPasses(cid), [cid]);
  const credits = useData(() => store.getCreditSummary(cid), [cid]);
  const products = useData(() => store.listProducts(), []);
  const intro = useData(() => store.isIntroEligible(cid), [cid]);
  const [buy, setBuy] = useState<Product | null>(null);

  useEffect(() => {
    if (paid) {
      toast('Payment received – your pass will appear in a moment');
      nav('/passes' + (forId ? '?for=' + encodeURIComponent(forId) : ''), { replace: true });
    }
  }, [paid]);

  const forSession = useData(() => (forId ? store.getSession(forId) : Promise.resolve(null)), [forId]);
  const forCt = forSession.data ? app.classTypes.find((t) => t.id === forSession.data!.classTypeId) : undefined;

  const myPasses = (passes.data ?? []).filter((p) => p.status !== 'expired' && p.status !== 'used_up');
  const groups = useMemo(() => {
    const list = (products.data ?? []).filter((p) => p.active).sort((a, b) => a.sortOrder - b.sortOrder || a.priceCents - b.priceCents);
    return {
      intro: list.filter((p) => p.kind === 'intro'),
      memberships: list.filter((p) => p.kind === 'membership'),
      packs: list.filter((p) => p.kind === 'pack' || p.kind === 'dropin'),
      retail: list.filter((p) => p.kind === 'retail'),
    };
  }, [products.data]);

  return (
    <div className="screen">
      <ScreenHead title={<>Your <em>passes</em></>} />

      {forId && forSession.data && (
        <div className="note cream mb-20">
          <Icon name="ticket" size={20} />
          <div>Pick a pass to book <strong>{forCt?.name ?? 'your class'}</strong> at {when(forSession.data.startsAt)}. We’ll take you straight back after.</div>
        </div>
      )}

      {passes.error && !passes.data ? <ErrorBlock error={passes.error} onRetry={passes.reload} /> :
        !passes.data ? <CardSkeletons n={1} h={170} /> :
          myPasses.length === 0 ? (
            <div className="no-pass">
              <Flower size={36} />
              <div>
                <strong>No active passes</strong>
                <p className="muted">Choose one below to start booking.</p>
              </div>
            </div>
          ) : (
            <div className="stack lg">
              {myPasses.map((p) => <PassCard key={p.id} p={p} summary={credits.data?.find((c) => c.pass.id === p.id)} />)}
            </div>
          )}

      <div className="shop-head">
        <div className="kicker">Shop</div>
        <h2>Find what’s<br />best for <em>you</em></h2>
      </div>

      {products.error && !products.data ? <ErrorBlock error={products.error} onRetry={products.reload} /> :
        !products.data || intro.loading && intro.data === undefined ? <CardSkeletons n={3} h={120} /> : (
          <div className="stack xl">
            {intro.data && groups.intro.map((p) => <IntroCard key={p.id} p={p} onBuy={() => setBuy(p)} />)}

            {groups.memberships.length > 0 && (
              <section className="stack">
                <div className="group-head">
                  <h3>Memberships</h3>
                  <p className="muted">Billed weekly by direct debit. Starts from your first booking – pause or cancel any time.</p>
                </div>
                {groups.memberships.map((p) => <ProductCard key={p.id} p={p} onBuy={() => setBuy(p)} />)}
              </section>
            )}

            {groups.packs.length > 0 && (
              <section className="stack">
                <div className="group-head">
                  <h3>Class packs</h3>
                  <p className="muted">No commitment. The clock starts at your first booking, not when you buy.</p>
                </div>
                {groups.packs.map((p) => <ProductCard key={p.id} p={p} onBuy={() => setBuy(p)} />)}
              </section>
            )}

            {groups.retail.length > 0 && (
              <section className="stack">
                <div className="group-head">
                  <h3>Studio extras</h3>
                  <p className="muted">Pay now and pick up at the front desk.</p>
                </div>
                <div className="retail-grid">
                  {groups.retail.map((p) => (
                    <button key={p.id} className="retail" onClick={() => setBuy(p)} disabled={p.stock === 0}>
                      <span className="retail-name">{p.name}</span>
                      <span className="retail-price serif">{money(p.priceCents)}</span>
                      {p.stock === 0 && <span className="tag muted-tag">Sold out</span>}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

      <p className="fine muted center mt-28">All prices in AUD and include GST.</p>

      <Checkout product={buy} onClose={() => setBuy(null)} nav={nav} forId={forId} forLabel={forCt ? forCt.name : undefined} />
    </div>
  );
}

// ------------------------------------------------------------------ my passes
function passLabel(p: Pass, s?: CreditSummary): string {
  if (s) return s.label;
  if (p.credits == null) return 'Unlimited';
  if (p.kind === 'membership') return `${p.credits} per week`;
  return `${Math.max(0, p.credits - p.creditsUsed)} of ${p.credits} left`;
}

const kindName = (p: Pass) => p.kind === 'intro' ? 'Intro offer' : p.kind === 'membership' ? 'Membership' : p.kind === 'dropin' ? 'Single class' : 'Class pack';

function PassCard({ p, summary }: { p: Pass; summary?: CreditSummary }) {
  const [sheet, setSheet] = useState<'pause' | 'cancel' | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const isMember = p.kind === 'membership';
  const tone = p.kind === 'intro' ? 'cream' : isMember ? 'navy' : 'white';
  const dl = daysLeft(p.expiresAt);
  const label = passLabel(p, summary);
  const resume = async () => {
    setBusy(true);
    try { await store.resumePass(p.id); toast('Welcome back – membership resumed'); }
    catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="pass-wrap">
      <div className={'pass ' + tone + (p.status === 'paused' ? ' paused' : '')}>
        <Flower size={170} white={tone === 'navy'} className="pass-flower" />
        <div className="pass-top">
          <span className="pass-kind">{kindName(p)}</span>
          {p.status === 'paused' ? <span className="tag cream">Paused</span> : p.status === 'cancelled' ? <span className="tag cream">Ending</span> : !p.activatedAt ? <span className="tag pass-tag">Not started</span> : null}
        </div>
        {p.name.toLowerCase() !== kindName(p).toLowerCase() && <div className="pass-name">{p.name}</div>}
        <div className="pass-big serif">{label}</div>
        {(p.kind === 'pack' || p.kind === 'dropin') && p.credits != null && p.credits <= 12 && (
          <div className="pass-dots" aria-hidden="true">
            {Array.from({ length: p.credits }).map((_, i) => <span key={i} className={i < p.creditsUsed ? 'used' : ''} />)}
          </div>
        )}
        <div className="pass-foot">
          <span>{p.status === 'cancelled' && p.nextBillingAt ? `Ends ${dateShortNoDay(p.nextBillingAt)}` : expiryLabel(p)}{dl != null && dl >= 0 && dl <= 7 && p.status === 'active' ? ` · ${dl === 0 ? 'last day' : `${dl} day${dl === 1 ? '' : 's'} left`}` : ''}</span>
          {isMember && <span>{money(p.priceCents)}/{p.billingInterval === 'month' ? 'month' : 'week'}</span>}
        </div>
      </div>
      {isMember && p.status !== 'cancelled' && (
        <div className="pass-actions">
          {p.status === 'paused' ? (
            <button className="btn soft sm" disabled={busy} onClick={resume}><Icon name="play" size={16} />Resume</button>
          ) : (
            <button className="btn soft sm" onClick={() => setSheet('pause')}><Icon name="pause" size={16} />Pause</button>
          )}
          <button className="btn ghost sm" onClick={() => setSheet('cancel')}>Cancel membership</button>
        </div>
      )}
      <PauseSheet open={sheet === 'pause'} p={p} onClose={() => setSheet(null)} />
      <CancelMembershipSheet open={sheet === 'cancel'} p={p} onClose={() => setSheet(null)} />
    </div>
  );
}

function PauseSheet({ open, p, onClose }: { open: boolean; p: Pass; onClose: () => void }) {
  const toast = useToast();
  const today = studioDate();
  const [from, setFrom] = useState(addDays(today, 1));
  const [until, setUntil] = useState(addDays(today, 8));
  const [busy, setBusy] = useState(false);
  const days = Math.round((Date.parse(until) - Date.parse(from)) / 86_400_000);
  const ok = from >= today && days >= 7;
  const save = async () => {
    setBusy(true);
    try { await store.pausePass(p.id, from, until); toast(`Paused until ${dateOnlyShort(until)}`); onClose(); }
    catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} label="Pause membership">
      <SheetHead title={<>Pause your <em>membership</em></>} onClose={onClose} />
      <div className="stack lg">
        <p className="muted">Going away or need a break? There’s no billing and no booking while you’re paused. Pauses are at least a week.</p>
        <div className="grid2">
          <label className="field"><span>From</span><input className="input" type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); if (until < addDays(e.target.value, 7)) setUntil(addDays(e.target.value, 7)); }} /></label>
          <label className="field"><span>Until</span><input className="input" type="date" min={addDays(from, 7)} value={until} onChange={(e) => setUntil(e.target.value)} /></label>
        </div>
        {!ok && <p className="form-error">Pauses need to be at least 7 days, starting from today.</p>}
        {ok && <p className="panel-soft">Paused for <strong>{days} days</strong>, {dateOnlyShort(from)} to {dateOnlyShort(until)}. Billing picks up again after that.</p>}
        <button className="btn block" disabled={!ok || busy} onClick={save}>{busy ? 'Pausing…' : 'Pause membership'}</button>
      </div>
    </Sheet>
  );
}

function CancelMembershipSheet({ open, p, onClose }: { open: boolean; p: Pass; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await store.cancelMembership(p.id); toast(r.nextBillingAt ? `Cancelled – you can keep booking until ${dateShortNoDay(r.nextBillingAt)}` : 'Membership cancelled'); onClose(); }
    catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} label="Cancel membership">
      <SheetHead title={<>Cancel your <em>membership?</em></>} onClose={onClose} />
      <div className="stack lg">
        <p className="muted">We’ll stop your weekly payments. {p.nextBillingAt ? <>Your membership stays usable until <strong>{dateShortNoDay(p.nextBillingAt)}</strong>, so you can still book until then.</> : 'You can keep using it until the end of the current week.'}</p>
        <p className="panel-soft">Just need a break? Pausing keeps your membership without billing you.</p>
        <button className="btn danger block" disabled={busy} onClick={go}>{busy ? 'Cancelling…' : 'Cancel membership'}</button>
        <button className="btn ghost block" onClick={onClose}>Keep my membership</button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ catalogue
function IntroCard({ p, onBuy }: { p: Product; onBuy: () => void }) {
  return (
    <button className="intro" onClick={onBuy}>
      <span className="intro-media">
        <img src="img/wide.webp" alt="" className="intro-img" />
        <span className="tag cream intro-tag">New clients only</span>
      </span>
      <span className="intro-body">
        <span className="intro-price serif">{money(p.priceCents)}</span>
        <span className="intro-title serif">{p.validityDays ? `${validityWords(p.validityDays)} of` : ''} unlimited <em>classes</em></span>
        <span className="intro-sub">{p.description || 'Don’t be afraid to do something new – it might be the best thing you ever do.'}</span>
        <span className="btn cream">Claim your intro offer <Icon name="chevron" size={18} /></span>
      </span>
    </button>
  );
}

function ProductCard({ p, onBuy }: { p: Product; onBuy: () => void }) {
  const pc = perClass(p);
  const unit = p.kind === 'membership' ? `/${p.billingInterval === 'month' ? 'month' : 'week'}` : '';
  return (
    <button className={'product' + (p.highlight ? ' hl' : '')} onClick={onBuy}>
      {p.highlight && <span className="product-badge">{p.highlight}</span>}
      <span className="product-top">
        <span className="product-name">{p.name}</span>
        <span className="product-price"><span className="serif">{money(p.priceCents)}</span><span className="muted">{unit}</span></span>
      </span>
      {pc && <span className="product-pc">{pc}</span>}
      {p.description && <span className="product-desc muted">{p.description}</span>}
      <span className="product-cta">{p.kind === 'membership' ? 'Join' : 'Buy'}<Icon name="chevron" size={16} /></span>
    </button>
  );
}

// ------------------------------------------------------------------ checkout
function Checkout({ product, onClose, nav, forId, forLabel }: { product: Product | null; onClose: () => void; nav: Nav; forId?: string; forLabel?: string }) {
  return (
    <Sheet open={!!product} onClose={onClose} label="Checkout">
      {product && <CheckoutBody key={product.id} p={product} onClose={onClose} nav={nav} forId={forId} forLabel={forLabel} />}
    </Sheet>
  );
}

function CheckoutBody({ p, onClose, nav, forId, forLabel }: { p: Product; onClose: () => void; nav: Nav; forId?: string; forLabel?: string }) {
  const app = useApp();
  const toast = useToast();
  const [step, setStep] = useState<'review' | 'pay' | 'done'>('review');
  const [busy, setBusy] = useState<false | 'continue' | 'pay' | 'apple'>(false);
  const [result, setResult] = useState<PurchaseResult | null>(null);
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', exp: '12 / 29', cvc: '123', name: `${app.client.firstName} ${app.client.lastName}`.trim() });
  const isMember = p.kind === 'membership';
  const isClassProduct = p.kind !== 'retail';

  const toPayment = async () => {
    setBusy('continue');
    try {
      if (store.startCheckout) {
        const base = location.href.split('#')[0];
        const returnUrl = `${base}#/passes?paid=${encodeURIComponent(p.id)}${forId ? `&for=${encodeURIComponent(forId)}` : ''}`;
        const r = await store.startCheckout({ clientId: app.client.id, productId: p.id, returnUrl });
        if (r && r.url) { location.href = r.url; return; }
      }
      setStep('pay');
    } catch (e) { toast(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const pay = async (via: 'pay' | 'apple') => {
    setBusy(via);
    try {
      await new Promise((r) => setTimeout(r, 650)); // feels like a real card round-trip
      const r = await store.purchase({ clientId: app.client.id, productId: p.id, method: 'card_online' });
      setResult(r); setStep('done');
    } catch (e) { toast(errorMessage(e)); }
    finally { setBusy(false); }
  };

  if (step === 'done' && result) {
    return (
      <div className="success">
        <div className="success-mark"><Flower size={64} className="bloom" /></div>
        <h2>You’re all <em>set</em></h2>
        <p className="muted">{isClassProduct ? (result.pass?.activatedAt ? 'Your pass is ready to use.' : 'Your pass starts with your first booking.') : 'Grab it from the front desk next time you’re in.'}</p>
        <Receipt sale={result.sale} />
        <div className="stack">
          {forId ? (
            <button className="btn block" onClick={() => { onClose(); nav('/class/' + encodeURIComponent(forId)); }}>Back to {forLabel ?? 'your class'}</button>
          ) : isClassProduct ? (
            <button className="btn block" onClick={() => { onClose(); nav('/'); }}>Book a class</button>
          ) : null}
          <button className="btn ghost block" onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  if (step === 'pay') {
    return (
      <div className="stack lg">
        <SheetHead eyebrow="Checkout" title={<>{money(p.priceCents)} <span className="muted-serif">· {p.name}</span></>} onClose={onClose} />
        {store.mode === 'demo' && <div className="demo-strip"><Icon name="info" size={18} />Demo – no real payment is taken</div>}
        <button className="apple-pay" disabled={!!busy} onClick={() => pay('apple')} aria-label="Pay with Apple Pay">
          {busy === 'apple' ? <Flower size={22} white spin /> : <><Icon name="apple" fill size={22} /><span>Pay</span></>}
        </button>
        <div className="or"><span>or pay with card</span></div>
        <div className="card-form">
          <label className="field"><span>Card number</span>
            <div className="input-icon"><Icon name="card" size={20} /><input className="input" inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} /></div>
          </label>
          <div className="grid2">
            <label className="field"><span>Expiry</span><input className="input" autoComplete="cc-exp" value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} /></label>
            <label className="field"><span>CVC</span><input className="input" inputMode="numeric" autoComplete="cc-csc" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} /></label>
          </div>
          <label className="field"><span>Name on card</span><input className="input" autoComplete="cc-name" value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} /></label>
        </div>
        <button className="btn block big" disabled={!!busy} onClick={() => pay('pay')}>
          {busy === 'pay' ? 'Processing…' : <><Icon name="lock" size={17} />Pay {money(p.priceCents)}</>}
        </button>
        <p className="fine muted center">{isMember ? `Then ${money(p.priceCents)} every ${p.billingInterval === 'month' ? 'month' : 'week'} from your first booking. Cancel or pause any time.` : 'Secure payment. Prices include GST.'}</p>
      </div>
    );
  }

  return (
    <div className="stack lg">
      <SheetHead eyebrow={kindLabel(p).toLowerCase() === p.name.toLowerCase() ? 'New clients only' : kindLabel(p)} title={<Accent text={p.name} />} onClose={onClose} />
      <div className="review-price">
        <span className="serif">{money(p.priceCents)}</span>
        <span className="muted">{isMember ? `per ${p.billingInterval === 'month' ? 'month' : 'week'}` : 'one-off'}{perClass(p) && perClass(p) !== 'Per class' ? ` · ${perClass(p)!.toLowerCase()}` : ''}</span>
      </div>
      {p.description && <p>{p.description}</p>}
      <ul className="ticks">
        <li><Icon name="check" size={18} />{productWhat(p)}</li>
        {isClassProduct && <li><Icon name="check" size={18} />Book any {p.classTypeIds?.length ? 'eligible' : ''} class in the app</li>}
        {isMember && <li><Icon name="check" size={18} />Billed weekly by direct debit, from your first booking</li>}
        {isMember && <li><Icon name="check" size={18} />Pause or cancel any time in the app</li>}
        {p.kind !== 'membership' && isClassProduct && <li><Icon name="check" size={18} />Cancel up to {app.settings.cancelWindowHours} hours before class and the credit comes back</li>}
      </ul>
      {forLabel && <p className="panel-soft">After paying we’ll take you back to <strong>{forLabel}</strong>.</p>}
      <button className="btn block big" disabled={!!busy} onClick={toPayment}>{busy ? 'One moment…' : 'Continue to payment'}</button>
    </div>
  );
}

function kindLabel(p: Product): string {
  return p.kind === 'intro' ? 'Intro offer' : p.kind === 'membership' ? 'Membership' : p.kind === 'retail' ? 'Studio extras' : 'Class pack';
}

// ------------------------------------------------------------------ receipt
export function Receipt({ sale }: { sale: Sale }) {
  const { settings } = useApp();
  const refunded = sale.refundedCents ?? 0;
  return (
    <div className="receipt">
      <div className="receipt-head">
        <Flower size={28} />
        <div>
          <div className="receipt-studio serif">{settings.name}</div>
          {settings.abn && <div className="muted">ABN {settings.abn}</div>}
        </div>
      </div>
      <div className="receipt-meta muted">
        <span>{settings.gstRegistered ? 'Tax invoice' : 'Receipt'} · #{sale.id.slice(-6).toUpperCase()}</span>
        <span>{when(sale.createdAt)}</span>
      </div>
      <div className="receipt-items">
        {sale.items.map((it, i) => (
          <div key={i} className="spread"><span>{it.qty > 1 ? `${it.qty} × ` : ''}{it.name}</span><span>{money(it.unitCents * it.qty, { cents: true })}</span></div>
        ))}
      </div>
      <div className="receipt-total spread"><strong>Total</strong><strong>{money(sale.totalCents, { cents: true })}</strong></div>
      {settings.gstRegistered !== false && <div className="muted">Total includes GST of {money(gstOf(sale.totalCents), { cents: true })}</div>}
      {refunded > 0 && <div className="muted">Refunded {money(refunded, { cents: true })}{sale.refundedAt ? ` on ${dateShortNoDay(sale.refundedAt)}` : ''}</div>}
      <div className="muted">Paid by {sale.method === 'card_online' ? 'card (online)' : sale.method === 'card_reader' ? 'card (in studio)' : sale.method}</div>
    </div>
  );
}

export function ReceiptSkeleton() {
  return <div className="receipt"><Skeleton w="60%" h={22} /><Skeleton h={14} /><Skeleton h={14} /><Skeleton w="40%" h={14} /></div>;
}

export function EmptyPurchases() {
  return <Empty title="No purchases yet">Receipts for passes and memberships will live here.</Empty>;
}
