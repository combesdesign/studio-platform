/**
 * Live data store: Supabase (Postgres + Auth + RLS + Realtime) and Stripe via edge functions.
 * OWNED BY THE BACKEND AGENT.
 *
 * - All booking/money rules run inside Postgres functions (supabase/migrations/0002, 0003) so they're
 *   transactional and race-safe. This file is mostly plumbing: call RPCs / tables, map
 *   snake_case rows to the camelCase types in src/shared/types.ts, and turn database errors
 *   ('NO_CREDITS: You need a class pass…') into StoreError.
 * - Row level security decides what each person can see; the UI never has to filter for safety.
 * - @supabase/supabase-js is stubbed in the offline sandbox build, so the client is typed loosely
 *   (`Loose`) and everything this file returns is strictly typed.
 */
import { createClient } from '@supabase/supabase-js';
import type {
  AuthUser, Booking, BookingStatus, ClassSession, ClassType, Client, HealthForm, ID, ISODate, ISODateTime, Pass,
  PassStatus, PaymentMethod, Product, ProductKind, ReportRange, Sale, SaleItem, ScheduleTemplate, SessionWithCounts,
  Staff, StaffRole, Studio, StudioBranding, StudioMembership, StudioReport, StudioSettings, StudioStatus, PlatformUser,
} from '../../shared/types';
import {
  StoreError,
  type BookResult, type BookingWithDetails, type CancelResult, type CreditSummary, type DataStore, type PurchaseResult,
  type RosterEntry, type Unsubscribe, type FeatureStores, type StudioPatch, type PlatformStore, type NewStudioInput,
} from '../../shared/store';
import { liveFeatures, type LiveFeatureContext } from './features';
import '../../features/live';
import { addDays, startOfStudioDay } from '../../shared/format';
import { clientsCsv, salesCsv } from '../../domain/report';
import { comparePassPriority, isPassCurrent } from '../../domain/rules';
import { can, type StaffAction } from '../../domain/permissions';
import { studioDay } from '../../domain/time';

// ---------------------------------------------------------------------------------------------- loose client typing

/* The real SupabaseClient type isn't available offline. Keep `any` confined to the client object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type Row = Record<string, unknown>;
interface DbError { message?: string; code?: string; details?: string; hint?: string; name?: string; context?: unknown }
interface DbResult { data: unknown; error: DbError | null }

// ---------------------------------------------------------------------------------------------- small helpers

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const optStr = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));
const num = (v: unknown, d = 0): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return d;
};
const optNum = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : num(v));
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 't';
/** Postgres timestamptz -> ISO UTC string. */
const iso = (v: unknown): ISODateTime => {
  const s = str(v);
  if (!s) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
};
const optIso = (v: unknown): ISODateTime | undefined => (v === null || v === undefined || v === '' ? undefined : iso(v));
const nullableIso = (v: unknown): ISODateTime | null | undefined => (v === undefined ? undefined : v === null ? null : iso(v));
const optDate = (v: unknown): ISODate | undefined => (v ? str(v).slice(0, 10) : undefined);
const ids = (v: unknown): ID[] | undefined => (Array.isArray(v) && v.length ? v.map(str) : undefined);
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Drop undefined props so optional fields are simply absent. */
function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

const ROLE_ORDER: Record<StaffRole, number> = { owner: 0, manager: 1, front_desk: 2, instructor: 3 };

// ---------------------------------------------------------------------------------------------- row mappers

function toSettings(r: Row): StudioSettings {
  return clean({
    name: str(r.name), timezone: str(r.timezone) || 'Australia/Sydney', address: str(r.address), email: str(r.email),
    phone: optStr(r.phone), abn: optStr(r.abn), gstRegistered: bool(r.gst_registered),
    cancelWindowHours: num(r.cancel_window_hours, 3), waitlistCutoffHours: num(r.waitlist_cutoff_hours, 1),
    lateCancelFeeCents: num(r.late_cancel_fee_cents), noShowFeeCents: num(r.no_show_fee_cents),
    bookingWindowDays: num(r.booking_window_days, 14), defaultCapacity: num(r.default_capacity, 14),
    waiverText: str(r.waiver_text), healthQuestions: arr(r.health_questions).map(str),
    cancellationPolicyText: str(r.cancellation_policy_text), waitlistPolicyText: str(r.waitlist_policy_text),
  });
}
const SETTINGS_COLS: Record<keyof StudioSettings, string> = {
  name: 'name', timezone: 'timezone', address: 'address', email: 'email', phone: 'phone', abn: 'abn',
  gstRegistered: 'gst_registered', cancelWindowHours: 'cancel_window_hours', waitlistCutoffHours: 'waitlist_cutoff_hours',
  lateCancelFeeCents: 'late_cancel_fee_cents', noShowFeeCents: 'no_show_fee_cents', bookingWindowDays: 'booking_window_days',
  defaultCapacity: 'default_capacity', waiverText: 'waiver_text', healthQuestions: 'health_questions',
  cancellationPolicyText: 'cancellation_policy_text', waitlistPolicyText: 'waitlist_policy_text',
};

function toStaff(r: Row, pay?: number): Staff {
  return clean({
    id: str(r.id), name: str(r.name), email: str(r.email), phone: optStr(r.phone),
    role: (str(r.role) || 'instructor') as StaffRole, bio: optStr(r.bio), photoUrl: optStr(r.photo_url),
    payPerClassCents: pay, active: r.active === undefined ? true : bool(r.active),
  });
}

function toClient(r: Row, staffNotes?: string): Client {
  const hf = r.health_form && typeof r.health_form === 'object' ? (r.health_form as Row) : undefined;
  const healthForm: HealthForm | undefined = hf
    ? clean({
        answers: Object.fromEntries(Object.entries(obj(hf.answers)).map(([k, v]) => [k, str(v)])),
        injuries: optStr(hf.injuries),
        pregnantOrPostnatal: hf.pregnantOrPostnatal === undefined ? undefined : bool(hf.pregnantOrPostnatal),
        submittedAt: iso(hf.submittedAt ?? r.waiver_signed_at),
      })
    : undefined;
  const notes = staffNotes ?? optStr(r.staff_notes);
  return clean({
    id: str(r.id), firstName: str(r.first_name), lastName: str(r.last_name), email: str(r.email), phone: optStr(r.phone),
    birthday: optDate(r.birthday), photoUrl: optStr(r.photo_url), createdAt: iso(r.created_at), staffNotes: notes || undefined,
    injuries: optStr(r.injuries),
    emergencyContactName: optStr(r.emergency_contact_name), emergencyContactPhone: optStr(r.emergency_contact_phone),
    waiverSignedAt: optIso(r.waiver_signed_at), healthForm, marketingOptIn: bool(r.marketing_opt_in),
    source: optStr(r.source) as Client['source'], archived: bool(r.archived),
  });
}

function toClassType(r: Row): ClassType {
  return clean({
    id: str(r.id), name: str(r.name), description: str(r.description), durationMin: num(r.duration_min, 55),
    color: str(r.color) || '#5069AC', defaultCapacity: num(r.default_capacity, 14), level: optStr(r.level),
    bookingNote: optStr(r.booking_note), bookable: bool(r.bookable), active: bool(r.active), imageUrl: optStr(r.image_url),
  });
}

/** studios row -> Studio. Branding is stored as JSON in the Studio shape (camelCase). */
function toStudio(r: Row): Studio {
  return clean({
    id: str(r.id), slug: str(r.slug), name: str(r.name), timezone: str(r.timezone) || 'Australia/Sydney', currency: str(r.currency) || 'AUD',
    locale: str(r.locale) || 'en-AU', email: str(r.email), phone: optStr(r.phone), address: str(r.address), website: optStr(r.website),
    taxId: optStr(r.tax_id), taxIdLabel: str(r.tax_id_label) || 'ABN', taxName: str(r.tax_name) || 'GST',
    taxRate: r.tax_rate === undefined || r.tax_rate === null ? 0.1 : num(r.tax_rate), taxRegistered: r.tax_registered === undefined ? true : bool(r.tax_registered),
    status: (str(r.status) || 'live') as StudioStatus, branding: obj(r.branding) as unknown as StudioBranding,
    customDomains: Array.isArray(r.custom_domains) && r.custom_domains.length ? r.custom_domains.map(str) : undefined,
    createdAt: iso(r.created_at),
  });
}
const STUDIO_COLS: Record<string, string> = {
  slug: 'slug', name: 'name', timezone: 'timezone', currency: 'currency', locale: 'locale', email: 'email', phone: 'phone', address: 'address',
  website: 'website', taxId: 'tax_id', taxIdLabel: 'tax_id_label', taxName: 'tax_name', taxRate: 'tax_rate', taxRegistered: 'tax_registered',
  status: 'status', branding: 'branding', customDomains: 'custom_domains',
};
/** Studio patch -> the JSON update_my_studio / platform_update_studio take (snake_case keys). */
function studioPatchRow(p: Partial<Studio>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(p)) { const col = STUDIO_COLS[k]; if (col && v !== undefined) out[col] = v ?? ''; }
  return out;
}

function toTemplate(r: Row): ScheduleTemplate {
  return clean({
    id: str(r.id), classTypeId: str(r.class_type_id), weekday: num(r.weekday), startTime: str(r.start_time).slice(0, 5),
    instructorId: str(r.instructor_id), capacity: optNum(r.capacity), startsOn: str(r.starts_on).slice(0, 10),
    endsOn: optDate(r.ends_on), active: bool(r.active),
  });
}

function toSession(r: Row): SessionWithCounts {
  const capacity = num(r.capacity);
  const booked = num(r.booked_count);
  return clean({
    id: str(r.id), classTypeId: str(r.class_type_id), templateId: optStr(r.template_id), startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at), instructorId: str(r.instructor_id), capacity,
    status: (str(r.status) || 'scheduled') as ClassSession['status'], note: optStr(r.note), cancelReason: optStr(r.cancel_reason),
    bookedCount: booked, waitlistCount: num(r.waitlist_count),
    spotsLeft: r.spots_left === undefined ? Math.max(0, capacity - booked) : num(r.spots_left),
  });
}

