/** Online classes: the library (category chips, "Recently watched", video cards) and the watch screen. */
import React, { useMemo, useState } from 'react';
import { brandAsset } from '../../../shared/branding';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { BackPill, CardSkeletons, Empty, ErrorBlock, Flower, Icon, ScreenHead } from '../../../client/ui';
import { categoriesOf, durationLabel } from '../calc';
import type { ClientVideo, OnDemandCatalog } from '../types';
import { Player } from './player';

type Nav = (to: string, o?: { replace?: boolean }) => void;
const RECENT_MAX = 8;

function Card({ v, onOpen, small }: { v: ClientVideo; onOpen: () => void; small?: boolean }) {
  const img = brandAsset(v.thumbnailUrl);
  return (
    <button type="button" className={'od-card' + (small ? ' small' : '') + (v.locked ? ' locked' : '')} onClick={onOpen}
      aria-label={`${v.title}, ${durationLabel(v.durationMin)}${v.locked ? ', locked' : ''}`}>
      <span className="od-thumb">
        {img ? <img src={img} alt="" loading="lazy" /> : <Flower size={40} />}
        <span className="od-dur"><Icon name="clock" size={13} />{durationLabel(v.durationMin)}</span>
        {v.free && <span className="od-free">Free</span>}
        {v.locked ? <span className="od-lock" aria-hidden="true"><Icon name="lock" size={18} /></span> : <span className="od-go" aria-hidden="true"><Icon name="play" size={18} fill /></span>}
      </span>
      <span className="od-title serif">{v.title}</span>
      <span className="od-meta">{[v.instructor, v.level].filter(Boolean).join(' · ')}</span>
    </button>
  );
}

function UnlockCard({ nav, compact }: { nav: Nav; compact?: boolean }) {
  return (
    <section className={'od-unlock' + (compact ? ' compact' : '')} aria-label="Unlock online classes">
      <Flower size={compact ? 28 : 34} color="var(--accent)" />
      <div>
        <h3 className="serif">The whole library, any time</h3>
        <p>Short classes you can do at home, in your own time.</p>
      </div>
      <button className="btn" onClick={() => nav('/passes')}>Unlock with Online membership</button>
    </section>
  );
}

export function Library({ nav }: { nav: Nav }) {
  const cat = useData<OnDemandCatalog | null>(async () => (store.features.ondemand ? store.features.ondemand.list() : null), []);
  const [chip, setChip] = useState('All');
  const videos = cat.data?.videos ?? [];
  const cats = useMemo(() => categoriesOf(videos), [videos]);
  const shown = chip === 'All' ? videos : videos.filter((v) => v.category === chip);
  const recent = videos.filter((v) => v.lastWatchedAt && !v.locked)
    .sort((a, b) => Date.parse(b.lastWatchedAt!) - Date.parse(a.lastWatchedAt!)).slice(0, RECENT_MAX);

  if (!store.features.ondemand) return null;
  const open = (v: ClientVideo) => nav('/online/' + v.id);

  return (
    <div className="screen od-screen">
      <ScreenHead eyebrow="Online classes" title={<>Move <em>anywhere</em></>} sub="Short, guided classes to do at home, whenever suits." />
      {cat.error && !cat.data ? <ErrorBlock error={cat.error} onRetry={cat.reload} /> : !cat.data ? <CardSkeletons n={3} h={190} /> : videos.length === 0 ? (
        <Empty title="Classes are on their way">The studio is filming its first online classes. Check back soon.</Empty>
      ) : (
        <>
          {!cat.data.access && <UnlockCard nav={nav} />}
          {recent.length > 0 && (
            <section className="od-recent" aria-label="Recently watched">
              <h2 className="od-h">Recently <em>watched</em></h2>
              <div className="od-row">{recent.map((v) => <Card key={v.id} v={v} small onOpen={() => open(v)} />)}</div>
            </section>
          )}
          <div className="od-chips" role="group" aria-label="Filter by category">
            {['All', ...cats].map((c) => (
              <button key={c} type="button" className={'od-chip' + (c === chip ? ' on' : '')} aria-pressed={c === chip} onClick={() => setChip(c)}>{c}</button>
            ))}
          </div>
          <div className="od-grid">{shown.map((v) => <Card key={v.id} v={v} onOpen={() => open(v)} />)}</div>
        </>
      )}
    </div>
  );
}

export function WatchScreen({ id, nav }: { id: string; nav: Nav }) {
  const toast = useToast();
  const cat = useData<OnDemandCatalog | null>(async () => (store.features.ondemand ? store.features.ondemand.list() : null), []);
  const v = cat.data?.videos.find((x) => x.id === id);
  const back = <BackPill label="Online" onClick={() => nav('/online')} />;

  if (!store.features.ondemand) return null;
  if (cat.error && !cat.data) return <div className="screen">{back}<ErrorBlock error={cat.error} onRetry={cat.reload} /></div>;
  if (!cat.data) return <div className="screen">{back}<CardSkeletons n={2} h={200} /></div>;
  if (!v) return <div className="screen">{back}<Empty title="We couldn't find that video" action={<button className="btn soft" onClick={() => nav('/online')}>See all classes</button>}>It may have been taken down.</Empty></div>;

  const more = cat.data.videos.filter((x) => x.id !== v.id && x.category === v.category).slice(0, 4);
  const img = brandAsset(v.thumbnailUrl);
  return (
    <div className="screen od-screen">
      {back}
      {v.locked || !v.videoUrl ? (
        <div className="od-player locked">
          {img && <img src={img} alt="" />}
          <span className="od-lock big" aria-hidden="true"><Icon name="lock" size={26} /></span>
        </div>
      ) : (
        <Player key={v.id} url={v.videoUrl} poster={v.thumbnailUrl} title={v.title}
          onPlay={() => { store.features.ondemand!.recordView(v.id).catch((e) => toast(errorMessage(e))); }} />
      )}
      <div className="od-info">
        <div className="od-tags">
          <span className="tag">{v.category}</span>
          <span className="tag"><Icon name="clock" size={14} />{durationLabel(v.durationMin)}</span>
          {v.level && <span className="tag">{v.level}</span>}
          {v.free && <span className="tag od-free-tag">Free</span>}
        </div>
        <h1 className="serif">{v.title}</h1>
        {v.instructor && <p className="od-by">with {v.instructor}</p>}
        {v.description && <p className="od-desc">{v.description}</p>}
      </div>
      {v.locked && <UnlockCard nav={nav} compact />}
      {more.length > 0 && (
        <section aria-label={`More ${v.category}`}>
          <h2 className="od-h">More <em>{v.category}</em></h2>
          <div className="od-row">{more.map((m) => <Card key={m.id} v={m} small onOpen={() => nav('/online/' + m.id)} />)}</div>
        </section>
      )}
    </div>
  );
}
