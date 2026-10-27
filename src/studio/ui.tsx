/** Studio app: small UI kit, permissions and app context. */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { AuthUser, ClassType, ScheduleTemplate, Staff, StaffRole, Studio, StudioSettings } from '../shared/types';
import { dayLong as _dayLong, dayShort as _dayShort, initials, time } from '../shared/format';

/** 'Tue 14 Oct' (Intl adds a comma in en-AU; RULES.md wants none). */
export const dayShort = (iso: string | Date) => _dayShort(iso).replace(',', '');
export const dayLong = (iso: string | Date) => _dayLong(iso).replace(',', '');
/** '6:00am Tue 14 Oct' */
export const dateTime = (iso: string | Date) => `${time(iso)} ${dayShort(iso)}`;
import { Sheet, leaveSheets } from '../shared/react';
import { Flower } from '../shared/brand';
import { can, type FeatureAction, type StaffAction } from '../domain';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

// ------------------------------------------------------------------ assets
/** Studio is served at /studio/, so brand + store photo paths need a '../' prefix. */
export function asset(p?: string | null): string | undefined {
  if (!p) return undefined;
  if (/^(https?:|data:|blob:)/.test(p)) return p;
  return '../' + p.replace(/^(\.\.\/|\.\/|\/)+/, '');
}

// ------------------------------------------------------------------ permissions (RULES.md › Staff permissions)
// UI-friendly names mapped onto the engine's matrix (src/domain/permissions.ts), so the screens hide
// exactly what the store would refuse.
const PERM_MAP = {
  reports: 'reports', // attendance reports (everyone)
  revenue: 'reports_revenue', // revenue figures in reports
  settings: 'settings', // policies, class types
  products: 'products',
  staff: 'staff',
  studioFinance: 'settings_financial', // ABN / GST / bank / Stripe
  pay: 'reports_pay', // pay amounts in reports, pay rates on staff
  refund: 'pos_refund',
  pos: 'pos',
  editClass: 'schedule', // edit / cancel / add classes, timetable
  allRosters: 'roster_all', // any class's roster (instructors: own classes only)
  staffNotes: 'client_staff_notes',
  adjustPasses: 'passes_manage',
  editMembership: 'membership_edit', // renewal date + move to another membership (owner, manager)
  editEmails: 'emails_edit', // Settings > Emails: wording and on/off of client emails (owner, manager)
  editClients: 'clients_edit', // add / edit clients (walk-ins create a client)
  waiver: 'waiver_record',
  salesView: 'sales_view', // a client's purchase history
  exportSales: 'export_sales',
  exportClients: 'export_clients',
} as const satisfies Record<string, StaffAction>;
export type Perm = keyof typeof PERM_MAP;
/** Core UI permissions (above) or a feature action ('payroll.view', see registerPermissions). */
export const roleCan = (role: StaffRole, p: Perm | FeatureAction | string) =>
  p.includes('.') ? can(role, p as FeatureAction) : p in PERM_MAP ? can(role, PERM_MAP[p as Perm]) : false;
export const ROLE_LABEL: Record<StaffRole, string> = { owner: 'Owner', manager: 'Manager', front_desk: 'Front desk', instructor: 'Instructor' };
/** Like the website's team cards: 'Owner + instructor', 'Front desk + instructor'. Teaching is about the timetable, not the role. */
export const roleLabel = (role: StaffRole, teaches: boolean) => (teaches && role !== 'instructor' ? `${ROLE_LABEL[role]} + instructor` : ROLE_LABEL[role]);
/** Staff ids that teach a weekly class on the timetable. */
export const teacherIds = (templates: { instructorId: string; active: boolean }[]) => new Set(templates.filter((t) => t.active).map((t) => t.instructorId));

// ------------------------------------------------------------------ app context
export type StaffUser = Extract<AuthUser, { kind: 'staff' }>;
export interface StudioCtxValue {
  me: StaffUser;
  staff: Staff[];
  classTypes: ClassType[];
  settings: StudioSettings;
  /** The studio itself (details, tax, branding, status). */
  studio: Studio;
  can: (p: Perm | FeatureAction | string) => boolean;
  staffById: (id?: string) => Staff | undefined;
  typeById: (id?: string) => ClassType | undefined;
  /** Weekly timetable (for who teaches what). */
  templates: ScheduleTemplate[];
  /** Does this staff member teach a weekly class? Based on instructorId, never on role. */
  teaches: (staffId?: string) => boolean;
  /** Usual instructor for a class type (most weekly slots), for new-class defaults. */
  usualInstructor: (classTypeId?: string) => string | undefined;
}
export const StudioCtx = createContext<StudioCtxValue>(null as unknown as StudioCtxValue);
export const useStudio = () => useContext(StudioCtx);

