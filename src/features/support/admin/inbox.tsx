/**
 * Platform admin: the support inbox (every studio's requests, urgent pinned) and the platform status banner.
 * Plugged into src/admin/main.tsx with one route and one nav link (SupportNavLink / SupportInbox).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Accented, Flower } from '../../../shared/brand';
import { deviceOf, inboxOrder, snippet } from '../calc';
import { SUPPORT_TZ } from '../config';
import { replyBy } from '../hours';
import { STATUS_LABEL, type SupportBanner, type SupportRequest, type SupportStatus } from '../types';
import { supportAdmin } from './store';
import './support-admin.css';

const msg = (e: unknown) => (e instanceof Error ? e.message.replace(/^[A-Z_]+: /, '') : 'Something went wrong. Please try again.');

function useInbox() {
  const [state, setState] = useState<{ list: SupportRequest[] | null; error?: string }>({ list: null });
  useEffect(() => {
    let live = true;
    const s = supportAdmin();
    const load = () => s.list().then((list) => live && setState({ list }), (e) => live && setState((x) => ({ list: x.list ?? [], error: msg(e) })));
    load();
    const off = s.subscribe(load);
    return () => { live = false; off(); };
  }, []);
  return state;
}

const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: SUPPORT_TZ, ...o }).format(new Date(iso));
const stamp = (iso: string) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).replace(',', '').replace(/\s?([ap])m/i, (_m, x: string) => x.toLowerCase() + 'm');
function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

/** Header link with a count of open requests (urgent ones in red). */
export function SupportNavLink({ active }: { active: boolean }) {
  const { list } = useInbox();
  const open = (list ?? []).filter((r) => r.status !== 'resolved');
  const urgent = open.filter((r) => r.urgent).length;
  return (
    <a href="#/support" className={active ? 'on' : ''} aria-current={active ? 'page' : undefined}>
      Support{open.length > 0 && <span className={`ad-count${urgent ? ' urgent' : ''}`}>{open.length}</span>}
    </a>
  );
}

export function SupportInbox() {
  const inbox = useInbox();
  const [filter, setFilter] = useState<'all' | SupportStatus>('all');
  const [sel, setSel] = useState<string | null>(null);
  const all = inbox.list ?? [];
  const shown = useMemo(() => inboxOrder(all.filter((r) => filter === 'all' || r.status === filter)), [all, filter]);
  const current = all.find((r) => r.id === sel) ?? null;
  const count = (s: SupportStatus) => all.filter((r) => r.status === s).length;
  useEffect(() => { if (!sel && shown[0] && window.matchMedia('(min-width: 900px)').matches) setSel(shown[0].id); }, [shown.length]);
  return (
    <div className="stack lg">
      <div className="ad-head">
        <div>
          <p className="eyebrow">{all.filter((r) => r.status !== 'resolved').length} open · {all.filter((r) => r.urgent && r.status !== 'resolved').length} urgent · {all.length} in total</p>
          <h1><Accented text="Support *inbox*" /></h1>
        </div>
      </div>
      <StatusBanner />
      {inbox.error && <p className="form-error" role="alert">{inbox.error}</p>}
      <nav className="tabs" aria-label="Filter requests">
        {([['all', `All (${all.length})`], ['open', `Open (${count('open')})`], ['waiting', `Waiting (${count('waiting')})`], ['resolved', `Resolved (${count('resolved')})`]] as const).map(([k, l]) => (
          <a key={k} href="#/support" className={filter === k ? 'on' : ''} onClick={(e) => { e.preventDefault(); setFilter(k); }}>{l}</a>
        ))}
      </nav>
      <div className={`si${current ? ' has-sel' : ''}`}>
        <div className="si-list" role="list" aria-label="Requests">
          {inbox.list === null && <p className="muted ad-empty"><Flower size={16} spin /> Loading…</p>}
          {inbox.list && shown.length === 0 && <p className="muted ad-empty">Nothing here. Lovely.</p>}
          {shown.map((r) => (
            <button key={r.id} role="listitem" className={`si-row${r.id === sel ? ' on' : ''}${r.urgent && r.status !== 'resolved' ? ' urgent' : ''}`} onClick={() => setSel(r.id)}>
              <span className="si-top">
                <strong>{r.studioName}</strong>
                {r.urgent && r.status !== 'resolved' && <span className="chip danger">Urgent</span>}
                <span className={`chip ${r.status === 'resolved' ? 'ok' : r.status === 'waiting' ? 'cream' : ''}`}>{STATUS_LABEL[r.status]}</span>
                <span className="si-time">{ago(r.createdAt)}</span>
              </span>
              <span className="si-body">{snippet(r.body, 120)}</span>
              <span className="si-who">{r.staffName} · {r.staffRole.replace('_', ' ')}{r.messages.length > 1 ? ` · ${r.messages.length} messages` : ''}</span>
            </button>
          ))}
        </div>
        {current ? <Detail key={current.id} r={current} onBack={() => setSel(null)} /> : <div className="si-detail empty muted"><p>Pick a request to read and reply.</p></div>}
      </div>
    </div>
  );
}

