/** Snowy Pilates Club — studio / staff app. Served at /studio/. */
import React, { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './studio.css';
import { DemoBadge, Sheet, ToastProvider, match, store, useData, useRoute } from '../shared/react';
import type { StaffRole } from '../shared/types';
import { Avatar, Icon, Loading, ROLE_LABEL, SnackProvider, StudioCtx, cx, roleCan, type Perm, type StaffUser, type StudioCtxValue } from './ui';
import { SignIn } from './signin';
import { Today } from './today';
import { Roster } from './roster';
import { Schedule, Timetable } from './schedule';
import { Clients, ClientProfile } from './clients';
import { Pos } from './pos';
import { Reports } from './reports';
import { Settings } from './settings';

type NavItem = { href: string; label: string; short?: string; icon: string; perm?: Perm; key: string };
const NAV: NavItem[] = [
  { key: 'today', href: '#/', label: 'Today', icon: 'today' },
  { key: 'schedule', href: '#/schedule', label: 'Schedule', icon: 'calendar' },
  { key: 'clients', href: '#/clients', label: 'Clients', icon: 'users' },
  { key: 'pos', href: '#/pos', label: 'Point of sale', short: 'Sell', icon: 'bag', perm: 'pos' },
  { key: 'reports', href: '#/reports', label: 'Reports', icon: 'chart', perm: 'reports' },
  { key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings', perm: 'settings' },
];

function section(path: string): string {
  const s = path.split('?')[0]!.split('/')[1] || 'today';
  if (s === 'class') return 'schedule';
  return s;
}

function App() {
  const auth = useData(() => store.currentUser(), []);
  const user = auth.data;
  if (auth.loading && auth.data === undefined) return <div className="boot"><Loading /></div>;
  if (!user || user.kind !== 'staff') return <SignIn notStaff={!!user && user.kind !== 'staff'} onDone={auth.reload} />;
  return <Signed me={user} />;
}

function Signed({ me }: { me: StaffUser }) {
  const base = useData(async () => {
    const [staff, classTypes, settings] = await Promise.all([
      store.listStaff({ includeInactive: true }), store.listClassTypes({ includeInactive: true }), store.getSettings(),
    ]);
    return { staff, classTypes, settings };
  }, []);
  const role: StaffRole = me.role;
  const can = useCallback((p: Perm) => roleCan(role, p), [role]);
  const ctx = useMemo<StudioCtxValue | null>(() => {
    if (!base.data) return null;
    const { staff, classTypes, settings } = base.data;
    return {
      me, staff, classTypes, settings, can,
      staffById: (id) => staff.find((s) => s.id === id),
      typeById: (id) => classTypes.find((t) => t.id === id),
    };
  }, [base.data, me, can]);

  if (base.error && !base.data) return <div className="boot"><p className="muted">Couldn't load the studio. {base.error.message}</p></div>;
  if (!ctx) return <div className="boot"><Loading /></div>;
  return <StudioCtx.Provider value={ctx}><Shell /></StudioCtx.Provider>;
}

function Shell() {
  const [path] = useRoute();
  const { me, staffById, can } = React.useContext(StudioCtx);
  const [moreOpen, setMoreOpen] = useState(false);
  const cur = section(path);
  const items = NAV.filter((n) => !n.perm || can(n.perm));
  const photo = staffById(me.staffId)?.photoUrl;
  const signOut = async () => { await store.signOut(); location.hash = '/'; };

  // phone bottom bar: first 4 + More
  const barItems = items.slice(0, 4);
  const overflow = items.slice(4);

  let page: React.ReactNode;
  let m: Record<string, string> | null;
  const p = path.split('?')[0]!;
  if (p === '/' || p === '') page = <Today />;
  else if ((m = match('/class/:id', p))) page = <Roster id={m.id!} />;
  else if (p === '/schedule') page = <Schedule />;
  else if (p === '/schedule/timetable') page = can('editClass') ? <Timetable /> : <NoAccess />;
  else if ((m = match('/schedule/:week', p))) page = <Schedule week={m.week} />;
  else if (p === '/clients') page = <Clients />;
  else if ((m = match('/clients/:id', p))) page = <ClientProfile id={m.id!} />;
  else if (p === '/pos') page = can('pos') ? <Pos /> : <NoAccess />;
  else if ((m = match('/pos/:clientId', p))) page = can('pos') ? <Pos clientId={m.clientId} /> : <NoAccess />;
  else if (p === '/reports') page = can('reports') ? <Reports /> : <NoAccess />;
  else if (p === '/settings') page = can('settings') ? <Settings /> : <NoAccess />;
  else if ((m = match('/settings/:tab', p))) page = can('settings') ? <Settings tab={m.tab} /> : <NoAccess />;
  else page = <NoAccess title="Page not found" />;

  return (
    <div className="app">
      <aside className="side" aria-label="Main">
        <a className="brand" href="#/" aria-label="Snowy Pilates Club studio home">
          <img className="brand-full" src="../brand/logo-white.svg" alt="Snowy Pilates Club" />
          <img className="brand-mark" src="../brand/flower-white.svg" alt="" />
          <span className="brand-tag">Studio</span>
        </a>
        <nav className="nav">
          {items.map((n) => (
            <a key={n.key} href={n.href} className={cx(cur === n.key && 'on')} aria-current={cur === n.key ? 'page' : undefined}>
              <Icon name={n.icon} /><span className="nl">{n.label}</span><span className="ns">{n.short ?? n.label}</span>
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <a className="side-link" href="../" target="_blank" rel="noopener"><Icon name="external" size={18} /><span>Client app</span></a>
          <div className="me">
            <Avatar name={me.name} photo={photo} size={40} />
            <div className="me-text"><strong>{me.name}</strong><span>{ROLE_LABEL[me.role]}</span></div>
            <button className="me-out" onClick={signOut} aria-label="Sign out" title="Sign out"><Icon name="logout" size={20} /></button>
          </div>
        </div>
      </aside>

      <nav className="tabbar" aria-label="Main">
        {barItems.map((n) => (
          <a key={n.key} href={n.href} className={cx(cur === n.key && 'on')}><Icon name={n.icon} /><span>{n.short ?? n.label}</span></a>
        ))}
        <button className={cx(overflow.some((n) => n.key === cur) && 'on')} onClick={() => setMoreOpen(true)}><Icon name="menu" /><span>More</span></button>
      </nav>
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label="More">
        <div className="more-me">
          <Avatar name={me.name} photo={photo} size={48} />
          <div><strong>{me.name}</strong><div className="muted small">{ROLE_LABEL[me.role]}</div></div>
        </div>
        <div className="list more-list">
          {overflow.map((n) => (
            <a key={n.key} href={n.href} onClick={() => setMoreOpen(false)}><Icon name={n.icon} />{n.label}<Icon name="right" size={18} className="push" /></a>
          ))}
          <a href="../" target="_blank" rel="noopener"><Icon name="external" />Open the client app<Icon name="right" size={18} className="push" /></a>
          <button onClick={() => { setMoreOpen(false); signOut(); }}><Icon name="logout" />Sign out</button>
        </div>
      </Sheet>

      <main className="main" key={p}>{page}</main>
    </div>
  );
}

function NoAccess({ title = 'Not available for your role' }: { title?: string }) {
  return (
    <div className="card pad" style={{ marginTop: 40 }}>
      <div className="empty">
        <img src="../brand/flower.svg" alt="" />
        <p className="serif" style={{ fontSize: 28, color: 'var(--ink)' }}>{title}</p>
        <p style={{ marginTop: 8 }}>Ask Libby if you think you should have access.</p>
        <a className="btn soft" style={{ marginTop: 18 }} href="#/">Back to today</a>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <SnackProvider>
      <DemoBadge />
      <App />
    </SnackProvider>
  </ToastProvider>,
);
