/** Report aggregation and CSV export. Pure. */
import type {
  Booking, ClassSession, ClassType, Client, ID, Pass, PaymentMethod, Product, ProductKind, ReportRange, Sale, Staff, StudioReport,
} from '../shared/types';
import { gstOf, time, weekday } from '../shared/format';
import { studioDay as studioDate } from './time';
import { computePassStatus } from './rules';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const round1 = (n: number) => Math.round(n * 10) / 10;
const inRange = (date: string, r: ReportRange) => date >= r.from && date <= r.to;

/** Split a sale's total across its items (handles discounts / comps proportionally). */
export function allocateSale(sale: Sale): number[] {
  const gross = sale.items.map((i) => i.qty * i.unitCents);
  const sum = gross.reduce((a, b) => a + b, 0);
  if (sum <= 0) return gross.map((_, i) => (i === 0 ? sale.totalCents : 0));
  const out = gross.map((g) => Math.floor((g * sale.totalCents) / sum));
  const rem = sale.totalCents - out.reduce((a, b) => a + b, 0);
  if (out.length) out[out.length - 1] = (out[out.length - 1] ?? 0) + rem;
  return out;
}

export interface ReportInput {
  range: ReportRange;
  now: Date;
  sales: readonly Sale[];
  sessions: readonly ClassSession[];
  bookings: readonly Booking[];
  clients: readonly Client[];
  passes: readonly Pass[];
  staff: readonly Staff[];
  classTypes: readonly ClassType[];
  products: readonly Product[];
  topSlots?: number;
}

/**
 * - revenueCents: gross sales (by sale date) in range; refundsCents: refunds issued in range (by refund date).
 * - classesRun: non-cancelled sessions in range that have started by `now`.
 * - fill % = (booked + checked_in + no_show) / capacity, averaged over classes run.
 * - attendees = checked_in. Instructor pay = classes taught × payPerClassCents.
 * - activeMemberships / activePacks are a snapshot as at `now` (packs include intro + drop-ins).
 */
export function buildReport(input: ReportInput): StudioReport {
  const { range, now } = input;
  const productKind = new Map<ID, ProductKind>(input.products.map((p) => [p.id, p.kind]));

  let revenueCents = 0, refundsCents = 0, salesCount = 0;
  const revenueByMethod: Partial<Record<PaymentMethod, number>> = {};
  const revenueByKind: Partial<Record<ProductKind, number>> = {};
  for (const s of input.sales) {
    if (inRange(studioDate(s.createdAt), range)) {
      salesCount++;
      revenueCents += s.totalCents;
      revenueByMethod[s.method] = (revenueByMethod[s.method] ?? 0) + s.totalCents;
      const alloc = allocateSale(s);
      s.items.forEach((it, i) => {
        const kind: ProductKind = (it.productId && productKind.get(it.productId)) || 'retail';
        revenueByKind[kind] = (revenueByKind[kind] ?? 0) + (alloc[i] ?? 0);
      });
    }
    if (s.refundedAt && s.refundedCents && inRange(studioDate(s.refundedAt), range)) refundsCents += s.refundedCents;
  }

  const run = input.sessions.filter((s) => s.status !== 'cancelled' && inRange(studioDate(s.startsAt), range) && Date.parse(s.startsAt) <= now.getTime());
  const runIds = new Set(run.map((s) => s.id));
  const bySession = new Map<ID, Booking[]>();
  for (const b of input.bookings) {
    if (!runIds.has(b.sessionId)) continue;
    const arr = bySession.get(b.sessionId) ?? [];
    arr.push(b);
    bySession.set(b.sessionId, arr);
  }

  let totalBookings = 0, attended = 0, noShows = 0, lateCancels = 0, fillSum = 0;
  const inst = new Map<ID, { classes: number; attendees: number }>();
  const ctAgg = new Map<ID, { classes: number; attendees: number; fill: number }>();
  const slots = new Map<string, { n: number; attendees: number; sortKey: string }>();
  for (const s of run) {
    const bs = bySession.get(s.id) ?? [];
    const att = bs.filter((b) => b.status === 'checked_in').length;
    const occupied = bs.filter((b) => b.status === 'booked' || b.status === 'checked_in' || b.status === 'no_show').length;
    totalBookings += bs.filter((b) => b.status === 'booked' || b.status === 'checked_in' || b.status === 'no_show' || b.status === 'late_cancelled').length;
    attended += att;
    noShows += bs.filter((b) => b.status === 'no_show').length;
    lateCancels += bs.filter((b) => b.status === 'late_cancelled').length;
    const fill = s.capacity > 0 ? Math.min(100, (occupied / s.capacity) * 100) : 0;
    fillSum += fill;

    const i = inst.get(s.instructorId) ?? { classes: 0, attendees: 0 };
    i.classes++; i.attendees += att; inst.set(s.instructorId, i);
    const c = ctAgg.get(s.classTypeId) ?? { classes: 0, attendees: 0, fill: 0 };
    c.classes++; c.attendees += att; c.fill += fill; ctAgg.set(s.classTypeId, c);
    const label = `${WEEKDAYS[weekday(studioDate(s.startsAt))]} ${time(s.startsAt)}`;
    const sl = slots.get(label) ?? { n: 0, attendees: 0, sortKey: label };
    sl.n++; sl.attendees += att; slots.set(label, sl);
  }

  const staffById = new Map(input.staff.map((s) => [s.id, s]));
  const ctById = new Map(input.classTypes.map((c) => [c.id, c]));
  const byInstructor = [...inst.entries()].map(([staffId, v]) => {
    const st = staffById.get(staffId);
    return { staffId, name: st?.name ?? 'Unknown', classes: v.classes, attendees: v.attendees, payCents: v.classes * (st?.payPerClassCents ?? 0) };
  }).sort((a, b) => b.classes - a.classes || a.name.localeCompare(b.name));
  const byClassType = [...ctAgg.entries()].map(([classTypeId, v]) => ({
    classTypeId, name: ctById.get(classTypeId)?.name ?? 'Unknown', classes: v.classes, attendees: v.attendees, avgFillPct: round1(v.fill / v.classes),
  })).sort((a, b) => b.classes - a.classes);
  const topSlots = [...slots.entries()].map(([label, v]) => ({ label, avgAttendees: round1(v.attendees / v.n) }))
    .sort((a, b) => b.avgAttendees - a.avgAttendees || a.label.localeCompare(b.label)).slice(0, input.topSlots ?? 5);

  let activeMemberships = 0, activePacks = 0;
  for (const p of input.passes) {
    if (computePassStatus(p, now) !== 'active') continue;
    if (p.kind === 'membership') activeMemberships++; else activePacks++;
  }

  return {
    range: { ...range },
    revenueCents, refundsCents, revenueByMethod, revenueByKind, salesCount,
    classesRun: run.length, totalBookings, attended, noShows, lateCancels,
    avgFillPct: run.length ? round1(fillSum / run.length) : 0,
    newClients: input.clients.filter((c) => inRange(studioDate(c.createdAt), range)).length,
    activeMemberships, activePacks, byInstructor, byClassType, topSlots,
  };
}

