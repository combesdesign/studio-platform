/**
 * The floating Help button and the status banner. The studio app has no registry slot for always-on elements, so
 * this mounts its own small React root next to the app (see studio/index.tsx). It only shows once a staff member is signed in.
 */
import React, { useEffect, useState } from 'react';
import { store } from '../../../shared/react';
import { demoDb } from '../demoDb';
import type { SupportBanner } from '../types';
import { HELP_OPEN_EVENT, HelpIcon, useMyRequests } from './parts';
import { HelpSheet } from './sheet';

export function Banner() {
  const [b, setB] = useState<SupportBanner | null>(null);
  const [hidden, setHidden] = useState<string>('');
  useEffect(() => {
    let live = true;
    const load = () => store.features.support?.banner().then((x) => live && setB(x), () => {});
    load();
    const t = setInterval(load, 60_000);
    const off = demoDb.subscribe(load);
    window.addEventListener('focus', load);
    return () => { live = false; clearInterval(t); off(); window.removeEventListener('focus', load); };
  }, []);
  if (!b || hidden === b.updatedAt) return null;
  return (
    <div className={`sp-banner ${b.tone}`} role="status">
      <span>{b.message}</span>
      <button type="button" aria-label="Hide this message" onClick={() => setHidden(b.updatedAt)}>×</button>
    </div>
  );
}

export function Launcher() {
  const [who, setWho] = useState<{ name: string; role: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<string | undefined>();
  // Is a staff member signed in? The studio app signs in and out without telling us, so look now and then.
  useEffect(() => {
    let live = true;
    const look = () => { store.currentUser().then((u) => live && setWho(u && u.kind === 'staff' ? { name: u.name, role: u.role } : null), () => live && setWho(null)); };
    look();
    const t = setInterval(look, 3000);
    window.addEventListener('hashchange', look);
    return () => { live = false; clearInterval(t); window.removeEventListener('hashchange', look); };
  }, []);
  useEffect(() => {
    const on = (e: Event) => { setSeed((e as CustomEvent).detail?.text); setOpen(true); };
    window.addEventListener(HELP_OPEN_EVENT, on);
    return () => window.removeEventListener(HELP_OPEN_EVENT, on);
  }, []);
  const reqs = useMyRequests(!!who);
  const news = (reqs.list ?? []).filter((r) => r.status === 'waiting').length;
  if (!who || !store.features.support) return null;
  return (
    <>
      <div className="sp-banner-slot"><Banner /></div>
      {!open && <button type="button" className="sp-fab" onClick={() => { setSeed(undefined); setOpen(true); }} aria-label={news ? `Help, ${news} new ${news === 1 ? 'reply' : 'replies'}` : 'Help'}>
        <HelpIcon size={20} /><span>Help</span>{news > 0 && <i className="sp-dot" aria-hidden="true">{news}</i>}
      </button>}
      <HelpSheet open={open} onClose={() => setOpen(false)} who={who} initialText={seed} />
    </>
  );
}
