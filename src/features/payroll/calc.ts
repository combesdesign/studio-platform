/**
 * Payroll maths: pure functions, shared by the demo store and the live store (the live one feeds them rows from
 * Postgres). Nothing here touches storage, the DOM or the clock; "now" decisions (has the class finished?) are made
 * by whoever gathers the inputs.
 *
 * What gets paid:
 *  - classes taught (finished, not cancelled) × the instructor's flat / per-head / tiered rule, by checked-in attendance
 *  - approved shift hours × the hourly rule
 *  - approved private/appointment entries × the session rule with the same session-type key
 *  - adjustments (plus or minus, with a reason)
 * Whoever teaches the class when it ran is paid, so an approved cover moves the pay with it.
 */
import { addDays, studioDate } from '../../shared/format';
import { toCsv } from '../../domain/report';
import type { Cents, ID, ISODate, ISODateTime } from '../../shared/types';
import type {
  PayAdjustment, PayClassRow, PayFrequency, PayLine, PayPeriodView, PayRule, PayrollSettings, StaffPay, TimesheetEntry,
} from './types';

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = { frequency: 'weekly', periodAnchor: '2024-01-01', coverAutoApprove: false };

// ---------------------------------------------------------------- pay periods

const DAY_MS = 86_400_000;
const dayNum = (d: ISODate): number => {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, dd ?? 1) / DAY_MS;
};
export const periodDays = (f: PayFrequency): number => (f === 'fortnightly' ? 14 : 7);

/** The pay period (inclusive dates) that contains a studio date. */
export function periodFor(date: ISODate, s: Pick<PayrollSettings, 'frequency' | 'periodAnchor'>): { from: ISODate; to: ISODate } {
  const len = periodDays(s.frequency);
  const k = Math.floor((dayNum(date) - dayNum(s.periodAnchor)) / len);
  const from = addDays(s.periodAnchor, k * len);
  return { from, to: addDays(from, len - 1) };
}
/** The period n steps before (negative) or after (positive), keeping this one's length. */
export function shiftPeriod(p: { from: ISODate; to: ISODate }, n: number): { from: ISODate; to: ISODate } {
  const len = dayNum(p.to) - dayNum(p.from) + 1;
  const from = addDays(p.from, n * len);
  return { from, to: addDays(from, len - 1) };
}
export const inRange = (d: ISODate, r: { from: ISODate; to: ISODate }): boolean => d >= r.from && d <= r.to;

// ---------------------------------------------------------------- time

/** Worked minutes of an entry (0 while it's still open). */
export function entryMinutes(e: Pick<TimesheetEntry, 'startedAt' | 'endedAt' | 'breakMin'>): number {
  if (!e.endedAt) return 0;
  const m = Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 60_000) - (e.breakMin || 0);
  return Math.max(0, m);
}
/** '7.5' hours, 2dp trimmed: 450 -> 7.5, 455 -> 7.58 */
export const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

/** 'private' -> 'Private', 'duet_pilates' -> 'Duet pilates' */
export function sessionTypeLabel(key: string): string {
  const t = key.replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Session';
}

// ---------------------------------------------------------------- rules

export const RULE_KIND_LABEL: Record<PayRule['kind'], string> = {
  flat: 'Per class', per_head: 'Base + per head', tiered: 'By attendance', hourly: 'Hourly', session: 'Private / appointment',
};

/** The class rule that applies: one for this class type beats one for every class. */
export function ruleForClass(rules: readonly PayRule[], staffId: ID, classTypeId: ID): PayRule | undefined {
  const mine = rules.filter((r) => r.active && r.staffId === staffId && (r.kind === 'flat' || r.kind === 'per_head' || r.kind === 'tiered')
    && (!r.classTypeId || r.classTypeId === classTypeId));
  return mine.find((r) => r.classTypeId === classTypeId) ?? mine[0];
}
export const hourlyRule = (rules: readonly PayRule[], staffId: ID): PayRule | undefined =>
  rules.find((r) => r.active && r.staffId === staffId && r.kind === 'hourly');
