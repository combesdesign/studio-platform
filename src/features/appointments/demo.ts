/**
 * Demo implementation of AppointmentsStore, plugged into the demo store (registerDemoFeature).
 * Data lives in the studio's demo state under features.appointments (persisted, synced across tabs, wiped by Reset demo).
 * Money goes through core Sales (state.sales), so receipts, refunds and the reports keep working; credits are our own records.
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import { can } from '../../domain/permissions';
import { StoreError } from '../../shared/store';
import { addDays, studioDate } from '../../shared/format';
import type { Client, ID, Sale, Staff } from '../../shared/types';
import type { DemoState } from '../../data/demo/engine';
import type {
  Appointment, AppointmentCredit, AppointmentPack, AppointmentPayMethod, AppointmentSettings, AppointmentType, AppointmentsStore, AvailabilityRule,
  BookAppointmentInput, EventRegistration, RegisterInput, StudioEvent, StudioEventSummary, TimeOff, WaitlistEntry,
} from './types';
import {
  DEFAULT_SETTINGS, HOUR_MS, allocateCredits, availabilityProblem, computeSlots, creditStatus, creditsLastUntil, eventEnd, eventProblem, eventStart, isLateCancel, moveProblem, planWaitlist,
} from './logic';
import { seedAppointments } from './seed';

// ---------------------------------------------------------------- stored shapes

export type StoredCredit = Omit<AppointmentCredit, 'remaining' | 'status'>;
export type StoredAppointment = Omit<Appointment, 'staffName' | 'clientName'>;
export type StoredRegistration = Omit<EventRegistration, 'clientName' | 'eventTitle' | 'eventKind' | 'startsAt'>;
export type StoredWaitlist = Omit<WaitlistEntry, 'clientName' | 'eventTitle' | 'position'>;

export interface Slice {
  settings: AppointmentSettings;
  types: AppointmentType[];
  packs: AppointmentPack[];
  credits: StoredCredit[];
  availability: AvailabilityRule[];
  timeOff: TimeOff[];
  appointments: StoredAppointment[];
  events: StudioEvent[];
  registrations: StoredRegistration[];
  /** Event waitlists (added after the first demos: may be missing). */
  waitlist?: StoredWaitlist[];
  /** Emails the live system would send (confirmations, cancellations, waitlist offers); the demo just records them, newest last, capped. */
  outbox?: { at: string; clientId: ID; kind: 'appointment_confirmed' | 'appointment_cancelled' | 'appointment_moved' | 'event_registered' | 'event_cancelled' | 'waitlist_offer'; text: string }[];
}

const err = (code: string, message: string) => new StoreError(code, message);

registerDemoFeature({
  name: 'appointments',
  seed: ({ studio, state, now, newId }) => seedAppointments(studio, state, now, newId),
  create: (ctx) => createStore(ctx),
});

