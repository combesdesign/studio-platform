/**
 * "Pete will reply by..." maths. Pure: business hours Mon to Fri 9am to 5pm in the platform support timezone
 * (config.ts), a target of N business hours. Works on wall-clock time in that zone, so daylight saving is handled
 * (it changes at 2am on a Sunday, outside business hours).
 */
import { SUPPORT_CLOSED_DATES, SUPPORT_CLOSE_HOUR, SUPPORT_DAYS, SUPPORT_OPEN_HOUR, SUPPORT_TARGET_HOURS, SUPPORT_TZ } from './config';

interface Wall { y: number; m: number; d: number; h: number; min: number; dow: number }

function wallOf(at: Date, tz: string): Wall {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), h: +get('hour') % 24, min: +get('minute'), dow };
}

/** The instant at which the wall clock in `tz` reads y-m-d h:min. */
function instantOf(tz: string, y: number, m: number, d: number, h: number, min: number): Date {
  const asUtc = Date.UTC(y, m - 1, d, h, min);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const w = wallOf(new Date(guess), tz);
    const shown = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
    if (shown === asUtc) break;
    guess -= shown - asUtc;
  }
  return new Date(guess);
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (w: { y: number; m: number; d: number }) => `${w.y}-${pad(w.m)}-${pad(w.d)}`;

/** Add whole calendar days to a wall date (no time zone involved). */
function addDays(w: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number; dow: number } {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

const isOpenDay = (w: { y: number; m: number; d: number; dow: number }, closed: readonly string[]) =>
  (SUPPORT_DAYS as readonly number[]).includes(w.dow) && !closed.includes(ymd(w));

export interface HoursOptions {
  tz?: string;
  /** Business hours to wait. Default SUPPORT_TARGET_HOURS. */
  hours?: number;
  closedDates?: readonly string[];
}

/** Is the support team in business hours at this moment? */
export function isOpenNow(now: Date, opts: HoursOptions = {}): boolean {
  const w = wallOf(now, opts.tz ?? SUPPORT_TZ);
  const mins = w.h * 60 + w.min;
  return isOpenDay(w, opts.closedDates ?? SUPPORT_CLOSED_DATES) && mins >= SUPPORT_OPEN_HOUR * 60 && mins < SUPPORT_CLOSE_HOUR * 60;
}

/**
 * When to promise a reply: `hours` business hours after `now`. Outside business hours the clock starts when we open
 * next (so Saturday 10am or Friday 6pm start from Monday 9am, and "2 hours" lands at Monday 11am).
 */
export function replyBy(now: Date, opts: HoursOptions = {}): Date {
  const tz = opts.tz ?? SUPPORT_TZ;
  const closed = opts.closedDates ?? SUPPORT_CLOSED_DATES;
  const open = SUPPORT_OPEN_HOUR * 60, close = SUPPORT_CLOSE_HOUR * 60;
  let left = Math.round((opts.hours ?? SUPPORT_TARGET_HOURS) * 60);
  const w = wallOf(now, tz);
  let day: { y: number; m: number; d: number; dow: number } = w;
  let mins = w.h * 60 + w.min;
  // Start of the clock: now if we're open, else the next opening.
  if (!isOpenDay(day, closed) || mins >= close) { day = nextOpenDay(addDays(day, 1), closed); mins = open; }
  else if (mins < open) mins = open;
  while (left > close - mins) {
    left -= close - mins;
    day = nextOpenDay(addDays(day, 1), closed);
    mins = open;
  }
  mins += left;
  return instantOf(tz, day.y, day.m, day.d, Math.floor(mins / 60), mins % 60);
}

function nextOpenDay(d: { y: number; m: number; d: number; dow: number }, closed: readonly string[]) {
  let day = d;
  for (let i = 0; i < 30 && !isOpenDay(day, closed); i++) day = addDays(day, 1);
  return day;
}

/**
 * "11:20am today", "9:30am tomorrow", "10:00am Monday", "10:00am Mon 3 Nov", written in the viewer's timezone
 * (a studio in Perth reads Perth time).
 */
export function formatReplyBy(at: Date | string, now: Date, tz: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const a = wallOf(d, tz), n = wallOf(now, tz);
  const days = Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86_400_000);
  const h12 = a.h % 12 === 0 ? 12 : a.h % 12;
  const time = `${h12}:${pad(a.min)}${a.h < 12 ? 'am' : 'pm'}`;
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (days <= 0) return `${time} today`;
  if (days === 1) return `${time} tomorrow`;
  if (days < 7) return `${time} ${DOW[a.dow]}`;
  return `${time} ${DOW[a.dow]!.slice(0, 3)} ${a.d} ${MON[a.m - 1]}`;
}
