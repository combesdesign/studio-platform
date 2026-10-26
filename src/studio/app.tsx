/**
 * Studio / staff app (served at /studio/), loaded by main.tsx once the studio is known.
 * Feature modules add nav items, pages, settings tabs, Today widgets and slot content through
 * src/shared/registry.ts (never by editing this file).
 */
import React, { useCallback, useMemo, useState } from 'react';
import type { Root } from 'react-dom/client';
import { isFeatureLocked, studioNavItems, studioRoutesAll, studioRoutesList } from '../shared/registry';
import { BillingBanner, Upsell } from './billing';
import { isSingleStudio } from '../shared/boot';
import { StudioSwitcher } from './choose';
import { Onboarding } from './onboarding';
import '../features/studio';
import { DemoBadge, Sheet, ToastProvider, leaveSheets, match, store, useData, useRoute, useToast } from '../shared/react';
import type { AuthUser, StaffRole, Studio } from '../shared/types';
import { Flower, Logo } from '../shared/brand';
import { Avatar, Icon, Loading, SheetHead, SnackProvider, StudioCtx, cx, goFromSheet, roleCan, roleLabel, teacherIds, type Perm, type StaffUser, type StudioCtxValue } from './ui';
import { SignIn } from './signin';
import { LINK_PROBLEM, NewPassword, endPasswordLink, usePasswordLink, type PasswordLinkKind } from './password';
import { Today } from './today';
import { Roster } from './roster';
import { Schedule, Timetable } from './schedule';
import { Clients, ClientProfile } from './clients';
import { Pos } from './pos';
import { Reports } from './reports';
import { Settings } from './settings';

type NavItem = { href: string; label: string; short?: string; icon: React.ReactNode; perm?: string; key: string; order: number };
const CORE_NAV: NavItem[] = [
  { key: 'today', href: '#/', label: 'Today', icon: 'today', order: 10 },
  { key: 'schedule', href: '#/schedule', label: 'Schedule', icon: 'calendar', order: 20 },
  { key: 'clients', href: '#/clients', label: 'Clients', icon: 'users', order: 30 },
  { key: 'pos', href: '#/pos', label: 'Point of sale', short: 'Sell', icon: 'bag', perm: 'pos', order: 40 },
  { key: 'reports', href: '#/reports', label: 'Reports', icon: 'chart', perm: 'reports', order: 50 },
  { key: 'settings', href: '#/settings', label: 'Settings', icon: 'settings', perm: 'settings', order: 60 },
];
/** Core nav plus feature nav items (registerStudioNav), in order. */
const navItems = (): NavItem[] => [...CORE_NAV, ...studioNavItems().map((n) => ({
  key: n.id, href: n.href, label: n.label, ...(n.short ? { short: n.short } : {}), icon: n.icon as React.ReactNode,
  ...(n.perm ? { perm: n.perm } : {}), order: n.order ?? 100,
}))].sort((a, b) => a.order - b.order);
const NavIcon = ({ icon, size }: { icon: React.ReactNode; size?: number }) => (typeof icon === 'string' ? <Icon name={icon} size={size} /> : <>{icon}</>);

function section(path: string): string {
  const p = path.split('?')[0]!;
  const feature = studioRoutesList().find((r) => match(r.path, p));
  if (feature?.nav) return feature.nav;
  const s = p.split('/')[1] || 'today';
  if (s === 'class') return 'schedule';
  if (s === 'welcome') return 'settings';
  return navItems().find((n) => n.href === `#/${s}`)?.key ?? s;
}

