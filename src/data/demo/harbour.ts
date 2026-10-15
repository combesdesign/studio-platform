/**
 * Demo data for the second sample studio, Harbour Reformer Co. Smaller than Snowy's: 4 staff, 3 reformer
 * classes, ~16 clients and three weeks of history, replayed through the real Engine so credits add up.
 * Personas (same order as Snowy's): brand new, member (1 of 2 left this week), pack (1 left), intro.
 */
import type { ClassType, Client, ID, Product, ScheduleTemplate, Staff, StudioSettings } from '../../shared/types';
import { addDays, studioToUTC, weekStart } from '../../shared/format';
import { DAY_MS, HOUR_MS, MINUTE_MS, studioDay } from '../../domain';
import { Engine, STATE_VERSION, type DemoState } from './engine';
import { HEALTH_QUESTIONS } from './fixtures';

export const HARBOUR_PERSONAS = {
  newClient: 'olive.harper@example.com',
  member: 'jack.nolan@example.com',
  pack: 'priya.shah@example.com',
  intro: 'lucas.bennett@example.com',
} as const;

function settings(): StudioSettings {
  return {
    name: 'Harbour Reformer Co.', timezone: 'Australia/Sydney', address: '12 Bay Street, Double Bay NSW 2028',
    email: 'hello@harbourreformer.example', phone: '02 9000 1234', abn: '98 765 432 109', gstRegistered: true,
    cancelWindowHours: 12, waitlistCutoffHours: 2, lateCancelFeeCents: 0, noShowFeeCents: 0, bookingWindowDays: 21, defaultCapacity: 8,
    waiverText: `Welcome to Harbour Reformer Co. Reformer Pilates uses spring-loaded equipment. Please read and agree before your first class.

1. I take part voluntarily and at my own risk, and I'll work within my limits.
2. I've answered the health questions honestly and will tell my instructor about any injury, condition or pregnancy.
3. I'll use the reformer only as shown, keep hands and feet clear of springs and the carriage, and stop if anything hurts.
4. Harbour Reformer Co. isn't liable for injury or loss from my participation, except where caused by its negligence or where the law says otherwise.
5. I agree to the studio's booking, cancellation and waitlist policies.`,
    healthQuestions: [...HEALTH_QUESTIONS],
    cancellationPolicyText: 'Reformers are limited, so cancel at least 12 hours before class to get your credit back. Later cancellations and no-shows lose the credit.',
    waitlistPolicyText: 'Full class? Join the waitlist. If a reformer frees up before the 2-hour cut-off, the first person with a credit is booked in automatically and we’ll let you know.',
  };
}

const STAFF: Staff[] = [
  { id: 'hb_st_ava', name: 'Ava Chen', email: 'ava@harbourreformer.example', role: 'owner', active: true,
    bio: 'Ava opened Harbour after ten years teaching reformer in London. Precise cues, calm energy and a soft spot for footwork.' },
  { id: 'hb_st_noah', name: 'Noah Price', email: 'noah@harbourreformer.example', role: 'instructor', payPerClassCents: 7000, active: true,
    bio: 'Former rower. Noah’s jumpboard classes are fast, sweaty and surprisingly fun.' },
  { id: 'hb_st_isla', name: 'Isla Moreau', email: 'isla@harbourreformer.example', role: 'instructor', payPerClassCents: 7000, active: true,
    bio: 'Physio-trained and big on alignment. Isla’s Foundations class is the perfect start.' },
  { id: 'hb_st_sam', name: 'Sam Lee', email: 'sam@harbourreformer.example', role: 'front_desk', payPerClassCents: 0, active: true,
    bio: 'Sam runs the front desk and knows everyone’s favourite reformer.' },
];

const CLASS_TYPES: ClassType[] = [
  { id: 'hb_ct_found', name: 'Reformer Foundations', level: 'Beginners', durationMin: 50, color: '#1F4A3D', defaultCapacity: 8, bookable: true, active: true,
    description: 'Learn the reformer properly: springs, footwork, breath and control. The best place to start.' },
  { id: 'hb_ct_flow', name: 'Reformer Flow', level: 'All levels', durationMin: 50, color: '#C9A877', defaultCapacity: 8, bookable: true, active: true,
    description: 'A flowing full-body reformer class with plenty of core and a long stretch to finish.' },
  { id: 'hb_ct_jump', name: 'Jumpboard Burn', level: 'Intermediate', durationMin: 45, color: '#6E8B7E', defaultCapacity: 8, bookable: true, active: true,
    description: 'Low-impact cardio on the jumpboard, then strength. Bring water.',
    bookingNote: 'You’ll need at least 5 reformer classes before Jumpboard Burn.' },
];

