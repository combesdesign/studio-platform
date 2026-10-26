/**
 * The demo platform's database: every studio's demo state in one localStorage key, plus the per-app sign-in.
 * Shared by the demo PlatformStore and every studio-bound demo DataStore created from it, so a booking made
 * in one tab shows up in another, and switching studios keeps you signed in as the same person.
 *
 * Keys: STATE_KEY (all studios), REV_KEY (cheap cross-tab sync), AUTH_KEYS[app] (who is signed in, per app).
 */
import type { ID, Studio } from '../../shared/types';
import { setStudioFormat, withStudioFormat } from '../../shared/format';
import { Engine, type DemoState } from './engine';
import { seedState, PERSONA_EMAILS } from './seed';
import { seedHarbour } from './harbour';
import { seedFeatures } from './features';
import { BUILTIN_STUDIOS, DEMO_PLATFORM_ADMINS, HARBOUR_ID, SNOWY_ID, SNOWY_STUDIO } from '../studios';
import { DEFAULT_BILLING_SETTINGS, DRAFT_PLANS, planOf } from '../../shared/plans';
import type { Plan, PlatformBillingSettings } from '../../shared/types';

/** Bumped for the platform (v3 was one studio; v4 holds every studio). */
export const STATE_KEY = 'spc-demo-v4';
export const REV_KEY = 'spc-demo-v4:rev';
export const AUTH_KEYS = { client: 'spc-demo-auth-client', studio: 'spc-demo-auth-studio', admin: 'spc-demo-auth-admin' } as const;
export type DemoApp = keyof typeof AUTH_KEYS;
export const PLATFORM_STATE_VERSION = 1;

export interface PlatformDemoState {
  platformVersion: number;
  seededAt: string;
  studios: Studio[];
  /** Each studio's own demo data, by studio id. */
  data: Record<ID, DemoState>;
  platformAdmins: { email: string; name: string }[];
  /** Fake Stripe Connect: studios whose owner has run the demo "Connect Stripe" flow. Missing in older saved demos = none. */
  connected?: Record<ID, boolean>;
  /** Platform plans (edited in the admin). Missing in older saved demos: ensureBilling seeds them. */
  plans?: Plan[];
  billingSettings?: PlatformBillingSettings;
  /** Fake Stripe subscriptions: studios that subscribed through the demo checkout (so there is a billing portal to "open"). */
  subscribed?: Record<ID, boolean>;
}

const DAY = 86_400_000;
/** Plans + billing for a platform state: Snowy on Signature (comped), Harbour on a Studio trial, anyone else on the first plan's trial. Safe to repeat. */
export function ensureBilling(ps: PlatformDemoState, now: Date, sample = true): void {
  ps.plans ??= clone(DRAFT_PLANS);
  ps.billingSettings ??= { ...DEFAULT_BILLING_SETTINGS };
  const first = [...ps.plans].filter((p) => p.active).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  for (const s of ps.studios) {
    if (s.billingStatus === undefined && s.planId === undefined) {
      if (!sample) Object.assign(s, { planId: 'plan_signature', billingStatus: 'active', billingComped: true });   // tests: every feature on
      else if (s.id === SNOWY_ID) Object.assign(s, { planId: 'plan_signature', billingStatus: 'active', billingComped: true });
      else if (first) Object.assign(s, { planId: s.id === HARBOUR_ID ? 'plan_studio' : first.id, billingStatus: 'trialing', trialEndsAt: new Date(now.getTime() + (s.id === HARBOUR_ID ? 11 : ps.billingSettings.trialDays) * DAY).toISOString() });
    }
  }
  resolvePlans(ps);
}
/** Keep every studio's `plan` (name + feature keys) in line with the plans table. */
export function resolvePlans(ps: PlatformDemoState): void {
  for (const s of ps.studios) {
    const p = s.planId ? ps.plans?.find((x) => x.id === s.planId) : undefined;
    if (p) s.plan = planOf(p); else delete s.plan;
  }
}

/** What's kept under the app's auth key: the person, plus the studio record they signed in as (if any). */
export interface StoredAuth {
  email: string;
  name: string;
  studioId?: ID;
  user?: import('../../shared/types').AuthUser;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

function defaultStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return memoryStorage();
    ls.setItem('spc-demo-probe', '1');
    ls.removeItem('spc-demo-probe');
    return ls;
  } catch {
    return memoryStorage();
  }
}

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
const fmtOf = (s: Studio) => ({ timezone: s.timezone, locale: s.locale, currency: s.currency, taxRate: s.taxRate });

