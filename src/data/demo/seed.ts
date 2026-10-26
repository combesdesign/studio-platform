/**
 * Builds a realistic demo studio relative to "now": ~45 clients, 6 weeks of history and the
 * next fortnight. History is produced by replaying bookings/purchases/cancels/check-ins through
 * the real Engine on a simulated clock, so credits, activation, weekly limits, waitlists and
 * billing are consistent by construction.
 */
import { StoreError } from '../../shared/store';
import type { Client, ClassSession, HealthForm, ID, PaymentMethod } from '../../shared/types';
import { addDays, studioToUTC, weekStart } from '../../shared/format';
import { DAY_MS, HOUR_MS, MINUTE_MS, isIntroEligible, isPassCurrent, studioDay } from '../../domain';
import { Engine, STATE_VERSION, type DemoState } from './engine';
import { CLASS_TYPES, HEALTH_QUESTIONS, PRODUCTS, STAFF, defaultSettings, templates } from './fixtures';

export const PERSONA_EMAILS = {
  newClient: 'chloe.bennett@example.com',
  member: 'hannah.mitchell@example.com',
  pack: 'jess.walker@example.com',
  intro: 'mia.roberts@example.com',
  family: 'sophie.archer@example.com',
} as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Plan = 'pr_m1' | 'pr_m2' | 'pr_m3' | 'pr_mu' | 'pr_p4' | 'pr_p8' | 'pr_drop' | 'intro>pr_p4' | 'intro>pr_m2' | 'intro>pr_p8';
interface Profile {
  first: string;
  last: string;
  plan: Plan;
  perWeek: number;
  joinedDaysAgo: number;
  mums?: boolean;
  /** Stops coming after this many weeks into the history (lapsed). */
  lapseAfterWeek?: number;
  injuries?: string;
  staffNotes?: string;
}

const P = (first: string, last: string, plan: Plan, perWeek: number, joinedDaysAgo: number, extra: Partial<Profile> = {}): Profile =>
  ({ first, last, plan, perWeek, joinedDaysAgo, ...extra });

const SIM_CLIENTS: Profile[] = [
  P('Hannah', 'Mitchell', 'pr_m2', 2, 210),
  P('Sarah', 'Thompson', 'pr_mu', 4, 520, { staffNotes: 'Likes the mat by the window. Founding member.' }),
  P('Emma', 'Wilson', 'pr_m3', 3, 380, { injuries: 'Lower back — L4/L5 disc bulge. Avoid deep spinal flexion.' }),
  P('Kate', 'Anderson', 'pr_m2', 2, 300),
  P('Lucy', 'Campbell', 'pr_m1', 1, 160),
  P('Georgia', 'Stewart', 'pr_mu', 3, 440),
  P('Amelia', 'Clarke', 'pr_m2', 2, 250),
  P('Charlotte', 'Kelly', 'pr_m2', 2, 190),
  P('Zoe', 'Martin', 'pr_m3', 3, 330, { injuries: 'Right shoulder impingement — go easy on weight-bearing through the arms.' }),
  P('Matilda', 'Hughes', 'pr_m1', 1, 120),
  P('Rebecca', 'Doyle', 'pr_mu', 4, 610, { staffNotes: 'Direct debit failed once in August — sorted now.' }),
  P('Laura', 'McKenzie', 'pr_m2', 2, 280),
  P('Olivia', 'Brown', 'pr_p8', 2, 400, { injuries: 'Right knee reconstruction (2023). Modify kneeling work.' }),
  P('Isabella', 'Ryan', 'pr_p4', 1, 150),
  P('Ruby', 'Murphy', 'pr_p8', 1.5, 230),
  P('Ella', 'White', 'pr_p4', 1, 95),
  P('Lily', 'Edwards', 'pr_p8', 2, 270),
  P('Sophie', 'Gardner', 'pr_p4', 1.2, 175),
  P('Phoebe', 'Morgan', 'pr_p8', 1, 345),
  P('Annabel', 'Cooper', 'pr_p4', 1, 88),
  P('Kirsten', 'Lawson', 'pr_p8', 2, 500),
  P('Tahlia', 'Nguyen', 'pr_p4', 1.3, 140),
  P('Alice', 'Fraser', 'pr_drop', 0.5, 220, { staffNotes: 'Usually pays at the desk.' }),
  P("Bridget", "O'Connor", 'pr_p4', 1, 260),
  P('Jasmine', 'Patel', 'pr_p8', 1.5, 205),
  P('Megan', 'Price', 'pr_p4', 1, 310, { lapseAfterWeek: 3, staffNotes: 'Mentioned pausing over the busy season — follow up.' }),
  P('Nicole', 'Baxter', 'pr_p8', 1.2, 420),
  P('Rachel', 'Henderson', 'pr_p4', 1, 365, { lapseAfterWeek: 2 }),
  P('Steph', 'Russell', 'pr_drop', 0.4, 75),
  P('Vanessa', 'Fitzgerald', 'pr_p8', 1.5, 290),
  P('Helen', 'Sinclair', 'pr_p4', 1, 480, { injuries: 'Osteopenia — avoid loaded spinal flexion.' }),
  P('Fiona', 'McGrath', 'pr_p8', 1.2, 230),
  P('Deborah', 'Gilmore', 'pr_p4', 1, 390),
  P('Tom', 'Bradley', 'pr_drop', 0.5, 60),
  P('Tegan', 'Walsh', 'pr_p4', 1, 150, { mums: true, injuries: 'Postnatal (5 months) — mild abdominal separation.' }),
  P('Leanne', 'Jarvis', 'pr_p8', 1, 130, { mums: true, injuries: 'Caesarean 4 months ago — cleared by women’s health physio.' }),
  P('Claire', 'Dunn', 'pr_m1', 1, 170, { mums: true }),
  P('Kylie', 'Burgess', 'intro>pr_p4', 1, 22, { mums: true, injuries: 'Postnatal (3 months) — cleared by women’s health physio.' }),
  P('Melissa', 'Sutherland', 'intro>pr_m2', 3, 33),
  P('Joanne', 'Pearce', 'intro>pr_p4', 2.5, 26),
  P('Samantha', 'Reid', 'intro>pr_p8', 3, 11),
  P('Ben', 'Carter', 'intro>pr_p4', 2, 13),
];

