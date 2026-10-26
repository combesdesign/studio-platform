/**
 * Live (Supabase) implementation of PayrollStore. Tables and RPCs: supabase/migrations/1400_payroll_tables.sql and
 * 1401_payroll_rpcs.sql. Every change goes through an RPC (same rules and error codes as demo.ts); reads of rules,
 * adjustments and pay runs use RLS. Pay is worked out here with calc.ts from payroll_period_inputs (classes taught
 * with attendance, staff, legacy per-class pay) plus those rows, so the demo and live stores share one calculation.
 *
 * Approving cover on live: payroll_decide_cover / payroll_claim_cover (auto-approve) update class_sessions.instructor_id
 * themselves inside the RPC (the demo goes through the booking engine's upsertSession).
 */
import './permissions';
import { registerLiveFeature, type LiveFeatureContext } from '../../data/supabase/features';
import { addDays, studioDate, studioToUTC } from '../../shared/format';
import type { Cents, ID, ISODate, ISODateTime } from '../../shared/types';
import { calcPayroll, payrollCsv, type ClassTaught } from './calc';
import type {
  ClockStatus, CoverRequestView, CoverStatus, PayAdjustment, PayPeriodView, PayRule, PayRuleInput, PayRunSummary, PayTier,
  PayrollSettings, PayrollStore, TimesheetEntry, TimesheetInput,
} from './types';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- row mappers (snake_case -> the shared types)

const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));
const num = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));
const iso = (v: unknown): ISODateTime | undefined => (v == null || v === '' ? undefined : new Date(String(v)).toISOString());
const day = (v: unknown): ISODate => String(v).slice(0, 10);
/** Copy only the defined values (the shared types use optional fields, not nulls). */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export const toSettings = (r: Row): PayrollSettings => ({
  frequency: r.frequency === 'fortnightly' ? 'fortnightly' : 'weekly',
  periodAnchor: day(r.period_anchor ?? '2024-01-01'),
  coverAutoApprove: r.cover_auto_approve === true,
});

export function toCover(r: Row): CoverRequestView {
  const s = (r.session ?? {}) as Row;
  return clean<CoverRequestView>({
    id: String(r.id), sessionId: String(r.session_id), requestedBy: String(r.requested_by), postedBy: String(r.posted_by),
    reason: str(r.reason), status: String(r.status) as CoverStatus, claimedBy: str(r.claimed_by), claimedAt: iso(r.claimed_at),
    decidedBy: str(r.decided_by), decidedAt: iso(r.decided_at), decisionNote: str(r.decision_note),
    autoApproved: r.auto_approved === true ? true : undefined,
    declinedBy: ((r.declined_by as string[] | null) ?? []).map(String), notified: ((r.notified as string[] | null) ?? []).map(String),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
    session: {
      id: String(s.id), classTypeId: String(s.class_type_id), startsAt: iso(s.starts_at)!, endsAt: iso(s.ends_at)!,
      instructorId: String(s.instructor_id), status: s.status === 'cancelled' ? 'cancelled' : 'scheduled',
    },
    canClaim: r.can_claim === true,
  });
}

export function toRule(r: Row): PayRule {
  return clean<PayRule>({
    id: String(r.id), staffId: String(r.staff_id), kind: r.kind as PayRule['kind'], earningsRate: str(r.earnings_rate),
    classTypeId: str(r.class_type_id), sessionType: str(r.session_type), rateCents: num(r.rate_cents),
    perHour: r.per_hour === true ? true : undefined, baseCents: num(r.base_cents), perHeadCents: num(r.per_head_cents),
    aboveN: num(r.above_n), tiers: Array.isArray(r.tiers) ? (r.tiers as PayTier[]).map((t) => ({ minAttendees: Number(t.minAttendees), payCents: Number(t.payCents) })) : undefined,
    active: r.active !== false,
  });
}

export function toEntry(r: Row): TimesheetEntry {
  return clean<TimesheetEntry>({
    id: String(r.id), staffId: String(r.staff_id), kind: r.kind === 'session' ? 'session' : 'shift', sessionType: str(r.session_type),
    startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at), breakMin: Number(r.break_min ?? 0), units: Number(r.units ?? 1),
    note: str(r.note), source: String(r.source ?? 'manual'), status: r.status as TimesheetEntry['status'],
    reviewedBy: str(r.reviewed_by), reviewedAt: iso(r.reviewed_at), reviewNote: str(r.review_note),
    createdBy: String(r.created_by ?? r.staff_id), createdAt: iso(r.created_at) ?? iso(r.started_at)!,
  });
}

export const toAdjustment = (r: Row): PayAdjustment => ({
  id: String(r.id), periodFrom: day(r.period_from), periodTo: day(r.period_to), staffId: String(r.staff_id), label: String(r.label),
  amountCents: Number(r.amount_cents), reason: String(r.reason), createdBy: String(r.created_by ?? ''), createdAt: iso(r.created_at)!,
});