/** Seed every built-in studio (Snowy exactly as before, plus Harbour) and Pete as platform admin. */
export function seedPlatform(now: Date, sample = true): PlatformDemoState {
  const studios = clone(BUILTIN_STUDIOS);
  const data: Record<ID, DemoState> = {};
  for (const s of studios) {
    data[s.id] = withStudioFormat(fmtOf(s), () => {
      const st = s.id === SNOWY_ID ? seedState(now) : seedHarbour(now);
      if (s.id === SNOWY_ID) {
        st.personas = [PERSONA_EMAILS.newClient, PERSONA_EMAILS.member, PERSONA_EMAILS.pack, PERSONA_EMAILS.intro, PERSONA_EMAILS.family];
        st.personaHints = {
          [PERSONA_EMAILS.newClient]: 'Brand new – no waiver or passes yet', [PERSONA_EMAILS.member]: 'Member · 2 classes a week',
          [PERSONA_EMAILS.pack]: '4 class pack · 1 credit left', [PERSONA_EMAILS.intro]: 'On the intro offer', [PERSONA_EMAILS.family]: 'Parent · baby Poppy in Mums + Bubs',
        };
      }
      seedFeatures(s, st, now);
      return st;
    });
  }
  const ps: PlatformDemoState = { platformVersion: PLATFORM_STATE_VERSION, seededAt: now.toISOString(), studios, data, platformAdmins: clone(DEMO_PLATFORM_ADMINS) };
  ensureBilling(ps, now, sample);
  return ps;
}

/** Accept a whole platform state, or (tests, older callers) one studio's state, which becomes Snowy's. */
export function toPlatformState(x: PlatformDemoState | DemoState, now: Date, sample = true): PlatformDemoState {
  if ((x as PlatformDemoState).studios) { ensureBilling(x as PlatformDemoState, now, sample); return x as PlatformDemoState; }
  const st = x as DemoState;
  const snowy: Studio = { ...clone(SNOWY_STUDIO), name: st.settings.name || SNOWY_STUDIO.name, timezone: st.settings.timezone || SNOWY_STUDIO.timezone };
  const ps: PlatformDemoState = { platformVersion: PLATFORM_STATE_VERSION, seededAt: now.toISOString(), studios: [snowy], data: { [snowy.id]: st }, platformAdmins: clone(DEMO_PLATFORM_ADMINS) };
  ensureBilling(ps, now, sample);
  return ps;
}

export interface DemoDbOptions {
  now?: () => Date;
  storage?: StorageLike;
  latencyMs?: number;
  app?: DemoApp;
  initialState?: PlatformDemoState | DemoState;
  /** Seed the sample billing (Snowy on Signature, Harbour on a Studio trial). False (tests that need every feature) puts every studio on Signature. Default true. */
  sampleBilling?: boolean;
}

export class DemoDb {
  readonly storage: StorageLike;
  readonly now: () => Date;
  readonly latency: () => number;
  readonly app: DemoApp;
  readonly authKey: string;
  private persistent = true;
  private sample = true;
  private listeners = new Set<() => void>();
  private engines = new Map<ID, Engine>();
  private rev = '';
  private memAuth: string | null = null;
  ps!: PlatformDemoState;

