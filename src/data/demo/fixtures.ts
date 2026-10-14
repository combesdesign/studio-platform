/** Static studio setup for the demo: settings, staff, class types, products, weekly timetable. */
import type { ClassType, Product, ScheduleTemplate, Staff, StudioSettings } from '../../shared/types';

export const HEALTH_QUESTIONS = [
  'Do you have any current injuries, or have you had surgery in the last 12 months?',
  'Are you pregnant, or have you had a baby in the last 12 months?',
  'Do you have a heart condition, high or low blood pressure, or have you felt chest pain or dizziness when exercising?',
  'Do you have any back, neck or joint pain?',
  'Has a doctor or health professional advised you not to exercise?',
  'Is there anything else your instructor should know?',
];

export const WAIVER_TEXT = `Welcome to Snowy Pilates Club. Before your first class, please read and agree to the following.

1. Exercise involves physical exertion. I take part in classes voluntarily and at my own risk, and I'll work within my own limits.
2. I've answered the health questions honestly, and I'll tell my instructor before class about any injury, condition, pregnancy or change in my health.
3. If I'm unsure whether Pilates is right for me, I'll get clearance from my doctor or health professional before taking part.
4. I'll follow my instructor's guidance, use equipment as shown, and stop and let them know if I feel pain, dizziness or discomfort.
5. Snowy Pilates Club and its instructors aren't liable for any injury, loss or damage arising from my participation, except where caused by their negligence or where the law says otherwise.
6. I agree to the studio's booking, cancellation and waitlist policies.

By signing, I confirm I've read and understood this waiver.`;

export const CANCELLATION_POLICY = 'Life happens! Cancel at least 3 hours before class and your credit goes straight back to you. Cancellations within 3 hours of class, and no-shows, lose the credit. Running late or need a hand? Just let us know.';
export const WAITLIST_POLICY = "If a class is full, join the waitlist — no credit is taken. If a spot opens up, the first person on the waitlist with an available credit is booked in automatically and we'll let you know. Automatic bookings stop 1 hour before class, and the waitlist is cleared when class starts. If you're booked in from the waitlist, the usual cancellation policy applies.";

export function defaultSettings(): StudioSettings {
  return {
    name: 'Snowy Pilates Club',
    timezone: 'Australia/Sydney',
    address: '57 Vale Street, Cooma NSW 2630',
    email: 'hello@snowypilatesclub.com',
    phone: '0400 123 456',
    abn: '12 345 678 901',
    gstRegistered: true,
    cancelWindowHours: 3,
    waitlistCutoffHours: 1,
    lateCancelFeeCents: 0,
    noShowFeeCents: 0,
    bookingWindowDays: 14,
    defaultCapacity: 14,
    waiverText: WAIVER_TEXT,
    healthQuestions: [...HEALTH_QUESTIONS],
    cancellationPolicyText: CANCELLATION_POLICY,
    waitlistPolicyText: WAITLIST_POLICY,
  };
}

export const STAFF: Staff[] = [
  { id: 'st_libby', name: 'Libby', email: 'libby@snowypilatesclub.com', role: 'owner', photoUrl: 'img/libby.webp', active: true,
    bio: "Libby is the owner of Snowy Pilates Club. Her classes are fun, achievable and leave you feeling stronger every week — whatever your starting point." },
  { id: 'st_julia', name: 'Julia', email: 'julia@snowypilatesclub.com', role: 'instructor', photoUrl: 'img/julia.webp', payPerClassCents: 6000, active: true,
    bio: "A real life angel — Julia's style is the perfect mix of satisfying and challenging where you leave every class realising what you are capable of." },
  { id: 'st_gracet', name: 'Grace T', email: 'grace.t@snowypilatesclub.com', role: 'instructor', photoUrl: 'img/grace-t.webp', payPerClassCents: 6000, active: true,
    bio: "Grace's bright smile and easy going nature will put you at ease instantly and her workouts will give you that signature pilates burn you've been looking for." },
  { id: 'st_gracep', name: 'Grace P', email: 'grace.p@snowypilatesclub.com', role: 'front_desk', photoUrl: 'img/grace-p.webp', payPerClassCents: 5500, active: true,
    bio: "Grace P runs our Mums + Bubs classes and helps out on the front desk. Gentle, encouraging and all about rebuilding strength from the inside out." },
];

export const CLASS_TYPES: ClassType[] = [
  { id: 'ct_mat', name: 'Mat Essentials', level: 'All levels', durationMin: 55, color: '#5069AC', defaultCapacity: 14, bookable: true, active: true,
    description: 'Our signature mat class. A full-body Pilates workout focused on core strength, control and mobility — suitable for every level, with options to make it easier or harder.' },
  { id: 'ct_mums', name: 'Mums + Bubs', level: 'Postnatal', durationMin: 45, color: '#85A2D1', defaultCapacity: 14, bookable: true, active: true,
    description: 'A gentle postnatal class to rebuild your core and pelvic floor, with bub right there beside you.',
    bookingNote: 'Mums must have clearance from a women’s health professional before booking. Bring a blanket, mat, bouncer or pram for bub. Crawling babies need to be in a seat or pram.' },
  { id: 'ct_sculpt', name: 'Strength + Sculpt', level: 'Intermediate', durationMin: 50, color: '#E3D2A3', defaultCapacity: 14, bookable: false, active: true,
    description: 'Pilates-based strength training with light weights and resistance bands. Coming soon — register your interest.' },
];

