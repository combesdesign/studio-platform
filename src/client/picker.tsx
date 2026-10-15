/** "Find your studio": the client app's front door on the platform (no studio in the address, none remembered). */
import React, { useEffect, useMemo, useState } from 'react';
import type { Studio } from '../shared/types';
import { platform } from '../data';
import { Accented, Flower, Logo } from '../shared/brand';
import { brandAsset, PLATFORM_NAME } from '../shared/branding';
import { isSingleStudio, rememberStudio, switchStudio } from '../shared/boot';

function StudioMark({ s, size = 22 }: { s: Studio; size?: number }) {
  const m = s.branding?.mark;
  if (m?.d) return <svg viewBox={m.viewBox ?? '0 0 100 100'} width={size} height={size} aria-hidden="true"><path d={m.d} fill={s.branding.colors.accent} /></svg>;
  return <span className="ps-initial" style={{ color: s.branding?.colors?.accent }}>{s.name.charAt(0)}</span>;
}

export function FindStudio({ start, missing }: { start: (s: Studio) => void; missing?: string }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Studio[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    platform.listStudios().then(setList, (e) => setErr(e instanceof Error ? e.message : 'Couldn’t load studios.'));
  }, []);
  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (list ?? []).filter((s) => terms.every((t) => `${s.name} ${s.address}`.toLowerCase().includes(t)));
  }, [list, q]);
  const pick = (s: Studio) => {
    rememberStudio('client', s.slug);
    history.replaceState(history.state, '', location.pathname + location.search + '#/');
    start(s);
  };
  return (
    <div className="fs">
      <header className="fs-head">
        <Logo className="fs-logo" label={PLATFORM_NAME} />
        <h1><Accented text="Find your *studio*" /></h1>
        <p className="muted">Pick your studio to book classes, manage your passes and keep your details up to date.</p>
        {missing && <p className="form-note" role="status">We couldn’t find the studio “{missing}”. Choose yours below.</p>}
        <label className="fs-search">
          <span className="sr-only">Search studios</span>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input className="input" type="search" placeholder="Studio name or suburb" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </label>
      </header>
      <main className="fs-list" aria-busy={!list}>
        {err && <p className="form-error" role="alert">{err}</p>}
        {!list && !err && <div className="fs-loading"><Flower size={28} spin /></div>}
        {list && shown.length === 0 && <p className="muted center">No studios match “{q}”.</p>}
        {shown.map((s) => (
          <button key={s.id} className="fs-card" onClick={() => pick(s)} style={{ ['--sc' as string]: s.branding?.colors?.primary ?? 'var(--primary)' }}>
            <span className="fs-photo">{s.branding?.photos?.hero && <img src={brandAsset(s.branding.photos.hero)} alt="" loading="lazy" />}<span className="fs-badge"><StudioMark s={s} /></span></span>
            <span className="fs-text">
              <strong>{s.name}</strong>
              <span className="muted">{s.address}</span>
            </span>
            <svg className="fs-arrow" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5" /></svg>
          </button>
        ))}
        {platform.mode === 'demo' && list && <p className="muted fine center fs-demo">Demo: two sample studios, each with its own look and its own data.</p>}
      </main>
    </div>
  );
}

/** A studio that isn't open in the app: suspended, or still setting up. */
export function Closed({ studio }: { studio: Studio }) {
  const soon = studio.status === 'onboarding';
  return (
    <div className="fs closed">
      <header className="fs-head">
        <Logo className="fs-logo studio" />
        <h1>{soon ? <Accented text="Opening *soon*" /> : <>Taking a <em>break</em></>}</h1>
        <p className="muted">{soon
          ? `${studio.name} is setting up its app. Check back soon, or contact the studio${studio.email ? ` at ${studio.email}` : ''}.`
          : `${studio.name} isn’t taking bookings in the app right now. Please contact the studio${studio.email ? ` at ${studio.email}` : ''}.`}</p>
        {!isSingleStudio() && <button className="btn block" onClick={() => switchStudio('client', null)}>Find another studio</button>}
      </header>
    </div>
  );
}
