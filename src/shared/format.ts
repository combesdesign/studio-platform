/** Formatting + studio-timezone date helpers shared by both apps. No dependencies. */
import type { Cents, ISODate, ISODateTime } from './types';

export const TZ = 'Australia/Sydney';

const nums3 = (s: string): [number, number, number] => {
  const a = s.split(/[-:]/).map(Number);
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
};

export function money(cents: Cents, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? cents % 100 !== 0;
  return (cents / 100).toLocaleString('en-AU', {
    style: 'currency', currency: 'AUD',
    minimumFractionDigits: showCents ? 2 : 0, maximumFractionDigits: showCents ? 2 : 0,
  });
}

export function gstOf(totalCents: Cents): Cents {
  return Math.round(totalCents / 11);
}

const parts = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, ...opts }).format(d);

/** '6:00am' */
export function time(iso: ISODateTime | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return parts(d, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
}
/** 'Tue 14 Oct' */
export function dayShort(iso: ISODateTime | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return parts(d, { weekday: 'short', day: 'numeric', month: 'short' });
}
/** 'Tuesday 14 October' */
export function dayLong(iso: ISODateTime | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return parts(d, { weekday: 'long', day: 'numeric', month: 'long' });
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
