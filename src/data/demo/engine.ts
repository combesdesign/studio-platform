/**
 * Demo engine: the studio's operations over an in-memory state object.
 * No auth / permissions / persistence here (that's the store wrapper in index.ts) —
 * this is also what the seeder drives with a simulated clock, so seeded data is
 * consistent by construction.
 */
import { StoreError } from '../../shared/store';
import type { BookResult, CancelResult } from '../../shared/store';
import type {
  Booking, ClassSession, ClassType, Client, ID, ISODate, ISODateTime, Pass, PaymentMethod, Product, Sale,
  ScheduleTemplate, SessionWithCounts, Staff, StudioSettings,
} from '../../shared/types';
import { addDays } from '../../shared/format';
import {
  ACTIVE_BOOKING_STATUSES, CREDIT_USING_STATUSES, SPOT_STATUSES, activatePass, canAutoPromote, cancellationOutcome,
  checkPassForSession, compareWaitlist, comparePassPriority, computePassStatus, generateSessions, hasEnded, hasStarted,
  isCountedPass, isIntroEligible, isPausedOn, nextBillingAfter, pickWaitlistPromotion, withinBookingWindow,
  studioDay as studioDate, type Eligibility, type PassUse,
} from '../../domain';

export const STATE_VERSION = 1;

export interface OutboxMessage {
  at: ISODateTime;
  clientId: ID;
  kind: 'waitlist_promoted' | 'class_cancelled' | 'booking_moved';
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
  bookings: Booking[];
  clients: Client[];
  products: Product[];
  passes: Pass[];
  sales: Sale[];
  /** passId -> saleId that created it (for refunds). */
  passSale: Record<ID, ID>;
  /** Notifications the live app would send (email/push). Demo only, newest last. */
  outbox: OutboxMessage[];
  /** "Register interest" for coming-soon class types (one row per client + class type). Staff can see it. */
  interest?: { clientId: ID; classTypeId: ID; at: ISODateTime }[];
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

  withCounts(session: ClassSession, countsCache?: Map<ID, { booked: number; waitlist: number }>): SessionWithCounts {
    const c = countsCache?.get(session.id) ?? this.counts(session.id);
    return { ...session, bookedCount: c.booked, waitlistCount: c.waitlist, spotsLeft: Math.max(0, session.capacity - c.booked) };
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
  /** Eligible passes for a session, best first. */
  eligiblePasses(clientId: ID, session: ClassSession): { pass: Pass; eligibility: Eligibility }[] {
    return this.clientPasses(clientId)
      .map((pass) => ({ pass, eligibility: this.eligibility(pass, session) }))
      .filter((x) => x.eligibility.eligible)
      .sort((a, b) => comparePassPriority(a.pass, b.pass));
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
    for (const x of created) this.addSession(x);
    return created.length;
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
    };
    if (Number.isNaN(Date.parse(input.startsAt)) || Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw err('INVALID', 'The class must end after it starts.');
    if (!(input.capacity >= 0)) throw err('INVALID', 'Capacity must be zero or more.');
    this.classType(input.classTypeId);
    const existing = input.id ? this.sessionsById.get(input.id) : undefined;
    if (existing) {
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

  cancelSession(id: ID, reason: string): void {
    const s = this.session(id);
    const now = this.now().toISOString();
    s.status = 'cancelled';
    s.cancelReason = reason;
    for (const b of this.sessionBookings(id)) {
      if (b.status === 'cancelled' || b.status === 'removed') continue;
      const wasBooked = b.status !== 'waitlisted';
      if (CREDIT_USING_STATUSES.includes(b.status)) this.returnCredit(b);
      b.status = 'removed';
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
      if (!client.waiverSignedAt) throw err('WAIVER_REQUIRED', 'Please sign the waiver and health form before your first booking.');
    } else if (hasEnded(session, now)) {
      throw err('TOO_LATE', 'This class has finished.');
    }
    if (client.archived) throw err('NOT_ALLOWED', 'This client account is archived.');
    const dupe = this.sessionBookings(sessionId).find((b) => b.clientId === clientId && ACTIVE_BOOKING_STATUSES.includes(b.status));
    if (dupe) throw err('ALREADY_BOOKED', dupe.status === 'waitlisted' ? "You're already on the waitlist for this class." : "You're already booked into this class.");

    const base: Booking = {
      id: this.newId('bk'), sessionId, clientId, status: 'booked', createdAt: now.toISOString(),
      source: staff ? 'staff' : 'client', ...(o.by.kind === 'staff' ? { bookedByStaffId: o.by.staffId } : {}),
    };
    const { booked } = this.counts(sessionId);
    if (booked >= session.capacity && !(staff && o.allowOverCapacity)) {
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
        if (p.clientId !== clientId) throw err('NOT_FOUND', 'That pass could not be found.');
        const e = this.eligibility(p, session);
        if (!e.eligible) throw err('NO_CREDITS', ineligibleMessage(p, e));
        pass = p;
      } else {
        pass = this.bestPass(clientId, session);
        if (!pass) throw err('NO_CREDITS', "You don't have a pass with a credit for this class.");
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
    b.status = out.status;
    b.cancelledAt = now.toISOString();
    if (out.creditReturned) this.returnCredit(b);
    else if (b.passId) { const p = this.passesById.get(b.passId); if (p) p.status = computePassStatus(p, now); }
    if (out.lateCancel && this.s.settings.lateCancelFeeCents > 0) this.feeSale(b.clientId, 'Late cancellation fee', this.s.settings.lateCancelFeeCents);
    const promoted = this.promote(session.id);
    return { booking: b, creditReturned: out.creditReturned, lateCancel: out.lateCancel, ...(promoted[0] ? { promoted: promoted[0] } : {}) };
  }

  leaveWaitlist(bookingId: ID): void {
    const b = this.booking(bookingId);
    if (b.status !== 'waitlisted') throw err('INVALID', "You're not on the waitlist for this class.");
    b.status = 'removed';
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
    while (this.counts(sessionId).booked < s.capacity) {
      const pick = pickWaitlistPromotion(this.sessionBookings(sessionId), (cid) => !!this.bestPass(cid, s));
      if (!pick) break;
      const pass = this.bestPass(pick.clientId, s);
      if (!pass) break;
      this.consume(pass);
      pick.status = 'booked';
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
    b.status = 'no_show';
    if (this.s.settings.noShowFeeCents > 0) this.feeSale(b.clientId, 'No-show fee', this.s.settings.noShowFeeCents);
    return b;
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

  private feeSale(clientId: ID, name: string, cents: number): void {
    this.s.sales.push({ id: this.newId('sa'), clientId, items: [{ name, qty: 1, unitCents: cents }], totalCents: cents, method: 'card_online', createdAt: this.now().toISOString(), note: name });
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
