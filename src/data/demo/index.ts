/**
 * Demo DataStore bound to one studio: that studio's data in the shared demo database (./db.ts), seeded with
 * realistic fake data. Snowy is seeded exactly as before; Harbour Reformer Co. is the second sample studio.
 * - Permissions follow RULES.md › Staff permissions (see src/domain/permissions.ts).
 * - Business rules live in src/domain; operations in ./engine.ts.
 * - Feature modules plug in through ./features.ts (registerDemoFeature) and appear as store.features.<name>.
 * - Every call runs with the studio's own timezone / currency (withStudioFormat).
 */
import { StoreError } from '../../shared/store';
import type {
  BookResult, BookingWithDetails, CreditSummary, DataStore, DependantInput, FeatureStores, PurchaseResult, RosterEntry, StudioPatch, Unsubscribe,
} from '../../shared/store';
import type {
  AuthUser, Booking, BookingStatus, ClassSession, ClassType, Client, HealthForm, ID, ISODate, ISODateTime, Pass, PaymentMethod, PaymentsStatus,
  Product, ReportRange, Sale, ScheduleTemplate, SessionWithCounts, Staff, Studio, StudioReport, StudioSettings,
} from '../../shared/types';
import { dayShort, studioToUTC, withStudioFormat } from '../../shared/format';
import {
  FINANCIAL_SETTINGS_KEYS, buildReport, can, clientsCsv, comparePassPriority, computePassStatus, creditLabel, isIntroEligible,
  isFamilyShareable, isPassCurrent, remainingCredits, rosterFlags, salesCsv, studioDay, type FeatureAction, type StaffAction,
} from '../../domain';
import type { Actor, DemoState, Engine } from './engine';
import { PERSONA_EMAILS } from './seed';
import { AUTH_KEYS, DemoDb, REV_KEY, STATE_KEY, memoryStorage, type DemoDbOptions, type StorageLike } from './db';
import { demoFeatures, type DemoFeatureContext } from './features';
import { createDemoPlatform } from './platform';
import { SNOWY_ID } from '../studios';
import '../../features/demo';

export { STATE_KEY, REV_KEY, AUTH_KEYS, PERSONA_EMAILS, memoryStorage, DemoDb, createDemoPlatform };
export type { StorageLike };

export interface DemoStoreOptions extends DemoDbOptions {
  /** Which studio (slug or id). Default: the first studio (Snowy). */
  studio?: string;
}

/** Which emailed link the user opened: an invite (new staff, imported clients) or forgot password. */
export type PasswordLinkKind = 'invite' | 'recovery';

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
const err = (code: string, msg: string) => new StoreError(code, msg);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Settings fields that mirror the studio record (kept in step both ways). */
const MIRROR: [keyof StudioSettings, keyof Studio][] = [['name', 'name'], ['timezone', 'timezone'], ['address', 'address'], ['email', 'email'], ['phone', 'phone'], ['abn', 'taxId'], ['gstRegistered', 'taxRegistered']];

/** A demo store for one studio (tests and simple callers). The apps go through createDemoPlatform().forStudio(). */
export function createDemoStore(opts: DemoStoreOptions = {}): DataStore {
  const db = new DemoDb(opts);
  const key = opts.studio;
  const studio = (key ? db.ps.studios.find((s) => s.slug === key || s.id === key) : undefined) ?? db.ps.studios[0];
  if (!studio) throw new Error('The demo has no studios.');
  return new DemoStore(db, studio.id);
}

export class DemoStore implements DataStore {
  readonly mode = 'demo' as const;
  readonly features: Partial<FeatureStores> = {};
  private listeners = new Set<() => void>();
  /** The app's "Choose a new password" screen (onPasswordRecovery). */
  private recoveryHandler: ((kind?: PasswordLinkKind) => void) | null = null;
  /** Whose reset / invite link was "opened" (demoOpenPasswordLink). setNewPassword signs them in, like a live link does. */
  private linkEmail: string | null = null;
  private now: () => Date;