export const PRODUCTS: Product[] = [
  { id: 'pr_intro', kind: 'intro', name: 'Intro offer — 2 weeks unlimited', description: "Feel stronger, more confident and enjoy movement. Enjoy two weeks of unlimited classes. Don't be afraid to do something new – it might be the best thing you ever do!", priceCents: 4900, credits: null, validityDays: 14, newClientsOnly: true, active: true, sortOrder: 1, highlight: 'New clients' },
  { id: 'pr_m1', kind: 'membership', name: '1 class per week', description: 'A perfect option if you want to add pilates to your current routine. Receive 1 class credit each week to book into whatever class suits your schedule that week.', priceCents: 2200, credits: 1, validityDays: null, billingInterval: 'week', active: true, sortOrder: 10 },
  { id: 'pr_m2', kind: 'membership', name: '2 classes per week', description: 'What we recommend for those wanting to be consistent with their pilates practice! Receive 2 class credits each week.', priceCents: 4000, credits: 2, validityDays: null, billingInterval: 'week', active: true, sortOrder: 11, highlight: 'Recommended' },
  { id: 'pr_m3', kind: 'membership', name: '3 classes per week', description: 'This is for those wanting to make a commitment to their movement, to really feel the changes in their body and minds, and make pilates part of their weekly routine!', priceCents: 5500, credits: 3, validityDays: null, billingInterval: 'week', active: true, sortOrder: 12 },
  { id: 'pr_mu', kind: 'membership', name: 'Unlimited', description: 'You will have access to an unlimited number of classes every single week! For the pilates addict who makes this their daily habit.', priceCents: 6900, credits: null, validityDays: null, billingInterval: 'week', active: true, sortOrder: 13 },
  { id: 'pr_drop', kind: 'dropin', name: 'Single class', description: 'One class credit to use on any class.', priceCents: 3000, credits: 1, validityDays: 61, active: true, sortOrder: 20 },
  { id: 'pr_p4', kind: 'pack', name: '4 class pack', description: 'Keep it casual with our 4 class pack. This gives you the flexibility to book into 4 classes at anytime during an 8 week period (expires in 2 months from first use).', priceCents: 10000, credits: 4, validityDays: 61, active: true, sortOrder: 21 },
  { id: 'pr_p8', kind: 'pack', name: '8 class pack', description: 'Prefer to buy in bulk but want some flexibility? This gives you 8 class credits to use within 4 months (expires in 4 months from first use).', priceCents: 19000, credits: 8, validityDays: 122, active: true, sortOrder: 22 },
  { id: 'pr_socks', kind: 'retail', name: 'Grip socks', description: 'Snowy Pilates Club grip socks. One size.', priceCents: 2000, stock: 24, active: true, sortOrder: 30 },
  { id: 'pr_bottle', kind: 'retail', name: 'Water bottle', description: 'Insulated Snowy Pilates Club water bottle.', priceCents: 1500, stock: 18, active: true, sortOrder: 31 },
];

/** Weekly timetable. weekday: 0 = Sun … 6 = Sat. */
export function templates(startsOn: string): ScheduleTemplate[] {
  const rot = ['st_libby', 'st_julia', 'st_gracet'];
  const out: ScheduleTemplate[] = [];
  let i = 0;
  for (let wd = 1; wd <= 5; wd++) {
    for (const t of ['06:00', '18:00']) {
      out.push({ id: `tp_mat_${wd}_${t.slice(0, 2)}`, classTypeId: 'ct_mat', weekday: wd, startTime: t, instructorId: rot[i % 3] ?? 'st_libby', startsOn, active: true });
      i++;
    }
  }
  out.push({ id: 'tp_mat_2_09', classTypeId: 'ct_mat', weekday: 2, startTime: '09:30', instructorId: 'st_libby', startsOn, active: true });
  out.push({ id: 'tp_mat_4_09', classTypeId: 'ct_mat', weekday: 4, startTime: '09:30', instructorId: 'st_gracet', startsOn, active: true });
  out.push({ id: 'tp_mat_6_08', classTypeId: 'ct_mat', weekday: 6, startTime: '08:00', instructorId: 'st_libby', startsOn, active: true });
  out.push({ id: 'tp_mums_3_10', classTypeId: 'ct_mums', weekday: 3, startTime: '10:30', instructorId: 'st_gracep', startsOn, active: true });
  return out;
}
