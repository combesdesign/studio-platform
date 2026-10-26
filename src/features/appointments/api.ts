/** Small helpers the appointments screens (client and studio) share. No React in here. */
import { store } from '../../data';
import { LOCALE, dateFormat, money, studioDate, time } from '../../shared/format';
import type { ID, ISODate, ISODateTime } from '../../shared/types';
import { HOUR_MS, toMinutes } from './logic';
import type { Appointment, AppointmentCredit, AppointmentsStore, AppointmentStatus, EventKind, EventRegistration, RegistrationStatus, StudioEvent } from './types';

export const appts = (): AppointmentsStore | undefined => store.features.appointments;
/** For loaders: the store, or a friendly error the screen's error block can show. */
export function needAppts(): AppointmentsStore {
  const a = appts();
  if (!a) throw new Error('Appointments aren’t available just yet.');
  return a;
}

export const KIND_LABEL: Record<EventKind, string> = { workshop: 'Workshop', course: 'Course', event: 'Event' };

const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
/** 'Tue 14 Oct' for a studio date or a timestamp. */
export function dayLabel(s: ISODate | ISODateTime): string {
  if (isDateOnly(s)) return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${s}T12:00:00Z`)).replace(',', '');
  return dateFormat({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(s)).replace(',', '');
}
/** 'Tuesday 14 October'. */
export function dayFull(s: ISODate | ISODateTime): string {
  if (isDateOnly(s)) return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${s}T12:00:00Z`)).replace(',', '');
  return dateFormat({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(s)).replace(',', '');
}
/** '9:00am' */
export const clock = (iso: ISODateTime) => time(iso);
/** '9:00 to 9:55am' style range. */
export const range = (a: ISODateTime, b: ISODateTime) => `${time(a)} to ${time(b)}`;
/** Studio date of an instant. */
export const dateOf = (iso: ISODateTime): ISODate => studioDate(iso);
export const price = (cents: number) => (cents === 0 ? 'Free' : money(cents, { cents: cents % 100 !== 0 }));

/** '2 sessions, 14 Oct to 21 Oct' or '14 Oct, 6:00pm'. */
export function eventWhen(e: Pick<StudioEvent, 'sessions'>): string {
  const first = e.sessions[0];
  if (!first) return '';
  if (e.sessions.length === 1) return `${dayLabel(first.startsAt)}, ${time(first.startsAt)}`;
  const last = e.sessions[e.sessions.length - 1]!;
  return `${e.sessions.length} sessions · ${dayLabel(first.startsAt)} to ${dayLabel(last.startsAt)}`;
}

export const APPT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Booked', completed: 'Done', cancelled: 'Cancelled', late_cancelled: 'Late cancel', no_show: 'No-show', pending_payment: 'Awaiting payment',
};
export const APPT_STATUS_TONE: Record<AppointmentStatus, 'ok' | 'warn' | 'danger' | ''> = {
  booked: 'ok', completed: '', cancelled: '', late_cancelled: 'warn', no_show: 'danger', pending_payment: 'warn',
};
export const REG_STATUS_LABEL: Record<RegistrationStatus, string> = { registered: 'Registered', cancelled: 'Cancelled', late_cancelled: 'Late cancel', pending_payment: 'Awaiting payment' };

/** Hours until an instant (negative once it has passed). */
export const hoursUntil = (iso: ISODateTime, now = Date.now()) => (Date.parse(iso) - now) / HOUR_MS;

/** One line about what cancelling costs, from the studio's own window. */
export function cancelNote(startsAt: ISODateTime, windowHours: number, what: 'credit' | 'payment', now = Date.now()): string {
  const late = hoursUntil(startsAt, now) < windowHours;
  const w = windowHours === 1 ? '1 hour' : windowHours % 24 === 0 && windowHours >= 48 ? `${windowHours / 24} days` : `${windowHours} hours`;
  return late
    ? `This is inside the ${w} cancellation window, so your ${what} won’t be returned.`
    : `Free to cancel until ${w} before the start.`;
}

export const creditsLeft = (credits: AppointmentCredit[]) => credits.filter((c) => c.status === 'active').reduce((n, c) => n + c.remaining, 0);
export const isUpcoming = (a: Pick<Appointment, 'startsAt' | 'status'>, now = Date.now()) => a.status === 'booked' && Date.parse(a.startsAt) > now - 60 * 60_000;
export const regUpcoming = (r: Pick<EventRegistration, 'status'>) => r.status === 'registered';

/** The origin + path to come back to after a Stripe Checkout (hash route appended by the caller). */
export const pageBase = (): string => (typeof location === 'undefined' ? '' : location.href.split('#')[0]!);

export type { ID };

/** Minutes after midnight, in the studio's timezone, for an instant. */
export function studioMinutes(iso: ISODateTime): number {
  const hm = dateFormat({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(/^24:/, '00:');
  return Math.max(0, toMinutes(hm));
}
