/**
 * The fixed lists the marketing feature is built from: segment rule types, the automations (what triggers each,
 * what its delay means, its default copy) and the starter segments every studio gets. Copy uses merge tags and
 * the studio's name, never a hard-coded studio. The SQL defaults (app.marketing_default_automations) mirror this file.
 */
import type { Automation, AutomationKey, SegmentFilter, SegmentRule, SegmentRuleType } from './types';

// ------------------------------------------------------------------ segment rules

export interface RuleDef {
  type: SegmentRuleType;
  label: string;
  /** Plain-English description of the rule. */
  hint: string;
  /** Which extra fields the rule takes. */
  params?: ('days' | 'credits' | 'tag')[];
  defaults?: Partial<SegmentRule>;
}

export const RULE_DEFS: RuleDef[] = [
  { type: 'active_member', label: 'Active member', hint: 'Has a membership that is running (not paused or cancelled).' },
  { type: 'pack_low', label: 'Pack running low', hint: 'Has a pack with few credits left, or one about to expire.', params: ['credits', 'days'], defaults: { credits: 1, days: 7 } },
  { type: 'no_visit', label: 'No visit lately', hint: 'Has been to class before, but not for a while.', params: ['days'], defaults: { days: 30 } },
  { type: 'intro', label: 'On the intro offer', hint: 'Is on the new-client intro offer right now.' },
  { type: 'birthday_month', label: 'Birthday this month', hint: 'Their birthday is in the current month.' },
  { type: 'opted_in', label: 'Opted into marketing', hint: 'Said yes to news and offers.' },
  { type: 'tag', label: 'Has the tag', hint: 'You added this tag to their profile.', params: ['tag'], defaults: { tag: '' } },
  { type: 'new_client', label: 'Joined recently', hint: 'Signed up in the last few days.', params: ['days'], defaults: { days: 30 } },
];
export const ruleDef = (t: SegmentRuleType): RuleDef => RULE_DEFS.find((d) => d.type === t) ?? RULE_DEFS[0]!;

/** "No visit in 30 days", "Not on the intro offer", "Tagged VIP". */
export function describeRule(r: SegmentRule): string {
  switch (r.type) {
    case 'active_member': return r.not ? 'Not an active member' : 'Active member';
    case 'pack_low': {
      const c = r.credits ?? 1, d = r.days ?? 7;
      return `${r.not ? 'No pack running low' : 'Pack running low'} (${c} ${c === 1 ? 'credit' : 'credits'} or fewer, or expiring within ${d} days)`;
    }
    case 'no_visit': return r.not ? `Visited in the last ${r.days ?? 30} days` : `No visit in ${r.days ?? 30} days`;
    case 'intro': return r.not ? 'Not on the intro offer' : 'On the intro offer';
    case 'birthday_month': return r.not ? 'Birthday not this month' : 'Birthday this month';
    case 'opted_in': return r.not ? 'Not opted into marketing' : 'Opted into marketing';
    case 'tag': return `${r.not ? 'Not tagged' : 'Tagged'} ${r.tag || '…'}`;
    case 'new_client': return r.not ? `Joined over ${r.days ?? 30} days ago` : `Joined in the last ${r.days ?? 30} days`;
  }
}

export function describeFilter(f: SegmentFilter): string {
  if (!f.rules.length) return 'Everyone';
  return f.rules.map(describeRule).join(f.match === 'any' ? ' or ' : ' and ');
}

// ------------------------------------------------------------------ starter segments

export const STARTER_SEGMENTS: { name: string; description: string; filter: SegmentFilter }[] = [
  { name: 'Active members', description: 'Everyone with a running membership.', filter: { match: 'all', rules: [{ type: 'active_member' }] } },
  { name: 'Pack running low', description: 'One credit left, or a pack expiring this week.', filter: { match: 'all', rules: [{ type: 'pack_low', credits: 1, days: 7 }] } },
  { name: 'No visit in 30 days', description: 'Came before, then went quiet.', filter: { match: 'all', rules: [{ type: 'no_visit', days: 30 }] } },
  { name: 'Intro offer clients', description: 'New clients on their intro offer.', filter: { match: 'all', rules: [{ type: 'intro' }] } },
  { name: 'Birthday this month', description: 'Birthdays in the current month.', filter: { match: 'all', rules: [{ type: 'birthday_month' }] } },
  { name: 'Opted into marketing', description: 'Everyone who said yes to news and offers.', filter: { match: 'all', rules: [{ type: 'opted_in' }] } },
  { name: 'VIP', description: 'Clients you have tagged VIP.', filter: { match: 'all', rules: [{ type: 'tag', tag: 'VIP' }] } },
];

// ------------------------------------------------------------------ automations

