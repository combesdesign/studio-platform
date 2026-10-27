/**
 * Snowy Pilates Club — pure booking rules (see RULES.md).
 * No storage, no DOM, no clock: every function takes `now` explicitly so the
 * demo store, tests and (later) the live backend can share them.
 */
import type {
  Booking, BookingStatus, ClassSession, Client, ID, ISODate, ISODateTime, Pass, PassStatus,
} from '../shared/types';
import { addDays, weekStart } from '../shared/format';
import { studioDay as studioDate } from './time';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Statuses that hold a spot in the class (count towards capacity). */
export const SPOT_STATUSES: readonly BookingStatus[] = ['booked', 'checked_in'];
/** Statuses where the credit has been spent (count towards a membership week / pack usage). */
export const CREDIT_USING_STATUSES: readonly BookingStatus[] = ['booked', 'checked_in', 'no_show', 'late_cancelled'];
/** Statuses that block another booking by the same client in the same class. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ['booked', 'checked_in', 'waitlisted'];

const ms = (iso: ISODateTime) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------- pass basics

/** Unlimited = membership or intro with no credit limit. */
export function isUnlimited(p: Pick<Pass, 'kind' | 'credits'> & { noClasses?: boolean }): boolean {
  return !p.noClasses && p.credits === null && (p.kind === 'membership' || p.kind === 'intro');
}
/** Memberships with a weekly allowance (1/2/3 per week). */
export function isWeeklyLimited(p: Pick<Pass, 'kind' | 'credits'>): boolean {
  return p.kind === 'membership' && typeof p.credits === 'number';
}
/** Packs, drop-ins (and a capped intro, if ever configured): fixed total credits. */
export function isCountedPass(p: Pick<Pass, 'kind' | 'credits'>): boolean {
  return p.kind !== 'membership' && typeof p.credits === 'number';
}

/** A booking that used (or is using) a pass, with the session start for week maths. */
export interface PassUse {
  bookingId: ID;
  status: BookingStatus;
  startsAt: ISODateTime;
}

/** Credit-using bookings on a membership in the Mon–Sun studio week containing `date`. */
export function weeklyUsed(uses: readonly PassUse[], date: ISODate): number {
  const wk = weekStart(date);
  let n = 0;
  for (const u of uses) {
    if (!CREDIT_USING_STATUSES.includes(u.status)) continue;
    if (weekStart(studioDate(u.startsAt)) === wk) n++;
  }
  return n;
}

/**
 * When the pass stops being usable. For a pass not yet activated this is the
 * projected expiry if it were activated `now`. null = never.
 */
export function effectiveExpiry(pass: Pass, validityDays: number | null | undefined, now: Date): number | null {
  if (pass.expiresAt) return ms(pass.expiresAt);
  if (pass.activatedAt) return null; // activated with no expiry
  if (pass.expiresAt === null) return null;
  return validityDays ? now.getTime() + validityDays * DAY_MS : null;
}

/** Last instant a cancelled membership can still be used (it runs until nextBillingAt). */
export function cancelledMembershipEnd(pass: Pass): number | null {
  if (pass.status !== 'cancelled' || pass.kind !== 'membership' || !pass.nextBillingAt) return null;
  return ms(pass.nextBillingAt);
}

export function isPausedOn(pass: Pick<Pass, 'pausedFrom' | 'pausedUntil'>, date: ISODate): boolean {
  if (!pass.pausedFrom) return false;
  const until = pass.pausedUntil ?? '9999-12-31';
  return date >= pass.pausedFrom && date <= until;
}

/**
 * Recompute a pass's status from its data. `status` is only stored as a cache, except
 * 'cancelled', which is sticky.
 */
export function computePassStatus(pass: Pass, now: Date): PassStatus {
  if (pass.status === 'cancelled') return 'cancelled';
  if (pass.expiresAt && now.getTime() >= ms(pass.expiresAt)) return 'expired';
  if (isCountedPass(pass) && pass.creditsUsed >= (pass.credits ?? 0)) return 'used_up';
  if (isPausedOn(pass, studioDate(now))) return 'paused';
  return 'active';
}

/** Is the pass still something the client "has" (shown in their wallet)? */
export function isPassCurrent(pass: Pass, now: Date): boolean {
  const st = computePassStatus(pass, now);
  if (st === 'active' || st === 'paused') return true;
  if (st === 'cancelled') {
    const end = cancelledMembershipEnd(pass);
    return end !== null && now.getTime() < end;
  }
  return false;
}

// ---------------------------------------------------------------- eligibility

export type IneligibleReason = 'cancelled' | 'expired' | 'paused' | 'class_type' | 'no_credits';

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  /** Credits left for that session (membership: in the session's week). null = unlimited. */
  remaining: number | null;
}

export interface EligibilityInput {
  pass: Pass;
  /** From the product (passes don't store it). Used to project expiry of unactivated passes. */
  validityDays?: number | null;
  session: Pick<ClassSession, 'startsAt' | 'classTypeId'>;
  /** All bookings made with this pass. */
  uses: readonly PassUse[];
  now: Date;
}