function toProduct(r: Row): Product {
  const retail = r.kind === 'retail';
  return clean({
    id: str(r.id), kind: str(r.kind) as ProductKind, name: str(r.name), description: str(r.description),
    priceCents: num(r.price_cents), active: bool(r.active), highlight: optStr(r.highlight), sortOrder: num(r.sort_order),
    credits: retail ? undefined : nullableNum(r.credits),
    validityDays: retail ? undefined : nullableNum(r.validity_days),
    billingInterval: optStr(r.billing_interval) as Product['billingInterval'],
    newClientsOnly: r.new_clients_only === undefined ? undefined : bool(r.new_clients_only),
    classTypeIds: ids(r.class_type_ids),
    stock: retail ? nullableNum(r.stock) : undefined,
  });
}

function toPass(r: Row): Pass {
  const adj = arr(r.adjustments ?? r.pass_adjustments).map((a) => {
    const x = obj(a);
    return clean({ at: iso(x.at), staffId: optStr(x.staff_id), delta: num(x.delta), reason: str(x.reason) });
  }).sort((a, b) => a.at.localeCompare(b.at));
  return clean({
    id: str(r.id), clientId: str(r.client_id), productId: str(r.product_id), kind: str(r.kind) as Pass['kind'], name: str(r.name),
    status: (str(r.status) || 'active') as PassStatus, purchasedAt: iso(r.purchased_at), activatedAt: optIso(r.activated_at),
    // undefined = not activated yet (expiry counted from first use); null = activated and never expires.
    expiresAt: r.expires_at ? iso(r.expires_at) : r.activated_at ? null : undefined,
    credits: nullableNum(r.credits), creditsUsed: num(r.credits_used),
    billingInterval: optStr(r.billing_interval) as Pass['billingInterval'],
    nextBillingAt: optIso(r.next_billing_at), pausedFrom: optDate(r.paused_from), pausedUntil: optDate(r.paused_until),
    priceCents: num(r.price_cents), classTypeIds: ids(r.class_type_ids), adjustments: adj.length ? adj : undefined,
  });
}

function toBooking(r: Row): Booking {
  return clean({
    id: str(r.id), sessionId: str(r.session_id), clientId: str(r.client_id), status: str(r.status) as BookingStatus,
    passId: optStr(r.pass_id), createdAt: iso(r.created_at), waitlistPosition: optNum(r.waitlist_position),
    promotedFromWaitlistAt: optIso(r.promoted_from_waitlist_at), cancelledAt: optIso(r.cancelled_at),
    checkedInAt: optIso(r.checked_in_at), source: (str(r.source) || 'client') as Booking['source'],
    bookedByStaffId: optStr(r.booked_by_staff_id),
  });
}

function toSale(r: Row): Sale {
  const items: SaleItem[] = arr(r.items ?? r.sale_items).map((i) => {
    const x = obj(i);
    return clean({ productId: optStr(x.product_id), name: str(x.name), qty: num(x.qty, 1), unitCents: num(x.unit_cents) });
  });
  return clean({
    id: str(r.id), clientId: optStr(r.client_id), items, totalCents: num(r.total_cents), method: str(r.method) as PaymentMethod,
    staffId: optStr(r.staff_id), createdAt: iso(r.created_at), stripePaymentIntentId: optStr(r.stripe_payment_intent_id),
    refundedAt: optIso(r.refunded_at), refundedCents: num(r.refunded_cents) || undefined, note: optStr(r.note),
  });
}

function toReport(r: Row, range: ReportRange): StudioReport {
  const centsMap = (v: unknown): Record<string, number> =>
    Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, num(x)]));
  return {
    range,
    revenueCents: num(r.revenue_cents), refundsCents: num(r.refunds_cents),
    revenueByMethod: centsMap(r.revenue_by_method) as StudioReport['revenueByMethod'],
    revenueByKind: centsMap(r.revenue_by_kind) as StudioReport['revenueByKind'],
    salesCount: num(r.sales_count), classesRun: num(r.classes_run), totalBookings: num(r.total_bookings),
    attended: num(r.attended), noShows: num(r.no_shows), lateCancels: num(r.late_cancels), avgFillPct: num(r.avg_fill_pct),
    newClients: num(r.new_clients), activeMemberships: num(r.active_memberships), activePacks: num(r.active_packs),
    byInstructor: arr(r.by_instructor).map((x) => {
      const o = obj(x);
      return { staffId: str(o.staff_id), name: str(o.name), classes: num(o.classes), attendees: num(o.attendees), payCents: num(o.pay_cents) };
    }),
    byClassType: arr(r.by_class_type).map((x) => {
      const o = obj(x);
      return { classTypeId: str(o.class_type_id), name: str(o.name), classes: num(o.classes), attendees: num(o.attendees), avgFillPct: num(o.avg_fill_pct) };
    }),
    topSlots: arr(r.top_slots).map((x) => {
      const o = obj(x);
      return { label: str(o.label), avgAttendees: num(o.avg_attendees) };
    }),
  };
}

/** Build an update row: undefined -> leave the column alone; null clears it. */
function patchRow(pairs: [string, unknown][]): Row {
  const out: Row = {};
  for (const [k, v] of pairs) if (v !== undefined) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------- errors

const GENERIC = 'Something went wrong. Please try again.';

/** Which kind of emailed link signed the user in: an invite (new staff, imported clients) or forgot password. */
export type PasswordLinkKind = 'invite' | 'recovery';
/** '#access_token=…&type=invite' -> 'invite'. Other link types (signup confirm, magic link, email change) -> null. */
export function passwordLinkKind(hash: string | undefined | null): PasswordLinkKind | null {
  const m = /(?:^|[#&?])type=(invite|recovery)(?:&|$)/.exec(hash ?? '');
  return m ? (m[1] as PasswordLinkKind) : null;
}
/** How long a link waits for the app to register its "Choose a new password" screen before the prompt fallback. */
export const PASSWORD_HANDLER_GRACE_MS = 1500;
/**
 * upsertClient's result. pendingEmail is set when a client changed their own email: everything else is saved,
 * and a confirm link went to the new address (the email itself changes once they tap it). Not an error.
 */
export type ClientSaveResult = Client & { pendingEmail?: string };
const NO_PERMISSION = 'You don’t have permission to do that.';

/** Turn a PostgREST / Postgres / Auth / Functions error into a StoreError. */
export function toStoreError(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  const err = obj(e) as DbError;
  const msg = str(err.message);
  // Our database functions raise 'CODE: friendly message'.
  const m = /^([A-Z][A-Z_]+):\s*([\s\S]*)$/.exec(msg);
  if (m && m[1]) return new StoreError(m[1], m[2] ?? '');
  switch (err.code) {
    case '42501': return new StoreError('NOT_ALLOWED', NO_PERMISSION);
    case 'PGRST116': return new StoreError('NOT_FOUND', 'We couldn’t find that.');
    case '22P02': return new StoreError('NOT_FOUND', 'We couldn’t find that.');
    case '23505':
      if (/email/i.test(`${msg} ${str(err.details)}`)) return new StoreError('EMAIL_TAKEN', 'That email is already in use.');
      return new StoreError('ALREADY_EXISTS', 'That already exists.');
    case '23514': return new StoreError('INVALID', 'Some of those details aren’t valid. Please check and try again.');
    case '23503': return new StoreError('NOT_ALLOWED', 'That’s still in use, so it can’t be removed.');
    default: break;
  }
  if (/row-level security|permission denied/i.test(msg)) return new StoreError('NOT_ALLOWED', NO_PERMISSION);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new StoreError('OFFLINE', 'You seem to be offline. Check your connection and try again.');
  if (typeof console !== 'undefined') console.error('[store]', e);
  return new StoreError('ERROR', msg && msg.length < 140 ? msg : GENERIC);
}

// ---------------------------------------------------------------------------------------------- the store

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AVATARS = 'avatars';
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Optional text from a form: '' and undefined both clear the column. */
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Which app is running: the client app at /, the studio app at /studio/ and the admin app at /admin/ keep separate logins. */
function currentApp(): 'client' | 'studio' | 'admin' {
  if (typeof location === 'undefined') return 'client';
  return location.pathname.includes('/admin') ? 'admin' : location.pathname.includes('/studio') ? 'studio' : 'client';
}

/**
 * One supabase-js client per app, shared by the PlatformStore and the studio-bound store, so there's one session.
 * The studio a request is for goes in the x-studio header, added to every request by our fetch wrapper (the
 * database scopes RLS and RPCs to it: supabase/migrations/0007_platform.sql).
 */
export interface SharedClient {
  sb: Loose;
  app: 'client' | 'studio' | 'admin';
  /** x-studio header value (studio id). Mutable: set when a store is bound. */
  hdr: Record<string, string>;
  /** Auth events, fanned out to whoever is listening (stores come and go; the client stays). */
  onAuth: Set<(event: string) => void>;
  /** A reset / invite link that signed someone in, waiting for a store to show the new-password screen. */
  pendingLink: PasswordLinkKind | null;
  onLink: Set<(kind: PasswordLinkKind) => void>;
}

export function createSharedClient(url: string, anonKey: string, app = currentApp()): SharedClient {
  // Invite and password-reset links land here with '#access_token=…&type=invite|recovery'. Note which before
  // supabase-js reads (and clears) the tokens from the address.
  let linkType: PasswordLinkKind | null = typeof location !== 'undefined' ? passwordLinkKind(location.hash) : null;
  const hdr: Record<string, string> = {};
  const baseFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;
  const studioFetch = baseFetch && ((input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (hdr['x-studio']) h.set('x-studio', hdr['x-studio']); else h.delete('x-studio');
    return baseFetch(input, { ...init, headers: h });
  });
  const make = createClient as unknown as (u: string, k: string, o?: object) => Loose;
  const sb = make(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: `spc-live-auth-${app}` },
    global: { headers: hdr, ...(studioFetch ? { fetch: studioFetch } : {}) },
  });
  const shared: SharedClient = { sb, app, hdr, onAuth: new Set(), pendingLink: null, onLink: new Set() };
  sb.auth.onAuthStateChange((event: string) => {
    for (const l of [...shared.onAuth]) { try { l(event); } catch (e) { console.error(e); } }
    // Recovery links fire PASSWORD_RECOVERY; invite links just sign in. Only once per link: supabase-js
    // also fires SIGNED_IN when the tab regains focus, and that mustn't reopen the screen.
    if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && linkType)) {
      const kind: PasswordLinkKind = linkType ?? 'recovery';
      linkType = null;
      // Out of supabase-js's callback first (it warns about auth calls made inside it).
      setTimeout(() => {
        if (shared.onLink.size) shared.onLink.forEach((fn) => fn(kind));
        else shared.pendingLink = kind;
      }, 0);
    }
  });
  return shared;
}

