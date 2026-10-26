/**
 * Demo engine: the studio's operations over an in-memory state object.
 * No auth / permissions / persistence here (that's the store wrapper in index.ts) —
 * this is also what the seeder drives with a simulated clock, so seeded data is
 * consistent by construction.
 */
import { StoreError } from '../../shared/store';
import type { BookResult, CancelResult, RestoreSessionResult, UndoCancelResult, VoidResult } from '../../shared/store';
import type {
  Booking, BookingStatus, ClassSession, ClassType, Client, ID, ISODate, ISODateTime, Location, Pass, PaymentMethod, Product, Sale,
  Room, ScheduleTemplate, SessionWithCounts, Staff, StudioSettings,
} from '../../shared/types';
import { addDays, time as clockTime } from '../../shared/format';
import { directFull, directSpotsLeft } from '../../domain/capacity';
import { demoFeatures } from './features';
import {
  ACTIVE_BOOKING_STATUSES, CREDIT_USING_STATUSES, SPOT_STATUSES, activatePass, canAutoPromote, cancellationOutcome,
  checkPassForSession, compareWaitlist, comparePassPriority, computePassStatus, generateSessions, hasEnded, hasStarted,
  isCountedPass, isFamilyShareable, isIntroEligible, isPausedOn, nextBillingAfter, pickWaitlistPromotion, withinBookingWindow,
  studioDay as studioDate, classUses, clashMessage, findRoomClash, locationOfRoom, type Eligibility, type PassUse,
} from '../../domain';

export const STATE_VERSION = 1;

export interface OutboxMessage {
  at: ISODateTime;
  clientId: ID;
  kind: 'waitlist_promoted' | 'class_cancelled' | 'booking_moved' | 'class_restored';
  text: string;
}

export interface DemoState {
  version: number;
  seededAt: ISODateTime;
  /** Earliest studio date sessions are generated for (start of seeded history). */
  historyFrom: ISODate;
  settings: StudioSettings;
  staff: Staff[];
  classTypes: ClassType[];
  templates: ScheduleTemplate[];
  sessions: ClassSession[];
  /** Locations and rooms. Missing in older saved demos and single-location studios: ensureLocations makes the default pair. */
  locations?: Location[];
  rooms?: Room[];
  bookings: Booking[];
  clients: Client[];
  products: Product[];
  passes: Pass[];
  sales: Sale[];
  /** passId -> saleId that created it (for refunds). */
  passSale: Record<ID, ID>;
  /** bookingId -> the fee sale a no-show / late cancel created (so undo can take it off again). */
  penaltyFees?: Record<ID, ID>;
  /** sessionId -> when the studio cancelled it (so restore knows which removals came from that). */
  sessionCancelledAt?: Record<ID, ISODateTime>;
  /** Notifications the live app would send (email/push). Demo only, newest last. */
  outbox: OutboxMessage[];
  /** "Register interest" for coming-soon class types (one row per client + class type). Staff can see it. */
  interest?: { clientId: ID; classTypeId: ID; at: ISODateTime }[];
  /** Client persona emails for the demo sign-in list, in order: brand new, member, pack, intro. */
  personas?: string[];
  /** One-line description of each persona for the demo sign-in list, by email. */
  personaHints?: Record<string, string>;
  /** Feature modules' own demo data, keyed by feature name (src/features/<name>/demo.ts). */
  features?: Record<string, unknown>;
}

export type Actor = { kind: 'client'; clientId: ID } | { kind: 'staff'; staffId: ID } | { kind: 'system' };

export interface BookOpts {
  by: Actor;
  passId?: ID;
  allowOverCapacity?: boolean;
  skipCredit?: boolean;
}

let counter = 0;
export function randomId(prefix: string): ID {
  counter = (counter + 1) % 1296;
  return `${prefix}_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 8)}${counter.toString(36)}`;
}

const err = (code: string, msg: string) => new StoreError(code, msg);

export class Engine {
  private sessionsById = new Map<ID, ClassSession>();
  private bookingsById = new Map<ID, Booking>();
  private passesById = new Map<ID, Pass>();
  private clientsById = new Map<ID, Client>();
  private productsById = new Map<ID, Product>();

  constructor(public s: DemoState, public now: () => Date, public newId: (prefix: string) => ID = randomId) {
    this.reindex();
  }

  reindex(): void {
    this.sessionsById = new Map(this.s.sessions.map((x) => [x.id, x]));
    this.bookingsById = new Map(this.s.bookings.map((x) => [x.id, x]));
    this.passesById = new Map(this.s.passes.map((x) => [x.id, x]));
    this.clientsById = new Map(this.s.clients.map((x) => [x.id, x]));
    this.productsById = new Map(this.s.products.map((x) => [x.id, x]));
  }

  // ---------------------------------------------------------------- lookups
  session(id: ID): ClassSession {
    const x = this.sessionsById.get(id);
    if (!x) throw err('NOT_FOUND', 'That class could not be found.');
    return x;
  }
  booking(id: ID): Booking {
    const x = this.bookingsById.get(id);
    if (!x) throw err('NOT_FOUND', 'That booking could not be found.');
    return x;
  }
  pass(id: ID): Pass {
    const x = this.passesById.get(id);
    if (!x) throw err('NOT_FOUND', 'That pass could not be found.');
    return x;
  }
  client(id: ID): Client {
    const x = this.clientsById.get(id);
    if (!x) throw err('NOT_FOUND', 'That client could not be found.');
    return x;
  }
  product(id: ID): Product {
    const x = this.productsById.get(id);
    if (!x) throw err('NOT_FOUND', 'That product could not be found.');
    return x;
  }
  classType(id: ID): ClassType {
    const x = this.s.classTypes.find((c) => c.id === id);
    if (!x) throw err('NOT_FOUND', 'That class type could not be found.');
    return x;
  }
  findSession(id: ID): ClassSession | undefined { return this.sessionsById.get(id); }
  findClient(id: ID): Client | undefined { return this.clientsById.get(id); }
  findPass(id: ID): Pass | undefined { return this.passesById.get(id); }

  addSession(x: ClassSession): void { this.s.sessions.push(x); this.sessionsById.set(x.id, x); }
  addBooking(x: Booking): void { this.s.bookings.push(x); this.bookingsById.set(x.id, x); }
  addPass(x: Pass): void { this.s.passes.push(x); this.passesById.set(x.id, x); }
  addClient(x: Client): void { this.s.clients.push(x); this.clientsById.set(x.id, x); }
  addProduct(x: Product): void { this.s.products.push(x); this.productsById.set(x.id, x); }
  removeSessions(ids: Set<ID>): void {
    this.s.sessions = this.s.sessions.filter((x) => !ids.has(x.id));
    for (const id of ids) this.sessionsById.delete(id);
  }