const PRODUCTS: Product[] = [
  { id: 'hb_pr_intro', kind: 'intro', name: 'Intro week unlimited', description: 'Seven days of unlimited reformer classes for new clients.', priceCents: 5900, credits: null, validityDays: 7, newClientsOnly: true, active: true, sortOrder: 1, highlight: 'New clients' },
  { id: 'hb_pr_m2', kind: 'membership', name: '2 reformer classes a week', description: 'Two classes every week, billed weekly. The sweet spot for real progress.', priceCents: 7900, credits: 2, validityDays: null, billingInterval: 'week', active: true, sortOrder: 10, highlight: 'Most popular' },
  { id: 'hb_pr_mu', kind: 'membership', name: 'Unlimited reformer', description: 'As many classes as you like, billed weekly.', priceCents: 10900, credits: null, validityDays: null, billingInterval: 'week', active: true, sortOrder: 11 },
  { id: 'hb_pr_drop', kind: 'dropin', name: 'Single reformer class', description: 'One class, any time in the next 60 days.', priceCents: 4200, credits: 1, validityDays: 60, active: true, sortOrder: 20 },
  { id: 'hb_pr_p5', kind: 'pack', name: '5 class pack', description: 'Five classes to use within 3 months of your first booking.', priceCents: 19500, credits: 5, validityDays: 91, active: true, sortOrder: 21 },
  { id: 'hb_pr_p10', kind: 'pack', name: '10 class pack', description: 'Ten classes to use within 6 months of your first booking.', priceCents: 36000, credits: 10, validityDays: 182, active: true, sortOrder: 22 },
  { id: 'hb_pr_socks', kind: 'retail', name: 'Grip socks', description: 'Harbour green grip socks. Required on the reformers.', priceCents: 2200, stock: 30, active: true, sortOrder: 30 },
];