function createStore(ctx: DemoFeatureContext): AppointmentsStore {
  /** The slice, topped up with the seed the first time a demo that predates this feature opens it. */
  const S = (): Slice => {
    const s = ctx.slice<Partial<Slice>>();
    if (!s.types) Object.assign(s, seedAppointments(ctx.studio(), ctx.core().state, ctx.now(), ctx.newId));
    return s as Slice;
  };
  const core = (): DemoState => ctx.core().state;
  const staffOf = (id: ID): Staff | undefined => core().staff.find((x) => x.id === id);
  const clientOf = (id: ID): Client | undefined => core().clients.find((x) => x.id === id);
  const fullName = (c?: Client) => (c ? `${c.firstName} ${c.lastName}`.trim() : 'Client');
  const cancelWindow = () => core().settings.cancelWindowHours;
  const settings = (): AppointmentSettings => ({ ...DEFAULT_SETTINGS, ...S().settings });

  type Who = { kind: 'client'; clientId: ID } | { kind: 'staff'; staff: Staff };
  const who = (): Who => {
    const u = ctx.me();
    if (u.kind === 'client') return { kind: 'client', clientId: u.clientId };
    const staff = staffOf(u.staffId);
    if (!staff) throw err('AUTH_REQUIRED', 'Please sign in first.');
    return { kind: 'staff', staff };
  };
  /** Family accounts: a client may act for their dependants (clients with guardianClientId = them). */
  const guardianOf = (id: ID): ID | undefined => clientOf(id)?.guardianClientId;
  const familyOf = (clientId: ID): ID[] => [clientId, ...core().clients.filter((c) => c.guardianClientId === clientId && !c.archived).map((c) => c.id)];
  const requireView = (): Staff => ctx.requireStaff('appointments.view');

  // ------------------------------------------------------------ decorate
  const dec = (a: StoredAppointment): Appointment => ({ ...a, staffName: staffOf(a.staffId)?.name ?? 'Instructor', clientName: fullName(clientOf(a.clientId)) });
  const decCredit = (c: StoredCredit): AppointmentCredit => ({ ...c, remaining: c.credits - c.used, status: creditStatus(c, ctx.now()) });
  const decReg = (r: StoredRegistration): EventRegistration => {
    const e = S().events.find((x) => x.id === r.eventId);
    return { ...r, clientName: fullName(clientOf(r.clientId)), eventTitle: e?.title ?? 'Event', eventKind: e?.kind ?? 'event', startsAt: e ? eventStart(e) : r.createdAt };
  };
  const registeredCount = (eventId: ID) => S().registrations.filter((r) => r.eventId === eventId && r.status === 'registered').length;

  // ------------------------------------------------------------ waitlist
  const waitlist = (): StoredWaitlist[] => (S().waitlist ??= []);
  const inLine = (eventId: ID) => waitlist().filter((w) => w.eventId === eventId && (w.status === 'waiting' || w.status === 'offered'))
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
  const decWait = (w: StoredWaitlist): WaitlistEntry => ({
    ...w, clientName: fullName(clientOf(w.clientId)), eventTitle: S().events.find((x) => x.id === w.eventId)?.title ?? 'Event',
    position: Math.max(1, inLine(w.eventId).findIndex((x) => x.id === w.id) + 1),
  });
  /** Places held by live offers, not counting `except`'s own (their place is theirs to take). */
  const heldOffers = (eventId: ID, except?: ID) =>
    inLine(eventId).filter((w) => w.status === 'offered' && w.clientId !== except && Date.parse(w.offerExpiresAt ?? '') > ctx.now().getTime()).length;
  const spotsFree = (e: StudioEvent, forClient?: ID) => Math.max(0, e.capacity - registeredCount(e.id) - heldOffers(e.id, forClient));
  /**
   * Let lapsed offers go and offer free places to whoever is next (same rules as app.ap_waitlist_advance in SQL). Runs whenever
   * places can have opened (cancelling, more capacity, time passing). Emails are only recorded in the demo.
   */
  const advance = (eventId: ID): void => {
    const e = S().events.find((x) => x.id === eventId);
    const line = inLine(eventId);
    if (!e || !line.length) return;
    const now = ctx.now();
    const plan = planWaitlist({
      line: line.map((w) => ({ id: w.id, status: w.status as 'waiting' | 'offered', joinedAt: w.joinedAt, ...(w.offerExpiresAt ? { offerExpiresAt: w.offerExpiresAt } : {}) })),
      capacity: e.capacity, taken: registeredCount(e.id), now, claimHours: settings().waitlistClaimHours, eventStart: eventStart(e),
      open: !e.cancelled && now.toISOString() < eventStart(e),
    });
    for (const id of plan.expire) { const w = line.find((x) => x.id === id)!; w.status = 'expired'; delete w.offerExpiresAt; }
    for (const o of plan.offer) {
      const w = line.find((x) => x.id === o.id)!;
      w.status = 'offered'; w.offeredAt = now.toISOString(); w.offerExpiresAt = o.expiresAt;
      queueEmail(w.clientId, 'waitlist_offer', `A place opened up in ${e.title}. It’s yours until ${o.expiresAt}`);
    }
  };
  const advanceAll = () => { for (const id of new Set(waitlist().map((w) => w.eventId))) advance(id); };
  const summary = (e: StudioEvent, clientId?: ID): StudioEventSummary => {
    advance(e.id);
    const registered = registeredCount(e.id);
    const mine = clientId ? S().registrations.find((r) => r.eventId === e.id && r.clientId === clientId && r.status === 'registered') : undefined;
    const line = clientId ? inLine(e.id).find((w) => w.clientId === clientId) : undefined;
    return {
      ...e, registered, spotsLeft: spotsFree(e), waitlisted: inLine(e.id).length,
      ...(mine ? { mine: decReg(mine) } : {}), ...(line ? { myWaitlist: decWait(line) } : {}),
    };
  };

  // ------------------------------------------------------------ emails (recorded only: the live outbox sends them)
  const queueEmail = (clientId: ID, kind: NonNullable<Slice['outbox']>[number]['kind'], text: string) => {
    const box = (S().outbox ??= []);
    box.push({ at: ctx.now().toISOString(), clientId, kind, text });
    if (box.length > 100) box.splice(0, box.length - 100);
  };

  // ------------------------------------------------------------ money
  const recordSale = (a: { clientId: ID; name: string; qty: number; unitCents: number; method: AppointmentPayMethod; staffId?: ID; note: string }): Sale => {
    const sale: Sale = {
      id: ctx.newId('sa'), clientId: a.clientId, items: [{ name: a.name, qty: a.qty, unitCents: a.unitCents }],
      totalCents: a.method === 'comp' ? 0 : a.qty * a.unitCents, method: a.method === 'pack' ? 'comp' : a.method, createdAt: ctx.now().toISOString(), note: a.note,
      ...(a.staffId ? { staffId: a.staffId } : {}),
    };
    core().sales.push(sale);
    return sale;
  };
  /** Who may pay with what: clients pay online by card (or with credits); the front desk takes cards at the till, cash or comps. */
  const checkMethod = (w: Who, method: AppointmentPayMethod, allowPack: boolean): void => {
    if (method === 'pack' && !allowPack) throw err('INVALID', 'Pack credits can’t be used for that.');
    if (w.kind === 'client') {
      if (method !== 'card_online' && method !== 'pack') throw err('NOT_ALLOWED', 'Online bookings are paid by card or with your credits.');
    } else if (method === 'card_online') throw err('NOT_ALLOWED', 'Take card payments at the till (card reader).');
  };
  const requireWaiver = (clientId: ID, w: Who) => {
    if (w.kind === 'staff') return;
    if (!clientOf(clientId)?.waiverSignedAt) throw err('WAIVER_REQUIRED', 'Please complete your waiver and health form before booking.');
  };
  /** The booker: a client books for themselves; the front desk books for a client. */
  const booker = (w: Who, clientId?: ID, what = 'book'): { clientId: ID; staffId?: ID } => {
    if (w.kind === 'client') {
      if (clientId && clientId !== w.clientId && guardianOf(clientId) !== w.clientId) throw err('NOT_ALLOWED', `You can only ${what} for yourself and your family.`);
      return { clientId: clientId ?? w.clientId };
    }
    ctx.requireStaff('appointments.book');
    if (!clientId) throw err('INVALID', 'Choose a client.');
    if (!clientOf(clientId)) throw err('NOT_FOUND', 'We couldn’t find that client.');
    return { clientId, staffId: w.staff.id };
  };

  return {
    // ---------------------------------------------------------- settings
    getSettings: () => ctx.read(() => { ctx.me(); return settings(); }),
    updateSettings: (patch) => ctx.write(() => {
      ctx.requireStaff('appointments.manage');
      const next = { ...settings(), ...patch };
      if (!(next.slotStepMin >= 5 && next.slotStepMin <= 120)) throw err('INVALID', 'Slots can start every 5 to 120 minutes.');
      if (!(next.minNoticeHours >= 0 && next.minNoticeHours <= 336)) throw err('INVALID', 'Minimum notice can be 0 to 336 hours.');
      if (!(next.horizonDays >= 1 && next.horizonDays <= 365)) throw err('INVALID', 'Clients can book 1 to 365 days ahead.');
      if (!(next.waitlistClaimHours >= 1 && next.waitlistClaimHours <= 72)) throw err('INVALID', 'A waitlist offer can be open for 1 to 72 hours.');
      S().settings = {
        slotStepMin: Math.round(next.slotStepMin), minNoticeHours: Math.round(next.minNoticeHours), horizonDays: Math.round(next.horizonDays),
        waitlistClaimHours: Math.round(next.waitlistClaimHours),
      };
      return S().settings;
    }),

    // ---------------------------------------------------------- catalogue
    listTypes: (opts) => ctx.read(() => {
      const w = who();
      return S().types.filter((t) => t.active || (w.kind === 'staff' && opts?.includeInactive))
        .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || a.name.localeCompare(b.name));
    }),
    upsertType: (input) => ctx.write(() => {
      ctx.requireStaff('appointments.manage');
      const name = input.name.trim();
      if (!name) throw err('INVALID', 'Give the session a name.');
      if (!(input.durationMin >= 5 && input.durationMin <= 480)) throw err('INVALID', 'Sessions run 5 to 480 minutes.');
      if (!(input.priceCents >= 0)) throw err('INVALID', 'The price can’t be negative.');
      if (input.capacity !== 1 && input.capacity !== 2) throw err('INVALID', 'A session is for 1 or 2 people.');
      if (!(input.bufferMin >= 0 && input.bufferMin <= 120)) throw err('INVALID', 'Buffer time can be 0 to 120 minutes.');
      const staffIds = [...new Set(input.staffIds)].filter((id) => staffOf(id)?.active);
      const t: AppointmentType = { ...input, id: input.id ?? ctx.newId('aty'), name, staffIds, durationMin: Math.round(input.durationMin), bufferMin: Math.round(input.bufferMin) };
      const list = S().types;
      const i = list.findIndex((x) => x.id === t.id);
      if (i >= 0) list[i] = t; else list.push(t);
      return t;
    }),
    listPacks: (opts) => ctx.read(() => {
      const w = who();
      return S().packs.filter((p) => p.active || (w.kind === 'staff' && opts?.includeInactive)).sort((a, b) => a.priceCents - b.priceCents);
    }),
    upsertPack: (input) => ctx.write(() => {
      ctx.requireStaff('appointments.manage');
      const name = input.name.trim();
      if (!name) throw err('INVALID', 'Give the pack a name.');
      if (!(Number.isInteger(input.credits) && input.credits >= 1)) throw err('INVALID', 'A pack needs at least one credit.');
      if (!(input.priceCents >= 0)) throw err('INVALID', 'The price can’t be negative.');
      if (input.validityDays != null && !(input.validityDays >= 1)) throw err('INVALID', 'Packs last at least a day (or leave it blank for no expiry).');
      const p: AppointmentPack = { ...input, id: input.id ?? ctx.newId('apk'), name, typeIds: input.typeIds.filter((id) => S().types.some((t) => t.id === id)) };
      const list = S().packs;
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) list[i] = p; else list.push(p);
      return p;
    }),

    // ---------------------------------------------------------- hours and time off
    listAvailability: (staffId) => ctx.read(() => { requireView(); return S().availability.filter((r) => !staffId || r.staffId === staffId); }),
    setAvailability: (staffId, rules) => ctx.write(() => {
      const me = ctx.requireStaff('appointments.own');
      if (me.id !== staffId && !can(me.role, 'appointments.manage')) throw err('NOT_ALLOWED', 'You can only change your own hours.');
      if (!staffOf(staffId)) throw err('NOT_FOUND', 'We couldn’t find that person.');
      const problem = availabilityProblem(rules);
      if (problem) throw err('INVALID', problem);
      const s = S();
      s.availability = s.availability.filter((r) => r.staffId !== staffId);
      const made = rules.map((r) => ({ id: ctx.newId('aav'), staffId, weekday: r.weekday, start: r.start, end: r.end }));
      s.availability.push(...made);
      return made;
    }),
    listTimeOff: (staffId) => ctx.read(() => { requireView(); return S().timeOff.filter((t) => !staffId || t.staffId === staffId).sort((a, b) => a.startsAt.localeCompare(b.startsAt)); }),
    addTimeOff: (input) => ctx.write(() => {
      const me = ctx.requireStaff('appointments.own');
      if (me.id !== input.staffId && !can(me.role, 'appointments.manage')) throw err('NOT_ALLOWED', 'You can only change your own time off.');
      if (!staffOf(input.staffId)) throw err('NOT_FOUND', 'We couldn’t find that person.');
      if (!(Date.parse(input.endsAt) > Date.parse(input.startsAt))) throw err('INVALID', 'Time off needs to finish after it starts.');
      const t: TimeOff = { id: ctx.newId('ato'), staffId: input.staffId, startsAt: input.startsAt, endsAt: input.endsAt, ...(input.note?.trim() ? { note: input.note.trim() } : {}) };
      S().timeOff.push(t);
      return t;
    }),
    removeTimeOff: (id) => ctx.write(() => {
      const me = ctx.requireStaff('appointments.own');
      const t = S().timeOff.find((x) => x.id === id);
      if (!t) return;
      if (me.id !== t.staffId && !can(me.role, 'appointments.manage')) throw err('NOT_ALLOWED', 'You can only change your own time off.');
      S().timeOff = S().timeOff.filter((x) => x.id !== id);
    }),

    // ---------------------------------------------------------- slots and booking
    listSlots: (q) => ctx.read(() => {
      const w = who();
      const type = S().types.find((t) => t.id === q.typeId);
      if (!type || (!type.active && w.kind === 'client')) throw err('NOT_FOUND', 'We couldn’t find that session.');
      if (q.to < q.from) return [];
      const to = q.to > addDays(q.from, 62) ? addDays(q.from, 62) : q.to;
      return computeSlots({
        type, rules: S().availability, timeOff: S().timeOff, appointments: S().appointments.filter((a) => a.id !== q.excludeAppointmentId), sessions: core().sessions,
        settings: settings(), now: ctx.now(), from: q.from, to, ...(q.staffId ? { staffId: q.staffId } : {}), asStaff: w.kind === 'staff',
      });
    }),

    bookAppointment: (input: BookAppointmentInput) => ctx.write(() => {
      const w = who();
      const { clientId, staffId } = booker(w, input.clientId);
      const type = S().types.find((t) => t.id === input.typeId);
      if (!type || (!type.active && w.kind === 'client')) throw err('NOT_FOUND', 'We couldn’t find that session.');
      const people = input.people ?? 1;
      if (!Number.isInteger(people) || people < 1 || people > type.capacity) throw err('INVALID', type.capacity === 1 ? 'This is a one-to-one session.' : `This session takes up to ${type.capacity} people.`);
      requireWaiver(clientId, w);
      checkMethod(w, input.pay.method, true);

      const startsAt = new Date(input.startsAt).toISOString();
      const day = studioDate(new Date(startsAt));
      const open = computeSlots({
        type, rules: S().availability, timeOff: S().timeOff, appointments: S().appointments, sessions: core().sessions,
        settings: settings(), now: ctx.now(), from: day, to: day, staffId: input.staffId, asStaff: w.kind === 'staff',
      }).find((s) => s.startsAt === startsAt);
      if (!open) throw err('SLOT_TAKEN', 'That time isn’t available any more. Please pick another.');
      if (S().appointments.some((a) => a.clientId === clientId && a.status === 'booked' && a.startsAt === startsAt)) throw err('ALREADY_BOOKED', 'You already have a session at that time.');

      const now = ctx.now();
      let payment: Appointment['payment'];
      let sale: Sale | undefined;
      if (input.pay.method === 'pack') {
        const uses = allocateCredits(S().credits.filter((c) => c.clientId === clientId).map(decCredit), type.id, people, new Date(startsAt), input.pay.creditId);
        if (!uses) throw err('NO_CREDITS', people > 1 ? `You need ${people} credits for this session.` : 'You don’t have a credit for this session.');
        for (const u of uses) {
          const c = S().credits.find((x) => x.id === u.creditId)!;
          c.used += u.n;
          if (!c.activatedAt) {
            c.activatedAt = now.toISOString();
            c.expiresAt = c.validityDays ? new Date(now.getTime() + c.validityDays * 24 * HOUR_MS).toISOString() : null;
          }
        }
        payment = { method: 'pack', amountCents: 0, credits: uses };
      } else {
        sale = recordSale({
          clientId, name: people === 2 ? `${type.name} (2 people)` : type.name, qty: people, unitCents: type.priceCents, method: input.pay.method,
          ...(staffId ? { staffId } : {}), note: 'Appointment',
        });
        payment = { method: input.pay.method, amountCents: sale.totalCents, saleId: sale.id };
      }
      const appt: StoredAppointment = {
        id: ctx.newId('apt'), typeId: type.id, typeName: type.name, staffId: input.staffId, clientId, people, startsAt, endsAt: open.endsAt, bufferMin: type.bufferMin,
        status: 'booked', payment, source: w.kind === 'client' ? 'client' : 'staff', createdAt: now.toISOString(),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}), ...(staffId ? { bookedByStaffId: staffId } : {}),
      };
      S().appointments.push(appt);
      queueEmail(clientId, 'appointment_confirmed', `${type.name} confirmed`);
      return { appointment: dec(appt), ...(sale ? { sale } : {}) };
    }),

    cancelAppointment: (id, opts) => ctx.write(() => {
      const w = who();
      const a = S().appointments.find((x) => x.id === id);
      if (!a) throw err('NOT_FOUND', 'We couldn’t find that appointment.');
      if (w.kind === 'client') {
        if (a.clientId !== w.clientId && guardianOf(a.clientId) !== w.clientId) throw err('NOT_FOUND', 'We couldn’t find that appointment.');
        if (opts?.waivePenalty) throw err('NOT_ALLOWED', 'Only staff can waive the cancellation policy.');
      } else ctx.requireStaff('appointments.book');
      if (a.status !== 'booked') throw err('INVALID', 'This appointment can’t be cancelled.');
      const now = ctx.now();
      if (w.kind === 'client' && now.getTime() >= Date.parse(a.startsAt)) throw err('TOO_LATE', 'This session has already started.');
      const late = isLateCancel(a.startsAt, now, cancelWindow()) && !opts?.waivePenalty;
      a.cancelledAt = now.toISOString();
      let creditsReturned = 0, refundDue = false;
      if (late) a.status = 'late_cancelled';
      else {
        a.status = 'cancelled';
        if (a.payment.method === 'pack') {
          for (const u of a.payment.credits ?? []) {
            const c = S().credits.find((x) => x.id === u.creditId);
            if (c) c.used = Math.max(0, c.used - u.n);
            creditsReturned += u.n;
          }
        } else if (a.payment.amountCents > 0) { refundDue = true; a.refundDue = true; }
      }
      queueEmail(a.clientId, 'appointment_cancelled', `${a.typeName} cancelled${late ? ' (late)' : ''}`);
      return { appointment: dec(a), creditsReturned, refundDue, late };
    }),

    moveAppointment: (id, to) => ctx.write(() => {
      const w = who();
      const a = S().appointments.find((x) => x.id === id);
      if (!a) throw err('NOT_FOUND', 'We couldn’t find that appointment.');
      if (w.kind === 'client') {
        if (a.clientId !== w.clientId && guardianOf(a.clientId) !== w.clientId) throw err('NOT_FOUND', 'We couldn’t find that appointment.');
      } else ctx.requireStaff('appointments.book');
      const now = ctx.now();
      const problem = moveProblem(a, now, cancelWindow(), w.kind === 'staff');
      if (problem) throw err(problem.code, problem.message);
      const type = S().types.find((t) => t.id === a.typeId);
      if (!type || (!type.active && w.kind === 'client')) throw err('NOT_FOUND', 'We couldn’t find that session.');
      const staffId = to.staffId ?? a.staffId;
      const startsAt = new Date(to.startsAt).toISOString();
      if (staffId === a.staffId && startsAt === a.startsAt) throw err('INVALID', 'That is the time you already have.');
      const day = studioDate(new Date(startsAt));
      const open = computeSlots({
        type, rules: S().availability, timeOff: S().timeOff, appointments: S().appointments.filter((x) => x.id !== a.id), sessions: core().sessions,
        settings: settings(), now, from: day, to: day, staffId, asStaff: w.kind === 'staff',
      }).find((s) => s.startsAt === startsAt);
      if (!open) throw err('SLOT_TAKEN', 'That time isn’t available any more. Please pick another.');
      if (S().appointments.some((x) => x.id !== a.id && x.clientId === a.clientId && x.status === 'booked' && x.startsAt === startsAt)) throw err('ALREADY_BOOKED', 'You already have a session at that time.');
      if (a.payment.method === 'pack' && !creditsLastUntil(a.payment.credits ?? [], S().credits.map(decCredit), startsAt)) {
        throw err('CREDIT_EXPIRES', 'Your pack runs out before that time. Please pick an earlier one.');
      }
      // the same appointment, a new time: payment, credits and history stay as they were
      a.startsAt = startsAt; a.endsAt = open.endsAt; a.staffId = staffId; a.bufferMin = type.bufferMin;
      queueEmail(a.clientId, 'appointment_moved', `${a.typeName} moved to ${startsAt}`);
      return dec(a);
    }),

    setAppointmentStatus: (id, status) => ctx.write(() => {
      const me = ctx.requireStaff('appointments.own');
      const a = S().appointments.find((x) => x.id === id);
      if (!a) throw err('NOT_FOUND', 'We couldn’t find that appointment.');
      if (!can(me.role, 'appointments.book') && a.staffId !== me.id) throw err('NOT_ALLOWED', 'You can only update your own sessions.');
      if (a.status !== 'booked' && a.status !== 'completed' && a.status !== 'no_show') throw err('INVALID', 'This appointment was cancelled.');
      if (status !== 'booked' && ctx.now().getTime() < Date.parse(a.startsAt)) throw err('INVALID', 'You can mark it once the session has started.');
      a.status = status;
      return dec(a);
    }),

    listAppointments: (q) => ctx.read(() => {
      const w = who();
      let staffId = q?.staffId, clientId = q?.clientId;
      const family = w.kind === 'client' ? familyOf(w.clientId) : undefined;   // a parent sees their dependants' sessions too
      if (w.kind === 'client') clientId = undefined;
      else {
        const me = requireView();
        if (!can(me.role, 'appointments.book')) staffId = me.id; // instructors: their own sessions only
      }
      return S().appointments
        .filter((a) => a.status !== 'pending_payment' && (q?.includeCancelled || (a.status !== 'cancelled' && a.status !== 'late_cancelled'))
          && (!staffId || a.staffId === staffId) && (!clientId || a.clientId === clientId) && (!family || family.includes(a.clientId))
          && (!q?.from || a.startsAt >= q.from) && (!q?.to || a.startsAt < q.to))
        .sort((x, y) => x.startsAt.localeCompare(y.startsAt)).map(dec);
    }),

    // ---------------------------------------------------------- packs
    buyPack: (input) => ctx.write(() => {
      const w = who();
      const { clientId, staffId } = booker(w, input.clientId, 'buy');
      checkMethod(w, input.method, false);
      const pack = S().packs.find((p) => p.id === input.packId);
      if (!pack || !pack.active) throw err('NOT_FOUND', 'That pack isn’t available.');
      const sale = recordSale({ clientId, name: pack.name, qty: 1, unitCents: pack.priceCents, method: input.method, ...(staffId ? { staffId } : {}), note: 'Appointment pack' });
      const c: StoredCredit = {
        id: ctx.newId('acr'), clientId, packId: pack.id, name: pack.name, credits: pack.credits, used: 0, validityDays: pack.validityDays, typeIds: [...pack.typeIds],
        purchasedAt: ctx.now().toISOString(), saleId: sale.id,
      };
      S().credits.push(c);
      return { credit: decCredit(c), sale };
    }),
    listCredits: (clientId, opts) => ctx.read(() => {
      const w = who();
      let id = clientId;
      if (w.kind === 'client') id = clientId && guardianOf(clientId) === w.clientId ? clientId : w.clientId; else requireView();
      if (!id) throw err('INVALID', 'Choose a client.');
      return S().credits.filter((c) => c.clientId === id).map(decCredit)
        .filter((c) => opts?.includeInactive || c.status === 'active')
        .sort((a, b) => a.purchasedAt.localeCompare(b.purchasedAt));
    }),

    // ---------------------------------------------------------- events
    listEvents: (opts) => ctx.read(() => {
      const w = who();
      const nowIso = ctx.now().toISOString();
      if (w.kind === 'client') {
        return S().events.filter((e) => e.published && !e.cancelled && eventEnd(e) > nowIso)
          .sort((a, b) => eventStart(a).localeCompare(eventStart(b))).map((e) => summary(e, w.clientId));
      }
      requireView();
      const past = !!opts?.includePast;
      return S().events.filter((e) => past || eventEnd(e) > nowIso)
        .sort((a, b) => (past ? eventStart(b).localeCompare(eventStart(a)) : eventStart(a).localeCompare(eventStart(b)))).map((e) => summary(e));
    }),
    getEvent: (id) => ctx.read(() => {
      const w = who();
      const e = S().events.find((x) => x.id === id);
      if (!e || (w.kind === 'client' && !e.published)) throw err('NOT_FOUND', 'We couldn’t find that event.');
      if (w.kind === 'staff') requireView();
      return summary(e, w.kind === 'client' ? w.clientId : undefined);
    }),
    upsertEvent: (input) => ctx.write(() => {
      ctx.requireStaff('appointments.manage');
      const sessions = [...input.sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const problem = eventProblem({ ...input, sessions });
      if (problem) throw err('INVALID', problem);
      if (input.kind !== 'course' && sessions.length > 1) throw err('INVALID', 'Workshops and events are a single date. Choose “Course” for several dates.');
      if (input.hostStaffId && !staffOf(input.hostStaffId)) throw err('NOT_FOUND', 'We couldn’t find that host.');
      const existing = input.id ? S().events.find((e) => e.id === input.id) : undefined;
      if (input.id && !existing) throw err('NOT_FOUND', 'We couldn’t find that event.');
      if (existing && input.capacity < registeredCount(existing.id)) throw err('INVALID', `${registeredCount(existing.id)} people are registered, so capacity can’t go below that.`);
      const e: StudioEvent = {
        ...(existing ?? {}), ...input, id: existing?.id ?? ctx.newId('aev'), title: input.title.trim(), sessions,
        description: input.description ?? '', createdAt: existing?.createdAt ?? ctx.now().toISOString(),
      };
      const list = S().events;
      const i = list.findIndex((x) => x.id === e.id);
      if (i >= 0) list[i] = e; else list.push(e);
      advance(e.id);   // more places than before? offer them
      return e;
    }),
    cancelEvent: (id, reason) => ctx.write(() => {
      ctx.requireStaff('appointments.manage');
      const e = S().events.find((x) => x.id === id);
      if (!e) throw err('NOT_FOUND', 'We couldn’t find that event.');
      e.cancelled = true; e.published = false; e.cancelReason = reason.trim() || 'Cancelled by the studio';
      const now = ctx.now().toISOString();
      for (const r of S().registrations.filter((x) => x.eventId === id && x.status === 'registered')) {
        r.status = 'cancelled'; r.cancelledAt = now;
        if (r.payment.amountCents > 0) r.refundDue = true;
        queueEmail(r.clientId, 'event_cancelled', `${e.title} cancelled by the studio`);
      }
      advance(e.id);   // the line is let go
      return e;
    }),
    register: (input: RegisterInput) => ctx.write(() => {
      const w = who();
      const { clientId, staffId } = booker(w, input.clientId, 'register');
      const e = S().events.find((x) => x.id === input.eventId);
      if (!e || e.cancelled || (w.kind === 'client' && !e.published)) throw err('NOT_FOUND', 'We couldn’t find that event.');
      const now = ctx.now();
      if (w.kind === 'client' && now.toISOString() >= eventStart(e)) throw err('TOO_LATE', 'Sign-up closed when it started.');
      if (now.toISOString() >= eventEnd(e)) throw err('TOO_LATE', 'That one has finished.');
      if (S().registrations.some((r) => r.eventId === e.id && r.clientId === clientId && r.status === 'registered')) throw err('ALREADY_BOOKED', 'You’re already registered.');
      advance(e.id);
      if (spotsFree(e, clientId) <= 0) throw err('EVENT_FULL', 'Sorry, that one is full.');
      requireWaiver(clientId, w);
      const free = e.priceCents === 0;
      const method: AppointmentPayMethod = free ? 'comp' : input.method;
      let sale: Sale | undefined;
      if (!free) {
        checkMethod(w, method, false);
        sale = recordSale({ clientId, name: e.title, qty: 1, unitCents: e.priceCents, method, ...(staffId ? { staffId } : {}), note: e.kind === 'course' ? 'Course' : 'Workshop / event' });
      }
      const r: StoredRegistration = {
        id: ctx.newId('arg'), eventId: e.id, clientId, status: 'registered', createdAt: now.toISOString(), attended: [],
        payment: { method, amountCents: sale?.totalCents ?? 0, ...(sale ? { saleId: sale.id } : {}) },
      };
      S().registrations.push(r);
      // a place taken from the waitlist (or any other way) ends their turn in line
      for (const x of inLine(e.id).filter((y) => y.clientId === clientId)) { x.status = 'claimed'; delete x.offerExpiresAt; }
      queueEmail(clientId, 'event_registered', `${e.title} confirmed`);
      return { registration: decReg(r), ...(sale ? { sale } : {}) };
    }),
    cancelRegistration: (id, opts) => ctx.write(() => {
      const w = who();
      const r = S().registrations.find((x) => x.id === id);
      const e = r && S().events.find((x) => x.id === r.eventId);
      if (!r || !e) throw err('NOT_FOUND', 'We couldn’t find that registration.');
      if (w.kind === 'client') {
        if (r.clientId !== w.clientId && guardianOf(r.clientId) !== w.clientId) throw err('NOT_FOUND', 'We couldn’t find that registration.');
        if (opts?.waivePenalty) throw err('NOT_ALLOWED', 'Only staff can waive the cancellation policy.');
      } else ctx.requireStaff('appointments.book');
      if (r.status !== 'registered') throw err('INVALID', 'This registration can’t be cancelled.');
      const now = ctx.now();
      if (w.kind === 'client' && now.toISOString() >= eventStart(e)) throw err('TOO_LATE', 'It has already started.');
      const late = isLateCancel(eventStart(e), now, e.refundCutoffHours) && !opts?.waivePenalty;
      r.cancelledAt = now.toISOString();
      r.status = late ? 'late_cancelled' : 'cancelled';
      const refundDue = !late && r.payment.amountCents > 0;
      if (refundDue) r.refundDue = true;
      queueEmail(r.clientId, 'event_cancelled', `${e.title} cancelled${late ? ' (late)' : ''}`);
      advance(e.id);   // the place goes to the next person in line
      return { registration: decReg(r), refundDue, late };
    }),
    listRegistrations: (q) => ctx.read(() => {
      const w = who();
      let rows: StoredRegistration[];
      if ('clientId' in q) {
        if (w.kind === 'client') { if (q.clientId !== w.clientId && guardianOf(q.clientId) !== w.clientId) throw err('NOT_ALLOWED', 'You can only see your own sign-ups.'); }
        else requireView();
        // asking for your own sign-ups includes your dependants'
        const ids = w.kind === 'client' && q.clientId === w.clientId ? familyOf(w.clientId) : [q.clientId];
        rows = S().registrations.filter((r) => ids.includes(r.clientId));
      } else {
        if (w.kind === 'client') throw err('NOT_ALLOWED', 'Only staff can see attendee lists.');
        const e = S().events.find((x) => x.id === q.eventId);
        if (!e) throw err('NOT_FOUND', 'We couldn’t find that event.');
        const me = requireView();
        if (!can(me.role, 'appointments.book') && e.hostStaffId !== me.id) throw err('NOT_ALLOWED', 'Only the host and the front desk can see who’s coming.');
        rows = S().registrations.filter((r) => r.eventId === q.eventId);
      }
      return rows.map(decReg).sort((a, b) => a.clientName.localeCompare(b.clientName));
    }),
    setAttendance: (registrationId, sessionStartsAt, present) => ctx.write(() => {
      const me = ctx.requireStaff('appointments.view');
      const r = S().registrations.find((x) => x.id === registrationId);
      const e = r && S().events.find((x) => x.id === r.eventId);
      if (!r || !e) throw err('NOT_FOUND', 'We couldn’t find that registration.');
      if (!can(me.role, 'appointments.book') && e.hostStaffId !== me.id) throw err('NOT_ALLOWED', 'Only the host and the front desk can take attendance.');
      if (!e.sessions.some((s) => s.startsAt === sessionStartsAt)) throw err('INVALID', 'That isn’t one of the dates.');
      if (r.status !== 'registered') throw err('INVALID', 'This registration was cancelled.');
      r.attended = present ? [...new Set([...r.attended, sessionStartsAt])].sort() : r.attended.filter((s) => s !== sessionStartsAt);
      return decReg(r);
    }),

    // ---------------------------------------------------------- waitlist
    joinWaitlist: (input) => ctx.write(() => {
      const w = who();
      const { clientId } = booker(w, input.clientId, 'join the waitlist');
      const e = S().events.find((x) => x.id === input.eventId);
      if (!e || e.cancelled || (w.kind === 'client' && !e.published)) throw err('NOT_FOUND', 'We couldn’t find that event.');
      const now = ctx.now();
      if (now.toISOString() >= eventStart(e)) throw err('TOO_LATE', 'Sign-up closed when it started.');
      advance(e.id);
      if (S().registrations.some((r) => r.eventId === e.id && r.clientId === clientId && r.status === 'registered')) throw err('ALREADY_BOOKED', 'You’re already registered.');
      if (inLine(e.id).some((x) => x.clientId === clientId)) throw err('ALREADY_BOOKED', 'You’re already on the waitlist.');
      if (spotsFree(e) > 0) throw err('NOT_FULL', 'There are places left, so you can sign up now.');
      requireWaiver(clientId, w);
      const entry: StoredWaitlist = { id: ctx.newId('awl'), eventId: e.id, clientId, status: 'waiting', joinedAt: now.toISOString() };
      waitlist().push(entry);
      return decWait(entry);
    }),
    leaveWaitlist: (id) => ctx.write(() => {
      const w = who();
      const x = waitlist().find((y) => y.id === id);
      if (!x) throw err('NOT_FOUND', 'We couldn’t find that waitlist spot.');
      if (w.kind === 'client') { if (x.clientId !== w.clientId && guardianOf(x.clientId) !== w.clientId) throw err('NOT_FOUND', 'We couldn’t find that waitlist spot.'); }
      else ctx.requireStaff('appointments.book');
      if (x.status !== 'waiting' && x.status !== 'offered') return;
      x.status = 'left'; delete x.offerExpiresAt;
      advance(x.eventId);   // an offer given back goes to the next in line
    }),
    listWaitlist: (q) => ctx.read(() => {
      const w = who();
      advanceAll();
      let rows: StoredWaitlist[];
      if ('clientId' in q) {
        if (w.kind === 'client') { if (q.clientId !== w.clientId && guardianOf(q.clientId) !== w.clientId) throw err('NOT_ALLOWED', 'You can only see your own waitlist spots.'); }
        else requireView();
        const ids = w.kind === 'client' && q.clientId === w.clientId ? familyOf(w.clientId) : [q.clientId];
        rows = waitlist().filter((x) => ids.includes(x.clientId) && (x.status === 'waiting' || x.status === 'offered'));
      } else {
        if (w.kind === 'client') throw err('NOT_ALLOWED', 'Only staff can see the waitlist.');
        const e = S().events.find((x) => x.id === q.eventId);
        if (!e) throw err('NOT_FOUND', 'We couldn’t find that event.');
        const me = requireView();
        if (!can(me.role, 'appointments.book') && e.hostStaffId !== me.id) throw err('NOT_ALLOWED', 'Only the host and the front desk can see the waitlist.');
        rows = inLine(e.id);
      }
      return rows.map(decWait).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    }),

    markRefunded: (target) => ctx.write(() => {
      ctx.requireStaff('appointments.book');
      if ('appointmentId' in target) {
        const a = S().appointments.find((x) => x.id === target.appointmentId);
        if (!a) throw err('NOT_FOUND', 'We couldn’t find that appointment.');
        delete a.refundDue;
      } else {
        const r = S().registrations.find((x) => x.id === target.registrationId);
        if (!r) throw err('NOT_FOUND', 'We couldn’t find that registration.');
        delete r.refundDue;
      }
    }),

    // Demo: no Stripe, so the UI shows the fake card sheet instead and then calls bookAppointment / buyPack / register.
    startCheckout: () => Promise.resolve(null),
  };
}