// ---------------------------------------------------------------- CSV

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const dollars = (c: number) => (c / 100).toFixed(2);

export function salesCsv(args: { sales: readonly Sale[]; clients: readonly Client[]; staff: readonly Staff[]; range: ReportRange }): string {
  const cl = new Map(args.clients.map((c) => [c.id, c]));
  const st = new Map(args.staff.map((s) => [s.id, s]));
  const rows: unknown[][] = [['Date', 'Time', 'Sale ID', 'Client', 'Email', 'Items', 'Method', 'Total', 'GST', 'Refunded', 'Net', 'Staff', 'Note']];
  const sales = args.sales.filter((s) => inRange(studioDate(s.createdAt), args.range)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const s of sales) {
    const c = s.clientId ? cl.get(s.clientId) : undefined;
    const refunded = s.refundedCents ?? 0;
    rows.push([
      studioDate(s.createdAt), time(s.createdAt), s.id, c ? `${c.firstName} ${c.lastName}` : 'Walk-in', c?.email ?? '',
      s.items.map((i) => `${i.qty} x ${i.name}`).join('; '), s.method, dollars(s.totalCents), dollars(gstOf(s.totalCents)),
      dollars(refunded), dollars(s.totalCents - refunded), s.staffId ? st.get(s.staffId)?.name ?? '' : '', s.note ?? '',
    ]);
  }
  return toCsv(rows);
}

export function clientsCsv(clients: readonly Client[]): string {
  const rows: unknown[][] = [['First name', 'Last name', 'Email', 'Phone', 'Birthday', 'Joined', 'Waiver signed', 'Marketing opt-in', 'Injuries', 'Emergency contact', 'Emergency phone', 'Source', 'Archived']];
  const sorted = [...clients].sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  for (const c of sorted) {
    rows.push([
      c.firstName, c.lastName, c.email, c.phone ?? '', c.birthday ?? '', studioDate(c.createdAt),
      c.waiverSignedAt ? studioDate(c.waiverSignedAt) : '', c.marketingOptIn ? 'yes' : 'no', c.injuries ?? '',
      c.emergencyContactName ?? '', c.emergencyContactPhone ?? '', c.source ?? '', c.archived ? 'yes' : 'no',
    ]);
  }
  return toCsv(rows);
}
