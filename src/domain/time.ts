/**
 * Fast studio-date helper. Same output as format.ts studioDate(), but reuses one Intl formatter
 * and memoises ISO strings (rules call it thousands of times per operation).
 */
import type { ISODate, ISODateTime } from '../shared/types';
import { TZ } from '../shared/format';

let fmt: Intl.DateTimeFormat | undefined;
const memo = new Map<string, ISODate>();

export function studioDay(d: Date | ISODateTime): ISODate {
  fmt ??= new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  if (typeof d !== 'string') return fmt.format(d);
  let v = memo.get(d);
  if (v === undefined) {
    v = fmt.format(new Date(d));
    if (memo.size > 50_000) memo.clear();
    memo.set(d, v);
  }
  return v;
}
