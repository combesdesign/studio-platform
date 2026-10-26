/**
 * Appointments feature (ROADMAP B1): private and duet appointments, appointment packs, workshops / courses / events.
 * Owner: the appointments feature agent. Everything for this feature lives in src/features/appointments/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1100_appointments_*.sql (range 1100–1199), tests supabase/tests/appointments_*.sql.
 *
 * Conventions (same as the core): money is integer cents in the studio currency; instants are ISO UTC strings; calendar dates
 * are 'YYYY-MM-DD' in the studio timezone; weekly availability times are 'HH:mm' in the studio timezone.
 *
 * Credits: appointment packs have their OWN credit records (AppointmentCredit), not core passes. Core passes are bound up with
 * the class engine (weekly memberships, class-type eligibility, bookings.pass_id), and a "5 privates" pack is a different thing.
 * Money still goes through the core: every purchase is a core Sale (so receipts, reports and refunds just work).
 */
import type { Cents, ID, ISODate, ISODateTime, PaymentMethod, Sale } from '../../shared/types';

// ---------------------------------------------------------------- configuration

/** Per-studio knobs for slot generation (Settings › Appointments). The cancel window is NOT here: it's the studio's own. */
export interface AppointmentSettings {
  /** Slots start on this grid inside an availability window (minutes past the window start). */
  slotStepMin: number;
  /** Clients can't book sooner than this many hours ahead. */
  minNoticeHours: number;
  /** Clients can book this many days ahead. */
  horizonDays: number;
  /** Hours a client has to claim a workshop or event place once the waitlist offers it to them. */
  waitlistClaimHours: number;
  /** How long before a session, workshop or event the reminder email goes out: 2, 12, 24 or 48 hours (REMINDER_HOURS). */
  reminderHours: number;
}

export interface AppointmentType {
  id: ID;
  name: string;
  description: string;
  durationMin: number;
  /** Price PER PERSON. A duet booked for two costs 2 × this (or 2 credits). */
  priceCents: Cents;
  /** 1 = private, 2 = duet (the client may bring a second person). */
  capacity: 1 | 2;
  /** Cleaning / reset time kept free after the session. */
  bufferMin: number;
  /** Staff who offer it. */
  staffIds: ID[];
  /** Shown to clients before they book. */
  bookingNote?: string;
  imageUrl?: string;
  active: boolean;
  sortOrder?: number;
}

/** A pack of appointment credits for sale ("5 reformer privates"). One credit = one person in one session. */
export interface AppointmentPack {
  id: ID;
  name: string;
  description: string;
  credits: number;
  priceCents: Cents;
  /** Days the credits last, counted from first use (the same rule as class packs). null = no expiry. */
  validityDays: number | null;
  /** Appointment types it can be used for. Empty = any. */
  typeIds: ID[];
  active: boolean;
}

/** A client's purchased pack. */
export interface AppointmentCredit {
  id: ID;
  clientId: ID;
  packId: ID;
  name: string;
  credits: number;
  used: number;
  /** credits - used. */
  remaining: number;
  validityDays: number | null;
  typeIds: ID[];
  purchasedAt: ISODateTime;
  /** Set on first use: activatedAt + validityDays. */
  activatedAt?: ISODateTime;
  expiresAt?: ISODateTime | null;
  saleId?: ID;
  /** Derived: 'active' | 'used_up' | 'expired'. */
  status: 'active' | 'used_up' | 'expired';
}

/** Weekly working hours for one staff member (several windows per weekday are fine). */
export interface AvailabilityRule {
  id: ID;
  staffId: ID;
  /** 0 = Sunday … 6 = Saturday, studio timezone. */
  weekday: number;
  start: string; // 'HH:mm'
  end: string; // 'HH:mm'
}
export type AvailabilityInput = Omit<AvailabilityRule, 'id' | 'staffId'>;

/** One-off time off: blocks every slot that overlaps it. */
export interface TimeOff {
  id: ID;
  staffId: ID;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  note?: string;
}

