/**
 * Client app (PWA now, Capacitor later), loaded by main.tsx once the studio is known. Hash routing only.
 * Feature modules add tabs, screens and profile entries through src/shared/registry.ts (never by editing this file).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Root } from 'react-dom/client';
import type { AuthUser, Studio } from '../shared/types';
import { clientRoutesList, clientTabsList } from '../shared/registry';
import { getBranding } from '../shared/branding';
import '../features/client';
import { store, featureOn, useData, useRoute, match, ToastProvider, DemoBadge, useToast } from '../shared/react';
import { AuthScreens, NewPassword } from './auth';
import { Timetable } from './timetable';
import { Bookings } from './bookings';
import { Passes } from './passes';
import { Profile, captureInstallPrompt } from './profile';
import { Waiver } from './waiver';
import { Family } from './family';
import { Ctx, ErrorBlock, Flower, Icon, Logo } from './ui';
import type { AppCtx } from './ui';
import {
  arrivingFromLink, dropFlow, isDeepLink, rememberLink, takeRememberedLink, endPasswordLink, goFlow, hasLinkProblem, isNative, markLaunched, onPasswordLink, passwordLinkKind, pathOnly, shouldLaunch,
  takeLinkOrigin, type PasswordLinkKind,
} from './lib';

type Nav = (to: string, o?: { replace?: boolean }) => void;

const CORE_TABS = [
  { path: '/', label: 'Timetable', icon: 'calendar' as React.ReactNode, order: 10 },
  { path: '/bookings', label: 'Bookings', icon: 'ticket' as React.ReactNode, order: 20 },
  { path: '/passes', label: 'Passes', icon: 'bag' as React.ReactNode, order: 30 },
  { path: '/profile', label: 'Profile', icon: 'user' as React.ReactNode, order: 40 },
];
/** Core tabs plus any a feature registered (registerClientTab), in order. */
const tabs = () => [...CORE_TABS, ...clientTabsList().map((t) => ({ path: t.path, label: t.label, icon: t.icon as React.ReactNode, order: t.order ?? 100 }))]
  .sort((a, b) => a.order - b.order);
const AUTH_PATHS = ['/signin', '/signup', '/forgot', '/welcome'];

function App() {
  const [path, nav] = useRoute();
  const auth = useData(() => store.currentUser(), []);
  const toast = useToast();
  const link = usePasswordLinkRoute(path, nav);
  // Just signed in by saving a new password: show the timetable straight away while auth re-loads.
  const [justIn, setJustIn] = useState<AuthUser | null>(null);
  useEffect(() => { if (auth.data) setJustIn(null); }, [auth.data]);

  if (link.kind) {
    const finish = async (kind: PasswordLinkKind) => {
      const u = await store.currentUser().catch(() => null);
      dropFlow('/new-password');
      endPasswordLink();
      if (u) {
        setJustIn(u);
        auth.reload();
        toast(kind === 'invite' ? 'You’re in! Your password is saved' : 'All set – your new password is saved');
        nav('/', { replace: true });
      } else {
        toast('Password saved. Sign in with your new password');
        nav('/signin', { replace: true });
      }
    };
    return (
      <div className="app signed-out">
        <NewPassword kind={link.kind} path={path} nav={nav} email={auth.data?.email} signedIn={!!auth.data} onSaved={finish} />
      </div>
    );
  }
  const signedOut = auth.data === null || (auth.data === undefined && !!auth.error);
  useEffect(() => { if (signedOut && isDeepLink(path)) rememberLink(path); }, [signedOut, path]);

  if (link.arriving || (auth.data === undefined && !auth.error)) return <Splash tone="navy" />;
  if (auth.error && auth.data === undefined) return <div className="app"><div className="screen"><ErrorBlock error={auth.error} onRetry={auth.reload} /></div></div>;

  const user = auth.data ?? justIn;
  if (!user) {
    return (
      <div className="app signed-out">
        <AuthScreens path={path} nav={nav} onSignedIn={() => { auth.reload(); nav(takeRememberedLink() ?? '/', { replace: true }); }} />
      </div>
    );
  }
  if (user.kind !== 'client') return <StaffNotice user={user} onSignOut={async () => { await store.signOut().catch(() => {}); setJustIn(null); auth.reload(); }} />;
  return (
    <>
      <SignedIn user={user} path={path} nav={nav} refreshAuth={auth.reload} />
      <Launch />
    </>
  );
}

