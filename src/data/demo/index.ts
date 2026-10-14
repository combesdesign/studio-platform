/**
 * Demo DataStore: the whole studio in localStorage, seeded with realistic fake data.
 * - One versioned key (STATE_KEY) + a revision key for cheap cross-tab sync.
 * - Auth lives in a separate key per app (client app at /, studio app at /studio/).
 * - Permissions follow RULES.md › Staff permissions (see src/domain/permissions.ts).
 * - Business rules live in src/domain; operations in ./engine.ts.
 */
import { StoreError } from '../../shared/store';
import type {
  BookingWithDetails, CreditSummary, DataStore, PurchaseResult, RosterEntry, Unsubscribe,
} from '../../shared/store';
import type {
  AuthUser, Booking, BookingStatus, ClassSession, ClassType, Client, HealthForm, ID, ISODate, ISODateTime, Pass, PaymentMethod,
  Product, ReportRange, Sale, ScheduleTemplate, SessionWithCounts, Staff, StudioReport, StudioSettings,
} from '../../shared/types';
import { dayShort, studioToUTC } from '../../shared/format';
import {
  FINANCIAL_SETTINGS_KEYS, buildReport, can, clientsCsv, comparePassPriority, computePassStatus, creditLabel, isIntroEligible,
  isPassCurrent, remainingCredits, rosterFlags, salesCsv, studioDay, type StaffAction,
} from '../../domain';
import { Engine, STATE_VERSION, type Actor, type DemoState } from './engine';
import { PERSONA_EMAILS, seedState } from './seed';

export const STATE_KEY = 'spc-demo-v3';
export const REV_KEY = 'spc-demo-v3:rev';
export const AUTH_KEYS = { client: 'spc-demo-auth-client', studio: 'spc-demo-auth-studio' } as const;
export { PERSONA_EMAILS };

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface DemoStoreOptions {
  /** Injectable clock (tests). Default: real time. */
  now?: () => Date;
  /** Where state + auth are kept. Default: localStorage, falling back to memory. */
  storage?: StorageLike;
  /** Simulated latency per call. Default: random 80–150ms. 0 = none. */
  latencyMs?: number;
  /** Which app's auth key to use. Default: from location.pathname ('/studio' → studio). */
  app?: 'client' | 'studio';
  /** Use this state instead of seeding (tests). */
  initialState?: DemoState;
}

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
const err = (code: string, msg: string) => new StoreError(code, msg);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createDemoStore(opts: DemoStoreOptions = {}): DataStore {
  return new DemoStore(opts);
}

class DemoStore implements DataStore {
  readonly mode = 'demo' as const;
  private storage: StorageLike;
  private persistent = true;
  private now: () => Date;
  private latency: () => number;
  private authKey: string;
  private listeners = new Set<() => void>();
  private state!: DemoState;
  private engine!: Engine;
  private rev = '';
  private memAuth: string | null = null;

