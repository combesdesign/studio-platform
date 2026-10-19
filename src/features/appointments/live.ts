/**
 * Live (Supabase) implementation of AppointmentsStore.
 * Everything with rules is an RPC from supabase/migrations/1101_appointments_rpcs.sql (camelCase JSON back, so the mapping here
 * is light); availability, time off, settings and packs are plain selects under RLS (1100). Online payment goes through the
 * appointments-checkout edge function (1102 + supabase/functions/appointments-checkout).
 * tests/appointments-live-audit.test.ts checks every RPC and argument used here exists in the migrations.
 */
import './permissions';
import { registerLiveFeature, type LiveFeatureContext } from '../../data/supabase/features';
import { StoreError } from '../../shared/store';
import type { PaymentMethod, Sale } from '../../shared/types';
import type {
  Appointment, AppointmentCredit, AppointmentPack, AppointmentSettings, AppointmentSlot, AppointmentType, AppointmentsStore, AvailabilityRule,
  EventRegistration, StudioEvent, StudioEventSummary, TimeOff,
} from './types';
import { DEFAULT_SETTINGS } from './logic';

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const isoOf = (v: unknown): string => { const s = str(v); const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : s; };

/** A core sale row (app.sale_json: snake_case) -> Sale. */
export function toSale(v: unknown): Sale {
  const r = obj(v);
  const sale: Sale = {
    id: str(r.id), items: arr(r.items).map((i) => { const x = obj(i); return { name: str(x.name), qty: num(x.qty, 1), unitCents: num(x.unit_cents) }; }),
    totalCents: num(r.total_cents), method: str(r.method) as PaymentMethod, createdAt: isoOf(r.created_at),
  };
  if (r.client_id) sale.clientId = str(r.client_id);
  if (r.staff_id) sale.staffId = str(r.staff_id);
  if (r.stripe_payment_intent_id) sale.stripePaymentIntentId = str(r.stripe_payment_intent_id);
  if (r.refunded_at) sale.refundedAt = isoOf(r.refunded_at);
  if (num(r.refunded_cents)) sale.refundedCents = num(r.refunded_cents);
  if (r.note) sale.note = str(r.note);
  return sale;
}

// The RPCs already return camelCase; fill in the fields JSON drops when they're null.
const toType = (v: unknown): AppointmentType => { const r = obj(v); return { ...(r as unknown as AppointmentType), staffIds: arr(r.staffIds).map(str) }; };
const toPack = (v: unknown): AppointmentPack => {
  const r = obj(v);
  return { ...(r as unknown as AppointmentPack), validityDays: r.validityDays == null ? null : num(r.validityDays), typeIds: arr(r.typeIds).map(str) };
};
const toCredit = (v: unknown): AppointmentCredit => {
  const r = obj(v);
  return { ...(r as unknown as AppointmentCredit), validityDays: r.validityDays == null ? null : num(r.validityDays), typeIds: arr(r.typeIds).map(str) };
};
const toAppt = (v: unknown): Appointment => obj(v) as unknown as Appointment;
const toReg = (v: unknown): EventRegistration => { const r = obj(v); return { ...(r as unknown as EventRegistration), attended: arr(r.attended).map(str) }; };
const toEvent = (v: unknown): StudioEventSummary => {
  const r = obj(v);
  const e = { ...(r as unknown as StudioEventSummary), sessions: arr(r.sessions).map((s) => ({ startsAt: str(obj(s).startsAt), endsAt: str(obj(s).endsAt) })) };
  if (r.mine) e.mine = toReg(r.mine);
  return e;
};
const hhmm = (v: unknown) => str(v).slice(0, 5);

registerLiveFeature({ name: 'appointments', create: (ctx) => createStore(ctx) });

