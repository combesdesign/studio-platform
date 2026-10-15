/**
 * The contract between the UI (client, studio and admin apps) and the data layer.
 *
 * Studio scoping: a DataStore is bound to ONE studio (`studioId`). Everything it reads and writes belongs to
 * that studio. The PlatformStore (below) lists studios, signs people in across studios and hands out bound
 * DataStores with forStudio(). The apps get the bound store as `store` from src/data after boot.
 * Two implementations:
 *   - src/data/demo      — in-browser, localStorage-backed, seeded with fake data (clickable demo, tests)
 *   - src/data/supabase  — the real thing (Postgres + Auth + RLS, Stripe via edge functions)
 *
 * OWNED BY THE LEAD. Agents: code against this. Don't rename or remove methods.
 * If you need something extra, add an OPTIONAL method and note it in NOTES.md.
 *
 * Rules every implementation must follow are in RULES.md (the studio's real policies).
 * All methods are async. Errors are thrown as StoreError with a user-friendly message.
 */
import type {
  PlatformUser, Studio, StudioMembership, StudioStatus,
  AuthUser, Booking, BookingStatus, ClassSession, ClassType, Client, ID, ISODate, ISODateTime,
  Pass, PaymentMethod, Product, Sale, SaleItem, ScheduleTemplate, SessionWithCounts, Staff,
  StudioReport, StudioSettings, ReportRange, HealthForm,
} from './types';

export class StoreError extends Error {
  /** Machine-readable code, e.g. 'NO_CREDITS', 'CLASS_FULL', 'ALREADY_BOOKED', 'TOO_LATE', 'NOT_ALLOWED', 'NOT_FOUND', 'INTRO_NOT_ELIGIBLE', 'WAIVER_REQUIRED' */
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface BookResult {
  booking: Booking;
  /** 'booked' = has a spot, 'waitlisted' = on the waitlist (not charged yet). */
  outcome: 'booked' | 'waitlisted';
  /** Pass the credit was taken from (booked only). */
  pass?: Pass;
}

export interface CancelResult {
  booking: Booking;
  /** true = credit returned (cancelled outside the window, or by staff with refund). */
  creditReturned: boolean;
  lateCancel: boolean;
  /** If someone was auto-booked off the waitlist as a result. */
  promoted?: Booking;
}

export interface PurchaseResult {
  sale: Sale;
  pass?: Pass; // for class products
}

/** Client-facing summary of what they can book with. */
export interface CreditSummary {
  pass: Pass;
  /** Credits left right now (for memberships: left this week of the given date). null = unlimited. */
  remaining: number | null;
  /** Human label e.g. '3 of 4 left', 'Unlimited', '1 of 2 left this week'. */
  label: string;
  expiresAt?: ISODateTime | null;
}

export interface BookingWithDetails extends Booking {
  session: SessionWithCounts;
  classType: ClassType;
  instructor?: Staff;
}

export interface RosterEntry extends Booking {
  client: Client;
  pass?: Pass;
  /** Flags staff should see at check-in. */
  flags: ('first_class' | 'no_waiver' | 'injury' | 'birthday' | 'last_credit' | 'pass_expiring')[];
}

export type Unsubscribe = () => void;

/**
 * Feature stores, one per feature module (src/features/<name>). Empty here on purpose: each feature adds its
 * own entry from its types.ts with module augmentation, so nobody edits this file:
 *
 *   declare module '../../shared/store' { interface FeatureStores { appointments: AppointmentsStore } }
 *
 * At runtime `store.features.<name>` is present when that feature's demo.ts / live.ts registered an implementation.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FeatureStores {}

/** What a studio owner may change about their own studio (details + branding). Status: only onboarding -> live. */
export type StudioPatch = Partial<Omit<Studio, 'id' | 'slug' | 'createdAt' | 'status' | 'customDomains'>> & { status?: 'live' };

export interface DataStore {
  /** 'demo' or 'live' — the UI shows a small DEMO badge in demo mode. */
  readonly mode: 'demo' | 'live';
  /** The studio this store is bound to. */
  readonly studioId: ID;
  /** Optional feature stores (see FeatureStores). */
  readonly features: Partial<FeatureStores>;

