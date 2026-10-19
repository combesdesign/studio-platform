/**
 * Pure audience logic: who is a client "as marketing sees them" (AudienceMember), whether a segment rule matches
 * them, and who each automation should message right now. No storage, no DOM; `now` is always passed in.
 * The live database mirrors every rule in SQL (app.marketing_facts / app.marketing_rule_ok / app.marketing_automation_candidates);
 * supabase/tests/marketing_*.sql and tests/marketing-segments.test.ts check the same cases.
 */
import { DAY_MS, computePassStatus, isPausedOn } from '../../domain';
import { addDays, dayShort, studioDate } from '../../shared/format';
import type { Client, ID, Pass } from '../../shared/types';
import { GRACE_DAYS, PACK_LOW_CREDITS, automationDef } from './catalog';
import { automationBlocks, buildSms, mergeTags } from './render';
import type {
  Automation, AutomationCandidate, AutomationKey, AudienceMember, Channel, SegmentFilter, SegmentRule,
} from './types';

export interface AudienceSnapshot {
  now: Date;
  clients: Client[];
  passes: Pass[];
  /** Classes each client has been checked in to (ISO start time). */
  visits: { clientId: ID; at: string }[];
  /** Tags by client id. */
  tags: Record<ID, string[]>;
}

const ms = (iso: string) => Date.parse(iso);

/** Everyone who isn't archived, with the facts the rules need. */
export function buildAudience(s: AudienceSnapshot): AudienceMember[] {
  const today = studioDate(s.now);
  const byClient = new Map<ID, Pass[]>();
  for (const p of s.passes) (byClient.get(p.clientId) ?? byClient.set(p.clientId, []).get(p.clientId)!).push(p);
  const visitsBy = new Map<ID, string[]>();
  for (const v of s.visits) (visitsBy.get(v.clientId) ?? visitsBy.set(v.clientId, []).get(v.clientId)!).push(v.at);

  return s.clients.filter((c) => !c.archived).map((c): AudienceMember => {
    const passes = byClient.get(c.id) ?? [];
    const v = (visitsBy.get(c.id) ?? []).sort();
    const live = passes.filter((p) => computePassStatus(p, s.now) === 'active');
    const membership = live.filter((p) => p.kind === 'membership');
    const paused = passes.filter((p) => p.kind === 'membership' && p.pausedUntil && p.pausedUntil >= today
      && (computePassStatus(p, s.now) === 'paused' || isPausedOn(p, today)));
    const packs = live.filter((p) => (p.kind === 'pack' || p.kind === 'dropin') && p.credits != null && p.credits - p.creditsUsed > 0);
    const intro = live.find((p) => p.kind === 'intro');
    const activeMembers = membership.filter((p) => !isPausedOn(p, today));
    const member: AudienceMember = {
      clientId: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, optIn: !!c.marketingOptIn,
      joinedAt: c.createdAt, visits: v.length, activeMember: activeMembers.length > 0,
      // Soonest expiry first (no expiry last), then id: the database orders them the same way.
      packs: [...packs].sort((a, b) => (a.expiresAt ?? '￿').localeCompare(b.expiresAt ?? '￿') || a.id.localeCompare(b.id))
        .map((p) => ({ id: p.id, name: p.name, remaining: (p.credits ?? 0) - p.creditsUsed, ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}) })),
      tags: s.tags[c.id] ?? [],
    };
    if (c.phone) member.phone = c.phone;
    if (c.birthday) member.birthday = c.birthday;
    if (v.length) { member.firstVisitAt = v[0]!; member.lastVisitAt = v[v.length - 1]!; }
    if (paused.length) member.pausedUntil = paused.map((p) => p.pausedUntil!).sort().pop()!;
    if (intro) member.intro = { id: intro.id, name: intro.name, ...(intro.expiresAt ? { endsAt: intro.expiresAt } : {}) };
    return member;
  });
}

// ------------------------------------------------------------------ segment rules