// ------------------------------------------------------------------ icons (1.6px line, 24 grid)
const P: Record<string, React.ReactNode> = {
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  users: <><circle cx="9" cy="8.5" r="3.5" /><path d="M2.8 19.5c.8-3.3 3.3-5 6.2-5s5.4 1.7 6.2 5" /><path d="M15.5 5.3a3.4 3.4 0 0 1 0 6.4M17.6 14.8c1.8.6 3.1 2.2 3.6 4.7" /></>,
  bag: <><path d="M5 8h14l-1.1 11.2a2 2 0 0 1-2 1.8H8.1a2 2 0 0 1-2-1.8L5 8Z" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></>,
  chart: <><path d="M4 20h16" /><rect x="5.5" y="11" width="3" height="6.5" rx="1" /><rect x="10.5" y="6" width="3" height="11.5" rx="1" /><rect x="15.5" y="13" width="3" height="4.5" rx="1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z" /></>,
  logout: <><path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" /><path d="M10 16l-4-4 4-4M6 12h10" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  left: <path d="m14.5 6-6 6 6 6" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeoff: <><path d="M4 4l16 16" /><path d="M9.8 5.8c.7-.2 1.4-.3 2.2-.3 6 0 9.5 6.5 9.5 6.5a16.7 16.7 0 0 1-3 3.7M6.6 7.1C4 8.9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  right: <path d="m9.5 6 6 6-6 6" />,
  down: <path d="m6 9.5 6 6 6-6" />,
  more: <><circle cx="5.5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.8v2" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  alert: <><path d="M12 3.5 21.5 20h-19L12 3.5Z" /><path d="M12 10v4.5M12 17.3v.2" /></>,
  cake: <><path d="M4.5 20.5v-7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7M3 20.5h18" /><path d="M4.5 15.5c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0M12 11.5V8M12 5.5c-.8-.8-.8-1.8 0-2.5.8.7.8 1.7 0 2.5Z" /></>,
  injury: <><rect x="4" y="4" width="16" height="16" rx="5" /><path d="M12 8.5v7M8.5 12h7" /></>,
  sparkle: <path d="M12 3.5c.6 4.4 2.3 6.4 6.5 7-4.2.6-5.9 2.6-6.5 7-.6-4.4-2.3-6.4-6.5-7 4.2-.6 5.9-2.6 6.5-7Z" />,
  ticket: <><path d="M3.5 8a2 2 0 0 0 2-2h13a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2h-13a2 2 0 0 0-2-2V8Z" /><path d="M14 6.5v11" strokeDasharray="1.6 2" /></>,
  move: <><path d="M4 8h13l-3-3M20 16H7l3 3" /></>,
  undo: <><path d="M9 7 5 11l4 4" /><path d="M5 11h9a5 5 0 0 1 0 10h-2" /></>,
  phone: <path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2L16.5 13l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" />,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="m4 7 8 6 8-6" /></>,
  edit: <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M4.5 7h15M10 4h4M6.5 7l.8 12a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M7 15h3" /></>,
  cash: <><rect x="2.5" y="6.5" width="19" height="11" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 9.5v5M18 9.5v5" /></>,
  gift: <><rect x="4" y="9" width="16" height="11.5" rx="1.5" /><path d="M3 9h18M12 9v11.5M12 9c-1.5-3.5-5.5-4-5.5-1.5S12 9 12 9Zm0 0c1.5-3.5 5.5-4 5.5-1.5S12 9 12 9Z" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>,
  print: <><path d="M7 9V3.5h10V9M7 17H4.5v-6.5a1.5 1.5 0 0 1 1.5-1.5h12a1.5 1.5 0 0 1 1.5 1.5V17H17" /><rect x="7" y="14" width="10" height="6.5" rx="1" /></>,
  download: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" /></>,
  userPlus: <><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 19.5c.8-3.3 3.4-5 6.5-5 1.6 0 3 .4 4.2 1.3M18.5 13v6M15.5 16h6" /></>,
  repeat: <><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19l-3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5l3 3" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  doc: <><path d="M6.5 3.5h7l4 4v13h-11a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5Z" /><path d="M13.5 3.5v4h4M8.5 12.5h7M8.5 16h5" /></>,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" />,
  waitlist: <><path d="M4 6.5h10M4 12h10M4 17.5h6" /><circle cx="18" cy="16" r="3.5" /><path d="M18 14.5V16l1 .8" /></>,
  ban: <><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>,
  flower: <><circle cx="12" cy="12" r="2.2" /><path d="M12 9.8C10 6.5 10.5 3.5 12 3.5s2 3 0 6.3ZM12 14.2c2 3.3 1.5 6.3 0 6.3s-2-3 0-6.3ZM9.8 12C6.5 14 3.5 13.5 3.5 12s3-2 6.3 0ZM14.2 12c3.3-2 6.3-1.5 6.3 0s-3 2-6.3 0Z" /></>,
};
export function Icon({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={cx('ic', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name] ?? null}
    </svg>
  );
}

