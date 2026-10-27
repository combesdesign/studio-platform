/**
 * Shared data model for the studio platform. One codebase, two deployments: the Snowy single-studio
 * deployment and the multi-studio platform (the Snowy deployment is just a platform with one studio).
 * OWNED BY THE LEAD / PLATFORM. Agents: do not change existing fields. If you truly need a new optional
 * field, add it (optional, documented) and note it in NOTES.md. Feature modules keep their own types in
 * src/features/<name>/types.ts.
 *
 * Conventions
 * - IDs are strings (uuid in Supabase, short random ids in the demo store).
 * - Money is integer cents in the studio's currency (Studio.currency). 3000 = $30.00. Prices include tax.
 * - Timestamps are ISO-8601 UTC strings. Display in the studio's timezone (Studio.timezone).
 * - Calendar dates (no time) are 'YYYY-MM-DD' in the studio timezone.
 *
 * Studio scoping: every record from "studio settings" down belongs to exactly one studio. The TS contract
 * does NOT put a studioId on each record. Instead a DataStore instance is bound to one studio (store.ts),
 * and the database keeps a studio_id column on every studio-owned table (supabase/migrations/0007).
 */

export type ID = string;
export type ISODateTime = string; // '2026-10-14T19:30:00.000Z'
export type ISODate = string; // '2026-10-14'
export type Cents = number;

// ---------------------------------------------------------------- platform: studios + branding

export type StudioStatus = 'onboarding' | 'live' | 'suspended';

/**
 * A studio's card-payment connection (Stripe Connect), for its owner only.
 * `connectMode` false = this deployment takes payments on its own single Stripe account (Snowy): nothing to connect.
 */