  /** The bound studio (details, branding, status). Anyone may read it. */
  getStudio(): Promise<Studio>;
  /** Owner (and manager for branding): change details or branding; 'live' finishes onboarding. Platform admins use PlatformStore. */
  updateStudio(patch: StudioPatch): Promise<Studio>;

  /** Fires after any change (any tab). UIs re-fetch on this. */
  subscribe(listener: () => void): Unsubscribe;

  // ------------------------------------------------------------ auth
  currentUser(): Promise<AuthUser | null>;
  /**
   * Clients: email + password. Demo store accepts any password for seeded clients
   * and also offers demoSignInAs().
   */
  signIn(email: string, password: string): Promise<AuthUser>;
  signUpClient(input: { firstName: string; lastName: string; email: string; phone?: string; password: string; marketingOptIn?: boolean }): Promise<AuthUser>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  /** Demo only: list of quick-login personas (clients + staff). Live store returns []. */
  demoPersonas(): Promise<AuthUser[]>;
  demoSignInAs?(user: AuthUser): Promise<AuthUser>;
  /** Demo only: wipe and re-seed. */
  demoReset?(): Promise<void>;

  // ------------------------------------------------------------ settings
  getSettings(): Promise<StudioSettings>;
  updateSettings(patch: Partial<StudioSettings>): Promise<StudioSettings>; // owner/manager

  // ------------------------------------------------------------ staff
  listStaff(opts?: { includeInactive?: boolean }): Promise<Staff[]>;
  upsertStaff(staff: Omit<Staff, 'id'> & { id?: ID }): Promise<Staff>; // owner/manager

  // ------------------------------------------------------------ class types & schedule
  listClassTypes(opts?: { includeInactive?: boolean }): Promise<ClassType[]>;
  upsertClassType(ct: Omit<ClassType, 'id'> & { id?: ID }): Promise<ClassType>;

  listTemplates(): Promise<ScheduleTemplate[]>;
  upsertTemplate(t: Omit<ScheduleTemplate, 'id'> & { id?: ID }): Promise<ScheduleTemplate>;
  deleteTemplate(id: ID): Promise<void>;
  /**
   * Make sure sessions exist for every active template between from..to (inclusive, studio dates).
   * Idempotent. Returns number created. Demo store calls this automatically on read.
   */
  generateSessions(from: ISODate, to: ISODate): Promise<number>;

  /** Sessions overlapping the range, ordered by startsAt. Includes cancelled unless excluded. */
  listSessions(range: { from: ISODateTime; to: ISODateTime; includeCancelled?: boolean }): Promise<SessionWithCounts[]>;
  getSession(id: ID): Promise<SessionWithCounts>;
  /** Create a one-off class or edit one (time, instructor/cover, capacity, note). */
  upsertSession(s: Omit<ClassSession, 'id' | 'status'> & { id?: ID; status?: ClassSession['status'] }): Promise<SessionWithCounts>;
  /** Studio cancels a class: every booking -> 'removed' with credit returned, waitlist cleared. */
  cancelSession(id: ID, reason: string): Promise<void>;

  // ------------------------------------------------------------ bookings
  /**
   * Book a client into a session. Picks the best pass automatically unless passId given
   * (see RULES.md: soonest-expiring eligible pass first, memberships before packs).
   * If full -> waitlist (no credit taken). Throws NO_CREDITS if no eligible pass and not full.
   * Staff may pass {asStaff:true, allowOverCapacity?:true, skipCredit?:true} (comp / squeeze in).
   */
  bookClass(clientId: ID, sessionId: ID, opts?: { passId?: ID; asStaff?: boolean; allowOverCapacity?: boolean; skipCredit?: boolean }): Promise<BookResult>;
  /** Client or staff cancel. Applies the cancellation window unless staff waives it. Promotes from waitlist. */
  cancelBooking(bookingId: ID, opts?: { asStaff?: boolean; waivePenalty?: boolean }): Promise<CancelResult>;
  /** Leave the waitlist (no penalty). */
  leaveWaitlist(bookingId: ID): Promise<void>;
  checkIn(bookingId: ID): Promise<Booking>;
  undoCheckIn(bookingId: ID): Promise<Booking>;
  markNoShow(bookingId: ID): Promise<Booking>;
  /** Staff: move a booking to another session (credit moves with it). */
  moveBooking?(bookingId: ID, toSessionId: ID): Promise<BookResult>;