function createStore(ctx: LiveFeatureContext): AppointmentsStore {
  const rpc = (name: string, args: Row = {}) => ctx.rpc(name, args);

  return {
    getSettings: () => ctx.read(async () => {
      const [r] = await ctx.rows(ctx.sb.from('appointment_settings').select('slot_step_min, min_notice_hours, horizon_days').limit(1));
      return r ? { slotStepMin: num(r.slot_step_min), minNoticeHours: num(r.min_notice_hours), horizonDays: num(r.horizon_days) } : { ...DEFAULT_SETTINGS };
    }),
    updateSettings: (patch) => ctx.write(async () => {
      const cur = await (async () => {
        const [r] = await ctx.rows(ctx.sb.from('appointment_settings').select('slot_step_min, min_notice_hours, horizon_days').limit(1));
        return r ? { slotStepMin: num(r.slot_step_min), minNoticeHours: num(r.min_notice_hours), horizonDays: num(r.horizon_days) } : { ...DEFAULT_SETTINGS };
      })();
      const next: AppointmentSettings = { ...cur, ...patch };
      return (await rpc('appointments_update_settings', {
        p_slot_step_min: Math.round(next.slotStepMin), p_min_notice_hours: Math.round(next.minNoticeHours), p_horizon_days: Math.round(next.horizonDays),
      })) as AppointmentSettings;
    }),

    listTypes: (opts) => ctx.read(async () => arr(await rpc('appointments_list_types', { p_include_inactive: !!opts?.includeInactive })).map(toType)),
    upsertType: (t) => ctx.write(async () => toType(await rpc('appointments_upsert_type', { p: t }))),
    listPacks: (opts) => ctx.read(async () => {
      let q = ctx.sb.from('appointment_packs').select('id, name, description, credits, price_cents, validity_days, type_ids, active').order('price_cents');
      if (!opts?.includeInactive) q = q.eq('active', true);
      return (await ctx.rows(q)).map((r) => ({
        id: str(r.id), name: str(r.name), description: str(r.description), credits: num(r.credits), priceCents: num(r.price_cents),
        validityDays: r.validity_days == null ? null : num(r.validity_days), typeIds: arr(r.type_ids).map(str), active: !!r.active,
      }));
    }),
    upsertPack: (p) => ctx.write(async () => toPack(await rpc('appointments_upsert_pack', { p }))),

    listAvailability: (staffId) => ctx.read(async () => {
      let q = ctx.sb.from('appointment_availability').select('id, staff_id, weekday, start_time, end_time').order('weekday').order('start_time');
      if (staffId) q = q.eq('staff_id', staffId);
      return (await ctx.rows(q)).map((r): AvailabilityRule => ({ id: str(r.id), staffId: str(r.staff_id), weekday: num(r.weekday), start: hhmm(r.start_time), end: hhmm(r.end_time) }));
    }),
    setAvailability: (staffId, rules) => ctx.write(async () => arr(await rpc('appointments_set_availability', { p_staff_id: staffId, p_rules: rules })) as AvailabilityRule[]),
    listTimeOff: (staffId) => ctx.read(async () => {
      let q = ctx.sb.from('appointment_time_off').select('id, staff_id, starts_at, ends_at, note').order('starts_at');
      if (staffId) q = q.eq('staff_id', staffId);
      return (await ctx.rows(q)).map((r): TimeOff => ({
        id: str(r.id), staffId: str(r.staff_id), startsAt: isoOf(r.starts_at), endsAt: isoOf(r.ends_at), ...(r.note ? { note: str(r.note) } : {}),
      }));
    }),
    addTimeOff: (input) => ctx.write(async () => (await rpc('appointments_add_time_off', {
      p_staff_id: input.staffId, p_starts_at: input.startsAt, p_ends_at: input.endsAt, p_note: input.note ?? null,
    })) as TimeOff),
    removeTimeOff: (id) => ctx.write(async () => { await rpc('appointments_remove_time_off', { p_id: id }); }),

    listSlots: (q) => ctx.read(async () => arr(await rpc('appointments_list_slots', {
      p_type_id: q.typeId, p_from: q.from, p_to: q.to, p_staff_id: q.staffId ?? null,
    })) as AppointmentSlot[]),
    bookAppointment: (input) => ctx.write(async () => {
      const r = obj(await rpc('appointments_book', {
        p_type_id: input.typeId, p_staff_id: input.staffId, p_starts_at: input.startsAt, p_people: input.people ?? 1, p_client_id: input.clientId ?? null,
        p_note: input.note ?? null, p_method: input.pay.method, p_credit_id: input.pay.creditId ?? null,
      }));
      return { appointment: toAppt(r.appointment), ...(r.sale ? { sale: toSale(r.sale) } : {}) };
    }),
    cancelAppointment: (id, opts) => ctx.write(async () => {
      const r = obj(await rpc('appointments_cancel', { p_id: id, p_waive_penalty: !!opts?.waivePenalty }));
      return { appointment: toAppt(r.appointment), creditsReturned: num(r.creditsReturned), refundDue: !!r.refundDue, late: !!r.late };
    }),
    setAppointmentStatus: (id, status) => ctx.write(async () => toAppt(await rpc('appointments_set_status', { p_id: id, p_status: status }))),
    listAppointments: (q) => ctx.read(async () => arr(await rpc('appointments_list', {
      p_from: q?.from ?? null, p_to: q?.to ?? null, p_staff_id: q?.staffId ?? null, p_client_id: q?.clientId ?? null, p_include_cancelled: !!q?.includeCancelled,
    })).map(toAppt)),

    buyPack: (input) => ctx.write(async () => {
      const r = obj(await rpc('appointments_buy_pack', { p_pack_id: input.packId, p_client_id: input.clientId ?? null, p_method: input.method }));
      return { credit: toCredit(r.credit), sale: toSale(r.sale) };
    }),
    listCredits: (clientId, opts) => ctx.read(async () => arr(await rpc('appointments_list_credits', {
      p_client_id: clientId ?? null, p_include_inactive: !!opts?.includeInactive,
    })).map(toCredit)),

    listEvents: (opts) => ctx.read(async () => arr(await rpc('appointments_list_events', { p_include_past: !!opts?.includePast })).map(toEvent)),
    getEvent: (id) => ctx.read(async () => toEvent(await rpc('appointments_get_event', { p_id: id }))),
    upsertEvent: (e) => ctx.write(async () => toEvent(await rpc('appointments_upsert_event', { p: e })) as StudioEvent),
    cancelEvent: (id, reason) => ctx.write(async () => toEvent(await rpc('appointments_cancel_event', { p_id: id, p_reason: reason })) as StudioEvent),
    register: (input) => ctx.write(async () => {
      const r = obj(await rpc('appointments_register', { p_event_id: input.eventId, p_client_id: input.clientId ?? null, p_method: input.method }));
      return { registration: toReg(r.registration), ...(r.sale ? { sale: toSale(r.sale) } : {}) };
    }),
    cancelRegistration: (id, opts) => ctx.write(async () => {
      const r = obj(await rpc('appointments_cancel_registration', { p_id: id, p_waive_penalty: !!opts?.waivePenalty }));
      return { registration: toReg(r.registration), refundDue: !!r.refundDue, late: !!r.late };
    }),
    listRegistrations: (q) => ctx.read(async () => arr(await rpc('appointments_list_registrations', {
      p_client_id: 'clientId' in q ? q.clientId : null, p_event_id: 'eventId' in q ? q.eventId : null,
    })).map(toReg)),
    setAttendance: (registrationId, sessionStartsAt, present) => ctx.write(async () => toReg(await rpc('appointments_set_attendance', {
      p_registration_id: registrationId, p_session_starts_at: sessionStartsAt, p_present: present,
    }))),
    markRefunded: (target) => ctx.write(async () => {
      await rpc('appointments_mark_refunded', {
        p_appointment_id: 'appointmentId' in target ? target.appointmentId : null, p_registration_id: 'registrationId' in target ? target.registrationId : null,
      });
    }),

    // Holds the slot / place and returns a Stripe Checkout URL; the appointments-stripe-webhook completes it.
    startCheckout: (order) => ctx.write(async () => {
      let res: { data: unknown; error: unknown };
      try {
        res = await ctx.sb.functions.invoke('appointments-checkout', { body: { ...order, studioId: ctx.studioId } });
      } catch (e) {
        throw ctx.error('ERROR', e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      }
      if (res.error) {
        const c = obj(obj(res.error).context) as { json?: () => Promise<unknown> };
        let j: Row = {};
        if (typeof c.json === 'function') { try { j = obj(await c.json()); } catch { /* not JSON */ } }
        throw new StoreError(str(j.code) || 'ERROR', str(j.message) || 'We couldn’t start the payment. Please try again.');
      }
      const url = str(obj(res.data).url);
      if (!url) throw ctx.error('ERROR', 'We couldn’t start the payment. Please try again.');
      return { url };
    }),
  };
}

