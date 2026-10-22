/**
 * Studio › Reviews: average rating per class type and per instructor, the NPS score, and the latest comments.
 * Owner and manager see every review; an instructor only sees their own classes' (the stores enforce it).
 */
import React, { useState } from 'react';
import { Flower } from '../../../shared/brand';
import { addDays, studioDate } from '../../../shared/format';
import { store, useData } from '../../../shared/react';
import { Empty, Loading, PageHead, Seg, dayShort, roleCan, useStudio } from '../../../studio/ui';
import { averageBy, npsOf, overall } from '../calc';
import type { ReviewEntry } from '../types';

type Range = '30' | '90' | 'all';

export function Rating({ value, size = 16 }: { value: number; size?: number }) {
  const full = Math.round(value);
  return (
    <span className="rv-rating" role="img" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Flower key={n} size={size} color={n <= full ? 'var(--accent)' : 'var(--faint)'} style={n <= full ? undefined : { opacity: .45 }} />)}
    </span>
  );
}

export function ReviewsPage() {
  const { me, typeById, staffById } = useStudio();
  const all = roleCan(me.role, 'reviews.all');
  const [range, setRange] = useState<Range>('90');
  const list = useData(() => (store.features.reviews ? store.features.reviews.list() : Promise.resolve([] as ReviewEntry[])), []);

  if (!store.features.reviews) return null;
  const since = range === 'all' ? 0 : Date.parse(addDays(studioDate(), -Number(range) + 1));
  const entries = (list.data ?? []).filter((e) => Date.parse(e.createdAt) >= since);
  const tot = overall(entries);
  const nps = npsOf(entries);
  const byType = averageBy(entries, (e) => e.classTypeId);
  const byTeacher = averageBy(entries, (e) => e.instructorId);
  const pct = (n: number) => (nps.answers ? Math.round((n / nps.answers) * 100) : 0);
  const comments = entries.filter((e) => e.comment).slice(0, 30);

  return (
    <>
      <PageHead
        eyebrow="Feedback"
        title={all ? <>Class <em>reviews</em></> : <>Your <em>reviews</em></>}
        sub={all ? 'What clients say after class, with an average per class type and per instructor.' : 'What clients say about your classes.'}
        actions={<Seg<Range> value={range} onChange={setRange} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All time' }]} />}
      />
      {list.error && !list.data ? <Empty title="That didn’t load">{list.error.message}</Empty> : !list.data ? <Loading /> : entries.length === 0 ? (
        <Empty title="No reviews yet">Clients are asked how class was after they check in. Their answers will show up here.</Empty>
      ) : (
        <>
          <div className="rv-kpis">
            <div className="rv-kpi">
              <span className="rv-kl">Average rating</span>
              <strong className="rv-kv serif">{tot.avg?.toFixed(1)}<small> / 5</small></strong>
              <Rating value={tot.avg ?? 0} size={18} />
              <span className="rv-ks">{tot.count} review{tot.count === 1 ? '' : 's'}</span>
            </div>
            <div className="rv-kpi">
              <span className="rv-kl">Net Promoter Score</span>
              <strong className="rv-kv serif">{nps.score === null ? '–' : nps.score > 0 ? `+${nps.score}` : nps.score}</strong>
              {nps.answers > 0 && (
                <div className="rv-bar" role="img" aria-label={`${pct(nps.promoters)}% promoters, ${pct(nps.passives)}% passives, ${pct(nps.detractors)}% detractors`}>
                  <i style={{ flex: nps.promoters, background: 'var(--primary)' }} /><i style={{ flex: nps.passives, background: 'var(--accent)' }} /><i style={{ flex: nps.detractors, background: 'var(--faint)' }} />
                </div>
              )}
              <span className="rv-ks">{nps.answers ? `${pct(nps.promoters)}% promoters · ${pct(nps.passives)}% passives · ${pct(nps.detractors)}% detractors` : 'No 0 to 10 answers yet'}</span>
            </div>
          </div>

          <div className="rv-tables">
            <section className="card pad">
              <h3>By class <em>type</em></h3>
              <ul className="rv-rows">
                {byType.map((s) => (
                  <li key={s.id}><span className="rv-name">{typeById(s.id)?.name ?? 'Class'}</span><Rating value={s.avg} /><strong>{s.avg.toFixed(1)}</strong><span className="muted">{s.count}</span></li>
                ))}
              </ul>
            </section>
            <section className="card pad">
              <h3>{all ? <>By <em>instructor</em></> : <>Your <em>average</em></>}</h3>
              <ul className="rv-rows">
                {byTeacher.map((s) => (
                  <li key={s.id}><span className="rv-name">{staffById(s.id)?.name ?? 'Instructor'}</span><Rating value={s.avg} /><strong>{s.avg.toFixed(1)}</strong><span className="muted">{s.count}</span></li>
                ))}
              </ul>
            </section>
          </div>

          <section className="card pad rv-latest">
            <h3>Latest <em>comments</em></h3>
            {comments.length === 0 ? <p className="muted">No comments in this time.</p> : (
              <ul className="rv-comments">
                {comments.map((e) => (
                  <li key={e.id}>
                    <div className="rv-chead"><Rating value={e.rating} size={14} /><span className="muted">{e.clientFirstName} · {typeById(e.classTypeId)?.name ?? 'Class'} with {staffById(e.instructorId)?.name?.split(' ')[0] ?? 'instructor'} · {dayShort(e.createdAt)}</span></div>
                    <p>{e.comment}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