const ruleArgs = (i: PayRuleInput): Row => ({
  id: i.id ?? null, staff_id: i.staffId, kind: i.kind, earnings_rate: i.earningsRate ?? null, class_type_id: i.classTypeId ?? null,
  session_type: i.sessionType ?? null, rate_cents: i.rateCents ?? null, per_hour: !!i.perHour, base_cents: i.baseCents ?? null,
  per_head_cents: i.perHeadCents ?? null, above_n: i.aboveN ?? null, tiers: i.tiers ?? null, active: i.active !== false,
});
const entryArgs = (i: TimesheetInput): Row => ({
  id: i.id ?? null, staff_id: i.staffId ?? null, kind: i.kind ?? null, session_type: i.sessionType ?? null, started_at: i.startedAt,
  ended_at: i.endedAt, break_min: i.breakMin ?? 0, units: i.units ?? 1, note: i.note ?? null, source: i.source ?? null,
});

// ---------------------------------------------------------------- the store

function create(ctx: LiveFeatureContext): PayrollStore {
  const rpc = async (name: string, args?: Row): Promise<Row> => (await ctx.rpc(name, args)) as Row;
  const list = async (name: string, args?: Row): Promise<Row[]> => ((await ctx.rpc(name, args)) as Row[] | null) ?? [];
  const range2 = (r: { from: ISODate; to: ISODate }) => ({ p_from: r.from, p_to: r.to });

  async function requireOwner(): Promise<void> {
    const u = await ctx.currentUser();
    if (!u || u.kind !== 'staff' || u.role !== 'owner') throw ctx.error('NOT_ALLOWED', 'Only the owner can do that.');
  }

  async function runFor(r: { from: ISODate; to: ISODate }): Promise<Row | undefined> {
    return (await ctx.rows(ctx.sb.from('payroll_runs').select('*').eq('period_from', r.from).eq('period_to', r.to)))[0];
  }

  /** Work the period out from the database (never a saved copy). */
  async function compute(r: { from: ISODate; to: ISODate }): Promise<PayPeriodView> {
    const inputs = await rpc('payroll_period_inputs', range2(r));
    const [rules, entries, adjustments] = await Promise.all([
      ctx.rows(ctx.sb.from('payroll_pay_rules').select('*')),
      // a day either side, then studio dates decide (calc.ts filters by studio date)
      ctx.rows(ctx.sb.from('payroll_timesheets').select('*')
        .gte('started_at', studioToUTC(addDays(r.from, -1), '00:00')).lt('started_at', studioToUTC(addDays(r.to, 2), '00:00'))),
      ctx.rows(ctx.sb.from('payroll_adjustments').select('*').eq('period_from', r.from).eq('period_to', r.to)),
    ]);
    const classTypes = (inputs.class_types ?? {}) as Record<ID, string>;
    const classes: ClassTaught[] = ((inputs.classes ?? []) as Row[]).map((c) => ({
      sessionId: String(c.session_id), staffId: String(c.staff_id), classTypeId: String(c.class_type_id), startsAt: iso(c.starts_at)!, attendees: Number(c.attendees ?? 0),
    }));
    const adj = adjustments.map(toAdjustment);
    const calc = calcPayroll({
      ...r, classes, rules: rules.map(toRule), entries: entries.map(toEntry), adjustments: adj,
      staff: ((inputs.staff ?? []) as Row[]).map((s) => ({ id: String(s.id), name: String(s.name) })),
      legacyPerClass: (inputs.legacy ?? {}) as Record<ID, Cents>,
      classTypeName: (id) => classTypes[id] ?? 'a class',
    });
    const today = inputs.today ? day(inputs.today) : studioDate(new Date());
    return { ...r, status: 'open', snapshot: false, ...calc, adjustments: adj, inProgress: r.to >= today };
  }

  function fromRun(run: Row): PayPeriodView {
    const snap = (run.snapshot ?? {}) as Partial<PayPeriodView>;
    return {
      staff: [], adjustments: [], totalCents: Number(run.total_cents ?? 0), pendingEntries: 0, openClocks: 0, ...snap,
      from: day(run.period_from), to: day(run.period_to), status: 'paid', snapshot: true, inProgress: false,
      paidAt: iso(run.paid_at), ...(run.paid_by ? { paidBy: String(run.paid_by) } : {}),
    } as PayPeriodView;
  }

  async function periodView(r: { from: ISODate; to: ISODate }): Promise<PayPeriodView> {
    const run = await runFor(r);
    return run ? fromRun(run) : compute(r);
  }

  return {
    getSettings: () => ctx.read(async () => toSettings(await rpc('payroll_get_settings'))),
    updateSettings: (patch) => ctx.write(async () => {
      const p: Row = {};
      if (patch.frequency !== undefined) p.frequency = patch.frequency;
      if (patch.periodAnchor !== undefined) p.period_anchor = patch.periodAnchor;
      if (patch.coverAutoApprove !== undefined) p.cover_auto_approve = !!patch.coverAutoApprove;
      return toSettings(await rpc('payroll_update_settings', { p_patch: p }));
    }),

    listCover: () => ctx.read(async () => (await list('payroll_list_cover')).map(toCover)),
    coverForSession: (sessionId) => ctx.read(async () => {
      const r = (await ctx.rpc('payroll_cover_for_session', { p_session_id: sessionId })) as Row | null;
      return r ? toCover(r) : null;
    }),
    requestCover: (input) => ctx.write(async () => toCover(await rpc('payroll_request_cover', { p_session_id: input.sessionId, p_reason: input.reason ?? null }))),
    claimCover: (id) => ctx.write(async () => toCover(await rpc('payroll_claim_cover', { p_id: id }))),
    withdrawCoverClaim: (id) => ctx.write(async () => toCover(await rpc('payroll_withdraw_claim', { p_id: id }))),
    decideCover: (id, decision, note) => ctx.write(async () => toCover(await rpc('payroll_decide_cover', { p_id: id, p_decision: decision, p_note: note ?? null }))),
    cancelCover: (id) => ctx.write(async () => toCover(await rpc('payroll_cancel_cover', { p_id: id }))),

    listPayRules: (opts) => ctx.read(async () => {
      let q = ctx.sb.from('payroll_pay_rules').select('*').order('created_at');
      if (opts?.staffId) q = q.eq('staff_id', opts.staffId);
      return (await ctx.rows(q)).map(toRule);
    }),
    savePayRule: (rule) => ctx.write(async () => toRule(await rpc('payroll_save_rule', { p_rule: ruleArgs(rule) }))),
    deletePayRule: (id) => ctx.write(async () => { await ctx.rpc('payroll_delete_rule', { p_id: id }); }),

    clockStatus: () => ctx.read(async (): Promise<ClockStatus> => {
      const r = await rpc('payroll_clock_status');
      return { eligible: r.eligible === true, ...(r.open ? { open: toEntry(r.open as Row) } : {}), todayMinutes: Number(r.today_minutes ?? 0) };
    }),
    clockIn: (note) => ctx.write(async () => toEntry(await rpc('payroll_clock_in', { p_note: note ?? null }))),
    clockOut: () => ctx.write(async () => toEntry(await rpc('payroll_clock_out'))),
    listTimesheets: (r) => ctx.read(async () => (await list('payroll_list_timesheets', { ...range2(r), p_staff_id: r.staffId ?? null })).map(toEntry)),
    saveTimesheet: (entry) => ctx.write(async () => toEntry(await rpc('payroll_save_timesheet', { p_entry: entryArgs(entry) }))),
    deleteTimesheet: (id) => ctx.write(async () => { await ctx.rpc('payroll_delete_timesheet', { p_id: id }); }),
    reviewTimesheets: (ids, decision, note) => ctx.write(async () =>
      (await list('payroll_review_timesheets', { p_ids: ids, p_decision: decision, p_note: note ?? null })).map(toEntry)),

    getPayPeriod: (r) => ctx.read(() => periodView(r)),
    listPayRuns: () => ctx.read(async (): Promise<PayRunSummary[]> =>
      (await ctx.rows(ctx.sb.from('payroll_runs').select('period_from, period_to, paid_at, total_cents').order('period_from', { ascending: false })))
        .map((r) => ({ from: day(r.period_from), to: day(r.period_to), paidAt: iso(r.paid_at)!, totalCents: Number(r.total_cents) }))),
    addAdjustment: (i) => ctx.write(async () => toAdjustment(await rpc('payroll_add_adjustment', {
      p_from: i.from, p_to: i.to, p_staff_id: i.staffId, p_label: i.label, p_amount_cents: i.amountCents, p_reason: i.reason,
    }))),
    removeAdjustment: (id) => ctx.write(async () => { await ctx.rpc('payroll_remove_adjustment', { p_id: id }); }),
    markPaid: (r) => ctx.write(async () => {
      // The database checks the period has ended and nothing is pending; the saved copy is what the owner was shown.
      const view = await compute(r);
      const snapshot: PayPeriodView = { ...view, status: 'paid', snapshot: true, inProgress: false };
      return fromRun(await rpc('payroll_mark_paid', { ...range2(r), p_total_cents: view.totalCents, p_snapshot: snapshot }));
    }),
    reopenPeriod: (r) => ctx.write(async () => { await ctx.rpc('payroll_reopen', range2(r)); return compute(r); }),
    exportCsv: (r) => ctx.read(async () => { await requireOwner(); return payrollCsv(await periodView(r)); }),
  };
}

registerLiveFeature({ name: 'payroll', create });