export const sessionRule = (rules: readonly PayRule[], staffId: ID, sessionType: string): PayRule | undefined =>
  rules.find((r) => r.active && r.staffId === staffId && r.kind === 'session' && (r.sessionType ?? '') === sessionType);

interface Part { kind: 'class' | 'head'; earningsRate: string; units: number; rateCents: Cents; amountCents: Cents }

/** What one class earns under one rule, split into the rows the export needs. */
export function classParts(rule: Pick<PayRule, 'kind' | 'earningsRate' | 'rateCents' | 'baseCents' | 'perHeadCents' | 'aboveN' | 'tiers'>, attendees: number): { parts: Part[]; note?: string } {
  const name = rule.earningsRate?.trim() || 'Class pay';
  if (rule.kind === 'flat') {
    const r = Math.max(0, rule.rateCents ?? 0);
    return { parts: [{ kind: 'class', earningsRate: name, units: 1, rateCents: r, amountCents: r }] };
  }
  if (rule.kind === 'per_head') {
    const base = Math.max(0, rule.baseCents ?? 0);
    const per = Math.max(0, rule.perHeadCents ?? 0);
    const extra = Math.max(0, attendees - Math.max(0, rule.aboveN ?? 0));
    const parts: Part[] = [{ kind: 'class', earningsRate: name, units: 1, rateCents: base, amountCents: base }];
    if (extra > 0 && per > 0) parts.push({ kind: 'head', earningsRate: rule.earningsRate?.trim() ? `${name} (per head)` : 'Per-head pay', units: extra, rateCents: per, amountCents: extra * per });
    return { parts };
  }
  if (rule.kind === 'tiered') {
    const tiers = [...(rule.tiers ?? [])].sort((a, b) => a.minAttendees - b.minAttendees);
    let hit: { minAttendees: number; payCents: Cents } | undefined;
    for (const t of tiers) if (attendees >= t.minAttendees) hit = t;
    if (!hit) return { parts: [{ kind: 'class', earningsRate: name, units: 1, rateCents: 0, amountCents: 0 }], note: 'Below the first tier' };
    return { parts: [{ kind: 'class', earningsRate: name, units: 1, rateCents: hit.payCents, amountCents: hit.payCents }] };
  }
  return { parts: [] };
}

/** A short plain-English line for a rule, e.g. '$45 + $3 per head above 6'. */
export function describeRule(rule: PayRule, money: (c: Cents) => string): string {
  switch (rule.kind) {
    case 'flat': return `${money(rule.rateCents ?? 0)} per class`;
    case 'per_head': return `${money(rule.baseCents ?? 0)} + ${money(rule.perHeadCents ?? 0)} per head above ${rule.aboveN ?? 0}`;
    case 'tiered': return [...(rule.tiers ?? [])].sort((a, b) => a.minAttendees - b.minAttendees).map((t) => `${t.minAttendees}+ ${money(t.payCents)}`).join(' · ') || 'No tiers yet';
    case 'hourly': return `${money(rule.rateCents ?? 0)} an hour`;
    case 'session': return `${money(rule.rateCents ?? 0)} per ${rule.perHour ? 'hour' : 'session'} · ${sessionTypeLabel(rule.sessionType ?? '')}`;
  }
}

// ---------------------------------------------------------------- the calculation

export interface ClassTaught {
  sessionId: ID;
  /** Who taught it (the class's instructor, after any cover). */
  staffId: ID;
  classTypeId: ID;
  startsAt: ISODateTime;
  /** Checked-in clients. */
  attendees: number;
}

export interface CalcInput {
  from: ISODate;
  to: ISODate;
  /** Finished, non-cancelled classes that start inside the period. */
  classes: readonly ClassTaught[];
  rules: readonly PayRule[];
  entries: readonly TimesheetEntry[];
  adjustments: readonly PayAdjustment[];
  staff: readonly { id: ID; name: string }[];
  /** Old per-class pay kept on the staff record: used for anyone with no class rule. */
  legacyPerClass?: Readonly<Record<ID, Cents>>;
  classTypeName?: (id: ID) => string;
}