/** A bookable start time. */
export interface AppointmentSlot {
  typeId: ID;
  staffId: ID;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
}

// ---------------------------------------------------------------- appointments

export type AppointmentStatus =
  | 'booked'
  | 'completed'
  | 'cancelled' // in time: credit back / refund due
  | 'late_cancelled' // inside the cancel window: credit or payment kept
  | 'no_show'
  | 'pending_payment'; // live only: a slot held for ~15 minutes while the client is at Stripe

export type AppointmentPayMethod = 'pack' | Extract<PaymentMethod, 'card_online' | 'card_reader' | 'cash' | 'comp'>;

export interface AppointmentPayment {
  method: AppointmentPayMethod;
  /** What was paid in money (0 for pack credits and comps). */
  amountCents: Cents;
  /** Pack credits used (method 'pack'). */
  credits?: { creditId: ID; n: number }[];
  /** The core Sale behind a money payment. */
  saleId?: ID;
}

export interface Appointment {
  id: ID;
  typeId: ID;
  /** Names are filled in by the store so lists and history still read well if a type is renamed. */
  typeName: string;
  staffId: ID;
  staffName: string;
  clientId: ID;
  clientName: string;
  /** People in the session (1, or 1–2 for a duet). */
  people: number;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  bufferMin: number;
  status: AppointmentStatus;
  payment: AppointmentPayment;
  /** The client's note to the instructor ("tight hips, first time on a reformer"). */
  note?: string;
  source: 'client' | 'staff';
  bookedByStaffId?: ID;
  createdAt: ISODateTime;
  cancelledAt?: ISODateTime;
  /** Cancelled in time after paying money: the studio still has to refund it (Refund button; the core refund does the work). */
  refundDue?: boolean;
}

export interface BookAppointmentInput {
  typeId: ID;
  staffId: ID;
  startsAt: ISODateTime;
  /** Default 1. */
  people?: number;
  /** Staff booking on behalf. Clients book themselves. */
  clientId?: ID;
  note?: string;
  pay: { method: AppointmentPayMethod; /** Optional: a specific credit. Default: the one expiring soonest. */ creditId?: ID };
}

export interface BookAppointmentResult {
  appointment: Appointment;
  sale?: Sale;
}

export interface CancelAppointmentResult {
  appointment: Appointment;
  /** Credits went back to the pack. */
  creditsReturned: number;
  /** Money paid and the studio owes it back (see Appointment.refundDue). */
  refundDue: boolean;
  late: boolean;
}

// ---------------------------------------------------------------- workshops, courses, events

export type EventKind = 'workshop' | 'course' | 'event';

export interface EventSession {
  startsAt: ISODateTime;
  endsAt: ISODateTime;
}

export interface StudioEvent {
  id: ID;
  /** workshop = one session; course = several sessions bought once; event = one-off (talks, socials). */
  kind: EventKind;
  title: string;
  description: string;
  imageUrl?: string;
  /** Per person, for the whole thing (all sessions of a course). 0 = free. */
  priceCents: Cents;
  capacity: number;
  hostStaffId?: ID;
  location?: string;
  /** 1+ sessions, sorted. */
  sessions: EventSession[];
  /** Clients only see published events. */
  published: boolean;
  cancelled?: boolean;
  cancelReason?: string;
  /** Cancel at least this many hours before the FIRST session for a refund (workshops usually need more notice than a class). */
  refundCutoffHours: number;
  createdAt: ISODateTime;
}
export type StudioEventInput = Omit<StudioEvent, 'id' | 'createdAt' | 'cancelled' | 'cancelReason'> & { id?: ID };

export interface StudioEventSummary extends StudioEvent {
  registered: number;
  /** Places nobody has or is being held for. A place offered from the waitlist isn't free until the offer lapses. */
  spotsLeft: number;
  /** People in line (waiting, or holding an offer). */
  waitlisted: number;
  /** The signed-in client's place in line, if they're on it (clients only). */
  myWaitlist?: WaitlistEntry;
  /** The signed-in client's registration, if any (clients only). */
  mine?: EventRegistration;
}