/** Remaining credits for a pass, for the week/date of `date` (membership) or overall (packs). */
export function remainingCredits(pass: Pass, uses: readonly PassUse[], date: ISODate): number | null {
  if (pass.credits === null || pass.credits === undefined) return null;
  if (pass.kind === 'membership') return Math.max(0, pass.credits - weeklyUsed(uses, date));
  return Math.max(0, pass.credits - pass.creditsUsed);
}

/** Can this pass pay for this session? (RULES.md › Booking) */
export function checkPassForSession(input: EligibilityInput): Eligibility {
  const { pass, session, uses, now } = input;
  const start = ms(session.startsAt);
  const date = studioDate(session.startsAt);
  const remaining = remainingCredits(pass, uses, date);
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason, remaining });

  if (pass.status === 'cancelled') {
    const end = cancelledMembershipEnd(pass);
    if (end === null || start >= end || now.getTime() >= end) return no('cancelled');
  }
  const exp = effectiveExpiry(pass, input.validityDays, now);
  if (exp !== null && (start >= exp || now.getTime() >= exp)) return no('expired');
  if (isPausedOn(pass, date)) return no('paused');
  if (pass.noClasses) return no('class_type'); // online-only: never pays for a studio class
  if (pass.classTypeIds && pass.classTypeIds.length > 0 && !pass.classTypeIds.includes(session.classTypeId)) return no('class_type');
  if (remaining !== null && remaining <= 0) return no('no_credits');
  return { eligible: true, remaining };
}

// ---------------------------------------------------------------- family accounts

/**
 * Family accounts, the one rule: a dependant spends their own passes first, then the parent's passes that are family-shareable.
 * Shareable = the pass (copied from its product) says so; if it doesn't say, packs and drop-ins are shareable and memberships
 * and intro offers (which belong to one person) are not. Staff can flip it per product in Settings.
 */
export function isFamilyShareable(p: Pick<Pass, 'kind' | 'familyShareable'>): boolean {
  return p.familyShareable ?? (p.kind === 'pack' || p.kind === 'dropin');
}

/** A dependant is a client with a guardian. */
export const isDependant = (c: Pick<Client, 'guardianClientId'>): boolean => !!c.guardianClientId;

/**
 * Sort key for best-pass selection (lower = use first):
 *   0 unlimited (membership or intro), 1 membership with weekly credits, 2 packs/drop-ins.
 * Within a group: soonest expiry first; activated-without-expiry next; unactivated last; then oldest purchase.
 */
export function passPriority(pass: Pass): [number, number, number, number] {
  const group = isUnlimited(pass) ? 0 : pass.kind === 'membership' ? 1 : 2;
  const exp = pass.expiresAt ? ms(pass.expiresAt) : Number.MAX_SAFE_INTEGER;
  const unactivated = pass.activatedAt ? 0 : 1;
  return [group, unactivated ? Number.MAX_SAFE_INTEGER : exp, unactivated, ms(pass.purchasedAt)];
}

