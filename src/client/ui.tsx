/** Small presentational pieces for the client app. */
import React, { createContext, useContext } from 'react';
import type { AuthUser, ClassType, Client, Location, Staff, Studio, StudioSettings } from '../shared/types';
import { initials } from '../shared/format';
import { asset } from './lib';
import { Flower as BrandFlower, Logo as BrandLogo, logoAspect } from '../shared/brand';
import { brandAsset, classPhotoFor, getBranding } from '../shared/branding';

// ------------------------------------------------------------------ app context
export interface AppCtx {
  user: Extract<AuthUser, { kind: 'client' }>;
  client: Client;
  settings: StudioSettings;
  /** The studio (name, contact, tax, branding). */
  studio: Studio;
  staff: Staff[];
  classTypes: ClassType[];
  /** The studio's active locations (one default location for most studios: then nothing about locations shows). */
  locations: Location[];
  refreshAuth: () => void;
}
export const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('App context missing');
  return c;
}

// ------------------------------------------------------------------ icons (1.6 stroke, 24 grid)
const P: Record<string, React.ReactNode> = {
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  ticket: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5z" /><path d="M14 5.5v13" strokeDasharray="1.6 2.4" /></>,
  bag: <><path d="M5 8h14l-1 11.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></>,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 6 8-6" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z" /></>,
  phone: <path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2C11 19.5 4.5 13 4.5 5.5a2 2 0 0 1 2-2z" />,
  chevron: <path d="M9.5 6l6 6-6 6" />,
  back: <path d="M14.5 6l-6 6 6 6" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="12.8" r="3.4" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  calplus: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M7 15h3" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeoff: <><path d="M4 4l16 16" /><path d="M9.8 5.8c.7-.2 1.4-.3 2.2-.3 6 0 9.5 6.5 9.5 6.5a16.7 16.7 0 0 1-3 3.7M6.6 7.1C4 8.9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  heart: <path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z" />,
  pause: <path d="M9 6v12M15 6v12" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  logout: <><path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" /><path d="M10 8l-4 4 4 4M6 12h9.5" /></>,
  share: <><path d="M12 15V3.5M8 7.5l4-4 4 4" /><path d="M7 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-1" /></>,
  addbox: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></>,
  receipt: <><path d="M6 3.5h12v17l-2.5-1.5-2 1.5-1.5-1.5-1.5 1.5-2-1.5L6 20.5z" /><path d="M9 8h6M9 11.5h6M9 15h3.5" /></>,
  shield: <><path d="M12 3.5l7 3v5.5c0 4.2-3 7.5-7 8.5-4-1-7-4.3-7-8.5V6.5z" /><path d="M9 12l2 2 4-4" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  users: <><circle cx="9" cy="9" r="3.3" /><path d="M3 19c.9-3 3.2-4.6 6-4.6s5.1 1.6 6 4.6" /><path d="M15.5 6a3.2 3.2 0 0 1 0 6.2M17.5 14.8c1.6.6 2.8 2 3.5 4.2" /></>,
  sparkle: <path d="M12 3.5c.6 4.4 2.4 6.6 6.5 7.5-4.1.9-5.9 3.1-6.5 8.5-.6-5.4-2.4-7.6-6.5-8.5 4.1-.9 5.9-3.1 6.5-7.5z" />,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></>,
  apple: <path d="M15.6 12.6c0-2 1.6-2.9 1.7-3-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.4 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.5 2 1 0 1.4-.7 2.6-.7s1.5.7 2.6.7c1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.1-.8-2.1-3.1zM13.7 6.6c.5-.7.9-1.6.8-2.6-.8 0-1.8.5-2.4 1.2-.5.6-1 1.5-.8 2.5.9.1 1.8-.4 2.4-1.1z" />,
};
export function Icon({ name, size = 22, className, fill }: { name: keyof typeof P | string; size?: number; className?: string; fill?: boolean }) {
  return (
    <svg className={'ic ' + (className || '')} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      {P[name]}
    </svg>
  );
}

// ------------------------------------------------------------------ brand
/** The flower mark, drawn inline (shared/brand). white = cream on navy surfaces, like the website. */
export function Flower({ size = 40, white, color, className, spin }: { size?: number; white?: boolean; color?: string; className?: string; spin?: boolean }) {
  return <BrandFlower size={size} color={color ?? (white ? 'var(--highlight)' : 'var(--accent)')} className={'flower ' + (spin ? 'spin ' : '') + (className || '')} />;
}
/** The wordmark, drawn inline. white = cream letters + sky flower (the website's on-navy colours). */
export function Logo({ white, width = 96, animate }: { white?: boolean; width?: number; animate?: boolean }) {
  return <BrandLogo animate={animate} letters={white ? 'var(--highlight)' : 'var(--primary)'} flower="var(--accent)" className="logo" style={{ width, height: 'auto', aspectRatio: String(logoAspect()) }} />;
}