export interface PaymentsStatus {
  connectMode: boolean;
  /** Connected and Stripe says charges are on. */
  connected: boolean;
  accountId?: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/** Where a studio is with its platform plan (what it pays Pete). */
export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';

/** A platform plan: edited by Pete in the admin (a table, not code). `features` are feature keys (see FEATURE_CATALOG in plans.ts). */
export interface Plan {
  id: ID;
  /** Short stable handle: 'studio', 'studio_plus', 'signature'. */
  key: string;
  name: string;
  /** Monthly price in cents (AUD). */
  priceCents: number;
  /** The Stripe Price on the platform's own Stripe account. Empty until Pete creates it. */
  stripePriceId?: string;
  features: string[];
  sortOrder: number;
  /** Inactive plans can't be picked by studios any more; studios already on one keep it. */
  active: boolean;
}

/** The plan a studio is on, as the apps need it (name + the feature keys it switches on). */
export interface StudioPlan { id: ID; name: string; priceCents: number; features: string[] }

/** Platform-wide billing settings, edited in the admin. */
export interface PlatformBillingSettings {
  /** Free trial for a new studio: 14 or 30 days. */
  trialDays: 14 | 30;
  /** Days a past-due (or trial-ended) studio keeps full access before staff go read-only. */
  graceDays: number;
}

/** What a studio owner sees on Settings > Plan & billing. */
export interface BillingInfo {
  /** False on a single-studio build (Snowy): no plan, nothing to pay. */
  enabled: boolean;
  planId?: ID;
  status: BillingStatus;
  trialEndsAt?: ISODateTime;
  pastDueSince?: ISODateTime;
  /** Set by Pete (comp / free): no Stripe subscription. */
  comped: boolean;
  /** Has a Stripe subscription, so there's a billing portal to open. */
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: ISODateTime;
  settings: PlatformBillingSettings;
}

/** One studio on the platform. */
export interface Studio {
  id: ID;
  /** URL-safe handle: <slug>.<platform domain>, '#/s/<slug>' or '?studio=<slug>'. */
  slug: string;
  name: string;
  /** IANA timezone, e.g. 'Australia/Sydney'. All dates and times show in this zone. */
  timezone: string;
  /** ISO 4217, e.g. 'AUD'. */
  currency: string;
  /** BCP 47, e.g. 'en-AU'. */
  locale: string;
  // contact details
  email: string;
  phone?: string;
  address: string;
  website?: string;
  /** Business / tax number on receipts (an ABN in Australia). */
  taxId?: string;
  /** Label for taxId on receipts, e.g. 'ABN'. */
  taxIdLabel: string;
  /** e.g. 'GST'. */
  taxName: string;
  /** Prices include tax at this rate: 0.1 = 10%. Receipts show total x rate / (1 + rate). */
  taxRate: number;
  taxRegistered: boolean;
  status: StudioStatus;
  branding: StudioBranding;
  /** Extra hostnames that open this studio, e.g. 'app.snowypilatesclub.com'. */
  customDomains?: string[];
  createdAt: ISODateTime;
  /** Platform plan (absent = not on a plan yet: nothing is locked). */
  planId?: ID;
  plan?: StudioPlan;
  billingStatus?: BillingStatus;
  trialEndsAt?: ISODateTime;
  pastDueSince?: ISODateTime;
  /** Plan was set by hand (comp / free), not paid through Stripe. */
  billingComped?: boolean;
}

/** Colour roles. The apps only use the CSS variables these become (--primary, --ink, --accent, --soft, --highlight, --bg). */
export interface BrandColors {
  /** Main brand colour: buttons, bands, the studio sidebar (Snowy navy). */
  primary: string;
  /** Hover / pressed primary. Derived when absent. */
  primaryDeep?: string;
  /** Text and the darkest surfaces (Snowy ink). */
  ink: string;
  /** Accent: the italic headline word, the mark (Snowy sky). */
  accent: string;
  /** Soft tint for panels and toggles (Snowy mist). */
  soft: string;
  softDeep?: string;
  /** Warm highlight: badges, the intro offer (Snowy cream). */
  highlight: string;
  highlightSoft?: string;
  /** Page background. */
  bg: string;
  /** Secondary / tertiary text. Derived from ink + bg when absent. */
  muted?: string;
  faint?: string;
}

/** An animated-wordmark path: 'lt' paths rise in one by one (ordered by n), 'lf' paths (the mark) spin in. */
export interface LogoPath { c: 'lt' | 'lf'; n: number; d: string }

export interface BrandLogo {
  /** Inline SVG markup (no <svg> wrapper needed). Use fill="var(--logo-letters)" and fill="var(--logo-mark)"
   *  so the apps can recolour it on dark bands; add class="lt"/"lf" and style="--n:2" to animate it. */
  svg?: string;
  /** Or a hosted image (PNG / SVG / WebP). */
  imageUrl?: string;
  /** Or an animated-wordmark path set (Snowy's website reveal). */
  paths?: LogoPath[];
  /** viewBox for svg / paths, e.g. '448.3 282.1 1024.7 443.9'. */
  viewBox?: string;
  /** width / height. */
  aspect: number;
}

/** The small brand mark (Snowy's flower): bullets, stars, separators, empty states, loaders. */
export interface BrandMark {
  /** One SVG path, drawn in the mark colour. */
  d?: string;
  viewBox?: string;
  /** Or a hosted image. */
  imageUrl?: string;
}

export interface StudioBranding {
  /** Name on the home screen and title bar. */
  appName: string;
  /** Short name under the home-screen icon (keep it to about 12 characters). */
  shortName: string;
  colors: BrandColors;
  /** Google Fonts family names. */
  fonts: { display: string; body: string };
  logo: BrandLogo;
  mark: BrandMark;
  photos: {
    /** Wide hero photo: welcome, staff sign-in, Today header. */
    hero: string;
    /** Intro-offer and pricing photo. Falls back to hero. */
    offer?: string;
    /** Default class photo. Falls back to hero. */
    class?: string;
    /** Class photos by class type name (ClassType.imageUrl wins). */
    classes?: Record<string, string>;
  };
  /** The scrolling phrase strip, plus an optional different set for the shop. */
  marquee: string[];
  shopMarquee?: string[];
  /** Welcome screen. Wrap the accent word in *asterisks*: 'Join the newest club to hit *Cooma!*' */
  welcome: { headline: string; copy: string; quote?: { text: string; by: string } };
  /** Line under the logo on the launch screen ('Feel your best'). */
  launchLine?: string;
  /** Client profile footer: tagline and small base line. */
  tagline?: string;
  footerLine?: string;
  /** Staff sign-in headline, *accent* allowed. */
  staffHeadline?: string;
  /** Square app icon (512px). */
  iconUrl?: string;
  /** Escape hatch: pin derived CSS variables exactly (e.g. Snowy's original hover shades). See shared/branding.ts. */
  tokens?: Record<string, string>;
}

/** Where a signed-in person belongs: a client at some studios, staff at others. */
export interface StudioMembership {
  studioId: ID;
  slug: string;
  name: string;
  status: StudioStatus;
  kind: 'client' | 'staff';
  role?: StaffRole;
}

/** Platform-level role, above any studio. Pete (the platform owner) is a platform_admin. */
export type PlatformRole = 'platform_admin';

export interface PlatformUser {
  email: string;
  name: string;
  role: PlatformRole;
}

// ---------------------------------------------------------------- studio settings (per studio)

export interface StudioSettings {
  name: string; // 'Snowy Pilates Club'
  timezone: string; // 'Australia/Sydney'
  address: string; // '57 Vale Street, Cooma NSW 2630'
  email: string;
  phone?: string;
  abn?: string;
  gstRegistered: boolean;
  /** Cancel at least this many hours before start to get the credit back. */
  cancelWindowHours: number; // 3
  /** Waitlisted clients are auto-booked when a spot opens, up until this many hours before start. */
  waitlistCutoffHours: number; // 1
  /** Optional fees charged on top of losing the credit. 0 = no fee (current studio policy). */
  lateCancelFeeCents: Cents;
  noShowFeeCents: Cents;
  /** How far ahead clients can see and book. */
  bookingWindowDays: number; // 14
  /** Default capacity for new classes. */
  defaultCapacity: number;
  waiverText: string;
  healthQuestions: string[];
  cancellationPolicyText: string;
  waitlistPolicyText: string;
  /** Booking flow: ask first-timers the long health questionnaire (the waiver is always required). Unset = on. */
  longHealthFormFirstTimers?: boolean;
  /** Booking flow: ask returning clients "any new injuries or health changes?" (one tap). Unset = on. */
  quickHealthCheck?: boolean;
  /** ...at most once every this many days. Unset = 30. */
  quickHealthCheckDays?: number;
}

// ---------------------------------------------------------------- people

export type StaffRole = 'owner' | 'manager' | 'instructor' | 'front_desk';

export interface Staff {
  id: ID;
  name: string;
  email: string;
  phone?: string;
  role: StaffRole;
  bio?: string;
  photoUrl?: string; // e.g. '/img/libby.webp'
  /** Instructor pay per class taught, for pay reports. */
  payPerClassCents?: Cents;
  active: boolean;
}

export interface HealthForm {
  /** Answers keyed by question text (from settings.healthQuestions). */
  answers: Record<string, string>;
  injuries?: string;
  pregnantOrPostnatal?: boolean;
  submittedAt: ISODateTime;
}

export interface Client {
  id: ID;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  birthday?: ISODate;
  /** Profile photo the client adds themselves. Demo: small JPEG data URL. Live: Supabase Storage public URL. */
  photoUrl?: string;
  createdAt: ISODateTime;
  /** Staff-only notes. Never shown to the client. */
  staffNotes?: string;
  /** Injuries / health notes visible to staff on rosters. */
  injuries?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  waiverSignedAt?: ISODateTime;
  healthForm?: HealthForm;
  /** The last time they answered the quick "any new injuries?" check (or the full form). */
  healthCheckedAt?: ISODateTime;
  /** The latest "yes, something's changed" from the quick check. Flags the roster until they next attend. */
  healthUpdate?: { note: string; at: ISODateTime };
  marketingOptIn: boolean;
  /** Imported from Momence etc. */
  source?: 'app' | 'staff' | 'import';
  archived?: boolean;
  /**
   * Family accounts: set on a dependant (a child, or a partner without their own login). It's the parent's client id.
   * A dependant is an ordinary client row (so bookings, rosters and reports just work) with no login and, usually, no email.
   * Guardians can't be dependants themselves (one level only). See docs/features/family.md.
   */
  guardianClientId?: ID;
  /** Derived on read (never stored): the guardian's full name, for "via Sarah" tags. */
  guardianName?: string;
}

// ---------------------------------------------------------------- classes

export interface ClassType {
  id: ID;
  name: string; // 'Mat Essentials'
  description: string;
  durationMin: number;
  /** Hex colour for the timetable. */
  color: string;
  defaultCapacity: number;
  level?: string; // 'All levels'
  /** Shown to clients before they book, e.g. clearance needed for Mums + Bubs. */
  bookingNote?: string;
  /** false = 'coming soon' / register interest only. */
  bookable: boolean;
  active: boolean;
  /** Optional photo for this class type (else the studio branding's class photos). */
  imageUrl?: string;
  /** "Let clients pick a spot". Off by default. Only classes in a room with a spot layout use it. */
  spotPicking?: boolean;
}

/** What a cell in a room's spot layout is. */
export type SpotKind = 'spot' | 'instructor' | 'unavailable';
/** One cell: a bookable spot (its label is its id, e.g. "7"), the instructor's place, or somewhere clients can't book. */
export interface SpotCell { label: string; kind: SpotKind }
/** A simple grid of spots (mats or reformers), `cells` row by row (rows x cols of them). */
export interface SpotLayout { rows: number; cols: number; cells: SpotCell[] }
/** What the spot picker needs for a class: the layout and which spots are taken (never who by). */
export interface SessionSpots {
  enabled: boolean;
  layout?: SpotLayout;
  taken: string[];
}

/** A place the studio runs classes. Every studio has a default one; most never see this. */
export interface Location {
  id: ID;
  name: string;
  address: string;
  /** IANA zone. Absent = the studio's. */
  timezone?: string;
  active: boolean;
  /** The location that classes without a location belong to. Exactly one per studio. */
  isDefault?: boolean;
  sortOrder?: number;
}

/** A room at a location. Only one class (or appointment or event) can use a room at a time. */
export interface Room {
  id: ID;
  locationId: ID;
  name: string;
  /** Prefills the capacity of classes held in this room. */
  capacity?: number;
  active: boolean;
  /** Optional grid of spots (mats or reformers) clients can pick from, for class types with spot picking on. */
  spotLayout?: SpotLayout;
}

/** A recurring weekly slot that generates ClassSessions. */
export interface ScheduleTemplate {
  id: ID;
  classTypeId: ID;
  /** 0 = Sunday … 6 = Saturday, in studio timezone. */
  weekday: number;
  /** 'HH:mm' 24h, studio timezone. */
  startTime: string;
  instructorId: ID;
  capacity?: number; // falls back to class type default
  startsOn: ISODate;
  endsOn?: ISODate;
  active: boolean;
  /** Where it happens (multi-location studios). Absent = the studio's default location. */
  locationId?: ID;
  roomId?: ID;
}

export type SessionStatus = 'scheduled' | 'cancelled';

export interface ClassSession {
  id: ID;
  classTypeId: ID;
  templateId?: ID;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  instructorId: ID;
  capacity: number;
  status: SessionStatus;
  /** Public note shown on the timetable, e.g. 'Bring a towel'. */
  note?: string;
  cancelReason?: string;
  /** Where it happens. Absent = the studio's default location / no particular room. */
  locationId?: ID;
  roomId?: ID;
}

/** A session plus live counts, as returned by listSessions/getSession. */
export interface SessionWithCounts extends ClassSession {
  bookedCount: number; // booked + checked_in
  waitlistCount: number;
  spotsLeft: number; // max(0, capacity - bookedCount)
}

// ---------------------------------------------------------------- products & passes

export type ProductKind = 'membership' | 'pack' | 'intro' | 'dropin' | 'retail';

export interface Product {
  id: ID;
  kind: ProductKind;
  name: string; // '2 classes per week'
  description: string;
  priceCents: Cents;
  active: boolean;
  /** Shown as a badge in the shop. */
  highlight?: string; // 'Recommended'
  sortOrder: number;

