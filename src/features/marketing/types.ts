/**
 * Marketing feature: segments, email + SMS campaigns, automations, the two-way inbox and push (ROADMAP B2).
 * Owner: the marketing feature agent. Everything for this feature lives in src/features/marketing/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1200_marketing_*.sql (range 1200–1299), tests supabase/tests/marketing_*.sql.
 *
 * Conventions: ids are strings, timestamps ISO UTC, calendar dates 'YYYY-MM-DD' in the studio timezone.
 * Marketing sends (campaigns, and automations marked kind 'marketing') only ever go to clients who opted in.
 */
import type { ID, ISODate, ISODateTime } from '../../shared/types';

// ------------------------------------------------------------------ segments

export type SegmentRuleType =
  | 'active_member' // holds a membership that is active (not paused)
  | 'pack_low' // an active pack with few credits left, or about to expire
  | 'no_visit' // has been to class before, but not in the last N days
  | 'intro' // is on the intro offer right now
  | 'birthday_month' // birthday falls in the current month (studio time)
  | 'opted_in' // said yes to news + offers
  | 'tag' // carries a tag you added
  | 'new_client'; // joined in the last N days

export interface SegmentRule {
  type: SegmentRuleType;
  /** Flip the rule: "not on the intro offer". */
  not?: boolean;
  /** no_visit: days since last class (default 30). new_client: days since joining (default 30). pack_low: expires within N days (default 7). */
  days?: number;
  /** pack_low: credits left or fewer (default 1). */
  credits?: number;
  /** tag */
  tag?: string;
}

export interface SegmentFilter {
  /** 'all' = every rule must match, 'any' = at least one. No rules = everyone. */
  match: 'all' | 'any';
  rules: SegmentRule[];
}

export interface Segment {
  id: ID;
  name: string;
  description?: string;
  filter: SegmentFilter;
  createdAt: ISODateTime;
}

export interface SegmentWithCount extends Segment {
  /** Clients matching the filter. */
  count: number;
  /** Of those, how many can receive marketing (opted in). */
  optedIn: number;
}

/** One client as the segment and automation rules see them. */
export interface AudienceMember {
  clientId: ID;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** Said yes to news + offers. Required for every marketing send. */
  optIn: boolean;
  birthday?: ISODate;
  joinedAt: ISODateTime;
  firstVisitAt?: ISODateTime;
  lastVisitAt?: ISODateTime;
  visits: number;
  activeMember: boolean;
  /** A membership paused until this date. */
  pausedUntil?: ISODate;
  /** Active packs and drop-ins that still have credits. */
  packs: { id: ID; name: string; remaining: number; expiresAt?: ISODateTime }[];
  /** The intro offer, if they hold a current one. */
  intro?: { id: ID; name: string; startsAt?: ISODateTime; endsAt?: ISODateTime };
  /** When each class they were checked in to started, oldest first (the review ask counts these). */
  visitAts?: ISODateTime[];
  tags: string[];
}

export interface AudiencePreview {
  count: number;
  optedIn: number;
  /** First few matches, for the "who is this?" list. */
  sample: Pick<AudienceMember, 'clientId' | 'firstName' | 'lastName' | 'optIn'>[];
}

// ------------------------------------------------------------------ campaigns

export type Channel = 'email' | 'sms';
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

export type EmailBlockType = 'heading' | 'text' | 'image' | 'button' | 'divider';
export interface EmailBlock {
  id: string;
  type: EmailBlockType;
  /** heading / text content. Text: blank line = new paragraph. */
  text?: string;
  /** image: URL or studio photo path (e.g. 'img/hero.webp'). */
  src?: string;
  alt?: string;
  /** button: label + link. image: optional link. */
  label?: string;
  url?: string;
}

export interface CampaignStats {
  /** Clients in the segment who could be reached (opted in, with an address). */
  audience: number;
  /** Left out: not opted in, or no email / mobile number. */
  skipped: number;
  sent: number;
  failed: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}

export interface Campaign {
  id: ID;
  name: string;
  channel: Channel;
  status: CampaignStatus;
  segmentId?: ID;
  /** Name of the segment when it was sent (kept if the segment is later deleted). */
  segmentName?: string;
  subject?: string;
  preheader?: string;
  blocks?: EmailBlock[];
  /** sms */
  body?: string;
  scheduledFor?: ISODateTime;
  sentAt?: ISODateTime;
  createdAt: ISODateTime;
  createdByName?: string;
  stats: CampaignStats;
  /** Demo numbers are made up (opens and clicks arrive on a timer); live numbers are recorded. */
  simulated?: boolean;
}

export interface CampaignInput {
  id?: ID;
  name: string;
  channel: Channel;
  segmentId?: ID | null;
  subject?: string;
  preheader?: string;
  blocks?: EmailBlock[];
  body?: string;
}