  sessionBookings(sessionId: ID): Booking[] {
    return this.s.bookings.filter((b) => b.sessionId === sessionId);
  }
  clientBookings(clientId: ID): Booking[] {
    return this.s.bookings.filter((b) => b.clientId === clientId);
  }
  clientPasses(clientId: ID): Pass[] {
    return this.s.passes.filter((p) => p.clientId === clientId);
  }

  counts(sessionId: ID): { booked: number; waitlist: number } {
    let booked = 0, waitlist = 0;
    for (const b of this.s.bookings) {
      if (b.sessionId !== sessionId) continue;
      if (SPOT_STATUSES.includes(b.status)) booked++;
      else if (b.status === 'waitlisted') waitlist++;
    }
    return { booked, waitlist };
  }

  /** Spots features keep back from direct clients in this class (unfilled spots held for a partner). Staff ignore it. */
  heldBack(session: ClassSession): number {
    let n = 0;
    for (const f of demoFeatures()) n += Math.max(0, f.heldBack?.(this.s, session) ?? 0);
    return n;
  }

  /** `direct` = what a client sees (held-back spots set aside); staff get the real number. */
  withCounts(session: ClassSession, countsCache?: Map<ID, { booked: number; waitlist: number }>, direct = false): SessionWithCounts {
    const c = countsCache?.get(session.id) ?? this.counts(session.id);
    return { ...session, bookedCount: c.booked, waitlistCount: c.waitlist, spotsLeft: direct ? directSpotsLeft(session.capacity, c.booked, this.heldBack(session)) : Math.max(0, session.capacity - c.booked) };
  }

  allCounts(): Map<ID, { booked: number; waitlist: number }> {
    const m = new Map<ID, { booked: number; waitlist: number }>();
    for (const b of this.s.bookings) {
      let c = m.get(b.sessionId);
      if (!c) { c = { booked: 0, waitlist: 0 }; m.set(b.sessionId, c); }
      if (SPOT_STATUSES.includes(b.status)) c.booked++;
      else if (b.status === 'waitlisted') c.waitlist++;
    }
    return m;
  }

  // ---------------------------------------------------------------- credits
  passUses(passId: ID): PassUse[] {
    const out: PassUse[] = [];
    for (const b of this.s.bookings) {
      if (b.passId !== passId) continue;
      const s = this.sessionsById.get(b.sessionId);
      if (s) out.push({ bookingId: b.id, status: b.status, startsAt: s.startsAt });
    }
    return out;
  }
  validityDays(pass: Pass): number | null | undefined {
    return this.productsById.get(pass.productId)?.validityDays;
  }
  eligibility(pass: Pass, session: Pick<ClassSession, 'startsAt' | 'classTypeId'>): Eligibility {
    return checkPassForSession({ pass, validityDays: this.validityDays(pass), session, uses: this.passUses(pass.id), now: this.now() });
  }
  /** The client's guardian, if they're a dependant. */
  guardianOf(clientId: ID): Client | undefined {
    const g = this.clientsById.get(clientId)?.guardianClientId;
    return g ? this.clientsById.get(g) : undefined;
  }
  /** Can `clientId` spend this pass? Their own, or (dependants) their guardian's family-shareable ones. */
  canSpend(clientId: ID, pass: Pass): boolean {
    return pass.clientId === clientId || (pass.clientId === this.clientsById.get(clientId)?.guardianClientId && isFamilyShareable(pass));
  }
  /** Eligible passes for a session, best first. A dependant's own passes come before the parent's shareable ones. */
  eligiblePasses(clientId: ID, session: ClassSession): { pass: Pass; eligibility: Eligibility }[] {
    const rank = (list: Pass[]) => list
      .map((pass) => ({ pass, eligibility: this.eligibility(pass, session) }))
      .filter((x) => x.eligibility.eligible)
      .sort((a, b) => comparePassPriority(a.pass, b.pass));
    const g = this.guardianOf(clientId);
    return [...rank(this.clientPasses(clientId)), ...(g ? rank(this.clientPasses(g.id).filter(isFamilyShareable)) : [])];
  }
  bestPass(clientId: ID, session: ClassSession): Pass | undefined {
    return this.eligiblePasses(clientId, session)[0]?.pass;
  }

  private consume(pass: Pass): void {
    if (!pass.activatedAt) Object.assign(pass, activatePass(pass, this.validityDays(pass), this.now()));
    if (isCountedPass(pass)) pass.creditsUsed += 1;
    pass.status = computePassStatus(pass, this.now());
  }
  private returnCredit(b: Booking): void {
    if (!b.passId) return;
    const p = this.passesById.get(b.passId);
    if (!p) return;
    if (isCountedPass(p)) p.creditsUsed = Math.max(0, p.creditsUsed - 1);
    // memberships/unlimited: the booking no longer counts once its status changes.
    p.status = computePassStatus(p, this.now());
  }

  /** Change a booking's status and remember what it was (undo needs it). */
  private setStatus(b: Booking, status: BookingStatus): void {
    b.priorStatus = b.status;
    if (b.status === 'waitlisted' && b.waitlistPosition) b.priorWaitlistPosition = b.waitlistPosition; else delete b.priorWaitlistPosition;
    b.status = status;
  }