export type RegistrationStatus = 'registered' | 'cancelled' | 'late_cancelled' | 'pending_payment';

export interface EventRegistration {
  id: ID;
  eventId: ID;
  eventTitle: string;
  eventKind: EventKind;
  clientId: ID;
  clientName: string;
  status: RegistrationStatus;
  payment: { method: AppointmentPayMethod; amountCents: Cents; saleId?: ID };
  createdAt: ISODateTime;
  cancelledAt?: ISODateTime;
  /** Sessions the client was marked present for (session startsAt). */
  attended: ISODateTime[];
  refundDue?: boolean;
  /** First session start, for sorting and the cancel window. */
  startsAt: ISODateTime;
}

export type WaitlistStatus = 'waiting' | 'offered' | 'claimed' | 'expired' | 'left';

/**
 * A client in line for a full workshop or event. When a place opens the first person waiting is offered it by email and
 * has the studio's claim window to take it (free: sign up as normal; paid: pay as normal). Past that the offer goes to the next.
 */
export interface WaitlistEntry {
  id: ID;
  eventId: ID;
  eventTitle: string;
  clientId: ID;
  clientName: string;
  status: WaitlistStatus;
  /** 1 = first in line (counts everyone waiting or holding an offer). */
  position: number;
  joinedAt: ISODateTime;
  offeredAt?: ISODateTime;
  /** While 'offered': the place is theirs until then. */
  offerExpiresAt?: ISODateTime;
}

export interface RegisterInput {
  eventId: ID;
  /** Staff registering on behalf. */
  clientId?: ID;
  method: Exclude<AppointmentPayMethod, 'pack'>;
}

export interface CancelRegistrationResult {
  registration: EventRegistration;
  refundDue: boolean;
  late: boolean;
}

// ---------------------------------------------------------------- online checkout (live: Stripe)

/** What a client is about to pay for online. Live: appointments-checkout turns it into a Stripe Checkout URL. */
export type CheckoutOrder =
  | { kind: 'appointment'; booking: Omit<BookAppointmentInput, 'pay' | 'clientId'>; /** Family accounts: a parent paying for their dependant. */ clientId?: ID }
  | { kind: 'pack'; packId: ID }
  | { kind: 'event'; eventId: ID; /** Family accounts: a parent paying for their dependant. */ clientId?: ID };

// ---------------------------------------------------------------- the store

/** What the apps can call as store.features.appointments. */
export interface AppointmentsStore {
  // --- setup (staff: appointments.manage for the catalogue; staff edit their own hours / time off)
  getSettings(): Promise<AppointmentSettings>;
  updateSettings(patch: Partial<AppointmentSettings>): Promise<AppointmentSettings>;

  /** Clients only get active types. */
  listTypes(opts?: { includeInactive?: boolean }): Promise<AppointmentType[]>;
  upsertType(t: Omit<AppointmentType, 'id'> & { id?: ID }): Promise<AppointmentType>;

  listPacks(opts?: { includeInactive?: boolean }): Promise<AppointmentPack[]>;
  upsertPack(p: Omit<AppointmentPack, 'id'> & { id?: ID }): Promise<AppointmentPack>;

  listAvailability(staffId?: ID): Promise<AvailabilityRule[]>;
  /** Replace a staff member's weekly hours. Managers for anyone; staff for themselves. */
  setAvailability(staffId: ID, rules: AvailabilityInput[]): Promise<AvailabilityRule[]>;
  listTimeOff(staffId?: ID): Promise<TimeOff[]>;
  addTimeOff(input: { staffId: ID; startsAt: ISODateTime; endsAt: ISODateTime; note?: string }): Promise<TimeOff>;
  removeTimeOff(id: ID): Promise<void>;

