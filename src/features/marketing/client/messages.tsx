/** Client app: Messages, a two-way conversation with the studio, plus this device's notification switch. */
import React, { useEffect, useRef, useState } from 'react';
import { errorMessage, useData, useToast } from '../../../shared/react';
import { BackPill, CardSkeletons, ErrorBlock, Icon, ScreenHead, Toggle } from '../../../client/ui';
import { backOut } from '../../../client/lib';
import { dayTime, marketing, needMarketing } from '../api';
import { usePushOptIn } from './notify';

type Nav = (to: string, o?: { replace?: boolean }) => void;

export function MessagesScreen({ nav, path }: { nav: Nav; path: string }) {
  const toast = useToast();
  const thread = useData(() => needMarketing().getMyThread(), []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const reload = thread.reload;
  useEffect(() => marketing()?.subscribeInbox?.(reload), [reload]);
  const n = thread.data?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [n]);
  useEffect(() => {
    if (thread.data?.unread) void needMarketing().markMyThreadRead().then(() => undefined, () => undefined);
  }, [thread.data?.unread]);

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await needMarketing().sendMyMessage(body); setText(''); reload(); }
    catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };

  const opt = usePushOptIn();

  return (
    <div className="screen mk-chat">
      <div className="screen-back"><BackPill label="Profile" onClick={() => backOut(nav, path, '/profile')} /></div>
      <ScreenHead title={<>Messages</>} sub="Questions, injuries, anything. We’ll reply here." />
      {opt.available && (
        <div className="mk-notify">
          <span className="row-ic"><Icon name="bell" size={20} /></span>
          <span className="mk-notify-t"><strong>Tell me when you reply</strong><span>A notification on this device</span></span>
          <Toggle checked={opt.on} disabled={opt.busy} onChange={(v) => void opt.set(v)} label="Notifications for replies" />
        </div>
      )}
      {thread.error && !thread.data ? <ErrorBlock error={thread.error} onRetry={thread.reload} /> : !thread.data ? <CardSkeletons n={2} h={70} /> : (
        <div className="mk-msgs" role="log" aria-live="polite">
          {thread.data.messages.length === 0 && <p className="muted center mk-hello">Say hello. A real person reads every message.</p>}
          {thread.data.messages.map((m) => (
            <div key={m.id} className={'mk-bubble ' + (m.from === 'client' ? 'mine' : 'theirs')}>
              <p>{m.body}</p>
              <span>{m.from === 'staff' && m.staffName ? `${m.staffName} · ` : ''}{dayTime(m.at)}</span>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
      <form className="mk-compose" onSubmit={send}>
        <textarea className="input" rows={1} value={text} maxLength={2000} placeholder="Write a message…" aria-label="Message" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); void send(); } }} />
        <button className="btn" type="submit" disabled={busy || !text.trim()} aria-label="Send"><Icon name="chevron" size={20} /></button>
      </form>
    </div>
  );
}

export const MessagesIcon = ({ size = 20 }: { size?: number }) => <Icon name="mail" size={size} />;
