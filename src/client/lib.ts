/** Client app helpers (no JSX). */
import type { ClassType, Pass, Product, SessionWithCounts, Staff, StudioSettings } from '../shared/types';
import { addDays, dateTime, money, studioDate, time, weekday } from '../shared/format';

/** '6:00am Tue 14 Oct' (strips the comma some ICU builds put after the weekday). */
export function when(iso: string | Date): string {
  return dateTime(iso).replace(/,/g, '');
}

/** Store image paths may be 'img/x.webp' or '/img/x.webp'. Keep everything relative (Capacitor-safe). */
export function asset(u?: string): string | undefined {
  if (!u) return undefined;
  if (/^(https?:|data:|blob:)/.test(u)) return u;
  return u.replace(/^\/+/, '');
}

/** Query string of a hash path: '/shop?for=abc' -> URLSearchParams */
export function queryOf(path: string): URLSearchParams {
  const i = path.indexOf('?');
  return new URLSearchParams(i >= 0 ? path.slice(i + 1) : '');
}
export const pathOnly = (path: string) => path.split('?')[0] || '/';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayLabel(date: string): string {
  const today = studioDate();
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return WEEKDAYS[weekday(date)]!;
}

export function hoursUntil(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / 3_600_000;
}

/** Is cancelling now a late cancel (credit lost)? */
export function isLateCancel(s: { startsAt: string }, settings: StudioSettings): boolean {
  return hoursUntil(s.startsAt) < settings.cancelWindowHours;
}
/** Latest moment a client can cancel and get their credit back. */
export function freeCancelUntil(s: { startsAt: string }, settings: StudioSettings): Date {
  return new Date(new Date(s.startsAt).getTime() - settings.cancelWindowHours * 3_600_000);
}

export function timeRange(s: { startsAt: string; endsAt: string }): string {
  const a = time(s.startsAt), b = time(s.endsAt);
  const ap = (x: string) => x.slice(-2);
  return ap(a) === ap(b) ? `${a.slice(0, -2)} – ${b}` : `${a} – ${b}`;
}

export function sessionState(s: SessionWithCounts): 'cancelled' | 'finished' | 'started' | 'open' {
  if (s.status === 'cancelled') return 'cancelled';
  const now = Date.now();
  if (new Date(s.endsAt).getTime() <= now) return 'finished';
  if (new Date(s.startsAt).getTime() <= now) return 'started';
  return 'open';
}

export function firstName(name?: string): string {
  return (name || '').trim().split(/\s+/)[0] || '';
}

export function staffRole(s?: Staff): string {
  if (!s) return '';
  return s.role === 'owner' ? 'Owner + instructor' : 'Instructor';
}

export function expiryLabel(p: Pass): string {
  if (p.status === 'paused') return p.pausedUntil ? `Paused until ${dateOnlyShort(p.pausedUntil)}` : 'Paused';
  if (p.expiresAt) {
    const d = new Date(p.expiresAt);
    const short = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' }).format(d);
    return d.getTime() < Date.now() ? `Expired ${short}` : `Expires ${short}`;
  }
  if (!p.activatedAt) return 'Starts on first booking';
  if (p.kind === 'membership') return p.nextBillingAt ? `Renews ${dateShortNoDay(p.nextBillingAt)}` : 'Ongoing';
  return 'No expiry';
}

export function dateShortNoDay(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' }).format(new Date(iso));
}

/** 'YYYY-MM-DD' (studio calendar date) -> '12 Dec' */
export function dateOnlyShort(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)));
}

export function daysLeft(iso?: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function perClass(p: Product): string | null {
  if (p.kind === 'membership') {
    if (p.credits == null) return 'Unlimited classes';
    return `${money(Math.round(p.priceCents / p.credits), { cents: true })} per class`;
  }
  if ((p.kind === 'pack' || p.kind === 'dropin') && p.credits) {
    if (p.credits === 1) return 'Per class';
    return `${money(Math.round(p.priceCents / p.credits), { cents: true })} per class`;
  }
  return null;
}

export function productWhat(p: Product): string {
  if (p.kind === 'intro') return `${p.validityDays ?? 14} days of unlimited classes, from your first booking`;
  if (p.kind === 'membership') return p.credits == null ? 'Unlimited classes every week' : `${p.credits} class${p.credits === 1 ? '' : 'es'} every week (Mon – Sun)`;
  if (p.kind === 'pack' || p.kind === 'dropin') {
    const c = p.credits ?? 1;
    const v = p.validityDays ? `, valid ${validityWords(p.validityDays)} from first booking` : '';
    return `${c} class credit${c === 1 ? '' : 's'}${v}`;
  }
  return 'Pick up at the front desk';
}

export function validityWords(days: number): string {
  if (days % 7 === 0 && days <= 28) return `${days / 7} week${days === 7 ? '' : 's'}`;
  const months = Math.round(days / 30.5);
  if (months >= 1 && Math.abs(days - months * 30.5) <= 2) return `${months} month${months === 1 ? '' : 's'}`;
  return `${days} days`;
}

export function classTypeFor(types: ClassType[] | undefined, id: string): ClassType | undefined {
  return types?.find((t) => t.id === id);
}

// ------------------------------------------------------------------ calendar (.ics)
const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function icsDataUrl(s: SessionWithCounts, ct: ClassType | undefined, instructor: Staff | undefined, settings: StudioSettings): string {
  const name = ct?.name ?? 'Pilates class';
  const desc = [instructor ? `With ${firstName(instructor.name)}` : '', ct?.bookingNote ?? '', settings.cancellationPolicyText ?? '']
    .filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Snowy Pilates Club//Client app//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${s.id}@snowypilatesclub.com`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(s.startsAt)}`,
    `DTEND:${icsTime(s.endsAt)}`,
    `SUMMARY:${icsEsc(`${name} · ${settings.name}`)}`,
    `LOCATION:${icsEsc(settings.address)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(name)} in 1 hour`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.join('\r\n'));
}

export function icsFileName(s: SessionWithCounts, ct?: ClassType): string {
  return `${(ct?.name ?? 'class').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${studioDate(s.startsAt)}.ics`;
}

// ------------------------------------------------------------------ platform
export const isIOS = () => typeof navigator !== 'undefined' &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1));
export const isStandalone = () => typeof window !== 'undefined' &&
  ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (navigator as any).standalone === true);
export const isNative = () => typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();

export function mapsUrl(address: string): string {
  return isIOS() ? `https://maps.apple.com/?q=${encodeURIComponent(address)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// ------------------------------------------------------------------ client record
import type { Client } from '../shared/types';
import { store } from '../shared/react';
/**
 * Save the signed-in client's own record. Never sends staff-only fields back (staffNotes),
 * so a merge-style upsert can't clobber them.
 */
export function saveClient(c: Client, patch: Partial<Client>) {
  const { staffNotes: _s, ...rest } = { ...c, ...patch };
  return store.upsertClient(rest);
}
