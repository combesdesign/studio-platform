/**
 * Stripe Terminal card reader at the desk: Settings > Payments > Card reader (register, choose this device's default, remove)
 * and the "Tap or insert card on the reader" sheet the POS opens. Server-driven: the app never sees card data and never
 * sends an amount; the server works the total out from the cart and the app just polls until it is paid, declined or cancelled.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet, store, useAction, useData } from '../shared/react';
import { money } from '../shared/format';
import type { Pass, Sale, TerminalPaymentStatus, TerminalReader } from '../shared/types';
import { Icon, Loading, SheetHead, cx, useStudio } from './ui';

// ------------------------------------------------------------------ this device's default reader (stored locally, per studio)
const key = (studioId: string) => `terminal-reader:${studioId}`;
export function getDefaultReaderId(studioId: string): string | null {
  try { return localStorage.getItem(key(studioId)); } catch { return null; }
}
export function setDefaultReaderId(studioId: string, id: string | null): void {
  try { if (id) localStorage.setItem(key(studioId), id); else localStorage.removeItem(key(studioId)); } catch { /* private window: it just won't be remembered */ }
}
/** The registered readers, and the one this device uses (its saved choice if that reader still exists, else the first). */
export function useReaders() {
  const { studio } = useStudio();
  const list = useData(() => (store.terminalReaders ? store.terminalReaders() : Promise.resolve([] as TerminalReader[])), [studio.id]);
  const readers = list.data ?? [];
  const saved = getDefaultReaderId(studio.id);
  const current = readers.find((r) => r.id === saved) ?? readers[0] ?? null;
  return { readers, current, loading: list.loading && !list.data, reload: list.reload };
}

