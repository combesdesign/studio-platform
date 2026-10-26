/**
 * Pure appointment rules: slot generation, pack credits, cancel window. No storage, no DOM; `now` is always passed in.
 * The demo store uses these directly; supabase/migrations/1101_appointments_rpcs.sql implements the same rules in SQL
 * (kept in step by supabase/tests/appointments_rpcs.sql, which checks the same cases as tests/appointments.test.ts).
 */
import { addDays, studioToUTC, weekday } from '../../shared/format';
import type { ClassSession, ID, ISODate, ISODateTime } from '../../shared/types';
import type {
  Appointment, AppointmentCredit, AppointmentSettings, AppointmentSlot, AppointmentType, AvailabilityInput, AvailabilityRule, StudioEvent, TimeOff,
} from './types';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export const DEFAULT_SETTINGS: AppointmentSettings = { slotStepMin: 30, minNoticeHours: 4, horizonDays: 28, waitlistClaimHours: 12, reminderHours: 24 };

/** The lead times a studio can pick for reminder emails (Settings › Appointments). */
export const REMINDER_HOURS: readonly number[] = [2, 12, 24, 48];

/** Is a reminder due: the session is still ahead and starts within `hours` from now? (The SQL appointments_queue_reminders does the same.) */
export function reminderDue(startsAt: ISODateTime, now: Date, hours: number): boolean {
  const t = Date.parse(startsAt);
  return t > now.getTime() && t <= now.getTime() + hours * HOUR_MS;
}

/** Statuses that occupy the instructor's time. Cancelled and late-cancelled sessions free the slot. */
export const BUSY_STATUSES: readonly Appointment['status'][] = ['booked', 'completed', 'no_show', 'pending_payment'];

/** 'HH:mm' -> minutes after midnight (-1 if it isn't a time). */
export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return -1;
  const h = Number(m[1]), n = Number(m[2]);
  return h > 24 || n > 59 || (h === 24 && n > 0) ? -1 : h * 60 + n;
}
export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

type BusyAppt = Pick<Appointment, 'staffId' | 'startsAt' | 'endsAt' | 'bufferMin' | 'status'>;
type BusyClass = Pick<ClassSession, 'instructorId' | 'startsAt' | 'endsAt' | 'status'>;

export interface SlotInput {
  type: Pick<AppointmentType, 'id' | 'durationMin' | 'bufferMin' | 'staffIds'>;
  rules: readonly Pick<AvailabilityRule, 'staffId' | 'weekday' | 'start' | 'end'>[];
  timeOff: readonly Pick<TimeOff, 'staffId' | 'startsAt' | 'endsAt'>[];
  appointments: readonly BusyAppt[];
  /** Classes: an instructor who teaches a class is busy for its whole length. */
  sessions: readonly BusyClass[];
  settings: AppointmentSettings;
  now: Date;
  from: ISODate;
  to: ISODate;
  /** Only this staff member. */
  staffId?: ID;
  /** Staff booking for a client can book inside the notice period and past the horizon (never in the past). */
  asStaff?: boolean;
}

/**
 * Every open start time for `type` between two studio dates (inclusive), earliest first.
 * A start time is open when:
 *  - it sits on the slot grid inside one of the instructor's weekly windows, and the whole session fits in that window;
 *  - it is at least `minNoticeHours` from now and no further than `horizonDays` ahead (not for staff);
 *  - it doesn't overlap time off;
 *  - the session plus its buffer doesn't overlap another appointment (that one plus its own buffer) or a class they teach.
 */
