/**
 * Demo seed for one studio: starter segments and tags, a few past campaigns with stats (plus a draft and a scheduled
 * one), every automation switched on with some history in the sent log, and a handful of inbox threads. Built only from
 * the studio's own demo data (its clients, products, class types, staff), so Snowy and Harbour each read as themselves.
 */
import type { DemoState } from '../../data/demo/engine';
import { DAY_MS, HOUR_MS } from '../../domain';
import { addDays, money, studioDate, studioToUTC } from '../../shared/format';
import type { ID, Studio } from '../../shared/types';
import { STARTER_SEGMENTS, automationDef, defaultAutomations } from './catalog';
import { automationCandidates, buildAudience, filterAudience } from './segments';
import {
  audienceOf, deliverCampaign, emptySlice, hash, snapshot, type Slice, type StoredCampaign, type StoredLog,
} from './slice';
import type { AudienceMember, EmailBlock } from './types';

type NewId = (prefix: string) => ID;

const block = (id: string, type: EmailBlock['type'], rest: Partial<EmailBlock> = {}): EmailBlock => ({ id, type, ...rest });

export function seedMarketing(args: { studio: Studio; state: DemoState; now: Date; newId: NewId }): Slice {
  const { studio, state, now, newId } = args;
  const slice = emptySlice();
  const nowMs = now.getTime();
  const iso = (t: number) => new Date(t).toISOString();
  const appUrl = 'https://app.example.test/';

  // ---------------------------------------------------------------- segments
  slice.segments = STARTER_SEGMENTS.map((s, i) => ({
    id: newId('sg'), name: s.name, description: s.description, filter: JSON.parse(JSON.stringify(s.filter)), createdAt: iso(nowMs - (60 - i) * DAY_MS),
  }));
  const seg = (name: string) => slice.segments.find((s) => s.name === name)!;

  // ---------------------------------------------------------------- tags: the regulars get VIP
  const visitCount = new Map<ID, number>();
  for (const v of snapshot(state, now, {}).visits) visitCount.set(v.clientId, (visitCount.get(v.clientId) ?? 0) + 1);
  const regulars = state.clients.filter((c) => !c.archived && c.marketingOptIn)
    .sort((a, b) => (visitCount.get(b.id) ?? 0) - (visitCount.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  regulars.slice(0, 3).forEach((c) => { slice.tags[c.id] = ['VIP']; });
  regulars.slice(3, 5).forEach((c) => { slice.tags[c.id] = ['Ambassador']; });
  if (regulars[5]) slice.tags[regulars[5].id] = ['Local business'];

  const members = audienceOf(state, now, slice.tags);
  const optedIn = members.filter((m) => m.optIn);
  const reachFor = (name: string, channel: 'email' | 'sms'): { id: ID; name: string; fallback: boolean } => {
    const s = seg(name);
    const n = filterAudience(optedIn, s.filter, now).filter((m) => (channel === 'sms' ? !!m.phone : !!m.email)).length;
    return n >= 3 ? { id: s.id, name: s.name, fallback: false } : { id: seg('Opted into marketing').id, name: 'Opted into marketing', fallback: true };
  };

  // ---------------------------------------------------------------- campaigns
  const intro = state.products.find((p) => p.kind === 'intro' && p.active);
  const pack = state.products.find((p) => (p.kind === 'pack') && p.active);
  const firstType = state.classTypes.find((c) => c.active && c.bookable);
  const hero = studio.branding.photos.hero;
  const offer = studio.branding.photos.offer ?? hero;
  const introLine = intro ? `${intro.name} is ${money(intro.priceCents)}` : 'Our intro offer is a great way to start';
  const author = state.staff.find((s) => s.role === 'owner' && s.active)?.name ?? state.staff[0]?.name ?? 'The team';

  const mk = (c: Omit<StoredCampaign, 'id' | 'createdAt' | 'audience' | 'skipped' | 'unsubscribed' | 'status'> & { daysAgo: number; status?: StoredCampaign['status'] }): StoredCampaign => {
    const { daysAgo, ...rest } = c;
    return { id: newId('cp'), createdAt: iso(nowMs - (daysAgo + 1) * DAY_MS), createdByName: author, audience: 0, skipped: 0, unsubscribed: 0, status: 'draft', ...rest };
  };
  const send = (c: StoredCampaign, daysAgo: number, hour: number) => {
    const day = addDays(studioDate(now), -daysAgo);
    const at = new Date(studioToUTC(day, `${String(hour).padStart(2, '0')}:00`));
    const sel = slice.segments.find((s) => s.id === c.segmentId);
    const people = sel ? filterAudience(members, sel.filter, now) : members;
    c.filterAtSend = sel?.filter;
    deliverCampaign(slice, c, people, newId, at, false);
  };

  const spring = reachFor('Opted into marketing', 'email');
  const c1 = mk({
    daysAgo: 4, name: 'Fresh start offer', channel: 'email', segmentId: spring.id, segmentName: spring.name,
    subject: 'A fresh start at {{studio_name}}', preheader: `${introLine}. New clients only.`,
    blocks: [
      block('b1', 'heading', { text: 'Your fresh *start*' }),
      block('b2', 'image', { src: offer ?? hero, alt: `Inside ${studio.name}` }),
      block('b3', 'text', { text: `Hi {{first_name}},\n\n${introLine}${intro?.validityDays ? ` for ${intro.validityDays} days of unlimited classes` : ''}, and it is the easiest way to bring a friend along for the first time.\n\nForward this to someone who keeps saying they’ll come along. We’ll take care of the rest.` }),
      block('b4', 'button', { label: 'See the intro offer', url: '{{app_url}}' }),
    ],
  });
  send(c1, 4, 9);

  const low = reachFor('Pack running low', 'email');
  const c2 = mk(low.fallback ? {
    daysAgo: 12, name: 'Which pass suits you?', channel: 'email', segmentId: low.id, segmentName: low.name,
    subject: 'Which pass suits you?', preheader: 'Memberships, packs and drop-ins, side by side.',
    blocks: [
      block('b1', 'heading', { text: 'Find your *fit*' }),
      block('b2', 'text', { text: `Hi {{first_name}}, whether you come once a week or most days, there’s a pass that fits${pack ? `. A ${pack.name} is ${money(pack.priceCents)}` : ''} and memberships save you more the more you come.\n\nHave a look in the app, or message us and we’ll help you choose.` }),
      block('b3', 'divider'),
      block('b4', 'button', { label: 'See passes', url: '{{app_url}}' }),
    ],
  } : {
    daysAgo: 12, name: 'Top up before it runs out', channel: 'email', segmentId: low.id, segmentName: low.name,
    subject: 'Your credits are almost up', preheader: 'A quick nudge before your pack runs out.',
    blocks: [
      block('b1', 'heading', { text: 'Almost *there*' }),
      block('b2', 'text', { text: `Hi {{first_name}}, you’re close to the end of your pack${pack ? `. A new ${pack.name} is ${money(pack.priceCents)}` : ''} and you can pick one up in the app in under a minute.\n\nNo rush, but credits don’t last forever.` }),
      block('b3', 'divider'),
      block('b4', 'button', { label: 'Top up in the app', url: '{{app_url}}' }),
    ],
  });
  send(c2, 12, 10);

  const act = reachFor('Active members', 'sms');
  const c3 = mk({
    daysAgo: 19, name: 'Timetable change (text)', channel: 'sms', segmentId: act.id, segmentName: act.name,
    body: `Hi {{first_name}}, a heads up from {{studio_name}}: ${firstType ? `${firstType.name} on Thursday` : 'Thursday’s class'} starts 30 mins later this week. Cancel in the app if it no longer suits and we’ll return your credit.`,
  });
  send(c3, 19, 16);

  const team = state.staff.filter((x) => x.active && (x.role === 'owner' || x.role === 'instructor')).map((x) => x.name.split(' ')[0]);
  const c4 = mk({
    daysAgo: 33, name: 'Meet the team', channel: 'email', segmentId: spring.id, segmentName: spring.name,
    subject: 'Meet your instructors', preheader: 'The people behind your favourite classes.',
    blocks: [
      block('b1', 'heading', { text: 'Meet your *instructors*' }),
      block('b2', 'text', { text: `Hi {{first_name}},\n\nEvery class at {{studio_name}} is led by someone who loves what they do${team.length ? `: ${team.slice(0, 4).join(', ')}` : ''}.\n\nNext time you’re in, say hello. They’d love to know what you’re working on.` }),
      block('b3', 'button', { label: 'See the timetable', url: '{{app_url}}' }),
    ],
  });
  send(c4, 33, 9);

  const bdays = slice.segments.find((s) => s.name === 'Birthday this month')!;
  const hasBdays = filterAudience(optedIn, bdays.filter, now).length > 0;
  const sched = hasBdays ? bdays : seg('Active members');
  const tomorrow = addDays(studioDate(now), 1);
  const c5 = mk({
    daysAgo: 1, name: hasBdays ? 'Birthday month treat' : 'Bring a friend week', channel: 'email', segmentId: sched.id, segmentName: sched.name, status: 'scheduled',
    subject: hasBdays ? 'A little birthday something' : 'Bring a friend this week', preheader: hasBdays ? 'Celebrate with a class on us.' : 'Share the love, book together.',
    scheduledFor: studioToUTC(tomorrow, '09:00'),
    blocks: [
      block('b1', 'heading', { text: hasBdays ? 'Happy birthday *month*' : 'Bring a *friend*' }),
      block('b2', 'text', { text: hasBdays ? 'Hi {{first_name}}, birthdays are better with a class. Book any time this month and bring a friend along.' : 'Hi {{first_name}}, classes are better with company. Book two spots together this week and bring someone along.' }),
      block('b3', 'button', { label: 'Book a class', url: '{{app_url}}' }),
    ],
  });
  const act2 = seg('Active members');
  const c6 = mk({
    daysAgo: 0, name: 'New term timetable', channel: 'email', segmentId: act2.id, segmentName: act2.name,
    subject: 'The new timetable is here', preheader: 'Some old favourites, a couple of new times.',
    blocks: [
      block('b1', 'heading', { text: 'A fresh *timetable*' }),
      block('b2', 'text', { text: 'Hi {{first_name}},\n\nWe’ve tweaked a few class times next term. Have a look and book your regulars early.' }),
      block('b3', 'button', { label: 'See the timetable', url: '{{app_url}}' }),
    ],
  });
  slice.campaigns = [c5, c6, c1, c2, c3, c4];

  // ---------------------------------------------------------------- automations: all on, with some history
  slice.automations = defaultAutomations().map((a) => ({ ...a, updatedAt: iso(nowMs - 30 * DAY_MS) }));
  const sentKeys = new Set<string>();
  const logAutomation = (item: { key: string; clientId: ID; clientName: string; channel: 'email' | 'sms'; to: string; subject: string; dedupeKey: string }, at: number, idx: number) => {
    sentKeys.add(item.dedupeKey);
    const h = hash(item.dedupeKey);
    const e: StoredLog = {
      id: newId('ml'), channel: item.channel, source: 'automation', refId: item.key, refName: automationDef(item.key as never).name,
      clientId: item.clientId, clientName: item.clientName, to: item.to, status: 'sent', sentAt: iso(at), subject: item.subject, dedupeKey: item.dedupeKey,
    };
    if (item.channel === 'email' && (h + idx) % 100 < 52) e.openedAt = iso(at + 600_000 + (h % 7_200_000));
    slice.log.push(e);
  };
  // Replay the last two weeks day by day (as the scheduler would have), leaving today open so the demo has people waiting.
  let n = 0;
  for (let d = 14; d >= 1; d--) {
    const then = new Date(nowMs - d * DAY_MS);
    const snap = snapshot(state, then, slice.tags);
    snap.clients = snap.clients.filter((c) => Date.parse(c.createdAt) <= then.getTime());
    const asOf = buildThen(snap, then);
    const plan = automationCandidates(
      slice.automations.filter((a) => ['welcome', 'welcome_followup', 'after_first_class', 'birthday', 'winback'].includes(a.key)),
      asOf, { now: then, studioName: studio.name, appUrl, sentKeys },
    );
    for (const it of plan.items) logAutomation(it, then.getTime() + 9 * HOUR_MS + (hash(it.dedupeKey) % HOUR_MS), n++);
  }

  // ---------------------------------------------------------------- inbox
  const emailOf = new Map(state.clients.map((c) => [c.email.toLowerCase(), c.id]));
  const persona = (i: number): ID | undefined => (state.personas?.[i] ? emailOf.get(state.personas[i]!.toLowerCase()) : undefined);
  const used = new Set<ID>();
  const pick = (pref: ID | undefined, offset: number): ID => {
    const pool = [...state.clients].filter((c) => !c.archived && !used.has(c.id));
    const id = pref && !used.has(pref) ? pref : pool[offset % Math.max(1, pool.length)]?.id ?? state.clients[0]!.id;
    used.add(id);
    return id;
  };
  const staffReply = state.staff.find((s) => s.active && (s.role === 'front_desk' || s.role === 'owner')) ?? state.staff[0]!;
  const owner = state.staff.find((s) => s.role === 'owner' && s.active) ?? staffReply;
  const thread = (clientId: ID, msgs: { from: 'client' | 'staff'; body: string; hoursAgo: number; by?: string }[], readByStaff: boolean, readByClient: boolean) => {
    const id = newId('th');
    const sorted = [...msgs].sort((a, b) => b.hoursAgo - a.hoursAgo);
    let staffUnread = 0, clientUnread = 0;
    sorted.forEach((m, i) => {
      slice.messages.push({ id: newId('mm'), threadId: id, from: m.from, ...(m.from === 'staff' ? { staffName: m.by ?? staffReply.name } : {}), body: m.body, at: iso(nowMs - m.hoursAgo * HOUR_MS - i * 1000) });
    });
    // Unread = the trailing run of messages from the other side, if that side hasn't read them.
    let k = sorted.length - 1;
    const lastFrom = sorted[k]!.from;
    while (k >= 0 && sorted[k]!.from === lastFrom) { if (lastFrom === 'client' && !readByStaff) staffUnread++; if (lastFrom === 'staff' && !readByClient) clientUnread++; k--; }
    slice.threads.push({ id, clientId, createdAt: iso(nowMs - sorted[0]!.hoursAgo * HOUR_MS), staffUnread, clientUnread });
  };

  thread(pick(persona(0), 0), [
    { from: 'client', hoursAgo: 3.2, body: 'Hi! I’m coming to my first class this week. Is there anything I should bring?' },
    { from: 'client', hoursAgo: 3.1, body: 'And is it okay to arrive a few minutes early to get set up?' },
  ], false, true);
  thread(pick(persona(1), 1), [
    { from: 'client', hoursAgo: 52, body: 'Could I move my Thursday class to Friday this week? Work has gone a bit sideways.' },
    { from: 'staff', hoursAgo: 50, body: 'Of course. I’ve moved you across, and you’ll see it in your bookings now. See you Friday!' },
    { from: 'client', hoursAgo: 49.5, body: 'Perfect, thank you so much!' },
  ], true, true);
  thread(pick(persona(2), 2), [
    { from: 'client', hoursAgo: 30, body: 'My pack runs out next week but I’ve been sick and missed a few classes. Is there any chance of an extension?' },
    { from: 'staff', hoursAgo: 5, body: 'So sorry to hear you’ve been unwell. We’ve added another week to your pack, so you’ll have a bit more time to use your credits. Hope you’re feeling better soon.', by: owner.name },
  ], true, false);
  thread(pick(persona(3), 3), [
    { from: 'staff', hoursAgo: 28, body: 'Hi! How are you finding your first couple of weeks? Let us know if there’s anything we can help with.', by: owner.name },
    { from: 'client', hoursAgo: 20, body: 'Loving it so far. Is the Saturday morning class usually full? I’d like to try it.' },
  ], false, true);
  thread(pick(undefined, 4), [
    { from: 'client', hoursAgo: 9, body: 'Hello, are there any classes that suit someone about 30 weeks pregnant?' },
  ], false, true);
  thread(pick(undefined, 5), [
    { from: 'client', hoursAgo: 120, body: 'Just wanted to say thanks for such a lovely class today. Exactly what I needed!' },
    { from: 'staff', hoursAgo: 118, body: 'That’s so kind, thank you! We loved having you. See you again soon.' },
  ], true, true);

  // ---------------------------------------------------------------- push devices + sender settings
  slice.devices = [
    { id: newId('pd'), who: `staff:${owner.id}`, platform: 'web', token: 'demo-web-owner', at: iso(nowMs - 9 * DAY_MS) },
    { id: newId('pd'), who: `staff:${staffReply.id}`, platform: 'ios', token: 'demo-ios-desk', at: iso(nowMs - 5 * DAY_MS) },
  ];
  slice.settings = { fromName: studio.name, replyTo: studio.email, smsSender: '', footerNote: '' };
  return slice;
}

/** Audience as it looked at a past moment, for replaying the scheduler. */
function buildThen(snap: ReturnType<typeof snapshot>, then: Date): AudienceMember[] {
  snap.passes = snap.passes.filter((p) => Date.parse(p.purchasedAt) <= then.getTime());
  return buildAudience(snap);
}