// ------------------------------------------------------------------ Settings > Payments > Card reader
export function CardReaderPanel() {
  const { studio, can } = useStudio();
  const { readers, current, loading, reload } = useReaders();
  const { busy, run } = useAction();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Front desk');
  const [, bump] = useState(0);
  const manage = can('settings');
  const demo = store.mode === 'demo';
  if (!store.terminalReaders) return null;

  const add = async () => {
    const r = await run(() => store.registerTerminalReader!({ code: code.trim(), label: label.trim() }), 'Card reader added');
    if (!r) return;
    if (!current) setDefaultReaderId(studio.id, r.id);
    setCode('');
    reload();
  };
  const remove = async (r: TerminalReader) => {
    if (!window.confirm(`Remove ${r.label || 'this reader'}? You can add it again with a new pairing code.`)) return;
    if (await run(() => store.removeTerminalReader!(r.id), 'Card reader removed') === undefined) return;
    if (getDefaultReaderId(studio.id) === r.id) setDefaultReaderId(studio.id, null);
    reload();
  };

  return (
    <div className="stack" data-testid="card-reader-panel">
      <div>
        <strong>Card reader</strong>
        <p className="small muted" style={{ marginTop: 4 }}>Take card payments at the desk with a Stripe smart reader (Stripe Reader S700 or BBPOS WisePOS E). It connects over wifi, so it works with the iPad.</p>
      </div>
      {loading ? <Loading /> : readers.length === 0 ? <p className="small muted">No reader yet.</p> : (
        <ul className="reader-list">
          {readers.map((r) => (
            <li key={r.id} className={cx('reader', current?.id === r.id && 'on')}>
              <Icon name="card" size={22} />
              <div className="grow">
                <strong>{r.label || 'Card reader'}</strong>
                <div className="small muted">{r.simulated ? 'Demo reader (simulated)' : r.deviceType.replace(/_/g, ' ') || 'Smart reader'} · <span className={r.status === 'online' ? 'ok-text' : 'warn-text'}>{r.status === 'online' ? 'Online' : 'Offline'}</span></div>
              </div>
              {current?.id === r.id
                ? <span className="chip ok">This device</span>
                : <button className="btn sm soft" onClick={() => { setDefaultReaderId(studio.id, r.id); bump((n) => n + 1); }}>Use on this device</button>}
              {manage && <button className="btn sm ghost" onClick={() => remove(r)} disabled={busy}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {manage ? (
        <div className="panel">
          <strong>Add a reader</strong>
          <p className="small muted" style={{ margin: '4px 0 12px' }}>On the reader, open its settings and choose Generate pairing code, then type the words it shows (like <em>sepia-cat-river</em>) here.{demo ? ' In the demo any code works.' : ''}</p>
          <div className="form-grid">
            <label className="field"><span>Name</span><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk" /></label>
            <label className="field"><span>Pairing code</span><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="sepia-cat-river" autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn" onClick={add} disabled={busy || !code.trim()}>{busy ? 'Adding…' : 'Add reader'}</button></div>
        </div>
      ) : <p className="small muted">Only the owner or a manager can add or remove readers.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ POS: waiting for the card
export interface TerminalCart { clientId?: string; items: { productId: string; qty: number }[]; discountCents?: number; note?: string }
type View = { k: 'starting' } | { k: 'waiting'; amount: number } | { k: 'ended'; s: TerminalPaymentStatus };
const POLL_MS = 1500;
/** The app stops waiting after this long even if the server hasn't said (the server gives up at 150s too). */
const GIVE_UP_MS = 165_000;
const newAttemptId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, '');

export function TerminalPaySheet({ open, reader, cart, onClose, onPaid }: {
  open: boolean; reader: TerminalReader; cart: TerminalCart; onClose: () => void;
  onPaid: (r: { sale: Sale; passes: Pass[] }) => void;
}) {
  const [view, setView] = useState<View>({ k: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const payId = useRef<string | null>(null);
  const stopped = useRef(false);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const paid = useRef(onPaid);
  paid.current = onPaid;

  const finish = useCallback((s: TerminalPaymentStatus) => {
    stopped.current = true;
    if (s.state === 'succeeded' && s.sale) { paid.current({ sale: s.sale, passes: s.passes ?? [] }); return; }
    setView({ k: 'ended', s });
  }, []);

  useEffect(() => {
    if (!open) return;
    stopped.current = false; payId.current = null;
    setView({ k: 'starting' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const began = Date.now();
    const poll = async () => {
      if (stopped.current || !payId.current) return;
      try {
        const s = await store.terminalPaymentStatus!(payId.current);
        if (stopped.current) return;
        if (s.state !== 'pending') { finish(s); return; }
      } catch { /* a blip in the connection: keep polling until we give up */ }
      if (Date.now() - began > GIVE_UP_MS) { finish({ state: 'timeout', message: 'The reader didn’t get a card in time.' }); return; }
      timer = setTimeout(poll, POLL_MS);
    };
    (async () => {
      try {
        const c = cartRef.current;
        const r = await store.startTerminalPayment!({ readerId: reader.id, attemptId: newAttemptId(), ...(c.clientId ? { clientId: c.clientId } : {}), items: c.items, ...(c.discountCents ? { discountCents: c.discountCents } : {}), ...(c.note ? { note: c.note } : {}) });
        if (stopped.current) return;
        payId.current = r.paymentId;
        setView({ k: 'waiting', amount: r.amountCents });
        timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!stopped.current) finish({ state: 'failed', message: e instanceof Error ? e.message : 'We couldn’t reach the card reader.' });
      }
    })();
    return () => { stopped.current = true; if (timer) clearTimeout(timer); };
  }, [open, attempt, reader.id, finish]);

  const cancel = async () => {
    const id = payId.current;
    stopped.current = true;
    if (!id) { onClose(); return; }
    try { const s = await store.cancelTerminalPayment!(id); if (s.state === 'succeeded' && s.sale) { paid.current({ sale: s.sale, passes: s.passes ?? [] }); return; } } catch { /* the reader clears itself */ }
    onClose();
  };

  const ended = view.k === 'ended' ? view.s : null;
  const title = ended ? ({ declined: 'Card declined', timeout: 'Timed out', canceled: 'Cancelled', failed: 'Didn’t go through', paid_unrecorded: 'Check Stripe', succeeded: 'Paid', pending: '' } as const)[ended.state] : 'Card reader';
  return (
    <Sheet open={open} onClose={ended ? onClose : cancel} label="Card reader payment">
      <SheetHead title={<>{title}</>} onClose={ended ? onClose : cancel} />
      <div className="term" data-testid="terminal-sheet" aria-live="polite">
        {!ended ? (
          <>
            <div className="term-ring"><Icon name="card" size={44} /></div>
            <h2>{view.k === 'starting' ? 'Waking the reader…' : 'Tap or insert card on the reader'}</h2>
            <p className="term-amt">{view.k === 'waiting' ? money(view.amount, { cents: true }) : ' '}</p>
            <p className="muted small">{reader.label || 'Card reader'}{reader.simulated ? ' (demo reader, it approves in a couple of seconds)' : ''}</p>
            <button className="btn ghost" onClick={cancel} data-testid="terminal-cancel">Cancel</button>
          </>
        ) : (
          <>
            <div className="term-ring bad"><Icon name="x" size={44} /></div>
            <h2>{ended.message || ({ declined: 'The card was declined.', timeout: 'The reader didn’t get a card in time.', canceled: 'Payment cancelled. Nothing was charged.', failed: 'The payment didn’t go through.' } as Record<string, string>)[ended.state] || 'Something went wrong.'}</h2>
            {ended.state === 'canceled' && <p className="muted small">The cart is still here when you’re ready.</p>}
            <div className="row" style={{ justifyContent: 'center' }}>
              {ended.state !== 'paid_unrecorded' && <button className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
              <button className="btn ghost" onClick={onClose}>Back to cart</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
