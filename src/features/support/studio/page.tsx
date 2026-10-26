/** #/help: the help centre (every article, searchable), "Message us", and My requests. */
import React, { useMemo, useState } from 'react';
import { PageHead } from '../../../studio/ui';
import { ARTICLES, searchArticles } from '../articles';
import { SUPPORT_NAME } from '../config';
import { ArticleCard, RequestCard, openHelp, useMyRequests } from './parts';

export function HelpPage({ slug }: { slug?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(slug ?? null);
  const [openReq, setOpenReq] = useState<string | null>(null);
  const mine = useMyRequests(true);
  const shown = useMemo(() => (q.trim().length >= 3 ? searchArticles(q, ARTICLES.length) : ARTICLES), [q]);
  return (
    <div className="sp-page">
      <PageHead eyebrow="Support" title={<>Help <em>centre</em></>}
        sub="A one-minute guide for each of the common jobs. If yours isn't here, just tell us."
        actions={<button className="btn" onClick={() => openHelp(q.trim().length >= 3 ? q : undefined)}>Message {SUPPORT_NAME}</button>} />
      <div className="sp-cols">
        <section className="card pad">
          <input className="input" type="search" placeholder="Search the guides" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the guides" />
          <div className="sp-list">
            {shown.map((a) => <ArticleCard key={a.slug} article={a} open={open === a.slug} onToggle={() => setOpen(open === a.slug ? null : a.slug)} />)}
            {shown.length === 0 && (
              <p className="muted sp-empty">Nothing matches that. <button className="sp-link" onClick={() => openHelp(q)}>Send it to {SUPPORT_NAME} instead</button> and you'll get a reply by the end of the next business 2 hours.</p>
            )}
          </div>
        </section>
        <section className="card pad">
          <h3>My <em>requests</em></h3>
          {mine.list === null && <p className="muted">Loading…</p>}
          {mine.list?.length === 0 && <p className="muted sp-empty">Nothing yet. Use the Help button any time, and type whatever's on your mind.</p>}
          <div className="sp-list">
            {mine.list?.map((r) => <RequestCard key={r.id} r={r} expanded={openReq === r.id} onToggle={() => setOpenReq(openReq === r.id ? null : r.id)} />)}
          </div>
        </section>
      </div>
    </div>
  );
}