function templates(startsOn: string): ScheduleTemplate[] {
  const out: ScheduleTemplate[] = [];
  const add = (wd: number, t: string, ct: string, by: string) => out.push({ id: `hb_tp_${wd}_${t.replace(':', '')}`, classTypeId: ct, weekday: wd, startTime: t, instructorId: by, startsOn, active: true });
  for (let wd = 1; wd <= 5; wd++) {
    add(wd, '06:15', wd % 2 ? 'hb_ct_flow' : 'hb_ct_jump', 'hb_st_noah');
    add(wd, '12:15', 'hb_ct_found', 'hb_st_isla');
    add(wd, '17:45', wd % 2 ? 'hb_ct_found' : 'hb_ct_flow', wd % 2 ? 'hb_st_isla' : 'hb_st_ava');
  }
  add(6, '08:00', 'hb_ct_flow', 'hb_st_ava');
  add(6, '09:15', 'hb_ct_jump', 'hb_st_noah');
  add(0, '09:00', 'hb_ct_found', 'hb_st_isla');
  return out;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const NAMES: [string, string, string][] = [
  ['Jack', 'Nolan', 'hb_pr_m2'], ['Priya', 'Shah', 'hb_pr_p5'], ['Grace', 'Okafor', 'hb_pr_mu'], ['Hugo', 'Lambert', 'hb_pr_p10'],
  ['Mei', 'Tanaka', 'hb_pr_m2'], ['Chloe', 'Dawson', 'hb_pr_p5'], ['Ollie', 'Grant', 'hb_pr_drop'], ['Sienna', 'Brooks', 'hb_pr_p10'],
  ['Ruby', 'Ellis', 'hb_pr_m2'], ['Leo', 'Fischer', 'hb_pr_p5'], ['Nina', 'Kowalski', 'hb_pr_mu'], ['Zara', 'Haddad', 'hb_pr_p10'],
];

/** Harbour's demo state, relative to now. */
export function seedHarbour(now: Date): DemoState {
  const rnd = mulberry(20261019);
  const nowT = now.getTime();
  const today = studioDay(now);
  const thisMon = weekStart(today);
  const historyFrom = addDays(thisMon, -21);
  const state: DemoState = {
    version: STATE_VERSION, seededAt: now.toISOString(), historyFrom, settings: settings(),
    staff: STAFF.map((s) => ({ ...s })), classTypes: CLASS_TYPES.map((c) => ({ ...c })), templates: templates('2025-01-01'),
    sessions: [], bookings: [], clients: [], products: PRODUCTS.map((p) => ({ ...p })), passes: [], sales: [], passSale: {}, outbox: [],
    personas: [HARBOUR_PERSONAS.newClient, HARBOUR_PERSONAS.member, HARBOUR_PERSONAS.pack, HARBOUR_PERSONAS.intro],
    personaHints: {
      [HARBOUR_PERSONAS.newClient]: 'Brand new – no waiver or passes yet', [HARBOUR_PERSONAS.member]: 'Member · 2 reformer classes a week',
      [HARBOUR_PERSONAS.pack]: '5 class pack · 1 credit left', [HARBOUR_PERSONAS.intro]: 'On the intro week',
    },
  };
  const clock = { t: nowT };
  let idn = 0;
  const eng = new Engine(state, () => new Date(clock.t), (prefix) => `hb_${prefix}_${(++idn).toString(36).padStart(4, '0')}`);
  eng.generate(historyFrom, addDays(today, 21));

  const answers = Object.fromEntries(HEALTH_QUESTIONS.map((q) => [q, 'No']));
  const mk = (first: string, last: string, daysAgo: number, signed = true): Client => {
    const created = new Date(nowT - daysAgo * DAY_MS).toISOString();
    const c: Client = {
      id: `hb_cl_${first.toLowerCase()}`, firstName: first, lastName: last, email: `${first}.${last}@example.com`.toLowerCase(),
      phone: `04${10 + Math.floor(rnd() * 89)} ${100 + Math.floor(rnd() * 899)} ${100 + Math.floor(rnd() * 899)}`, createdAt: created,
      marketingOptIn: rnd() < 0.7, source: 'app',
      ...(signed ? { waiverSignedAt: created, healthForm: { answers, submittedAt: created } } : {}),
    };
    eng.addClient(c);
    return c;
  };
  const sessionsOf = (fromT: number, toT: number) => state.sessions
    .filter((s) => Date.parse(s.startsAt) >= fromT && Date.parse(s.startsAt) < toT && s.status === 'scheduled')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = (s: { startsAt: string }) => Date.parse(s.startsAt) < nowT;

  // Regulars: buy, then come to a couple of classes a week (past ones checked in).
  NAMES.forEach(([first, last, product], i) => {
    const c = mk(first, last, 40 + i * 9);
    clock.t = Date.parse(studioToUTC(historyFrom, '07:00')) + i * HOUR_MS;
    eng.checkout({ clientId: c.id, items: [{ productId: product, qty: 1 }], method: rnd() < 0.7 ? 'card_online' : 'card_reader', ...(rnd() < 0.3 ? { staffId: 'hb_st_sam' } : {}) });
    const candidates = sessionsOf(clock.t + 6 * HOUR_MS, nowT + 7 * DAY_MS);
    const perWeek = first === 'Jack' ? 0 : product === 'hb_pr_drop' ? 0.4 : product === 'hb_pr_p5' && first === 'Priya' ? 0 : 1.6;
    for (let w = 0; w < 4; w++) {
      const wk = candidates.filter((s) => weekStart(studioDay(s.startsAt)) === addDays(historyFrom, w * 7));
      let k = Math.floor(perWeek) + (rnd() < perWeek % 1 ? 1 : 0);
      while (k-- > 0 && wk.length) {
        const s = wk.splice(Math.floor(rnd() * wk.length), 1)[0]!;
        if (eng.counts(s.id).booked >= s.capacity) continue;
        clock.t = Math.min(Date.parse(s.startsAt) - 30 * HOUR_MS, nowT - HOUR_MS);
        try {
          const r = eng.book(c.id, s.id, { by: { kind: 'client', clientId: c.id } });
          if (past(s) && r.outcome === 'booked') { clock.t = Date.parse(s.startsAt) - 5 * MINUTE_MS; if (rnd() < 0.92) eng.checkIn(r.booking.id); else eng.markNoShow(r.booking.id); }
        } catch { /* no credit left */ }
      }
    }
  });

  // Persona: Jack, member (2 a week) with one booked this week -> "1 of 2 left this week".
  const jack = state.clients.find((c) => c.firstName === 'Jack')!;
  const thisWeek = sessionsOf(nowT + 2 * HOUR_MS, Date.parse(studioToUTC(addDays(thisMon, 7), '00:00')));
  const nextWeek = sessionsOf(Date.parse(studioToUTC(addDays(thisMon, 7), '00:00')), nowT + 14 * DAY_MS);
  clock.t = nowT - 2 * DAY_MS;
  const jackClass = thisWeek[0] ?? nextWeek[0];
  if (jackClass) eng.book(jack.id, jackClass.id, { by: { kind: 'client', clientId: jack.id } });

  // Persona: Priya, 5 pack with one left.
  const priya = state.clients.find((c) => c.firstName === 'Priya')!;
  const pastFour = sessionsOf(Date.parse(studioToUTC(historyFrom, '00:00')) + DAY_MS, nowT).filter((s) => s.classTypeId === 'hb_ct_flow').slice(0, 4);
  for (const s of pastFour) {
    clock.t = Date.parse(s.startsAt) - 20 * HOUR_MS;
    const r = eng.book(priya.id, s.id, { by: { kind: 'staff', staffId: 'hb_st_sam' }, allowOverCapacity: true });
    r.booking.source = 'client'; delete r.booking.bookedByStaffId;
    clock.t = Date.parse(s.startsAt) - 4 * MINUTE_MS;
    eng.checkIn(r.booking.id);
  }

  // Persona: Lucas, intro week, one class done, one coming up.
  const lucas = mk('Lucas', 'Bennett', 3);
  clock.t = nowT - 2 * DAY_MS - 4 * HOUR_MS;
  eng.checkout({ clientId: lucas.id, items: [{ productId: 'hb_pr_intro', qty: 1 }], method: 'card_online' });
  const lucasPast = sessionsOf(clock.t + 4 * HOUR_MS, nowT - 2 * HOUR_MS).find((s) => s.classTypeId === 'hb_ct_found');
  if (lucasPast) {
    const r = eng.book(lucas.id, lucasPast.id, { by: { kind: 'staff', staffId: 'hb_st_sam' }, allowOverCapacity: true });
    r.booking.source = 'client'; delete r.booking.bookedByStaffId;
    clock.t = Date.parse(lucasPast.startsAt) - 3 * MINUTE_MS;
    eng.checkIn(r.booking.id);
  }
  clock.t = nowT - HOUR_MS;
  const lucasNext = sessionsOf(nowT + 18 * HOUR_MS, nowT + 6 * DAY_MS).find((s) => eng.counts(s.id).booked < s.capacity);
  if (lucasNext) eng.book(lucas.id, lucasNext.id, { by: { kind: 'client', clientId: lucas.id } });

  // A full Saturday class with a waitlist.
  const sat = sessionsOf(nowT + 3 * HOUR_MS, nowT + 8 * DAY_MS).find((s) => s.templateId === 'hb_tp_6_0800');
  if (sat) {
    clock.t = nowT - 5 * HOUR_MS;
    for (const c of state.clients) {
      if (c.id === jack.id || c.id === lucas.id || c.id === priya.id) continue;
      try { eng.book(c.id, sat.id, { by: { kind: 'client', clientId: c.id } }); } catch { /* no credit */ }
      if (eng.counts(sat.id).waitlist >= 2) break;
    }
  }

  // Persona: Olive, brand new (no waiver, no passes).
  clock.t = nowT - 40 * MINUTE_MS;
  mk('Olive', 'Harper', 0.03, false);

  // A couple of retail sales.
  clock.t = nowT - 4 * DAY_MS;
  eng.checkout({ items: [{ productId: 'hb_pr_socks', qty: 2 }], method: 'card_reader', staffId: 'hb_st_sam' });

  clock.t = nowT;
  eng.housekeeping();
  state.sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  state.clients.sort((a, b) => a.id.localeCompare(b.id));
  return state;
}

/** A new, empty studio (created from the platform admin): settings only, the owner adds the rest in onboarding. */
export function emptyStudioState(now: Date, s: { name: string; timezone: string; address: string; email: string; phone?: string }): DemoState {
  const today = studioDay(now);
  return {
    version: STATE_VERSION, seededAt: now.toISOString(), historyFrom: addDays(today, -1),
    settings: {
      name: s.name, timezone: s.timezone, address: s.address, email: s.email, ...(s.phone ? { phone: s.phone } : {}), gstRegistered: true,
      cancelWindowHours: 12, waitlistCutoffHours: 1, lateCancelFeeCents: 0, noShowFeeCents: 0, bookingWindowDays: 14, defaultCapacity: 10,
      waiverText: `I take part in classes at ${s.name} at my own risk and will work within my limits. I've told the studio about any injury, condition or pregnancy, and I agree to the booking and cancellation policies.`,
      healthQuestions: [...HEALTH_QUESTIONS],
      cancellationPolicyText: 'Cancel at least 12 hours before class to get your credit back. Later cancellations and no-shows lose the credit.',
      waitlistPolicyText: 'If a class is full, join the waitlist. If a spot opens, the first person with a credit is booked in automatically.',
    },
    staff: [], classTypes: [], templates: [], sessions: [], bookings: [], clients: [], products: [], passes: [], sales: [], passSale: {}, outbox: [],
    personas: [],
  };
}

export type { ID };
