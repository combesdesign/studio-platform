/** Small shared React helpers for both apps: store hooks, hash router, toast, sheet. */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { store } from '../data';
import { StoreError } from './store';

export { store };

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

// ------------------------------------------------------------------ sheet (bottom sheet on phones, modal on desktop)
export function Sheet({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: React.ReactNode; label: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
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