// ------------------------------------------------------------------ bits
const TINTS = ['t1', 't2', 't3', 't4', 't5'];
function hash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
/** Circular avatar. Photos (staff) get the website's mist ring, like the team section. */
export function Avatar({ name, photo, size = 44, className }: { name: string; photo?: string; size?: number; className?: string }) {
  const src = asset(photo);
  const ring = src ? Math.max(2, Math.round(size * 0.055)) : 0;
  return (
    <span className={cx('av', TINTS[hash(name) % TINTS.length], src && 'ph', className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.36), ['--ring' as string]: ring + 'px' }}>
      {src ? <img src={src} alt="" loading="lazy" /> : initials(name)}
    </span>
  );
}

/** 'Mat Essentials' -> Mat <em>Essentials</em> */
export function Accent({ text }: { text: string }) {
  const i = text.lastIndexOf(' ');
  if (i < 0) return <em>{text}</em>;
  return <>{text.slice(0, i + 1)}<em>{text.slice(i + 1)}</em></>;
}

// ------------------------------------------------------------------ back navigation
// A small trail of the routes visited in this tab, so a page's "‹ Back" link can pop history (like a native
// back) when it leads to where you just came from, and pick its label from it ("‹ Today" vs "‹ Schedule").
// Every history entry carries a unique stamp (state.spcT, set by shared/react before this runs), so a
// back/forward lands on a known stamp and a new stamp is a new page. Sheet entries (state.spcBack) are skipped.
const routeOf = (h: string) => (h.replace(/^#/, '').split('?')[0] || '/');
const stampOf = (): number | undefined => { try { return history.state?.spcT; } catch { return undefined; } };
type Stop = { t?: number; r: string };
const trail: Stop[] = [{ t: typeof window !== 'undefined' ? stampOf() : undefined, r: typeof location !== 'undefined' ? routeOf(location.hash) : '/' }];
let trailAt = 0;
let replacing = false;
if (typeof window !== 'undefined') {
  const sync = (isHashChange: boolean) => {
    let st: any = null; try { st = history.state; } catch { /* */ }
    if (st?.spcBack) return; // a sheet's entry: not a page
    const t = stampOf(), r = routeOf(location.hash);
    const i = t == null ? -1 : trail.findIndex((x) => x.t === t);
    if (i >= 0) { trailAt = i; trail[i]!.r = r; return; } // back / forward to a page we know
    if (!isHashChange) return;
    if (replacing) { replacing = false; trail[trailAt] = { t, r }; return; }
    trail.splice(trailAt + 1, trail.length, { t, r });
    trailAt = trail.length - 1;
  };
  window.addEventListener('popstate', () => sync(false));
  window.addEventListener('hashchange', () => sync(true));
}
/** The route you came from (e.g. '/', '/schedule/2026-10-12', '/clients/abc'), or null after a reload / deep link. */
export const prevRoute = (): string | null => (trailAt > 0 ? trail[trailAt - 1]!.r : null);
/** Change route without adding a history entry (e.g. switching settings tabs). */
export function replaceRoute(to: string) {
  if (location.hash.replace(/^#/, '') === to.replace(/^#/, '')) return;
  replacing = true;
  location.replace('#' + to.replace(/^#/, ''));
}
/** Follow a link from inside a sheet: close the sheets (popping their history entries) and then go. */
export function goFromSheet(e: React.MouseEvent | null, href: string) {
  e?.preventDefault();
  leaveSheets(() => { location.hash = href.replace(/^#/, ''); });
}

export type BackTo = { href: string; label: string };
/** "‹ Today": goes back in history when that's where you came from, otherwise links there. */
export function BackLink({ href, label, className }: BackTo & { className?: string }) {
  const go = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (prevRoute() === routeOf(href)) { e.preventDefault(); history.back(); }
  };
  return <a className={cx('back-pill', className)} href={href} onClick={go}><Icon name="left" size={20} /><span>{label}</span></a>;
}
/** Back target for a page: where you came from if `name` recognises it, otherwise the fallback. */
export function backFrom(name: (route: string) => string | null, fallback: BackTo): BackTo {
  const p = prevRoute();
  const label = p ? name(p) : null;
  return p && label ? { href: '#' + p, label } : fallback;
}

export function PageHead({ eyebrow, title, sub, actions, back }: { eyebrow?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; back?: BackTo }) {
  return (
    <header className="page-head">
      <div className="ph-text">
        {back && <BackLink {...back} className="ph-back" />}
        {eyebrow && <div className="eyebrow"><Flower size={12} className="eb-fl" />{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <div className="ph-sub">{sub}</div>}
      </div>
      {actions && <div className="ph-actions">{actions}</div>}
    </header>
  );
}

/**
 * Pinned sheet header (stays put while the sheet scrolls). back = a step inside the sheet ("‹ Find a client"),
 * shown as the same pill as page back links; ✕ always closes the whole sheet.
 */
export function SheetHead({ title, sub, onClose, back }: { title: React.ReactNode; sub?: React.ReactNode; onClose: () => void; back?: { label: string; onClick: () => void } }) {
  return (
    <div className={cx('sh-head', back && 'has-back')}>
      {back && <button type="button" className="back-pill" onClick={back.onClick}><Icon name="left" size={20} /><span>{back.label}</span></button>}
      <div className="sh-title">
        <h3>{title}</h3>
        {sub && <p className="muted small" style={{ marginTop: 6 }}>{sub}</p>}
      </div>
      <button type="button" className="btn icon soft sh-x" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
    </div>
  );
}

export function Fill({ value, max, tone }: { value: number; max: number; tone?: 'light' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <span className={cx('fill', tone, pct >= 100 && 'full', pct >= 75 && pct < 100 && 'hot')}>
      <span style={{ width: pct + '%' }} />
    </span>
  );
}

export function Seg<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('seg', className)} role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)} type="button">{o.label}</button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <Flower size={40} className="empty-fl" />
      <p className="serif" style={{ fontSize: 26, color: 'var(--ink)' }}>{title}</p>
      {children && <div className="muted" style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

export function Loading() {
  return <div className="loading" role="status" aria-label="Loading"><Flower size={14} /><Flower size={14} /><Flower size={14} /></div>;
}

/** Confirm sheet. */
export function Confirm({ open, title, body, confirmLabel, danger, busy, onConfirm, onClose, children }: {
  open: boolean; title: React.ReactNode; body?: React.ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onClose: () => void; children?: React.ReactNode;
}) {
  return (
    <Sheet open={open} onClose={onClose} label={typeof title === 'string' ? title : 'Confirm'}>
      <SheetHead title={title} onClose={onClose} />
      {body && <p className="muted" style={{ marginBottom: 16 }}>{body}</p>}
      {children}
      <div className="sh-foot">
        <button className="btn ghost" onClick={onClose}>Not now</button>
        <button className={cx('btn', danger && 'danger-solid')} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ snackbar with an action (undo)
type Snack = { id: number; msg: string; action?: { label: string; run: () => void } };
const SnackCtx = createContext<(msg: string, action?: Snack['action']) => void>(() => {});
export function SnackProvider({ children }: { children: React.ReactNode }) {
  const [snack, setSnack] = useState<Snack | null>(null);
  const t = useRef<number>(0);
  const show = useCallback((msg: string, action?: Snack['action']) => {
    const id = Date.now();
    setSnack({ id, msg, action });
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setSnack((s) => (s && s.id === id ? null : s)), action ? 10000 : 2800);
  }, []);
  return (
    <SnackCtx.Provider value={show}>
      {children}
      {snack && (
        <div className="snack" role="status" key={snack.id}>
          <span>{snack.msg}</span>
          {snack.action && (
            <button onClick={() => { snack.action!.run(); setSnack(null); }}>{snack.action.label}</button>
          )}
        </div>
      )}
    </SnackCtx.Provider>
  );
}
export const useSnack = () => useContext(SnackCtx);

// ------------------------------------------------------------------ money input helpers
export const toDollars = (c: number | undefined | null) => (c == null ? '' : (c / 100).toFixed(c % 100 ? 2 : 0));
export const toCents = (s: string) => { const n = parseFloat(s.replace(/[^0-9.]/g, '')); return isFinite(n) ? Math.round(n * 100) : 0; };

/** Download text as a file (CSV export). */
export function downloadText(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A tiny flower used as a separator, like the website's marquee. */
export const Sep = () => <Flower size={8} className="sep-fl" />;

export const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
