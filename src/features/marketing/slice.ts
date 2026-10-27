/**
 * The demo's marketing data (one slice per studio, inside the studio's demo state) and the helpers that work on it.
 * Shared by seed.ts and demo.ts. Opens and clicks in the demo are simulated: each recipient gets a deterministic
 * open / click time after the send, so numbers settle the same way every time and recent sends tick up on screen.
 */
import type { DemoState } from '../../data/demo/engine';
import type { ID } from '../../shared/types';
import { buildAudience, filterAudience, reachable, type AudienceSnapshot } from './segments';
import type {
  Automation, AudienceMember, Campaign, CampaignStats, MarketingSettings, MessageLogEntry, PushPlatform, Segment, InboxMessage, InboxAlert,
} from './types';

export interface StoredCampaign extends Omit<Campaign, 'stats'> {
  audience: number;
  skipped: number;
  unsubscribed: number;
  /** Frozen at send time so editing the segment later doesn't change who got it. */
  filterAtSend?: Segment['filter'];
}
export interface StoredLog extends MessageLogEntry { dedupeKey?: string }
export interface StoredThread { id: ID; clientId: ID; createdAt: string; staffUnread: number; clientUnread: number }
export interface StoredDevice { id: ID; who: string; platform: PushPlatform; token: string; at: string }

export interface Slice {
  segments: Segment[];
  tags: Record<ID, string[]>;
  campaigns: StoredCampaign[];
  automations: Automation[];
  log: StoredLog[];
  threads: StoredThread[];
  messages: InboxMessage[];
  devices: StoredDevice[];
  settings: MarketingSettings;
  /** Inbox emails the demo "sent" (studio alerts and client replies). */
  alerts?: InboxAlert[];
}

export const emptySlice = (): Slice => ({
  segments: [], tags: {}, campaigns: [], automations: [], log: [], threads: [], messages: [], devices: [],
  settings: { fromName: '', replyTo: '', smsSender: '', footerNote: '', inboxAccess: 'no_instructors', emailStudio: true, emailClient: true },
  alerts: [],
});

/** Fills in anything missing (a studio whose slice predates a field). */
export function normalise(raw: Partial<Slice>): Slice {
  return { ...emptySlice(), ...raw };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The facts the rules need, from the studio's demo data. */
export function snapshot(state: DemoState, now: Date, tags: Record<ID, string[]>): AudienceSnapshot {
  const startOf = new Map(state.sessions.map((s) => [s.id, s.startsAt]));
  const visits = state.bookings.filter((b) => b.status === 'checked_in')
    .map((b) => ({ clientId: b.clientId, at: b.checkedInAt ?? startOf.get(b.sessionId) ?? b.createdAt }))
    .filter((v) => Date.parse(v.at) <= now.getTime());
  return { now, clients: state.clients, passes: state.passes, visits, tags };
}

export const audienceOf = (state: DemoState, now: Date, tags: Record<ID, string[]>): AudienceMember[] => buildAudience(snapshot(state, now, tags));

export const emptyStats = (): CampaignStats => ({ audience: 0, skipped: 0, sent: 0, failed: 0, opened: 0, clicked: 0, unsubscribed: 0 });

/** Campaign numbers from the send log. Opens and clicks only count once their (simulated) time has passed. */
export function statsFor(c: StoredCampaign, log: StoredLog[], now: Date): CampaignStats {
  if (c.status !== 'sent' && c.status !== 'sending') return emptyStats();
  const t = now.getTime();
  const mine = log.filter((l) => l.source === 'campaign' && l.refId === c.id);
  return {
    audience: c.audience, skipped: c.skipped, unsubscribed: c.unsubscribed,
    sent: mine.filter((l) => l.status === 'sent').length, failed: mine.filter((l) => l.status === 'failed').length,
    opened: mine.filter((l) => l.openedAt && Date.parse(l.openedAt) <= t).length,
    clicked: mine.filter((l) => l.clickedAt && Date.parse(l.clickedAt) <= t).length,
  };
}

export function toCampaign(c: StoredCampaign, log: StoredLog[], now: Date): Campaign {
  const { audience: _a, skipped: _s, unsubscribed: _u, filterAtSend: _f, ...rest } = c;
  return { ...rest, stats: statsFor(c, log, now), simulated: true };
}

const fullName = (m: Pick<AudienceMember, 'firstName' | 'lastName'>) => `${m.firstName} ${m.lastName}`.trim();

/**
 * "Send" a campaign in the demo: who is reachable gets a log entry (sent), the rest are counted as skipped.
 * `fast` = a send that just happened, so opens and clicks arrive within a minute or so (watch them tick up);
 * otherwise they arrive over the following hours.
 */
export function deliverCampaign(
  slice: Slice, c: StoredCampaign, members: AudienceMember[], newId: (p: string) => string, sentAt: Date, fast: boolean,
): void {
  const base = hash(c.id);
  const openRate = 420 + (base % 200); // 42 – 62% of recipients
  const clickOfOpens = 160 + ((base >> 8) % 160); // 16 – 32% of those who opened
  const reach = members.filter((m) => reachable(m, c.channel, true).ok);
  const skipped = members.length - reach.length;
  // Rank recipients by a stable hash so the rates come out right even for a small list.
  const ranked = [...reach].sort((a, b) => hash(`${c.id}:${a.clientId}`) - hash(`${c.id}:${b.clientId}`));
  const nOpen = c.channel === 'email' ? Math.min(ranked.length, Math.max(ranked.length >= 3 ? 1 : 0, Math.round((ranked.length * openRate) / 1000))) : 0;
  const nClick = c.channel === 'sms'
    ? Math.min(ranked.length, Math.max(ranked.length >= 3 ? 1 : 0, Math.round((ranked.length * 110) / 1000)))
    : Math.min(nOpen, Math.max(nOpen >= 3 ? 1 : 0, Math.round((nOpen * clickOfOpens) / 1000)));
  const reached = ranked.length;
  ranked.forEach((m, rank) => {
    const h = hash(`${c.id}:${m.clientId}`);
    const spread = fast ? 8_000 + (h % 70_000) : 90_000 + (h % (6 * 3_600_000));
    const entry: StoredLog = {
      id: newId('ml'), channel: c.channel, source: 'campaign', refId: c.id, refName: c.name, clientId: m.clientId, clientName: fullName(m),
      to: c.channel === 'sms' ? m.phone ?? '' : m.email, status: 'sent', sentAt: sentAt.toISOString(),
      ...(c.subject ? { subject: c.subject } : {}), dedupeKey: `c:${c.id}:${m.clientId}`,
    };
    if (rank < nOpen) entry.openedAt = new Date(sentAt.getTime() + spread).toISOString();
    if (rank < nClick) entry.clickedAt = new Date(sentAt.getTime() + spread + 20_000 + (h % 90_000)).toISOString();
    slice.log.push(entry);
  });
  c.audience = reached;
  c.skipped = skipped;
  c.unsubscribed = reached >= 25 && base % 3 === 0 ? 1 : 0;
  c.status = 'sent';
  c.sentAt = sentAt.toISOString();
  delete c.scheduledFor;
}

export { filterAudience };
