/**
 * Booking flow: which health step (if any) comes before confirming a booking, plus membership edit helpers.
 * Pure, so the demo store, the client app and the tests all agree. The live store feeds it the same data
 * (the client row and whether they have a checked-in booking), so demo and live behave the same.
 */
import type { Client, ISODate, ISODateTime, Pass, Product, StudioSettings } from '../shared/types';
import { studioDay } from './time';
import { DAY_MS } from './rules';

export interface HealthPolicy { longFormFirstTimers: boolean; quickCheck: boolean; quickCheckDays: number }

/** The studio's health-step settings with defaults (long form on, quick check on, every 30 days). */
export function healthPolicy(s: Pick<StudioSettings, 'longHealthFormFirstTimers' | 'quickHealthCheck' | 'quickHealthCheckDays'> | undefined): HealthPolicy {
  const days = Math.floor(Number(s?.quickHealthCheckDays));
  return {
    longFormFirstTimers: s?.longHealthFormFirstTimers !== false,
    quickCheck: s?.quickHealthCheck !== false,
    quickCheckDays: Number.isFinite(days) && days >= 1 ? days : 30,
  };
}

/** 'full' = waiver (+ long health questions if the studio has them on); 'quick' = the one-tap check; 'none' = straight to confirm. */
export type HealthStep = 'none' | 'full' | 'quick';

/** The last time this client told us about their health: the quick check, or the full form / waiver. */
export function lastHealthCheck(c: Pick<Client, 'healthCheckedAt' | 'healthForm' | 'waiverSignedAt'>): ISODateTime | undefined {
  const all = [c.healthCheckedAt, c.healthForm?.submittedAt, c.waiverSignedAt].filter((x): x is ISODateTime => !!x);
  return all.sort().pop();
}

/**
 * First-timers (no waiver yet) need the full waiver. Everyone who has attended before (`attended`: at least one checked-in
 * booking at this studio) gets the quick check, but only when the studio has it on and it has been `quickCheckDays` or more.
 * Someone who has signed up front but hasn't attended yet has just done the long form, so they go straight through.
 */
export function healthStepFor(args: { client: Pick<Client, 'healthCheckedAt' | 'healthForm' | 'waiverSignedAt'>; settings: StudioSettings | undefined; attended: boolean; now?: Date }): HealthStep {
  const { client, attended } = args;
  if (!client.waiverSignedAt) return 'full';
  if (!attended) return 'none';
  const p = healthPolicy(args.settings);
  if (!p.quickCheck) return 'none';
  const last = lastHealthCheck(client);
  if (!last) return 'quick';
  const now = (args.now ?? new Date()).getTime();
  return now - Date.parse(last) >= p.quickCheckDays * DAY_MS ? 'quick' : 'none';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '27 Oct 2026: sore left knee' (studio date). The same text the live database writes. */
export function healthNoteLine(note: string, at: Date | ISODateTime): string {
  const d = studioDay(typeof at === 'string' ? new Date(at) : at);
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}: ${note.trim()}`;
}

/** Append a dated health note to a client's injuries text. */
export function appendHealthNote(injuries: string | undefined, note: string, at: Date | ISODateTime): string {
  const line = healthNoteLine(note, at);
  return injuries?.trim() ? `${injuries.trim()}\n${line}` : line;
}

// ---------------------------------------------------------------- membership edits

/** Can this pass be edited (renewal date / moved)? Memberships that are still billing. */
export function isEditableMembership(p: Pick<Pass, 'kind' | 'status'>): boolean {
  return p.kind === 'membership' && p.status !== 'cancelled' && p.status !== 'expired';
}

/** The membership move staff have booked for the next cycle, while it still waits: what it changes to and when. Nothing for other passes or ended memberships. */
export function pendingMove(p: Pick<Pass, 'kind' | 'status' | 'pendingChange'>): { name: string; effectiveAt: ISODateTime } | undefined {
  if (p.kind !== 'membership' || !p.pendingChange || p.status === 'cancelled' || p.status === 'expired') return undefined;
  return { name: p.pendingChange.name, effectiveAt: p.pendingChange.effectiveAt };
}

/** A new renewal date must be after today and no more than 60 days out. Returns an error message, or null when fine. */
export function renewalDateProblem(date: ISODate, today: ISODate, maxDays = 60): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) return 'Choose a valid date.';
  if (date <= today) return 'Pick a date after today.';
  const max = new Date(Date.parse(today + 'T00:00:00Z') + maxDays * DAY_MS).toISOString().slice(0, 10);
  if (date > max) return `Pick a date within the next ${maxDays} days.`;
  return null;
}

/**
 * What switching memberships does to the money: the unused part of the current period, priced at the new rate, minus at the old
 * rate. Positive = they owe it, negative = they're owed a credit. Zero when there's nothing left of the period.
 */
export function membershipChangeCents(pass: Pick<Pass, 'priceCents' | 'billingInterval' | 'nextBillingAt'>, newPriceCents: number, now: Date): number {
  if (!pass.nextBillingAt) return 0;
  const period = (pass.billingInterval === 'month' ? 30 : 7) * DAY_MS;
  const left = Math.max(0, Math.min(period, Date.parse(pass.nextBillingAt) - now.getTime()));
  return Math.round(((newPriceCents - pass.priceCents) * left) / period);
}

/** The pass fields a membership product sets (what a move rewrites). */
export function passFieldsFrom(product: Product): Pick<Pass, 'productId' | 'name' | 'credits' | 'priceCents'> & Partial<Pick<Pass, 'classTypeIds' | 'noClasses' | 'familyShareable'>> {
  return {
    productId: product.id, name: product.name, credits: product.credits ?? null, priceCents: product.priceCents,
    ...(product.classTypeIds?.length ? { classTypeIds: [...product.classTypeIds] } : {}),
    ...(product.noClasses ? { noClasses: true } : {}),
    ...(product.familyShareable !== undefined ? { familyShareable: product.familyShareable } : {}),
  };
}
