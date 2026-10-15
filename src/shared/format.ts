/**
 * Formatting + studio-timezone date helpers shared by every app. No dependencies.
 *
 * Everything formats for the CURRENT studio: its timezone, locale, currency and tax rate. The apps call
 * setStudioFormat(studio) once at boot (src/data bindStudio does it). Defaults are Australia/Sydney, en-AU,
 * AUD and 10% GST, so code and tests that never set a studio behave exactly as before.
 * For work that spans studios (the demo platform store), wrap it in withStudioFormat(studio, fn).
 */
import type { Cents, ISODate, ISODateTime } from './types';

export interface StudioFormat { timezone: string; locale: string; currency: string; taxRate: number }
export const DEFAULT_FORMAT: StudioFormat = { timezone: 'Australia/Sydney', locale: 'en-AU', currency: 'AUD', taxRate: 0.1 };

/** Current studio timezone (a live binding: always read it, never copy it at import time). */
export let TZ = DEFAULT_FORMAT.timezone;
export let LOCALE = DEFAULT_FORMAT.locale;
export let CURRENCY = DEFAULT_FORMAT.currency;
export let TAX_RATE = DEFAULT_FORMAT.taxRate;
let formatVersion = 0;
/** Bumps whenever the format changes (caches keyed on it, e.g. domain/time.ts). */
export const formatEpoch = () => formatVersion;

/** Set the timezone / locale / currency / tax rate everything formats with. Missing keys keep their value. */
export function setStudioFormat(f: Partial<StudioFormat>): void {
  const next = { timezone: f.timezone || TZ, locale: f.locale || LOCALE, currency: f.currency || CURRENCY, taxRate: f.taxRate ?? TAX_RATE };
  if (next.timezone === TZ && next.locale === LOCALE && next.currency === CURRENCY && next.taxRate === TAX_RATE) return;
  TZ = next.timezone; LOCALE = next.locale; CURRENCY = next.currency; TAX_RATE = next.taxRate;
  formatVersion++;
}
/** Just the timezone (kept for callers that only care about dates). */
export function setStudioTimezone(tz: string): void { setStudioFormat({ timezone: tz }); }
export function currentFormat(): StudioFormat { return { timezone: TZ, locale: LOCALE, currency: CURRENCY, taxRate: TAX_RATE }; }

/** Run fn with another studio's format, then put the previous one back. Synchronous work only. */
export function withStudioFormat<T>(f: Partial<StudioFormat>, fn: () => T): T {
  const prev = currentFormat();
  setStudioFormat(f);
  try { return fn(); } finally { setStudioFormat(prev); }
}

/** Intl.DateTimeFormat in the studio's locale + timezone (pass timeZone: 'UTC' for date-only values). */
export function dateFormat(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...opts });
}

const nums3 = (s: string): [number, number, number] => {
  const a = s.split(/[-:]/).map(Number);
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
};

export function money(cents: Cents, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? cents % 100 !== 0;
  return (cents / 100).toLocaleString(LOCALE, {
    style: 'currency', currency: CURRENCY,
    minimumFractionDigits: showCents ? 2 : 0, maximumFractionDigits: showCents ? 2 : 0,
  });
}

/** Tax included in a tax-inclusive total, at the studio's rate (10% GST: total / 11). */
export function taxOf(totalCents: Cents, rate: number = TAX_RATE): Cents {
  if (rate === 0.1) return Math.round(totalCents / 11);
  return Math.round((totalCents * rate) / (1 + rate));
}
/** Kept for existing callers: the included tax at the current studio's rate. */
export function gstOf(totalCents: Cents): Cents {
  return taxOf(totalCents);
}

const parts = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...opts }).format(d);

/** '6:00am' */
export function time(iso: ISODateTime | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return parts(d, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
}
/** 'Tue 14 Oct' */
export function dayShort(iso: ISODateTime | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return parts(d, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}
/** 'Tuesday 14 October' */
export function dayLong(iso: ISODateTime | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return parts(d, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
}
/** '6:00am Tue 14 Oct' */
export function dateTime(iso: ISODateTime | Date): string {
  return `${time(iso)} ${dayShort(iso)}`;
}

/** Studio-local calendar date 'YYYY-MM-DD' for an instant. */
export function studioDate(d: Date | ISODateTime = new Date()): ISODate {
  const x = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
}

/** Minutes the studio timezone is ahead of UTC at a given instant (handles AEST/AEDT). */
export function tzOffsetMinutes(at: Date): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  const g = (k: string) => Number(p[k] ?? 0);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - at.getTime()) / 60000);
}

/** Convert studio-local 'YYYY-MM-DD' + 'HH:mm' to a UTC ISO string. DST-safe. */
export function studioToUTC(date: ISODate, hhmm: string): ISODateTime {
  const [y, m, d] = nums3(date);
  const [hh, mm] = nums3(hhmm);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMinutes(new Date(guess));
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t).toISOString();
}

/** Add days to a studio date. */
export function addDays(date: ISODate, n: number): ISODate {
  const [y, m, d] = nums3(date);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}

/** 0=Sun..6=Sat for a studio date. */
export function weekday(date: ISODate): number {
  const [y, m, d] = nums3(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the studio week containing the date (membership weeks run Mon–Sun). */
export function weekStart(date: ISODate): ISODate {
  const wd = weekday(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

/** UTC instant of studio-local midnight starting the date. */
export function startOfStudioDay(date: ISODate): ISODateTime {
  return studioToUTC(date, '00:00');
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s.charAt(0).toUpperCase()).join('');
}

export function pluralise(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