  // --- class passes (membership | pack | intro | dropin)
  /**
   * pack/dropin: total credits (dropin = 1).
   * membership: credits per week (null = unlimited).
   * intro: null = unlimited for the validity period.
   */
  credits?: number | null;
  /** Days the pass lasts, counted from FIRST USE (studio rule). pack 4 = 61, pack 8 = 122, intro = 14. */
  validityDays?: number | null;
  /** membership only: billing period. Studio bills weekly by direct debit. */
  billingInterval?: 'week' | 'month';
  /** intro only. */
  newClientsOnly?: boolean;
  /** Limit to certain class types. Empty/undefined = any class. */
  classTypeIds?: ID[];
  /** No studio class access (the Online membership: on-demand video only). Never books a class, never reads as "Unlimited". */
  noClasses?: boolean;
  /**
   * Family accounts: may the buyer's dependants spend this pass's credits? Unset = packs and drop-ins yes, memberships and
   * intro offers no (see isFamilyShareable). Copied onto the pass at purchase.
   */
  familyShareable?: boolean;

  // --- retail
  stock?: number | null;
}

export type PassStatus = 'active' | 'paused' | 'expired' | 'cancelled' | 'used_up';

/** A client's purchased membership / pack / intro / drop-in credit. */
export interface Pass {
  id: ID;
  clientId: ID;
  productId: ID;
  kind: Exclude<ProductKind, 'retail'>;
  name: string;
  status: PassStatus;
  purchasedAt: ISODateTime;
  /** Set on first booking (validity counts from first use). */
  activatedAt?: ISODateTime;
  /** Set when activated: activatedAt + validityDays. null = no expiry. */
  expiresAt?: ISODateTime | null;
  /** pack/dropin: total credits. intro/unlimited membership: null. membership: credits per week. */
  credits: number | null;
  /** pack/dropin: credits used in total. membership: not used (count bookings per week instead). */
  creditsUsed: number;
  /** membership */
  billingInterval?: 'week' | 'month';
  nextBillingAt?: ISODateTime;
  pausedFrom?: ISODate;
  pausedUntil?: ISODate;
  priceCents: Cents;
  classTypeIds?: ID[];
  /** Copied from the product at purchase: gives no studio class access. */
  noClasses?: boolean;
  /** Copied from the product at purchase (see Product.familyShareable). */
  familyShareable?: boolean;
  /** Free-text history of manual adjustments by staff (and membership edits, with delta 0). */
  adjustments?: { at: ISODateTime; staffId?: ID; delta: number; reason: string }[];
  /** membership: a move to another membership that takes effect at the next billing date. */
  pendingChange?: { productId: ID; name: string; credits: number | null; priceCents: Cents; effectiveAt: ISODateTime };
}

// ---------------------------------------------------------------- bookings

export type BookingStatus =
  | 'booked'
  | 'waitlisted'
  | 'checked_in'
  | 'cancelled' // cancelled in time, credit returned
  | 'late_cancelled' // cancelled inside window, credit lost
  | 'no_show' // credit lost
  | 'removed'; // removed from waitlist / session cancelled by studio (credit returned)

export interface Booking {
  id: ID;
  sessionId: ID;
  clientId: ID;
  status: BookingStatus;
  /** Pass the credit came from. Waitlisted bookings have none until promoted. */
  passId?: ID;
  createdAt: ISODateTime;
  /** For waitlisted bookings: lower = earlier. */
  waitlistPosition?: number;
  promotedFromWaitlistAt?: ISODateTime;
  cancelledAt?: ISODateTime;
  checkedInAt?: ISODateTime;
  source: 'client' | 'staff';
  bookedByStaffId?: ID;
  /** What it was before its last status change (and its waitlist spot, if it was waitlisted). Undo uses these. */
  priorStatus?: BookingStatus;
  priorWaitlistPosition?: number;
  /** The spot (mat or reformer) held in a class that has spot picking. Only booked and checked-in bookings have one. */
  spot?: string;
}

// ---------------------------------------------------------------- money

export type PaymentMethod = 'card_online' | 'card_reader' | 'cash' | 'comp' | 'imported';

export interface SaleItem {
  productId?: ID;
  name: string;
  qty: number;
  unitCents: Cents;
}

export interface Sale {
  id: ID;
  clientId?: ID; // walk-in retail can be anonymous
  items: SaleItem[];
  totalCents: Cents;
  method: PaymentMethod;
  staffId?: ID;
  createdAt: ISODateTime;
  /** Stripe ids once live. */
  stripePaymentIntentId?: string;
  refundedAt?: ISODateTime;
  refundedCents?: Cents;
  note?: string;
}

// ---------------------------------------------------------------- auth

export type AuthUser =
  | { kind: 'client'; clientId: ID; email: string; name: string }
  | { kind: 'staff'; staffId: ID; email: string; name: string; role: StaffRole };

// ---------------------------------------------------------------- reports

export interface ReportRange {
  from: ISODate;
  to: ISODate; // inclusive
  /** Only classes at this location (attendance, fill, instructors). Sales aren't split by location, so revenue stays studio-wide. */
  locationId?: ID;
}

export interface StudioReport {
  range: ReportRange;
  revenueCents: Cents;
  refundsCents: Cents;
  revenueByMethod: Partial<Record<PaymentMethod, Cents>>;
  revenueByKind: Partial<Record<ProductKind, Cents>>;
  salesCount: number;
  classesRun: number;
  totalBookings: number; // booked+checked_in+no_show+late_cancelled
  attended: number; // checked_in
  noShows: number;
  lateCancels: number;
  avgFillPct: number; // 0..100 over classes run
  newClients: number;
  activeMemberships: number;
  activePacks: number;
  byInstructor: { staffId: ID; name: string; classes: number; attendees: number; payCents: Cents }[];
  byClassType: { classTypeId: ID; name: string; classes: number; attendees: number; avgFillPct: number }[];
  /** Busiest slots, e.g. 'Mon 6:00am'. */
  topSlots: { label: string; avgAttendees: number }[];
}
