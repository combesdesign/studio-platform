/**
 * Point of sale slots.
 *   pos.products  barcode / SKU entry (scanner or keyboard, camera where the browser can), gift card tiles
 *   pos.cart      promo codes and gift cards at the till: held while the cart is open, made real when the sale lands
 *
 * The slots only get the subtotal and client from the core POS, so the cart's lines are read from the cart on screen
 * (falling back to the subtotal) and a scan "taps" the product's tile. See NOTES.md › commerce for the slot props
 * that would remove both workarounds.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet, errorMessage, store, useData, useToast } from '../../../shared/react';
import { money } from '../../../shared/format';
import type { Product } from '../../../shared/types';
import { Icon, SheetHead, useStudio } from '../../../studio/ui';
import { commerce, dmy, needCommerce } from '../api';
import { GIFT_STATE_LABEL, cleanScan, makeHoldToken, maskGiftCode, normaliseGiftCode, normalisePromoCode } from '../logic';
import type { GiftCardLookup, HoldResult } from '../types';
import { SellGiftCardSheet } from './shop';

// ------------------------------------------------------------------ pos.products
export function PosProducts({ clientId }: { clientId?: string }) {
  const { can } = useStudio();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sell, setSell] = useState(false);
  const [check, setCheck] = useState(false);
  const [camera, setCamera] = useState(false);
  const canCamera = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  if (!commerce()) return null;

  const find = async (raw: string) => {
    const c = cleanScan(raw);
    if (!c) return;
    setBusy(true);
    try {
      const item = await needCommerce().findRetail(c);
      if (!item) { toast(`No product with barcode or SKU “${c}”`); return; }
      const tile = [...document.querySelectorAll<HTMLButtonElement>('.pos-products .tile')].find((t) => t.querySelector('.tile-name')?.textContent?.trim() === item.name);
      if (!tile) { toast(`${item.name} isn’t on sale right now`); return; }
      if (tile.disabled) { toast(`${item.name} is out of stock`); return; }
      tile.click();
      setCode('');
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <section className="pg cm-pos-top">
      {can('commerce.sell') && (
        <form className="cm-scan" onSubmit={(e) => { e.preventDefault(); find(code); }}>
          <label className="search-in grow">
            <Icon name="search" size={18} />
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan or type a barcode or SKU" aria-label="Barcode or SKU" autoComplete="off" spellCheck={false} enterKeyHint="go" />
          </label>
          <button className="btn soft" disabled={busy || !code.trim()}>Add</button>
          {canCamera && <button type="button" className="btn soft icon" onClick={() => setCamera(true)} aria-label="Scan with the camera"><CameraIcon /></button>}
        </form>
      )}
      <div className="eyebrow">Gift cards</div>
      <div className="tiles">
        {can('commerce.sell') && (
          <button className="tile cm-gift-tile" onClick={() => setSell(true)}>
            <span className="tile-name">Gift card</span>
            <span className="tile-desc">Any amount, printed or emailed</span>
            <span className="tile-price"><Icon name="gift" size={26} /></span>
          </button>
        )}
        <button className="tile" onClick={() => setCheck(true)}>
          <span className="tile-name">Check a balance</span>
          <span className="tile-desc">Gift card or credit code</span>
          <span className="tile-price"><Icon name="search" size={24} /></span>
        </button>
      </div>
      <SellGiftCardSheet open={sell} onClose={() => setSell(false)} clientId={clientId} />
      <Sheet open={check} onClose={() => setCheck(false)} label="Check a gift card balance">{check && <BalanceSheet onClose={() => setCheck(false)} />}</Sheet>
      <Sheet open={camera} onClose={() => setCamera(false)} label="Scan a barcode">{camera && <CameraScan onClose={() => setCamera(false)} onCode={(c) => { setCamera(false); find(c); }} />}</Sheet>
    </section>
  );
}

const CameraIcon = () => (
  <svg className="ic" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="12.8" r="3.4" />
  </svg>
);

/** Camera scanning with the browser's BarcodeDetector (Chrome on Android, some desktops). Only offered where it exists. */
function CameraScan({ onClose, onCode }: { onClose: () => void; onCode: (c: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    (async () => {
      try {
        const Detector = (window as unknown as { BarcodeDetector: new (o?: unknown) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        const det = new Detector();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await det.detect(video.current);
            if (found[0]?.rawValue) { onCode(found[0].rawValue); return; }
          } catch { /* keep looking */ }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch { setErr('The camera isn’t available. Type the barcode instead.'); }
    })();
    return () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return (
    <>
      <SheetHead title={<>Scan a <em>barcode</em></>} sub="Hold the barcode steady inside the frame." onClose={onClose} />
      {err ? <p className="form-err">{err}</p> : <video ref={video} className="cm-video" playsInline muted />}
    </>
  );
}

function BalanceSheet({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [res, setRes] = useState<GiftCardLookup | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setRes(null);
    if (!normaliseGiftCode(code)) { setErr('Gift card codes are 12 letters and numbers.'); return; }
    setBusy(true);
    try { setRes(await needCommerce().lookupGiftCard(code)); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <SheetHead title={<>Check a <em>balance</em></>} onClose={onClose} />
      <form className="stack" onSubmit={go}>
        <div className="cm-inline"><input className="input cm-upper" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" aria-label="Gift card code" autoComplete="off" spellCheck={false} /><button className="btn" disabled={busy || !code.trim()}>Check</button></div>
        {err && <p className="form-err">{err}</p>}
        {res && (
          <div className="panel">
            <div className="cm-kpi-v serif">{money(res.balanceCents, { cents: true })}</div>
            <p className="muted">{res.kind === 'credit' ? 'Account credit' : 'Gift card'} · {GIFT_STATE_LABEL[res.state]}{res.expiresAt ? ` · expires ${dmy(res.expiresAt)}` : ''}</p>
          </div>
        )}
      </form>
    </>
  );
}

// ------------------------------------------------------------------ pos.cart
type Line = { productId: string; qty: number };
/** The cart as shown on screen (the slot only gets the subtotal). null if it can't be read exactly. */
function readCart(products: Product[], subtotal: number): Line[] | null {
  const rows = [...document.querySelectorAll('.pos-cart .pc-line')];
  if (!rows.length) return null;
  const lines: Line[] = [];
  for (const r of rows) {
    const name = r.querySelector('strong')?.textContent?.trim();
    const p = products.filter((x) => x.name === name);
    if (p.length !== 1) return null;
    const qty = Number(r.querySelector('.mini-step span')?.textContent ?? 1) || 1;
    lines.push({ productId: p[0]!.id, qty });
  }
  const sum = lines.reduce((n, l) => n + (products.find((p) => p.id === l.productId)?.priceCents ?? 0) * l.qty, 0);
  return sum === subtotal ? lines : null;
}

export function PosCodes({ clientId, subtotalCents, setDiscount }: { clientId?: string; subtotalCents: number; setDiscount: (cents: number, note: string) => void }) {
  const toast = useToast();
  const products = useData(() => store.listProducts(), []);
  const [open, setOpen] = useState(false);
  const [promoIn, setPromoIn] = useState('');
  const [giftIn, setGiftIn] = useState('');
  const [promo, setPromo] = useState('');
  const [gifts, setGifts] = useState<string[]>([]);
  const [hold, setHold] = useState<HoldResult | null>(null);
  const token = useRef<string>(makeHoldToken());
  const held = useRef(false);
  const seq = useRef(0);
  const disc = useRef(setDiscount);
  disc.current = setDiscount;
  const any = !!promo || gifts.length > 0;

  useEffect(() => {
    const cm = commerce();
    if (!cm) return;
    const n = ++seq.current;
    if (!any) {
      if (held.current) { held.current = false; cm.settleHold(token.current).catch(() => {}); token.current = makeHoldToken(); disc.current(0, ' '); }
      setHold(null);
      return;
    }
    if (!products.data) return;
    const items = readCart(products.data, subtotalCents);
    held.current = true;
    cm.holdCodes({ token: token.current, ...(clientId ? { clientId } : {}), ...(items ? { items } : { subtotalCents }), ...(promo ? { promoCode: promo } : {}), ...(gifts.length ? { giftCodes: gifts } : {}) })
      .then((r) => {
        if (n !== seq.current) return;
        setHold(r);
        disc.current(r.quote.promoCents + r.quote.giftCents, r.note || ' ');
      }, (e) => { if (n === seq.current) toast(errorMessage(e)); });
  }, [promo, gifts.join('|'), subtotalCents, clientId, !!products.data]);

  // Leaving the cart (sale done, emptied or page closed): the hold becomes real if the sale has landed, otherwise it's released.
  useEffect(() => () => { if (held.current) commerce()?.settleHold(token.current).catch(() => {}); }, []);

  const q = hold?.quote;
  const giftLine = (c: string) => q?.gifts.find((g) => g.code === c);
  const giftErr = (c: string) => q?.giftErrors.find((g) => g.code === c)?.message;
  if (!commerce()) return null;
  if (!open && !any) {
    return <button className="linkish cm-pos-open" onClick={() => setOpen(true)}><Icon name="ticket" size={16} />Promo code or gift card</button>;
  }
  return (
    <div className="cm-pos-codes">
      <form className="cm-inline" onSubmit={(e) => { e.preventDefault(); setPromo(normalisePromoCode(promoIn)); setPromoIn(''); }}>
        <input className="input sm cm-upper" value={promoIn} onChange={(e) => setPromoIn(e.target.value)} placeholder="Promo code" aria-label="Promo code" autoComplete="off" spellCheck={false} />
        <button className="btn sm soft" disabled={!promoIn.trim()}>Apply</button>
      </form>
      {promo && (
        <div className={'cm-applied' + (q?.promoError ? ' bad' : '')}>
          <span className="cm-code promo">{promo}</span>
          <span className="grow small">{q?.promoError ? <span className="danger-text">{q.promoError}</span> : q?.promo ? <>{q.promo.label} · −{money(q.promoCents, { cents: true })}</> : 'Checking…'}</span>
          <button className="pc-x" onClick={() => setPromo('')} aria-label="Remove promo code"><Icon name="x" size={16} /></button>
        </div>
      )}
      <form className="cm-inline" onSubmit={(e) => { e.preventDefault(); const c = normaliseGiftCode(giftIn) || giftIn.trim().toUpperCase(); if (c && !gifts.includes(c)) setGifts([...gifts, c]); setGiftIn(''); }}>
        <input className="input sm cm-upper" value={giftIn} onChange={(e) => setGiftIn(e.target.value)} placeholder="Gift card or credit code" aria-label="Gift card code" autoComplete="off" spellCheck={false} />
        <button className="btn sm soft" disabled={!giftIn.trim()}>Add</button>
      </form>
      {gifts.map((c) => (
        <div key={c} className={'cm-applied' + (giftErr(c) ? ' bad' : '')}>
          <span className="cm-code">{normaliseGiftCode(c) ? maskGiftCode(c) : c}</span>
          <span className="grow small">{giftErr(c) ? <span className="danger-text">{giftErr(c)}</span> : giftLine(c) ? <>−{money(giftLine(c)!.appliedCents, { cents: true })} <span className="faint">· {money(giftLine(c)!.balanceCents - giftLine(c)!.appliedCents, { cents: true })} left after</span></> : 'Checking…'}</span>
          <button className="pc-x" onClick={() => setGifts(gifts.filter((x) => x !== c))} aria-label="Remove gift card"><Icon name="x" size={16} /></button>
        </div>
      ))}
      {q && q.totalCents > 0 && q.giftCents > 0 && <p className="pc-hint"><Icon name="card" size={16} />{money(q.totalCents, { cents: true })} left to pay by card or cash.</p>}
    </div>
  );
}

export const useCommerceReady = () => useMemo(() => !!commerce(), []);