function Detail({ r, onBack }: { r: SupportRequest; onBack: () => void }) {
  const s = supportAdmin();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<SupportStatus>('waiting');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  const send = (e: React.FormEvent) => { e.preventDefault(); if (text.trim()) void act(async () => { await s.reply(r.id, text, status); setText(''); }); };
  const overdue = !r.urgent && r.status === 'open' && r.replyBy && Date.parse(r.replyBy) < Date.now() && !r.messages.some((m) => m.from === 'platform');
  return (
    <article className="si-detail" aria-label="Request">
      <button className="back-pill si-back" onClick={onBack}><svg className="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M14.5 6l-6 6 6 6" /></svg><span>All requests</span></button>
      <header className="si-dh">
        <div>
          <p className="eyebrow">{r.urgent && <span className="chip danger">Urgent: clients can't book or pay</span>} <span className={`chip ${r.status === 'resolved' ? 'ok' : r.status === 'waiting' ? 'cream' : ''}`}>{STATUS_LABEL[r.status]}</span></p>
          <h2>{r.studioName}</h2>
          <p className="muted">{r.staffName} ({r.staffRole.replace('_', ' ')}) · {stamp(r.createdAt)}</p>
        </div>
        <div className="row" role="group" aria-label="Set status">
          {(['open', 'waiting', 'resolved'] as const).map((k) => (
            <button key={k} className={`btn sm ${r.status === k ? '' : 'soft'}`} disabled={busy || r.status === k} onClick={() => void act(() => s.setStatus(r.id, k))}>{k === 'open' ? 'Open' : k === 'waiting' ? 'Waiting' : 'Resolved'}</button>
          ))}
        </div>
      </header>

      {overdue && <p className="note warn">Past the reply-by time ({stamp(r.replyBy!)}).</p>}
      {!r.urgent && r.replyBy && !overdue && !r.messages.some((m) => m.from === 'platform') && <p className="note">Promised by {stamp(r.replyBy)} (Sydney time).</p>}

      <dl className="si-ctx">
        <dt>Page</dt><dd>{r.context.route || 'Unknown'}</dd>
        <dt>App version</dt><dd>v{r.context.appVersion}</dd>
        <dt>Device</dt><dd title={r.context.userAgent}>{deviceOf(r.context.userAgent)}</dd>
        <dt>Studio ID</dt><dd className="mono">{r.studioId}</dd>
      </dl>
      <details className="si-ua"><summary>Full browser details</summary><code>{r.context.userAgent || 'none'}</code></details>

      <ul className="sp-thread si-thread">
        {r.messages.map((m) => (
          <li key={m.id} className={m.from === 'platform' ? 'studio' : 'platform'}>
            <span className="sp-who">{m.from === 'platform' ? `${m.author} (you)` : m.author} · {stamp(m.at)}</span>
            <p>{m.body}</p>
          </li>
        ))}
      </ul>
      {r.screenshot && <a href={r.screenshot} target="_blank" rel="noopener"><img className="si-shot" src={r.screenshot} alt="Attached by the studio" /></a>}

      <form className="si-reply" onSubmit={send}>
        <label className="field"><span>Reply (shows in {r.studioName}'s thread)</span>
          <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Hi, thanks for flagging this…" /></label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <div className="row si-reply-a">
          <label className="field si-st"><span>After sending</span>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as SupportStatus)}>
              <option value="waiting">Waiting on the studio</option><option value="resolved">Resolved</option><option value="open">Keep open</option>
            </select></label>
          <button className="btn" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send reply'}</button>
        </div>
      </form>
    </article>
  );
}

/** The platform-wide status message every studio app shows as a slim banner. */
function StatusBanner() {
  const s = supportAdmin();
  const [cur, setCur] = useState<SupportBanner | null | undefined>(undefined);
  const [text, setText] = useState('');
  const [tone, setTone] = useState<SupportBanner['tone']>('warn');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { let live = true; s.getBanner().then((b) => { if (!live) return; setCur(b); setText(b?.message ?? ''); if (b) setTone(b.tone); }, (e) => live && setErr(msg(e))); return () => { live = false; }; }, []);
  const save = async (message: string | null) => {
    setBusy(true); setErr('');
    try { const b = await s.setBanner(message, tone); setCur(b); setText(b?.message ?? ''); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card pad si-banner">
      <div className="si-banner-h">
        <h3>Status <em>banner</em></h3>
        {cur ? <span className="chip ok">Showing in every studio app</span> : <span className="chip">Off</span>}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save(text); }}>
        <label className="field si-grow"><span>Message for every studio (e.g. "Payments are slow right now, we're on it")</span>
          <input className="input" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="Leave empty for no banner" /></label>
        <label className="field"><span>Style</span>
          <select className="select" value={tone} onChange={(e) => setTone(e.target.value as SupportBanner['tone'])}><option value="warn">Heads up</option><option value="info">Info</option></select></label>
        <button className="btn" disabled={busy || !text.trim() || (text.trim() === cur?.message && tone === cur?.tone)}>{cur ? 'Update' : 'Publish'}</button>
        {cur && <button type="button" className="btn soft" disabled={busy} onClick={() => void save(null)}>Clear</button>}
      </form>
      {err && <p className="form-error" role="alert">{err}</p>}
    </section>
  );
}

export { replyBy };