/**
 * Reset and invite links: when the store says one arrived, open '#/new-password' (pushed from the demo button so
 * back returns there; replacing the token address on a real link). Returns the link kind while that screen is up.
 */
function usePasswordLinkRoute(path: string, nav: Nav): { kind: PasswordLinkKind | null; arriving: boolean } {
  const [kind, setKind] = useState<PasswordLinkKind | null>(passwordLinkKind);
  const [arriving, setArriving] = useState(arrivingFromLink);
  useEffect(() => {
    const off = onPasswordLink((k) => {
      setKind(k);
      setArriving(false);
      const from = takeLinkOrigin();
      if (from) goFlow(nav, '/new-password', from);
      else nav('/new-password', { replace: true });
    });
    // supabase-js normally signs the link in within a second; don't hold the splash forever if it can't.
    const t = window.setTimeout(() => setArriving(false), 6000);
    // An expired or already-used link: straight to "Forgot password", which explains.
    if (hasLinkProblem()) nav('/forgot', { replace: true });
    return () => { off(); window.clearTimeout(t); };
  }, []);
  // Leaving the screen (saved, back, or any other route) ends it; forward/back onto it again doesn't reopen it.
  const onScreen = pathOnly(path) === '/new-password';
  useEffect(() => { if (!onScreen && kind) setKind(null); }, [onScreen]);
  return { kind: onScreen ? kind : null, arriving };
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
      {getBranding().launchLine && <p className="launch-line">{getBranding().launchLine}</p>}
    </div>
  );
}

function SignedIn({ user, path, nav, refreshAuth }: { user: Extract<AuthUser, { kind: 'client' }>; path: string; nav: Nav; refreshAuth: () => void }) {
  const boot = useData(async () => {
    const [client, settings, staff, classTypes, studio, locations] = await Promise.all([
      store.getClient(user.clientId), store.getSettings(), store.listStaff(), store.listClassTypes(), store.getStudio(),
      store.listLocations().catch(() => []),   // a studio with one location never needs them
    ]);
    return { client, settings, staff, classTypes, studio, locations };
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
  let m: Record<string, string> | null = null;
  const feature = clientRoutesList().find((r) => (m = match(r.path, p)));
  if (p === '/waiver') { screen = <Waiver nav={nav} path={path} />; chrome = false; }
  else if (p === '/family' && featureOn('family')) { screen = <Family nav={nav} path={path} />; chrome = false; }
  else if (p === '/bookings') { screen = <Bookings nav={nav} />; tab = p; }
  else if (p === '/passes') { screen = <Passes nav={nav} path={path} />; tab = p; }
  else if (p === '/profile') { screen = <Profile nav={nav} />; tab = p; }
  else if (feature) {
    screen = feature.render({ params: m ?? {}, path, nav });
    chrome = feature.chrome !== false;
    tab = feature.tab ?? (tabs().some((t) => t.path === feature.path) ? feature.path : '');
  }
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
  const list = tabs();
  const i = list.findIndex((t) => t.path === active);
  return (
    <nav className="tabbar" aria-label="Main">
      <div className={'tabbar-inner' + (i < 0 ? ' no-active' : '')} style={{ ['--i' as any]: Math.max(0, i), ['--tabs' as any]: list.length }}>
        <button className="tabbar-logo" aria-label="Timetable" onClick={() => nav('/')}><Logo width={112} /></button>
        <span className="tab-glow" aria-hidden="true" />
        {list.map((t) => (
          <button key={t.path} className={'tab' + (t.path === active ? ' on' : '')} aria-current={t.path === active ? 'page' : undefined}
            onClick={() => { if (t.path === active) window.scrollTo({ top: 0, behavior: 'smooth' }); else nav(t.path); }}>
            {typeof t.icon === 'string' ? <Icon name={t.icon} size={23} /> : t.icon}
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

// ------------------------------------------------------------------ mount (called by main.tsx once the studio is bound)
export function mount(root: Root, _studio: Studio): void {
  captureInstallPrompt();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !isNative()) {
    const reg = () => navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is a nice-to-have */ });
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
  }
  root.render(
    <ToastProvider>
      <DemoBadge />
      <App />
    </ToastProvider>,
  );
}