/** The object path inside the avatars bucket for one of our public URLs, if it is one. */
export function avatarPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const i = url.indexOf(`/object/public/${AVATARS}/`);
  return i < 0 ? null : decodeURIComponent(url.slice(i + `/object/public/${AVATARS}/`.length).split('?')[0] ?? '');
}

/** 'data:image/jpeg;base64,...' -> bytes + type. Only images. */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; type: string; ext: string } {
  const m = /^data:(image\/(jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m || !m[3]) throw new StoreError('INVALID', 'That photo couldn’t be read. Please try another one.');
  const bin = atob(m[3].replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > 1_000_000) throw new StoreError('INVALID', 'That photo is too big. Please pick a smaller one.');
  const type = m[1] === 'image/jpg' ? 'image/jpeg' : (m[1] as string);
  return { bytes, type, ext: type === 'image/jpeg' ? 'jpg' : type.slice(6) };
}

class SupabaseStore implements DataStore {
  readonly mode = 'live' as const;
  readonly features: Partial<FeatureStores> = {};
  private sb: Loose;
  private app: 'client' | 'studio' | 'admin';
  private shared: SharedClient;
  /** The bound studio (resolved to the database's default studio when none was given, e.g. in tests). */
  private studio: Studio | null;
  private studioReady: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private channel: Loose = null;
  private authSub: { unsubscribe: () => void } | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private me: Promise<AuthUser | null> | null = null;
  /** Date ranges we've already asked the database to fill from the weekly timetable (this session). */
  private ensured = new Set<string>();
  /** "Choose a new password" screen of the app (onPasswordRecovery). Gets 'invite' or 'recovery'. */
  private recoveryHandler: ((kind?: PasswordLinkKind) => void) | null = null;
  /** A reset/invite link arrived before the app registered its handler: handed over when it does. */
  private pendingLink: PasswordLinkKind | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, anonKey: string, opts: { studio?: Studio; shared?: SharedClient } = {}) {
    this.shared = opts.shared ?? createSharedClient(url, anonKey);
    this.sb = this.shared.sb;
    this.app = this.shared.app;
    this.studio = opts.studio ?? null;
    if (this.studio) this.shared.hdr['x-studio'] = this.studio.id;
    // Sign in/out (any tab) or a password-reset link invalidates who-am-I.
    const onAuth = (event: string) => {
      if (event === 'TOKEN_REFRESHED') return;
      this.me = null;
      this.ensured.clear();
      this.emit();
    };
    this.shared.onAuth.add(onAuth);
    const onLink = (kind: PasswordLinkKind) => this.passwordLinkArrived(kind);
    this.shared.onLink.add(onLink);
    if (this.shared.pendingLink) { const k = this.shared.pendingLink; this.shared.pendingLink = null; setTimeout(() => onLink(k), 0); }
    this.authSub = { unsubscribe: () => { this.shared.onAuth.delete(onAuth); this.shared.onLink.delete(onLink); } };
    const ctx = this.featureContext();
    for (const f of liveFeatures()) (this.features as Record<string, unknown>)[f.name] = f.create(ctx);
  }

  get studioId(): ID { return this.studio?.id ?? ''; }

  /** No studio given: use the database's default studio (the Snowy single-studio deployment, and the tests). */
  private ready(): Promise<void> {
    if (this.studio) { this.shared.hdr['x-studio'] = this.studio.id; return Promise.resolve(); }
    this.studioReady ??= (async () => {
      const res = (await this.sb.from('studios').select('*').eq('is_default', true).limit(1)) as DbResult;
      const row = arr(res.data)[0];
      if (res.error || !row) { this.studioReady = null; throw toStoreError(res.error ?? { message: 'NO_STUDIO: This app isn’t linked to a studio yet.' }); }
      this.studio = toStudio(obj(row));
      this.shared.hdr['x-studio'] = this.studio.id;
    })();
    return this.studioReady;
  }

  private featureContext(): LiveFeatureContext {
    const self = this;
    return {
      get studioId() { return self.studioId; },
      get sb() { return self.sb; },
      rpc: (name, args) => this.rpc(name, (args ?? {}) as Row),
      rows: (q) => this.rows(q as PromiseLike<DbResult>),
      read: async (fn) => { await this.ready(); return fn(); },
      write: (fn) => this.write(async () => { await this.ready(); return fn(); }),
      currentUser: () => this.currentUser(),
      error: (code, msg) => new StoreError(code, msg),
    };
  }

  // ------------------------------------------------------------------ plumbing

  private async run(q: PromiseLike<DbResult>): Promise<unknown> {
    await this.ready();
    let res: DbResult;
    try { res = await q; } catch (e) { throw toStoreError(e); }
    if (res.error) throw toStoreError(res.error);
    return res.data;
  }
  private async rows(q: PromiseLike<DbResult>): Promise<Row[]> {
    return arr(await this.run(q)).map(obj);
  }
  /** First row, or `code` (RLS-filtered updates come back empty, so the message can say why). */
  private async one(q: PromiseLike<DbResult>, notFound = 'We couldn’t find that.', code = 'NOT_FOUND'): Promise<Row> {
    const d = await this.run(q);
    const r = Array.isArray(d) ? d[0] : d;
    if (!r || typeof r !== 'object') throw new StoreError(code, notFound);
    return r as Row;
  }
  private rpc(fn: string, args: Row = {}): Promise<unknown> {
    return this.run(this.sb.rpc(fn, args));
  }
  /** Call an edge function; its {code, message} JSON errors become StoreErrors. */
  private async invoke(fn: string, body: Row): Promise<Row> {
    let res: DbResult;
    await this.ready();
    try { res = await this.sb.functions.invoke(fn, { body: { ...body, studioId: this.studioId } }); } catch (e) { throw toStoreError(e); }
    if (res.error) {
      const ctx = obj(res.error).context as { json?: () => Promise<unknown> } | undefined;
      if (ctx && typeof ctx.json === 'function') {
        let j: Row = {};
        try { j = obj(await ctx.json()); } catch { /* not JSON */ }
        if (j.code || j.message) throw new StoreError(str(j.code) || 'ERROR', str(j.message) || GENERIC);
      }
      throw toStoreError(res.error);
    }
    return obj(res.data);
  }

  private emit(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error(e); } }
    }, 120);
  }
  /** Run a write, then tell listeners straight away (realtime also fires, but feedback should be instant). */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    const out = await fn();
    this.emit();
    return out;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    if (!this.channel) {
      const ch = this.sb.channel(`live-${this.studioId || 'default'}`);
      // RLS applies: clients only hear about their own bookings/passes; class_sessions changes
      // (bumped on every booking) tell everyone that spot counts moved. Only this studio's rows.
      for (const table of ['bookings', 'class_sessions', 'passes']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table, ...(this.studioId ? { filter: `studio_id=eq.${this.studioId}` } : {}) }, () => this.emit());
      }
      ch.subscribe();
      this.channel = ch;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.channel) {
        try { this.sb.removeChannel(this.channel); } catch { /* ignore */ }
        this.channel = null;
      }
    };
  }

  // ------------------------------------------------------------------ auth

  currentUser(): Promise<AuthUser | null> {
    if (!this.me) {
      const p = (async () => {
        const { data } = await this.sb.auth.getSession();
        if (!data?.session) return null;
        await this.ready();
        return this.whoami();
      })();
      p.catch(() => { this.me = null; });
      this.me = p;
    }
    return this.me;
  }

  private async whoami(): Promise<AuthUser | null> {
    const r = await this.rpc('whoami');
    if (!r || typeof r !== 'object') return null;
    const o = r as Row;
    if (o.kind === 'staff') return { kind: 'staff', staffId: str(o.staff_id), email: str(o.email), name: str(o.name), role: str(o.role) as StaffRole };
    return { kind: 'client', clientId: str(o.client_id), email: str(o.email), name: str(o.name) };
  }

  private async meOrNull(): Promise<AuthUser | null> {
    try { return await this.currentUser(); } catch { return null; }
  }
  private async requireMe(): Promise<AuthUser> {
    const u = await this.meOrNull();
    if (!u) throw new StoreError('AUTH_REQUIRED', 'Please sign in first.');
    return u;
  }
  private async isStaff(): Promise<boolean> {
    return (await this.meOrNull())?.kind === 'staff';
  }
  /** Signed-in staff member whose role can do `action` (src/domain/permissions.ts); the database checks again. */
  private async requireStaff(action: StaffAction): Promise<Extract<AuthUser, { kind: 'staff' }>> {
    const u = await this.requireMe();
    if (u.kind !== 'staff') throw new StoreError('NOT_ALLOWED', 'Only studio staff can do that.');
    if (!can(u.role, action)) throw new StoreError('NOT_ALLOWED', 'Your role doesn’t have access to that.');
    return u;
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    if (!email?.trim() || !password) throw new StoreError('INVALID_LOGIN', 'Enter your email and password.');
    const { error } = await this.sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) {
      const m = str(obj(error).message);
      if (/confirm/i.test(m)) throw new StoreError('CONFIRM_EMAIL', 'Please confirm your email first. Check your inbox for the link.');
      if (/fetch|network/i.test(m)) throw toStoreError(error);
      throw new StoreError('INVALID_LOGIN', 'That email and password don’t match. Try again or reset your password.');
    }
    this.me = null;
    let u = await this.currentUser();
    // One login, many studios: a client of another studio signing in here joins this one.
    if (!u && this.app === 'client') {
      try { await this.rpc('join_studio'); } catch { /* not open to new clients */ }
      this.me = null;
      u = await this.currentUser();
    }
    if (!u) {
      await this.sb.auth.signOut();
      this.me = null;
      throw new StoreError('NOT_FOUND', 'Your login worked, but your account isn’t set up yet. Please contact the studio.');
    }
    // Same rule as the demo: the studio app is for staff, the client app for clients.
    if (this.app !== 'client' && u.kind !== 'staff') {
      await this.signOut();
      throw new StoreError('NOT_ALLOWED', `This sign-in is for studio staff. Clients can use the ${this.studio?.name ?? 'studio’s'} app.`);
    }
    if (this.app === 'client' && u.kind === 'staff') {
      await this.signOut();
      throw new StoreError('NOT_ALLOWED', 'Staff accounts sign in to the studio app.');
    }
    this.emit();
    return u;
  }

  async signUpClient(input: { firstName: string; lastName: string; email: string; phone?: string; password: string; marketingOptIn?: boolean }): Promise<AuthUser> {
    const email = (input.email ?? '').trim().toLowerCase();
    await this.ready();
    if (!input.firstName?.trim()) throw new StoreError('INVALID', 'Please enter your first name.');
    if (!EMAIL_RE.test(email)) throw new StoreError('INVALID', 'Please enter a valid email address.');
    if (!input.password || input.password.length < 8) throw new StoreError('INVALID', 'Please choose a password with at least 8 characters.');
    const redirect = typeof location !== 'undefined' ? location.href.split('#')[0] : undefined;
    const { data, error } = await this.sb.auth.signUp({
      email,
      password: input.password,
      options: {
        data: { first_name: input.firstName.trim(), last_name: (input.lastName ?? '').trim(), phone: input.phone?.trim() ?? '', marketing_opt_in: !!input.marketingOptIn, studio: this.studioId },
        ...(redirect ? { emailRedirectTo: redirect } : {}),
      },
    });
    if (error) {
      const m = str(obj(error).message);
      if (/already|registered|exists/i.test(m)) throw new StoreError('EMAIL_TAKEN', 'There’s already an account with that email. Try signing in or resetting your password.');
      if (/password/i.test(m)) throw new StoreError('INVALID', 'Please choose a longer password (at least 8 characters).');
      throw toStoreError(error);
    }
    // With "Confirm email" on (recommended) there's no session until they tap the link.
    if (!data?.session) {
      throw new StoreError('CONFIRM_EMAIL', `Almost there! We’ve emailed ${email}. Tap the link to confirm, then sign in.`);
    }
    this.me = null;
    const u = await this.currentUser();
    if (!u) throw new StoreError('ERROR', 'Your account was created. Please sign in.');
    this.emit();
    return u;
  }

  async signOut(): Promise<void> {
    await this.sb.auth.signOut();
    this.me = null;
    this.ensured.clear();
    this.emit();
  }

  async requestPasswordReset(email: string): Promise<void> {
    const e = (email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new StoreError('INVALID', 'Please enter a valid email address.');
    const redirect = typeof location !== 'undefined' ? location.href.split('#')[0] : undefined;
    const { error } = await this.sb.auth.resetPasswordForEmail(e, redirect ? { redirectTo: redirect } : {});
    if (error) throw toStoreError(error);
  }

  /**
   * Set a new password after opening a reset or invite link (the link signed them in).
   * DataStore optional method; the apps' "Choose a new password" screens call it.
   */
  async setNewPassword(password: string): Promise<void> {
    if (!password || password.length < 8) throw new StoreError('INVALID', 'Please choose a password with at least 8 characters.');
    const { error } = await this.sb.auth.updateUser({ password });
    if (error) {
      const e = obj(error);
      const m = `${str(e.code)} ${str(e.message)}`;
      if (/same_password|different from the old/i.test(m)) throw new StoreError('INVALID', 'That’s the password you already have. Please choose a new one.');
      if (/weak_password|password should|at least/i.test(m)) throw new StoreError('INVALID', 'Please choose a stronger password (at least 8 characters, not too easy to guess).');
      if (/session|jwt|expired|not authenticated|missing/i.test(m)) throw new StoreError('LINK_EXPIRED', 'That link has expired. Please ask for a new one from the sign-in screen.');
      throw toStoreError(error);
    }
    this.emit();
  }
  /**
   * DataStore optional method: the app's "Choose a new password" screen takes over from here. The handler gets
   * 'invite' (an invite link: new staff, imported clients) or 'recovery' (forgot password). A link that arrived
   * before the handler was registered is handed over straight away.
   */
  onPasswordRecovery(handler: (kind?: PasswordLinkKind) => void): Unsubscribe {
    this.recoveryHandler = handler;
    if (this.pendingLink) {
      const kind = this.pendingLink;
      this.pendingLink = null;
      if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
      setTimeout(() => this.recoveryHandler?.(kind), 0);
    }
    return () => { if (this.recoveryHandler === handler) this.recoveryHandler = null; };
  }
  private passwordLinkArrived(kind: PasswordLinkKind): void {
    if (this.recoveryHandler) { this.recoveryHandler(kind); return; }
    // No screen registered (yet). Give the app a moment to register one; only then fall back to a prompt.
    this.pendingLink = kind;
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.recoveryHandler || !this.pendingLink) return;
      this.pendingLink = null;
      void this.promptForNewPassword();
    }, PASSWORD_HANDLER_GRACE_MS);
  }
  /** Last resort when no app screen is registered (blocked in Capacitor and sandboxed frames, so the apps register one). */
  private async promptForNewPassword(): Promise<void> {
    const g = globalThis as { prompt?: (msg: string) => string | null; alert?: (msg: string) => void };
    if (typeof g.prompt !== 'function') return;
    for (let i = 0; i < 3; i++) {
      let pw: string | null;
      try { pw = g.prompt(`Choose a new password for ${this.studio?.name ?? 'your account'} (at least 8 characters)`); } catch { return; }
      if (pw === null) return;
      try { await this.setNewPassword(pw); g.alert?.('All set. Your new password is saved.'); return; }
      catch (e) { try { g.alert?.(e instanceof StoreError ? e.message : GENERIC); } catch { return; } }
    }
  }

  async demoPersonas(): Promise<AuthUser[]> { return []; }

  // ------------------------------------------------------------------ the studio (details + branding)

  async getStudio(): Promise<Studio> {
    await this.ready();
    return toStudio(await this.one(this.sb.from('studios').select('*').eq('id', this.studioId).limit(1), 'We couldn’t find this studio.'));
  }

  async updateStudio(patch: StudioPatch): Promise<Studio> {
    return this.write(async () => {
      await this.requireStaff('settings');
      const r = toStudio(obj(await this.rpc('update_my_studio', { p_patch: studioPatchRow(patch) })));
      if (this.studio) this.studio = r;
      return r;
    });
  }

  // ------------------------------------------------------------------ settings

  async getSettings(): Promise<StudioSettings> {
    await this.ready();
    return toSettings(await this.one(this.sb.from('studio_settings').select('*').eq('studio_id', this.studioId).limit(1)));
  }

  async updateSettings(patch: Partial<StudioSettings>): Promise<StudioSettings> {
    return this.write(async () => {
      await this.requireStaff('settings');
      for (const k of ['cancelWindowHours', 'waitlistCutoffHours', 'lateCancelFeeCents', 'noShowFeeCents', 'bookingWindowDays', 'defaultCapacity'] as const) {
        const v = patch[k];
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new StoreError('INVALID', `${k} must be zero or more.`);
      }
      const row: Row = {};
      for (const [k, v] of Object.entries(patch) as [keyof StudioSettings, unknown][]) {
        const col = SETTINGS_COLS[k];
        if (col && v !== undefined) row[col] = v === '' && (k === 'phone' || k === 'abn') ? null : v;
      }
      await this.ready();
      const r = await this.one(this.sb.from('studio_settings').update(row).eq('studio_id', this.studioId).select('*'),
        'You don’t have permission to change settings.', 'NOT_ALLOWED');
      return toSettings(r);
    });
  }

  // ------------------------------------------------------------------ staff

  async listStaff(opts: { includeInactive?: boolean } = {}): Promise<Staff[]> {
    let list: Staff[];
    if (await this.isStaff()) {
      const [rows, pay] = await Promise.all([
        this.rows(this.sb.from('staff').select('*')),
        this.rows(this.sb.from('staff_pay').select('*')), // owner + manager only (RLS): empty for everyone else
      ]);
      const payBy = new Map(pay.map((p) => [str(p.staff_id), num(p.pay_per_class_cents)]));
      list = rows.map((r) => toStaff(r, payBy.get(str(r.id))));
    } else {
      list = (await this.rows(this.sb.from('staff_public').select('*'))).map((r) => toStaff(r));
    }
    return list
      .filter((s) => opts.includeInactive || s.active)
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
  }

  async upsertStaff(staff: Omit<Staff, 'id'> & { id?: ID }): Promise<Staff> {
    return this.write(async () => {
      const me = await this.requireStaff('staff');
      if (!staff.name?.trim()) throw new StoreError('INVALID', 'Please enter a name.');
      const email = (staff.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new StoreError('INVALID', 'Please enter a valid email address.');
      const all = await this.listStaff({ includeInactive: true });
      const existing = staff.id ? all.find((s) => s.id === staff.id) : undefined;
      if (all.some((s) => s.id !== existing?.id && s.email.toLowerCase() === email)) throw new StoreError('EMAIL_TAKEN', 'That email is already in use.');
      const payChanged = has(staff, 'payPerClassCents') && (staff.payPerClassCents ?? undefined) !== (existing?.payPerClassCents ?? undefined);
      if (payChanged && !can(me.role, 'staff_pay')) throw new StoreError('NOT_ALLOWED', 'Only the owner can change pay rates.');
      const owners = all.filter((s) => s.role === 'owner' && s.active && s.id !== existing?.id).length + (staff.role === 'owner' && staff.active ? 1 : 0);
      if (owners === 0) throw new StoreError('INVALID', 'The studio needs at least one active owner.');
      const row = patchRow([
        ['name', staff.name.trim()], ['email', email], ['phone', has(staff, 'phone') ? textOrNull(staff.phone) : undefined],
        ['role', staff.role], ['bio', has(staff, 'bio') ? textOrNull(staff.bio) : undefined],
        ['photo_url', has(staff, 'photoUrl') ? textOrNull(staff.photoUrl) : undefined], ['active', staff.active],
      ]);
      const r = staff.id
        ? await this.one(this.sb.from('staff').update(row).eq('id', staff.id).select('*'), 'You don’t have permission to edit staff.', 'NOT_ALLOWED')
        : await this.one(this.sb.from('staff').insert(row).select('*'));
      let pay = existing?.payPerClassCents;
      if (payChanged) {
        await this.run(this.sb.from('staff_pay').upsert({ staff_id: str(r.id), pay_per_class_cents: staff.payPerClassCents ?? 0, updated_at: new Date().toISOString() }));
        pay = staff.payPerClassCents;
      }
      return toStaff(r, can(me.role, 'reports_pay') ? pay : undefined);
    });
  }

  // ------------------------------------------------------------------ class types & schedule

  async listClassTypes(opts: { includeInactive?: boolean } = {}): Promise<ClassType[]> {
    const rows = await this.rows(this.sb.from('class_types').select('*').order('sort_order').order('name'));
    return rows.map(toClassType).filter((c) => opts.includeInactive || c.active);
  }

  async upsertClassType(ct: Omit<ClassType, 'id'> & { id?: ID }): Promise<ClassType> {
    return this.write(async () => {
      await this.requireStaff('schedule');
      if (!ct.name?.trim()) throw new StoreError('INVALID', 'Please enter a name.');
      if (!(ct.durationMin > 0)) throw new StoreError('INVALID', 'Duration must be more than 0 minutes.');
      const row = patchRow([
        ['name', ct.name.trim()], ['description', ct.description ?? ''], ['duration_min', ct.durationMin], ['color', ct.color],
        ['default_capacity', ct.defaultCapacity], ['level', textOrNull(ct.level)], ['booking_note', textOrNull(ct.bookingNote)],
        ['bookable', ct.bookable], ['active', ct.active], ['image_url', 'imageUrl' in ct ? textOrNull(ct.imageUrl) : undefined],
      ]);
      const r = ct.id
        ? await this.one(this.sb.from('class_types').update(row).eq('id', ct.id).select('*'), 'You don’t have permission to edit classes.', 'NOT_ALLOWED')
        : await this.one(this.sb.from('class_types').insert(row).select('*'));
      return toClassType(r);
    });
  }

  async listTemplates(): Promise<ScheduleTemplate[]> {
    const rows = await this.rows(this.sb.from('schedule_templates').select('*'));
    return rows.map(toTemplate).sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.startTime.localeCompare(b.startTime));
  }

  async upsertTemplate(t: Omit<ScheduleTemplate, 'id'> & { id?: ID }): Promise<ScheduleTemplate> {
    return this.write(async () => {
      await this.requireStaff('schedule');
      if (!(Number.isInteger(t.weekday) && t.weekday >= 0 && t.weekday <= 6)) throw new StoreError('INVALID', 'Choose a day of the week.');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.startTime)) throw new StoreError('INVALID', 'Start time must be HH:mm.');
      const row = patchRow([
        ['class_type_id', t.classTypeId], ['weekday', t.weekday], ['start_time', t.startTime], ['instructor_id', t.instructorId],
        ['capacity', t.capacity ?? null], ['starts_on', t.startsOn], ['ends_on', t.endsOn ?? null], ['active', t.active],
      ]);
      const r = t.id
        ? await this.one(this.sb.from('schedule_templates').update(row).eq('id', t.id).select('*'), 'You don’t have permission to edit the timetable.', 'NOT_ALLOWED')
        : await this.one(this.sb.from('schedule_templates').insert(row).select('*'));
      // Unbooked future classes from this slot are remade with the new details (booked ones keep theirs).
      await this.rpc('refresh_template_sessions', { p_template_id: str(r.id) });
      this.ensured.clear();
      return toTemplate(r);
    });
  }

  async deleteTemplate(id: ID): Promise<void> {
    await this.write(async () => {
      // Future classes nobody booked go; classes with bookings stay as one-offs.
      await this.rpc('delete_template', { p_template_id: id });
      this.ensured.clear();
    });
  }

  async generateSessions(from: ISODate, to: ISODate): Promise<number> {
    return this.write(async () => num(await this.rpc('generate_sessions', { p_from: from, p_to: to })));
  }

  /** Like the demo: make classes from the weekly timetable for the dates being looked at (best effort). */
  private async ensureSessions(from: ISODate, to: ISODate): Promise<void> {
    const key = `${from}|${to}`;
    if (this.ensured.has(key) || !(await this.meOrNull())) return;
    this.ensured.add(key);
    try { await this.rpc('ensure_sessions', { p_from: from, p_to: to }); } catch { this.ensured.delete(key); }
  }

  async listSessions(range: { from: ISODateTime; to: ISODateTime; includeCancelled?: boolean }): Promise<SessionWithCounts[]> {
    if (Number.isNaN(Date.parse(range.from)) || Number.isNaN(Date.parse(range.to))) throw new StoreError('INVALID', 'Invalid date range.');
    await this.ensureSessions(studioDay(range.from), studioDay(range.to));
    let q = this.sb.from('sessions_with_counts').select('*').lt('starts_at', range.to).gt('ends_at', range.from).order('starts_at');
    // DataStore: cancelled classes are included unless the caller excludes them.
    if (range.includeCancelled === false) q = q.eq('status', 'scheduled');
    return (await this.rows(q)).map(toSession);
  }

  async getSession(id: ID): Promise<SessionWithCounts> {
    return toSession(await this.one(this.sb.from('sessions_with_counts').select('*').eq('id', id).limit(1), 'We couldn’t find that class.'));
  }

  async upsertSession(s: Omit<ClassSession, 'id' | 'status'> & { id?: ID; status?: ClassSession['status'] }): Promise<SessionWithCounts> {
    return this.write(async () => {
      await this.requireStaff('schedule');
      if (!(Date.parse(s.endsAt) > Date.parse(s.startsAt))) throw new StoreError('INVALID', 'The class needs to end after it starts.');
      const row = patchRow([
        ['class_type_id', s.classTypeId], ['template_id', s.templateId], ['starts_at', s.startsAt], ['ends_at', s.endsAt],
        ['instructor_id', s.instructorId], ['capacity', s.capacity], ['note', textOrNull(s.note)],
      ]);
      let id = s.id;
      if (id) {
        const current = await this.getSession(id);
        await this.one(this.sb.from('class_sessions').update(row).eq('id', id).select('id'), 'You don’t have permission to edit classes.', 'NOT_ALLOWED');
        // Cancelling goes through cancel_session so bookings are refunded and people are told.
        if (s.status === 'cancelled' && current.status !== 'cancelled') {
          await this.rpc('cancel_session', { p_session_id: id, p_reason: s.cancelReason ?? null });
        }
      } else {
        const r = await this.one(this.sb.from('class_sessions').insert({ ...row, status: 'scheduled' }).select('id'));
        id = str(r.id);
      }
      return this.getSession(id);
    });
  }

  async cancelSession(id: ID, reason: string): Promise<void> {
    await this.write(() => this.rpc('cancel_session', { p_session_id: id, p_reason: reason || null }));
  }

  // ------------------------------------------------------------------ bookings

  private toBookResult(v: unknown): BookResult {
    const o = obj(v);
    const res: BookResult = { booking: toBooking(obj(o.booking)), outcome: o.outcome === 'waitlisted' ? 'waitlisted' : 'booked' };
    if (o.pass && typeof o.pass === 'object') res.pass = toPass(o.pass as Row);
    return res;
  }

  async bookClass(clientId: ID, sessionId: ID, opts: { passId?: ID; asStaff?: boolean; allowOverCapacity?: boolean; skipCredit?: boolean } = {}): Promise<BookResult> {
    return this.write(async () => {
      // Who's signed in decides (like the demo). A client passing staff options gets NOT_ALLOWED from the database.
      const asStaff = (await this.isStaff()) || !!opts.asStaff;
      const r = await this.rpc('book_class', {
        p_session_id: sessionId, p_pass_id: opts.passId ?? null, p_client_id: clientId, p_as_staff: asStaff,
        p_allow_over_capacity: !!opts.allowOverCapacity, p_skip_credit: !!opts.skipCredit,
      });
      return this.toBookResult(r);
    });
  }

  async cancelBooking(bookingId: ID, opts: { asStaff?: boolean; waivePenalty?: boolean } = {}): Promise<CancelResult> {
    return this.write(async () => {
      const asStaff = (await this.isStaff()) || !!opts.asStaff;
      const o = obj(await this.rpc('cancel_booking', { p_booking_id: bookingId, p_waive_penalty: !!opts.waivePenalty, p_as_staff: asStaff }));
      const res: CancelResult = { booking: toBooking(obj(o.booking)), creditReturned: bool(o.creditReturned), lateCancel: bool(o.lateCancel) };
      if (o.promoted && typeof o.promoted === 'object') res.promoted = toBooking(o.promoted as Row);
      return res;
    });
  }

  async leaveWaitlist(bookingId: ID): Promise<void> {
    await this.write(() => this.rpc('leave_waitlist', { p_booking_id: bookingId }));
  }
  async checkIn(bookingId: ID): Promise<Booking> {
    return this.write(async () => toBooking(obj(await this.rpc('check_in', { p_booking_id: bookingId }))));
  }
  async undoCheckIn(bookingId: ID): Promise<Booking> {
    return this.write(async () => toBooking(obj(await this.rpc('undo_check_in', { p_booking_id: bookingId }))));
  }
  async markNoShow(bookingId: ID): Promise<Booking> {
    return this.write(async () => toBooking(obj(await this.rpc('mark_no_show', { p_booking_id: bookingId }))));
  }
  async moveBooking(bookingId: ID, toSessionId: ID): Promise<BookResult> {
    return this.write(async () => this.toBookResult(await this.rpc('move_booking', { p_booking_id: bookingId, p_to_session_id: toSessionId })));
  }

  async getRoster(sessionId: ID): Promise<RosterEntry[]> {
    const list = arr(await this.rpc('get_roster', { p_session_id: sessionId })).map(obj);
    return list.map((e) => {
      const entry: RosterEntry = { ...toBooking(e), client: toClient(obj(e.client)), flags: arr(e.flags).map(str) as RosterEntry['flags'] };
      if (e.pass && typeof e.pass === 'object') entry.pass = toPass(e.pass as Row);
      return entry;
    });
  }

  async listClientBookings(clientId: ID, opts: { when?: 'upcoming' | 'past' | 'all'; statuses?: BookingStatus[] } = {}): Promise<BookingWithDetails[]> {
    const list = arr(await this.rpc('list_client_bookings', {
      p_client_id: clientId, p_when: opts.when ?? 'all', p_statuses: opts.statuses && opts.statuses.length ? opts.statuses : null,
    })).map(obj);
    return list.map((e) => {
      const b: BookingWithDetails = { ...toBooking(e), session: toSession(obj(e.session)), classType: toClassType(obj(e.class_type)) };
      if (e.instructor && typeof e.instructor === 'object') b.instructor = toStaff(e.instructor as Row);
      return b;
    });
  }

  // ------------------------------------------------------------------ clients

  private async notesFor(clientId?: ID): Promise<Map<string, string>> {
    const me = await this.meOrNull();
    if (me?.kind !== 'staff' || !can(me.role, 'client_staff_notes')) return new Map();
    let q = this.sb.from('client_notes').select('client_id, notes'); // RLS: owner, manager, front desk
    if (clientId) q = q.eq('client_id', clientId);
    const rows = await this.rows(q);
    return new Map(rows.map((r) => [str(r.client_id), str(r.notes)]));
  }

  async listClients(opts: { search?: string; includeArchived?: boolean } = {}): Promise<Client[]> {
    await this.requireStaff('clients_view');
    let q = this.sb.from('clients').select('*').order('first_name').order('last_name');
    if (!opts.includeArchived) q = q.eq('archived', false);
    const [rows, notes] = await Promise.all([this.rows(q), this.notesFor()]);
    const terms = (opts.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return rows.map((r) => toClient(r, notes.get(str(r.id)))).filter((c) => {
      if (!terms.length) return true;
      const hay = `${c.firstName} ${c.lastName} ${c.email} ${c.phone ?? ''} ${(c.phone ?? '').replace(/\D/g, '')}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  async getClient(id: ID): Promise<Client> {
    const [r, notes] = await Promise.all([
      this.one(this.sb.from('clients').select('*').eq('id', id).limit(1), 'We couldn’t find that client.'),
      this.notesFor(id),
    ]);
    return toClient(r, notes.get(id));
  }

  /** Upload a profile photo (data: URL from src/shared/photo.ts) to avatars/<clientId>/<timestamp>.jpg; returns its public URL. */
  private async uploadPhoto(clientId: ID, dataUrl: string): Promise<string> {
    const { bytes, type, ext } = decodeDataUrl(dataUrl);
    const path = `${clientId}/${Date.now()}.${ext}`;
    const bucket = this.sb.storage.from(AVATARS);
    await this.run(bucket.upload(path, new Blob([bytes.buffer as ArrayBuffer], { type }), { contentType: type, cacheControl: '31536000', upsert: false }));
    const url = str(obj(obj(bucket.getPublicUrl(path)).data).publicUrl);
    if (!url) throw new StoreError('ERROR', 'Your photo uploaded but we couldn’t link it. Please try again.');
    return url;
  }
  /** Best effort: tidy away a replaced photo. */
  private async removePhoto(url: string | null | undefined): Promise<void> {
    const path = avatarPath(url);
    if (!path) return;
    try { await this.sb.storage.from(AVATARS).remove([path]); } catch { /* leave it */ }
  }
  /** photo_url to save for c.photoUrl: data: URL -> upload; '' / undefined -> null (remove); a URL -> as is. */
  private async photoColumn(clientId: ID, photoUrl: string | undefined): Promise<string | null> {
    if (!photoUrl) return null;
    if (photoUrl.startsWith('data:')) return this.uploadPhoto(clientId, photoUrl);
    return photoUrl;
  }

  /**
   * Merge, never replace: only the fields present on `c` change (a present-but-undefined field is cleared,
   * e.g. `{ ...client, photoUrl: undefined }` removes the photo). Clients can only change their own
   * personal details; the database ignores their writes to email, waiver, health form, source, archived
   * and staff notes. A client's new email goes through Supabase Auth (confirmation link), then syncs: the call
   * still resolves, with `pendingEmail` set on the result so the app can say "check your inbox".
   */
  async upsertClient(c: Omit<Client, 'id' | 'createdAt'> & { id?: ID; createdAt?: ISODateTime }): Promise<ClientSaveResult> {
    return this.write(async () => {
      const me = await this.requireMe();
      if (has(c, 'firstName') && !c.firstName?.trim()) throw new StoreError('INVALID', 'Please enter a first name.');
      const email = (c.email ?? '').trim().toLowerCase();
      if (email && !EMAIL_RE.test(email)) throw new StoreError('INVALID', 'Please enter a valid email address.');

      // Fields anyone (client or staff) may set, only when present.
      const personal = (): [string, unknown][] => [
        ['first_name', has(c, 'firstName') ? c.firstName.trim() : undefined],
        ['last_name', has(c, 'lastName') ? (c.lastName ?? '').trim() : undefined],
        ['phone', has(c, 'phone') ? textOrNull(c.phone) : undefined],
        ['birthday', has(c, 'birthday') ? textOrNull(c.birthday) : undefined],
        ['injuries', has(c, 'injuries') ? textOrNull(c.injuries) : undefined],
        ['emergency_contact_name', has(c, 'emergencyContactName') ? textOrNull(c.emergencyContactName) : undefined],
        ['emergency_contact_phone', has(c, 'emergencyContactPhone') ? textOrNull(c.emergencyContactPhone) : undefined],
        ['marketing_opt_in', has(c, 'marketingOptIn') ? !!c.marketingOptIn : undefined],
      ];

      if (me.kind === 'client') {
        if (!c.id || c.id !== me.clientId) throw new StoreError('NOT_ALLOWED', 'You can only edit your own details.');
        const id = c.id;
        const before = has(c, 'photoUrl') ? await this.getClient(id) : undefined;
        const pairs = personal();
        if (has(c, 'photoUrl')) pairs.push(['photo_url', await this.photoColumn(id, c.photoUrl)]);
        const row = patchRow(pairs);
        if (Object.keys(row).length) {
          await this.one(this.sb.from('clients').update(row).eq('id', id).select('id'), 'You can only edit your own details.', 'NOT_ALLOWED');
        }
        if (before && before.photoUrl !== row.photo_url) await this.removePhoto(before.photoUrl);
        if (email && email !== me.email.toLowerCase()) {
          const { error } = await this.sb.auth.updateUser({ email });
          if (error) {
            const m = str(obj(error).message);
            if (/already|registered|exists/i.test(m)) throw new StoreError('EMAIL_TAKEN', 'There’s already an account with that email.');
            throw toStoreError(error);
          }
          // Not an error: the details are saved and Supabase has emailed a confirm link to the new address.
          // The email changes (and syncs to the client record) once they tap it. The UI shows a friendly note.
          const saved: ClientSaveResult = await this.getClient(id);
          saved.pendingEmail = email;
          return saved;
        }
        return this.getClient(id);
      }

      const st = await this.requireStaff('clients_edit');
      if (email) {
        const dup = await this.rows(this.sb.from('clients').select('id').ilike('email', email.replace(/([%_\\])/g, '\\$1')).limit(2));
        if (dup.some((r) => str(r.id) !== c.id)) throw new StoreError('EMAIL_TAKEN', 'Another client already uses that email.');
      }
      const pairs = personal();
      pairs.push(
        ['email', has(c, 'email') ? email : undefined],
        ['archived', has(c, 'archived') ? !!c.archived : undefined],
        ['source', has(c, 'source') && c.source ? c.source : undefined],
        ['waiver_signed_at', has(c, 'waiverSignedAt') ? c.waiverSignedAt ?? null : undefined],
        ['health_form', has(c, 'healthForm') ? c.healthForm ?? null : undefined],
      );
      let id = c.id;
      let before: Client | undefined;
      if (id) {
        before = has(c, 'photoUrl') ? await this.getClient(id) : undefined;
        if (has(c, 'photoUrl')) pairs.push(['photo_url', await this.photoColumn(id, c.photoUrl)]);
        const row = patchRow(pairs);
        if (Object.keys(row).length) {
          await this.one(this.sb.from('clients').update(row).eq('id', id).select('id'), 'You don’t have permission to edit this client.', 'NOT_ALLOWED');
        }
      } else {
        if (!has(c, 'firstName')) throw new StoreError('INVALID', 'Please enter a first name.');
        const row = patchRow(pairs);
        const r = await this.one(this.sb.from('clients').insert({
          ...row, email, source: c.source ?? 'staff', ...(c.createdAt ? { created_at: c.createdAt } : {}),
        }).select('id'));
        id = str(r.id);
        if (c.photoUrl) {
          await this.run(this.sb.from('clients').update({ photo_url: await this.photoColumn(id, c.photoUrl) }).eq('id', id));
        }
      }
      if (before && has(c, 'photoUrl')) {
        const now = await this.getClient(id);
        if (now.photoUrl !== before.photoUrl) await this.removePhoto(before.photoUrl);
      }
      // Staff notes live in their own table; only roles with client_staff_notes can write them (RLS agrees).
      if (has(c, 'staffNotes') && can(st.role, 'client_staff_notes')) {
        await this.run(this.sb.from('client_notes').upsert({ client_id: id, notes: c.staffNotes ?? '', updated_at: new Date().toISOString(), updated_by: st.staffId }));
      }
      return this.getClient(id);
    });
  }

  async submitWaiver(clientId: ID, health: Omit<HealthForm, 'submittedAt'>): Promise<Client> {
    return this.write(async () => {
      await this.rpc('submit_waiver', { p_client_id: clientId, p_health: health });
      return this.getClient(clientId);
    });
  }

  /** Coming-soon classes: the client (or front desk for them) registers interest. Safe to repeat. */
  async registerInterest(clientId: ID, classTypeId: ID): Promise<void> {
    await this.write(() => this.rpc('register_interest', { p_class_type_id: classTypeId, p_client_id: clientId }));
  }

  /** Extra (not in DataStore): who registered interest, newest first. Staff only. */
  async listClassInterest(classTypeId?: ID): Promise<{ clientId: ID; classTypeId: ID; at: ISODateTime; name: string; email: string; phone?: string }[]> {
    return arr(await this.rpc('list_class_interest', { p_class_type_id: classTypeId ?? null })).map(obj).map((x) => clean({
      clientId: str(x.client_id), classTypeId: str(x.class_type_id), at: iso(x.created_at),
      name: `${str(x.first_name)} ${str(x.last_name)}`.trim(), email: str(x.email), phone: optStr(x.phone),
    }));
  }

  // ------------------------------------------------------------------ products, passes, sales

  async listProducts(opts: { includeInactive?: boolean; kinds?: Product['kind'][] } = {}): Promise<Product[]> {
    const rows = await this.rows(this.sb.from('products').select('*').order('sort_order').order('name'));
    return rows.map(toProduct)
      .filter((p) => opts.includeInactive || p.active)
      .filter((p) => !opts.kinds || opts.kinds.includes(p.kind));
  }

  async upsertProduct(p: Omit<Product, 'id'> & { id?: ID }): Promise<Product> {
    return this.write(async () => {
      await this.requireStaff('products');
      if (!p.name?.trim()) throw new StoreError('INVALID', 'Please enter a name.');
      if (!(p.priceCents >= 0)) throw new StoreError('INVALID', 'Price must be zero or more.');
      const row = patchRow([
        ['kind', p.kind], ['name', p.name.trim()], ['description', p.description ?? ''], ['price_cents', p.priceCents], ['active', p.active],
        ['highlight', textOrNull(p.highlight)], ['sort_order', p.sortOrder], ['credits', p.kind === 'retail' ? null : p.credits ?? null],
        ['validity_days', p.kind === 'retail' ? null : p.validityDays ?? null],
        ['billing_interval', p.kind === 'membership' ? p.billingInterval ?? 'week' : null], ['new_clients_only', !!p.newClientsOnly],
        ['class_type_ids', p.classTypeIds && p.classTypeIds.length ? p.classTypeIds : null], ['stock', p.kind === 'retail' ? p.stock ?? null : null],
      ]);
      const r = p.id
        ? await this.one(this.sb.from('products').update(row).eq('id', p.id).select('*'), 'You don’t have permission to edit products.', 'NOT_ALLOWED')
        : await this.one(this.sb.from('products').insert(row).select('*'));
      return toProduct(r);
    });
  }

  async listPasses(clientId: ID, opts: { includeInactive?: boolean } = {}): Promise<Pass[]> {
    const rows = await this.rows(this.sb.from('passes').select('*, pass_adjustments(*)').eq('client_id', clientId));
    const all = rows.map(toPass);
    const now = new Date();
    const current = all.filter((p) => isPassCurrent(p, now)).sort(comparePassPriority);
    if (!opts.includeInactive) return current;
    const rest = all.filter((p) => !current.includes(p)).sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
    return [...current, ...rest];
  }

  async getCreditSummary(clientId: ID, forSessionId?: ID): Promise<CreditSummary[]> {
    const list = arr(await this.rpc('credit_summary', { p_client_id: clientId, p_session_id: forSessionId ?? null })).map(obj);
    return list.map((x) => {
      const c: CreditSummary = {
        pass: toPass(obj(x.pass)), remaining: x.remaining === null || x.remaining === undefined ? null : num(x.remaining), label: str(x.label),
      };
      const exp = nullableIso(x.expiresAt);
      if (exp !== undefined) c.expiresAt = exp;
      return c;
    });
  }

  async isIntroEligible(clientId: ID): Promise<boolean> {
    return bool(await this.rpc('is_intro_eligible', { p_client_id: clientId }));
  }

  async purchase(input: { clientId?: ID; productId: ID; method: PaymentMethod; staffId?: ID; qty?: number; note?: string }): Promise<PurchaseResult> {
    if (!(await this.isStaff())) {
      // Clients pay through Stripe Checkout (startCheckout); the pass appears when Stripe confirms payment.
      throw new StoreError('NOT_ALLOWED', 'Online purchases go through secure checkout.');
    }
    const { sale, passes } = await this.checkoutCart({
      ...(input.clientId ? { clientId: input.clientId } : {}), items: [{ productId: input.productId, qty: input.qty ?? 1 }],
      method: input.method, ...(input.note ? { note: input.note } : {}),
    });
    return passes[0] ? { sale, pass: passes[0] } : { sale };
  }

  async checkoutCart(input: { clientId?: ID; items: { productId: ID; qty: number }[]; method: PaymentMethod; staffId?: ID; discountCents?: number; note?: string }): Promise<{ sale: Sale; passes: Pass[] }> {
    return this.write(async () => {
      const o = obj(await this.rpc('checkout_cart', {
        p_client_id: input.clientId ?? null,
        p_items: input.items.map((i) => ({ product_id: i.productId, qty: i.qty })),
        p_method: input.method, p_discount_cents: input.discountCents ?? 0, p_note: input.note ?? null,
      }));
      return { sale: toSale(obj(o.sale)), passes: arr(o.passes).map((p) => toPass(obj(p))) };
    });
  }

  async startCheckout(input: { clientId: ID; productId: ID; returnUrl: string }): Promise<{ url: string } | null> {
    const r = await this.invoke('create-checkout', { productId: input.productId, returnUrl: input.returnUrl });
    const url = str(r.url);
    if (!url) throw new StoreError('ERROR', 'We couldn’t start checkout. Please try again.');
    return { url };
  }

  /**
   * Extra (not in DataStore yet): Stripe's hosted page for a client to update their card / see invoices.
   * Usage: `const r = await (store as { billingPortal?: (u: string) => Promise<{ url: string }> }).billingPortal?.(location.href)`.
   */
  async billingPortal(returnUrl: string): Promise<{ url: string }> {
    const r = await this.invoke('billing-portal', { returnUrl });
    const url = str(r.url);
    if (!url) throw new StoreError('ERROR', 'We couldn’t open billing. Please try again.');
    return { url };
  }

  /** After pause/resume/cancel, bring the Stripe subscription in line with the database (if there is one). */
  private async syncMembership(passId: ID): Promise<void> {
    const rows = await this.rows(this.sb.from('passes').select('stripe_subscription_id').eq('id', passId));
    if (!rows[0] || !rows[0].stripe_subscription_id) return;
    try {
      await this.invoke('manage-membership', { passId });
    } catch (e) {
      const se = toStoreError(e);
      throw new StoreError(se.code, `Saved, but billing didn’t update (${se.message}). Please let the studio know.`);
    }
  }

  async pausePass(passId: ID, from: ISODate, until: ISODate): Promise<Pass> {
    return this.write(async () => {
      const p = toPass(obj(await this.rpc('pause_pass', { p_pass_id: passId, p_from: from, p_until: until })));
      await this.syncMembership(passId);
      return p;
    });
  }
  async resumePass(passId: ID): Promise<Pass> {
    return this.write(async () => {
      const p = toPass(obj(await this.rpc('resume_pass', { p_pass_id: passId })));
      await this.syncMembership(passId);
      return p;
    });
  }
  async cancelMembership(passId: ID): Promise<Pass> {
    return this.write(async () => {
      const p = toPass(obj(await this.rpc('cancel_membership', { p_pass_id: passId })));
      await this.syncMembership(passId);
      return p;
    });
  }

  async adjustPass(passId: ID, change: { creditsDelta?: number; newExpiresAt?: ISODateTime | null; reason: string }): Promise<Pass> {
    return this.write(async () => toPass(obj(await this.rpc('adjust_pass', {
      p_pass_id: passId, p_credits_delta: change.creditsDelta ?? 0, p_new_expires_at: change.newExpiresAt ?? null,
      p_set_expiry: change.newExpiresAt !== undefined, p_reason: change.reason,
    }))));
  }

  async listSales(range: ReportRange & { clientId?: ID }): Promise<Sale[]> {
    const me = await this.requireMe();
    if (me.kind === 'client' && range.clientId && range.clientId !== me.clientId) throw new StoreError('NOT_ALLOWED', 'You can only see your own purchases.');
    if (me.kind === 'staff' && !can(me.role, 'sales_view')) throw new StoreError('NOT_ALLOWED', 'Your role doesn’t have access to that.');
    let q = this.sb.from('sales').select('*, sale_items(*)')
      .gte('created_at', startOfStudioDay(range.from)).lt('created_at', startOfStudioDay(addDays(range.to, 1)))
      .order('created_at', { ascending: false });
    const clientId = me.kind === 'client' ? me.clientId : range.clientId;
    if (clientId) q = q.eq('client_id', clientId);
    return (await this.rows(q)).map(toSale);
  }

  async refundSale(saleId: ID, opts: { amountCents?: number; cancelPass?: boolean; reason?: string } = {}): Promise<Sale> {
    return this.write(async () => {
      await this.requireStaff('pos_refund');
      const s = await this.one(this.sb.from('sales').select('id, method, stripe_payment_intent_id').eq('id', saleId).limit(1), 'We couldn’t find that sale.');
      if (s.method === 'card_online' && s.stripe_payment_intent_id) {
        // Online card payments are refunded in Stripe first; the edge function records it here.
        const r = await this.invoke('refund-payment', { saleId, amountCents: opts.amountCents ?? null, cancelPass: !!opts.cancelPass, reason: opts.reason ?? '' });
        return toSale(obj(r.sale));
      }
      return toSale(obj(await this.rpc('refund_sale', {
        p_sale_id: saleId, p_amount_cents: opts.amountCents ?? null, p_cancel_pass: !!opts.cancelPass, p_reason: opts.reason ?? null,
      })));
    });
  }

  // ------------------------------------------------------------------ reports

  async getReport(range: ReportRange): Promise<StudioReport> {
    return toReport(obj(await this.rpc('report', { p_from: range.from, p_to: range.to })), range);
  }

  async exportSalesCsv(range: ReportRange): Promise<string> {
    await this.requireStaff('export_sales');
    const [sales, clients, staff] = await Promise.all([this.listSales(range), this.listClients({ includeArchived: true }), this.listStaff({ includeInactive: true })]);
    return salesCsv({ sales, clients, staff, range });
  }

  async exportClientsCsv(): Promise<string> {
    await this.requireStaff('export_clients');
    return clientsCsv(await this.listClients({ includeArchived: true }));
  }

  /** Stop listening (tests / hot reload). Not part of DataStore. */
  dispose(): void {
    try { this.authSub?.unsubscribe?.(); } catch { /* ignore */ }
    if (this.channel) { try { this.sb.removeChannel(this.channel); } catch { /* ignore */ } }
    this.listeners.clear();
  }
}

/** A live store bound to one studio (or, with no studio, the database's default studio: the Snowy deployment). */
export function createSupabaseStore(url: string, anonKey: string, opts: { studio?: Studio; shared?: SharedClient } = {}): DataStore {
  return new SupabaseStore(url, anonKey, opts);
}

/**
 * Live PlatformStore: the studio directory (public.studios with RLS), person-level sign-in, memberships
 * (my_studios) and the platform admin functions (platform_*). forStudio() returns stores that share its client.
 */
class SupabasePlatform implements PlatformStore {
  readonly mode = 'live' as const;
  private shared: SharedClient | null = null;
  private stores = new Map<ID, DataStore>();
  private listeners = new Set<() => void>();
  constructor(private url: string, private anonKey: string) {}
  private get sc(): SharedClient {
    if (!this.shared) {
      this.shared = createSharedClient(this.url, this.anonKey);
      this.shared.onAuth.add(() => this.listeners.forEach((l) => l()));
    }
    return this.shared;
  }
  private async call(q: PromiseLike<DbResult>): Promise<unknown> {
    let res: DbResult;
    try { res = await q; } catch (e) { throw toStoreError(e); }
    if (res.error) throw toStoreError(res.error);
    return res.data;
  }
  private rpc(fn: string, args: Row = {}) { return this.call(this.sc.sb.rpc(fn, args)); }
  private emit() { this.listeners.forEach((l) => { try { l(); } catch (e) { console.error(e); } }); }

  subscribe(listener: () => void): Unsubscribe { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async listStudios(opts: { search?: string; includeAll?: boolean } = {}): Promise<Studio[]> {
    let q = this.sc.sb.from('studios').select('*').order('name');
    if (!opts.includeAll) q = q.eq('status', 'live');
    const list = arr(await this.call(q)).map((r) => toStudio(obj(r)));
    const terms = (opts.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((s) => terms.every((t) => `${s.name} ${s.slug} ${s.address}`.toLowerCase().includes(t)));
  }
  async findStudio(key: { slug?: string; id?: ID; domain?: string }): Promise<Studio | null> {
    let q = this.sc.sb.from('studios').select('*');
    if (key.id) q = q.eq('id', key.id);
    else if (key.slug) q = q.eq('slug', key.slug.toLowerCase());
    else if (key.domain) q = q.contains('custom_domains', [key.domain.toLowerCase()]);
    else return null;
    const r = arr(await this.call(q.limit(1)))[0];
    return r ? toStudio(obj(r)) : null;
  }
  forStudio(studio: Studio): DataStore {
    let s = this.stores.get(studio.id);
    if (!s) { s = new SupabaseStore(this.url, this.anonKey, { studio, shared: this.sc }); this.stores.set(studio.id, s); }
    this.sc.hdr['x-studio'] = studio.id;
    return s;
  }
  async currentPerson(): Promise<{ email: string; name: string } | null> {
    const { data } = await this.sc.sb.auth.getSession();
    const u = obj(obj(data?.session).user);
    if (!u.id) return null;
    const meta = obj(u.user_metadata);
    return { email: str(u.email), name: `${str(meta.first_name)} ${str(meta.last_name)}`.trim() || str(u.email) };
  }
  async signIn(email: string, password: string): Promise<{ email: string; name: string }> {
    if (!email?.trim() || !password) throw new StoreError('INVALID_LOGIN', 'Enter your email and password.');
    const { error } = await this.sc.sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new StoreError('INVALID_LOGIN', 'That email and password don’t match. Try again or reset your password.');
    if (this.sc.app === 'admin' && !(await this.platformUser())) {
      await this.sc.sb.auth.signOut();
      throw new StoreError('NOT_ALLOWED', 'This sign-in is for the platform team.');
    }
    this.emit();
    return (await this.currentPerson()) ?? { email, name: email };
  }
  async signOut(): Promise<void> { await this.sc.sb.auth.signOut(); this.emit(); }
  async myMemberships(): Promise<StudioMembership[]> {
    return arr(await this.rpc('my_studios')).map(obj).map((m) => clean({
      studioId: str(m.studio_id), slug: str(m.slug), name: str(m.name), status: str(m.status) as StudioStatus,
      kind: str(m.kind) as 'client' | 'staff', role: optStr(m.role) as StaffRole | undefined,
    }));
  }
  async platformUser(): Promise<PlatformUser | null> {
    const p = await this.currentPerson();
    if (!p) return null;
    const rows = arr(await this.call(this.sc.sb.from('platform_admins').select('user_id').limit(1)));
    return rows.length ? { email: p.email, name: p.name, role: 'platform_admin' } : null;
  }
  async createStudio(input: NewStudioInput): Promise<Studio> {
    const r = toStudio(obj(await this.rpc('platform_create_studio', {
      p_name: input.name, p_slug: input.slug, p_email: input.email, p_timezone: input.timezone ?? 'Australia/Sydney',
      p_currency: input.currency ?? 'AUD', p_locale: input.locale ?? 'en-AU', p_phone: input.phone ?? null, p_address: input.address ?? '',
      p_branding: input.branding ?? {},
    })));
    this.emit();
    return r;
  }
  async updateStudioAsAdmin(id: ID, patch: Partial<Omit<Studio, 'id' | 'createdAt'>>): Promise<Studio> {
    const r = toStudio(obj(await this.rpc('platform_update_studio', { p_studio_id: id, p_patch: studioPatchRow(patch) })));
    this.emit();
    return r;
  }
  async setStudioStatus(id: ID, status: StudioStatus): Promise<Studio> {
    const r = toStudio(obj(await this.rpc('platform_set_studio_status', { p_studio_id: id, p_status: status })));
    this.emit();
    return r;
  }
  async inviteOwner(studioId: ID, owner: { name: string; email: string }): Promise<Staff> {
    const st = toStaff(obj(await this.rpc('platform_invite_owner', { p_studio_id: studioId, p_name: owner.name, p_email: owner.email })));
    // The email itself: Supabase Auth's invite (edge function invite-user), which links to that studio's app.
    try { await this.sc.sb.functions.invoke('invite-user', { body: { studioId, email: owner.email, name: owner.name, role: 'owner' } }); }
    catch { /* the owner can still use "Forgot password" with this email */ }
    this.emit();
    return st;
  }
  async studioStats(): Promise<Record<ID, { clients: number; staff: number; classesNext7Days: number }>> {
    const o = obj(await this.rpc('platform_studio_stats'));
    return Object.fromEntries(Object.entries(o).map(([k, v]) => { const x = obj(v); return [k, { clients: num(x.clients), staff: num(x.staff), classesNext7Days: num(x.classes_next_7_days) }]; }));
  }
}

export function createSupabasePlatform(url: string, anonKey: string): PlatformStore {
  return new SupabasePlatform(url, anonKey);
}

/** Row mappers, exported for supabase/tests/live_store.test.mjs. */
export const mappers = { toSettings, toStaff, toClient, toClassType, toTemplate, toSession, toProduct, toPass, toBooking, toSale, toReport };