/** Relative popularity of each timetable slot (6pm + Saturday are busiest). */
function slotWeight(templateId: string): number {
  if (templateId.endsWith('_18')) return 3.2;
  if (templateId === 'tp_mat_6_08') return 3.5;
  if (templateId.endsWith('_09')) return 2;
  if (templateId.startsWith('tp_mums')) return 0;
  return 1.6;
}

const emailFor = (first: string, last: string) => `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com';

export function seedState(now: Date): DemoState {
  const rnd = mulberry32(20261014);
  const r = (a: number, b: number) => a + (b - a) * rnd();
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
  const nowT = now.getTime();
  const today = studioDay(now);
  const thisMon = weekStart(today);
  const historyFrom = addDays(thisMon, -42);

  const state: DemoState = {
    version: STATE_VERSION,
    seededAt: now.toISOString(),
    historyFrom,
    settings: defaultSettings(),
    staff: STAFF.map((s) => ({ ...s })),
    classTypes: CLASS_TYPES.map((c) => ({ ...c })),
    templates: templates('2024-01-01'),
    sessions: [],
    bookings: [],
    clients: [],
    products: PRODUCTS.map((p) => ({ ...p })),
    passes: [],
    sales: [],
    passSale: {},
    outbox: [],
  };
  const clock = { t: nowT };
  let idn = 0;
  const eng = new Engine(state, () => new Date(clock.t), (prefix) => `${prefix}_${(++idn).toString(36).padStart(4, '0')}${Math.floor(rnd() * 1296).toString(36)}`);
  eng.generate(historyFrom, addDays(today, 14));

  // ------------------------------------------------------------ clients
  const thisWeekDays = Array.from({ length: 7 }, (_, i) => addDays(thisMon, i).slice(5));
  const randomBirthday = (): string => {
    for (;;) {
      const md = `${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
      if (!thisWeekDays.includes(md)) return `${1965 + Math.floor(rnd() * 38)}-${md}`;
    }
  };
  const phone = () => `04${Math.floor(r(10, 99))} ${Math.floor(r(100, 999))} ${Math.floor(r(100, 999))}`;
  const healthFor = (injuries: string | undefined, mums: boolean | undefined, at: string): HealthForm => {
    const answers: Record<string, string> = {};
    HEALTH_QUESTIONS.forEach((q, i) => { answers[q] = 'No'; if (i === 5) answers[q] = ''; });
    if (injuries) { answers[HEALTH_QUESTIONS[0] as string] = `Yes — ${injuries}`; answers[HEALTH_QUESTIONS[3] as string] = injuries.toLowerCase().includes('back') ? 'Yes' : 'No'; }
    if (mums) answers[HEALTH_QUESTIONS[1] as string] = 'Yes — had a baby this year';
    return { answers, ...(injuries ? { injuries } : {}), ...(mums ? { pregnantOrPostnatal: true } : {}), submittedAt: at };
  };
  const mkClient = (id: ID, first: string, last: string, createdAt: number, extra: Partial<Client> & { signed?: boolean; mums?: boolean } = {}): Client => {
    const { signed = true, mums, ...rest } = extra;
    const created = new Date(createdAt).toISOString();
    const c: Client = {
      id, firstName: first, lastName: last, email: emailFor(first, last), phone: phone(), createdAt: created,
      marketingOptIn: rnd() < 0.7, source: 'app',
      ...(rnd() < 0.6 ? { birthday: randomBirthday() } : {}),
      ...(rnd() < 0.5 ? { emergencyContactName: pick(['Mark', 'Dave', 'Sue', 'James', 'Andrew', 'Karen', 'Pete', 'Nick']) + ' ' + last, emergencyContactPhone: phone() } : {}),
      ...(signed ? { waiverSignedAt: created, healthForm: healthFor(rest.injuries, mums, created) } : {}),
      ...rest,
    };
    eng.addClient(c);
    return c;
  };

  const sim = SIM_CLIENTS.map((p, i) => {
    const id = `cl_${String(i + 1).padStart(2, '0')}`;
    const created = nowT - p.joinedDaysAgo * DAY_MS - r(0, 10) * HOUR_MS;
    const c = mkClient(id, p.first, p.last, created, {
      ...(p.injuries ? { injuries: p.injuries } : {}), ...(p.staffNotes ? { staffNotes: p.staffNotes } : {}), mums: p.mums,
      source: p.joinedDaysAgo > 300 ? 'import' : 'app',
    });
    return { p, c };
  });
  const byName = (first: string) => sim.find((x) => x.p.first === first)?.c;
  // Two birthdays this week.
  const kate = byName('Kate'), ruby = byName('Ruby');
  if (kate) kate.birthday = `1988-${addDays(thisMon, 2).slice(5)}`;
  if (ruby) ruby.birthday = `1994-${addDays(thisMon, 5).slice(5)}`;

  // ------------------------------------------------------------ preferred slots
  const tpl = state.templates;
  const prefs = new Map<ID, string[]>();
  for (const { p, c } of sim) {
    if (p.mums) { prefs.set(c.id, ['tp_mums_3_10', ...(rnd() < 0.4 ? ['tp_mat_6_08'] : [])]); continue; }
    const want = Math.max(3, Math.ceil(p.perWeek) + 1);
    const chosen = new Set<string>();
    while (chosen.size < want) {
      const total = tpl.reduce((n, t) => n + slotWeight(t.id), 0);
      let x = rnd() * total;
      for (const t of tpl) { x -= slotWeight(t.id); if (x <= 0) { chosen.add(t.id); break; } }
    }
    prefs.set(c.id, [...chosen]);
  }

  // ------------------------------------------------------------ event queue
  type Ev = { at: number; seq: number; run: () => void };
  const queue: Ev[] = [];
  let seq = 0;
  const push = (at: number, run: () => void) => {
    if (at >= nowT) return;
    const ev = { at, seq: seq++, run };
    let lo = 0, hi = queue.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const q = queue[mid] as Ev; if (q.at < at || (q.at === at && q.seq < ev.seq)) lo = mid + 1; else hi = mid; }
    queue.splice(lo, 0, ev);
  };
  const methodOnline = (): { method: PaymentMethod; staffId?: ID } => {
    const x = rnd();
    if (x < 0.72) return { method: 'card_online' };
    return { method: x < 0.9 ? 'card_reader' : 'cash', staffId: pick(['st_libby', 'st_gracep']) };
  };
  const buyFor = (p: Profile, clientId: ID): boolean => {
    const passes = state.passes.filter((x) => x.clientId === clientId);
    let productId: string = p.plan;
    if (p.plan.startsWith('intro>')) productId = isIntroEligible(clientId, state.passes) ? 'pr_intro' : p.plan.slice(6);
    const product = state.products.find((x) => x.id === productId);
    if (!product) return false;
    if (product.kind === 'membership' && passes.some((x) => x.kind === 'membership' && isPassCurrent(x, new Date(clock.t)))) return false;
    eng.checkout({ clientId, items: [{ productId, qty: 1 }], ...methodOnline() });
    return true;
  };
  const scheduleOutcome = (bookingId: ID, s: ClassSession, bookedAt: number) => {
    const start = Date.parse(s.startsAt);
    const x = rnd();
    const cancelLatest = start - 3 * HOUR_MS - 30 * MINUTE_MS;
    if (x < 0.07 && cancelLatest > bookedAt + 30 * MINUTE_MS) {
      push(bookedAt + (cancelLatest - bookedAt) * r(0.2, 0.95), () => tryCancel(bookingId));
    } else if (x < 0.11) {
      const at = start - r(0.3, 2.8) * HOUR_MS;
      if (at > bookedAt) push(at, () => tryCancel(bookingId));
    } else if (x < 0.14) {
      push(start + 65 * MINUTE_MS, () => { const b = eng.booking(bookingId); if (b.status === 'booked') eng.markNoShow(bookingId); });
    } else {
      push(start - r(2, 15) * MINUTE_MS, () => { const b = eng.booking(bookingId); if (b.status === 'booked') eng.checkIn(bookingId); });
    }
  };
  const tryCancel = (bookingId: ID) => {
    const b = eng.booking(bookingId);
    if (b.status !== 'booked') return;
    const res = eng.cancel(bookingId, { by: { kind: 'client', clientId: b.clientId } });
    if (res.promoted) {
      const s = eng.session(res.promoted.sessionId);
      const pid = res.promoted.id;
      push(Date.parse(s.startsAt) - 5 * MINUTE_MS, () => { const pb = eng.booking(pid); if (pb.status === 'booked') eng.checkIn(pid); });
    }
  };
  const tryBook = (p: Profile, clientId: ID, s: ClassSession) => {
    const by = { kind: 'client' as const, clientId };
    const attempt = () => eng.book(clientId, s.id, { by });
    try {
      let res;
      try { res = attempt(); } catch (e) {
        if (!(e instanceof StoreError) || e.code !== 'NO_CREDITS' || !buyFor(p, clientId)) return;
        res = attempt();
      }
      if (res.outcome === 'booked') scheduleOutcome(res.booking.id, s, clock.t);
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
    }
  };

  // Weekly booking intents: history + this week + a few for next week.
  const sessionsByWeekTpl = new Map<string, ClassSession>();
  for (const s of state.sessions) if (s.templateId) sessionsByWeekTpl.set(`${weekStart(studioDay(s.startsAt))}|${s.templateId}`, s);
  for (let w = 0; w < 8; w++) {
    const mon = addDays(historyFrom, w * 7);
    for (const { p, c } of sim) {
      if (p.lapseAfterWeek !== undefined && w > p.lapseAfterWeek) continue;
      const created = Date.parse(c.createdAt);
      const demand = p.plan === 'pr_mu' ? p.perWeek + 0.5 : p.plan.startsWith('pr_m') ? p.perWeek : p.perWeek * 1.6;
      let k = Math.floor(demand) + (rnd() < demand % 1 ? 1 : 0);
      if (!p.plan.startsWith('pr_m') && !p.plan.startsWith('intro') && rnd() < 0.08) k = 0;
      if (w === 7) k = Math.min(k, rnd() < 0.5 ? 1 : 0); // next week: only some have booked ahead
      if (p.first === 'Hannah' && w === 6) k = 1; // member persona: 1 of 2 left this week
      const options = [...(prefs.get(c.id) ?? [])].sort(() => rnd() - 0.5);
      for (const tid of options.slice(0, k)) {
        const s = sessionsByWeekTpl.get(`${mon}|${tid}`);
        if (!s) continue;
        const start = Date.parse(s.startsAt);
        let at = start - r(4, 96) * HOUR_MS;
        if (at < created + HOUR_MS) at = created + HOUR_MS;
        if (at >= start - HOUR_MS) continue;
        if (at >= nowT) at = nowT - r(0.5, 60) * HOUR_MS;
        if (at < created) continue;
        push(at, () => tryBook(p, c.id, s));
      }
    }
    // A couple of retail sales a week.
    for (let n = 0; n < 2 + Math.floor(rnd() * 2); n++) {
      const day = addDays(mon, Math.floor(rnd() * 6));
      const at = Date.parse(studioToUTC(day, pick(['06:05', '09:35', '18:05', '08:05'])));
      push(at, () => {
        const who = rnd() < 0.75 ? pick(sim).c.id : undefined;
        const productId = rnd() < 0.6 ? 'pr_socks' : 'pr_bottle';
        try { eng.checkout({ ...(who ? { clientId: who } : {}), items: [{ productId, qty: 1 }], method: rnd() < 0.75 ? 'card_reader' : 'cash', staffId: pick(['st_libby', 'st_gracep', 'st_julia']) }); } catch { /* out of stock */ }
      });
    }
  }

  // A class the studio cancelled two weeks ago (bookings removed, credits returned).
  const pastCancel = sessionsByWeekTpl.get(`${addDays(thisMon, -14)}|tp_mat_4_06`);
  if (pastCancel) push(Date.parse(pastCancel.startsAt) - 9 * HOUR_MS, () => eng.cancelSession(pastCancel.id, 'Instructor unwell — sorry for the late notice'));

  while (queue.length) {
    const ev = queue.shift() as Ev;
    clock.t = ev.at;
    eng.housekeeping();
    ev.run();
  }

  // ------------------------------------------------------------ scripted extras
  clock.t = nowT - 20 * MINUTE_MS;
  eng.housekeeping();
  const upcoming = state.sessions
    .filter((s) => s.status === 'scheduled' && s.classTypeId === 'ct_mat' && Date.parse(s.startsAt) > nowT + 5 * HOUR_MS && Date.parse(s.startsAt) < nowT + 7 * DAY_MS)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  // Two full classes with waitlists: the next Saturday 8am and the next popular 6pm.
  const fullTargets = [
    upcoming.find((s) => s.templateId === 'tp_mat_6_08'),
    upcoming.find((s) => s.templateId?.endsWith('_18') && s.templateId !== 'tp_mat_6_08'),
  ].filter((s): s is ClassSession => !!s);
  for (const s of fullTargets) {
    const order = [...sim].sort(() => rnd() - 0.5);
    let waitlisted = 0;
    for (const { c } of order) {
      if (c.firstName === 'Hannah') continue; // keep the member persona at 1 of 2 left this week
      clock.t = nowT - r(15, 600) * MINUTE_MS;
      const full = eng.counts(s.id).booked >= s.capacity;
      if (full && waitlisted >= 3) break;
      try {
        const res = eng.book(c.id, s.id, { by: { kind: 'client', clientId: c.id } });
        if (res.outcome === 'waitlisted') waitlisted++;
      } catch { /* no credit / already booked */ }
    }
  }
  clock.t = nowT - 10 * MINUTE_MS;

  // Persona: Chloe — brand new, no waiver, no passes.
  mkClient('cl_new', 'Chloe', 'Bennett', nowT - 25 * MINUTE_MS, { signed: false, marketingOptIn: true });

  // Persona: Jess — 4 class pack with 1 left.
  const jess = mkClient('cl_pack', 'Jess', 'Walker', nowT - 140 * DAY_MS, { birthday: '1991-03-22' });
  clock.t = Date.parse(studioToUTC(addDays(thisMon, -23), '19:40'));
  eng.checkout({ clientId: jess.id, items: [{ productId: 'pr_p4', qty: 1 }], method: 'card_online' });
  for (const w of [-3, -2, -1]) {
    const s = sessionsByWeekTpl.get(`${addDays(thisMon, w * 7)}|tp_mat_2_18`);
    if (!s) continue;
    const start = Date.parse(s.startsAt);
    clock.t = start - 26 * HOUR_MS;
    const res = eng.book(jess.id, s.id, { by: { kind: 'staff', staffId: 'st_libby' }, allowOverCapacity: true });
    res.booking.source = 'client';
    delete res.booking.bookedByStaffId;
    clock.t = start - 6 * MINUTE_MS;
    eng.checkIn(res.booking.id);
  }

  // Persona: Mia — intro offer, 2 classes done, 1 coming up.
  const mia = mkClient('cl_intro', 'Mia', 'Roberts', nowT - 5 * DAY_MS, {});
  clock.t = nowT - 4 * DAY_MS - 3 * HOUR_MS;
  eng.checkout({ clientId: mia.id, items: [{ productId: 'pr_intro', qty: 1 }], method: 'card_online' });
  const miaPast = state.sessions
    .filter((s) => s.status === 'scheduled' && s.classTypeId === 'ct_mat' && Date.parse(s.startsAt) > clock.t + 8 * HOUR_MS && Date.parse(s.endsAt) < nowT)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).filter((_, i) => i % 3 === 0).slice(0, 2);
  for (const s of miaPast) {
    const start = Date.parse(s.startsAt);
    clock.t = start - 7 * HOUR_MS;
    const res = eng.book(mia.id, s.id, { by: { kind: 'staff', staffId: 'st_libby' }, allowOverCapacity: true });
    res.booking.source = 'client';
    delete res.booking.bookedByStaffId;
    clock.t = start - 4 * MINUTE_MS;
    eng.checkIn(res.booking.id);
  }
  clock.t = nowT - 50 * MINUTE_MS;
  const miaNext = upcoming.find((s) => Date.parse(s.startsAt) > nowT + 20 * HOUR_MS && eng.counts(s.id).booked < s.capacity && !fullTargets.includes(s));
  if (miaNext) eng.book(mia.id, miaNext.id, { by: { kind: 'client', clientId: mia.id } });

  // Imported client with no waiver, sold an 8 pack at the desk and booked in by staff.
  const marg = mkClient('cl_import', 'Margaret', 'Hollis', nowT - 700 * DAY_MS, {
    signed: false, source: 'import', birthday: '1958-07-09', staffNotes: 'Imported from Momence — needs to sign the new waiver at her next class.',
  });
  clock.t = nowT - 9 * DAY_MS;
  eng.checkout({ clientId: marg.id, items: [{ productId: 'pr_p8', qty: 1 }], method: 'cash', staffId: 'st_libby' });
  const margPast = state.sessions.find((s) => s.templateId === 'tp_mat_2_09' && Date.parse(s.startsAt) > clock.t && Date.parse(s.endsAt) < nowT)
    ?? state.sessions.find((s) => s.templateId === 'tp_mat_4_09' && Date.parse(s.startsAt) > clock.t && Date.parse(s.endsAt) < nowT);
  if (margPast) {
    clock.t = Date.parse(margPast.startsAt) - 20 * HOUR_MS;
    const res = eng.book(marg.id, margPast.id, { by: { kind: 'staff', staffId: 'st_libby' }, allowOverCapacity: true });
    clock.t = Date.parse(margPast.startsAt) - 3 * MINUTE_MS;
    eng.checkIn(res.booking.id);
  }
  clock.t = nowT - 30 * MINUTE_MS;
  const margNext = upcoming.find((s) => (s.templateId === 'tp_mat_2_09' || s.templateId === 'tp_mat_4_09') && eng.counts(s.id).booked < s.capacity)
    ?? upcoming.find((s) => !fullTargets.includes(s) && eng.counts(s.id).booked < s.capacity);
  if (margNext) eng.book(marg.id, margNext.id, { by: { kind: 'staff', staffId: 'st_gracep' } });

  // A recent sign-up who hasn't bought anything yet (intro eligible).
  mkClient('cl_isla', 'Isla', 'Grant', nowT - 2 * DAY_MS - 5 * HOUR_MS, { marketingOptIn: true });

  // Persona: Sophie — a mum with a baby dependant (Poppy), both booked into the next Mums + Bubs on her 4 class pack.
  const sophie = mkClient('cl_family', 'Sophie', 'Archer', nowT - 60 * DAY_MS, {
    email: PERSONA_EMAILS.family, mums: true, birthday: '1992-05-14', injuries: 'Postnatal (5 months) — cleared by women’s health physio.',
  });
  clock.t = nowT - 45 * DAY_MS;
  eng.checkout({ clientId: sophie.id, items: [{ productId: 'pr_p4', qty: 1 }], method: 'card_online' });
  clock.t = nowT - 44 * DAY_MS;
  const poppy: Client = {
    id: 'cl_family_poppy', firstName: 'Poppy', lastName: 'Archer', email: '', createdAt: new Date(clock.t).toISOString(), marketingOptIn: false, source: 'app',
    guardianClientId: sophie.id, birthday: studioDay(new Date(nowT - 150 * DAY_MS)), waiverSignedAt: new Date(clock.t).toISOString(),
    healthForm: { answers: {}, submittedAt: new Date(clock.t).toISOString() }, injuries: 'Crawling soon. Bring a mat and a bouncer.',
    emergencyContactName: 'Sophie Archer', emergencyContactPhone: sophie.phone ?? '',
  };
  eng.addClient(poppy);
  clock.t = nowT - 20 * MINUTE_MS;
  const mumsNext = state.sessions
    .filter((x) => x.status === 'scheduled' && x.classTypeId === 'ct_mums' && Date.parse(x.startsAt) > nowT + 12 * HOUR_MS && Date.parse(x.startsAt) < nowT + 10 * DAY_MS)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).find((x) => eng.counts(x.id).booked + 2 <= x.capacity);
  if (mumsNext) for (const id of [sophie.id, poppy.id]) eng.book(id, mumsNext.id, { by: { kind: 'client', clientId: sophie.id } });

  // Make sure Hannah (member persona) has something coming up.
  const hannah = sim.find((x) => x.p.first === 'Hannah')?.c;
  if (hannah && !state.bookings.some((b) => b.clientId === hannah.id && b.status === 'booked' && Date.parse(eng.session(b.sessionId).startsAt) > nowT)) {
    clock.t = nowT - 3 * HOUR_MS;
    for (const s of upcoming) {
      if (fullTargets.includes(s) || studioDay(s.startsAt) < addDays(thisMon, 7)) continue;
      try { eng.book(hannah.id, s.id, { by: { kind: 'client', clientId: hannah.id } }); break; } catch { /* try next */ }
    }
  }

  // A few everyday studio events: a paused and a cancelled membership, a goodwill credit, a refund, cancelled classes.
  clock.t = nowT - 26 * HOUR_MS;
  const memberPass = (first: string) => { const c = byName(first); return c ? state.passes.find((x) => x.clientId === c.id && x.kind === 'membership' && x.status === 'active') : undefined; };
  const lucyPass = memberPass('Lucy');
  if (lucyPass) eng.pause(lucyPass.id, addDays(thisMon, 7), addDays(thisMon, 20));
  const matildaPass = memberPass('Matilda');
  if (matildaPass) eng.cancelMembership(matildaPass.id);
  const olivia = byName('Olivia');
  const oliviaPack = olivia && state.passes.filter((x) => x.clientId === olivia.id && x.status === 'active').pop();
  if (oliviaPack) eng.adjust(oliviaPack.id, { creditsDelta: 1, reason: 'Goodwill credit — class moved at short notice' }, 'st_libby');
  const bottleSale = [...state.sales].reverse().find((x) => x.items.some((i) => i.productId === 'pr_bottle') && Date.parse(x.createdAt) < nowT - 3 * DAY_MS);
  if (bottleSale) { clock.t = Date.parse(bottleSale.createdAt) + 2 * DAY_MS; eng.refund(bottleSale.id, { reason: 'Faulty lid — refunded' }); }
  clock.t = nowT - 15 * MINUTE_MS;
  const nextWeekFri = state.sessions.find((x) => x.templateId === 'tp_mat_5_06' && studioDay(x.startsAt) === addDays(thisMon, 11));
  if (nextWeekFri) eng.cancelSession(nextWeekFri.id, 'Libby is away at a workshop — sorry!');

  // Anything left 'booked' in a finished class gets checked in (e.g. promoted late, persona bookings).
  for (const b of state.bookings) {
    if (b.status !== 'booked') continue;
    const s = eng.session(b.sessionId);
    if (Date.parse(s.endsAt) <= nowT) { clock.t = Date.parse(s.startsAt) - 5 * MINUTE_MS; eng.checkIn(b.id); }
  }

  clock.t = nowT;
  eng.housekeeping();
  state.sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  state.clients.sort((a, b) => a.id.localeCompare(b.id));
  return state;
}
