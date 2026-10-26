/** The Help sheet: one free-text box, instant article suggestions, urgent toggle, photo, and what we attach. No categories. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { currentStudio } from '../../../data';
import { Sheet, errorMessage, store } from '../../../shared/react';
import { Flower } from '../../../shared/brand';
import { Seg, SheetHead } from '../../../studio/ui';
import { ARTICLES, searchArticles } from '../articles';
import { deviceOf } from '../calc';
import { APP_VERSION, SUPPORT_CLOSE_HOUR, SUPPORT_NAME, SUPPORT_OPEN_HOUR, SUPPORT_TZ } from '../config';
import { replyBy } from '../hours';
import type { SupportRequest } from '../types';
import { ArticleCard, RequestCard, replyByText, shrinkImage, useMyRequests } from './parts';

type View = 'ask' | 'mine';
const hourText = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

export function HelpSheet({ open, onClose, who, initialText }: {
  open: boolean; onClose: () => void; who: { name: string; role: string }; initialText?: string;
}) {
  const [view, setView] = useState<View>('ask');
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<SupportRequest | null>(null);
  const [openArt, setOpenArt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [solved, setSolved] = useState<string | null>(null);
  const [openReq, setOpenReq] = useState<string | null>(null);
  const mine = useMyRequests(open);
  const box = useRef<HTMLTextAreaElement>(null);

  // A fresh sheet each time it opens.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => box.current?.focus({ preventScroll: true }), 120);
    setView('ask'); setText(initialText ?? ''); setUrgent(false); setShot(null); setErr(''); setSent(null); setOpenArt(null); setDismissed([]); setSolved(null);
    return () => clearTimeout(t);
  }, [open]);

  const suggestions = useMemo(() => searchArticles(text, 3).filter((a) => !dismissed.includes(a.slug)), [text, dismissed]);
  const pendingCount = (mine.list ?? []).filter((r) => r.status === 'waiting').length;

  const route = typeof location !== 'undefined' ? location.hash || '#/' : '';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  const attach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setErr('');
    try { setShot(await shrinkImage(f)); } catch (x) { setErr(errorMessage(x)); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const s = store.features.support;
    if (!s || !text.trim()) return;
    setBusy(true); setErr('');
    try {
      const now = new Date();
      const r = await s.send({
        body: text, urgent, screenshot: shot, context: { route, appVersion: APP_VERSION, userAgent: ua },
        replyBy: urgent ? null : replyBy(now).toISOString(),
      });
      setSent(r);
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };

  const close = () => onClose();

  return (
    <Sheet open={open} onClose={close} label="Help">
      <SheetHead title={<>How can we <em>help</em>?</>} sub={view === 'ask' && !sent && !solved ? 'Tell us in your own words. You\'ll get an answer or an acknowledgement straight away.' : undefined} onClose={close} />
      {!sent && !solved && (
        <Seg<View> className="sp-seg" value={view} onChange={setView} options={[{ value: 'ask', label: 'Ask' }, { value: 'mine', label: pendingCount ? `My requests (${pendingCount} new)` : 'My requests' }]} />
      )}

      {solved && (
        <div className="sp-done" role="status">
          <Flower size={34} />
          <h4>Glad that sorted it.</h4>
          <p className="muted">{solved}</p>
          <div className="sp-done-a"><button className="btn" onClick={close}>Done</button><button className="btn ghost" onClick={() => setSolved(null)}>Ask something else</button></div>
        </div>
      )}

      {!solved && sent && (
        <div className="sp-done" role="status" aria-live="polite">
          <Flower size={34} />
          {sent.urgent ? (
            <><h4>We've been alerted and are on it now.</h4><p className="muted">Hang tight. If it's easier to talk, reply here and {SUPPORT_NAME} will pick it up.</p></>
          ) : (
            <><h4>Got it. {SUPPORT_NAME} will reply by {sent.replyBy ? replyByText(sent.replyBy) : 'soon'}.</h4>
              <p className="muted">Support is Mon to Fri, {hourText(SUPPORT_OPEN_HOUR)} to {hourText(SUPPORT_CLOSE_HOUR)}, {SUPPORT_TZ.split('/')[1]!.replace('_', ' ')} time. Your reply will show up under My requests.</p></>
          )}
          <div className="sp-done-a"><button className="btn" onClick={close}>Done</button><button className="btn ghost" onClick={() => { setSent(null); setView('mine'); setOpenReq(sent.id); }}>See my requests</button></div>
        </div>
      )}

      {!solved && !sent && view === 'ask' && (
        <form className="sp-form" onSubmit={submit}>
          <label className="field">
            <span className="sp-lbl">What's going on?</span>
            <textarea ref={box} className="textarea sp-text" rows={4} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="e.g. a client was charged twice, or how do I move a class?" />
          </label>

          {suggestions.length > 0 && (
            <div className="sp-sug" aria-live="polite">
              <p className="sp-sug-h">These might help <span>You can still send your message below.</span></p>
              {suggestions.map((a) => (
                <ArticleCard
                  key={a.slug} article={a} open={openArt === a.slug} ask onToggle={() => setOpenArt(openArt === a.slug ? null : a.slug)}
                  onYes={() => setSolved(`"${a.title}" answered it, so we haven't sent anything. Message us any time if something else comes up.`)}
                  onNo={() => { setOpenArt(null); setDismissed((d) => [...d, a.slug]); }}
                />
              ))}
            </div>
          )}

          <label className={`sp-urgent${urgent ? ' on' : ''}`}>
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
            <span><strong>Urgent: clients can't book or pay</strong><span>We'll be alerted straight away, even outside office hours.</span></span>
          </label>

          <div className="sp-attach">
            {shot ? (
              <div className="sp-shot-row"><img src={shot} alt="Your attachment" /><button type="button" className="btn sm ghost" onClick={() => setShot(null)}>Remove</button></div>
            ) : (
              <label className="btn sm soft sp-file">Add a photo or screenshot<input type="file" accept="image/*" onChange={attach} /></label>
            )}
            <span className="muted small">Optional</span>
          </div>

          <details className="sp-ctxbox">
            <summary>What we send with it</summary>
            <dl>
              <dt>Page</dt><dd>{route || '#/'}</dd>
              <dt>Studio</dt><dd>{currentStudio?.name ?? ''}</dd>
              <dt>You</dt><dd>{who.name} ({who.role.replace('_', ' ')})</dd>
              <dt>App</dt><dd>v{APP_VERSION}</dd>
              <dt>Device</dt><dd>{deviceOf(ua)}</dd>
            </dl>
          </details>

          {err && <p className="form-error" role="alert">{err}</p>}
          <div className="sp-foot">
            <a className="sp-browse" href="#/help" onClick={() => close()}>Browse all help</a>
            <button className="btn" disabled={busy || !text.trim()}>{busy ? 'Sending…' : urgent ? 'Send as urgent' : `Send to ${SUPPORT_NAME}`}</button>
          </div>
        </form>
      )}

      {!solved && !sent && view === 'mine' && (
        <div className="sp-mine">
          {mine.list === null && <p className="muted">Loading…</p>}
          {mine.error && <p className="form-error">{mine.error}</p>}
          {mine.list?.length === 0 && <p className="muted sp-empty">Nothing yet. When you message us, the whole conversation lives here.</p>}
          {mine.list?.map((r) => <RequestCard key={r.id} r={r} expanded={openReq === r.id} onToggle={() => setOpenReq(openReq === r.id ? null : r.id)} />)}
        </div>
      )}
    </Sheet>
  );
}

export { ARTICLES };
