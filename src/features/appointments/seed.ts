/**
 * Demo seed data for the appointments feature: realistic privates, duets, packs, a course and workshops for each demo studio.
 * Runs once per studio inside that studio's format (timezone / currency), relative to `now`, so the demo always looks current.
 * Ids are deterministic (the demo can re-seed lazily for a browser that predates this feature without ids changing).
 */
import { addDays, dateFormat, studioDate, studioToUTC, weekday } from '../../shared/format';
import type { DemoState } from '../../data/demo/engine';
import type { ID, Sale, Studio } from '../../shared/types';
import type { Slice, StoredAppointment, StoredCredit, StoredRegistration } from './demo';
import type { AppointmentPack, AppointmentType, AvailabilityRule, StudioEvent, TimeOff } from './types';
import { DEFAULT_SETTINGS, HOUR_MS, computeSlots } from './logic';

const DAY_MS = 24 * HOUR_MS;

export function seedAppointments(studio: Studio, state: DemoState, now: Date, _newId?: (prefix: string) => ID): Slice {
  const slice: Slice = {
    settings: { ...DEFAULT_SETTINGS }, types: [], packs: [], credits: [], availability: [], timeOff: [], appointments: [], events: [], registrations: [],
  };
  const build = BUILDERS[studio.slug];
  if (build) build(slice, state, now);
  return slice;
}

// ---------------------------------------------------------------- helpers

interface Ctx {
  slice: Slice; state: DemoState; now: Date; today: string;
  staff: (name: string) => ID | undefined;
  client: (first: string, last: string) => ID | undefined;
  /** The Nth upcoming date (from `from`, inclusive) on a weekday. */
  nextOn: (from: string, wd: number) => string;
  at: (date: string, hhmm: string) => string;
  sale: (id: string, clientId: ID, name: string, qty: number, unitCents: number, method: Sale['method'], daysAgo: number, note: string) => Sale;
}

function context(slice: Slice, state: DemoState, now: Date): Ctx {
  const today = studioDate(now);
  const byName = (n: string) => state.staff.find((s) => s.name.toLowerCase() === n.toLowerCase() || s.name.toLowerCase().startsWith(n.toLowerCase() + ' '))?.id;
  return {
    slice, state, now, today,
    staff: byName,
    client: (first, last) => state.clients.find((c) => c.firstName === first && c.lastName === last)?.id,
    nextOn: (from, wd) => { let d = from; while (weekday(d) !== wd) d = addDays(d, 1); return d; },
    at: (date, hhmm) => studioToUTC(date, hhmm),
    sale: (id, clientId, name, qty, unitCents, method, daysAgo, note) => {
      const existing = state.sales.find((s) => s.id === id);
      if (existing) return existing;
      const sale: Sale = { id, clientId, items: [{ name, qty, unitCents }], totalCents: method === 'comp' ? 0 : qty * unitCents, method, createdAt: new Date(now.getTime() - daysAgo * DAY_MS).toISOString(), note };
      state.sales.push(sale);
      return sale;
    },
  };
}

let seq = 0;
const uid = (p: string) => `${p}_s${(++seq).toString(36)}`;
const resetIds = () => { seq = 0; };

function avail(staffId: ID | undefined, rows: [number[], string, string][]): AvailabilityRule[] {
  if (!staffId) return [];
  return rows.flatMap(([days, start, end]) => days.map((weekday) => ({ id: uid('aav'), staffId, weekday, start, end })));
}