  /** Staff roster for a session: booked/checked-in/no-show first, then waitlist in order. */
  getRoster(sessionId: ID): Promise<RosterEntry[]>;
  /** A client's bookings with session details. upcoming = startsAt >= now. */
  listClientBookings(clientId: ID, opts?: { when?: 'upcoming' | 'past' | 'all'; statuses?: BookingStatus[] }): Promise<BookingWithDetails[]>;

  // ------------------------------------------------------------ clients
  /**
   * Optional: client registers interest in a coming-soon class type (bookable: false). Safe to repeat.
   * Clients can only register themselves; front desk / manager / owner can register any client.
   */
  registerInterest?(clientId: ID, classTypeId: ID): Promise<void>;
  /**
   * Password links (forgot password, staff/client invites). The live store calls the registered handler when the user
   * arrives from a recovery or invite link; the UI then shows its own "Choose a new password" screen and calls setNewPassword.
   * Demo store: optional; may simulate the flow.
   */
  setNewPassword?(password: string): Promise<void>;
  onPasswordRecovery?(handler: (kind?: 'invite' | 'recovery') => void): Unsubscribe;

  listClients(opts?: { search?: string; includeArchived?: boolean }): Promise<Client[]>;
  getClient(id: ID): Promise<Client>;
  /** Live: if the email changed, resolves with pendingEmail set (a confirmation email went to the new address). */
  upsertClient(c: Omit<Client, 'id' | 'createdAt'> & { id?: ID; createdAt?: ISODateTime }): Promise<Client & { pendingEmail?: string }>;
  /** Client signs waiver + health form (client app) or staff records it. */
  submitWaiver(clientId: ID, health: Omit<HealthForm, 'submittedAt'>): Promise<Client>;

  // ------------------------------------------------------------ products, passes, sales
  listProducts(opts?: { includeInactive?: boolean; kinds?: Product['kind'][] }): Promise<Product[]>;
  upsertProduct(p: Omit<Product, 'id'> & { id?: ID }): Promise<Product>;

  listPasses(clientId: ID, opts?: { includeInactive?: boolean }): Promise<Pass[]>;
  /** Usable credits for a client, optionally for a specific session (eligibility + that week's membership count). */
  getCreditSummary(clientId: ID, forSessionId?: ID): Promise<CreditSummary[]>;
  /** Is this client allowed to buy the intro offer? (never had any class pass before) */
  isIntroEligible(clientId: ID): Promise<boolean>;

  /**
   * Buy a class product (creates Pass + Sale) or retail (Sale only).
   * Client app: method 'card_online' (demo simulates Stripe; live goes through Stripe Checkout first —
   * see startCheckout). Studio POS: any method.
   */
  purchase(input: { clientId?: ID; productId: ID; method: PaymentMethod; staffId?: ID; qty?: number; note?: string }): Promise<PurchaseResult>;
  /** POS cart with several items (retail + passes). Class products require a clientId. */
  checkoutCart(input: { clientId?: ID; items: { productId: ID; qty: number }[]; method: PaymentMethod; staffId?: ID; discountCents?: number; note?: string }): Promise<{ sale: Sale; passes: Pass[] }>;
  /**
   * Live store: returns a Stripe Checkout URL to redirect to (pass is created by webhook).
   * Demo store: returns null — UI should call purchase() directly after a fake card sheet.
   */
  startCheckout?(input: { clientId: ID; productId: ID; returnUrl: string }): Promise<{ url: string } | null>;

