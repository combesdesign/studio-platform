/**
 * Payroll feature: sub/cover requests, pay rules, timesheets and payroll export (ROADMAP B4).
 * Owner: the payroll feature agent. Everything for this feature lives in src/features/payroll/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1400_payroll_*.sql (range 1400–1499), tests supabase/tests/payroll_*.sql.
 *
 * Conventions (same as src/shared/types.ts): money is integer cents in the studio's currency, timestamps are ISO UTC,
 * calendar dates are 'YYYY-MM-DD' in the studio's timezone.
 */
import type { Cents, ID, ISODate, ISODateTime } from '../../shared/types';

// ---------------------------------------------------------------- cover (sub) requests

/** open = waiting for someone to claim · claimed = waiting for approval · approved = the class has a new instructor.
 *  expired is worked out when the class has started without being covered. */
export type CoverStatus = 'open' | 'claimed' | 'approved' | 'cancelled' | 'expired';

export interface CoverRequest {
  id: ID;
  sessionId: ID;
  /** The instructor who needs cover (the class's instructor when it was posted). */
  requestedBy: ID;
  /** Who posted it (the instructor, or an owner/manager on their behalf). */
  postedBy: ID;
  reason?: string;
  status: CoverStatus;
  claimedBy?: ID;
  claimedAt?: ISODateTime;
  /** Set when approved (auto-approval records no one). */
  decidedBy?: ID;
  decidedAt?: ISODateTime;
  decisionNote?: string;
  autoApproved?: boolean;
  /** Staff whose claim was turned down (they can't claim it again). */
  declinedBy: ID[];
  /** Staff who were told (in-app now, email on live). */
  notified: ID[];
  createdAt: ISODateTime;
}

export interface CoverSessionInfo {
  id: ID;
  classTypeId: ID;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  /** Who teaches it now (changes to the cover instructor on approval). */
  instructorId: ID;
  status: 'scheduled' | 'cancelled';
}

/** A request with its class, and whether the signed-in person can claim it. */
export interface CoverRequestView extends CoverRequest {
  session: CoverSessionInfo;
  canClaim: boolean;
}

// ---------------------------------------------------------------- settings

export type PayFrequency = 'weekly' | 'fortnightly';
export interface PayrollSettings {
  frequency: PayFrequency;
  /** A date a pay period starts on (any one; periods repeat from it every 7 or 14 days). */
  periodAnchor: ISODate;
  /** true = a claim goes straight through; false = the owner or a manager approves. */
  coverAutoApprove: boolean;
}

// ---------------------------------------------------------------- pay rules (owner-only, per staff member)

/** flat = per class · per_head = base plus per attendee above N · tiered = by attendance · hourly = timesheet hours ·
 *  session = private/appointment work, matched by a generic session-type key ('private', 'duet', …). */
export type PayRuleKind = 'flat' | 'per_head' | 'tiered' | 'hourly' | 'session';

export interface PayTier { minAttendees: number; payCents: Cents }

export interface PayRule {
  id: ID;
  staffId: ID;
  kind: PayRuleKind;
  /** Name on the Xero export (blank = a sensible default for the kind). */
  earningsRate?: string;
  /** flat / per_head / tiered: only this class type (blank = every class the person teaches). */
  classTypeId?: ID;
  /** session: the session-type key. Appointments (or anything else) just logs work with the same key. */
  sessionType?: string;
  /** flat: per class · hourly: per hour · session: per session (or per hour when perHour). */
  rateCents?: Cents;
  perHour?: boolean;
  /** per_head */
  baseCents?: Cents;
  perHeadCents?: Cents;
  /** per_head: attendees above this number earn the per-head amount. */
  aboveN?: number;
  /** tiered: the highest tier reached wins. */
  tiers?: PayTier[];
  active: boolean;
}
export type PayRuleInput = Omit<PayRule, 'id'> & { id?: ID };

// ---------------------------------------------------------------- timesheets

export type TimesheetStatus = 'pending' | 'approved' | 'rejected';
/** shift = front desk hours (clock in/out or typed in) · session = private/appointment work for a session type. */
export type TimesheetKind = 'shift' | 'session';

export interface TimesheetEntry {
  id: ID;
  staffId: ID;
  kind: TimesheetKind;
  /** kind = session: the session-type key. */
  sessionType?: string;
  startedAt: ISODateTime;
  /** Empty while clocked in. */
  endedAt?: ISODateTime;
  breakMin: number;
  /** kind = session: how many sessions this entry covers (default 1). */
  units: number;
  note?: string;
  source: 'clock' | 'manual' | string;
  status: TimesheetStatus;
  reviewedBy?: ID;
  reviewedAt?: ISODateTime;
  reviewNote?: string;
  createdBy: ID;
  createdAt: ISODateTime;
}
export interface TimesheetInput {
  id?: ID;
  /** Defaults to the signed-in person. Entering someone else's needs timesheet access (owner/manager). */
  staffId?: ID;
  kind?: TimesheetKind;
  sessionType?: string;
  startedAt: ISODateTime;
  endedAt: ISODateTime;
  breakMin?: number;
  units?: number;
  note?: string;
  source?: string;
}

export interface ClockStatus {
  /** Front desk (or anyone with an hourly rule) clocks in and out. */
  eligible: boolean;
  /** The shift in progress, if any. */
  open?: TimesheetEntry;
  /** Minutes worked today, closed shifts only. */
  todayMinutes: number;
}

