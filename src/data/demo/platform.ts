/**
 * Demo PlatformStore: the studio directory, person-level sign-in across studios, and Pete's platform admin
 * tools, all on the shared demo database (./db.ts). forStudio() hands out studio-bound DemoStores.
 */
import { StoreError } from '../../shared/store';
import type { DataStore, NewStudioInput, PlatformStore, Unsubscribe } from '../../shared/store';
import type { ID, PlatformUser, Staff, Studio, StudioMembership, StudioStatus } from '../../shared/types';
import { defaultBranding } from '../../shared/branding';
import { withStudioFormat } from '../../shared/format';
import { DemoDb, type DemoDbOptions } from './db';
import { emptyStudioState } from './harbour';
import { seedFeatures } from './features';
import { DemoStore } from './index';

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
const err = (code: string, msg: string) => new StoreError(code, msg);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Slugs that would clash with platform hostnames or paths. */
export const RESERVED_SLUGS = ['www', 'app', 'admin', 'studio', 'studios', 'api', 'platform', 'help', 'mail', 's'];
const ROLE_WORD: Record<string, string> = { owner: 'Owner', manager: 'Manager', front_desk: 'Front desk', instructor: 'Instructor' };

export function createDemoPlatform(opts: DemoDbOptions = {}): DemoPlatform {
  return new DemoPlatform(new DemoDb(opts));
}

export class DemoPlatform implements PlatformStore {
  readonly mode = 'demo' as const;
  private stores = new Map<ID, DemoStore>();
  constructor(readonly db: DemoDb) {}

  subscribe(listener: () => void): Unsubscribe { return this.db.subscribe(listener); }

  private async read<T>(fn: () => T): Promise<T> {
    await this.db.delay();
    this.db.sync();
    return clone(fn());
  }
  private async write<T>(fn: () => T): Promise<T> {
    await this.db.delay();
    this.db.sync();
    const snap = JSON.stringify(this.db.ps);
    let out: T;
    try { out = fn(); } catch (e) { this.db.ps = JSON.parse(snap); this.db.load(); throw e; }
    this.db.save();
    const r = clone(out);
    this.db.emit();
    return r;
  }
  private person(): { email: string; name: string } | null {
    const a = this.db.readAuth();
    if (!a) return null;
    return this.db.personByEmail(a.email) ?? null;
  }
  private requireAdmin(): { email: string; name: string } {
    const p = this.person();
    if (!p) throw err('AUTH_REQUIRED', 'Please sign in first.');
    if (!this.db.isPlatformAdmin(p.email)) throw err('NOT_ALLOWED', 'Only platform admins can do that.');
    return p;
  }
  private studioOrThrow(id: ID): Studio {
    const s = this.db.studio(id);
    if (!s) throw err('NOT_FOUND', 'That studio could not be found.');
    return s;
  }

