/**
 * Who shows up on the kiosk, and what it may say about them. Pure functions, no store, so they're easy to test.
 *
 * The kiosk faces the room: it only ever shows a first name and a last initial. Injuries, notes, health forms and
 * every other flag stay on the staff roster. The only hint is "see the front desk" (no waiver, or a first class).
 */
import type { RosterEntry } from '../../shared/store';
import type { ClassSession, ID, SessionWithCounts } from '../../shared/types';

/** Classes show up this long before they start, and stay until they finish. */
export const KIOSK_WINDOW_MIN = 60;

/** Classes starting within the next 60 minutes, or running right now. Cancelled classes never show. */
export function kioskSessions<T extends Pick<ClassSession, 'startsAt' | 'endsAt' | 'status'>>(sessions: T[], now: Date, windowMin = KIOSK_WINDOW_MIN): T[] {
  const t = now.getTime();
  return sessions
    .filter((s) => s.status !== 'cancelled' && Date.parse(s.startsAt) <= t + windowMin * 60_000 && Date.parse(s.endsAt) > t)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** The only things the kiosk knows about someone. */
export interface KioskPerson {
  bookingId: ID;
  firstName: string;
  /** 'B.' or '' */
  lastInitial: string;
  /** Already checked in (shown ticked, not tappable). */
  checkedIn: boolean;
  /** Show "Please see the front desk" after check-in. */
  seeDesk: boolean;
}

/** Everyone who holds a spot in the class (booked or already in), in first-name order. Waitlist, no-shows and late cancels are left out. */
export function kioskPeople(roster: RosterEntry[]): KioskPerson[] {
  return roster
    .filter((e) => e.status === 'booked' || e.status === 'checked_in')
    .map((e): KioskPerson => ({
      bookingId: e.id,
      firstName: e.client.firstName,
      lastInitial: e.client.lastName.trim() ? `${e.client.lastName.trim()[0]!.toUpperCase()}.` : '',
      checkedIn: e.status === 'checked_in',
      seeDesk: e.flags.includes('no_waiver') || e.flags.includes('first_class'),
    }))
    .sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastInitial.localeCompare(b.lastInitial));
}

/** Search by first name (the start of it, ignoring case and spaces). */
export function searchPeople(people: KioskPerson[], q: string): KioskPerson[] {
  const s = q.trim().toLowerCase();
  return s ? people.filter((p) => p.firstName.toLowerCase().startsWith(s)) : people;
}

export const isPin = (s: string): boolean => /^\d{4}$/.test(s);

/** For the class card: "Starts in 25 min" / "Started 10 min ago" / "Starting now". */
export function startsLabel(s: Pick<SessionWithCounts, 'startsAt'>, now: Date): string {
  const min = Math.round((Date.parse(s.startsAt) - now.getTime()) / 60_000);
  if (min > 1) return `Starts in ${min} min`;
  if (min >= -1) return 'Starting now';
  return `Started ${-min} min ago`;
}