function App() {
  const auth = useData(() => store.currentUser(), []);
  const link = usePasswordLink();
  const toast = useToast();
  // Just signed in by saving a new password: go straight to Today while auth re-loads.
  const [justIn, setJustIn] = useState<AuthUser | null>(null);
  React.useEffect(() => { if (auth.data) setJustIn(null); }, [auth.data]);
  if (link.kind) {
    const finish = async (kind: PasswordLinkKind) => {
      const u = await store.currentUser().catch(() => null);
      endPasswordLink();
      if (u && u.kind === 'staff') {
        setJustIn(u);
        auth.reload();
        toast(kind === 'invite' ? 'Welcome aboard! Your password is saved' : 'All set – your new password is saved');
      } else toast('Password saved. Sign in with your new password');
      location.replace('#/');
    };
    return <NewPassword kind={link.kind} email={auth.data?.email} signedIn={auth.data?.kind === 'staff'} onSaved={finish} />;
  }
  const user = auth.data ?? justIn;
  if (link.arriving || (auth.loading && auth.data === undefined)) return <div className="boot"><Loading /></div>;
  if (!user || user.kind !== 'staff') return <SignIn notStaff={!!user && user.kind !== 'staff'} onDone={auth.reload} linkProblem={LINK_PROBLEM} />;
  return <Signed me={user} />;
}

function Signed({ me }: { me: StaffUser }) {
  const base = useData(async () => {
    const [staff, classTypes, settings, templates, studio] = await Promise.all([
      store.listStaff({ includeInactive: true }), store.listClassTypes({ includeInactive: true }), store.getSettings(),
      store.listTemplates().catch(() => []), store.getStudio(),
    ]);
    return { staff, classTypes, settings, templates, studio };
  }, []);
  const role: StaffRole = me.role;
  const can = useCallback((p: Perm | string) => roleCan(role, p), [role]);
  const ctx = useMemo<StudioCtxValue | null>(() => {
    if (!base.data) return null;
    const { staff, classTypes, settings, templates, studio } = base.data;
    const teaching = teacherIds(templates);
    return {
      me, staff, classTypes, settings, can, templates, studio,
      staffById: (id) => staff.find((s) => s.id === id),
      typeById: (id) => classTypes.find((t) => t.id === id),
      teaches: (id) => !!id && teaching.has(id),
      usualInstructor: (classTypeId) => {
        const n = new Map<string, number>();
        for (const t of templates) if (t.active && t.classTypeId === classTypeId) n.set(t.instructorId, (n.get(t.instructorId) ?? 0) + 1);
        const best = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return best && staff.find((s) => s.id === best && s.active) ? best : undefined;
      },
    };
  }, [base.data, me, can]);

  if (base.error && !base.data) return <div className="boot"><p className="muted">Couldn't load the studio. {base.error.message}</p></div>;
  if (!ctx) return <div className="boot"><Loading /></div>;
  return <StudioCtx.Provider value={ctx}><Shell /></StudioCtx.Provider>;
}