  constructor(opts: DemoStoreOptions) {
    this.storage = opts.storage ?? defaultStorage();
    this.now = opts.now ?? (() => new Date());
    this.latency = opts.latencyMs !== undefined ? () => opts.latencyMs as number : () => 80 + Math.random() * 70;
    const app = opts.app ?? (typeof location !== 'undefined' && location.pathname.includes('/studio') ? 'studio' : 'client');
    this.authKey = AUTH_KEYS[app];
    this.memAuth = this.get(this.authKey);
    if (opts.initialState) { this.setState(clone(opts.initialState)); this.save(); }
    else this.load();
    if (!opts.storage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key === REV_KEY || e.key === STATE_KEY || e.key === null) { this.rev = '__stale__'; this.sync(); this.emit(); }
        else if (e.key === this.authKey) { this.memAuth = this.get(this.authKey); this.emit(); }
      });
    }
  }

  // ---------------------------------------------------------------- persistence
  private setState(s: DemoState): void {
    this.state = s;
    this.engine = new Engine(s, this.now);
  }
  private get(key: string): string | null {
    try { return this.storage.getItem(key); } catch { return null; }
  }
  private set(key: string, v: string): void {
    if (!this.persistent) return;
    try { this.storage.setItem(key, v); } catch { this.persistent = false; }
  }
  private load(): void {
    const raw = this.get(STATE_KEY);
    let s: DemoState | undefined;
    if (raw) {
      try { const parsed = JSON.parse(raw) as DemoState; if (parsed?.version === STATE_VERSION && Array.isArray(parsed.sessions)) s = parsed; } catch { /* reseed */ }
    }
    if (s) { this.setState(s); this.rev = this.get(REV_KEY) ?? ''; }
    else { this.setState(seedState(this.now())); this.save(); }
  }
  private save(): void {
    this.rev = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.set(STATE_KEY, JSON.stringify(this.state));
    this.set(REV_KEY, this.rev);
  }
  private sync(): void {
    if (!this.persistent) return;
    const r = this.get(REV_KEY);
    if (r !== null && r !== this.rev) this.load();
  }
  private emit(): void {
    for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error(e); } }
  }
  private emitSoon(): void { setTimeout(() => this.emit(), 0); }
  private async delay(): Promise<void> {
    const ms = this.latency();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }
  /** Sync from other tabs and apply lazy time-based updates. */
  private prepare(): void {
    this.sync();
    if (this.engine.housekeeping()) { this.save(); this.emitSoon(); }
  }
  private async read<T>(fn: () => T): Promise<T> {
    await this.delay();
    this.prepare();
    return clone(fn());
  }
  private async write<T>(fn: () => T): Promise<T> {
    await this.delay();
    this.prepare();
    const snap = JSON.stringify(this.state);
    let out: T;
    try {
      out = fn();
    } catch (e) {
      this.setState(JSON.parse(snap) as DemoState);
      throw e;
    }
    this.save();
    const result = clone(out);
    this.emit();
    return result;
  }

  // ---------------------------------------------------------------- auth helpers
  private readAuth(): AuthUser | null {
    const raw = this.memAuth;
    if (!raw) return null;
    try { return this.freshUser(JSON.parse(raw) as AuthUser); } catch { return null; }
  }
  private writeAuth(u: AuthUser | null): void {
    const v = u ? JSON.stringify(u) : null;
    this.memAuth = v;
    try { if (v) this.storage.setItem(this.authKey, v); else this.storage.removeItem(this.authKey); } catch { /* memory only */ }
  }
  /** Re-derive a user from current state (null if gone/archived/inactive). */
  private freshUser(u: AuthUser): AuthUser | null {
    if (u.kind === 'staff') {
      const st = this.state.staff.find((s) => s.id === u.staffId && s.active);
      return st ? { kind: 'staff', staffId: st.id, email: st.email, name: st.name, role: st.role } : null;
    }
    const c = this.engine.findClient(u.clientId);
    return c && !c.archived ? { kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}`.trim() } : null;
  }
  private me(): AuthUser {
    const u = this.readAuth();
    if (!u) throw err('AUTH_REQUIRED', 'Please sign in first.');
    return u;
  }
  private staffMe(): Staff {
    const u = this.me();
    if (u.kind !== 'staff') throw err('NOT_ALLOWED', 'Only studio staff can do that.');
    const st = this.state.staff.find((s) => s.id === u.staffId);
    if (!st) throw err('AUTH_REQUIRED', 'Please sign in first.');
    return st;
  }
  private requireStaff(action: StaffAction): Staff {
    const st = this.staffMe();
    if (!can(st.role, action)) throw err('NOT_ALLOWED', "Your role doesn't have access to that.");
    return st;
  }
  /** Client acting on their own data, or staff with `action`. */
  private requireSelfOrStaff(clientId: ID, action: StaffAction = 'clients_view'): AuthUser {
    const u = this.me();
    if (u.kind === 'client') {
      if (u.clientId !== clientId) throw err('NOT_ALLOWED', 'You can only see your own account.');
      return u;
    }
    this.requireStaff(action);
    return u;
  }
  private canRoster(st: Staff, sessionId: ID): boolean {
    if (can(st.role, 'roster_all')) return true;
    return can(st.role, 'roster_own') && this.engine.session(sessionId).instructorId === st.id;
  }
  private requireRoster(sessionId: ID): Staff {
    const st = this.staffMe();
    if (!this.canRoster(st, sessionId)) throw err('NOT_ALLOWED', 'You can only manage rosters for classes you teach.');
    return st;
  }
  private actor(u: AuthUser): Actor {
    return u.kind === 'staff' ? { kind: 'staff', staffId: u.staffId } : { kind: 'client', clientId: u.clientId };
  }
  private viewerStaff(): Staff | undefined {
    const u = this.readAuth();
    return u?.kind === 'staff' ? this.state.staff.find((s) => s.id === u.staffId) : undefined;
  }
  private redactClient(c: Client): Client {
    const st = this.viewerStaff();
    if (st && can(st.role, 'client_staff_notes')) return c;
    const { staffNotes: _omit, ...rest } = c;
    return rest;
  }
  private redactStaff(s: Staff, viewer: Staff | undefined): Staff {
    const out: Staff = { ...s };
    if (!viewer) { out.email = ''; delete out.phone; delete out.payPerClassCents; }
    else if (!can(viewer.role, 'reports_pay')) delete out.payPerClassCents;
    return out;
  }
  private emailTaken(email: string, exceptClientId?: ID, exceptStaffId?: ID): boolean {
    const e = email.trim().toLowerCase();
    if (!e) return false;
    return this.state.clients.some((c) => c.id !== exceptClientId && c.email.toLowerCase() === e)
      || this.state.staff.some((s) => s.id !== exceptStaffId && s.email.toLowerCase() === e);
  }

  // ---------------------------------------------------------------- subscribe
  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ---------------------------------------------------------------- auth
  async currentUser(): Promise<AuthUser | null> {
    return this.read(() => this.readAuth());
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    return this.write(() => {
      const e = (email ?? '').trim().toLowerCase();
      if (!e || !password) throw err('INVALID_LOGIN', 'Enter your email and password.');
      const st = this.state.staff.find((s) => s.active && s.email.toLowerCase() === e);
      const c = this.state.clients.find((x) => !x.archived && x.email.toLowerCase() === e);
      const studio = this.authKey === AUTH_KEYS.studio;
      let u: AuthUser | null = null;
      if (studio && st) u = { kind: 'staff', staffId: st.id, email: st.email, name: st.name, role: st.role };
      else if (!studio && c) u = { kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}`.trim() };
      else if (studio && c) throw err('NOT_ALLOWED', 'This sign-in is for studio staff. Clients can use the Snowy Pilates Club app.');
      else if (!studio && st) throw err('NOT_ALLOWED', 'Staff accounts sign in to the studio app.');
      if (!u) throw err('INVALID_LOGIN', "We couldn't find an account with that email.");
      this.writeAuth(u);
      return u;
    });
  }

  async signUpClient(input: { firstName: string; lastName: string; email: string; phone?: string; password: string; marketingOptIn?: boolean }): Promise<AuthUser> {
    return this.write(() => {
      const firstName = input.firstName?.trim(), lastName = input.lastName?.trim() ?? '', email = input.email?.trim().toLowerCase();
      if (!firstName) throw err('INVALID', 'Please enter your first name.');
      if (!email || !EMAIL_RE.test(email)) throw err('INVALID', 'Please enter a valid email address.');
      if (!input.password || input.password.length < 6) throw err('INVALID', 'Your password needs at least 6 characters.');
      if (this.emailTaken(email)) throw err('EMAIL_TAKEN', 'There is already an account with that email. Try signing in.');
      const c: Client = {
        id: this.engine.newId('cl'), firstName, lastName, email, createdAt: this.now().toISOString(),
        marketingOptIn: !!input.marketingOptIn, source: 'app', ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
      };
      this.engine.addClient(c);
      const u: AuthUser = { kind: 'client', clientId: c.id, email, name: `${firstName} ${lastName}`.trim() };
      this.writeAuth(u);
      return u;
    });
  }

  async signOut(): Promise<void> {
    await this.delay();
    this.writeAuth(null);
    this.emit();
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.delay();
    if (!EMAIL_RE.test((email ?? '').trim())) throw err('INVALID', 'Please enter a valid email address.');
  }

  async demoPersonas(): Promise<AuthUser[]> {
    return this.read(() => {
      const out: AuthUser[] = [];
      for (const email of [PERSONA_EMAILS.newClient, PERSONA_EMAILS.member, PERSONA_EMAILS.pack, PERSONA_EMAILS.intro]) {
        const c = this.state.clients.find((x) => x.email === email && !x.archived);
        if (c) out.push({ kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}` });
      }
      for (const s of this.state.staff) if (s.active) out.push({ kind: 'staff', staffId: s.id, email: s.email, name: s.name, role: s.role });
      return out;
    });
  }

  async demoSignInAs(user: AuthUser): Promise<AuthUser> {
    return this.write(() => {
      const u = this.freshUser(user);
      if (!u) throw err('NOT_FOUND', 'That demo account no longer exists. Try resetting the demo.');
      this.writeAuth(u);
      return u;
    });
  }

  async demoReset(): Promise<void> {
    await this.delay();
    this.setState(seedState(this.now()));
    this.save();
    if (!this.readAuth()) this.writeAuth(null);
    this.emit();
  }

  // ---------------------------------------------------------------- settings
  async getSettings(): Promise<StudioSettings> {
    return this.read(() => this.state.settings);
  }

  async updateSettings(patch: Partial<StudioSettings>): Promise<StudioSettings> {
    return this.write(() => {
      const st = this.requireStaff('settings');
      const touchesFinancial = FINANCIAL_SETTINGS_KEYS.some((k) => k in patch && patch[k] !== this.state.settings[k]);
      if (touchesFinancial && !can(st.role, 'settings_financial')) throw err('NOT_ALLOWED', 'Only the owner can change the ABN and GST settings.');
      for (const k of ['cancelWindowHours', 'waitlistCutoffHours', 'lateCancelFeeCents', 'noShowFeeCents', 'bookingWindowDays', 'defaultCapacity'] as const) {
        const v = patch[k];
        if (v !== undefined && !(typeof v === 'number' && v >= 0 && Number.isFinite(v))) throw err('INVALID', `${k} must be zero or more.`);
      }
      Object.assign(this.state.settings, patch);
      return this.state.settings;
    });
  }

  // ---------------------------------------------------------------- staff
  async listStaff(opts: { includeInactive?: boolean } = {}): Promise<Staff[]> {
    return this.read(() => {
      const viewer = this.viewerStaff();
      const order = { owner: 0, manager: 1, front_desk: 2, instructor: 3 } as const;
      return this.state.staff.filter((s) => opts.includeInactive || s.active)
        .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name))
        .map((s) => this.redactStaff(s, viewer));
    });
  }

  async upsertStaff(input: Omit<Staff, 'id'> & { id?: ID }): Promise<Staff> {
    return this.write(() => {
      const me = this.requireStaff('staff');
      if (!input.name?.trim()) throw err('INVALID', 'Please enter a name.');
      if (!input.email || !EMAIL_RE.test(input.email.trim())) throw err('INVALID', 'Please enter a valid email address.');
      const existing = input.id ? this.state.staff.find((s) => s.id === input.id) : undefined;
      if (this.emailTaken(input.email, undefined, existing?.id)) throw err('EMAIL_TAKEN', 'That email is already in use.');
      const payChanged = 'payPerClassCents' in input && (input.payPerClassCents ?? undefined) !== (existing?.payPerClassCents ?? undefined);
      if (payChanged && !can(me.role, 'staff_pay')) throw err('NOT_ALLOWED', 'Only the owner can change pay rates.');
      const ownerChange = (input.role === 'owner') !== (existing?.role === 'owner');
      if (ownerChange && me.role !== 'owner') throw err('NOT_ALLOWED', 'Only the owner can change owner access.');
      let out: Staff;
      if (existing) {
        const keepPay = existing.payPerClassCents;
        Object.assign(existing, input, { email: input.email.trim() });
        if (!('payPerClassCents' in input) && keepPay !== undefined) existing.payPerClassCents = keepPay;
        out = existing;
      } else {
        out = { ...input, email: input.email.trim(), id: this.engine.newId('st') };
        this.state.staff.push(out);
      }
      if (!this.state.staff.some((s) => s.role === 'owner' && s.active)) throw err('INVALID', 'The studio needs at least one active owner.');
      return out;
    });
  }

  // ---------------------------------------------------------------- class types & schedule
  async listClassTypes(opts: { includeInactive?: boolean } = {}): Promise<ClassType[]> {
    return this.read(() => this.state.classTypes.filter((c) => opts.includeInactive || c.active));
  }

  async upsertClassType(input: Omit<ClassType, 'id'> & { id?: ID }): Promise<ClassType> {
    return this.write(() => {
      this.requireStaff('schedule');
      if (!input.name?.trim()) throw err('INVALID', 'Please enter a name.');
      if (!(input.durationMin > 0)) throw err('INVALID', 'Duration must be more than 0 minutes.');
      const existing = input.id ? this.state.classTypes.find((c) => c.id === input.id) : undefined;
      if (existing) { Object.assign(existing, input); return existing; }
      const ct: ClassType = { ...input, id: this.engine.newId('ct') };
      this.state.classTypes.push(ct);
      return ct;
    });
  }

  async listTemplates(): Promise<ScheduleTemplate[]> {
    return this.read(() => [...this.state.templates].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.startTime.localeCompare(b.startTime)));
  }

  async upsertTemplate(input: Omit<ScheduleTemplate, 'id'> & { id?: ID }): Promise<ScheduleTemplate> {
    return this.write(() => {
      this.requireStaff('schedule');
      if (!(Number.isInteger(input.weekday) && input.weekday >= 0 && input.weekday <= 6)) throw err('INVALID', 'Choose a day of the week.');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) throw err('INVALID', 'Start time must be HH:mm.');
      if (!DATE_RE.test(input.startsOn) || (input.endsOn && !DATE_RE.test(input.endsOn))) throw err('INVALID', 'Dates must be YYYY-MM-DD.');
      this.engine.classType(input.classTypeId);
      if (!this.state.staff.some((s) => s.id === input.instructorId)) throw err('NOT_FOUND', 'That instructor could not be found.');
      const existing = input.id ? this.state.templates.find((t) => t.id === input.id) : undefined;
      let out: ScheduleTemplate;
      if (existing) { Object.assign(existing, input); out = existing; }
      else { out = { ...input, id: input.id ?? this.engine.newId('tp') }; this.state.templates.push(out); }
      this.engine.dropFutureTemplateSessions(out.id);
      return out;
    });
  }

  async deleteTemplate(id: ID): Promise<void> {
    return this.write(() => {
      this.requireStaff('schedule');
      if (!this.state.templates.some((t) => t.id === id)) throw err('NOT_FOUND', 'That timetable slot could not be found.');
      this.engine.dropFutureTemplateSessions(id);
      this.state.templates = this.state.templates.filter((t) => t.id !== id);
    });
  }

  async generateSessions(from: ISODate, to: ISODate): Promise<number> {
    return this.write(() => this.engine.generate(from, to));
  }

  async listSessions(range: { from: ISODateTime; to: ISODateTime; includeCancelled?: boolean }): Promise<SessionWithCounts[]> {
    await this.delay();
    this.prepare();
    const from = Date.parse(range.from), to = Date.parse(range.to);
    if (Number.isNaN(from) || Number.isNaN(to)) throw err('INVALID', 'Invalid date range.');
    if (this.engine.generate(studioDay(range.from), studioDay(range.to)) > 0) this.save();
    const counts = this.engine.allCounts();
    return clone(this.state.sessions
      .filter((s) => Date.parse(s.startsAt) < to && Date.parse(s.endsAt) > from && (range.includeCancelled !== false || s.status !== 'cancelled'))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((s) => this.engine.withCounts(s, counts)));
  }

  async getSession(id: ID): Promise<SessionWithCounts> {
    return this.read(() => this.engine.withCounts(this.engine.session(id)));
  }

  async upsertSession(s: Omit<ClassSession, 'id' | 'status'> & { id?: ID; status?: ClassSession['status'] }): Promise<SessionWithCounts> {
    return this.write(() => {
      const st = this.requireStaff('schedule');
      return this.engine.upsertSession(s, { kind: 'staff', staffId: st.id });
    });
  }

  async cancelSession(id: ID, reason: string): Promise<void> {
    return this.write(() => {
      this.requireStaff('schedule');
      const s = this.engine.session(id);
      if (s.status === 'cancelled') return;
      this.engine.cancelSession(id, reason);
    });
  }

  // ---------------------------------------------------------------- bookings
  async bookClass(clientId: ID, sessionId: ID, opts: { passId?: ID; asStaff?: boolean; allowOverCapacity?: boolean; skipCredit?: boolean } = {}) {
    return this.write(() => {
      const u = this.me();
      this.engine.session(sessionId);
      if (u.kind === 'client') {
        if (u.clientId !== clientId) throw err('NOT_ALLOWED', 'You can only book for yourself.');
        if (opts.asStaff || opts.allowOverCapacity || opts.skipCredit) throw err('NOT_ALLOWED', 'Only studio staff can do that.');
      } else {
        this.requireRoster(sessionId);
      }
      return this.engine.book(clientId, sessionId, {
        by: this.actor(u), ...(opts.passId ? { passId: opts.passId } : {}),
        allowOverCapacity: !!opts.allowOverCapacity, skipCredit: !!opts.skipCredit,
      });
    });
  }

  async cancelBooking(bookingId: ID, opts: { asStaff?: boolean; waivePenalty?: boolean } = {}) {
    return this.write(() => {
      const u = this.me();
      const b = this.engine.booking(bookingId);
      if (u.kind === 'client') {
        if (b.clientId !== u.clientId) throw err('NOT_ALLOWED', 'You can only cancel your own bookings.');
        if (opts.waivePenalty || opts.asStaff) throw err('NOT_ALLOWED', 'Only studio staff can waive the cancellation policy.');
      } else this.requireRoster(b.sessionId);
      return this.engine.cancel(bookingId, { by: this.actor(u), waive: !!opts.waivePenalty });
    });
  }

  async leaveWaitlist(bookingId: ID): Promise<void> {
    return this.write(() => {
      const u = this.me();
      const b = this.engine.booking(bookingId);
      if (u.kind === 'client') { if (b.clientId !== u.clientId) throw err('NOT_ALLOWED', 'You can only change your own bookings.'); }
      else this.requireRoster(b.sessionId);
      this.engine.leaveWaitlist(bookingId);
    });
  }

  async checkIn(bookingId: ID): Promise<Booking> {
    return this.write(() => { this.requireRoster(this.engine.booking(bookingId).sessionId); return this.engine.checkIn(bookingId); });
  }
  async undoCheckIn(bookingId: ID): Promise<Booking> {
    return this.write(() => { this.requireRoster(this.engine.booking(bookingId).sessionId); return this.engine.undoCheckIn(bookingId); });
  }
  async markNoShow(bookingId: ID): Promise<Booking> {
    return this.write(() => { this.requireRoster(this.engine.booking(bookingId).sessionId); return this.engine.markNoShow(bookingId); });
  }

  async moveBooking(bookingId: ID, toSessionId: ID) {
    return this.write(() => {
      const st = this.requireRoster(this.engine.booking(bookingId).sessionId);
      if (!this.canRoster(st, toSessionId)) throw err('NOT_ALLOWED', 'You can only manage rosters for classes you teach.');
      return this.engine.move(bookingId, toSessionId, { kind: 'staff', staffId: st.id });
    });
  }

  async getRoster(sessionId: ID): Promise<RosterEntry[]> {
    return this.read(() => {
      this.requireRoster(sessionId);
      const s = this.engine.session(sessionId);
      const date = studioDay(s.startsAt);
      const startT = Date.parse(s.startsAt);
      const rank: Partial<Record<BookingStatus, number>> = { booked: 0, checked_in: 0, no_show: 1, late_cancelled: 2, waitlisted: 3 };
      const entries = this.engine.sessionBookings(sessionId).filter((b) => rank[b.status] !== undefined);
      const out = entries.map((b): RosterEntry & { _name: string } => {
        const client = this.engine.client(b.clientId);
        const pass = b.passId ? this.engine.findPass(b.passId) : undefined;
        const priorCheckIns = this.state.bookings.filter((x) => x.clientId === b.clientId && x.status === 'checked_in' && x.sessionId !== sessionId
          && Date.parse(this.engine.findSession(x.sessionId)?.startsAt ?? s.startsAt) < startT).length;
        const passRemaining = pass ? remainingCredits(pass, this.engine.passUses(pass.id), date) : null;
        const flags = rosterFlags({ client, booking: b, session: s, ...(pass ? { pass } : {}), passRemaining, priorCheckIns });
        return { ...b, client: this.redactClient(client), ...(pass ? { pass } : {}), flags, _name: `${client.firstName} ${client.lastName}` };
      });
      out.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        || (a.status === 'waitlisted' ? (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0) : a._name.localeCompare(b._name)));
      return out.map(({ _name, ...e }) => e);
    });
  }

  async listClientBookings(clientId: ID, opts: { when?: 'upcoming' | 'past' | 'all'; statuses?: BookingStatus[] } = {}): Promise<BookingWithDetails[]> {
    return this.read(() => {
      this.requireSelfOrStaff(clientId);
      const when = opts.when ?? 'all';
      const t = this.now().getTime();
      const counts = this.engine.allCounts();
      const viewer = this.viewerStaff();
      const out: BookingWithDetails[] = [];
      for (const b of this.engine.clientBookings(clientId)) {
        if (opts.statuses && !opts.statuses.includes(b.status)) continue;
        const s = this.engine.findSession(b.sessionId);
        if (!s) continue;
        const st = Date.parse(s.startsAt);
        if (when === 'upcoming' && st < t) continue;
        if (when === 'past' && st >= t) continue;
        const instructor = this.state.staff.find((x) => x.id === s.instructorId);
        out.push({ ...b, session: this.engine.withCounts(s, counts), classType: this.engine.classType(s.classTypeId), ...(instructor ? { instructor: this.redactStaff(instructor, viewer) } : {}) });
      }
      out.sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
      if (when === 'past') out.reverse();
      return out;
    });
  }

  // ---------------------------------------------------------------- clients
  async listClients(opts: { search?: string; includeArchived?: boolean } = {}): Promise<Client[]> {
    return this.read(() => {
      this.requireStaff('clients_view');
      const terms = (opts.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      return this.state.clients
        .filter((c) => opts.includeArchived || !c.archived)
        .filter((c) => {
          if (!terms.length) return true;
          const hay = `${c.firstName} ${c.lastName} ${c.email} ${c.phone ?? ''} ${(c.phone ?? '').replace(/\D/g, '')}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
        .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName))
        .map((c) => this.redactClient(c));
    });
  }

  async getClient(id: ID): Promise<Client> {
    return this.read(() => {
      this.requireSelfOrStaff(id);
      return this.redactClient(this.engine.client(id));
    });
  }

  async upsertClient(input: Omit<Client, 'id' | 'createdAt'> & { id?: ID; createdAt?: ISODateTime }): Promise<Client> {
    return this.write(() => {
      const u = this.me();
      const existing = input.id ? this.engine.findClient(input.id) : undefined;
      const email = (input.email ?? '').trim().toLowerCase();
      if (!input.firstName?.trim()) throw err('INVALID', 'Please enter a first name.');
      if (email && !EMAIL_RE.test(email)) throw err('INVALID', 'Please enter a valid email address.');
      if (this.emailTaken(email, existing?.id)) throw err('EMAIL_TAKEN', 'Another client already uses that email.');
      if (u.kind === 'client') {
        if (!existing || existing.id !== u.clientId) throw err('NOT_ALLOWED', 'You can only edit your own details.');
        if (!email) throw err('INVALID', 'Please enter your email address.');
        const { staffNotes: _a, archived: _b, source: _c, waiverSignedAt: _d, healthForm: _e, createdAt: _f, id: _g, ...allowed } = input;
        Object.assign(existing, allowed, { email });
        return this.redactClient(existing);
      }
      const st = this.requireStaff('clients_edit');
      const patch: Partial<Client> = { ...input, email };
      if (!can(st.role, 'client_staff_notes')) delete patch.staffNotes;
      if (existing) {
        delete patch.createdAt;
        Object.assign(existing, patch);
        return existing;
      }
      const c: Client = {
        marketingOptIn: false, source: 'staff', ...patch, firstName: input.firstName.trim(), lastName: input.lastName ?? '', email,
        id: this.engine.newId('cl'), createdAt: input.createdAt ?? this.now().toISOString(),
      };
      this.engine.addClient(c);
      return c;
    });
  }

  async submitWaiver(clientId: ID, health: Omit<HealthForm, 'submittedAt'>): Promise<Client> {
    return this.write(() => {
      this.requireSelfOrStaff(clientId, 'waiver_record');
      const c = this.engine.client(clientId);
      const at = this.now().toISOString();
      c.waiverSignedAt = at;
      c.healthForm = { ...health, answers: { ...(health.answers ?? {}) }, submittedAt: at };
      if (health.injuries?.trim()) c.injuries = health.injuries.trim();
      return this.redactClient(c);
    });
  }

  // ---------------------------------------------------------------- products, passes, sales
  async listProducts(opts: { includeInactive?: boolean; kinds?: Product['kind'][] } = {}): Promise<Product[]> {
    return this.read(() => this.state.products
      .filter((p) => (opts.includeInactive || p.active) && (!opts.kinds || opts.kinds.includes(p.kind)))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));
  }

  async upsertProduct(input: Omit<Product, 'id'> & { id?: ID }): Promise<Product> {
    return this.write(() => {
      this.requireStaff('products');
      if (!input.name?.trim()) throw err('INVALID', 'Please enter a name.');
      if (!(input.priceCents >= 0)) throw err('INVALID', 'Price must be zero or more.');
      const existing = input.id ? this.state.products.find((p) => p.id === input.id) : undefined;
      if (existing) { Object.assign(existing, input); return existing; }
      const p: Product = { ...input, id: this.engine.newId('pr') };
      this.engine.addProduct(p);
      return p;
    });
  }

  async listPasses(clientId: ID, opts: { includeInactive?: boolean } = {}): Promise<Pass[]> {
    return this.read(() => {
      this.requireSelfOrStaff(clientId);
      const now = this.now();
      const all = this.engine.clientPasses(clientId);
      const current = all.filter((p) => isPassCurrent(p, now)).sort(comparePassPriority);
      if (!opts.includeInactive) return current;
      const rest = all.filter((p) => !current.includes(p)).sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
      return [...current, ...rest];
    });
  }

  async getCreditSummary(clientId: ID, forSessionId?: ID): Promise<CreditSummary[]> {
    return this.read(() => {
      this.requireSelfOrStaff(clientId);
      const now = this.now();
      const expiry = (p: Pass) => (p.kind === 'membership' && p.status === 'cancelled' ? p.nextBillingAt : p.expiresAt);
      const summary = (p: Pass, remaining: number | null, label: string): CreditSummary => {
        const e = expiry(p);
        return { pass: p, remaining, label, ...(e !== undefined ? { expiresAt: e } : {}) };
      };
      if (forSessionId) {
        const s = this.engine.session(forSessionId);
        return this.engine.eligiblePasses(clientId, s).map(({ pass, eligibility }) => summary(pass, eligibility.remaining, creditLabel(pass, eligibility.remaining)));
      }
      const today = studioDay(now);
      return this.engine.clientPasses(clientId).filter((p) => isPassCurrent(p, now)).sort(comparePassPriority).map((p) => {
        const remaining = remainingCredits(p, this.engine.passUses(p.id), today);
        const paused = computePassStatus(p, now) === 'paused' && p.pausedUntil;
        const label = paused ? `Paused until ${dayShort(studioToUTC(p.pausedUntil as string, '12:00'))}` : creditLabel(p, remaining);
        return summary(p, remaining, label);
      });
    });
  }

  async isIntroEligible(clientId: ID): Promise<boolean> {
    return this.read(() => {
      this.requireSelfOrStaff(clientId);
      return isIntroEligible(clientId, this.state.passes);
    });
  }

  private checkoutAs(input: { clientId?: ID; items: { productId: ID; qty: number }[]; method: PaymentMethod; staffId?: ID; discountCents?: number; note?: string }) {
    const u = this.me();
    if (u.kind === 'client') {
      const clientId = input.clientId ?? u.clientId;
      if (clientId !== u.clientId) throw err('NOT_ALLOWED', 'You can only buy for yourself.');
      if (input.method !== 'card_online') throw err('NOT_ALLOWED', 'Online purchases are paid by card.');
      if (input.discountCents) throw err('NOT_ALLOWED', 'Discounts are applied by the studio.');
      return this.engine.checkout({ clientId, items: input.items, method: 'card_online', ...(input.note ? { note: input.note } : {}) });
    }
    const st = this.requireStaff('pos');
    return this.engine.checkout({ ...input, staffId: input.staffId ?? st.id });
  }

  async purchase(input: { clientId?: ID; productId: ID; method: PaymentMethod; staffId?: ID; qty?: number; note?: string }): Promise<PurchaseResult> {
    return this.write(() => {
      const { sale, passes } = this.checkoutAs({
        ...(input.clientId ? { clientId: input.clientId } : {}), items: [{ productId: input.productId, qty: input.qty ?? 1 }], method: input.method,
        ...(input.staffId ? { staffId: input.staffId } : {}), ...(input.note ? { note: input.note } : {}),
      });
      return passes[0] ? { sale, pass: passes[0] } : { sale };
    });
  }

  async checkoutCart(input: { clientId?: ID; items: { productId: ID; qty: number }[]; method: PaymentMethod; staffId?: ID; discountCents?: number; note?: string }): Promise<{ sale: Sale; passes: Pass[] }> {
    return this.write(() => this.checkoutAs(input));
  }

  async startCheckout(): Promise<{ url: string } | null> {
    await this.delay();
    return null;
  }

  private requirePassOwnerOrStaff(passId: ID): AuthUser {
    const p = this.engine.pass(passId);
    const u = this.me();
    if (u.kind === 'client') { if (p.clientId !== u.clientId) throw err('NOT_ALLOWED', 'You can only manage your own passes.'); }
    else this.requireStaff('passes_manage');
    return u;
  }

  async pausePass(passId: ID, from: ISODate, until: ISODate): Promise<Pass> {
    return this.write(() => { this.requirePassOwnerOrStaff(passId); return this.engine.pause(passId, from, until); });
  }
  async resumePass(passId: ID): Promise<Pass> {
    return this.write(() => { this.requirePassOwnerOrStaff(passId); return this.engine.resume(passId); });
  }
  async cancelMembership(passId: ID): Promise<Pass> {
    return this.write(() => { this.requirePassOwnerOrStaff(passId); return this.engine.cancelMembership(passId); });
  }
  async adjustPass(passId: ID, change: { creditsDelta?: number; newExpiresAt?: ISODateTime | null; reason: string }): Promise<Pass> {
    return this.write(() => { const st = this.requireStaff('passes_manage'); return this.engine.adjust(passId, change, st.id); });
  }

  async listSales(range: ReportRange & { clientId?: ID }): Promise<Sale[]> {
    return this.read(() => {
      const u = this.me();
      let clientId = range.clientId;
      if (u.kind === 'client') {
        if (clientId && clientId !== u.clientId) throw err('NOT_ALLOWED', 'You can only see your own purchases.');
        clientId = u.clientId;
      } else this.requireStaff('sales_view');
      return this.state.sales
        .filter((s) => (!clientId || s.clientId === clientId) && studioDay(s.createdAt) >= range.from && studioDay(s.createdAt) <= range.to)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async refundSale(saleId: ID, opts: { amountCents?: number; cancelPass?: boolean; reason?: string } = {}): Promise<Sale> {
    return this.write(() => { this.requireStaff('pos_refund'); return this.engine.refund(saleId, opts); });
  }

  // ---------------------------------------------------------------- reports
  async getReport(range: ReportRange): Promise<StudioReport> {
    return this.read(() => {
      const st = this.requireStaff('reports');
      const s = this.state;
      const r = buildReport({ range, now: this.now(), sales: s.sales, sessions: s.sessions, bookings: s.bookings, clients: s.clients, passes: s.passes, staff: s.staff, classTypes: s.classTypes, products: s.products });
      if (!can(st.role, 'reports_revenue')) { r.revenueCents = 0; r.refundsCents = 0; r.revenueByMethod = {}; r.revenueByKind = {}; r.salesCount = 0; }
      if (!can(st.role, 'reports_pay')) r.byInstructor = r.byInstructor.map((x) => ({ ...x, payCents: 0 }));
      return r;
    });
  }

  async exportSalesCsv(range: ReportRange): Promise<string> {
    return this.read(() => { this.requireStaff('export_sales'); return salesCsv({ sales: this.state.sales, clients: this.state.clients, staff: this.state.staff, range }); });
  }

  async exportClientsCsv(): Promise<string> {
    return this.read(() => { this.requireStaff('export_clients'); return clientsCsv(this.state.clients); });
  }
}