  // --- slots and booking
  /**
   * Open start times for a type between two studio dates (inclusive). Avoids classes they teach, other appointments, time off, buffers.
   * `excludeAppointmentId`: an appointment being moved, so its own time doesn't count as busy.
   */
  listSlots(q: { typeId: ID; from: ISODate; to: ISODate; staffId?: ID; excludeAppointmentId?: ID }): Promise<AppointmentSlot[]>;
  bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult>;
  /** Client (own, with the studio cancel window) or staff (can waive the penalty). */
  cancelAppointment(id: ID, opts?: { waivePenalty?: boolean }): Promise<CancelAppointmentResult>;
  /**
   * Move a booked appointment to another open time for the same session type, with the same instructor (default) or another who
   * offers it. One step, not a cancel and a rebook: it keeps its payment or pack credits and sends a "moved" email. Clients can
   * move (their own and their family's) until the studio's cancellation window; staff can move any time.
   */
  moveAppointment(id: ID, to: { startsAt: ISODateTime; staffId?: ID }): Promise<Appointment>;
  /** Staff: mark completed / no-show (or put back to booked). */
  setAppointmentStatus(id: ID, status: 'completed' | 'no_show' | 'booked'): Promise<Appointment>;
  /** Clients see their own; instructors see theirs; owner / manager / front desk see all. startsAt in [from, to). */
  listAppointments(q?: { from?: ISODateTime; to?: ISODateTime; staffId?: ID; clientId?: ID; includeCancelled?: boolean }): Promise<Appointment[]>;

  // --- packs
  buyPack(input: { packId: ID; clientId?: ID; method: Exclude<AppointmentPayMethod, 'pack'> }): Promise<{ credit: AppointmentCredit; sale: Sale }>;
  listCredits(clientId?: ID, opts?: { includeInactive?: boolean }): Promise<AppointmentCredit[]>;

  // --- workshops, courses, events
  /** Clients: published, not cancelled, not finished (with their own registration). Staff: everything (opts.includePast for history). */
  listEvents(opts?: { includePast?: boolean }): Promise<StudioEventSummary[]>;
  getEvent(id: ID): Promise<StudioEventSummary>;
  upsertEvent(e: StudioEventInput): Promise<StudioEvent>;
  /** Cancels the event: every registration is cancelled and a refund is due for the paid ones. */
  cancelEvent(id: ID, reason: string): Promise<StudioEvent>;
  register(input: RegisterInput): Promise<{ registration: EventRegistration; sale?: Sale }>;
  cancelRegistration(id: ID, opts?: { waivePenalty?: boolean }): Promise<CancelRegistrationResult>;
  /** The client's own registrations (or a client's, for staff), or an event's attendee list (staff). */
  listRegistrations(q: { clientId: ID } | { eventId: ID }): Promise<EventRegistration[]>;
  setAttendance(registrationId: ID, sessionStartsAt: ISODateTime, present: boolean): Promise<EventRegistration>;

  // --- waitlist (a full workshop / event)
  /** Join the line for a full event (clients for themselves and their family, the front desk for anyone). */
  joinWaitlist(input: { eventId: ID; clientId?: ID }): Promise<WaitlistEntry>;
  /** Leave the line, or give an offered place back (it goes to the next person). Own entry, or the front desk. */
  leaveWaitlist(id: ID): Promise<void>;
  /** People in line (waiting or holding an offer), in order: an event's list (front desk and the host) or a client's own entries. */
  listWaitlist(q: { eventId: ID } | { clientId: ID }): Promise<WaitlistEntry[]>;

  // --- refunds (money back for in-time cancellations)
  /** Staff: after refunding the sale (store.refundSale), clear the "refund due" flag. */
  markRefunded(target: { appointmentId: ID } | { registrationId: ID }): Promise<void>;

  /**
   * Live store only: a Stripe Checkout URL for an online payment (the booking / pack / registration is completed by the
   * appointments-stripe-webhook when Stripe confirms). Demo: returns null, so the UI shows the fake card sheet and then
   * calls bookAppointment / buyPack / register with method 'card_online'.
   */
  startCheckout?(order: CheckoutOrder & { returnUrl: string }): Promise<{ url: string } | null>;
}

declare module '../../shared/store' {
  interface FeatureStores { appointments: AppointmentsStore }
}