export function computeSlots(a: SlotInput): AppointmentSlot[] {
  const out: AppointmentSlot[] = [];
  const dur = a.type.durationMin * MINUTE_MS;
  const buf = a.type.bufferMin * MINUTE_MS;
  const step = Math.max(5, a.settings.slotStepMin);
  const earliest = a.now.getTime() + (a.asStaff ? 0 : a.settings.minNoticeHours * HOUR_MS);
  const latest = a.asStaff ? Infinity : a.now.getTime() + a.settings.horizonDays * 24 * HOUR_MS;
  const staff = a.type.staffIds.filter((s) => !a.staffId || s === a.staffId);

  for (const staffId of staff) {
    const rules = a.rules.filter((r) => r.staffId === staffId);
    if (!rules.length) continue;
    const off = a.timeOff.filter((t) => t.staffId === staffId).map((t) => [Date.parse(t.startsAt), Date.parse(t.endsAt)] as const);
    const busy: (readonly [number, number])[] = [
      ...a.appointments.filter((p) => p.staffId === staffId && BUSY_STATUSES.includes(p.status))
        .map((p) => [Date.parse(p.startsAt), Date.parse(p.endsAt) + p.bufferMin * MINUTE_MS] as const),
      ...a.sessions.filter((s) => s.instructorId === staffId && s.status !== 'cancelled')
        .map((s) => [Date.parse(s.startsAt), Date.parse(s.endsAt)] as const),
    ];
    for (let date = a.from, guard = 0; date <= a.to && guard < 400; date = addDays(date, 1), guard++) {
      const wd = weekday(date);
      for (const r of rules) {
        if (r.weekday !== wd) continue;
        const ws = toMinutes(r.start), we = toMinutes(r.end);
        if (ws < 0 || we <= ws) continue;
        for (let m = ws; m + a.type.durationMin <= we; m += step) {
          const s = Date.parse(studioToUTC(date, fromMinutes(m)));
          if (s < earliest || s > latest) continue;
          const e = s + dur;
          if (off.some(([x, y]) => s < y && x < e)) continue;
          const eb = e + buf;
          if (busy.some(([x, y]) => s < y && x < eb)) continue;
          out.push({ typeId: a.type.id, staffId, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() });
        }
      }
    }
  }
  // Two overlapping windows for the same person can produce a start twice.
  const seen = new Set<string>();
  return out
    .filter((s) => { const k = s.staffId + s.startsAt; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => x.startsAt.localeCompare(y.startsAt) || x.staffId.localeCompare(y.staffId));
}

// ---------------------------------------------------------------- availability input

/** Check a staff member's weekly windows: valid times, start before end, no overlaps on a day. Returns a friendly error or null. */
export function availabilityProblem(rules: readonly AvailabilityInput[]): string | null {
  for (const r of rules) {
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return 'Pick a day of the week.';
    const s = toMinutes(r.start), e = toMinutes(r.end);
    if (s < 0 || e < 0) return 'Use times like 09:00.';
    if (e <= s) return 'Each window needs to finish after it starts.';
  }
  for (let d = 0; d < 7; d++) {
    const day = rules.filter((r) => r.weekday === d).map((r) => [toMinutes(r.start), toMinutes(r.end)] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < day.length; i++) if (day[i]![0] < day[i - 1]![1]) return 'Two windows on the same day overlap.';
  }
  return null;
}

// ---------------------------------------------------------------- pack credits

export function creditStatus(c: Pick<AppointmentCredit, 'credits' | 'used' | 'expiresAt'>, now: Date): AppointmentCredit['status'] {
  if (c.credits - c.used <= 0) return 'used_up';
  if (c.expiresAt && Date.parse(c.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

/** Credits that can pay for `typeId` at `at`: has some left, hasn't expired by then, covers the type. */
export function usableCredits(credits: readonly AppointmentCredit[], typeId: ID, at: Date): AppointmentCredit[] {
  return credits
    .filter((c) => c.credits - c.used > 0 && (!c.expiresAt || Date.parse(c.expiresAt) > at.getTime()) && (!c.typeIds.length || c.typeIds.includes(typeId)))
    // soonest to expire first; packs not started yet count as expiring last; then oldest purchase
    .sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || a.purchasedAt.localeCompare(b.purchasedAt));
}

/**
 * Which credits pay for `people` places. Takes from the credit expiring soonest and spills into the next one; null if there aren't
 * enough. `creditId` forces one credit (it then has to cover everyone).
 */
export function allocateCredits(credits: readonly AppointmentCredit[], typeId: ID, people: number, at: Date, creditId?: ID): { creditId: ID; n: number }[] | null {
  let pool = usableCredits(credits, typeId, at);
  if (creditId) {
    pool = pool.filter((c) => c.id === creditId);
    if (!pool.length || pool[0]!.credits - pool[0]!.used < people) return null;
  }
  const out: { creditId: ID; n: number }[] = [];
  let need = people;
  for (const c of pool) {
    if (need <= 0) break;
    const n = Math.min(need, c.credits - c.used);
    out.push({ creditId: c.id, n });
    need -= n;
  }
  return need > 0 ? null : out;
}

// ---------------------------------------------------------------- cancelling

/** In time = at least `windowHours` before the start (exactly on the line still counts as in time, like class cancels). */
export function isLateCancel(startsAt: ISODateTime, now: Date, windowHours: number): boolean {
  return now.getTime() > Date.parse(startsAt) - windowHours * HOUR_MS;
}

// ---------------------------------------------------------------- moving

/**
 * Whether a booked appointment may be moved right now, or why not (the SQL appointments_move does the same).
 * Clients can move while it is still outside the studio's cancellation window (the same line cancelling uses); staff any time before it ends.
 */
export function moveProblem(a: Pick<Appointment, 'startsAt' | 'status'>, now: Date, windowHours: number, asStaff: boolean): { code: string; message: string } | null {
  if (a.status !== 'booked') return { code: 'INVALID', message: 'This appointment can’t be moved.' };
  if (asStaff) return null;
  if (now.getTime() >= Date.parse(a.startsAt)) return { code: 'TOO_LATE', message: 'This session has already started.' };
  if (isLateCancel(a.startsAt, now, windowHours)) return { code: 'TOO_LATE', message: 'It’s inside the cancellation window, so it can’t be moved online. Please contact the studio.' };
  return null;
}

/** Pack credits keep paying for a moved session only if none of them runs out before the new start. */
export function creditsLastUntil(uses: readonly { creditId: ID }[], credits: readonly Pick<AppointmentCredit, 'id' | 'expiresAt'>[], newStart: ISODateTime): boolean {
  return uses.every((u) => { const e = credits.find((c) => c.id === u.creditId)?.expiresAt; return !e || Date.parse(e) > Date.parse(newStart); });
}

// ---------------------------------------------------------------- events

export const eventStart = (e: Pick<StudioEvent, 'sessions'>): ISODateTime => e.sessions[0]?.startsAt ?? '';
export const eventEnd = (e: Pick<StudioEvent, 'sessions'>): ISODateTime => e.sessions[e.sessions.length - 1]?.endsAt ?? '';

/** Problem with an event as entered in the editor, or null. */
export function eventProblem(e: Pick<StudioEvent, 'title' | 'capacity' | 'priceCents' | 'sessions' | 'refundCutoffHours'>): string | null {
  if (!e.title.trim()) return 'Give it a name.';
  if (!Number.isInteger(e.capacity) || e.capacity < 1) return 'Capacity needs to be at least 1.';
  if (e.priceCents < 0) return 'The price can’t be negative.';
  if (!e.sessions.length) return 'Add at least one date.';
  for (const s of e.sessions) {
    if (!Date.parse(s.startsAt) || !Date.parse(s.endsAt)) return 'Check the dates and times.';
    if (Date.parse(s.endsAt) <= Date.parse(s.startsAt)) return 'Each session needs to finish after it starts.';
  }
  if (e.refundCutoffHours < 0) return 'The refund cut-off can’t be negative.';
  return null;
}

// ---------------------------------------------------------------- event waitlist

/** A person in an event's line. `offered` = a spot is being held for them until offerExpiresAt. */
export interface WaitlistLine { id: ID; status: 'waiting' | 'offered'; joinedAt: ISODateTime; offerExpiresAt?: ISODateTime }

/**
 * What to do with an event's waitlist right now (the SQL app.ap_waitlist_advance does the same):
 *  - if the event is closed (cancelled, or the first session has started) everyone in line is let go;
 *  - offers past their claim window lapse;
 *  - every spot that is neither taken nor held by a live offer goes to the next person waiting, first come first served.
 * `taken` = people registered (and paying) already. An offer lasts `claimHours`, but never past the start of the event.
 */
export function planWaitlist(a: { line: readonly WaitlistLine[]; capacity: number; taken: number; now: Date; claimHours: number; eventStart: ISODateTime; open: boolean }):
  { expire: ID[]; offer: { id: ID; expiresAt: ISODateTime }[] } {
  const now = a.now.getTime();
  if (!a.open) return { expire: a.line.map((w) => w.id), offer: [] };
  const lapsed = a.line.filter((w) => w.status === 'offered' && Date.parse(w.offerExpiresAt ?? '') <= now).map((w) => w.id);
  const held = a.line.filter((w) => w.status === 'offered' && !lapsed.includes(w.id)).length;
  let free = Math.max(0, a.capacity - a.taken - held);
  const expiresAt = new Date(Math.min(now + a.claimHours * HOUR_MS, Date.parse(a.eventStart))).toISOString();
  const offer: { id: ID; expiresAt: ISODateTime }[] = [];
  for (const w of [...a.line].filter((x) => x.status === 'waiting').sort((x, y) => x.joinedAt.localeCompare(y.joinedAt) || x.id.localeCompare(y.id))) {
    if (free <= 0) break;
    offer.push({ id: w.id, expiresAt });
    free--;
  }
  return { expire: lapsed, offer };
}