  constructor(private db: DemoDb, readonly studioId: ID) {
    this.now = db.now;
    if (!db.studio(studioId)) throw new Error(`Unknown studio ${studioId}`);
    db.subscribe(() => this.emit());
    for (const f of demoFeatures()) (this.features as Record<string, unknown>)[f.name] = f.create(this.featureContext(f.name));
  }

  private get state(): DemoState { return this.db.state(this.studioId); }
  private get engine(): Engine { return this.db.engine(this.studioId); }
  private get studioRec(): Studio { return this.db.studio(this.studioId)!; }
  private get authKey(): string { return this.db.authKey; }

  // ---------------------------------------------------------------- persistence
  private emit(): void {
    for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error(e); } }
  }
  private inFormat<T>(fn: () => T): T {
    const f = this.db.formatOf(this.studioId);
    return f ? withStudioFormat(f, fn) : fn();
  }
  private delay(): Promise<void> { return this.db.delay(); }
  private save(): void { this.db.save(); }
  /** Sync from other tabs and apply lazy time-based updates. */
  private prepare(): void {
    this.db.sync();
    if (this.inFormat(() => this.engine.housekeeping())) { this.save(); this.db.emitSoon(); }
  }
  private async read<T>(fn: () => T): Promise<T> {
    await this.delay();
    this.prepare();
    return clone(this.inFormat(fn));
  }
  private async write<T>(fn: () => T): Promise<T> {
    await this.delay();
    this.prepare();
    const snap = JSON.stringify(this.state);
    const studioSnap = JSON.stringify(this.studioRec);
    let out: T;
    try {
      if (this.studioRec.status === 'suspended' && !this.db.isPlatformAdmin(this.db.readAuth()?.email)) {
        throw err('STUDIO_SUSPENDED', `${this.studioRec.name} is paused on the platform right now. Please contact the studio.`);
      }
      out = this.inFormat(fn);
    } catch (e) {
      this.db.replaceState(this.studioId, JSON.parse(snap) as DemoState);
      Object.assign(this.studioRec, JSON.parse(studioSnap));
      throw e;
    }
    this.save();
    const result = clone(out);
    this.db.emit();
    return result;
  }

  /** What feature modules get (see ./features.ts). */
  private featureContext(name: string): DemoFeatureContext {
    return {
      studioId: this.studioId,
      studio: () => clone(this.studioRec),
      now: () => this.now(),
      slice: <T>() => { const f = (this.state.features ??= {}); return ((f[name] ??= {}) as T); },
      read: (fn) => this.read(fn),
      write: (fn) => this.write(fn),
      me: () => this.me(),
      requireStaff: (action) => this.requireStaff(action as StaffAction),
      requireSelfOrStaff: (clientId, action) => this.requireSelfOrStaff(clientId, (action ?? 'clients_view') as StaffAction),
      core: () => ({ state: this.state, engine: this.engine }),
      newId: (prefix) => this.engine.newId(prefix),
      error: (code, msg) => err(code, msg),
    };
  }
  // ---------------------------------------------------------------- auth helpers
  /** The signed-in person as this studio sees them (their client or staff record here), or null. */
  private readAuth(): AuthUser | null {
    const a = this.db.readAuth();
    if (!a) return null;
    if (a.user && (a.studioId ?? this.studioId) === this.studioId) {
      const u = this.freshUser(a.user);
      if (u) return u;
    }
    return this.byEmail(a.email);
  }
  private writeAuth(u: AuthUser | null): void {
    this.db.writeAuth(u ? { email: u.email, name: u.name, studioId: this.studioId, user: u } : null);
  }
  /** A person's record here by email: staff first in the studio app, client first in the client app. */
  private byEmail(email: string): AuthUser | null {
    const e = (email ?? '').trim().toLowerCase();
    if (!e) return null;
    const st = this.state.staff.find((s) => s.active && s.email.toLowerCase() === e);
    const c = this.state.clients.find((x) => !x.archived && x.email.toLowerCase() === e);
    const staffU: AuthUser | null = st ? { kind: 'staff', staffId: st.id, email: st.email, name: st.name, role: st.role } : null;
    const clientU: AuthUser | null = c ? { kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}`.trim() } : null;
    return this.db.app === 'client' ? clientU ?? staffU : staffU ?? clientU;
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
  private requireStaff(action: StaffAction | FeatureAction): Staff {
    const st = this.staffMe();
    if (!can(st.role, action)) throw err('NOT_ALLOWED', "Your role doesn't have access to that.");
    return st;
  }
  /** Client acting on their own data, or staff with `action`. */
  private requireSelfOrStaff(clientId: ID, action: StaffAction | FeatureAction = 'clients_view'): AuthUser {
    const u = this.me();
    if (u.kind === 'client') {
      if (u.clientId !== clientId && !this.isGuardianOf(u.clientId, clientId)) throw err('NOT_ALLOWED', 'You can only see your own account.');
      return u;
    }
    this.requireStaff(action);
    return u;
  }
  /** Is `clientId` a dependant of `guardianId`? (Family accounts.) */
  private isGuardianOf(guardianId: ID, clientId: ID): boolean {
    return this.engine.findClient(clientId)?.guardianClientId === guardianId;
  }
  /** The signed-in client and their dependants: everyone they may book, pay and sign for. */
  private familyIds(clientId: ID): ID[] {
    return [clientId, ...this.state.clients.filter((c) => c.guardianClientId === clientId && !c.archived).map((c) => c.id)];
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
    let out: Client = c;
    if (!(st && can(st.role, 'client_staff_notes'))) { const { staffNotes: _omit, ...rest } = c; out = rest; }
    const g = c.guardianClientId ? this.engine.findClient(c.guardianClientId) : undefined;
    return g ? { ...out, guardianName: `${g.firstName} ${g.lastName}`.trim() } : out;
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
      const studio = this.db.app !== 'client';
      let u: AuthUser | null = null;
      if (studio && st) u = { kind: 'staff', staffId: st.id, email: st.email, name: st.name, role: st.role };
      else if (!studio && c) u = { kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}`.trim() };
      else if (studio && c) throw err('NOT_ALLOWED', `This sign-in is for studio staff. Clients can use the ${this.studioRec.name} app.`);
      else if (!studio && st) throw err('NOT_ALLOWED', 'Staff accounts sign in to the studio app.');
      if (!u && !studio) u = this.joinFromPlatform(e);
      if (!u) throw err('INVALID_LOGIN', "We couldn't find an account with that email.");
      this.writeAuth(u);
      return u;
    });
  }

  /**
   * One login, many studios: someone who's a client at another studio on the platform signing in here for the
   * first time becomes a client here too (name, email and phone only: no waiver, passes or history carry over).
   */
  private joinFromPlatform(email: string): AuthUser | null {
    for (const [id, st] of Object.entries(this.db.ps.data)) {
      if (id === this.studioId) continue;
      const other = st.clients.find((x) => !x.archived && x.email.toLowerCase() === email);
      if (!other) continue;
      const c: Client = {
        id: this.engine.newId('cl'), firstName: other.firstName, lastName: other.lastName, email: other.email, createdAt: this.now().toISOString(),
        marketingOptIn: false, source: 'app', ...(other.phone ? { phone: other.phone } : {}),
      };
      this.engine.addClient(c);
      return { kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}`.trim() };
    }
    return null;
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
    this.db.emit();
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.delay();
    if (!EMAIL_RE.test((email ?? '').trim())) throw err('INVALID', 'Please enter a valid email address.');
  }

  /**
   * Password links. Live, the reset/invite link signs the user in and the app shows its "Choose a new password"
   * screen. Demo: the app's "Demo: open the reset link" button calls demoOpenPasswordLink(), which fires the
   * handler; setNewPassword() then signs that person in (any password works in the demo anyway).
   */
  onPasswordRecovery(handler: (kind?: PasswordLinkKind) => void): Unsubscribe {
    this.recoveryHandler = handler;
    return () => { if (this.recoveryHandler === handler) this.recoveryHandler = null; };
  }

  async setNewPassword(password: string): Promise<void> {
    await this.delay();
    if (!password || password.length < 8) throw err('INVALID', 'Please choose a password with at least 8 characters.');
    const e = this.linkEmail;
    this.linkEmail = null;
    if (!e || this.readAuth()) return;
    this.prepare();
    const u = this.accountFor(e);
    if (u) { this.writeAuth(u); this.emit(); }
  }

  /**
   * Demo only (not in DataStore): pretend the user tapped the emailed link. `email` is whose link it is; an invite
   * with no email picks the imported Momence client (client app) or the newest staff member (studio app).
   * Returns false if the app hasn't registered a screen.
   */
  async demoOpenPasswordLink(kind: PasswordLinkKind = 'recovery', email?: string): Promise<boolean> {
    await this.delay();
    this.prepare();
    let e = (email ?? '').trim().toLowerCase();
    if (!e && kind === 'invite') {
      e = this.db.app !== 'client'
        ? (this.state.staff.filter((s) => s.active).at(-1)?.email ?? '')
        : (() => {
          // An imported Momence client who hasn't used the new app yet (no waiver signed in it) shows it best.
          const imported = this.state.clients.filter((c) => c.source === 'import' && !c.archived);
          return (imported.find((c) => !c.waiverSignedAt) ?? imported[0])?.email ?? '';
        })();
    }
    this.linkEmail = e || null;
    if (!this.recoveryHandler) return false;
    this.recoveryHandler(kind);
    return true;
  }

  /** The account this app would sign in for an email (staff in the studio app, clients in the client app). */
  private accountFor(email: string): AuthUser | null {
    const e = email.trim().toLowerCase();
    if (this.db.app !== 'client') {
      const st = this.state.staff.find((s) => s.active && s.email.toLowerCase() === e);
      return st ? { kind: 'staff', staffId: st.id, email: st.email, name: st.name, role: st.role } : null;
    }
    const c = this.state.clients.find((x) => !x.archived && x.email.toLowerCase() === e);
    return c ? { kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}`.trim() } : null;
  }

  async demoPersonas(): Promise<AuthUser[]> {
    return this.read(() => {
      const out: AuthUser[] = [];
      for (const email of this.state.personas ?? []) {
        const c = this.state.clients.find((x) => x.email === email && !x.archived);
        if (c) out.push({ kind: 'client', clientId: c.id, email: c.email, name: `${c.firstName} ${c.lastName}` });
      }
      for (const s of this.state.staff) if (s.active) out.push({ kind: 'staff', staffId: s.id, email: s.email, name: s.name, role: s.role });
      return out;
    });
  }

  /** Demo only (not in DataStore): persona descriptions, and the imported (Momence) client whose invite link the demo can open. */
  async demoPersonaInfo(): Promise<{ hints: Record<string, string>; importedClient?: string }> {
    return this.read(() => {
      const imported = this.state.clients.filter((c) => c.source === 'import' && !c.archived);
      const c = imported.find((x) => !x.waiverSignedAt) ?? imported[0];
      return { hints: this.state.personaHints ?? {}, ...(c ? { importedClient: c.firstName } : {}) };
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

  /** Demo only: wipe and re-seed every studio on the platform (sign-in is kept if the person still exists here). */
  async demoReset(): Promise<void> {
    await this.delay();
    this.db.reseed();
    if (!this.readAuth()) this.writeAuth(null);
    this.db.emit();
  }

  /** Demo: images stay inline as data URLs (fine for a browser demo; the live store uploads to Storage). */
  async uploadBrandingImage(file: Blob): Promise<string> {
    await this.delay();
    if (file.size > 4 * 1024 * 1024) throw err('INVALID', 'That image is over 4 MB. Please choose a smaller one.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${file.type || 'application/octet-stream'};base64,${btoa(bin)}`;
  }

  // ---------------------------------------------------------------- payments (fake Stripe Connect)
  /** Snowy (the default studio) takes payments on its own Stripe account, like the real single-account deployment. Every other studio starts unconnected. */
  async getPaymentsStatus(): Promise<PaymentsStatus> {
    return this.read(() => {
      const st = this.staffMe();
      if (st.role !== 'owner') throw err('NOT_ALLOWED', 'Only the studio owner can see payment settings.');
      const single = this.studioId === SNOWY_ID;
      const on = !single && !!this.db.ps.connected?.[this.studioId];
      return { connectMode: !single, connected: on, ...(on ? { accountId: 'acct_demo' + this.studioRec.slug } : {}), chargesEnabled: on, payoutsEnabled: on, detailsSubmitted: on };
    });
  }

  /** Demo: no Stripe to visit, so "Connect Stripe" just marks the studio connected. */
  async startPaymentsOnboarding(): Promise<{ url: string } | null> {
    return this.write(() => {
      const st = this.staffMe();
      if (st.role !== 'owner') throw err('NOT_ALLOWED', 'Only the studio owner can connect Stripe.');
      if (this.studioId === SNOWY_ID) throw err('CONNECT_OFF', 'This app takes card payments on its own Stripe account, so there’s nothing to connect.');
      (this.db.ps.connected ??= {})[this.studioId] = true;
      return null;
    });
  }

  // ---------------------------------------------------------------- studio (details + branding)
  async getStudio(): Promise<Studio> {
    return this.read(() => this.studioRec);
  }

  async updateStudio(patch: StudioPatch): Promise<Studio> {
    return this.write(() => {
      const st = this.requireStaff('settings');
      const s = this.studioRec;
      const financial = (['taxId', 'taxRegistered', 'taxRate', 'taxName', 'taxIdLabel', 'currency'] as const).some((k) => k in patch && patch[k] !== s[k]);
      if (financial && !can(st.role, 'settings_financial')) throw err('NOT_ALLOWED', 'Only the owner can change tax and currency details.');
      if (patch.status !== undefined) {
        if (st.role !== 'owner') throw err('NOT_ALLOWED', 'Only the owner can open the studio.');
        if (patch.status !== 'live' || s.status !== 'onboarding') throw err('INVALID', 'Only a studio that is setting up can go live.');
      }
      if (patch.name !== undefined && !patch.name.trim()) throw err('INVALID', 'Please enter the studio name.');
      if (patch.email !== undefined && patch.email && !EMAIL_RE.test(patch.email.trim())) throw err('INVALID', 'Please enter a valid email address.');
      if (patch.taxRate !== undefined && !(patch.taxRate >= 0 && patch.taxRate < 1)) throw err('INVALID', 'Tax rate must be between 0 and 1 (0.1 = 10%).');
      if (patch.timezone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: patch.timezone }); } catch { throw err('INVALID', 'That timezone isn’t recognised.'); } }
      Object.assign(s, clone(patch));
      for (const [k, sk] of MIRROR) if (sk in patch) (this.state.settings as unknown as Record<string, unknown>)[k] = s[sk];
      return s;
    });
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
      const studio = this.studioRec;
      for (const [k, sk] of MIRROR) if (k in patch) (studio as unknown as Record<string, unknown>)[sk] = this.state.settings[k];
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
    return this.inFormat(() => {
      if (this.engine.generate(studioDay(range.from), studioDay(range.to)) > 0) this.save();
      const counts = this.engine.allCounts();
      const direct = !this.viewerStaff();   // clients see capacity minus held-back spots; staff see the real number
      return clone(this.state.sessions
        .filter((s) => Date.parse(s.startsAt) < to && Date.parse(s.endsAt) > from && (range.includeCancelled !== false || s.status !== 'cancelled'))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .map((s) => this.engine.withCounts(s, counts, direct)));
    });
  }

  async getSession(id: ID): Promise<SessionWithCounts> {
    return this.read(() => this.engine.withCounts(this.engine.session(id), undefined, !this.viewerStaff()));
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
        if (u.clientId !== clientId && !this.isGuardianOf(u.clientId, clientId)) throw err('NOT_ALLOWED', 'You can only book for yourself and your family.');
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
        if (b.clientId !== u.clientId && !this.isGuardianOf(u.clientId, b.clientId)) throw err('NOT_ALLOWED', 'You can only cancel your own bookings.');
        if (opts.waivePenalty || opts.asStaff) throw err('NOT_ALLOWED', 'Only studio staff can waive the cancellation policy.');
      } else this.requireRoster(b.sessionId);
      return this.engine.cancel(bookingId, { by: this.actor(u), waive: !!opts.waivePenalty });
    });
  }

  async leaveWaitlist(bookingId: ID): Promise<void> {
    return this.write(() => {
      const u = this.me();
      const b = this.engine.booking(bookingId);
      if (u.kind === 'client') { if (b.clientId !== u.clientId && !this.isGuardianOf(u.clientId, b.clientId)) throw err('NOT_ALLOWED', 'You can only change your own bookings.'); }
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

  async undoNoShow(bookingId: ID): Promise<Booking> {
    return this.write(() => { this.requireRoster(this.engine.booking(bookingId).sessionId); return this.engine.undoNoShow(bookingId); });
  }
  async undoCancelBooking(bookingId: ID, opts: { demotePromotedId?: ID } = {}) {
    return this.write(() => { this.requireRoster(this.engine.booking(bookingId).sessionId); return this.engine.undoCancel(bookingId, opts); });
  }
  async waivePenalty(bookingId: ID): Promise<Booking> {
    return this.write(() => { this.requireRoster(this.engine.booking(bookingId).sessionId); return this.engine.waivePenalty(bookingId); });
  }
  async restoreSession(sessionId: ID) {
    return this.write(() => { this.requireStaff('schedule'); return this.engine.restoreSession(sessionId); });
  }
  async voidSale(saleId: ID, opts: { reason?: string; dryRun?: boolean } = {}) {
    if (opts.dryRun) return this.read(() => { this.requireStaff('pos_refund'); return this.engine.voidSale(saleId, { ...opts, dryRun: true }); });   // describes only: no write, so UIs don't refetch in a loop
    return this.write(() => {
      this.requireStaff('pos_refund');
      const r = this.engine.voidSale(saleId, opts);
      if (r.voided) for (const f of demoFeatures()) f.afterRefund?.(this.featureContext(f.name), r.sale);
      return r;
    });
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
        out.push({ ...b, session: this.engine.withCounts(s, counts, !viewer), classType: this.engine.classType(s.classTypeId), ...(instructor ? { instructor: this.redactStaff(instructor, viewer) } : {}) });
      }
      out.sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
      if (when === 'past') out.reverse();
      return out;
    });
  }

  // ---------------------------------------------------------------- register interest
  async registerInterest(clientId: ID, classTypeId: ID): Promise<void> {
    await this.write(() => {
      const u = this.me();
      if (u.kind === 'client') { if (u.clientId !== clientId) throw err('NOT_ALLOWED', 'You can only register interest for yourself.'); }
      else this.requireStaff('clients_edit');
      this.engine.client(clientId);
      this.engine.classType(classTypeId);
      const list = (this.state.interest ??= []);
      if (!list.some((x) => x.clientId === clientId && x.classTypeId === classTypeId)) list.push({ clientId, classTypeId, at: this.now().toISOString() });
    });
  }

  /** Extra (not in DataStore): who registered interest, newest first. Staff only. */
  async listClassInterest(classTypeId?: ID): Promise<{ clientId: ID; classTypeId: ID; at: ISODateTime }[]> {
    return this.read(() => {
      this.requireStaff('clients_view');
      return (this.state.interest ?? []).filter((x) => !classTypeId || x.classTypeId === classTypeId).sort((a, b) => b.at.localeCompare(a.at));
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
          const g = c.guardianClientId ? this.engine.findClient(c.guardianClientId) : undefined;
          const hay = `${c.firstName} ${c.lastName} ${c.email} ${c.phone ?? ''} ${(c.phone ?? '').replace(/\D/g, '')} ${g ? `${g.firstName} ${g.lastName} ${g.email}` : ''}`.toLowerCase();
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
      delete patch.guardianName; // derived on read, never stored
      if (!can(st.role, 'client_staff_notes')) delete patch.staffNotes;
      if (patch.guardianClientId) {
        const g = this.engine.findClient(patch.guardianClientId);
        if (!g || g.archived) throw err('NOT_FOUND', 'We couldn’t find that parent.');
        if (g.guardianClientId) throw err('INVALID', 'A dependant can’t be a parent as well.');
        if (existing && (existing.id === g.id || this.state.clients.some((c) => c.guardianClientId === existing.id))) throw err('INVALID', 'Someone with dependants of their own can’t be a dependant.');
      }
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

  // ---------------------------------------------------------------- family accounts (see docs/features/family.md)
  async listDependants(guardianId: ID): Promise<Client[]> {
    return this.read(() => {
      this.requireSelfOrStaff(guardianId);
      return this.state.clients.filter((c) => c.guardianClientId === guardianId && !c.archived)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => this.redactClient(c));
    });
  }

  async saveDependant(guardianId: ID, input: DependantInput): Promise<Client> {
    return this.write(() => {
      const u = this.me();
      if (u.kind === 'client') { if (u.clientId !== guardianId) throw err('NOT_ALLOWED', 'You can only manage your own family.'); }
      else this.requireStaff('clients_edit');
      const g = this.engine.client(guardianId);
      if (g.archived) throw err('NOT_ALLOWED', 'This client account is archived.');
      if (g.guardianClientId) throw err('INVALID', 'A dependant can’t have dependants of their own.');
      const firstName = (input.firstName ?? '').trim();
      if (!firstName) throw err('INVALID', 'Please enter a first name.');
      if (input.birthday && (!DATE_RE.test(input.birthday) || input.birthday > studioDay(this.now()))) throw err('INVALID', 'Please enter a valid date of birth.');
      const existing = input.id ? this.engine.findClient(input.id) : undefined;
      if (input.id && (!existing || existing.guardianClientId !== guardianId)) throw err('NOT_FOUND', 'We couldn’t find that person.');
      const lastName = (input.lastName ?? '').trim() || g.lastName;
      const injuries = (input.injuries ?? '').trim() || undefined;
      const twin = this.state.clients.find((c) => c.guardianClientId === guardianId && !c.archived && c.id !== existing?.id
        && c.firstName.toLowerCase() === firstName.toLowerCase() && c.lastName.toLowerCase() === lastName.toLowerCase());
      if (twin) throw err('INVALID', `${firstName} is already in your family.`);
      if (existing) {
        existing.firstName = firstName; existing.lastName = lastName;
        if (input.birthday) existing.birthday = input.birthday; else delete existing.birthday;
        if (injuries) existing.injuries = injuries; else delete existing.injuries;
        return this.redactClient(existing);
      }
      const c: Client = {
        id: this.engine.newId('cl'), firstName, lastName, email: '', createdAt: this.now().toISOString(), marketingOptIn: false,
        source: u.kind === 'client' ? 'app' : 'staff', guardianClientId: guardianId,
        // the parent is the emergency contact, and the one who signs the waiver
        ...(g.phone ? { emergencyContactName: `${g.firstName} ${g.lastName}`.trim(), emergencyContactPhone: g.phone } : {}),
        ...(input.birthday ? { birthday: input.birthday } : {}), ...(injuries ? { injuries } : {}),
      };
      this.engine.addClient(c);
      return this.redactClient(c);
    });
  }

  async removeDependant(dependantId: ID): Promise<void> {
    await this.write(() => {
      const u = this.me();
      const d = this.engine.client(dependantId);
      if (!d.guardianClientId) throw err('INVALID', 'That isn’t a dependant.');
      if (u.kind === 'client') { if (d.guardianClientId !== u.clientId) throw err('NOT_ALLOWED', 'You can only manage your own family.'); }
      else this.requireStaff('clients_edit');
      const now = this.now().getTime();
      const upcoming = this.engine.clientBookings(dependantId).some((b) => ['booked', 'waitlisted', 'checked_in'].includes(b.status)
        && Date.parse(this.engine.session(b.sessionId).startsAt) >= now);
      if (upcoming) throw err('INVALID', `Cancel ${d.firstName}’s upcoming classes first, then remove them.`);
      d.archived = true;
    });
  }

  async bookAttendees(sessionId: ID, clientIds: ID[], opts: { passId?: ID } = {}): Promise<BookResult[]> {
    return this.write(() => {
      const u = this.me();
      if (u.kind !== 'client') throw err('NOT_ALLOWED', 'Staff add people to a class one at a time from the roster.');
      const ids = [...new Set(clientIds)];
      if (!ids.length) throw err('INVALID', 'Choose who’s coming.');
      this.engine.session(sessionId);
      for (const id of ids) if (id !== u.clientId && !this.isGuardianOf(u.clientId, id)) throw err('NOT_ALLOWED', 'You can only book for yourself and your family.');
      const pass = opts.passId ? this.engine.findPass(opts.passId) : undefined;
      // all or nothing: the first failure throws and write() rolls every booking back
      return ids.map((id) => this.engine.book(id, sessionId, { by: this.actor(u), ...(pass && this.engine.canSpend(id, pass) ? { passId: pass.id } : {}) }));
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
      const guardian = this.engine.guardianOf(clientId);
      return [...this.engine.clientPasses(clientId), ...(guardian ? this.engine.clientPasses(guardian.id).filter(isFamilyShareable) : [])].filter((p) => isPassCurrent(p, now)).sort(comparePassPriority).map((p) => {
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
      if (clientId !== u.clientId && !this.isGuardianOf(u.clientId, clientId)) throw err('NOT_ALLOWED', 'You can only buy for yourself and your family.');
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
    if (u.kind === 'client') { if (p.clientId !== u.clientId && !this.isGuardianOf(u.clientId, p.clientId)) throw err('NOT_ALLOWED', 'You can only manage your own passes.'); }
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
      let family: ID[] | undefined;   // a parent also sees what they bought for their dependants
      if (u.kind === 'client') {
        if (clientId && clientId !== u.clientId && !this.isGuardianOf(u.clientId, clientId)) throw err('NOT_ALLOWED', 'You can only see your own purchases.');
        clientId = clientId ?? u.clientId;
        if (clientId === u.clientId) family = this.familyIds(u.clientId);
      } else this.requireStaff('sales_view');
      return this.state.sales
        .filter((s) => (family ? !!s.clientId && family.includes(s.clientId) : (!clientId || s.clientId === clientId)) && studioDay(s.createdAt) >= range.from && studioDay(s.createdAt) <= range.to)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async refundSale(saleId: ID, opts: { amountCents?: number; cancelPass?: boolean; reason?: string } = {}): Promise<Sale> {
    return this.write(() => {
      this.requireStaff('pos_refund');
      const sale = this.engine.refund(saleId, opts);
      for (const f of demoFeatures()) f.afterRefund?.(this.featureContext(f.name), sale);
      return sale;
    });
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