interface Acc { sp: StaffPay; groups: Map<string, PayLine> }

export function calcPayroll(input: CalcInput): Pick<PayPeriodView, 'staff' | 'totalCents' | 'pendingEntries' | 'openClocks'> {
  const range = { from: input.from, to: input.to };
  const names = new Map(input.staff.map((s) => [s.id, s.name]));
  const accs = new Map<ID, Acc>();
  const get = (id: ID): Acc => {
    let a = accs.get(id);
    if (!a) {
      a = {
        groups: new Map(),
        sp: { staffId: id, name: names.get(id) ?? 'Former staff member', lines: [], classes: [], classCount: 0, attendees: 0, minutes: 0, pendingMinutes: 0, pendingEntries: 0, adjustmentsCents: 0, totalCents: 0, warnings: [] },
      };
      accs.set(id, a);
    }
    return a;
  };
  const add = (a: Acc, l: PayLine): void => {
    const key = `${l.kind}|${l.earningsRate}|${l.rateCents}`;
    const g = a.groups.get(key);
    if (g) { g.units += l.units; g.amountCents += l.amountCents; }
    else a.groups.set(key, { ...l });
  };

  // classes
  const unpaid = new Map<ID, Set<string>>();
  for (const c of [...input.classes].sort((x, y) => x.startsAt.localeCompare(y.startsAt))) {
    if (!inRange(studioDate(c.startsAt), range)) continue;
    const a = get(c.staffId);
    const rule = ruleForClass(input.rules, c.staffId, c.classTypeId);
    let parts: Part[] = [];
    let note: string | undefined;
    if (rule) ({ parts, note } = classParts(rule, c.attendees));
    else {
      const legacy = input.legacyPerClass?.[c.staffId];
      if (legacy && legacy > 0) parts = [{ kind: 'class', earningsRate: 'Class pay', units: 1, rateCents: legacy, amountCents: legacy }];
      else {
        note = 'No pay rule';
        const set = unpaid.get(c.staffId) ?? new Set<string>();
        set.add(input.classTypeName?.(c.classTypeId) ?? 'a class');
        unpaid.set(c.staffId, set);
      }
    }
    const amount = parts.reduce((n, p) => n + p.amountCents, 0);
    for (const p of parts) add(a, { staffId: c.staffId, kind: p.kind, earningsRate: p.earningsRate, units: p.units, rateCents: p.rateCents, amountCents: p.amountCents });
    const row: PayClassRow = { sessionId: c.sessionId, classTypeId: c.classTypeId, startsAt: c.startsAt, attendees: c.attendees, amountCents: amount, ...(note ? { note } : {}) };
    a.sp.classes.push(row);
    a.sp.classCount++;
    a.sp.attendees += c.attendees;
  }
  for (const [id, set] of unpaid) get(id).sp.warnings.push(`No pay rule for ${[...set].join(', ')}. Those classes earn nothing until one is added.`);

  // timesheets
  let pendingEntries = 0;
  let openClocks = 0;
  const shiftMinutes = new Map<ID, number>();
  const sessionAgg = new Map<string, { staffId: ID; type: string; units: number; minutes: number }>();
  for (const e of input.entries) {
    if (!inRange(studioDate(e.startedAt), range)) continue;
    if (e.status === 'rejected') continue;
    const a = get(e.staffId);
    if (!e.endedAt) { if (e.kind === 'shift') { openClocks++; a.sp.warnings.push('Still clocked in. Close the shift before paying.'); } continue; }
    const mins = entryMinutes(e);
    if (e.status === 'pending') {
      pendingEntries++;
      a.sp.pendingEntries++;
      if (e.kind === 'shift') a.sp.pendingMinutes += mins;
      continue;
    }
    if (e.kind === 'shift') { shiftMinutes.set(e.staffId, (shiftMinutes.get(e.staffId) ?? 0) + mins); a.sp.minutes += mins; }
    else {
      const key = `${e.staffId}|${e.sessionType ?? ''}`;
      const s = sessionAgg.get(key) ?? { staffId: e.staffId, type: e.sessionType ?? '', units: 0, minutes: 0 };
      s.units += Math.max(1, e.units || 1);
      s.minutes += mins;
      sessionAgg.set(key, s);
    }
  }
  for (const [staffId, mins] of shiftMinutes) {
    const a = get(staffId);
    const rule = hourlyRule(input.rules, staffId);
    if (!rule || !rule.rateCents) { a.sp.warnings.push(`${hoursOf(mins)} hours logged but no hourly rate is set.`); continue; }
    add(a, {
      staffId, kind: 'hourly', earningsRate: rule.earningsRate?.trim() || 'Ordinary hours', units: hoursOf(mins), rateCents: rule.rateCents,
      amountCents: Math.round((mins * rule.rateCents) / 60),
    });
  }
  for (const s of sessionAgg.values()) {
    const a = get(s.staffId);
    const rule = sessionRule(input.rules, s.staffId, s.type);
    if (!rule || !rule.rateCents) { a.sp.warnings.push(`No pay rule for ${sessionTypeLabel(s.type).toLowerCase()} sessions.`); continue; }
    const name = rule.earningsRate?.trim() || `${sessionTypeLabel(s.type)} sessions`;
    if (rule.perHour) add(a, { staffId: s.staffId, kind: 'session', earningsRate: name, units: hoursOf(s.minutes), rateCents: rule.rateCents, amountCents: Math.round((s.minutes * rule.rateCents) / 60) });
    else add(a, { staffId: s.staffId, kind: 'session', earningsRate: name, units: s.units, rateCents: rule.rateCents, amountCents: s.units * rule.rateCents });
  }

  // adjustments
  for (const adj of input.adjustments) {
    if (adj.periodFrom !== input.from || adj.periodTo !== input.to) continue;
    const a = get(adj.staffId);
    a.sp.lines.push({ staffId: adj.staffId, kind: 'adjustment', earningsRate: adj.label || 'Adjustment', units: 1, rateCents: adj.amountCents, amountCents: adj.amountCents, detail: adj.reason });
    a.sp.adjustmentsCents += adj.amountCents;
  }

  const order: Record<PayLine['kind'], number> = { class: 0, head: 1, hourly: 2, session: 3, adjustment: 4 };
  const staff: StaffPay[] = [];
  for (const a of accs.values()) {
    const grouped = [...a.groups.values()].sort((x, y) => order[x.kind] - order[y.kind] || y.amountCents - x.amountCents);
    a.sp.lines = [...grouped, ...a.sp.lines];
    a.sp.totalCents = a.sp.lines.reduce((n, l) => n + l.amountCents, 0);
    staff.push(a.sp);
  }
  staff.sort((x, y) => x.name.localeCompare(y.name));
  return { staff, totalCents: staff.reduce((n, s) => n + s.totalCents, 0), pendingEntries, openClocks };
}

// ---------------------------------------------------------------- export

/** Xero-friendly rows: one per employee and earnings rate. Zero-dollar rows (an owner on $0 per class) are left out. */
export const CSV_HEADER = ['Employee', 'Earnings rate', 'Hours / units', 'Rate', 'Amount'] as const;
export function payrollCsv(view: Pick<PayPeriodView, 'staff'>): string {
  const rows: (string | number)[][] = [[...CSV_HEADER]];
  const dollars = (c: Cents) => (c / 100).toFixed(2);
  for (const sp of view.staff) {
    for (const l of sp.lines) {
      if (l.amountCents === 0) continue;
      const units = l.kind === 'hourly' || (l.kind === 'session' && !Number.isInteger(l.units)) ? l.units.toFixed(2) : String(l.units);
      rows.push([sp.name, l.earningsRate, units, dollars(l.rateCents), dollars(l.amountCents)]);
    }
  }
  return toCsv(rows);
}

/** Does this staff member need a clock? Front desk, or anyone paid hourly. */
export const clocksIn = (role: string, rules: readonly PayRule[], staffId: ID): boolean => role === 'front_desk' || !!hourlyRule(rules, staffId);