function Shell() {
  const [path] = useRoute();
  const { me, staffById, can, teaches } = React.useContext(StudioCtx);
  const myRole = roleLabel(me.role, teaches(me.staffId));
  const [moreOpen, setMoreOpen] = useState(false);
  const cur = section(path);
  const items = navItems().filter((n) => !n.perm || can(n.perm));
  const { studio } = React.useContext(StudioCtx);
  // A brand-new studio: the owner goes through setup first (they can still leave it from the sidebar).
  React.useEffect(() => {
    if (studio.status === 'onboarding' && me.role === 'owner' && !/^#?\/welcome/.test(location.hash) && !sessionStorage.getItem(`onboard-skip-${studio.id}`)) location.replace('#/welcome');
  }, [studio.status]);
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
  else if (p === '/welcome' || (m = match('/welcome/:step', p))) page = me.role === 'owner' ? <Onboarding step={m?.step} /> : <NoAccess />;
  else {
    let fm: Record<string, string> | null = null;
    const feature = studioRoutesList().find((r) => (fm = match(r.path, p)));
    // A page the plan doesn't include: a calm "Available on Studio Plus", not "not found".
    const locked = feature ? undefined : studioRoutesAll().find((r) => r.feature && isFeatureLocked(r.feature) && match(r.path, p));
    page = feature ? (!feature.perm || can(feature.perm) ? feature.render({ params: fm ?? {}, path }) : <NoAccess />)
      : locked ? (!locked.perm || can(locked.perm) ? <Upsell feature={locked.feature!} /> : <NoAccess />) : <NoAccess title="Page not found" />;
  }

  return (
    <div className="app">
      <aside className="side" aria-label="Main">
        <a className="brand" href="#/" aria-label={`${studio.name} studio home`}>
          <Logo className="brand-logo" letters="var(--highlight)" flower="var(--accent)" />
          <span className="brand-tag">Studio</span>
        </a>
        <nav className="nav">
          {items.map((n) => (
            <a key={n.key} href={n.href} className={cx(cur === n.key && 'on')} aria-current={cur === n.key ? 'page' : undefined}>
              <NavIcon icon={n.icon} /><span className="nl">{n.label}</span><span className="ns">{n.short ?? n.label}</span>
              {cur === n.key && <Flower size={12} className="nav-fl" />}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          {!isSingleStudio() && <StudioSwitcher current={studio} />}
          <a className="side-link" href={clientAppHref(studio)} target="_blank" rel="noopener"><Icon name="external" size={18} /><span>Client app</span></a>
          <div className="me">
            <Avatar name={me.name} photo={photo} size={40} />
            <div className="me-text"><strong>{me.name}</strong><span>{myRole}</span></div>
            <button className="me-out" onClick={signOut} aria-label="Sign out" title="Sign out"><Icon name="logout" size={20} /></button>
          </div>
        </div>
      </aside>

      <nav className="tabbar" aria-label="Main">
        {barItems.map((n) => (
          <a key={n.key} href={n.href} className={cx(cur === n.key && 'on')}><NavIcon icon={n.icon} /><span>{n.short ?? n.label}</span></a>
        ))}
        <button className={cx(overflow.some((n) => n.key === cur) && 'on')} onClick={() => setMoreOpen(true)}><Icon name="menu" /><span>More</span></button>
      </nav>
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label="More">
        <SheetHead title={<>More</>} onClose={() => setMoreOpen(false)} />
        <div className="more-me">
          <Avatar name={me.name} photo={photo} size={48} />
          <div><strong>{me.name}</strong><div className="muted small">{myRole}</div></div>
        </div>
        <div className="list more-list">
          {overflow.map((n) => (
            <a key={n.key} href={n.href} onClick={(e) => goFromSheet(e, n.href)}><NavIcon icon={n.icon} />{n.label}<Icon name="right" size={18} className="push" /></a>
          ))}
          {!isSingleStudio() && <StudioSwitcher current={studio} variant="row" />}
          <a href={clientAppHref(studio)} target="_blank" rel="noopener"><Icon name="external" />Open the client app<Icon name="right" size={18} className="push" /></a>
          <button onClick={() => leaveSheets(signOut)}><Icon name="logout" />Sign out</button>
        </div>
      </Sheet>

      <main className="main" key={p}><BillingBanner />{page}</main>
    </div>
  );
}

function NoAccess({ title = 'Not available for your role' }: { title?: string }) {
  const { staff } = React.useContext(StudioCtx);
  const owner = staff.find((s) => s.role === 'owner' && s.active)?.name ?? 'the studio owner';
  return (
    <div className="card pad" style={{ marginTop: 40 }}>
      <div className="empty">
        <Flower size={40} className="empty-fl" />
        <p className="serif" style={{ fontSize: 28, color: 'var(--ink)' }}>{title}</p>
        <p style={{ marginTop: 8 }}>Ask {owner} if you think you should have access.</p>
        <a className="btn soft" style={{ marginTop: 18 }} href="#/">Back to today</a>
      </div>
    </div>
  );
}

/** The client app for this studio (same studio, one folder up). */
function clientAppHref(studio: Studio): string {
  return isSingleStudio() ? '../' : `../?studio=${encodeURIComponent(studio.slug)}#/`;
}

// ------------------------------------------------------------------ mount (called by main.tsx once the studio is bound)
export function mount(root: Root, _studio: Studio): void {
  root.render(
    <ToastProvider>
      <SnackProvider>
        <DemoBadge />
        <App />
      </SnackProvider>
    </ToastProvider>,
  );
}
