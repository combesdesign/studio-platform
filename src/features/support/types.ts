/**
 * In-app help and support (ROADMAP "Support that's actually good"). Everything for it lives in src/features/support/.
 * SQL: supabase/migrations/2000_support.sql (range 2000-2099), tests supabase/tests/support_*.sql.
 * There are NO problem categories anywhere: a request is free text, an urgent flag and the context we attach.
 */
import type { ID, ISODateTime, StaffRole } from '../../shared/types';

export type SupportStatus = 'open' | 'waiting' | 'resolved';
export const STATUS_LABEL: Record<SupportStatus, string> = { open: 'Open', waiting: 'Waiting on you', resolved: 'Resolved' };

export interface SupportMessage {
  id: ID;
  /** 'studio' = the staff member, 'platform' = us. */
  from: 'studio' | 'platform';
  author: string;
  body: string;
  at: ISODateTime;
}

/** What we attach automatically, so nobody has to explain where they were or what they're using. */
export interface SupportContext {
  /** Hash route they were on, e.g. '#/clients/abc'. */
  route: string;
  appVersion: string;
  userAgent: string;
}

export interface SupportRequest {
  id: ID;
  studioId: ID;
  studioName: string;
  staffId: ID | null;
  staffName: string;
  staffRole: StaffRole;
  body: string;
  /** "Clients can't book or pay". */
  urgent: boolean;
  status: SupportStatus;
  context: SupportContext;
  /** A downscaled JPEG data URL, if they attached a photo or screenshot. */
  screenshot: string | null;
  /** When we promised a reply by; null for urgent requests ("on it now"). */
  replyBy: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** Oldest first. The first one is the request itself. */
  messages: SupportMessage[];
}

export interface SupportSendInput {
  body: string;
  urgent: boolean;
  screenshot?: string | null;
  context: SupportContext;
  /** Computed in the app from the platform's business hours (hours.ts). Null for urgent. */
  replyBy: ISODateTime | null;
}

/** Platform-wide status message shown as a slim banner in every studio app. */
export interface SupportBanner {
  message: string;
  tone: 'info' | 'warn';
  updatedAt: ISODateTime;
}

/** The Help sheet's instant answer. Same shape whether the AI or the best-matching help article wrote it. */
export interface SupportAssist {
  answer: string;
  /** The answer says this needs a person: nudge towards sending it to us. */
  suggestHuman: boolean;
  /** A help article to open for the full guide (the article fallback always has one). */
  link?: { label: string; href: string };
}

/** Studio staff side. */
export interface SupportStore {
  /** An instant written answer to what they typed, before (or instead of) sending it to us. Never throws for "not switched on". */
  assist(input: { question: string; page: string }): Promise<SupportAssist>;
  send(input: SupportSendInput): Promise<SupportRequest>;
  /** The signed-in staff member's requests (owners and managers also see their studio's), newest first. */
  listMine(): Promise<SupportRequest[]>;
  /** Add a follow-up to one of your threads (re-opens it). */
  follow(requestId: ID, body: string): Promise<SupportRequest>;
  banner(): Promise<SupportBanner | null>;
}

/** Platform admin side (src/admin). Not part of DataStore: it works across studios. */
export interface SupportAdminStore {
  /** Every request across studios, newest first. */
  list(): Promise<SupportRequest[]>;
  reply(requestId: ID, body: string, status?: SupportStatus): Promise<SupportRequest>;
  setStatus(requestId: ID, status: SupportStatus): Promise<SupportRequest>;
  getBanner(): Promise<SupportBanner | null>;
  /** null or an empty message clears it. */
  setBanner(message: string | null, tone?: SupportBanner['tone']): Promise<SupportBanner | null>;
  /** Called when anything changes (other tabs too). */
  subscribe(listener: () => void): () => void;
}

declare module '../../shared/store' {
  interface FeatureStores { support: SupportStore }
}
