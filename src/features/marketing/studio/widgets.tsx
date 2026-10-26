/** Marketing pieces that sit inside core studio screens: the Today widget and the client profile card. */
import React, { useState } from 'react';
import { useAction, useData } from '../../../shared/react';
import type { Client } from '../../../shared/types';
import { Icon, useStudio } from '../../../studio/ui';
import { ago, marketing, needMarketing } from '../api';
import { useInboxLive } from './inbox';

/** Today › side: unread client messages. Renders nothing when there are none. */
export function InboxWidget() {
  const t = useData(async () => (await marketing()?.listThreads())?.filter((x) => x.unread > 0) ?? [], []);
  useInboxLive(t.reload);
  if (!t.data?.length) return null;
  return (
    <section className="card pad mk-widget">
      <h3>New <em>messages</em></h3>
      <div className="mk-widget-list">
        {t.data.slice(0, 4).map((x) => (
          <a key={x.id} href={`#/marketing/inbox/${x.clientId}`} className="mk-widget-row">
            <span><strong>{x.clientName}</strong><span className="mk-thread-prev">{x.lastMessagePreview}</span></span>
            <span className="faint small">{ago(x.lastMessageAt)}</span>
          </a>
        ))}
      </div>
      {t.data.length > 4 && <a className="linkish" href="#/marketing/inbox">See all {t.data.length}</a>}
    </section>
  );
}

/** Client profile › header button. */
export function MessageButton({ client }: { client: Client }) {
  return <a className="btn soft" href={`#/marketing/inbox/${client.id}`}><Icon name="mail" size={18} />Message</a>;
}

/** Client profile › card: tags you can put on a client (used by audiences), and whether they take marketing. */
export function ClientTagsCard({ client }: { client: Client }) {
  const { can } = useStudio();
  const tags = useData(() => needMarketing().getClientTags(client.id), [client.id]);
  const all = useData(() => needMarketing().listTags(), []);
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  const list = tags.data ?? [];
  const save = (next: string[]) => run(async () => { await needMarketing().setClientTags(client.id, next); tags.reload(); all.reload(); });
  const add = () => { const t = text.trim(); if (!t) return; setText(''); if (!list.some((x) => x.toLowerCase() === t.toLowerCase())) void save([...list, t]); };
  return (
    <section className="card pad mk-profile">
      <h3>Marketing</h3>
      <p className="muted small">{client.marketingOptIn ? 'Said yes to news and offers.' : 'Hasn’t opted in, so campaigns skip them. They still get messages about their own classes and passes.'}</p>
      <div className="mk-chips">
        {list.map((t) => <span key={t} className="mk-chip">{t}{can('marketing.manage') && <button aria-label={`Remove ${t}`} disabled={busy} onClick={() => save(list.filter((x) => x !== t))}><Icon name="x" size={12} /></button>}</span>)}
        {tags.data && list.length === 0 && <span className="faint small">No tags.</span>}
      </div>
      {can('marketing.manage') && (
        <form className="mk-inline" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input className="input sm" value={text} maxLength={30} list="mk-tag-list" placeholder="Add a tag" aria-label="Add a tag" onChange={(e) => setText(e.target.value)} />
          <datalist id="mk-tag-list">{(all.data ?? []).map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
          <button className="btn sm soft" type="submit" disabled={busy || !text.trim()}>Add</button>
        </form>
      )}
    </section>
  );
}