export function ruleMatches(m: AudienceMember, r: SegmentRule, now: Date): boolean {
  let ok: boolean;
  switch (r.type) {
    case 'active_member': ok = m.activeMember; break;
    case 'pack_low': {
      const credits = r.credits ?? PACK_LOW_CREDITS, days = r.days ?? 7;
      ok = m.packs.some((p) => p.remaining <= credits || (p.expiresAt !== undefined && ms(p.expiresAt) <= now.getTime() + days * DAY_MS));
      break;
    }
    case 'no_visit': ok = m.lastVisitAt !== undefined && ms(m.lastVisitAt) <= now.getTime() - (r.days ?? 30) * DAY_MS; break;
    case 'intro': ok = m.intro !== undefined; break;
    case 'birthday_month': ok = !!m.birthday && m.birthday.slice(5, 7) === studioDate(now).slice(5, 7); break;
    case 'opted_in': ok = m.optIn; break;
    case 'tag': { const t = (r.tag ?? '').trim().toLowerCase(); ok = t !== '' && m.tags.some((x) => x.toLowerCase() === t); break; }
    case 'new_client': ok = ms(m.joinedAt) >= now.getTime() - (r.days ?? 30) * DAY_MS; break;
    default: ok = false;
  }
  return r.not ? !ok : ok;
}

export function filterMatches(m: AudienceMember, f: SegmentFilter, now: Date): boolean {
  if (!f.rules.length) return true;
  return f.match === 'any' ? f.rules.some((r) => ruleMatches(m, r, now)) : f.rules.every((r) => ruleMatches(m, r, now));
}

export function filterAudience(members: AudienceMember[], f: SegmentFilter, now: Date): AudienceMember[] {
  return members.filter((m) => filterMatches(m, f, now));
}

/** Can this client be sent a message on this channel? Marketing needs opt-in; every send needs an address. */
export function reachable(m: AudienceMember, channel: Channel, marketing: boolean): { ok: true } | { ok: false; why: string } {
  if (marketing && !m.optIn) return { ok: false, why: 'Not opted into marketing' };
  if (channel === 'email' && !m.email.trim()) return { ok: false, why: 'No email address' };
  if (channel === 'sms' && !(m.phone ?? '').trim()) return { ok: false, why: 'No mobile number' };
  return { ok: true };
}

// ------------------------------------------------------------------ automations

export interface AutomationContext {
  now: Date;
  studioName: string;
  /** The app's address, for the button in automation emails. */
  appUrl: string;
  /** Sent-log keys already used. Matching candidates are left out. */
  sentKeys: ReadonlySet<string>;
}

interface Hit { reason: string; key: string; vars: Record<string, string> }

const daysAgo = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - ms(iso)) / DAY_MS));
const inWindow = (at: number, delayDays: number, now: Date) => at + delayDays * DAY_MS <= now.getTime() && now.getTime() < at + (delayDays + GRACE_DAYS) * DAY_MS;
const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