  // ---------------------------------------------------------------- directory
  async listStudios(opts: { search?: string; includeAll?: boolean } = {}): Promise<Studio[]> {
    return this.read(() => {
      const all = opts.includeAll && this.db.isPlatformAdmin(this.person()?.email);
      const terms = (opts.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      return this.db.ps.studios
        .filter((s) => all || s.status === 'live')
        .filter((s) => terms.every((t) => `${s.name} ${s.slug} ${s.address}`.toLowerCase().includes(t)))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async findStudio(key: { slug?: string; id?: ID; domain?: string }): Promise<Studio | null> {
    return this.read(() => {
      const slug = key.slug?.toLowerCase(), domain = key.domain?.toLowerCase();
      return this.db.ps.studios.find((s) => (key.id && s.id === key.id) || (slug && s.slug === slug)
        || (domain && (s.customDomains ?? []).some((d) => d.toLowerCase() === domain))) ?? null;
    });
  }

  forStudio(studio: Studio): DataStore {
    let s = this.stores.get(studio.id);
    if (!s) { s = new DemoStore(this.db, studio.id); this.stores.set(studio.id, s); }
    return s;
  }

  // ---------------------------------------------------------------- people
  async currentPerson(): Promise<{ email: string; name: string } | null> {
    return this.read(() => this.person());
  }

  async signIn(email: string, password: string): Promise<{ email: string; name: string }> {
    return this.write(() => {
      const e = (email ?? '').trim().toLowerCase();
      if (!e || !password) throw err('INVALID_LOGIN', 'Enter your email and password.');
      const p = this.db.personByEmail(e);
      if (!p) throw err('INVALID_LOGIN', "We couldn't find an account with that email.");
      if (this.db.app === 'admin' && !this.db.isPlatformAdmin(e)) throw err('NOT_ALLOWED', 'This sign-in is for the platform team.');
      if (this.db.app === 'studio' && !this.db.isPlatformAdmin(e) && !this.memberships(e).some((m) => m.kind === 'staff')) {
        throw err('NOT_ALLOWED', 'This sign-in is for studio staff. Clients can use their studio’s app.');
      }
      this.db.writeAuth({ email: p.email, name: p.name });
      return p;
    });
  }

  async signOut(): Promise<void> {
    await this.db.delay();
    this.db.writeAuth(null);
    this.db.emit();
  }

  private memberships(email: string): StudioMembership[] {
    const e = email.trim().toLowerCase();
    const out: StudioMembership[] = [];
    for (const s of this.db.ps.studios) {
      const st = this.db.ps.data[s.id];
      if (!st) continue;
      const staff = st.staff.find((x) => x.active && x.email.toLowerCase() === e);
      if (staff) out.push({ studioId: s.id, slug: s.slug, name: s.name, status: s.status, kind: 'staff', role: staff.role });
      if (st.clients.some((x) => !x.archived && x.email.toLowerCase() === e)) out.push({ studioId: s.id, slug: s.slug, name: s.name, status: s.status, kind: 'client' });
    }
    return out;
  }

  async myMemberships(): Promise<StudioMembership[]> {
    return this.read(() => { const p = this.person(); return p ? this.memberships(p.email) : []; });
  }

  // ---------------------------------------------------------------- platform admin
  async platformUser(): Promise<PlatformUser | null> {
    return this.read(() => {
      const p = this.person();
      return p && this.db.isPlatformAdmin(p.email) ? { email: p.email, name: p.name, role: 'platform_admin' } : null;
    });
  }

  private checkSlug(slug: string, exceptId?: ID): string {
    const s = (slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(s)) throw err('INVALID', 'The web address can use lowercase letters, numbers and dashes (2 to 40 characters).');
    if (RESERVED_SLUGS.includes(s)) throw err('INVALID', `“${s}” is reserved. Try another web address.`);
    if (this.db.ps.studios.some((x) => x.slug === s && x.id !== exceptId)) throw err('SLUG_TAKEN', 'Another studio already uses that web address.');
    return s;
  }

  async createStudio(input: NewStudioInput): Promise<Studio> {
    return this.write(() => {
      this.requireAdmin();
      const name = input.name?.trim();
      if (!name) throw err('INVALID', 'Please enter the studio name.');
      const slug = this.checkSlug(input.slug);
      const email = (input.email ?? '').trim();
      if (!EMAIL_RE.test(email)) throw err('INVALID', 'Please enter the studio’s email address.');
      const timezone = input.timezone || 'Australia/Sydney';
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw err('INVALID', 'That timezone isn’t recognised.'); }
      let id = `studio_${slug.replace(/-/g, '_')}`;
      while (this.db.studio(id)) id += '_x';
      const studio: Studio = {
        id, slug, name, timezone, currency: input.currency || 'AUD', locale: input.locale || 'en-AU', email,
        ...(input.phone ? { phone: input.phone } : {}), address: input.address ?? '', taxIdLabel: 'ABN', taxName: 'GST', taxRate: 0.1,
        taxRegistered: true, status: 'onboarding', branding: input.branding ? clone(input.branding) : defaultBranding(name),
        createdAt: this.db.now().toISOString(),
      };
      const fmt = { timezone, locale: studio.locale, currency: studio.currency, taxRate: studio.taxRate };
      const state = withStudioFormat(fmt, () => emptyStudioState(this.db.now(), { name, timezone, address: studio.address, email, ...(input.phone ? { phone: input.phone } : {}) }));
      seedFeatures(studio, state, this.db.now());
      this.db.ps.studios.push(studio);
      this.db.ps.data[id] = state;
      return studio;
    });
  }

  async updateStudioAsAdmin(id: ID, patch: Partial<Omit<Studio, 'id' | 'createdAt'>>): Promise<Studio> {
    return this.write(() => {
      this.requireAdmin();
      const s = this.studioOrThrow(id);
      if (patch.slug !== undefined) patch.slug = this.checkSlug(patch.slug, id);
      if (patch.name !== undefined && !patch.name.trim()) throw err('INVALID', 'Please enter the studio name.');
      Object.assign(s, clone(patch));
      const st = this.db.ps.data[id];
      if (st) {
        const m = st.settings;
        if (patch.name !== undefined) m.name = s.name;
        if (patch.timezone !== undefined) m.timezone = s.timezone;
        if (patch.address !== undefined) m.address = s.address;
        if (patch.email !== undefined) m.email = s.email;
        if (patch.phone !== undefined) m.phone = s.phone;
        if (patch.taxId !== undefined) m.abn = s.taxId;
        if (patch.taxRegistered !== undefined) m.gstRegistered = s.taxRegistered;
      }
      return s;
    });
  }

  async setStudioStatus(id: ID, status: StudioStatus): Promise<Studio> {
    return this.write(() => {
      this.requireAdmin();
      if (!['onboarding', 'live', 'suspended'].includes(status)) throw err('INVALID', 'Unknown status.');
      const s = this.studioOrThrow(id);
      s.status = status;
      return s;
    });
  }

  async inviteOwner(studioId: ID, owner: { name: string; email: string }): Promise<Staff> {
    return this.write(() => {
      this.requireAdmin();
      this.studioOrThrow(studioId);
      const st = this.db.state(studioId);
      const name = owner.name?.trim(), email = owner.email?.trim().toLowerCase();
      if (!name) throw err('INVALID', 'Please enter the owner’s name.');
      if (!email || !EMAIL_RE.test(email)) throw err('INVALID', 'Please enter the owner’s email address.');
      if (st.clients.some((c) => c.email.toLowerCase() === email)) throw err('EMAIL_TAKEN', 'That email belongs to a client of this studio.');
      let s = st.staff.find((x) => x.email.toLowerCase() === email);
      if (s) Object.assign(s, { role: 'owner', active: true, name });
      else { s = { id: this.db.engine(studioId).newId('st'), name, email, role: 'owner', active: true }; st.staff.push(s); }
      return s;
    });
  }

  async studioStats(): Promise<Record<ID, { clients: number; staff: number; classesNext7Days: number }>> {
    return this.read(() => {
      this.requireAdmin();
      const now = this.db.now().getTime(), week = now + 7 * 86_400_000;
      const out: Record<ID, { clients: number; staff: number; classesNext7Days: number }> = {};
      for (const s of this.db.ps.studios) {
        const st = this.db.ps.data[s.id];
        if (!st) continue;
        const weekly = st.templates.filter((t) => t.active).length;
        const oneOff = st.sessions.filter((x) => !x.templateId && x.status === 'scheduled' && Date.parse(x.startsAt) >= now && Date.parse(x.startsAt) < week).length;
        out[s.id] = { clients: st.clients.filter((c) => !c.archived).length, staff: st.staff.filter((x) => x.active).length, classesNext7Days: weekly + oneOff };
      }
      return out;
    });
  }

  // ---------------------------------------------------------------- demo
  async demoPersonas(app: 'client' | 'studio' | 'admin'): Promise<{ email: string; name: string; hint: string; studioId?: ID }[]> {
    return this.read(() => {
      if (app === 'admin') return this.db.ps.platformAdmins.map((a) => ({ email: a.email, name: a.name, hint: 'Platform admin' }));
      const out: { email: string; name: string; hint: string; studioId?: ID }[] = [];
      for (const s of this.db.ps.studios) {
        const st = this.db.ps.data[s.id];
        if (!st) continue;
        if (app === 'studio') for (const x of st.staff.filter((y) => y.active)) out.push({ email: x.email, name: x.name, hint: `${ROLE_WORD[x.role]} · ${s.name}`, studioId: s.id });
        else for (const em of st.personas ?? []) { const c = st.clients.find((y) => y.email === em); if (c) out.push({ email: c.email, name: `${c.firstName} ${c.lastName}`, hint: s.name, studioId: s.id }); }
      }
      return out;
    });
  }

  async demoSignInAs(email: string): Promise<void> {
    await this.write(() => {
      const p = this.db.personByEmail(email);
      if (!p) throw err('NOT_FOUND', 'That demo account no longer exists. Try resetting the demo.');
      this.db.writeAuth({ email: p.email, name: p.name });
    });
  }

  async demoReset(): Promise<void> {
    await this.db.delay();
    this.db.reseed();
    this.db.emit();
  }
}
