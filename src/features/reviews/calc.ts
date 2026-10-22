/** Review maths and checks. Pure functions, shared by the demo store, the live store, the UI and the tests. */
import type { ReviewEntry, ReviewInput } from './types';

export const MIN_RATING = 1;
export const MAX_RATING = 5;
export const MAX_COMMENT = 1000;
/** Scores of this or more ask for a Google review (when the studio saved a link). */
export const HAPPY_NPS = 9;
/** A class is asked about for this many days after it, then we stop asking. */
export const PROMPT_DAYS = 14;

/** Trim and validate. Throws a plain Error('INVALID: …') caught by callers and turned into a StoreError. */
export function cleanReview(input: ReviewInput): { rating: number; nps: number | null; comment: string | null } {
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) throw new Error('INVALID: Please choose 1 to 5 flowers.');
  const nps = input.nps === null || input.nps === undefined ? null : Number(input.nps);
  if (nps !== null && (!Number.isInteger(nps) || nps < 0 || nps > 10)) throw new Error('INVALID: Choose a number from 0 to 10.');
  const comment = (input.comment ?? '').trim();
  if (comment.length > MAX_COMMENT) throw new Error(`INVALID: Comments can be up to ${MAX_COMMENT} characters.`);
  return { rating, nps, comment: comment || null };
}

/** Only web addresses, so a link setting can't be a script or a file. Empty is fine (off). */
export function cleanGoogleUrl(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('INVALID: That doesn\'t look like a web address. Start it with https://'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('INVALID: That doesn\'t look like a web address. Start it with https://');
  return u.toString();
}

export interface Stat { id: string; count: number; avg: number }

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Average rating and count per key (class type or instructor), best first. */
export function averageBy(entries: ReviewEntry[], key: (e: ReviewEntry) => string): Stat[] {
  const m = new Map<string, { n: number; sum: number }>();
  for (const e of entries) { const k = key(e); const v = m.get(k) ?? { n: 0, sum: 0 }; v.n++; v.sum += e.rating; m.set(k, v); }
  return [...m].map(([id, v]) => ({ id, count: v.n, avg: round1(v.sum / v.n) })).sort((a, b) => b.avg - a.avg || b.count - a.count || a.id.localeCompare(b.id));
}

export interface Nps { score: number | null; answers: number; promoters: number; passives: number; detractors: number }

/** Net Promoter Score: % who scored 9 or 10 minus % who scored 0 to 6, from -100 to 100. Null with no answers. */
export function npsOf(entries: Pick<ReviewEntry, 'nps'>[]): Nps {
  let promoters = 0, passives = 0, detractors = 0;
  for (const e of entries) {
    if (e.nps === null || e.nps === undefined) continue;
    if (e.nps >= 9) promoters++; else if (e.nps >= 7) passives++; else detractors++;
  }
  const answers = promoters + passives + detractors;
  return { score: answers ? Math.round(((promoters - detractors) / answers) * 100) : null, answers, promoters, passives, detractors };
}

export function overall(entries: ReviewEntry[]): { count: number; avg: number | null } {
  return { count: entries.length, avg: entries.length ? round1(entries.reduce((s, e) => s + e.rating, 0) / entries.length) : null };
}

/** Roster-friendly name for the comments list: first name only. */
export const byNewest = (a: ReviewEntry, b: ReviewEntry) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
