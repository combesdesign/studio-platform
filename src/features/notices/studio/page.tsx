/** Settings › Notice board: post, edit, pin and remove the notices clients see at the top of their timetable. */
import React, { useState } from 'react';
import { Sheet, store, useAction, useData } from '../../../shared/react';
import { studioDate } from '../../../shared/format';
import { Empty, Icon, Loading, SheetHead, dayShort } from '../../../studio/ui';
import { MAX_BODY, MAX_TITLE, isActive } from '../calc';
import type { Notice } from '../types';

export function NoticesSettingsTab() {
  const notices = needNotices();
  const list = useData(() => notices.listAll(), []);
  const [edit, setEdit] = useState<Notice | 'new' | null>(null);
  const [gone, setGone] = useState<Notice | null>(null);
  const { busy, run } = useAction();
  const today = studioDate();
  return (
    <div className="stack lg">
      <section className="card pad">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3>Notice <em>board</em></h3>
          <button className="btn" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> New notice</button>
        </div>
        <p className="muted">Short notices show as small cards at the top of the client timetable. Clients can dismiss them. Pin one to keep it first, and set a “show until” day to have it tidy itself away.</p>
        {!list.data ? <Loading /> : list.data.length === 0 ? <Empty title="No notices yet">Post one to show clients what’s on.</Empty> : (
          <div className="stack">
            {list.data.map((n) => (
              <div key={n.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                <span className="list-row-main">
                  <span className="list-row-title">{n.title}{n.pinned && <span className="chip" style={{ marginLeft: 8 }}>Pinned</span>}{!isActive(n, today) && <span className="chip warn" style={{ marginLeft: 8 }}>Finished</span>}</span>
                  {n.body && <span className="list-row-sub">{n.body}</span>}
                  <span className="list-row-sub">{n.showUntil ? `Shows until ${dayShort(n.showUntil + 'T02:00:00Z')}` : 'Shows until you remove it'}{n.linkUrl ? ' · has a link' : ''}</span>
                </span>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button className="btn ghost sm" disabled={busy} onClick={() => void run(async () => { await notices.setPinned(n.id, !n.pinned); list.reload(); }, n.pinned ? 'Unpinned' : 'Pinned')}>{n.pinned ? 'Unpin' : 'Pin'}</button>
                  <button className="btn ghost sm" onClick={() => setEdit(n)}>Edit</button>
                  <button className="btn ghost sm" onClick={() => setGone(n)}>Remove</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      {edit && <NoticeSheet notice={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {gone && (
        <Sheet open onClose={() => setGone(null)} label="Remove notice">
          <SheetHead title={<>Remove this <em>notice?</em></>} sub={gone.title} onClose={() => setGone(null)} />
          <p className="muted">Clients stop seeing it straight away.</p>
          <div className="sh-foot">
            <button className="btn ghost" onClick={() => setGone(null)}>Keep it</button>
            <button className="btn danger-solid" disabled={busy} onClick={() => void run(async () => { await notices.remove(gone.id); setGone(null); list.reload(); }, 'Notice removed')}>Remove</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function NoticeSheet({ notice, onClose, onSaved }: { notice: Notice | null; onClose: () => void; onSaved: () => void }) {
  const notices = needNotices();
  const { busy, run } = useAction();
  const [title, setTitle] = useState(notice?.title ?? '');
  const [body, setBody] = useState(notice?.body ?? '');
  const [link, setLink] = useState(notice?.linkUrl ?? '');
  const [until, setUntil] = useState(notice?.showUntil ?? '');
  const [pinned, setPinned] = useState(notice?.pinned ?? false);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await notices.save({ ...(notice ? { id: notice.id } : {}), title, body, linkUrl: link, showUntil: until, pinned });
      onSaved();
    }, notice ? 'Notice saved' : 'Notice posted');
  };
  return (
    <Sheet open onClose={onClose} label={notice ? 'Edit notice' : 'New notice'}>
      <SheetHead title={notice ? <>Edit <em>notice</em></> : <>New <em>notice</em></>} onClose={onClose} />
      <form onSubmit={save} className="stack">
        <label className="field"><span>Title</span><input className="input" maxLength={MAX_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label className="field"><span>Text (optional)</span><textarea className="textarea" rows={3} maxLength={MAX_BODY} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <label className="field"><span>Link (optional)</span><input className="input" type="url" inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></label>
        <label className="field"><span>Show until (optional)</span><input className="input" type="date" min={studioDate()} value={until} onChange={(e) => setUntil(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /><span>Pin to the top</span></label>
        <div className="sh-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !title.trim()}>{notice ? 'Save' : 'Post notice'}</button></div>
      </form>
    </Sheet>
  );
}

function needNotices() {
  const s = store.features.notices;
  if (!s) throw new Error('The notice board isn’t available.');
  return s;
}
