/**
 * Demo implementation of PayrollStore, plugged into the demo store (src/data/demo/features.ts).
 * Everything lives in the studio's demo state under features.payroll, so it persists, syncs across tabs and resets
 * with the demo. Seeded for each built-in studio: pay rules, cover requests, timesheets and a paid pay run.
 *
 * Approving a cover request changes the class's instructor through the core booking engine's upsertSession
 * (the same call the roster's "Edit class" makes), so rosters, Today and pay all follow.
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import type { DemoState } from '../../data/demo/engine';
import { can } from '../../domain/permissions';
import { addDays, studioDate, studioToUTC, weekStart } from '../../shared/format';
import type { Cents, ID, ISODate, ISODateTime, Staff, Studio } from '../../shared/types';
import { DEFAULT_PAYROLL_SETTINGS, calcPayroll, clocksIn, entryMinutes, inRange, payrollCsv, type ClassTaught } from './calc';
import type {
  ClockStatus, CoverRequest, CoverRequestView, CoverStatus, PayAdjustment, PayPeriodView, PayRule, PayRuleInput, PayRunSummary,
  PayrollSettings, PayrollStore, TimesheetEntry,
} from './types';

interface Run { id: ID; from: ISODate; to: ISODate; paidAt: ISODateTime; paidBy: ID; totalCents: Cents; snapshot: PayPeriodView }
interface Slice {
  settings?: PayrollSettings;
  rules?: PayRule[];
  cover?: CoverRequest[];
  timesheets?: TimesheetEntry[];
  adjustments?: PayAdjustment[];
  runs?: Run[];
}
type Full = Required<Slice>;

/** Fill in whatever a studio without a seeded slice is missing (studios created on the platform start empty). */
function norm(raw: Slice): Full {
  raw.settings ??= { ...DEFAULT_PAYROLL_SETTINGS };
  raw.rules ??= [];
  raw.cover ??= [];
  raw.timesheets ??= [];
  raw.adjustments ??= [];
  raw.runs ??= [];
  return raw as Full;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------- shared logic (also used by the seed)

/** Who is told about, and may claim, a class that needs cover: active teachers other than the person asking. */
function eligibleStaff(state: DemoState, requesterId: ID): Staff[] {
  const teachers = new Set<ID>([...state.templates.filter((t) => t.active).map((t) => t.instructorId), ...state.sessions.map((s) => s.instructorId)]);
  return state.staff.filter((s) => s.active && s.id !== requesterId && (s.role === 'instructor' || teachers.has(s.id)));
}

function computeView(state: DemoState, s: Full, range: { from: ISODate; to: ISODate }, now: Date): PayPeriodView {
  const bookedIn = new Map<ID, number>();
  for (const b of state.bookings) if (b.status === 'checked_in') bookedIn.set(b.sessionId, (bookedIn.get(b.sessionId) ?? 0) + 1);
  const classes: ClassTaught[] = state.sessions
    .filter((x) => x.status === 'scheduled' && Date.parse(x.endsAt) <= now.getTime() && inRange(studioDate(x.startsAt), range))
    .map((x) => ({ sessionId: x.id, staffId: x.instructorId, classTypeId: x.classTypeId, startsAt: x.startsAt, attendees: bookedIn.get(x.id) ?? 0 }));
  const legacyPerClass: Record<ID, Cents> = {};
  for (const st of state.staff) if (st.payPerClassCents) legacyPerClass[st.id] = st.payPerClassCents;
  const calc = calcPayroll({
    ...range, classes, rules: s.rules, entries: s.timesheets, adjustments: s.adjustments,
    staff: state.staff.map((x) => ({ id: x.id, name: x.name })), legacyPerClass,
    classTypeName: (id) => state.classTypes.find((c) => c.id === id)?.name ?? 'a class',
  });
  return {
    ...range, status: 'open', snapshot: false, ...calc,
    adjustments: s.adjustments.filter((a) => a.periodFrom === range.from && a.periodTo === range.to),
    inProgress: range.to >= studioDate(now),
  };
}

const cleanKey = (v?: string): string => (v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
/** Two active rules in the same slot would fight, so a person gets one per slot. */
export const ruleSlot = (r: Pick<PayRule, 'kind' | 'classTypeId' | 'sessionType'>): string =>
  r.kind === 'hourly' ? 'hourly' : r.kind === 'session' ? `session:${r.sessionType ?? ''}` : `class:${r.classTypeId ?? '*'}`;

function cleanRule(i: PayRuleInput, ctx: DemoFeatureContext): PayRuleInput {
  const bad = (m: string) => ctx.error('INVALID', m);
  const num = (v: unknown, what: string, min = 0): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > 10_000_000) throw bad(`Check the ${what}.`);
    return Math.round(v);
  };
  if (!['flat', 'per_head', 'tiered', 'hourly', 'session'].includes(i.kind)) throw bad('Pick how this person is paid.');
  const out: PayRuleInput = { staffId: i.staffId, kind: i.kind, active: i.active !== false };
  if (i.id) out.id = i.id;
  if (i.earningsRate?.trim()) out.earningsRate = i.earningsRate.trim().slice(0, 60);
  if (i.kind === 'flat') out.rateCents = num(i.rateCents ?? 0, 'amount per class');
  if (i.kind === 'per_head') {
    out.baseCents = num(i.baseCents ?? 0, 'base amount');
    out.perHeadCents = num(i.perHeadCents ?? 0, 'per-head amount');
    out.aboveN = num(i.aboveN ?? 0, 'number of attendees');
  }
  if (i.kind === 'tiered') {
    const tiers = (i.tiers ?? []).map((t) => ({ minAttendees: num(t.minAttendees, 'attendance tiers'), payCents: num(t.payCents, 'tier amounts') }));
    if (!tiers.length) throw bad('Add at least one tier.');
    if (new Set(tiers.map((t) => t.minAttendees)).size !== tiers.length) throw bad('Two tiers start at the same number of attendees.');
    out.tiers = tiers.sort((a, b) => a.minAttendees - b.minAttendees);
  }
  if (i.kind === 'hourly') out.rateCents = num(i.rateCents ?? 0, 'hourly rate', 1);
  if (i.kind === 'session') {
    const key = cleanKey(i.sessionType);
    if (!key) throw bad('Say which kind of session this is for, like “private”.');
    out.sessionType = key;
    out.rateCents = num(i.rateCents ?? 0, 'session rate', 1);
    if (i.perHour) out.perHour = true;
  }
  if ((i.kind === 'flat' || i.kind === 'per_head' || i.kind === 'tiered') && i.classTypeId) out.classTypeId = i.classTypeId;
  return out;
}

