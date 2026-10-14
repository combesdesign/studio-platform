/**
 * Snowy Pilates Club — shared data model.
 * OWNED BY THE LEAD. Agents: do not change existing fields. If you truly need a new
 * optional field, add it (optional, documented) and note it in NOTES.md.
 *
 * Conventions
 * - IDs are strings (uuid in Supabase, short random ids in the demo store).
 * - Money is integer cents (AUD). 3000 = $30.00. Prices include GST.
 * - Timestamps are ISO-8601 UTC strings. Display in the studio timezone (Australia/Sydney).
 * - Calendar dates (no time) are 'YYYY-MM-DD' in the studio timezone.
 */

export type ID = string;
export type ISODateTime = string; // '2026-10-14T19:30:00.000Z'
export type ISODate = string; // '2026-10-14'
export type Cents = number;

// ---------------------------------------------------------------- studio

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
  marketingOptIn: boolean;
  /** Imported from Momence etc. */
  source?: 'app' | 'staff' | 'import';
  archived?: boolean;
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
  /** Free-text history of manual adjustments by staff. */
  adjustments?: { at: ISODateTime; staffId?: ID; delta: number; reason: string }[];
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