// ---------------------------------------------------------------- payroll

export interface PayAdjustment {
  id: ID;
  periodFrom: ISODate;
  periodTo: ISODate;
  staffId: ID;
  /** Earnings rate name on the export, e.g. 'Bonus', 'Reimbursement'. */
  label: string;
  /** Plus or minus. */
  amountCents: Cents;
  reason: string;
  createdBy: ID;
  createdAt: ISODateTime;
}

export type PayLineKind = 'class' | 'head' | 'hourly' | 'session' | 'adjustment';
/** One row of the export: employee, earnings rate, units, rate, amount. */
export interface PayLine {
  staffId: ID;
  kind: PayLineKind;
  earningsRate: string;
  /** Classes, attendees, hours (2dp), sessions, or 1 for an adjustment. */
  units: number;
  rateCents: Cents;
  amountCents: Cents;
  detail?: string;
}

export interface PayClassRow {
  sessionId: ID;
  classTypeId: ID;
  startsAt: ISODateTime;
  attendees: number;
  amountCents: Cents;
  /** Why it earned nothing, e.g. 'No pay rule'. */
  note?: string;
}

export interface StaffPay {
  staffId: ID;
  name: string;
  lines: PayLine[];
  classes: PayClassRow[];
  classCount: number;
  attendees: number;
  /** Approved minutes counted (shifts). */
  minutes: number;
  /** Shift minutes still waiting for approval (not counted yet). */
  pendingMinutes: number;
  pendingEntries: number;
  adjustmentsCents: Cents;
  totalCents: Cents;
  warnings: string[];
}

export interface PayPeriodView {
  from: ISODate;
  to: ISODate;
  status: 'open' | 'paid';
  paidAt?: ISODateTime;
  paidBy?: ID;
  /** true = a saved copy of what was paid (rule changes don't touch it). */
  snapshot: boolean;
  staff: StaffPay[];
  adjustments: PayAdjustment[];
  totalCents: Cents;
  /** Entries still to approve across the period, and shifts still clocked in. */
  pendingEntries: number;
  openClocks: number;
  /** The period ends today or later. */
  inProgress: boolean;
}

export interface PayRunSummary { from: ISODate; to: ISODate; paidAt: ISODateTime; totalCents: Cents }

// ---------------------------------------------------------------- the store

export interface PayrollStore {
  getSettings(): Promise<PayrollSettings>;
  /** Frequency and anchor: owner. Cover auto-approval: owner or manager. */
  updateSettings(patch: Partial<PayrollSettings>): Promise<PayrollSettings>;

  // -------- cover
  /** Every cover request from the last couple of months plus anything upcoming, soonest class first. */
  listCover(): Promise<CoverRequestView[]>;
  /** The request that matters for a class: the live one, else the latest approved. */
  coverForSession(sessionId: ID): Promise<CoverRequestView | null>;
  /** The class's instructor (or an owner/manager for them) asks for cover. Notifies eligible staff. */
  requestCover(input: { sessionId: ID; reason?: string }): Promise<CoverRequestView>;
  claimCover(id: ID): Promise<CoverRequestView>;
  withdrawCoverClaim(id: ID): Promise<CoverRequestView>;
  /** Owner/manager. Approving changes the class's instructor. Declining puts it back to open. */
  decideCover(id: ID, decision: 'approve' | 'decline', note?: string): Promise<CoverRequestView>;
  cancelCover(id: ID): Promise<CoverRequestView>;

  // -------- pay rules (read: owner/manager · write: owner)
  listPayRules(opts?: { staffId?: ID }): Promise<PayRule[]>;
  savePayRule(rule: PayRuleInput): Promise<PayRule>;
  deletePayRule(id: ID): Promise<void>;

  // -------- timesheets
  clockStatus(): Promise<ClockStatus>;
  clockIn(note?: string): Promise<TimesheetEntry>;
  clockOut(): Promise<TimesheetEntry>;
  /** Own entries, or everyone's with timesheet access. */
  listTimesheets(range: { from: ISODate; to: ISODate; staffId?: ID }): Promise<TimesheetEntry[]>;
  saveTimesheet(entry: TimesheetInput): Promise<TimesheetEntry>;
  deleteTimesheet(id: ID): Promise<void>;
  /** Owner. */
  reviewTimesheets(ids: ID[], decision: 'approve' | 'reject', note?: string): Promise<TimesheetEntry[]>;

  // -------- payroll (owner/manager read · owner changes)
  getPayPeriod(range: { from: ISODate; to: ISODate }): Promise<PayPeriodView>;
  listPayRuns(): Promise<PayRunSummary[]>;
  addAdjustment(input: { from: ISODate; to: ISODate; staffId: ID; label: string; amountCents: Cents; reason: string }): Promise<PayAdjustment>;
  removeAdjustment(id: ID): Promise<void>;
  markPaid(range: { from: ISODate; to: ISODate }): Promise<PayPeriodView>;
  reopenPeriod(range: { from: ISODate; to: ISODate }): Promise<PayPeriodView>;
  /** Xero-friendly CSV: Employee, Earnings rate, Hours / units, Rate, Amount. */
  exportCsv(range: { from: ISODate; to: ISODate }): Promise<string>;
}

declare module '../../shared/store' {
  interface FeatureStores { payroll: PayrollStore }
}