/** First open slot for a type with this instructor, on/after `afterDays` days from now, starting between two local hours. */
function firstSlot(c: Ctx, type: AppointmentType, staffId: ID, afterDays: number, hourFrom: number, hourTo: number, nth = 0): string | undefined {
  const from = addDays(c.today, afterDays);
  const slots = computeSlots({
    type, rules: c.slice.availability, timeOff: c.slice.timeOff, appointments: c.slice.appointments, sessions: c.state.sessions,
    settings: c.slice.settings, now: c.now, from, to: addDays(from, 28), staffId, asStaff: true,
  }).filter((s) => {
    const h = Number(studioToLocalHour(s.startsAt));
    return h >= hourFrom && h < hourTo;
  });
  return slots[nth]?.startsAt;
}
function studioToLocalHour(iso: string): string {
  return dateFormat({ hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

function addAppt(c: Ctx, a: { type: AppointmentType; staffId: ID; clientId: ID; startsAt: string; people?: number; pay: 'card' | 'cash' | 'pack'; creditId?: ID; status?: StoredAppointment['status']; note?: string; bookedDaysAgo?: number; refundDue?: boolean }): StoredAppointment {
  const people = a.people ?? 1;
  const startsAt = new Date(a.startsAt).toISOString();
  const bookedAt = new Date(Math.min(Date.parse(startsAt) - 2 * HOUR_MS, c.now.getTime() - (a.bookedDaysAgo ?? 3) * DAY_MS)).toISOString();
  let payment: StoredAppointment['payment'];
  if (a.pay === 'pack') payment = { method: 'pack', amountCents: 0, credits: [{ creditId: a.creditId as ID, n: people }] };
  else {
    const id = `sa_ap_${a.type.id}_${a.clientId}_${startsAt.slice(0, 13)}`;
    const sale = c.sale(id, a.clientId, people === 2 ? `${a.type.name} (2 people)` : a.type.name, people, a.type.priceCents, a.pay === 'card' ? 'card_online' : 'cash', Math.max(0, Math.round((c.now.getTime() - Date.parse(bookedAt)) / DAY_MS)), 'Appointment');
    payment = { method: a.pay === 'card' ? 'card_online' : 'cash', amountCents: sale.totalCents, saleId: sale.id };
  }
  const appt: StoredAppointment = {
    id: uid('apt'), typeId: a.type.id, typeName: a.type.name, staffId: a.staffId, clientId: a.clientId, people, startsAt,
    endsAt: new Date(Date.parse(startsAt) + a.type.durationMin * 60000).toISOString(), bufferMin: a.type.bufferMin, status: a.status ?? 'booked', payment,
    source: 'client', createdAt: bookedAt, ...(a.note ? { note: a.note } : {}), ...(a.refundDue ? { refundDue: true, cancelledAt: new Date(c.now.getTime() - DAY_MS).toISOString() } : {}),
  };
  c.slice.appointments.push(appt);
  return appt;
}

function addCredit(c: Ctx, pack: AppointmentPack, clientId: ID, used: number, daysAgo: number, activatedDaysAgo?: number): StoredCredit {
  const sale = c.sale(`sa_ap_pack_${pack.id}_${clientId}`, clientId, pack.name, 1, pack.priceCents, 'card_online', daysAgo, 'Appointment pack');
  const activatedAt = activatedDaysAgo != null ? new Date(c.now.getTime() - activatedDaysAgo * DAY_MS).toISOString() : undefined;
  const cr: StoredCredit = {
    id: uid('acr'), clientId, packId: pack.id, name: pack.name, credits: pack.credits, used, validityDays: pack.validityDays, typeIds: [...pack.typeIds],
    purchasedAt: sale.createdAt, saleId: sale.id,
    ...(activatedAt ? { activatedAt, expiresAt: pack.validityDays ? new Date(Date.parse(activatedAt) + pack.validityDays * DAY_MS).toISOString() : null } : {}),
  };
  c.slice.credits.push(cr);
  return cr;
}

/** Register the first `n` clients (stable order) that haven't been used for this event. Paid ones get a Sale. */
function fillEvent(c: Ctx, e: StudioEvent, clientIds: ID[]): void {
  clientIds.forEach((clientId, i) => {
    const daysAgo = 2 + (i % 9);
    const sale = e.priceCents > 0 ? c.sale(`sa_ap_ev_${e.id}_${clientId}`, clientId, e.title, 1, e.priceCents, i % 4 === 3 ? 'card_reader' : 'card_online', daysAgo, e.kind === 'course' ? 'Course' : 'Workshop / event') : undefined;
    const r: StoredRegistration = {
      id: uid('arg'), eventId: e.id, clientId, status: 'registered', createdAt: new Date(c.now.getTime() - daysAgo * DAY_MS).toISOString(), attended: [],
      payment: { method: sale ? sale.method as StoredRegistration['payment']['method'] : 'comp', amountCents: sale?.totalCents ?? 0, ...(sale ? { saleId: sale.id } : {}) },
    };
    c.slice.registrations.push(r);
  });
}

/** Clients that exist in this studio, stable order, skipping the named ones (kept for the hand-made bookings). */
function pool(c: Ctx, skip: ID[]): ID[] {
  return c.state.clients.filter((x) => !x.archived && !skip.includes(x.id)).map((x) => x.id).sort();
}

// ---------------------------------------------------------------- Snowy Pilates Club (mat Pilates, Cooma)

function snowy(slice: Slice, state: DemoState, now: Date): void {
  resetIds();
  const c = context(slice, state, now);
  const libby = c.staff('Libby'), julia = c.staff('Julia');
  if (!libby) return;
  const typePrivate: AppointmentType = {
    id: 'apty_private', name: 'Private Session', durationMin: 55, priceCents: 12000, capacity: 1, bufferMin: 15, staffIds: [libby, ...(julia ? [julia] : [])], active: true, sortOrder: 10,
    description: 'One-to-one mat Pilates, shaped around you. Perfect for injuries, postnatal, nerves about group classes, or when you want your form dialled in.',
    bookingNote: 'Wear something comfy. We’ll have a mat ready for you. Tell us about any injuries when you book.', imageUrl: 'img/portrait.webp',
  };
  const typeDuet: AppointmentType = {
    id: 'apty_duet', name: 'Duet Session', durationMin: 55, priceCents: 7500, capacity: 2, bufferMin: 15, staffIds: [libby], active: true, sortOrder: 20,
    description: 'Train with a friend, your partner or your mum. One instructor, two mats, lots of laughs. Price is per person.',
    bookingNote: 'Booking for two? Pick “Me + a friend” and we’ll set up two mats.', imageUrl: 'img/square.webp',
  };
  const typeIntro: AppointmentType = {
    id: 'apty_intro', name: 'Private Intro', durationMin: 30, priceCents: 6500, capacity: 1, bufferMin: 10, staffIds: [libby], active: true, sortOrder: 5,
    description: 'A relaxed 30 minutes with Libby: a chat about your body and goals, and a gentle movement check so you walk into group classes with confidence.',
    imageUrl: 'img/wide.webp',
  };
  slice.types.push(typeIntro, typePrivate, typeDuet);
  const pack3: AppointmentPack = { id: 'apk_3', name: '3 Private Sessions', description: 'Three one-to-one sessions. Use within 3 months of your first one.', credits: 3, priceCents: 33000, validityDays: 91, typeIds: [typePrivate.id], active: true };
  const pack5: AppointmentPack = { id: 'apk_5', name: '5 Session Pack', description: 'Five sessions for privates or duets (one credit per person). Use within 5 months.', credits: 5, priceCents: 52500, validityDays: 152, typeIds: [], active: true };
  slice.packs.push(pack3, pack5);

  slice.availability.push(
    ...avail(libby, [[[1, 2, 4], '09:00', '15:00'], [[6], '09:30', '12:30']]),
    ...avail(julia, [[[3], '09:30', '13:00'], [[5], '09:00', '13:00']]),
  );
  const off = c.nextOn(addDays(c.today, 8), 4);
  slice.timeOff.push({ id: uid('ato'), staffId: libby, startsAt: c.at(off, '09:00'), endsAt: c.at(off, '15:00'), note: 'Teacher training in Sydney' });

  // people
  const hannah = c.client('Hannah', 'Mitchell'), jess = c.client('Jess', 'Walker'), mia = c.client('Mia', 'Roberts'), kate = c.client('Kate', 'Anderson');
  if (hannah) {
    const s = firstSlot(c, typePrivate, libby, 2, 10, 12);
    if (s) addAppt(c, { type: typePrivate, staffId: libby, clientId: hannah, startsAt: s, pay: 'card', note: 'Lower back is a bit grumpy after a long drive. Keen to work on core.' });
    addAppt(c, { type: typePrivate, staffId: libby, clientId: hannah, startsAt: c.at(c.nextOn(addDays(c.today, -14), 1), '10:00'), pay: 'card', status: 'completed', bookedDaysAgo: 18 });
  }
  if (jess) {
    const cr = addCredit(c, pack3, jess, 2, 21, 12);
    addAppt(c, { type: typePrivate, staffId: libby, clientId: jess, startsAt: c.at(c.nextOn(addDays(c.today, -10), 2), '11:00'), pay: 'pack', creditId: cr.id, status: 'completed', bookedDaysAgo: 14 });
    const s = firstSlot(c, typePrivate, libby, 3, 9, 11, 1);
    if (s) addAppt(c, { type: typePrivate, staffId: libby, clientId: jess, startsAt: s, pay: 'pack', creditId: cr.id });
    else cr.used = 1;
  }
  if (mia) {
    const s = firstSlot(c, typeDuet, libby, 5, 10, 13);
    if (s) addAppt(c, { type: typeDuet, staffId: libby, clientId: mia, startsAt: s, people: 2, pay: 'card', note: 'Bringing my sister Ella. She’s a total beginner!' });
  }
  if (kate) {
    const s = firstSlot(c, typePrivate, libby, 6, 12, 15);
    if (s) addAppt(c, { type: typePrivate, staffId: libby, clientId: kate, startsAt: s, pay: 'card', status: 'cancelled', refundDue: true, bookedDaysAgo: 4 });
  }
  const juliaSlot = julia ? firstSlot(c, typePrivate, julia, 1, 9, 12) : undefined;
  const walkIn = c.state.clients.find((x) => !x.archived && ![hannah, jess, mia, kate].includes(x.id) && x.waiverSignedAt)?.id;
  if (juliaSlot && julia && walkIn) addAppt(c, { type: typePrivate, staffId: julia, clientId: walkIn, startsAt: juliaSlot, pay: 'cash' });

  // events
  const sat = c.nextOn(addDays(c.today, 9), 6);
  const course: StudioEvent = {
    id: 'aev_foundations', kind: 'course', title: 'Mat Pilates Foundations', priceCents: 13500, capacity: 10, hostStaffId: libby, published: true, refundCutoffHours: 48,
    description: 'Three weeks to learn the building blocks of mat Pilates: breath, pelvic placement, the hundred, rolling like a ball and more. A small group with plenty of coaching, so you walk into any class with confidence. Come to all three sessions for the full course.',
    imageUrl: 'img/wide.webp', createdAt: new Date(now.getTime() - 20 * DAY_MS).toISOString(),
    sessions: [0, 7, 14].map((d) => ({ startsAt: c.at(addDays(sat, d), '10:30'), endsAt: c.at(addDays(sat, d), '11:30') })),
  };
  const sun = c.nextOn(addDays(c.today, 4), 0);
  const workshop: StudioEvent = {
    id: 'aev_reset', kind: 'workshop', title: 'Sunday Reset: Mobility + Breath', priceCents: 5500, capacity: 12, hostStaffId: julia ?? libby, published: true, refundCutoffHours: 48,
    description: 'A slow, spacious two hours to unwind your week: gentle mobility, breathwork and a long floor stretch. All levels. Bring a water bottle and a cosy layer for the end.',
    imageUrl: 'img/square.webp', createdAt: new Date(now.getTime() - 10 * DAY_MS).toISOString(),
    sessions: [{ startsAt: c.at(sun, '09:30'), endsAt: c.at(sun, '11:30') }],
  };
  slice.events.push(course, workshop);
  const others = pool(c, []);
  fillEvent(c, course, [...[hannah].filter(Boolean) as ID[], ...others.filter((id) => id !== hannah).slice(0, 5)]);
  fillEvent(c, workshop, [...[mia].filter(Boolean) as ID[], ...others.filter((id) => id !== mia).slice(2, 12)]);
}

// ---------------------------------------------------------------- Harbour Reformer Co. (reformer, Double Bay)

function harbour(slice: Slice, state: DemoState, now: Date): void {
  resetIds();
  const c = context(slice, state, now);
  const ava = c.staff('Ava'), noah = c.staff('Noah'), isla = c.staff('Isla');
  if (!ava || !noah || !isla) return;
  const typePrivate: AppointmentType = {
    id: 'apty_private', name: 'Reformer Private', durationMin: 50, priceCents: 13000, capacity: 1, bufferMin: 10, staffIds: [ava, isla, noah], active: true, sortOrder: 10,
    description: 'One-to-one on the reformer with your choice of instructor. Technique, strength, a tricky shoulder, or a first time on the springs.',
    bookingNote: 'Grip socks required. Pick up a pair at the studio if you need them.', imageUrl: 'studios/harbour/foundations.webp',
  };
  const typeDuet: AppointmentType = {
    id: 'apty_duet', name: 'Reformer Duet', durationMin: 50, priceCents: 8500, capacity: 2, bufferMin: 10, staffIds: [ava, isla], active: true, sortOrder: 20,
    description: 'Two reformers, one instructor. Share the session with a friend or partner. Price is per person.', imageUrl: 'studios/harbour/flow.webp',
  };
  const typeRehab: AppointmentType = {
    id: 'apty_rehab', name: 'Rehab Private', durationMin: 50, priceCents: 15000, capacity: 1, bufferMin: 10, staffIds: [isla], active: true, sortOrder: 30,
    description: 'Physio-trained, alignment-led reformer work with Isla, for injuries and returning to training. Bring any scans or notes.', imageUrl: 'studios/harbour/hero.webp',
  };
  slice.types.push(typePrivate, typeDuet, typeRehab);
  const pack3: AppointmentPack = { id: 'apk_3', name: '3 Reformer Privates', description: 'Three one-to-one sessions. Use within 3 months of your first one.', credits: 3, priceCents: 36000, validityDays: 91, typeIds: [typePrivate.id, typeRehab.id], active: true };
  const pack5: AppointmentPack = { id: 'apk_5', name: '5 Session Pack', description: 'Five sessions across privates, duets and rehab (one credit per person). Use within 5 months.', credits: 5, priceCents: 57500, validityDays: 152, typeIds: [], active: true };
  slice.packs.push(pack3, pack5);

  slice.availability.push(
    ...avail(ava, [[[2, 4], '09:30', '16:00']]),
    ...avail(isla, [[[1, 2, 3, 4, 5], '13:00', '17:00']]),
    ...avail(noah, [[[1, 2, 3, 4, 5], '09:00', '11:30'], [[6], '10:00', '13:00']]),
  );
  const off = c.nextOn(addDays(c.today, 6), 3);
  slice.timeOff.push({ id: uid('ato'), staffId: noah, startsAt: c.at(off, '00:00'), endsAt: c.at(addDays(off, 1), '00:00'), note: 'Fitness conference' });

  const priya = c.client('Priya', 'Shah'), jack = c.client('Jack', 'Nolan'), grace = c.client('Grace', 'Okafor'), hugo = c.client('Hugo', 'Lambert');
  if (priya) {
    const cr = addCredit(c, pack3, priya, 2, 24, 15);
    addAppt(c, { type: typePrivate, staffId: isla, clientId: priya, startsAt: c.at(c.nextOn(addDays(c.today, -9), 3), '14:00'), pay: 'pack', creditId: cr.id, status: 'completed', bookedDaysAgo: 12 });
    const s = firstSlot(c, typePrivate, isla, 2, 14, 16);
    if (s) addAppt(c, { type: typePrivate, staffId: isla, clientId: priya, startsAt: s, pay: 'pack', creditId: cr.id, note: 'Right shoulder. Physio cleared me for light load.' });
    else cr.used = 1;
  }
  if (jack) {
    const s = firstSlot(c, typeDuet, ava, 3, 10, 13);
    if (s) addAppt(c, { type: typeDuet, staffId: ava, clientId: jack, startsAt: s, people: 2, pay: 'card' });
  }
  if (grace) addAppt(c, { type: typePrivate, staffId: noah, clientId: grace, startsAt: c.at(c.nextOn(addDays(c.today, -6), 1), '09:30'), pay: 'card', status: 'completed', bookedDaysAgo: 9 });
  if (hugo) {
    const s = firstSlot(c, typeRehab, isla, 4, 13, 17);
    if (s) addAppt(c, { type: typeRehab, staffId: isla, clientId: hugo, startsAt: s, pay: 'cash' });
  }

  const sat = c.nextOn(addDays(c.today, 8), 6);
  const workshop: StudioEvent = {
    id: 'aev_foundations', kind: 'workshop', title: 'Reformer Foundations Workshop', priceCents: 8500, capacity: 8, hostStaffId: isla, published: true, refundCutoffHours: 48,
    description: 'Two unhurried hours on the reformer with Isla. Springs, footwork, breath and the little cues that make everything else click. Perfect before your first class, or to reset your technique.',
    imageUrl: 'studios/harbour/foundations.webp', createdAt: new Date(now.getTime() - 16 * DAY_MS).toISOString(),
    sessions: [{ startsAt: c.at(sat, '11:00'), endsAt: c.at(sat, '13:00') }],
  };
  const fri = c.nextOn(addDays(c.today, 5), 5);
  const social: StudioEvent = {
    id: 'aev_social', kind: 'event', title: 'Sunset on the Terrace: members’ social', priceCents: 0, capacity: 25, hostStaffId: ava, published: true, refundCutoffHours: 0,
    description: 'Drinks, nibbles and good company on the studio terrace. Meet the team, meet each other, and tell Ava what you’d love to see next. Free for everyone, but please register so we can plan.',
    imageUrl: 'studios/harbour/offer.webp', createdAt: new Date(now.getTime() - 8 * DAY_MS).toISOString(),
    sessions: [{ startsAt: c.at(fri, '19:00'), endsAt: c.at(fri, '20:30') }],
  };
  slice.events.push(workshop, social);
  const others = pool(c, []);
  fillEvent(c, workshop, others.slice(1, 6));
  fillEvent(c, social, others.slice(0, 9));
}

const BUILDERS: Record<string, (slice: Slice, state: DemoState, now: Date) => void> = { snowy, harbour };

