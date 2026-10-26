/** Studio support UI: small shared pieces (data hook, article card, request thread, photo shrinker). */
import React, { useEffect, useRef, useState } from 'react';
import { store, errorMessage } from '../../../shared/react';
import { Flower } from '../../../shared/brand';
import { SUPPORT_NAME } from '../config';
import { demoDb } from '../demoDb';
import { formatReplyBy } from '../hours';
import { MAX_SCREENSHOT_CHARS, deviceOf, snippet } from '../calc';
import { currentStudio } from '../../../data';
import { STATUS_LABEL, type SupportRequest } from '../types';
import type { HelpArticle } from '../articles';
import { dateTime } from '../../../studio/ui';

export const HELP_OPEN_EVENT = 'support:open';
/** Open the Help sheet from anywhere ("Message us" on the help page). */
export const openHelp = (text?: string) => window.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT, { detail: { text } }));

/** The signed-in staff member's requests, kept fresh (other tabs, the admin replying, and every 20 seconds while mounted). */
export function useMyRequests(active = true) {
  const [state, setState] = useState<{ list: SupportRequest[] | null; error?: string }>({ list: null });
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => {
      const s = store.features.support;
      if (!s) return;
      s.listMine().then((list) => live && setState({ list }), (e) => live && setState((x) => ({ list: x.list ?? [], error: errorMessage(e) })));
    };
    load();
    const offs = [store.subscribe(load), demoDb.subscribe(load)];
    const t = setInterval(load, 20_000);
    return () => { live = false; clearInterval(t); offs.forEach((o) => o()); };
  }, [active]);
  return state;
}

/** "11:20am today" in the studio's timezone. */
export const replyByText = (iso: string, now = new Date()) => formatReplyBy(iso, now, currentStudio?.timezone ?? 'Australia/Sydney');

export function HelpIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" /><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.8" /><path d="M12 17.2h.01" />
    </svg>
  );
}

/** One help article: summary, expandable steps, and "Did this answer it?" when asked. */
export function ArticleCard({ article, open, onToggle, ask, onYes, onNo }: {
  article: HelpArticle; open: boolean; onToggle: () => void; ask?: boolean; onYes?: () => void; onNo?: () => void;
}) {
  return (
    <div className={`sp-art${open ? ' open' : ''}`}>
      <button type="button" className="sp-art-h" onClick={onToggle} aria-expanded={open}>
        <span className="sp-art-t"><strong>{article.title}</strong><span>{article.summary}</span></span>
        <svg className="sp-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="sp-art-b">
          <ol>{article.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {article.tip && <p className="sp-tip"><Flower size={11} /> {article.tip}</p>}
          {ask && (
            <div className="sp-did">
              <span>Did this answer it?</span>
              <button type="button" className="btn sm soft" onClick={onYes}>Yes, thanks</button>
              <button type="button" className="btn sm ghost" onClick={onNo}>Not quite</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StatusChips({ r }: { r: SupportRequest }) {
  return (
    <>
      {r.urgent && <span className="chip danger">Urgent</span>}
      <span className={`chip ${r.status === 'resolved' ? 'ok' : r.status === 'waiting' ? 'cream' : ''}`}>{r.status === 'waiting' ? 'Pete replied' : STATUS_LABEL[r.status]}</span>
    </>
  );
}

/** A request's thread, with a follow-up box. */
export function RequestCard({ r, expanded, onToggle }: { r: SupportRequest; expanded: boolean; onToggle: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !store.features.support) return;
    setBusy(true); setErr('');
    try { await store.features.support.follow(r.id, text); setText(''); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  const last = r.messages[r.messages.length - 1];
  return (
    <div className={`sp-req${expanded ? ' open' : ''}${r.urgent && r.status !== 'resolved' ? ' urgent' : ''}`}>
      <button type="button" className="sp-req-h" onClick={onToggle} aria-expanded={expanded}>
        <span className="sp-req-t"><strong>{snippet(r.body, 80)}</strong><span>{dateTime(r.createdAt)}{last && last.from === 'platform' ? ` · ${last.author} replied` : ''}</span></span>
        <span className="sp-chips"><StatusChips r={r} /></span>
      </button>
      {expanded && (
        <div className="sp-req-b">
          {r.status !== 'resolved' && !r.messages.some((m) => m.from === 'platform') && (
            <p className="sp-promise">{r.urgent ? 'We\'ve been alerted and are on it now.' : r.replyBy ? `${SUPPORT_NAME} will reply by ${replyByText(r.replyBy)}.` : `${SUPPORT_NAME} will reply soon.`}</p>
          )}
          <ul className="sp-thread">
            {r.messages.map((m) => (
              <li key={m.id} className={m.from}>
                <span className="sp-who">{m.from === 'platform' ? `${m.author} (support)` : m.author} · {dateTime(m.at)}</span>
                <p>{m.body}</p>
              </li>
            ))}
          </ul>
          {r.screenshot && <img className="sp-shot" src={r.screenshot} alt="What you attached" />}
          <p className="sp-ctx">Sent from {r.context.route || 'the app'} · {deviceOf(r.context.userAgent)} · v{r.context.appVersion}</p>
          <form className="sp-follow" onSubmit={send}>
            <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={r.status === 'resolved' ? 'Still not right? Tell us here and we\'ll re-open it.' : 'Add to this request…'} aria-label="Reply" />
            {err && <p className="form-error" role="alert">{err}</p>}
            <button className="btn sm" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** A picked image as a small JPEG data URL (long side 1280px), under the size limit. */
export async function shrinkImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a photo or screenshot.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That image is too big. Please pick a smaller one.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('We couldn\'t open that image. Try a JPEG or PNG.')); i.src = url; });
    for (const [max, q] of [[1280, 0.72], [1024, 0.6], [800, 0.5]] as const) {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      if (!g) throw new Error('We couldn\'t read that image.');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL('image/jpeg', q);
      if (out.length <= MAX_SCREENSHOT_CHARS) return out;
    }
    throw new Error('That image is still too big. Try a smaller screenshot.');
  } finally { URL.revokeObjectURL(url); }
}

export const useLatest = <T,>(v: T) => { const r = useRef(v); r.current = v; return r; };