export interface MessageLogEntry {
  id: ID;
  channel: Channel | 'push';
  source: 'campaign' | 'automation' | 'inbox';
  /** Campaign id, automation key or thread id. */
  refId: string;
  refName: string;
  clientId: ID;
  clientName: string;
  to: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  error?: string;
  sentAt?: ISODateTime;
  openedAt?: ISODateTime;
  clickedAt?: ISODateTime;
  subject?: string;
}

export interface CampaignDetail {
  campaign: Campaign;
  /** Segment now (null if deleted). */
  segment: Segment | null;
  /** Who got it, newest first (capped). */
  recipients: MessageLogEntry[];
}

// ------------------------------------------------------------------ automations

export type AutomationKey =
  | 'welcome'
  | 'welcome_followup'
  | 'intro_ending'
  | 'pack_low'
  | 'winback'
  | 'birthday'
  | 'after_first_class'
  | 'paused_ending'
  | 'intro_checkin'
  | 'review_ask';

export interface Automation {
  key: AutomationKey;
  enabled: boolean;
  channel: Channel;
  /** What the delay means depends on the automation (see AUTOMATION_CATALOG): days after, days before, days without a visit… */
  delay: number;
  subject: string;
  heading: string;
  /** Plain text; blank line = new paragraph. Merge tags like {{first_name}}. */
  body: string;
  buttonLabel: string;
  updatedAt?: ISODateTime;
}

export interface AutomationInput {
  key: AutomationKey;
  enabled?: boolean;
  channel?: Channel;
  delay?: number;
  subject?: string;
  heading?: string;
  body?: string;
  buttonLabel?: string;
}

/** One message an automation would send (or just sent) right now. */
export interface AutomationCandidate {
  key: AutomationKey;
  automationName: string;
  clientId: ID;
  clientName: string;
  channel: Channel;
  to: string;
  subject: string;
  /** First line or two of the message, with the client's details filled in. */
  preview: string;
  /** Why they qualify, e.g. "Last class 31 Aug (33 days ago)". */
  reason: string;
  /** Sent-log key. A key that's already been sent is never sent again. */
  dedupeKey: string;
}

export interface AutomationRun {
  dryRun: boolean;
  /** Messages that qualify (dry run) or were sent (real run). */
  items: AutomationCandidate[];
  /** Qualified but skipped (not opted in, no address). */
  skipped: { key: AutomationKey; clientName: string; why: string }[];
}

// ------------------------------------------------------------------ inbox

export interface InboxMessage {
  id: ID;
  threadId: ID;
  from: 'client' | 'staff';
  /** 'sms' = a one-off text from staff (Send a text). Missing = a message in the app. */
  channel?: 'app' | 'sms';
  staffName?: string;
  body: string;
  at: ISODateTime;
}

export interface InboxThread {
  id: ID;
  clientId: ID;
  clientName: string;
  clientPhotoUrl?: string;
  lastMessageAt: ISODateTime;
  lastMessagePreview: string;
  lastFrom: 'client' | 'staff';
  /** Messages from the client that staff haven't read. */
  unread: number;
}

export interface InboxThreadDetail {
  thread: InboxThread | null;
  messages: InboxMessage[];
}

/** A client's own conversation with the studio. */
export interface MyThread {
  threadId?: ID;
  messages: InboxMessage[];
  /** Studio messages the client hasn't read. */
  unread: number;
}

// ------------------------------------------------------------------ push

export type PushPlatform = 'web' | 'ios' | 'android';

export interface PushRegistration {
  platform: PushPlatform;
  /** Web: the subscription endpoint. Native: the APNs / FCM device token. */
  token: string;
  /** Web push keys ({ p256dh, auth }). */
  keys?: Record<string, string>;
  userAgent?: string;
}

export interface PushStatus {
  /** Does this device have a registration? */
  registered: boolean;
  /** Sending needs real keys (VAPID for web, FCM / APNs for the apps). */
  needsKeys: boolean;
  /** Registered devices at this studio, by platform (staff only; clients see their own). */
  devices: Record<PushPlatform, number>;
  /** Web push public key (VAPID), when the server has one. */
  vapidPublicKey?: string;
}

// ------------------------------------------------------------------ settings

export interface MarketingSettings {
  /** "From" name on emails. Blank = the studio name. */
  fromName: string;
  /** Replies to campaigns go here. Blank = the studio email. */
  replyTo: string;
  /** SMS sender id or number (Twilio). Blank = the provider default. */
  smsSender: string;
  /** Extra line in the email footer, e.g. "You're getting this because you joined our newsletter." */
  footerNote: string;
  /** Who can use the inbox. Default no_instructors: owner, managers and front desk. */
  inboxAccess: InboxAccess;
  /** Email the studio when a client messages (at most one per conversation every 15 minutes). Default on. */
  emailStudio: boolean;
  /** Email a client when the studio replies and they don't have notifications on (same batching). Default on. */
  emailClient: boolean;
}

