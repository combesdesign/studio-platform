/** Small shared React helpers for both apps: store hooks, hash router, toast, sheet. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { store } from '../data';
import { StoreError } from './store';

export { store };
export { featureOn } from '../data';

/**
 * Run an async loader and re-run it whenever the store changes (any tab) or deps change.
 * const { data, error, loading, reload } = useData(() => store.listSessions({...}), [day]);
 */
export function useData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    loader().then(
      (data) => n === seq.current && setState({ data, loading: false }),
      (error) => n === seq.current && setState({ error, loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { setState((s) => ({ ...s, loading: true })); run(); }, [run]);
  useEffect(() => store.subscribe(run), [run]);
  return { ...state, reload: run };
}

/** Friendly message for any thrown error. */
export function errorMessage(e: unknown): string {
  if (e instanceof StoreError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong. Please try again.';
}

// ------------------------------------------------------------------ hash router
/** Current hash path, e.g. '#/classes/abc' -> '/classes/abc'. Works inside Capacitor too. */
export function useRoute(): [string, (to: string, opts?: { replace?: boolean }) => void] {
  const get = () => (location.hash.replace(/^#/, '') || '/');
  const [path, setPath] = useState(get);
  useEffect(() => {
    const on = () => { setPath(get()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const nav = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) location.replace('#' + to); else location.hash = to;
  }, []);
  return [path, nav];
}

/** Match '/class/:id' against '/class/123' -> { id: '123' } | null */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean), a = path.split('?')[0]!.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) out[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return out;
}

// ------------------------------------------------------------------ toast
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number>();
  const show = useCallback((m: string) => {
    setMsg(m); window.clearTimeout(t.current); t.current = window.setTimeout(() => setMsg(null), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ back button support (history entries for sheets + in-sheet steps)
// Each open sheet (and each active in-sheet step) pushes one history entry with a marker in its state and the
// SAME url, so the hash router (useRoute / hashchange) never notices. The phone/browser back button or the
// Android back gesture then pops that entry and we close the sheet instead of leaving the screen.
// Closing with ✕ / scrim / Esc pops the entry again, but only if it's still on top (so nothing doubles up).
// An entry whose sheet is already gone ("orphan", e.g. after one sheet swaps for another) is skipped over.
type BackEntry = { token: string; t: number; onBack: () => void; done: boolean };
const backLive: BackEntry[] = [];
let backSeq = Date.now() * 1000;
let backLastT: number | undefined;
let backTraversing = 0; // history.back()/forward() calls of ours that haven't landed yet
let backQueue: (() => void)[] = []; // pushes waiting for those traversals to land
let afterLeave: (() => void) | null = null;
let backInstalled = false;

const hstate = (): any => { try { return history.state; } catch { return null; } };
function flushBackQueue() { const q = backQueue; backQueue = []; q.forEach((f) => f()); }
let lastTraverse = 0;
function traverse(dir: -1 | 1) {
  backTraversing++;
  lastTraverse = Date.now();
  // If the browser has nowhere to go, no popstate arrives, so don't wait forever.
  window.setTimeout(() => {
    if (backTraversing === 0 || Date.now() - lastTraverse < 390) return;
    backTraversing = 0;
    if (afterLeave) { const f = afterLeave; afterLeave = null; f(); }
    flushBackQueue();
  }, 400);
  if (dir < 0) history.back(); else history.forward();
}
function stampEntry() {
  const st = hstate();
  if (st && typeof st === 'object' && st.spcT != null) { backLastT = st.spcT; return; }
  try { history.replaceState({ ...(st && typeof st === 'object' ? st : {}), spcT: ++backSeq }, ''); backLastT = backSeq; } catch { /* sandboxed */ }
}
function installBack() {
  if (backInstalled || typeof window === 'undefined') return;
  backInstalled = true;
  const st = hstate();
  // Reloaded while a sheet was open: that entry is a leftover, step off it.
  if (st && st.spcBack) { backLastT = st.spcT; traverse(-1); } else stampEntry();
  window.addEventListener('hashchange', stampEntry);
  window.addEventListener('popstate', () => {
    const s = hstate();
    const t: number | undefined = s && typeof s === 'object' ? s.spcT : undefined;
    const prevT = backLastT;
    if (t != null) backLastT = t;
    if (backTraversing > 0) backTraversing--;
    // Close every sheet / step whose entry is now above where we are.
    for (let i = backLive.length - 1; i >= 0; i--) {
      const e = backLive[i]!;
      if (t == null || e.t > t) { backLive.splice(i, 1); if (!e.done) { e.done = true; e.onBack(); } }
    }
    const onMarker = !!(s && s.spcBack);
    if (afterLeave && onMarker) { traverse(-1); return; } // leaving every sheet: keep stepping back
    if (onMarker && !backLive.some((e) => e.token === s.spcBack)) { traverse(t != null && prevT != null && t > prevT ? 1 : -1); return; }
    if (afterLeave) { const f = afterLeave; afterLeave = null; f(); }
    if (backTraversing === 0) flushBackQueue();
  });
}
if (typeof window !== 'undefined') installBack();

/** True when the current history entry belongs to an open sheet or step (not a route). */
export function onSheetEntry(): boolean { return !!hstate()?.spcBack; }

/**
 * Close every open sheet by stepping back past their history entries, then run `then` (usually a route change).
 * Use this instead of `onClose(); nav(...)` so sheet entries don't pile up under the new route.
 */
export function leaveSheets(then: () => void, opts?: { quiet?: boolean }) {
  installBack();
  if (!onSheetEntry()) { then(); return; }
  afterLeave = then;
  const live = backLive.splice(0);
  live.forEach((e) => { e.done = true; });
  // quiet: the screen is about to change anyway, so don't step its UI back first (avoids a flash)
  if (!opts?.quiet) live.reverse().forEach((e) => e.onBack());
  traverse(-1);
}

/**
 * While `active`, the phone/browser back button calls `onBack` instead of leaving the screen.
 * Used by Sheet, and by multi-step flows inside sheets or pages (back goes one step back).
 */
export function useBackHandler(active: boolean, onBack: () => void) {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!active) return;
    installBack();
    const t = ++backSeq;
    const e: BackEntry = { token: 'b' + t, t, onBack: () => cb.current(), done: false };
    let pushed = false;
    const push = () => {
      if (e.done) return;
      try { history.pushState({ spcT: t, spcBack: e.token }, ''); pushed = true; backLastT = t; backLive.push(e); } catch { /* sandboxed: no history */ }
    };
    if (backTraversing > 0 || afterLeave) backQueue.push(push); else push();
    return () => {
      const i = backLive.indexOf(e);
      if (i >= 0) backLive.splice(i, 1);
      if (e.done) return;
      e.done = true;
      if (!pushed) return;
      // Deferred: if this close is followed by a link / route change in the same tick, our entry is no
      // longer on top and mustn't be popped (it becomes an orphan that back skips over instead).
      window.setTimeout(() => { if (hstate()?.spcBack === e.token) traverse(-1); }, 0);
    };
  }, [active]);
}

// ------------------------------------------------------------------ sheet (bottom sheet on phones, modal on desktop)
const openSheets: { current: () => void }[] = [];
let lockCount = 0;

/**
 * Bottom sheet on phones, centred modal from 760px. The back button / gesture closes it (useBackHandler),
 * Esc closes the top one, and on touch it can be dragged down by the grip or header (or from the content
 * when that's scrolled to the top). Start the content with a pinned header (.sheet-head / .sh-head / .sheet-bar)
 * so ✕ or back stays in reach.
 */
export function Sheet({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: React.ReactNode; label: string }) {
  const close = useRef(onClose);
  close.current = onClose;
  useBackHandler(open, () => close.current());
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const me = { current: () => close.current() };
    openSheets.push(me);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && openSheets[openSheets.length - 1] === me) { e.preventDefault(); me.current(); } };
    window.addEventListener('keydown', k);
    if (lockCount++ === 0) document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', k);
      const i = openSheets.indexOf(me);
      if (i >= 0) openSheets.splice(i, 1);
      if (--lockCount === 0) document.body.style.overflow = '';
    };
  }, [open]);

  // ---- swipe down to close (touch / pen, bottom-sheet layout only)
  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current, scroller = scrollRef.current;
    if (!sheet || !scroller) return;
    const phone = () => !window.matchMedia('(min-width: 760px)').matches;
    let startY = 0, startX = 0, dy = 0, dragging = false, decided = false, closing = false;
    let samples: [number, number][] = [];
    let mode: 'pointer' | 'touch' | null = null;
    let pid = -1;
    const set = (y: number, anim?: boolean) => {
      sheet.style.transition = anim ? 'transform .24s cubic-bezier(.2,.7,.2,1)' : 'none';
      sheet.style.transform = y > 0 ? `translateY(${y}px)` : '';
      const scrim = scrimRef.current;
      if (scrim) { scrim.style.transition = anim ? 'opacity .24s ease' : 'none'; scrim.style.opacity = String(Math.max(0, 1 - y / (sheet.offsetHeight || 1))); }
    };
    const begin = (x: number, y: number) => { startX = x; startY = y; dy = 0; dragging = false; decided = false; samples = [[performance.now(), y]]; };
    const move = (x: number, y: number): boolean => {
      dy = y - startY;
      if (!decided) {
        if (Math.abs(dy) < 6 && Math.abs(x - startX) < 6) return false;
        decided = true;
        dragging = dy > 0 && Math.abs(dy) > Math.abs(x - startX);
      }
      if (!dragging) return false;
      samples.push([performance.now(), y]);
      if (samples.length > 6) samples.shift();
      set(Math.max(0, dy));
      return true;
    };
    const end = () => {
      mode = null;
      if (!dragging) return;
      dragging = false;
      const [t0, y0] = samples[0]!, [t1, y1] = samples[samples.length - 1]!;
      const v = (y1 - y0) / Math.max(1, t1 - t0); // px per ms
      if (dy > 100 || (v > 0.55 && dy > 24)) {
        closing = true;
        set(sheet.offsetHeight + 40, true);
        window.setTimeout(() => close.current(), 190);
      } else set(0, true);
    };
    const interactive = (el: Element | null) => !!el?.closest('button, a, input, select, textarea, label, [role="radio"], [role="switch"], [contenteditable]');
    const inHandle = (el: Element | null) => !!el?.closest('.sheet-grip, .sheet-head, .sh-head, .sheet-bar, [data-sheet-drag]');
    // An inner scroller under the finger (e.g. the waiver text) keeps its own scrolling.
    const innerScroll = (el: Element | null) => {
      for (let n = el as HTMLElement | null; n && n !== scroller; n = n.parentElement) {
        const o = getComputedStyle(n).overflowY;
        if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
      }
      return false;
    };

    // 1) grip + pinned header: pointer events (touch-action: none there, in CSS)
    const pDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !phone() || mode || closing) return;
      const el = e.target as Element;
      if (!inHandle(el) || interactive(el)) return;
      mode = 'pointer'; pid = e.pointerId; begin(e.clientX, e.clientY);
    };
    const pMove = (e: PointerEvent) => {
      if (mode !== 'pointer' || e.pointerId !== pid) return;
      if (move(e.clientX, e.clientY)) { try { sheet.setPointerCapture(pid); } catch { /* */ } }
    };
    const pUp = (e: PointerEvent) => { if (mode === 'pointer' && e.pointerId === pid) end(); };
    const pCancel = (e: PointerEvent) => { if (mode === 'pointer' && e.pointerId === pid) { mode = null; if (dragging) { dragging = false; set(0, true); } } };

    // 2) content: only while it's scrolled to the very top and the finger moves down
    const tStart = (e: TouchEvent) => {
      if (mode || closing || !phone() || e.touches.length !== 1) return;
      const el = e.target as Element;
      if (inHandle(el) || scroller.scrollTop > 0 || innerScroll(el) || el.closest('input, select, textarea')) return;
      const t = e.touches[0]!;
      mode = 'touch'; begin(t.clientX, t.clientY);
    };
    const tMove = (e: TouchEvent) => {
      if (mode !== 'touch') return;
      const t = e.touches[0]!;
      if (!dragging && scroller.scrollTop > 0) { mode = null; return; }
      if (move(t.clientX, t.clientY)) { if (e.cancelable) e.preventDefault(); }
      else if (decided) mode = null; // scrolling up or sideways: leave it to the browser
    };
    const tEnd = () => { if (mode === 'touch') end(); };

    // pinned headers get a hairline once the content scrolls under them
    const onScroll = () => { if ((scroller.scrollTop > 2) !== scroller.hasAttribute('data-scrolled')) scroller.toggleAttribute('data-scrolled', scroller.scrollTop > 2); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    sheet.addEventListener('pointerdown', pDown);
    sheet.addEventListener('pointermove', pMove);
    sheet.addEventListener('pointerup', pUp);
    sheet.addEventListener('pointercancel', pCancel);
    scroller.addEventListener('touchstart', tStart, { passive: true });
    scroller.addEventListener('touchmove', tMove, { passive: false });
    scroller.addEventListener('touchend', tEnd);
    scroller.addEventListener('touchcancel', tEnd);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      sheet.removeEventListener('pointerdown', pDown);
      sheet.removeEventListener('pointermove', pMove);
      sheet.removeEventListener('pointerup', pUp);
      sheet.removeEventListener('pointercancel', pCancel);
      scroller.removeEventListener('touchstart', tStart);
      scroller.removeEventListener('touchmove', tMove);
      scroller.removeEventListener('touchend', tEnd);
      scroller.removeEventListener('touchcancel', tEnd);
    };
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="scrim" ref={scrimRef} onClick={() => close.current()} />
      <div className="sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label={label}>
        <div className="sheet-grip" aria-hidden="true"><span /></div>
        <div className="sheet-scroll" ref={scrollRef}>{children}</div>
      </div>
    </>
  );
}

export function DemoBadge() {
  return store.mode === 'demo' ? <div className="demo-badge">DEMO</div> : null;
}

/** Async button handler with busy state + toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (success) toast(success); return r; }
    catch (e) { toast(errorMessage(e)); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return useMemo(() => ({ busy, run }), [busy, run]);
}