export function comparePassPriority(a: Pass, b: Pass): number {
  const x = passPriority(a), y = passPriority(b);
  for (let i = 0; i < x.length; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pick the best eligible pass (RULES.md priority order), or undefined. */
export function selectBestPass(candidates: readonly { pass: Pass; eligibility: Eligibility }[]): Pass | undefined {
  return candidates.filter((c) => c.eligibility.eligible).map((c) => c.pass).sort(comparePassPriority)[0];
}

/** First use: activatedAt = now, expiresAt = now + validityDays, memberships start billing weekly. Returns a new object. */
export function activatePass(pass: Pass, validityDays: number | null | undefined, now: Date): Pass {
  if (pass.activatedAt) return pass;
  const out: Pass = { ...pass, activatedAt: now.toISOString() };
  if (pass.expiresAt === undefined) out.expiresAt = validityDays ? iso(now.getTime() + validityDays * DAY_MS) : null;
  if (pass.kind === 'membership') out.nextBillingAt = nextBillingAfter(now, pass.billingInterval ?? 'week');
  return out;
}

export function nextBillingAfter(from: Date, interval: 'week' | 'month'): ISODateTime {
  if (interval === 'week') return iso(from.getTime() + 7 * DAY_MS);
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

// ---------------------------------------------------------------- cancelling

export interface CancelOutcome {
  status: 'cancelled' | 'late_cancelled';
  creditReturned: boolean;
  lateCancel: boolean;
}

/**
 * Cancel at least `cancelWindowHours` before start → cancelled, credit back.
 * Inside the window → late_cancelled, credit lost — unless staff waive it.
 */
export function cancellationOutcome(args: { startsAt: ISODateTime; now: Date; cancelWindowHours: number; waive?: boolean }): CancelOutcome {
  const inTime = ms(args.startsAt) - args.now.getTime() >= args.cancelWindowHours * HOUR_MS;
  if (inTime || args.waive) return { status: 'cancelled', creditReturned: true, lateCancel: false };
  return { status: 'late_cancelled', creditReturned: false, lateCancel: true };
}

// ---------------------------------------------------------------- waitlist

/** Auto-booking off the waitlist only happens before the cutoff (default 1h before class). */
export function canAutoPromote(startsAt: ISODateTime, now: Date, waitlistCutoffHours: number): boolean {
  return now.getTime() < ms(startsAt) - waitlistCutoffHours * HOUR_MS;
}

/** First waitlisted booking (by position) whose client has an eligible credit. */
export function pickWaitlistPromotion<B extends Pick<Booking, 'status' | 'waitlistPosition' | 'createdAt' | 'clientId'>>(
  bookings: readonly B[], hasCredit: (clientId: ID) => boolean,
): B | undefined {
  const queue = bookings.filter((b) => b.status === 'waitlisted').sort(compareWaitlist);
  return queue.find((b) => hasCredit(b.clientId));
}

export function compareWaitlist(a: Pick<Booking, 'waitlistPosition' | 'createdAt'>, b: Pick<Booking, 'waitlistPosition' | 'createdAt'>): number {
  const d = (a.waitlistPosition ?? Number.MAX_SAFE_INTEGER) - (b.waitlistPosition ?? Number.MAX_SAFE_INTEGER);
  return d !== 0 ? d : ms(a.createdAt) - ms(b.createdAt);
}

// ---------------------------------------------------------------- intro offer

/** New clients only: never held any class pass (of any kind, any status). */
export function isIntroEligible(clientId: ID, passes: readonly Pick<Pass, 'clientId'>[]): boolean {
  return !passes.some((p) => p.clientId === clientId);
}

// ---------------------------------------------------------------- labels

/** '3 of 4 left', 'Unlimited', '1 of 2 left this week'. */
export function creditLabel(pass: Pick<Pass, 'kind' | 'credits'> & { noClasses?: boolean }, remaining: number | null): string {
  if (pass.noClasses) return 'Online only';
  if (remaining === null || pass.credits === null || pass.credits === undefined) return 'Unlimited';
  return pass.kind === 'membership' ? `${remaining} of ${pass.credits} left this week` : `${remaining} of ${pass.credits} left`;
}

// ---------------------------------------------------------------- roster

export type RosterFlag = 'first_class' | 'no_waiver' | 'injury' | 'health_update' | 'birthday' | 'last_credit' | 'pass_expiring';

/** Does a 'YYYY-MM-DD' birthday fall in the Mon–Sun week containing `date`? */
export function birthdayInWeek(birthday: ISODate | undefined, date: ISODate): boolean {
  if (!birthday || birthday.length < 10) return false;
  const md = birthday.slice(5);
  const mon = weekStart(date);
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    if (d.slice(5) === md) return true;
    if (md === '02-29' && d.slice(5) === '02-28' && !isLeap(Number(d.slice(0, 4)))) return true;
  }
  return false;
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function rosterFlags(args: {
  client: Pick<Client, 'waiverSignedAt' | 'injuries' | 'birthday' | 'healthForm'> & Partial<Pick<Client, 'healthUpdate'>>;
  booking: Pick<Booking, 'status'>;
  session: Pick<ClassSession, 'startsAt'>;
  pass?: Pass;
  /** Credits left on the pass after this booking (null = unlimited / no pass). */
  passRemaining?: number | null;
  /** Checked-in bookings this client has in OTHER classes that started before this one. */
  priorCheckIns: number;
  /** Start of the latest checked-in class before this one (so a health update they made since is flagged until an instructor sees them). */
  lastCheckInAt?: ISODateTime;
}): RosterFlag[] {
  const flags: RosterFlag[] = [];
  const { client, pass, session } = args;
  if (args.priorCheckIns === 0) flags.push('first_class');
  if (!client.waiverSignedAt) flags.push('no_waiver');
  if ((client.injuries ?? client.healthForm?.injuries ?? '').trim()) flags.push('injury');
  const hu = client.healthUpdate;
  if (hu && ms(hu.at) <= ms(session.startsAt) && (!args.lastCheckInAt || ms(hu.at) > ms(args.lastCheckInAt))) flags.push('health_update');
  if (birthdayInWeek(client.birthday, studioDate(session.startsAt))) flags.push('birthday');
  if (pass && isCountedPass(pass) && args.passRemaining === 0 && SPOT_STATUSES.includes(args.booking.status)) flags.push('last_credit');
  if (pass?.expiresAt) {
    const exp = ms(pass.expiresAt), start = ms(session.startsAt);
    if (exp > start && exp - start <= 7 * DAY_MS) flags.push('pass_expiring');
  }
  return flags;
}

// ---------------------------------------------------------------- booking-window helpers

/** Has the class started? (clients can't book or cancel after this) */
export function hasStarted(session: Pick<ClassSession, 'startsAt'>, now: Date): boolean {
  return now.getTime() >= ms(session.startsAt);
}
export function hasEnded(session: Pick<ClassSession, 'endsAt'>, now: Date): boolean {
  return now.getTime() >= ms(session.endsAt);
}
/** Clients can see/book up to `bookingWindowDays` ahead (by studio date). */
export function withinBookingWindow(session: Pick<ClassSession, 'startsAt'>, now: Date, bookingWindowDays: number): boolean {
  return studioDate(session.startsAt) <= addDays(studioDate(now), bookingWindowDays);
}