/** The website's thin arrow, used on pill buttons ("Join the club ->"). */
export function Arrow({ size = 16 }: { size?: number }) {
  return <svg className="ic arr" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5" /></svg>;
}

/** The studio's photo for a class type (its own image, else the branding's photo for that class, else the default). */
export function classPhoto(ct?: Pick<ClassType, 'name' | 'imageUrl'> | string): string {
  return brandAsset(classPhotoFor(getBranding(), ct)) ?? '';
}

/** Centred section head like the website: optional kicker, serif headline with an italic sky word, short line under. */
export function SectionHead({ kicker, title, sub, className }: { kicker?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <header className={'sec-head ' + (className || '')}>
      {kicker && <div className="kicker">{kicker}</div>}
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
    </header>
  );
}

/** 'Mums + Bubs' -> Mums + <em>Bubs</em> */
export function Accent({ text }: { text: string }) {
  const i = text.lastIndexOf(' ');
  if (i < 0) return <em>{text}</em>;
  return <>{text.slice(0, i + 1)}<em>{text.slice(i + 1)}</em></>;
}

export function Avatar({ name, src, size = 40, className }: { name: string; src?: string; size?: number; className?: string }) {
  const s = asset(src);
  return (
    <span className={'avatar ' + (className || '')} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {s ? <img src={s} alt="" loading="lazy" /> : <span className="serif">{initials(name)}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ layout bits
export function ScreenHead({ eyebrow, title, right, sub }: { eyebrow?: React.ReactNode; title: React.ReactNode; right?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <header className="shead">
      {eyebrow && <div className="kicker">{eyebrow}</div>}
      <h1>{title}</h1>
      {sub && <p className="shead-sub">{sub}</p>}
      {right}
    </header>
  );
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-mark"><Flower size={34} /></div>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 18, w = '100%', r = 8, style }: { h?: number; w?: number | string; r?: number; style?: React.CSSProperties }) {
  return <span className="skel" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function CardSkeletons({ n = 3, h = 92 }: { n?: number; h?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="skel-card" style={{ height: h, animationDelay: `${i * 80}ms` }}>
          <Skeleton w={56} h={30} r={8} />
          <div style={{ flex: 1, display: 'grid', gap: 10 }}>
            <Skeleton w="60%" h={18} />
            <Skeleton w="40%" h={14} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="seg" role="tablist" style={{ ['--n' as any]: options.length, ['--i' as any]: idx }}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}{o.count ? <span className="seg-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={'toggle' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="empty-state">
      <div className="empty-mark"><Flower size={34} /></div>
      <h3>That didn’t load</h3>
      <p className="muted">{msg}</p>
      {onRetry && <button className="btn soft" onClick={onRetry}><Icon name="refresh" size={18} />Try again</button>}
    </div>
  );
}

/** "‹ Timetable": the back control used everywhere (sheets, flows, auth). */
export function BackPill({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={'back-pill ' + (className || '')} onClick={onClick}>
      <Icon name="back" size={20} /><span>{label}</span>
    </button>
  );
}

export type Back = { label: string; onClick: () => void };

/**
 * Pinned sheet header: stays at the top while the sheet scrolls, so back / ✕ is always in reach.
 * back: drill-down ("‹ Profile"). onClose: ✕. compact: one row with a small title that fades in once scrolled.
 */
export function SheetHead({ title, onClose, eyebrow, back, compact }: { title?: React.ReactNode; onClose?: () => void; eyebrow?: React.ReactNode; back?: Back; compact?: boolean }) {
  return (
    <div className={'sheet-head' + (back ? ' has-back' : '') + (compact ? ' compact' : '') + (title ? '' : ' bare')}>
      {back && <BackPill label={back.label} onClick={back.onClick} />}
      {title && (
        <div className="sh-title">
          {eyebrow && !compact && <div className="kicker">{eyebrow}</div>}
          {compact ? <span className="sh-mini">{title}</span> : <h2>{title}</h2>}
        </div>
      )}
      {onClose && <button className="icon-btn sh-close" onClick={onClose} aria-label="Close"><Icon name="close" size={20} /></button>}
    </div>
  );
}