  // ---------------------------------------------------------------- housekeeping
  /**
   * Lazy time-based updates: remove waitlist entries for started classes, refresh pass statuses,
   * run demo weekly membership billing. Returns true if anything changed.
   */
  housekeeping(): boolean {
    const now = this.now();
    const t = now.getTime();
    let changed = false;
    for (const b of this.s.bookings) {
      if (b.status !== 'waitlisted') continue;
      const s = this.sessionsById.get(b.sessionId);
      if (s && Date.parse(s.startsAt) <= t) {
        b.status = 'removed';
        b.cancelledAt = s.startsAt;
        delete b.waitlistPosition;
        changed = true;
      }
    }
    for (const p of this.s.passes) {
      if (p.kind === 'membership' && p.nextBillingAt && p.status !== 'cancelled') {
        let guard = 0;
        while (Date.parse(p.nextBillingAt) <= t && guard++ < 520) {
          const due = p.nextBillingAt;
          if (!isPausedOn(p, studioDate(due))) {
            this.s.sales.push({
              id: this.newId('sa'), clientId: p.clientId, method: 'card_online', createdAt: due, totalCents: p.priceCents,
              items: [{ productId: p.productId, name: p.name, qty: 1, unitCents: p.priceCents }], note: 'Weekly membership direct debit',
            });
          }
          p.nextBillingAt = nextBillingAfter(new Date(due), p.billingInterval ?? 'week');
          changed = true;
        }
      }
      if (p.pausedUntil && p.pausedUntil < studioDate(now)) {
        delete p.pausedFrom;
        delete p.pausedUntil;
        changed = true;
      }
      const st = computePassStatus(p, now);
      if (st !== p.status) { p.status = st; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- schedule
  /** Idempotent. Never generates before the seeded history or more than 180 days ahead. */
  generate(from: ISODate, to: ISODate): number {
    const lo = from < this.s.historyFrom ? this.s.historyFrom : from;
    const maxTo = addDays(studioDate(this.now()), 180);
    const hi = to > maxTo ? maxTo : to;
    if (lo > hi) return 0;
    const created = generateSessions({ templates: this.s.templates, classTypes: this.s.classTypes, from: lo, to: hi, existingIds: new Set(this.sessionsById.keys()) });
    let n = 0;
    for (const x of created) {
      if (x.roomId && this.roomClash(x)) continue;   // a busy room keeps the class that was there first
      this.addSession(x); n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- locations and rooms
  /** Every studio has one default location and room (made on first use, so older saved demos and new studios just work). */
  ensureLocations(): { locations: Location[]; rooms: Room[] } {
    if (!this.s.locations?.length) {
      this.s.locations = [{ id: 'loc_default', name: 'Main location', address: this.s.settings.address, active: true, isDefault: true, sortOrder: 0 }];
      this.s.rooms = [{ id: 'room_default', locationId: 'loc_default', name: 'Main room', active: true }];
    }
    this.s.rooms ??= [];
    return { locations: this.s.locations, rooms: this.s.rooms };
  }

  /** The class (or other room use) a session would clash with, if any. */
  roomClash(want: { roomId?: ID | undefined; startsAt: string; endsAt: string; id?: ID | undefined }): ReturnType<typeof findRoomClash> {
    return findRoomClash({ roomId: want.roomId, startsAt: want.startsAt, endsAt: want.endsAt, ignoreId: want.id }, classUses(this.s.sessions, this.s.classTypes));
  }

  /** After a template changes: drop its future sessions that have no bookings, so they regenerate. */
  dropFutureTemplateSessions(templateId: ID): void {
    const t = this.now().getTime();
    const withBookings = new Set(this.s.bookings.map((b) => b.sessionId));
    const ids = new Set(this.s.sessions.filter((x) => x.templateId === templateId && Date.parse(x.startsAt) > t && !withBookings.has(x.id)).map((x) => x.id));
    if (ids.size) this.removeSessions(ids);
  }

  upsertSession(raw: Omit<ClassSession, 'id' | 'status'> & { id?: ID; status?: ClassSession['status'] }, by: Actor): SessionWithCounts {
    // Accept a SessionWithCounts from the UI: keep only ClassSession fields.
    const input: Omit<ClassSession, 'id' | 'status'> & { id?: ID; status?: ClassSession['status'] } = {
      classTypeId: raw.classTypeId, startsAt: raw.startsAt, endsAt: raw.endsAt, instructorId: raw.instructorId, capacity: raw.capacity,
      ...(raw.id ? { id: raw.id } : {}), ...(raw.status ? { status: raw.status } : {}), ...(raw.templateId ? { templateId: raw.templateId } : {}),
      ...(raw.note !== undefined ? { note: raw.note } : {}), ...(raw.cancelReason !== undefined ? { cancelReason: raw.cancelReason } : {}),
      ...(raw.locationId ? { locationId: raw.locationId } : {}), ...(raw.roomId ? { roomId: raw.roomId } : {}),
    };
    this.checkPlace(input);
    if (Number.isNaN(Date.parse(input.startsAt)) || Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw err('INVALID', 'The class must end after it starts.');
    if (!(input.capacity >= 0)) throw err('INVALID', 'Capacity must be zero or more.');
    this.classType(input.classTypeId);
    const existing = input.id ? this.sessionsById.get(input.id) : undefined;
    if (input.roomId && (input.status ?? existing?.status ?? 'scheduled') !== 'cancelled') this.assertRoomFree({ roomId: input.roomId, startsAt: input.startsAt, endsAt: input.endsAt, id: input.id });
    if (existing) {
      if (!input.roomId) { delete existing.roomId; }
      if (!input.locationId) { delete existing.locationId; }
      const prevCap = existing.capacity;
      const wasCancelled = existing.status === 'cancelled';
      const { status, ...rest } = input;
      Object.assign(existing, rest);
      if (status === 'cancelled' && !wasCancelled) this.cancelSession(existing.id, input.cancelReason ?? 'Cancelled by the studio');
      else if (status === 'scheduled' && wasCancelled) { existing.status = 'scheduled'; delete existing.cancelReason; }
      if (existing.capacity > prevCap) this.promote(existing.id);
      void by;
      return this.withCounts(existing);
    }
    const s: ClassSession = { ...input, id: input.id ?? this.newId('se'), status: input.status ?? 'scheduled' };
    this.addSession(s);
    return this.withCounts(s);
  }

  /** Throws ROOM_BUSY (with a message that names the room, the time and the class) when something else holds the room then. */
  assertRoomFree(want: { roomId: ID; startsAt: string; endsAt: string; id?: ID | undefined }): void {
    const clash = this.roomClash(want);
    if (clash) throw err('ROOM_BUSY', clashMessage(this.s.rooms?.find((r) => r.id === want.roomId)?.name ?? 'That room', clash, clockTime(clash.startsAt)));
  }

  /** A room has to exist and belong to the class's location (which it fills in when left out). */
  private checkPlace(input: { locationId?: ID; roomId?: ID }): void {
    const { locations, rooms } = this.ensureLocations();
    if (input.roomId) {
      const loc = locationOfRoom(rooms, input.roomId);
      if (!loc) throw err('NOT_FOUND', 'That room could not be found.');
      if (input.locationId && input.locationId !== loc) throw err('INVALID', 'That room is at a different location.');
      input.locationId = loc;
    }
    if (input.locationId && !locations.some((l) => l.id === input.locationId)) throw err('NOT_FOUND', 'That location could not be found.');
  }

  cancelSession(id: ID, reason: string): void {
    const s = this.session(id);
    const now = this.now().toISOString();
    s.status = 'cancelled';
    s.cancelReason = reason;
    (this.s.sessionCancelledAt ??= {})[id] = now;
    for (const b of this.sessionBookings(id)) {
      if (b.status === 'cancelled' || b.status === 'removed') continue;
      const wasBooked = b.status !== 'waitlisted';
      if (CREDIT_USING_STATUSES.includes(b.status)) this.returnCredit(b);
      this.setStatus(b, 'removed');
      b.cancelledAt = now;
      delete b.waitlistPosition;
      // return credit happened above using the pre-change status; refresh pass status now the booking no longer counts
      if (b.passId) { const p = this.passesById.get(b.passId); if (p) p.status = computePassStatus(p, this.now()); }
      this.notify(b.clientId, 'class_cancelled', wasBooked
        ? `Sorry, your class on ${studioDate(s.startsAt)} has been cancelled${reason ? ` (${reason})` : ''}. Your credit has been returned.`
        : `The class on ${studioDate(s.startsAt)} you were waitlisted for has been cancelled.`);
    }
  }

  // ---------------------------------------------------------------- bookings
  book(clientId: ID, sessionId: ID, o: BookOpts): BookResult {
    const now = this.now();
    const session = this.session(sessionId);
    const client = this.client(clientId);
    const staff = o.by.kind !== 'client';
    if (session.status === 'cancelled') throw err('CLASS_CANCELLED', 'This class has been cancelled.');
    const ct = this.classType(session.classTypeId);
    if (!staff) {
      if (!ct.bookable) throw err('NOT_BOOKABLE', `${ct.name} isn't open for bookings yet.`);
      if (hasStarted(session, now)) throw err('TOO_LATE', 'This class has already started.');
      if (!withinBookingWindow(session, now, this.s.settings.bookingWindowDays)) throw err('TOO_EARLY', `Bookings open ${this.s.settings.bookingWindowDays} days before class.`);
      if (!client.waiverSignedAt) throw err('WAIVER_REQUIRED', client.guardianClientId ? `${client.firstName}'s waiver and health form needs signing before their first booking.` : 'Please sign the waiver and health form before your first booking.');
    } else if (hasEnded(session, now)) {
      throw err('TOO_LATE', 'This class has finished.');
    }
    if (client.archived) throw err('NOT_ALLOWED', 'This client account is archived.');
    const dupe = this.sessionBookings(sessionId).find((b) => b.clientId === clientId && ACTIVE_BOOKING_STATUSES.includes(b.status));
    if (dupe) {
      const who = client.guardianClientId ? `${client.firstName} is` : "You're";
      throw err('ALREADY_BOOKED', dupe.status === 'waitlisted' ? `${who} already on the waitlist for this class.` : `${who} already booked into this class.`);
    }

    const base: Booking = {
      id: this.newId('bk'), sessionId, clientId, status: 'booked', createdAt: now.toISOString(),
      source: staff ? 'staff' : 'client', ...(o.by.kind === 'staff' ? { bookedByStaffId: o.by.staffId } : {}),
    };
    const { booked } = this.counts(sessionId);
    if (directFull(session.capacity, booked, staff ? 0 : this.heldBack(session)) && !(staff && o.allowOverCapacity)) {
      const maxPos = this.sessionBookings(sessionId).filter((b) => b.status === 'waitlisted').reduce((m, b) => Math.max(m, b.waitlistPosition ?? 0), 0);
      const booking: Booking = { ...base, status: 'waitlisted', waitlistPosition: maxPos + 1 };
      this.addBooking(booking);
      this.renumberWaitlist(sessionId);
      return { booking, outcome: 'waitlisted' };
    }

    let pass: Pass | undefined;
    if (!(staff && o.skipCredit)) {
      if (o.passId) {
        const p = this.pass(o.passId);
        if (!this.canSpend(clientId, p)) throw err('NOT_FOUND', 'That pass could not be found.');
        const e = this.eligibility(p, session);
        if (!e.eligible) throw err('NO_CREDITS', ineligibleMessage(p, e));
        pass = p;
      } else {
        pass = this.bestPass(clientId, session);
        if (!pass) throw err('NO_CREDITS', client.guardianClientId ? `${client.firstName} needs a pass for this class. Buy one for them, or use a family-shareable pass of yours.` : "You don't have a pass with a credit for this class.");
      }
      this.consume(pass);
    }
    const booking: Booking = { ...base, ...(pass ? { passId: pass.id } : {}) };
    this.addBooking(booking);
    return pass ? { booking, outcome: 'booked', pass } : { booking, outcome: 'booked' };
  }

  cancel(bookingId: ID, o: { by: Actor; waive?: boolean }): CancelResult {
    const b = this.booking(bookingId);
    const session = this.session(b.sessionId);
    const now = this.now();
    const staff = o.by.kind !== 'client';
    if (b.status === 'waitlisted') {
      this.leaveWaitlist(bookingId);
      return { booking: b, creditReturned: false, lateCancel: false };
    }
    if (b.status === 'checked_in') throw err('INVALID', 'Undo the check-in before cancelling.');
    if (b.status !== 'booked') throw err('INVALID', "This booking can't be cancelled.");
    if (!staff && hasStarted(session, now)) throw err('TOO_LATE', 'This class has already started.');
    const out = cancellationOutcome({ startsAt: session.startsAt, now, cancelWindowHours: this.s.settings.cancelWindowHours, waive: staff && !!o.waive });
    this.setStatus(b, out.status);
    b.cancelledAt = now.toISOString();
    if (out.creditReturned) this.returnCredit(b);
    else if (b.passId) { const p = this.passesById.get(b.passId); if (p) p.status = computePassStatus(p, now); }
    if (out.lateCancel && this.s.settings.lateCancelFeeCents > 0) this.feeSale(b.clientId, 'Late cancellation fee', this.s.settings.lateCancelFeeCents, b.id);
    const promoted = this.promote(session.id);
    return { booking: b, creditReturned: out.creditReturned, lateCancel: out.lateCancel, ...(promoted[0] ? { promoted: promoted[0] } : {}) };
  }

  leaveWaitlist(bookingId: ID): void {
    const b = this.booking(bookingId);
    if (b.status !== 'waitlisted') throw err('INVALID', "You're not on the waitlist for this class.");
    this.setStatus(b, 'removed');
    b.cancelledAt = this.now().toISOString();
    delete b.waitlistPosition;
    this.renumberWaitlist(b.sessionId);
  }

  renumberWaitlist(sessionId: ID): void {
    this.sessionBookings(sessionId).filter((b) => b.status === 'waitlisted').sort(compareWaitlist)
      .forEach((b, i) => { b.waitlistPosition = i + 1; });
  }

  /** Fill open spots from the waitlist (first client with an eligible credit), until the cutoff. */
  promote(sessionId: ID): Booking[] {
    const s = this.session(sessionId);
    const now = this.now();
    const out: Booking[] = [];
    if (s.status === 'cancelled' || !canAutoPromote(s.startsAt, now, this.s.settings.waitlistCutoffHours)) return out;
    while (!directFull(s.capacity, this.counts(sessionId).booked, this.heldBack(s))) {
      const pick = pickWaitlistPromotion(this.sessionBookings(sessionId), (cid) => !!this.bestPass(cid, s));
      if (!pick) break;
      const pass = this.bestPass(pick.clientId, s);
      if (!pass) break;
      this.consume(pass);
      this.setStatus(pick, 'booked');
      pick.passId = pass.id;
      pick.promotedFromWaitlistAt = now.toISOString();
      delete pick.waitlistPosition;
      out.push(pick);
      this.notify(pick.clientId, 'waitlist_promoted', `Good news — a spot opened up and you're booked in for class on ${studioDate(s.startsAt)}.`);
    }
    this.renumberWaitlist(sessionId);
    return out;
  }

  checkIn(bookingId: ID): Booking {
    const b = this.booking(bookingId);
    if (b.status === 'checked_in') return b;
    if (b.status !== 'booked' && b.status !== 'no_show') throw err('INVALID', 'Only booked clients can be checked in.');
    b.status = 'checked_in';
    b.checkedInAt = this.now().toISOString();
    return b;
  }
  undoCheckIn(bookingId: ID): Booking {
    const b = this.booking(bookingId);
    if (b.status === 'booked') return b;
    if (b.status !== 'checked_in') throw err('INVALID', 'This booking is not checked in.');
    b.status = 'booked';
    delete b.checkedInAt;
    return b;
  }
  markNoShow(bookingId: ID): Booking {
    const b = this.booking(bookingId);
    if (b.status === 'no_show') return b;
    if (b.status !== 'booked') throw err('INVALID', 'Only booked clients can be marked as a no-show.');
    this.setStatus(b, 'no_show');
    if (this.s.settings.noShowFeeCents > 0) this.feeSale(b.clientId, 'No-show fee', this.s.settings.noShowFeeCents, b.id);
    return b;
  }

  // ---------------------------------------------------------------- undo (staff mistakes)
  /** Take a penalty fee sale off again (a mistake, so it never happened) or refund it (waived later). */
  private dropPenaltyFee(bookingId: ID, how: 'delete' | 'refund'): void {
    const saleId = this.s.penaltyFees?.[bookingId];
    if (!saleId) return;
    delete this.s.penaltyFees![bookingId];
    const sale = this.s.sales.find((x) => x.id === saleId);
    if (!sale) return;
    if (how === 'delete') this.s.sales = this.s.sales.filter((x) => x.id !== saleId);
    else if (!sale.refundedAt) { sale.refundedCents = sale.totalCents; sale.refundedAt = this.now().toISOString(); sale.note = [sale.note, 'Refund: penalty waived'].filter(Boolean).join(' · '); }
  }

  undoNoShow(bookingId: ID): Booking {
    const b = this.booking(bookingId);
    if (b.status !== 'no_show') throw err('INVALID', 'This booking is no longer marked as a no-show.');
    this.setStatus(b, 'booked');
    this.dropPenaltyFee(b.id, 'delete');
    return b;
  }

  /** "Return credit": a late cancel or no-show becomes a normal cancel, credit back. */
  waivePenalty(bookingId: ID): Booking {
    const b = this.booking(bookingId);
    if (b.status !== 'late_cancelled' && b.status !== 'no_show') throw err('INVALID', 'There is no penalty on this booking to waive.');
    this.setStatus(b, 'cancelled');
    b.cancelledAt = b.cancelledAt ?? this.now().toISOString();
    this.returnCredit(b);
    this.dropPenaltyFee(b.id, 'refund');
    return b;
  }

  /** Put a staff cancel, late cancel or waitlist removal back exactly as it was. */
  undoCancel(bookingId: ID, opts: { demotePromotedId?: ID } = {}): UndoCancelResult {
    const b = this.booking(bookingId);
    const session = this.session(b.sessionId);
    const now = this.now();
    if (session.status === 'cancelled') throw err('CLASS_CANCELLED', 'That class has been cancelled. Restore the class instead.');
    if (hasEnded(session, now)) throw err('TOO_LATE', 'That class has finished.');
    const was = b.priorStatus;
    const fromWaitlist = b.status === 'removed' && was === 'waitlisted';
    const fromCancel = (b.status === 'cancelled' || b.status === 'late_cancelled') && (was === 'booked' || was === 'checked_in' || was === 'no_show');
    if (!fromWaitlist && !fromCancel) throw err('INVALID', "This booking can't be put back any more.");
    if (this.sessionBookings(session.id).some((x) => x.id !== b.id && x.clientId === b.clientId && ACTIVE_BOOKING_STATUSES.includes(x.status))) {
      throw err('ALREADY_BOOKED', `${this.client(b.clientId).firstName} has been booked into this class again already.`);
    }
    if (fromWaitlist) {
      if (hasStarted(session, now)) throw err('TOO_LATE', 'The class has started, so the waitlist is closed.');
      const place = b.priorWaitlistPosition;
      this.setStatus(b, 'waitlisted');
      this.rejoinWaitlist(b, place);
      return { booking: b, creditTaken: false };
    }
    let demoted: Booking | undefined;
    if (opts.demotePromotedId) {
      const w = this.booking(opts.demotePromotedId);
      if (w.sessionId !== session.id || w.status !== 'booked' || !w.promotedFromWaitlistAt) throw err('INVALID', "The person who took that spot can't be moved back.");
      this.returnCredit(w);
      const place = w.priorStatus === 'waitlisted' ? w.priorWaitlistPosition : undefined;   // where they were before the promotion
      this.setStatus(w, 'waitlisted');
      delete w.passId; delete w.promotedFromWaitlistAt;
      this.rejoinWaitlist(w, place);
      demoted = w;
    }
    if (this.counts(session.id).booked >= session.capacity) throw err('CLASS_FULL', 'Someone else has taken that spot, so they can\'t be put back.');
    const needsCredit = b.status === 'cancelled' && !!b.passId;   // a late cancel never gave the credit back
    if (needsCredit) {
      const pass = this.pass(b.passId as ID);
      if (!this.eligibility(pass, session).eligible) throw err('NO_CREDITS', `${this.client(b.clientId).firstName} can't be put back: their ${pass.name} has no credit for this class now.`);
      this.consume(pass);
    }
    this.setStatus(b, was as BookingStatus);
    delete b.cancelledAt;
    this.dropPenaltyFee(b.id, 'delete');
    this.renumberWaitlist(session.id);
    return { booking: b, creditTaken: needsCredit, ...(demoted ? { demoted } : {}) };
  }

  /** Back on the waitlist where they were (`place`, else by when they joined). */
  private rejoinWaitlist(b: Booking, place?: number): void {
    const others = this.sessionBookings(b.sessionId).filter((x) => x.id !== b.id && x.status === 'waitlisted');
    b.waitlistPosition = (place ?? others.filter((x) => Date.parse(x.createdAt) < Date.parse(b.createdAt)).length + 1) - 0.5;
    this.renumberWaitlist(b.sessionId);
  }

  /** The studio cancelled a class by mistake: put it back and rebook everyone it can. */
  restoreSession(id: ID): RestoreSessionResult {
    const s = this.session(id);
    const now = this.now();
    if (s.status !== 'cancelled') throw err('INVALID', 'This class is not cancelled.');
    if (hasEnded(s, now)) throw err('TOO_LATE', 'That class has finished.');
    if (s.roomId) this.assertRoomFree({ roomId: s.roomId, startsAt: s.startsAt, endsAt: s.endsAt, id: s.id });   // someone may have taken the room since
    const removed = this.sessionBookings(id).filter((b) => b.status === 'removed' && b.priorStatus);
    const stamp = this.s.sessionCancelledAt?.[id] ?? removed.reduce((m, b) => (b.cancelledAt && b.cancelledAt > m ? b.cancelledAt : m), '');
    const batch = removed.filter((b) => (b.cancelledAt ?? '') >= stamp).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    s.status = 'scheduled';
    delete s.cancelReason;
    if (this.s.sessionCancelledAt) delete this.s.sessionCancelledAt[id];
    const out: RestoreSessionResult = { session: this.withCounts(s), restored: [], needsAttention: [] };
    const name = (b: Booking) => { const c = this.client(b.clientId); return `${c.firstName} ${c.lastName}`.trim(); };
    const skip = (b: Booking, reason: string) => out.needsAttention.push({ bookingId: b.id, clientId: b.clientId, name: name(b), reason });
    const sStart = Date.parse(s.startsAt), sEnd = Date.parse(s.endsAt);
    for (const b of batch.filter((x) => x.priorStatus !== 'waitlisted')) {
      const was = b.priorStatus as BookingStatus;
      const c = this.client(b.clientId);
      if (this.sessionBookings(id).some((x) => x.id !== b.id && x.clientId === b.clientId && ACTIVE_BOOKING_STATUSES.includes(x.status))) { skip(b, 'Already booked into this class again'); continue; }
      const clash = this.clientBookings(b.clientId).find((x) => x.sessionId !== id && SPOT_STATUSES.includes(x.status) && (() => {
        const o = this.sessionsById.get(x.sessionId);
        return !!o && o.status !== 'cancelled' && Date.parse(o.startsAt) < sEnd && Date.parse(o.endsAt) > sStart;
      })());
      if (clash) { skip(b, 'Took another class at the same time'); continue; }
      if (c.archived) { skip(b, 'Client is archived'); continue; }
      if (this.counts(id).booked >= s.capacity) { skip(b, 'No spot left'); continue; }
      if (b.passId) {
        const pass = this.passesById.get(b.passId);
        if (!pass) { skip(b, 'Their pass is gone'); continue; }
        if (!this.eligibility(pass, s).eligible) { skip(b, `No credit left on their ${pass.name}`); continue; }
        this.consume(pass);
      }
      this.setStatus(b, was === 'late_cancelled' ? 'booked' : was);
      delete b.cancelledAt;
      out.restored.push({ bookingId: b.id, clientId: b.clientId, name: name(b), status: b.status });
      this.notify(b.clientId, 'class_restored', `Good news: your class on ${studioDate(s.startsAt)} is back on, and you're booked in again.`);
    }
    for (const b of batch.filter((x) => x.priorStatus === 'waitlisted').sort((a, b) => (a.priorWaitlistPosition ?? 1e9) - (b.priorWaitlistPosition ?? 1e9) || Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
      if (this.sessionBookings(id).some((x) => x.id !== b.id && x.clientId === b.clientId && ACTIVE_BOOKING_STATUSES.includes(x.status))) { skip(b, 'Already booked into this class again'); continue; }
      this.setStatus(b, 'waitlisted');
      delete b.cancelledAt;
      b.waitlistPosition = b.priorWaitlistPosition;
      out.restored.push({ bookingId: b.id, clientId: b.clientId, name: name(b), status: 'waitlisted' });
    }
    this.renumberWaitlist(id);
    this.promote(id);
    for (const r of out.restored) r.status = this.booking(r.bookingId).status;   // a spare spot may have gone to the waitlist
    out.session = this.withCounts(s);
    return out;
  }

  /** A desk sale made by mistake today, not paid by card: as if it never happened. Card sales go through refund. */
  voidSale(saleId: ID, opts: { reason?: string; dryRun?: boolean }): VoidResult {
    const sale = this.s.sales.find((x) => x.id === saleId);
    if (!sale) throw err('NOT_FOUND', 'That sale could not be found.');
    const passes = this.s.passes.filter((p) => this.s.passSale[p.id] === sale.id && p.status !== 'cancelled')
      .map((p) => ({ id: p.id, name: p.name, classesUsed: this.s.bookings.filter((b) => b.passId === p.id && (CREDIT_USING_STATUSES.includes(b.status))).length }));
    let blocked: string | undefined;
    if (sale.refundedAt) blocked = 'This sale has already been refunded or voided.';
    else if (sale.method === 'card_online' || sale.stripePaymentIntentId) blocked = 'Card payments can’t be voided. Use Refund so the money goes back to the card.';
    else if (studioDate(sale.createdAt) !== studioDate(this.now())) blocked = 'Only sales made today can be voided. For older sales, use Refund.';
    else {
      const used = passes.find((p) => p.classesUsed > 0);
      if (used) blocked = `${used.name} has already been used for ${used.classesUsed} ${used.classesUsed === 1 ? 'class' : 'classes'}, so this sale can’t be voided. Use Refund, or adjust their pass.`;
    }
    if (blocked && !opts.dryRun) throw err('INVALID', blocked);
    if (blocked || opts.dryRun) return { voided: false, ...(blocked ? { blocked } : {}), sale, passes };
    const reason = `Voided${opts.reason?.trim() ? `: ${opts.reason.trim()}` : ' (entered by mistake)'}`;
    const done = this.refund(saleId, { cancelPass: true, reason });
    return { voided: true, sale: done, passes };
  }

  move(bookingId: ID, toSessionId: ID, by: Actor): BookResult {
    const b = this.booking(bookingId);
    if (b.status !== 'booked') throw err('INVALID', 'Only booked (not checked-in) bookings can be moved.');
    if (b.sessionId === toSessionId) throw err('INVALID', 'The booking is already in that class.');
    const target = this.session(toSessionId);
    if (target.status === 'cancelled') throw err('CLASS_CANCELLED', 'That class has been cancelled.');
    if (hasEnded(target, this.now())) throw err('TOO_LATE', 'That class has finished.');
    if (this.sessionBookings(toSessionId).some((x) => x.clientId === b.clientId && ACTIVE_BOOKING_STATUSES.includes(x.status))) {
      throw err('ALREADY_BOOKED', 'The client is already booked into that class.');
    }
    if (this.counts(toSessionId).booked >= target.capacity) throw err('CLASS_FULL', 'That class is full.');
    const fromSession = b.sessionId;
    const oldPassId = b.passId;
    b.status = 'cancelled';
    b.cancelledAt = this.now().toISOString();
    this.returnCredit(b);
    let passId: ID | undefined;
    if (oldPassId) {
      const p = this.pass(oldPassId);
      if (this.eligibility(p, target).eligible) passId = oldPassId;
    }
    const res = this.book(b.clientId, toSessionId, { by, ...(passId ? { passId } : {}), skipCredit: !oldPassId, allowOverCapacity: false });
    this.promote(fromSession);
    return res;
  }

  // ---------------------------------------------------------------- sales & passes
  checkout(input: { clientId?: ID; items: { productId: ID; qty: number }[]; method: PaymentMethod; staffId?: ID; discountCents?: number; note?: string }): { sale: Sale; passes: Pass[] } {
    const now = this.now();
    if (!input.items.length) throw err('INVALID', 'The cart is empty.');
    const lines = input.items.map((i) => ({ product: this.product(i.productId), qty: Math.max(1, Math.floor(i.qty || 1)) }));
    for (const l of lines) if (!l.product.active) throw err('INVALID', `${l.product.name} isn't available right now.`);
    const classLines = lines.filter((l) => l.product.kind !== 'retail');
    if (classLines.length) {
      if (!input.clientId) throw err('INVALID', 'Choose a client for class passes.');
      this.client(input.clientId);
      const introQty = classLines.filter((l) => l.product.kind === 'intro' || l.product.newClientsOnly).reduce((n, l) => n + l.qty, 0);
      if (introQty > 1 || (introQty === 1 && !isIntroEligible(input.clientId, this.s.passes))) {
        throw err('INTRO_NOT_ELIGIBLE', 'The intro offer is for new clients only (one per person).');
      }
    } else if (input.clientId) this.client(input.clientId);
    const stockNeed = new Map<ID, number>();
    for (const l of lines) if (l.product.kind === 'retail') stockNeed.set(l.product.id, (stockNeed.get(l.product.id) ?? 0) + l.qty);
    for (const [pid, n] of stockNeed) {
      const p = this.product(pid);
      if (typeof p.stock === 'number' && p.stock < n) throw err('OUT_OF_STOCK', `Only ${p.stock} ${p.name} left in stock.`);
    }
    const gross = lines.reduce((n, l) => n + l.product.priceCents * l.qty, 0);
    const discount = Math.min(gross, Math.max(0, Math.round(input.discountCents ?? 0)));
    const sale: Sale = {
      id: this.newId('sa'), items: lines.map((l) => ({ productId: l.product.id, name: l.product.name, qty: l.qty, unitCents: l.product.priceCents })),
      totalCents: input.method === 'comp' ? 0 : gross - discount, method: input.method, createdAt: now.toISOString(),
      ...(input.clientId ? { clientId: input.clientId } : {}), ...(input.staffId ? { staffId: input.staffId } : {}),
      ...(input.note || discount ? { note: [input.note, discount ? `Discount ${(discount / 100).toFixed(2)}` : ''].filter(Boolean).join(' · ') } : {}),
    };
    this.s.sales.push(sale);
    const passes: Pass[] = [];
    for (const l of classLines) {
      for (let i = 0; i < l.qty; i++) {
        const p = this.newPassFrom(l.product, input.clientId as ID);
        this.addPass(p);
        this.s.passSale[p.id] = sale.id;
        passes.push(p);
      }
    }
    for (const [pid, n] of stockNeed) {
      const p = this.product(pid);
      if (typeof p.stock === 'number') p.stock -= n;
    }
    return { sale, passes };
  }

  newPassFrom(product: Product, clientId: ID): Pass {
    if (product.kind === 'retail') throw err('INVALID', 'Retail items are not passes.');
    const credits = product.kind === 'pack' || product.kind === 'dropin' ? product.credits ?? 1 : product.credits ?? null;
    return {
      id: this.newId('ps'), clientId, productId: product.id, kind: product.kind, name: product.name, status: 'active',
      purchasedAt: this.now().toISOString(), credits, creditsUsed: 0, priceCents: product.priceCents,
      ...(product.kind === 'membership' ? { billingInterval: product.billingInterval ?? 'week' } : {}),
      ...(product.classTypeIds?.length ? { classTypeIds: [...product.classTypeIds] } : {}),
      ...(product.noClasses ? { noClasses: true } : {}),
      ...(product.familyShareable !== undefined ? { familyShareable: product.familyShareable } : {}),
    };
  }

  pause(passId: ID, from: ISODate, until: ISODate): Pass {
    const p = this.pass(passId);
    if (p.kind !== 'membership') throw err('INVALID', 'Only memberships can be paused.');
    if (p.status === 'cancelled') throw err('INVALID', 'This membership has been cancelled.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw err('INVALID', 'Choose valid pause dates.');
    if (from < studioDate(this.now())) throw err('INVALID', 'A pause can start today at the earliest.');
    if (addDays(from, 6) > until) throw err('INVALID', 'Pauses need to be at least 1 week.');
    p.pausedFrom = from;
    p.pausedUntil = until;
    p.status = computePassStatus(p, this.now());
    // No classes while paused: cancel bookings on this pass inside the pause (credit returned).
    const t = this.now().getTime();
    for (const b of this.s.bookings) {
      if (b.passId !== p.id || b.status !== 'booked') continue;
      const s = this.sessionsById.get(b.sessionId);
      if (!s || Date.parse(s.startsAt) <= t) continue;
      const d = studioDate(s.startsAt);
      if (d >= from && d <= until) {
        b.status = 'cancelled';
        b.cancelledAt = this.now().toISOString();
        this.promote(s.id);
      }
    }
    return p;
  }

  resume(passId: ID): Pass {
    const p = this.pass(passId);
    delete p.pausedFrom;
    delete p.pausedUntil;
    p.status = computePassStatus(p, this.now());
    return p;
  }

  cancelMembership(passId: ID): Pass {
    const p = this.pass(passId);
    if (p.kind !== 'membership') throw err('INVALID', 'Only memberships can be cancelled this way.');
    if (p.status === 'cancelled') return p;
    p.status = 'cancelled';
    // Usable until nextBillingAt; drop bookings after that (or all future ones if never activated).
    const end = p.nextBillingAt ? Date.parse(p.nextBillingAt) : this.now().getTime();
    this.cancelFutureBookingsOnPass(p.id, end);
    return p;
  }

  private cancelFutureBookingsOnPass(passId: ID, fromTime: number): void {
    const t = Math.max(fromTime, this.now().getTime());
    for (const b of this.s.bookings) {
      if (b.passId !== passId || b.status !== 'booked') continue;
      const s = this.sessionsById.get(b.sessionId);
      if (!s || Date.parse(s.startsAt) < t) continue;
      b.status = 'cancelled';
      b.cancelledAt = this.now().toISOString();
      this.returnCredit(b);
      this.promote(s.id);
    }
  }

  adjust(passId: ID, change: { creditsDelta?: number; newExpiresAt?: ISODateTime | null; reason: string }, staffId?: ID): Pass {
    const p = this.pass(passId);
    if (!change.reason?.trim()) throw err('INVALID', 'Add a reason for the adjustment.');
    const delta = Math.trunc(change.creditsDelta ?? 0);
    if (delta !== 0) {
      if (p.credits === null) throw err('INVALID', "Unlimited passes don't have credits to adjust.");
      if (p.kind === 'membership') throw err('INVALID', 'Weekly membership credits reset each week and can’t be adjusted.');
      const next = p.credits + delta;
      if (next < p.creditsUsed) throw err('INVALID', "That would remove credits that have already been used.");
      p.credits = next;
    }
    let reason = change.reason.trim();
    if (change.newExpiresAt !== undefined) {
      p.expiresAt = change.newExpiresAt;
      reason += change.newExpiresAt ? ` (expiry set to ${studioDate(change.newExpiresAt)})` : ' (expiry removed)';
    }
    (p.adjustments ??= []).push({ at: this.now().toISOString(), ...(staffId ? { staffId } : {}), delta, reason });
    p.status = computePassStatus(p, this.now());
    return p;
  }

  refund(saleId: ID, opts: { amountCents?: number; cancelPass?: boolean; reason?: string }): Sale {
    const sale = this.s.sales.find((x) => x.id === saleId);
    if (!sale) throw err('NOT_FOUND', 'That sale could not be found.');
    const left = sale.totalCents - (sale.refundedCents ?? 0);
    const amount = opts.amountCents === undefined ? left : Math.round(opts.amountCents);
    if (left <= 0 && amount > 0) throw err('INVALID', 'This sale has already been fully refunded.');
    if (amount < 0 || amount > left) throw err('INVALID', `You can refund up to $${(left / 100).toFixed(2)}.`);
    if (amount > 0) {
      sale.refundedCents = (sale.refundedCents ?? 0) + amount;
      sale.refundedAt = this.now().toISOString();
    } else if (sale.totalCents === 0 && amount === 0) {
      // Paid entirely with a gift card / promo: nothing to hand back, but it can still be undone (once).
      if (sale.refundedAt) throw err('INVALID', 'This sale has already been refunded.');
      sale.refundedAt = this.now().toISOString();
    }
    if (opts.reason) sale.note = [sale.note, `Refund: ${opts.reason}`].filter(Boolean).join(' · ');
    if (opts.cancelPass) {
      for (const p of this.s.passes) {
        if (this.s.passSale[p.id] !== sale.id || p.status === 'cancelled') continue;
        p.status = 'cancelled';
        if (p.kind === 'membership') p.nextBillingAt = this.now().toISOString();
        this.cancelFutureBookingsOnPass(p.id, this.now().getTime());
      }
    }
    return sale;
  }

  private feeSale(clientId: ID, name: string, cents: number, bookingId?: ID): void {
    const id = this.newId('sa');
    this.s.sales.push({ id, clientId, items: [{ name, qty: 1, unitCents: cents }], totalCents: cents, method: 'card_online', createdAt: this.now().toISOString(), note: name });
    if (bookingId) (this.s.penaltyFees ??= {})[bookingId] = id;
  }

  notify(clientId: ID, kind: OutboxMessage['kind'], text: string): void {
    this.s.outbox.push({ at: this.now().toISOString(), clientId, kind, text });
    if (this.s.outbox.length > 200) this.s.outbox.splice(0, this.s.outbox.length - 200);
  }
}

export function ineligibleMessage(p: Pass, e: Eligibility): string {
  switch (e.reason) {
    case 'cancelled': return `Your ${p.name} has ended.`;
    case 'expired': return `Your ${p.name} will have expired by then.`;
    case 'paused': return `Your ${p.name} is paused on that date.`;
    case 'class_type': return `Your ${p.name} doesn't cover this class.`;
    case 'no_credits': return p.kind === 'membership' ? `You've used all your ${p.name} credits for that week.` : `Your ${p.name} has no credits left.`;
    default: return `Your ${p.name} can't be used for this class.`;
  }
}