export type InboxAccess = 'owner' | 'owner_manager' | 'no_instructors' | 'all_staff';

/** An email the inbox queued (demo only: live ones sit in the send queue). */
export interface InboxAlert { at: string; audience: 'staff' | 'client'; clientId: string; to: string; subject: string; preview: string }

export interface ProviderStatus {
  /** 'stub' until Twilio is configured. */
  sms: { provider: 'stub' | 'twilio'; ready: boolean; note: string };
  email: { provider: 'demo' | 'resend'; ready: boolean; note: string };
  push: { ready: boolean; note: string };
}

// ------------------------------------------------------------------ the store

/** What the apps call: store.features.marketing. Staff methods need 'marketing.*' permissions; "my…" methods are for the signed-in client. */
export interface MarketingStore {
  // --- segments + tags (marketing.view to read, marketing.manage to change)
  listSegments(): Promise<SegmentWithCount[]>;
  previewAudience(filter: SegmentFilter): Promise<AudiencePreview>;
  saveSegment(input: { id?: ID; name: string; description?: string; filter: SegmentFilter }): Promise<Segment>;
  deleteSegment(id: ID): Promise<void>;
  listTags(): Promise<{ tag: string; count: number }[]>;
  getClientTags(clientId: ID): Promise<string[]>;
  setClientTags(clientId: ID, tags: string[]): Promise<string[]>;

  // --- campaigns
  listCampaigns(): Promise<Campaign[]>;
  getCampaign(id: ID): Promise<CampaignDetail>;
  saveCampaign(input: CampaignInput): Promise<Campaign>;
  deleteCampaign(id: ID): Promise<void>;
  /** Send to the segment now. Returns the campaign (status 'sent' in the demo, 'sending' live while the queue drains). */
  sendCampaign(id: ID): Promise<Campaign>;
  scheduleCampaign(id: ID, at: ISODateTime): Promise<Campaign>;
  /** Back to draft. */
  unscheduleCampaign(id: ID): Promise<Campaign>;
  /** Send one test (email address or mobile number) of an unsaved or saved campaign. */
  sendTest(input: CampaignInput, to: string): Promise<void>;

  // --- automations
  listAutomations(): Promise<(Automation & { sentLast30Days: number })[]>;
  saveAutomation(input: AutomationInput): Promise<Automation>;
  /** dryRun: who would get what right now. Otherwise sends them (once each: the sent log stops repeats). */
  runAutomations(opts: { dryRun: boolean }): Promise<AutomationRun>;
  /** Recent sends from campaigns and automations, newest first. */
  listMessageLog(opts?: { limit?: number }): Promise<MessageLogEntry[]>;

  // --- inbox (staff)
  listThreads(): Promise<InboxThread[]>;
  getThread(clientId: ID): Promise<InboxThreadDetail>;
  /** Staff message to a client (starts the thread if there isn't one). */
  sendStaffMessage(clientId: ID, body: string): Promise<InboxMessage>;
  /**
   * One-off text to a client's mobile (owner, manager, front desk). Goes through the marketing SMS provider (Twilio, or the logging stub
   * until it is set up) and is logged in the client's message history. Throws NO_PHONE if they have no number.
   */
  sendText(clientId: ID, body: string): Promise<InboxMessage>;
  markThreadRead(clientId: ID): Promise<void>;
  inboxUnreadCount(): Promise<number>;

  // --- inbox (the signed-in client)
  getMyThread(): Promise<MyThread>;
  sendMyMessage(body: string): Promise<InboxMessage>;
  markMyThreadRead(): Promise<void>;
  myUnreadCount(): Promise<number>;
  /** Live only: call `onChange` when a message arrives (Supabase realtime). The demo syncs through store.subscribe. */
  subscribeInbox?(onChange: () => void): () => void;

  // --- push
  getPushStatus(): Promise<PushStatus>;
  registerPush(reg: PushRegistration): Promise<void>;
  unregisterPush(token: string): Promise<void>;
  /** Staff: send a test push to the signed-in person's own devices. */
  sendTestPush(): Promise<{ sent: number; note: string }>;

  // --- settings
  getSettings(): Promise<MarketingSettings>;
  /** Can the signed-in staff member use the inbox, under the studio's setting? Any staff can ask (the UI hides the inbox when not). */
  getInboxAccess(): Promise<{ access: InboxAccess; allowed: boolean }>;
  /** Demo only: the emails the inbox "sent". */
  listInboxAlerts?(): Promise<InboxAlert[]>;
  updateSettings(patch: Partial<MarketingSettings>): Promise<MarketingSettings>;
  getProviders(): Promise<ProviderStatus>;
}

declare module '../../shared/store' {
  interface FeatureStores { marketing: MarketingStore }
}