  constructor(opts: DemoDbOptions = {}) {
    this.sample = opts.sampleBilling !== false;
    this.storage = opts.storage ?? defaultStorage();
    this.now = opts.now ?? (() => new Date());
    this.latency = opts.latencyMs !== undefined ? () => opts.latencyMs as number : () => 80 + Math.random() * 70;
    this.app = opts.app ?? (typeof location !== 'undefined' && location.pathname.includes('/admin') ? 'admin'
      : typeof location !== 'undefined' && location.pathname.includes('/studio') ? 'studio' : 'client');
    this.authKey = AUTH_KEYS[this.app];
    this.memAuth = this.get(this.authKey);
    if (opts.initialState) { this.ps = clone(toPlatformState(opts.initialState, this.now(), this.sample)); this.engines.clear(); this.save(); }
    else this.load();
    if (!opts.storage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key === REV_KEY || e.key === STATE_KEY || e.key === null) { this.rev = '__stale__'; this.sync(); this.emit(); }
        else if (e.key === this.authKey) { this.memAuth = this.get(this.authKey); this.emit(); }
      });
    }
  }

  // ---------------------------------------------------------------- storage
  get(key: string): string | null {
    try { return this.storage.getItem(key); } catch { return null; }
  }
  private set(key: string, v: string): void {
    if (!this.persistent) return;
    try { this.storage.setItem(key, v); } catch { this.persistent = false; }
  }
  load(): void {
    const raw = this.get(STATE_KEY);
    let s: PlatformDemoState | undefined;
    if (raw) {
      try { const p = JSON.parse(raw) as PlatformDemoState; if (p?.platformVersion === PLATFORM_STATE_VERSION && Array.isArray(p.studios) && p.data) { s = p; ensureBilling(s, this.now(), this.sample); } } catch { /* reseed */ }
    }
    this.engines.clear();
    if (s) { this.ps = s; this.rev = this.get(REV_KEY) ?? ''; }
    else { this.ps = this.withFirstStudioFormat(() => seedPlatform(this.now(), this.sample)); this.save(); }
  }
  private withFirstStudioFormat<T>(fn: () => T): T {
    const f = BUILTIN_STUDIOS[0]!;
    return withStudioFormat(fmtOf(f), fn);
  }
  save(): void {
    this.rev = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.set(STATE_KEY, JSON.stringify(this.ps));
    this.set(REV_KEY, this.rev);
  }
  sync(): void {
    if (!this.persistent) return;
    const r = this.get(REV_KEY);
    if (r !== null && r !== this.rev) this.load();
  }
  reseed(): void {
    this.ps = seedPlatform(this.now(), this.sample);
    this.engines.clear();
    this.save();
  }

  // ---------------------------------------------------------------- subscribers + latency
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  emit(): void { for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error(e); } } }
  emitSoon(): void { setTimeout(() => this.emit(), 0); }
  async delay(): Promise<void> {
    const ms = this.latency();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  // ---------------------------------------------------------------- studios
  studio(id: ID): Studio | undefined { return this.ps.studios.find((s) => s.id === id); }
  state(id: ID): DemoState {
    const st = this.ps.data[id];
    if (!st) throw new Error(`No demo data for studio ${id}`);
    return st;
  }
  /** The booking engine for one studio (rebuilt when that studio's state object is replaced). */
  engine(id: ID): Engine {
    const st = this.state(id);
    let e = this.engines.get(id);
    if (!e || e.s !== st) { e = new Engine(st, this.now); this.engines.set(id, e); }
    return e;
  }
  /** Put back a studio's state (rollback after a failed write). */
  replaceState(id: ID, st: DemoState): void { this.ps.data[id] = st; this.engines.delete(id); }
  /** Format (timezone, currency…) of a studio, for withStudioFormat. */
  formatOf(id: ID) { const s = this.studio(id); return s ? fmtOf(s) : undefined; }
  useFormat(id: ID): void { const f = this.formatOf(id); if (f) setStudioFormat(f); }

  // ---------------------------------------------------------------- auth (per app, shared by every studio)
  readAuth(): StoredAuth | null {
    const raw = this.memAuth;
    if (!raw) return null;
    try {
      const a = JSON.parse(raw) as StoredAuth & { kind?: string; clientId?: string; staffId?: string };
      // v3 stored a bare AuthUser
      if (a && a.kind && !a.user) return { email: a.email ?? '', name: (a as { name?: string }).name ?? '', studioId: SNOWY_ID, user: a as unknown as StoredAuth['user'] };
      return a;
    } catch { return null; }
  }
  writeAuth(a: StoredAuth | null): void {
    const v = a ? JSON.stringify(a) : null;
    this.memAuth = v;
    try { if (v) this.storage.setItem(this.authKey, v); else this.storage.removeItem(this.authKey); } catch { /* memory only */ }
  }

  /** Everyone with this email anywhere on the platform (for person-level sign-in). */
  personByEmail(email: string): { email: string; name: string } | null {
    const e = email.trim().toLowerCase();
    if (!e) return null;
    const admin = this.ps.platformAdmins.find((a) => a.email.toLowerCase() === e);
    if (admin) return { email: admin.email, name: admin.name };
    for (const st of Object.values(this.ps.data)) {
      const s = st.staff.find((x) => x.active && x.email.toLowerCase() === e);
      if (s) return { email: s.email, name: s.name };
      const c = st.clients.find((x) => !x.archived && x.email.toLowerCase() === e);
      if (c) return { email: c.email, name: `${c.firstName} ${c.lastName}`.trim() };
    }
    return null;
  }
  isPlatformAdmin(email?: string | null): boolean {
    const e = (email ?? '').trim().toLowerCase();
    return !!e && this.ps.platformAdmins.some((a) => a.email.toLowerCase() === e);
  }
}