export interface AutomationDef {
  key: AutomationKey;
  name: string;
  /** One line for the card. */
  description: string;
  /** 'marketing' only goes to opted-in clients. 'service' is about something they already hold (their pack, their pause) and goes to everyone. */
  kind: 'marketing' | 'service';
  /** What the delay number means. */
  delay: { unit: string; before: string; after: string; min: number; max: number; default: number };
  /** Extra merge tags this automation can use, with an example. */
  tags: { tag: string; label: string; example: string }[];
  defaults: Pick<Automation, 'channel' | 'subject' | 'heading' | 'body' | 'buttonLabel'>;
  order: number;
}

export const AUTOMATION_CATALOG: AutomationDef[] = [
  {
    key: 'welcome', name: 'Welcome', order: 1, kind: 'marketing',
    description: 'A warm hello when someone joins.',
    delay: { unit: 'days', before: 'Sends', after: 'days after they join', min: 0, max: 14, default: 0 },
    tags: [],
    defaults: {
      channel: 'email', subject: 'Welcome to {{studio_name}}', heading: 'Welcome, *{{first_name}}*',
      body: 'We’re so glad you’re here.\n\nYour first class is easy: open the app, pick a time and book. If you’re not sure where to start, say hi in Messages and we’ll point you to the right class.',
      buttonLabel: 'Book your first class',
    },
  },
  {
    key: 'welcome_followup', name: 'Welcome, part two', order: 2, kind: 'marketing',
    description: 'A few tips to settle in, a few days later.',
    delay: { unit: 'days', before: 'Sends', after: 'days after they join', min: 1, max: 21, default: 3 },
    tags: [],
    defaults: {
      channel: 'email', subject: 'A few tips for your first week', heading: 'Settling *in*',
      body: 'Most of our clients make it a habit by booking the week ahead on a Sunday night and choosing classes they’ll really get to.\n\nTurn on notifications in the app and you’ll hear first when a spot opens. Questions about what to bring or which class to try? Reply in Messages any time.',
      buttonLabel: 'See the timetable',
    },
  },
  {
    key: 'intro_ending', name: 'Intro offer ending soon', order: 3, kind: 'marketing',
    description: 'Nudge new clients before their intro offer runs out.',
    delay: { unit: 'days', before: 'Sends', after: 'days before it ends', min: 1, max: 10, default: 3 },
    tags: [{ tag: 'ends_on', label: 'End date', example: 'Fri 24 Oct' }],
    defaults: {
      channel: 'email', subject: 'Your intro offer ends {{ends_on}}', heading: 'Keep the *momentum*',
      body: 'Hi {{first_name}}, your intro offer finishes on {{ends_on}}. If you’ve been enjoying it, a membership or a class pack keeps you in the routine.\n\nHave a look at the options in the app, or message us and we’ll help you pick.',
      buttonLabel: 'See the options',
    },
  },
  {
    key: 'pack_low', name: 'Pack running low or expiring', order: 4, kind: 'service',
    description: 'One credit left, or a pack about to expire.',
    delay: { unit: 'days', before: 'Also sends', after: 'days before a pack expires', min: 1, max: 30, default: 7 },
    tags: [
      { tag: 'pack_name', label: 'Pack name', example: '4 class pack' },
      { tag: 'pack_summary', label: 'Credits and expiry', example: '1 class left, expiring 12 Nov' },
    ],
    defaults: {
      channel: 'email', subject: 'Your {{pack_name}} is running low', heading: 'Almost *there*',
      body: 'Hi {{first_name}}, a quick heads up: your {{pack_name}} has {{pack_summary}}.\n\nBook your next class while you still have credits, or top up in the app so you never miss a session.',
      buttonLabel: 'Open the app',
    },
  },
  {
    key: 'winback', name: 'Win-back', order: 5, kind: 'marketing',
    description: 'A friendly note when someone has been away a while.',
    delay: { unit: 'days', before: 'Sends after', after: 'days without a class', min: 7, max: 180, default: 30 },
    tags: [{ tag: 'last_visit', label: 'Last class date', example: 'Tue 9 Sep' }],
    defaults: {
      channel: 'email', subject: 'We miss you at {{studio_name}}', heading: 'Come back *soon*',
      body: 'Hi {{first_name}}, it’s been a little while since your last class on {{last_visit}}. Life gets busy, we get it.\n\nWhenever you’re ready, we’d love to see you again. Have a look at this week’s timetable and grab a spot.',
      buttonLabel: 'See the timetable',
    },
  },
  {
    key: 'birthday', name: 'Birthday', order: 6, kind: 'marketing',
    description: 'A little note on their birthday.',
    delay: { unit: 'days', before: 'Sends', after: 'days before their birthday (0 = on the day)', min: 0, max: 7, default: 0 },
    tags: [],
    defaults: {
      channel: 'email', subject: 'Happy birthday, {{first_name}}', heading: 'Happy *birthday*',
      body: 'Everyone at {{studio_name}} is wishing you a wonderful day.\n\nTreat yourself to a class this week. You’ve earned it.',
      buttonLabel: 'Book a class',
    },
  },
  {
    key: 'after_first_class', name: 'After their first class', order: 7, kind: 'marketing',
    description: 'Say thanks and point to what’s next.',
    delay: { unit: 'days', before: 'Sends', after: 'days after their first class', min: 0, max: 7, default: 1 },
    tags: [],
    defaults: {
      channel: 'email', subject: 'How was your first class?', heading: 'Nice *work*',
      body: 'Hi {{first_name}}, thanks for coming in. First classes can feel like a lot, and you did it.\n\nIf you have questions about what to try next, just reply in Messages. When you’re ready, grab your next class in the app.',
      buttonLabel: 'Book your next class',
    },
  },
  {
    key: 'paused_ending', name: 'Membership pause ending', order: 8, kind: 'service',
    description: 'A heads up before a paused membership restarts.',
    delay: { unit: 'days', before: 'Sends', after: 'days before the pause ends', min: 1, max: 14, default: 3 },
    tags: [{ tag: 'pause_ends', label: 'Pause end date', example: 'Mon 3 Nov' }],
    defaults: {
      channel: 'email', subject: 'Your membership restarts {{pause_ends}}', heading: 'Welcome *back*',
      body: 'Hi {{first_name}}, your membership pause ends on {{pause_ends}} and billing starts again then.\n\nIf you need a little longer, message us before then and we’ll sort it out.',
      buttonLabel: 'Open the app',
    },
  },
  {
    key: 'intro_checkin', name: 'Intro offer check-in', order: 9, kind: 'marketing',
    description: 'A friendly check-in partway through the intro offer, with what to book next.',
    delay: { unit: 'days', before: 'Sends', after: 'days into the intro offer (7 is the middle of a 14 day offer)', min: 1, max: 13, default: 7 },
    tags: [{ tag: 'ends_on', label: 'End date', example: 'Fri 24 Oct' }],
    defaults: {
      channel: 'email', subject: 'How are you finding it, {{first_name}}?', heading: 'How’s it *going*?',
      body: 'Hi {{first_name}}, you’re about halfway through your intro offer, so we wanted to check in. How are you finding it?\n\nIf you’ve found a class or a time you love, here’s what to book next: another session this week keeps the momentum going, and your offer runs until {{ends_on}}. Not sure what suits you? Reply in Messages and we’ll point you to the right class.',
      buttonLabel: 'Book your next class',
    },
  },
  {
    key: 'review_ask', name: 'Google review ask', order: 10, kind: 'marketing',
    description: 'After every few classes, a friendly ask for a Google review. Turn it on in Settings › Reviews.',
    delay: { unit: 'days', before: 'Sends', after: 'days after the class (0 = a few hours after)', min: 0, max: 14, default: 0 },
    tags: [{ tag: 'class_count', label: 'Classes so far', example: '5' }, { tag: 'review_url', label: 'Google review link', example: 'https://g.page/r/…/review' }],
    defaults: {
      channel: 'email', subject: 'Would you leave us a Google review?', heading: 'A small *favour*',
      body: 'Hi {{first_name}}, you’ve been to {{class_count}} classes at {{studio_name}} now, which is so good to see.\n\nIf you’re enjoying it, a quick Google review helps other people find us and means the world to a small studio. It takes about a minute.',
      buttonLabel: 'Leave a Google review',
    },
  },
];

export const automationDef = (k: AutomationKey): AutomationDef => AUTOMATION_CATALOG.find((d) => d.key === k) ?? AUTOMATION_CATALOG[0]!;

/** Automations a new studio starts with: all on, default copy. */
export function defaultAutomations(): Automation[] {
  return AUTOMATION_CATALOG.map((d) => ({ key: d.key, enabled: true, delay: d.delay.default, ...d.defaults }));
}

/** A class counts as done this long after it starts when the review ask is timed (the live check uses the class end + 3 hours; classes run about an hour). */
export const REVIEW_ASK_AFTER_START_HOURS = 4;
/** The review ask never goes to the same person more than once in this many days. */
export const REVIEW_ASK_GAP_DAYS = 60;

/** Catch-up window: if the scheduler missed a day, people who qualified within this many days are still sent to (once). */
export const GRACE_DAYS = 7;
/** Credits left or fewer counts as "running low" for the pack automation. */
export const PACK_LOW_CREDITS = 1;