// ---------------------------------------------------------------- the store

function create(ctx: DemoFeatureContext): PayrollStore {
  const S = (): Full => norm(ctx.slice<Slice>());
  const err = ctx.error;
  const nowIso = () => ctx.now().toISOString();
  const staffRec = (id: ID) => ctx.core().state.staff.find((x) => x.id === id);
  const requireOpen = (s: Full, date: ISODate) => {
    if (s.runs.some((r) => inRange(date, r))) throw err('PERIOD_PAID', 'That pay period has already been paid. Reopen it first if it needs a change.');
  };

  // ---------------------------------------------------------------- cover helpers
  /** Is this person already teaching something that overlaps the class? */
  function clash(staffId: ID, sessionId: ID): boolean {
    const se = ctx.core().engine.findSession(sessionId);
    if (!se) return false;
    const a = Date.parse(se.startsAt), b = Date.parse(se.endsAt);
    return ctx.core().state.sessions.some((o) => o.id !== sessionId && o.instructorId === staffId && o.status === 'scheduled' && Date.parse(o.startsAt) < b && Date.parse(o.endsAt) > a);
  }
  function effectiveStatus(r: CoverRequest): CoverStatus {
    if (r.status !== 'open' && r.status !== 'claimed') return r.status;
    const se = ctx.core().engine.findSession(r.sessionId);
    if (!se || se.status === 'cancelled') return 'cancelled';
    return Date.parse(se.startsAt) <= ctx.now().getTime() ? 'expired' : r.status;
  }
  function toView(r: CoverRequest, viewer: Staff | undefined): CoverRequestView | null {
    const se = ctx.core().engine.findSession(r.sessionId);
    if (!se) return null;
    const status = effectiveStatus(r);
    const canClaim = !!viewer && status === 'open' && viewer.id !== r.requestedBy && !r.declinedBy.includes(viewer.id)
      && eligibleStaff(ctx.core().state, r.requestedBy).some((x) => x.id === viewer.id) && !clash(viewer.id, se.id);
    return {
      ...r, status,
      session: { id: se.id, classTypeId: se.classTypeId, startsAt: se.startsAt, endsAt: se.endsAt, instructorId: se.instructorId, status: se.status },
      canClaim,
    };
  }
  function findCover(id: ID): CoverRequest {
    const r = S().cover.find((x) => x.id === id);
    if (!r) throw err('NOT_FOUND', 'We couldn’t find that cover request.');
    return r;
  }
  function needLive(r: CoverRequest): void {
    const st = effectiveStatus(r);
    if (st === 'expired') throw err('TOO_LATE', 'That class has already started.');
    if (st === 'cancelled') throw err('CANCELLED', r.status === 'cancelled' ? 'That request was cancelled.' : 'That class has been cancelled.');
    if (st === 'approved') throw err('ALREADY_COVERED', 'That class already has its cover sorted.');
  }
  function approveNow(r: CoverRequest, byStaffId?: ID): void {
    const eng = ctx.core().engine;
    const se = eng.session(r.sessionId);
    if (!r.claimedBy) throw err('INVALID', 'Nobody has claimed this yet.');
    if (se.instructorId !== r.requestedBy) throw err('CHANGED', 'This class has a different instructor now, so the request is out of date.');
    eng.upsertSession({ ...se, instructorId: r.claimedBy }, byStaffId ? { kind: 'staff', staffId: byStaffId } : { kind: 'system' });
    r.status = 'approved';
    r.decidedAt = nowIso();
    if (byStaffId) r.decidedBy = byStaffId; else r.autoApproved = true;
  }
  function periodView(range: { from: ISODate; to: ISODate }): PayPeriodView {
    const s = S();
    const run = s.runs.find((r) => r.from === range.from && r.to === range.to);
    if (run) return { ...run.snapshot, status: 'paid', snapshot: true, paidAt: run.paidAt, paidBy: run.paidBy };
    return computeView(ctx.core().state, s, range, ctx.now());
  }

  return {
    // -------- settings
    getSettings: () => ctx.read(() => { ctx.requireStaff('payroll.cover'); return { ...S().settings }; }),
    updateSettings: (patch) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.cover');
      const s = S();
      if (patch.frequency !== undefined || patch.periodAnchor !== undefined) {
        ctx.requireStaff('payroll.manage');
        if (patch.frequency !== undefined) {
          if (patch.frequency !== 'weekly' && patch.frequency !== 'fortnightly') throw err('INVALID', 'Pick weekly or fortnightly.');
          s.settings.frequency = patch.frequency;
        }
        if (patch.periodAnchor !== undefined) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.periodAnchor) || Number.isNaN(Date.parse(patch.periodAnchor))) throw err('INVALID', 'Pick the first day of a pay period.');
          s.settings.periodAnchor = patch.periodAnchor;
        }
      }
      if (patch.coverAutoApprove !== undefined) {
        if (!can(me.role, 'payroll.cover_approve')) throw err('NOT_ALLOWED', 'Only the owner or a manager can change that.');
        s.settings.coverAutoApprove = !!patch.coverAutoApprove;
      }
      return { ...s.settings };
    }),

    // -------- cover
    listCover: () => ctx.read(() => {
      const me = ctx.requireStaff('payroll.cover');
      const horizon = ctx.now().getTime() - 60 * DAY;
      return S().cover
        .map((r) => toView(r, me))
        .filter((v): v is CoverRequestView => !!v && Date.parse(v.session.startsAt) >= horizon)
        .sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
    }),
    coverForSession: (sessionId) => ctx.read(() => {
      const me = ctx.requireStaff('payroll.cover');
      const mine = S().cover.filter((r) => r.sessionId === sessionId).map((r) => toView(r, me)).filter((v): v is CoverRequestView => !!v);
      const live = mine.find((v) => v.status === 'open' || v.status === 'claimed');
      if (live) return live;
      return mine.filter((v) => v.status === 'approved').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))[0] ?? null;
    }),
    requestCover: (input) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.cover');
      const se = ctx.core().engine.findSession(input.sessionId);
      if (!se) throw err('NOT_FOUND', 'We couldn’t find that class.');
      if (se.instructorId !== me.id && !can(me.role, 'payroll.cover_approve')) throw err('NOT_ALLOWED', 'You can ask for cover on your own classes.');
      if (se.status === 'cancelled') throw err('CANCELLED', 'That class has been cancelled.');
      if (Date.parse(se.startsAt) <= ctx.now().getTime()) throw err('TOO_LATE', 'That class has already started.');
      const s = S();
      if (s.cover.some((r) => r.sessionId === se.id && (r.status === 'open' || r.status === 'claimed'))) throw err('ALREADY_REQUESTED', 'Cover has already been asked for on this class.');
      const r: CoverRequest = {
        id: ctx.newId('cv'), sessionId: se.id, requestedBy: se.instructorId, postedBy: me.id, status: 'open', declinedBy: [],
        notified: eligibleStaff(ctx.core().state, se.instructorId).map((x) => x.id), createdAt: nowIso(),
      };
      if (input.reason?.trim()) r.reason = input.reason.trim().slice(0, 300);
      s.cover.push(r);
      return toView(r, me)!;
    }),
    claimCover: (id) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.cover');
      const s = S();
      const r = findCover(id);
      needLive(r);
      if (r.status !== 'open') throw err('ALREADY_CLAIMED', 'Someone else has already put their hand up for this one.');
      if (r.requestedBy === me.id) throw err('NOT_ALLOWED', 'This is your own class.');
      if (r.declinedBy.includes(me.id)) throw err('NOT_ALLOWED', 'Your earlier offer for this class wasn’t accepted.');
      if (!eligibleStaff(ctx.core().state, r.requestedBy).some((x) => x.id === me.id)) throw err('NOT_ALLOWED', 'Cover requests go to the people who teach here.');
      if (clash(me.id, r.sessionId)) throw err('CONFLICT', 'You’re already teaching at that time.');
      r.status = 'claimed';
      r.claimedBy = me.id;
      r.claimedAt = nowIso();
      if (s.settings.coverAutoApprove) approveNow(r);
      return toView(r, me)!;
    }),
    withdrawCoverClaim: (id) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.cover');
      const r = findCover(id);
      needLive(r);
      if (r.status !== 'claimed') throw err('INVALID', 'Nobody has claimed this one.');
      if (r.claimedBy !== me.id && !can(me.role, 'payroll.cover_approve')) throw err('NOT_ALLOWED', 'Only the person who claimed it can step back.');
      r.status = 'open';
      delete r.claimedBy;
      delete r.claimedAt;
      return toView(r, me)!;
    }),
    decideCover: (id, decision, note) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.cover_approve');
      const r = findCover(id);
      needLive(r);
      if (r.status !== 'claimed' || !r.claimedBy) throw err('INVALID', 'There’s no claim to decide on yet.');
      if (note?.trim()) r.decisionNote = note.trim().slice(0, 300);
      if (decision === 'approve') approveNow(r, me.id);
      else {
        r.declinedBy.push(r.claimedBy);
        r.status = 'open';
        delete r.claimedBy;
        delete r.claimedAt;
      }
      return toView(r, me)!;
    }),
    cancelCover: (id) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.cover');
      const r = findCover(id);
      needLive(r);
      if (r.postedBy !== me.id && r.requestedBy !== me.id && !can(me.role, 'payroll.cover_approve')) throw err('NOT_ALLOWED', 'Only the person who asked can cancel this.');
      r.status = 'cancelled';
      return toView(r, me)!;
    }),

    // -------- pay rules
    listPayRules: (opts) => ctx.read(() => {
      ctx.requireStaff('payroll.view');
      return S().rules.filter((r) => !opts?.staffId || r.staffId === opts.staffId);
    }),
    savePayRule: (input) => ctx.write(() => {
      ctx.requireStaff('payroll.rules');
      const s = S();
      const rule = cleanRule(input, ctx);
      if (!staffRec(rule.staffId)) throw err('NOT_FOUND', 'We couldn’t find that staff member.');
      if (rule.classTypeId && !ctx.core().state.classTypes.some((c) => c.id === rule.classTypeId)) throw err('NOT_FOUND', 'We couldn’t find that class type.');
      const slot = ruleSlot(rule);
      if (rule.active && s.rules.some((r) => r.id !== rule.id && r.active && r.staffId === rule.staffId && ruleSlot(r) === slot)) {
        throw err('DUPLICATE_RULE', 'There’s already a rule like that for this person. Edit it instead of adding a second.');
      }
      const i = rule.id ? s.rules.findIndex((r) => r.id === rule.id) : -1;
      if (rule.id && i < 0) throw err('NOT_FOUND', 'We couldn’t find that rule.');
      const saved: PayRule = { ...rule, id: rule.id ?? ctx.newId('pr'), active: rule.active };
      if (i >= 0) s.rules[i] = saved; else s.rules.push(saved);
      return saved;
    }),
    deletePayRule: (id) => ctx.write(() => {
      ctx.requireStaff('payroll.rules');
      const s = S();
      if (!s.rules.some((r) => r.id === id)) throw err('NOT_FOUND', 'We couldn’t find that rule.');
      ctx.slice<Slice>().rules = s.rules.filter((r) => r.id !== id);
    }),

    // -------- timesheets
    clockStatus: () => ctx.read((): ClockStatus => {
      const me = ctx.requireStaff('payroll.clock');
      const s = S();
      const open = s.timesheets.find((e) => e.staffId === me.id && e.kind === 'shift' && !e.endedAt);
      const today = studioDate(ctx.now());
      const todayMinutes = s.timesheets
        .filter((e) => e.staffId === me.id && e.kind === 'shift' && e.status !== 'rejected' && studioDate(e.startedAt) === today)
        .reduce((n, e) => n + entryMinutes(e), 0);
      return { eligible: clocksIn(me.role, s.rules, me.id), ...(open ? { open } : {}), todayMinutes };
    }),
    clockIn: (note) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.clock');
      const s = S();
      if (!clocksIn(me.role, s.rules, me.id)) throw err('NOT_ALLOWED', 'Clocking in is for front desk shifts. Ask the owner to set you up with an hourly rate.');
      if (s.timesheets.some((e) => e.staffId === me.id && e.kind === 'shift' && !e.endedAt)) throw err('ALREADY_CLOCKED_IN', 'You’re already clocked in.');
      requireOpen(s, studioDate(ctx.now()));
      const e: TimesheetEntry = {
        id: ctx.newId('ts'), staffId: me.id, kind: 'shift', startedAt: nowIso(), breakMin: 0, units: 1, source: 'clock', status: 'pending',
        createdBy: me.id, createdAt: nowIso(),
      };
      if (note?.trim()) e.note = note.trim().slice(0, 200);
      s.timesheets.push(e);
      return e;
    }),
    clockOut: () => ctx.write(() => {
      const me = ctx.requireStaff('payroll.clock');
      const e = S().timesheets.find((x) => x.staffId === me.id && x.kind === 'shift' && !x.endedAt);
      if (!e) throw err('NOT_CLOCKED_IN', 'You’re not clocked in.');
      e.endedAt = nowIso();
      return e;
    }),
    listTimesheets: (range) => ctx.read(() => {
      const me = ctx.requireStaff('payroll.clock');
      const all = can(me.role, 'payroll.timesheets');
      if (range.staffId && range.staffId !== me.id && !all) throw err('NOT_ALLOWED', 'You can see your own timesheet.');
      return S().timesheets
        .filter((e) => (all ? !range.staffId || e.staffId === range.staffId : e.staffId === me.id) && inRange(studioDate(e.startedAt), range))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }),
    saveTimesheet: (input) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.clock');
      const s = S();
      const manager = can(me.role, 'payroll.timesheets');
      const approver = can(me.role, 'payroll.timesheets_approve');
      const existing = input.id ? s.timesheets.find((e) => e.id === input.id) : undefined;
      if (input.id && !existing) throw err('NOT_FOUND', 'We couldn’t find that entry.');
      const staffId = existing?.staffId ?? input.staffId ?? me.id;
      if (staffId !== me.id && !manager) throw err('NOT_ALLOWED', 'You can add hours to your own timesheet.');
      const target = staffRec(staffId);
      if (!target || !target.active) throw err('NOT_FOUND', 'We couldn’t find that staff member.');
      const kind = existing?.kind ?? input.kind ?? 'shift';
      if (kind === 'session' && !manager) throw err('NOT_ALLOWED', 'The owner or a manager logs private sessions.');
      if (existing && existing.status === 'approved' && !approver) throw err('NOT_ALLOWED', 'Approved hours can only be changed by the owner.');
      const start = Date.parse(input.startedAt), end = Date.parse(input.endedAt);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw err('INVALID', 'The finish needs to be after the start.');
      if (end - start > 24 * HOUR) throw err('INVALID', 'That’s longer than a day. Split it into separate shifts.');
      if (end > ctx.now().getTime() + 5 * MIN) throw err('INVALID', 'You can’t log time that hasn’t happened yet.');
      const breakMin = Math.max(0, Math.round(input.breakMin ?? 0));
      if (breakMin * MIN >= end - start) throw err('INVALID', 'The break can’t be as long as the shift.');
      const sessionType = kind === 'session' ? cleanKey(input.sessionType) : '';
      if (kind === 'session' && !sessionType) throw err('INVALID', 'Say what kind of session it was.');
      requireOpen(s, studioDate(input.startedAt));
      if (existing) requireOpen(s, studioDate(existing.startedAt));
      if (kind === 'shift') {
        const overlap = s.timesheets.find((e) => e.id !== input.id && e.staffId === staffId && e.kind === 'shift' && e.status !== 'rejected'
          && Date.parse(e.startedAt) < end && (e.endedAt ? Date.parse(e.endedAt) : Infinity) > start);
        if (overlap) throw err('OVERLAP', 'That overlaps another shift on the timesheet.');
      }
      const next: TimesheetEntry = existing ?? {
        id: ctx.newId('ts'), staffId, kind, startedAt: input.startedAt, breakMin: 0, units: 1, source: input.source || 'manual', status: 'pending',
        createdBy: me.id, createdAt: nowIso(),
      };
      next.startedAt = new Date(start).toISOString();
      next.endedAt = new Date(end).toISOString();
      next.breakMin = breakMin;
      next.units = kind === 'session' ? Math.max(1, Math.round(input.units ?? 1)) : 1;
      next.status = approver ? 'approved' : 'pending';
      if (sessionType) next.sessionType = sessionType;
      if (input.note?.trim()) next.note = input.note.trim().slice(0, 200); else delete next.note;
      delete next.reviewNote;
      if (approver) { next.reviewedBy = me.id; next.reviewedAt = nowIso(); } else { delete next.reviewedBy; delete next.reviewedAt; }
      if (!existing) s.timesheets.push(next);
      return next;
    }),
    deleteTimesheet: (id) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.clock');
      const s = S();
      const e = s.timesheets.find((x) => x.id === id);
      if (!e) throw err('NOT_FOUND', 'We couldn’t find that entry.');
      const approver = can(me.role, 'payroll.timesheets_approve');
      const manager = can(me.role, 'payroll.timesheets');
      if (!approver && (e.status === 'approved' || (e.staffId !== me.id && !manager))) throw err('NOT_ALLOWED', 'Approved hours can only be removed by the owner.');
      requireOpen(s, studioDate(e.startedAt));
      ctx.slice<Slice>().timesheets = s.timesheets.filter((x) => x.id !== id);
    }),
    reviewTimesheets: (ids, decision, note) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.timesheets_approve');
      const s = S();
      const out: TimesheetEntry[] = [];
      for (const id of ids) {
        const e = s.timesheets.find((x) => x.id === id);
        if (!e) throw err('NOT_FOUND', 'We couldn’t find that entry.');
        if (decision === 'approve' && !e.endedAt) throw err('STILL_CLOCKED_IN', 'That shift is still running. Wait for them to clock out.');
        requireOpen(s, studioDate(e.startedAt));
        e.status = decision === 'approve' ? 'approved' : 'rejected';
        e.reviewedBy = me.id;
        e.reviewedAt = nowIso();
        if (note?.trim()) e.reviewNote = note.trim().slice(0, 200); else delete e.reviewNote;
        out.push(e);
      }
      return out;
    }),

    // -------- payroll
    getPayPeriod: (range) => ctx.read(() => { ctx.requireStaff('payroll.view'); return periodView(range); }),
    listPayRuns: () => ctx.read((): PayRunSummary[] => {
      ctx.requireStaff('payroll.view');
      return [...S().runs].sort((a, b) => b.from.localeCompare(a.from)).map((r) => ({ from: r.from, to: r.to, paidAt: r.paidAt, totalCents: r.totalCents }));
    }),
    addAdjustment: (input) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.manage');
      const s = S();
      if (!staffRec(input.staffId)) throw err('NOT_FOUND', 'We couldn’t find that staff member.');
      if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw err('INVALID', 'Enter an amount, plus or minus.');
      if (!input.reason?.trim()) throw err('INVALID', 'Add a reason so there’s a record of why.');
      if (input.to < input.from) throw err('INVALID', 'That isn’t a pay period.');
      if (s.runs.some((r) => r.from === input.from && r.to === input.to)) throw err('PERIOD_PAID', 'That pay period has already been paid. Reopen it first.');
      const a: PayAdjustment = {
        id: ctx.newId('adj'), periodFrom: input.from, periodTo: input.to, staffId: input.staffId, label: input.label?.trim().slice(0, 60) || 'Adjustment',
        amountCents: input.amountCents, reason: input.reason.trim().slice(0, 300), createdBy: me.id, createdAt: nowIso(),
      };
      s.adjustments.push(a);
      return a;
    }),
    removeAdjustment: (id) => ctx.write(() => {
      ctx.requireStaff('payroll.manage');
      const s = S();
      const a = s.adjustments.find((x) => x.id === id);
      if (!a) throw err('NOT_FOUND', 'We couldn’t find that adjustment.');
      if (s.runs.some((r) => r.from === a.periodFrom && r.to === a.periodTo)) throw err('PERIOD_PAID', 'That pay period has already been paid. Reopen it first.');
      ctx.slice<Slice>().adjustments = s.adjustments.filter((x) => x.id !== id);
    }),
    markPaid: (range) => ctx.write(() => {
      const me = ctx.requireStaff('payroll.manage');
      const s = S();
      if (s.runs.some((r) => r.from === range.from && r.to === range.to)) throw err('ALREADY_PAID', 'This pay period is already marked as paid.');
      if (range.to >= studioDate(ctx.now())) throw err('PERIOD_OPEN', 'This pay period hasn’t finished yet.');
      const view = computeView(ctx.core().state, s, range, ctx.now());
      if (view.openClocks > 0) throw err('STILL_CLOCKED_IN', 'Someone is still clocked in. Close their shift first.');
      if (view.pendingEntries > 0) throw err('TIMESHEETS_PENDING', `${view.pendingEntries === 1 ? '1 timesheet entry needs' : `${view.pendingEntries} timesheet entries need`} approving first.`);
      const paidAt = nowIso();
      const paid: PayPeriodView = { ...view, status: 'paid', snapshot: true, paidAt, paidBy: me.id, inProgress: false };
      s.runs.push({ id: ctx.newId('run'), from: range.from, to: range.to, paidAt, paidBy: me.id, totalCents: paid.totalCents, snapshot: paid });
      return paid;
    }),
    reopenPeriod: (range) => ctx.write(() => {
      ctx.requireStaff('payroll.manage');
      const s = S();
      if (!s.runs.some((r) => r.from === range.from && r.to === range.to)) throw err('NOT_FOUND', 'That pay period isn’t marked as paid.');
      ctx.slice<Slice>().runs = s.runs.filter((r) => !(r.from === range.from && r.to === range.to));
      return computeView(ctx.core().state, S(), range, ctx.now());
    }),
    exportCsv: (range) => ctx.read(() => { ctx.requireStaff('payroll.manage'); return payrollCsv(periodView(range)); }),
  };
}

