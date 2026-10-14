/** Snowy Pilates Club — client app entry (PWA now, Capacitor later). Hash routing only. */
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './client.css';
import type { AuthUser } from '../shared/types';
import { store, useData, useRoute, match, ToastProvider, DemoBadge } from '../shared/react';
import { AuthScreens } from './auth';
import { Timetable } from './timetable';
import { Bookings } from './bookings';
import { Passes } from './passes';
import { Profile, captureInstallPrompt } from './profile';
import { Waiver } from './waiver';
import { Ctx, ErrorBlock, Flower, Icon, Logo } from './ui';
import type { AppCtx } from './ui';
import { isNative, markLaunched, pathOnly, shouldLaunch } from './lib';

type Nav = (to: string, o?: { replace?: boolean }) => void;

const TABS = [
  { path: '/', label: 'Timetable', icon: 'calendar' },
  { path: '/bookings', label: 'Bookings', icon: 'ticket' },
  { path: '/passes', label: 'Passes', icon: 'bag' },
  { path: '/profile', label: 'Profile', icon: 'user' },
];
const AUTH_PATHS = ['/signin', '/signup', '/forgot', '/welcome'];

function App() {
  const [path, nav] = useRoute();
  const auth = useData(() => store.currentUser(), []);

  if (auth.data === undefined && !auth.error) return <Splash tone="navy" />;
  if (auth.error && auth.data === undefined) return <div className="app"><div className="screen"><ErrorBlock error={auth.error} onRetry={auth.reload} /></div></div>;

  const user = auth.data ?? null;
  if (!user) {
    return (
      <div className="app signed-out">
        <AuthScreens path={path} nav={nav} onSignedIn={() => { auth.reload(); nav('/', { replace: true }); }} />
      </div>
    );
  }
  if (user.kind !== 'client') return <StaffNotice user={user} onSignOut={async () => { await store.signOut().catch(() => {}); auth.reload(); }} />;
  return (
    <>
      <SignedIn user={user} path={path} nav={nav} refreshAuth={auth.reload} />
      <Launch />
    </>
  );
}

// ------------------------------------------------------------------ launch moment
// Opening the app already signed in plays the website's logo reveal once per session, on navy,
// then lifts away. Signed-out visitors get the same reveal on the welcome hero instead.
function Launch() {
  const [phase, setPhase] = useState<'show' | 'leave' | 'gone'>(() => shouldLaunch() ? 'show' : 'gone');
  useEffect(() => {
    if (phase === 'gone') return;
    markLaunched();
    const a = window.setTimeout(() => setPhase('leave'), 2100);
    const b = window.setTimeout(() => setPhase('gone'), 2700);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, []);
  if (phase === 'gone') return null;
  return (
    <div className={'launch' + (phase === 'leave' ? ' leave' : '')} aria-hidden="true" onClick={() => setPhase('gone')}>
      <Logo animate white width={236} />
      <p className="launch-line">Feel your best</p>
    </div>
  );
}

function SignedIn({ user, path, nav, refreshAuth }: { user: Extract<AuthUser, { kind: 'client' }>; path: string; nav: Nav; refreshAuth: () => void }) {
  const boot = useData(async () => {
    const [client, settings, staff, classTypes] = await Promise.all([
      store.getClient(user.clientId), store.getSettings(), store.listStaff(), store.listClassTypes(),
    ]);
    return { client, settings, staff, classTypes };
  }, [user.clientId]);

  const p = pathOnly(path);
  useEffect(() => { if (AUTH_PATHS.includes(p)) nav('/', { replace: true }); }, [p]);

  const ctx: AppCtx | null = useMemo(() => boot.data ? { user, ...boot.data, refreshAuth: () => { refreshAuth(); boot.reload(); } } : null,
    [boot.data, user]);

  if (!ctx) {
    if (boot.error) return <div className="app"><div className="screen"><ErrorBlock error={boot.error} onRetry={boot.reload} /></div></div>;
    return <Splash />;
  }

  const classMatch = match('/class/:id', p);
  let screen: React.ReactNode;
  let tab = '/';
  let chrome = true;
  if (p === '/waiver') { screen = <Waiver nav={nav} path={path} />; chrome = false; }
  else if (p === '/bookings') { screen = <Bookings nav={nav} />; tab = p; }
  else if (p === '/passes') { screen = <Passes nav={nav} path={path} />; tab = p; }
  else if (p === '/profile') { screen = <Profile nav={nav} />; tab = p; }
  else screen = <Timetable nav={nav} openId={classMatch?.id} />;

  return (
    <Ctx.Provider value={ctx}>
      <div className={'app' + (chrome ? ' has-tabs' : '') + (store.mode === 'demo' ? ' demo' : '')}>
        <main key={chrome ? tab : 'flow'} className="view">{screen}</main>
        {chrome && <TabBar active={tab} nav={nav} />}
      </div>
    </Ctx.Provider>
  );
}

function TabBar({ active, nav }: { active: string; nav: Nav }) {
  const i = Math.max(0, TABS.findIndex((t) => t.path === active));
  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar-inner" style={{ ['--i' as any]: i }}>
        <span className="tab-glow" aria-hidden="true" />
        {TABS.map((t) => (
          <button key={t.path} className={'tab' + (t.path === active ? ' on' : '')} aria-current={t.path === active ? 'page' : undefined}
            onClick={() => { if (t.path === active) window.scrollTo({ top: 0, behavior: 'smooth' }); else nav(t.path); }}>
            <Icon name={t.icon} size={23} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function Splash({ tone }: { tone?: 'navy' }) {
  return (
    <div className={'splash' + (tone ? ' ' + tone : '')} aria-busy="true" aria-label="Loading">
      <Flower size={44} className="pulse" />
    </div>
  );
}

function StaffNotice({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  return (
    <div className="app">
      <div className="screen center-col staff-notice">
        <Logo width={150} animate />
        <h1>Hi <em>{user.name.split(' ')[0]}</em></h1>
        <p className="muted">You’re signed in with a staff account. The front desk and roster tools live in the studio app.</p>
        <a className="btn block" href="studio/">Open the studio app <Icon name="chevron" size={18} /></a>
        <button className="btn ghost block" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ boot
captureInstallPrompt();
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !isNative()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is a nice-to-have */ }); });
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <DemoBadge />
    <App />
  </ToastProvider>,
);
