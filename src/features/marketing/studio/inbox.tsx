/** Studio › Marketing › Inbox: messages from clients (and replies), one thread per client. #/marketing/inbox/<clientId> opens a thread. */
import React, { useEffect, useRef, useState } from 'react';
import { store, useAction, useData } from '../../../shared/react';
import { Avatar, Empty, Icon, Loading, cx, replaceRoute, useStudio } from '../../../studio/ui';
import { ago, dayTime, marketing, needMarketing } from '../api';
import type { InboxMessage } from '../types';

/** Re-run `reload` when a message arrives (live realtime; the demo already syncs through the store). */
export function useInboxLive(reload: () => void) {
  useEffect(() => marketing()?.subscribeInbox?.(reload), [reload]);
}

export function InboxTab({ clientId }: { clientId?: string }) {
  const threads = useData(() => needMarketing().listThreads(), []);
  useInboxLive(threads.reload);
  if (threads.error && !threads.data) return <Empty title="That didn’t load">{threads.error.message}</Empty>;
  if (!threads.data) return <Loading />;
  const list = threads.data;
  // A client with no thread yet can still be messaged: #/marketing/inbox/<id> from their profile.
  const open = clientId ?? '';
  return (
    <div className={cx('mk-inbox', open && 'has-open')}>
      <aside className="card mk-threads" aria-label="Conversations">
        {list.length === 0 && <p className="muted pad">No messages yet. Clients can write to you from Profile › Messages in their app.</p>}
        {list.map((t) => (
          <a key={t.id} href={`#/marketing/inbox/${t.clientId}`} className={cx('mk-thread', open === t.clientId && 'on', t.unread > 0 && 'unread')}
            onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); replaceRoute(`/marketing/inbox/${t.clientId}`); }}>
            <Avatar name={t.clientName} {...(t.clientPhotoUrl ? { photo: t.clientPhotoUrl } : {})} size={42} />
            <span className="mk-thread-main">
              <span className="mk-thread-top"><strong>{t.clientName}</strong><span className="faint">{ago(t.lastMessageAt)}</span></span>
              <span className="mk-thread-prev">{t.lastFrom === 'staff' ? 'You: ' : ''}{t.lastMessagePreview}</span>
            </span>
            {t.unread > 0 && <span className="mk-badge" aria-label={`${t.unread} unread`}>{t.unread}</span>}
          </a>
        ))}
      </aside>
      <section className="card mk-convo">
        {open ? <Thread key={open} clientId={open} onChange={threads.reload} /> : <div className="mk-convo-empty"><Icon name="mail" size={28} /><p className="muted">Pick a conversation.</p></div>}
      </section>
    </div>
  );
}

function Thread({ clientId, onChange }: { clientId: string; onChange: () => void }) {
  const { can } = useStudio();
  const t = useData(() => needMarketing().getThread(clientId), [clientId]);
  useInboxLive(t.reload);
  const client = useData(() => store.getClient(clientId), [clientId]);
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const n = t.data?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [n]);
  useEffect(() => {
    if (t.data?.thread?.unread) void needMarketing().markThreadRead(clientId).then(onChange, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.data?.thread?.unread, clientId]);
  const name = t.data?.thread?.clientName ?? (client.data ? `${client.data.firstName} ${client.data.lastName}` : 'Client');
  const send = () => {
    const body = text.trim();
    if (!body) return;
    void run(async () => { await needMarketing().sendStaffMessage(clientId, body); setText(''); t.reload(); onChange(); });
  };
  if (!t.data) return t.error ? <p className="form-err pad">{t.error.message}</p> : <Loading />;
  return (
    <>
      <header className="mk-convo-head">
        <a className="back-pill mk-back" href="#/marketing/inbox" onClick={(e) => { e.preventDefault(); replaceRoute('/marketing/inbox'); }}><Icon name="left" size={20} /><span>Inbox</span></a>
        <Avatar name={name} size={40} />
        <div><strong>{name}</strong><a className="linkish small" href={`#/clients/${clientId}`}>Open profile</a></div>
      </header>
      <div className="mk-msgs" role="log" aria-live="polite">
        {t.data.messages.length === 0 && <p className="muted center">No messages yet. Say hello below.</p>}
        {t.data.messages.map((m) => <Bubble key={m.id} m={m} />)}
        <div ref={end} />
      </div>
      {can('marketing.inbox') && (
        <form className="mk-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea className="textarea" rows={2} value={text} maxLength={2000} placeholder={`Reply to ${name.split(' ')[0]}…`} aria-label="Reply" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          <button className="btn" type="submit" disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
    </>
  );
}

function Bubble({ m }: { m: InboxMessage }) {
  return (
    <div className={cx('mk-bubble', m.from === 'staff' ? 'mine' : 'theirs')}>
      <p>{m.body}</p>
      <span className="faint">{m.channel === 'sms' ? 'Text · ' : ''}{m.from === 'staff' && m.staffName ? `${m.staffName} · ` : ''}{dayTime(m.at)}</span>
    </div>
  );
}
