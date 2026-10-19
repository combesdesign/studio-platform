/** Payroll studio UI: small shared helpers (store handle, date + hours formatting, form inputs). */
import React, { useEffect, useState } from 'react';
import { store } from '../../../shared/react';
import { LOCALE, dateFormat, studioDate, studioToUTC } from '../../../shared/format';
import type { ISODate, ISODateTime } from '../../../shared/types';
import type { PayrollStore } from '../types';

/** The payroll store (undefined until the feature registered, so callers check). */
export const payroll = (): PayrollStore | undefined => store.features.payroll;

/** Re-render every `ms` (live clock). */
export function useTick(ms = 30_000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setN(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return n;
}

const shortDay = (d: ISODate) => new Date(d + 'T12:00:00Z').toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** '12–18 Oct' or '28 Sep – 4 Oct' */
export function periodLabel(from: ISODate, to: ISODate): string {
  const [a, b] = [shortDay(from), shortDay(to)];
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${a.split(' ')[0]}–${b}` : `${a} – ${b}`;
}
/** 'Mon 12 Oct' for a studio date */
export const dateLabel = (d: ISODate): string =>
  new Date(d + 'T12:00:00Z').toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');

/** 450 -> '7.5 hrs', 60 -> '1 hr', 45 -> '45 min' */
export function hrs(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round((minutes / 60) * 100) / 100;
  return `${h} ${h === 1 ? 'hr' : 'hrs'}`;
}
/** 135 -> '2h 15m' (a running clock) */
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** 'HH:mm' (24h) of an instant in studio time, for <input type="time">. */
export const time24 = (iso: ISODateTime): string => dateFormat({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
export const toInstant = (date: ISODate, hhmm: string): ISODateTime => studioToUTC(date, hhmm);
export const dateOf = (iso: ISODateTime): ISODate => studioDate(iso);

/** A dollar amount typed by a person -> cents ('' -> undefined). */
export const centsOf = (s: string): number | undefined => {
  const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};
export const dollarsOf = (c: number | undefined | null): string => (c == null ? '' : (c / 100).toFixed(c % 100 ? 2 : 0));

export function MoneyInput({ value, onChange, placeholder, label, ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; ariaLabel?: string }) {
  const input = (
    <div className="money-in"><span>$</span><input className="input" inputMode="decimal" value={value} placeholder={placeholder} aria-label={ariaLabel ?? label} onChange={(e) => onChange(e.target.value)} /></div>
  );
  return label ? <label className="field"><span>{label}</span>{input}</label> : input;
}

/** ‹ 12–18 Oct › */
export function PeriodNav({ from, to, onPrev, onNext, nextDisabled, sub }: { from: ISODate; to: ISODate; onPrev: () => void; onNext: () => void; nextDisabled?: boolean; sub?: React.ReactNode }) {
  return (
    <div className="pr-nav">
      <button className="btn soft icon" onClick={onPrev} aria-label="Previous period"><svg className="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m14.5 6-6 6 6 6" /></svg></button>
      <div className="pr-nav-t"><strong>{periodLabel(from, to)}</strong>{sub && <span>{sub}</span>}</div>
      <button className="btn soft icon" onClick={onNext} disabled={nextDisabled} aria-label="Next period"><svg className="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m9.5 6 6 6-6 6" /></svg></button>
    </div>
  );
}
