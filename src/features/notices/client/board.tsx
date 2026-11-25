/**
 * The notice board at the top of the client timetable: the studio's current notices as compact cards. A client can dismiss one
 * (remembered on this device, keyed by the notice and when it last changed, so an edited notice comes back).
 */
import React, { useState } from 'react';
import { store, useData } from '../../../shared/react';
import { Icon } from '../../../client/ui';

const KEY = 'spc.notices.dismissed';
const stamp = (n: { id: string; updatedAt: string }) => `${n.id}@${n.updatedAt}`;

function readDismissed(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function saveDismissed(list: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-200))); } catch { /* private mode: it just comes back next time */ }
}

export function NoticeBoard() {
  const notices = store.features.notices;
  const list = useData(async () => (notices ? notices.listActive().catch(() => []) : []), []);
  const [gone, setGone] = useState<string[]>(readDismissed);
  const shown = (list.data ?? []).filter((n) => !gone.includes(stamp(n)));
  if (!shown.length) return null;
  const dismiss = (n: { id: string; updatedAt: string }) => { const next = [...gone, stamp(n)]; setGone(next); saveDismissed(next); };
  return (
    <section className="nb" aria-label="Notices">
      {shown.map((n) => (
        <article key={n.id} className={'nb-card' + (n.pinned ? ' pinned' : '')}>
          <div className="nb-main">
            <h3>{n.pinned && <span className="nb-pin">Pinned</span>}{n.title}</h3>
            {n.body && <p>{n.body}</p>}
            {n.linkUrl && <a className="nb-link" href={n.linkUrl} target="_blank" rel="noopener noreferrer">Read more</a>}
          </div>
          <button className="nb-x" onClick={() => dismiss(n)} aria-label={`Dismiss ${n.title}`}><Icon name="close" size={18} /></button>
        </article>
      ))}
    </section>
  );
}