  pausePass(passId: ID, from: ISODate, until: ISODate): Promise<Pass>;
  resumePass(passId: ID): Promise<Pass>;
  cancelMembership(passId: ID): Promise<Pass>;
  /** Staff: add/remove credits or extend expiry, with a reason (logged). */
  adjustPass(passId: ID, change: { creditsDelta?: number; newExpiresAt?: ISODateTime | null; reason: string }): Promise<Pass>;

  listSales(range: ReportRange & { clientId?: ID }): Promise<Sale[]>;
  refundSale(saleId: ID, opts?: { amountCents?: number; cancelPass?: boolean; reason?: string }): Promise<Sale>;

  // ------------------------------------------------------------ reports
  getReport(range: ReportRange): Promise<StudioReport>;
  /** CSV text for accounting export (sales in range). */
  exportSalesCsv(range: ReportRange): Promise<string>;
  /** CSV text of all clients. */
  exportClientsCsv(): Promise<string>;
}

// ---------------------------------------------------------------------------------------------- platform

export interface NewStudioInput {
  name: string;
  slug: string;
  timezone?: string;
  currency?: string;
  locale?: string;
  email: string;
  phone?: string;
  address?: string;
  /** Start from this branding (else a calm neutral default). */
  branding?: Studio['branding'];
}

/**
 * The platform layer: which studios exist, who you are across them, and Pete's platform admin tools.
 * One per app; the apps get it as `platform` from src/data.
 */
export interface PlatformStore {
  readonly mode: 'demo' | 'live';
  subscribe(listener: () => void): Unsubscribe;

  /** "Find your studio": live studios (platform admins also see onboarding / suspended ones with includeAll). */
  listStudios(opts?: { search?: string; includeAll?: boolean }): Promise<Studio[]>;
  /** By slug, id or custom domain. null if there's no such studio (or it isn't visible to you). */
  findStudio(key: { slug?: string; id?: ID; domain?: string }): Promise<Studio | null>;
  /** A DataStore bound to one studio. */
  forStudio(studio: Studio): DataStore;

  /** Person-level sign-in, shared by every studio in this app (the studio app's "which studio?" and the admin app). */
  currentPerson(): Promise<{ email: string; name: string } | null>;
  signIn(email: string, password: string): Promise<{ email: string; name: string }>;
  signOut(): Promise<void>;
  /** Studios the signed-in person belongs to (client and/or staff). */
  myMemberships(): Promise<StudioMembership[]>;

  // ---------------------------------------------------------------- platform admin (role platform_admin)
  platformUser(): Promise<PlatformUser | null>;
  createStudio(input: NewStudioInput): Promise<Studio>;
  updateStudioAsAdmin(id: ID, patch: Partial<Omit<Studio, 'id' | 'createdAt'>>): Promise<Studio>;
  setStudioStatus(id: ID, status: StudioStatus): Promise<Studio>;
  /** Adds the owner as staff (role owner) of that studio and sends them an invite. */
  inviteOwner(studioId: ID, owner: { name: string; email: string }): Promise<Staff>;
  /** Staff and clients per studio, for the admin list. */
  studioStats?(): Promise<Record<ID, { clients: number; staff: number; classesNext7Days: number }>>;

  /** Demo only. */
  demoPersonas?(app: 'client' | 'studio' | 'admin'): Promise<{ email: string; name: string; hint: string; studioId?: ID }[]>;
  demoSignInAs?(email: string): Promise<void>;
  demoReset?(): Promise<void>;
}

export type { PlatformUser, Studio, StudioMembership, StudioStatus };
export type { AuthUser, Booking, ClassSession, ClassType, Client, ID, ISODate, ISODateTime, Pass, PaymentMethod, Product, Sale, SaleItem, ScheduleTemplate, SessionWithCounts, Staff, StudioReport, StudioSettings, ReportRange, HealthForm };