/** Does this client qualify for this automation right now? Returns why, plus the sent-log key and extra merge values. */
export function automationHit(key: AutomationKey, delay: number, m: AudienceMember, now: Date): Hit | null {
  const today = studioDate(now);
  switch (key) {
    case 'welcome':
    case 'welcome_followup':
      return inWindow(ms(m.joinedAt), delay, now)
        ? { reason: `Joined ${daysAgo(m.joinedAt, now) === 0 ? 'today' : `${plural(daysAgo(m.joinedAt, now), 'day')} ago`}`, key: `${key}:${m.clientId}`, vars: {} }
        : null;
    case 'intro_ending': {
      const end = m.intro?.endsAt ? ms(m.intro.endsAt) : null;
      if (end === null || !(end - delay * DAY_MS <= now.getTime() && now.getTime() < end)) return null;
      const on = dayShort(m.intro!.endsAt!);
      return { reason: `Intro offer ends ${on}`, key: `intro_ending:${m.clientId}:${m.intro!.id}`, vars: { ends_on: on } };
    }
    case 'pack_low': {
      const p = m.packs.find((x) => x.remaining <= PACK_LOW_CREDITS || (x.expiresAt !== undefined && ms(x.expiresAt) <= now.getTime() + delay * DAY_MS));
      if (!p) return null;
      const bits = [`${plural(p.remaining, 'class', 'classes')} left`];
      if (p.expiresAt) bits.push(`expiring ${dayShort(p.expiresAt)}`);
      return { reason: `${p.name}: ${bits.join(', ')}`, key: `pack_low:${m.clientId}:${p.id}`, vars: { pack_name: p.name, pack_summary: bits.join(', ') } };
    }
    case 'winback': {
      if (!m.lastVisitAt || !inWindow(ms(m.lastVisitAt), delay, now)) return null;
      return {
        reason: `Last class ${dayShort(m.lastVisitAt)} (${plural(daysAgo(m.lastVisitAt, now), 'day')} ago)`,
        key: `winback:${m.clientId}:${studioDate(new Date(m.lastVisitAt))}`, vars: { last_visit: dayShort(m.lastVisitAt) },
      };
    }
    case 'birthday': {
      if (!m.birthday) return null;
      if (m.birthday.slice(5) !== addDays(today, delay).slice(5)) return null;
      return { reason: delay ? `Birthday in ${plural(delay, 'day')}` : 'Birthday today', key: `birthday:${m.clientId}:${addDays(today, delay).slice(0, 4)}`, vars: {} };
    }
    case 'after_first_class':
      return m.firstVisitAt && inWindow(ms(m.firstVisitAt), delay, now)
        ? { reason: `First class ${dayShort(m.firstVisitAt)}`, key: `after_first_class:${m.clientId}`, vars: {} }
        : null;
    case 'paused_ending': {
      if (!m.pausedUntil) return null;
      if (!(addDays(today, delay) >= m.pausedUntil && today <= m.pausedUntil)) return null;
      const on = dayShort(new Date(`${m.pausedUntil}T12:00:00Z`));
      return { reason: `Pause ends ${on}`, key: `paused_ending:${m.clientId}:${m.pausedUntil}`, vars: { pause_ends: on } };
    }
  }
}

export interface AutomationPlan { items: AutomationCandidate[]; skipped: { key: AutomationKey; clientName: string; why: string }[] }

/** Every message the enabled automations would send right now (already-sent keys left out). */
export function automationCandidates(automations: Automation[], members: AudienceMember[], ctx: AutomationContext): AutomationPlan {
  const items: AutomationCandidate[] = [];
  const skipped: AutomationPlan['skipped'] = [];
  const seen = new Set<string>();
  for (const a of automations) {
    if (!a.enabled) continue;
    const def = automationDef(a.key);
    for (const m of members) {
      const hit = automationHit(a.key, a.delay, m, ctx.now);
      if (!hit || ctx.sentKeys.has(hit.key) || seen.has(hit.key)) continue;
      const clientName = `${m.firstName} ${m.lastName}`.trim();
      const r = reachable(m, a.channel, def.kind === 'marketing');
      if (!r.ok) { skipped.push({ key: a.key, clientName, why: r.why }); continue; }
      seen.add(hit.key);
      const vars: Record<string, string> = { first_name: m.firstName, last_name: m.lastName, studio_name: ctx.studioName, app_url: ctx.appUrl, ...hit.vars };
      const blocks = automationBlocks(a);
      const preview = a.channel === 'sms'
        ? buildSms(a.body, vars, { marketing: def.kind === 'marketing' })
        : mergeTags(blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' '), vars).replace(/\s+/g, ' ').trim();
      items.push({
        key: a.key, automationName: def.name, clientId: m.clientId, clientName, channel: a.channel,
        to: a.channel === 'sms' ? m.phone ?? '' : m.email, subject: mergeTags(a.subject, vars), preview, reason: hit.reason, dedupeKey: hit.key,
      });
    }
  }
  items.sort((x, y) => automationDef(x.key).order - automationDef(y.key).order || x.clientName.localeCompare(y.clientName));
  return { items, skipped };
}