// ---------------------------------------------------------------- seed

function seedSlice(studio: Studio, state: DemoState, now: Date, newId: (p: string) => ID): Full {
  const harbour = studio.slug === 'harbour';
  const today = studioDate(now);
  const monday = weekStart(today);
  const st = (id: string) => state.staff.find((x) => x.id === id);
  const owner = state.staff.find((x) => x.role === 'owner')!;
  // owner · two instructors · front desk
  const ids = harbour
    ? { owner: 'hb_st_ava', a: 'hb_st_noah', b: 'hb_st_isla', desk: 'hb_st_sam' }
    : { owner: 'st_libby', a: 'st_julia', b: 'st_gracet', desk: 'st_gracep' };
  const out: Full = {
    settings: harbour
      ? { frequency: 'fortnightly', periodAnchor: addDays(monday, -7), coverAutoApprove: true }
      : { frequency: 'weekly', periodAnchor: monday, coverAutoApprove: false },
    rules: [], cover: [], timesheets: [], adjustments: [], runs: [],
  };

  // ---- pay rules
  const rule = (staffId: string, r: Omit<PayRule, 'id' | 'staffId' | 'active'>) => { if (st(staffId)) out.rules.push({ id: newId('pr'), staffId, active: true, ...r }); };
  rule(ids.owner, { kind: 'flat', rateCents: 0, earningsRate: 'Owner (not on payroll)' });
  if (harbour) {
    rule(ids.a, { kind: 'flat', rateCents: 7000 });
    rule(ids.a, { kind: 'session', sessionType: 'private', rateCents: 11000, earningsRate: 'Private sessions' });
    rule(ids.b, { kind: 'per_head', baseCents: 5500, perHeadCents: 500, aboveN: 4 });
    rule(ids.b, { kind: 'session', sessionType: 'private', rateCents: 10500, earningsRate: 'Private sessions' });
    rule(ids.desk, { kind: 'hourly', rateCents: 3100, earningsRate: 'Front desk hours' });
  } else {
    rule(ids.a, { kind: 'tiered', tiers: [{ minAttendees: 0, payCents: 5500 }, { minAttendees: 8, payCents: 6500 }, { minAttendees: 12, payCents: 7500 }] });
    rule(ids.a, { kind: 'session', sessionType: 'private', rateCents: 9000, earningsRate: 'Private sessions' });
    rule(ids.b, { kind: 'per_head', baseCents: 4500, perHeadCents: 300, aboveN: 6 });
    rule(ids.desk, { kind: 'hourly', rateCents: 3250, earningsRate: 'Front desk hours' });
    const mums = state.classTypes.find((c) => c.id === 'ct_mums');
    if (mums) rule(ids.desk, { kind: 'flat', rateCents: 5500, classTypeId: mums.id, earningsRate: 'Mums + Bubs class' });
  }

  // ---- timesheets: front desk shifts over the last four weeks, a few private sessions
  const at = (date: ISODate, hhmm: string) => studioToUTC(date, hhmm);
  const shiftDays = harbour ? [2, 4, 6] : [1, 3, 5]; // Tue Thu Sat · Mon Wed Fri
  const shifts: TimesheetEntry[] = [];
  if (st(ids.desk)) {
    for (let back = 27; back >= 1; back--) {
      const d = addDays(today, -back);
      const wd = new Date(d + 'T12:00:00Z').getUTCDay();
      if (!shiftDays.includes(wd)) continue;
      const nudge = (wd + back) % 3 === 0 ? 15 : 0; // a quarter hour over now and then, so the hours aren't suspiciously round
      const endAt = new Date(Date.parse(at(d, harbour ? '12:30' : '13:00')) + nudge * MIN).toISOString();
      shifts.push({
        id: newId('ts'), staffId: ids.desk, kind: 'shift', startedAt: at(d, harbour ? '07:00' : '08:30'), endedAt: endAt, breakMin: 30, units: 1,
        source: 'clock', status: 'approved', reviewedBy: owner.id, reviewedAt: new Date(Date.parse(endAt) + 20 * HOUR).toISOString(),
        createdBy: ids.desk, createdAt: endAt,
      });
    }
    // this week's shifts, and the last shift of last week, are still waiting for the owner
    const lastBefore = [...shifts].reverse().find((e) => studioDate(e.startedAt) < monday);
    for (const e of shifts) {
      if (studioDate(e.startedAt) >= monday || e === lastBefore) { e.status = 'pending'; delete e.reviewedBy; delete e.reviewedAt; }
    }
  }
  out.timesheets.push(...shifts);
  // private sessions the owner logged (same session-type key an appointments feature would use)
  for (const [back, who, status] of [[9, ids.a, 'approved'], [8, harbour ? ids.b : ids.a, 'approved'], [2, ids.a, 'pending']] as const) {
    if (!st(who)) continue;
    const d = addDays(today, -back);
    const [s0, s1] = back === 8 ? ['10:00', '10:50'] : ['12:00', '12:50'];
    out.timesheets.push({
      id: newId('ts'), staffId: who, kind: 'session', sessionType: 'private', startedAt: at(d, s0), endedAt: at(d, s1), breakMin: 0, units: 1,
      source: 'manual', status, createdBy: owner.id, createdAt: at(d, s1), ...(status === 'approved' ? { reviewedBy: owner.id, reviewedAt: at(d, '17:00') } : {}),
    });
  }

  // ---- cover requests
  const nowMs = now.getTime();
  const used = new Set<string>();
  const upcoming = (staffId: string, afterHours: number) =>
    state.sessions.filter((s) => s.instructorId === staffId && s.status === 'scheduled' && Date.parse(s.startsAt) > nowMs + afterHours * HOUR && !used.has(s.id))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const post = (s: { id: string; instructorId: string }, extra: Partial<CoverRequest>, hoursAgo: number): void => {
    used.add(s.id);
    out.cover.push({
      id: newId('cv'), sessionId: s.id, requestedBy: s.instructorId, postedBy: s.instructorId, status: 'open', declinedBy: [],
      notified: eligibleStaff(state, s.instructorId).map((x) => x.id), createdAt: new Date(nowMs - hoursAgo * HOUR).toISOString(), ...extra,
    });
  };
  if (harbour) {
    const n = upcoming(ids.a, 56)[0];
    if (n) post(n, { reason: 'Away for a family wedding' }, 20);
  } else {
    const g = upcoming(ids.b, 30)[0]; // Grace T
    if (g) post(g, { reason: 'Dentist appointment I can’t move' }, 5);
    const j = upcoming(ids.a, 56)[0]; // Julia
    if (j) post(j, {}, 20);
    const c = upcoming(ids.a, 90)[0]; // Julia again: claimed by Grace P, waiting for Libby
    if (c) post(c, { reason: 'Sick little one at home', status: 'claimed', claimedBy: ids.desk, claimedAt: new Date(nowMs - 3 * HOUR).toISOString() }, 26);
  }
  // history: a class that really was covered, and (Snowy) one nobody could take
  const past = (staffId: string, minDays: number) =>
    state.sessions.filter((s) => s.instructorId === staffId && s.status === 'scheduled' && Date.parse(s.endsAt) < nowMs - minDays * DAY && !used.has(s.id))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const covered = past(ids.a, 5)[2];
  if (covered && st(ids.b)) {
    used.add(covered.id);
    covered.instructorId = ids.b;
    const t0 = Date.parse(covered.startsAt);
    out.cover.push({
      id: newId('cv'), sessionId: covered.id, requestedBy: ids.a, postedBy: ids.a, status: 'approved', claimedBy: ids.b, claimedAt: new Date(t0 - 4 * DAY).toISOString(),
      decidedAt: new Date(t0 - 4 * DAY + 30 * MIN).toISOString(), reason: 'Long weekend away', declinedBy: [], notified: eligibleStaff(state, ids.a).map((x) => x.id),
      createdAt: new Date(t0 - 5 * DAY).toISOString(), ...(harbour ? { autoApproved: true } : { decidedBy: owner.id }),
    });
  }
  const missed = harbour ? undefined : past(ids.b, 3)[0];
  if (missed) {
    out.cover.push({
      id: newId('cv'), sessionId: missed.id, requestedBy: ids.b, postedBy: ids.b, status: 'open', declinedBy: [], reason: 'Car trouble, back next week',
      notified: eligibleStaff(state, ids.b).map((x) => x.id), createdAt: new Date(Date.parse(missed.startsAt) - 20 * HOUR).toISOString(),
    });
  }

  // ---- Snowy: last-but-one week already paid, with one adjustment, saved as a snapshot
  if (!harbour && st(ids.desk)) {
    const range = { from: addDays(monday, -14), to: addDays(monday, -8) };
    out.adjustments.push({
      id: newId('adj'), periodFrom: range.from, periodTo: range.to, staffId: ids.desk, label: 'Reimbursement', amountCents: 4200,
      reason: 'Cleaning supplies bought for the studio', createdBy: owner.id, createdAt: at(addDays(range.to, 1), '09:00'),
    });
    const view = computeView(state, out, range, now);
    const paidAt = at(addDays(range.to, 2), '10:15');
    out.runs.push({
      id: newId('run'), ...range, paidAt, paidBy: owner.id, totalCents: view.totalCents,
      snapshot: { ...view, status: 'paid', snapshot: true, paidAt, paidBy: owner.id, inProgress: false },
    });
  }
  return out;
}

registerDemoFeature({
  name: 'payroll',
  seed: ({ studio, state, now, newId }) => seedSlice(studio, state, now, newId),
  create,
});
