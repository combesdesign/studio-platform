/**
 * Notice board: short notices staff post for clients, shown as compact cards at the top of the client timetable.
 * Owner: whoever adds notices (src/features/notices, supabase/migrations/3303_notices.sql). Studio-agnostic: no studio names in here.
 */
import type { ID, ISODate, ISODateTime } from '../../shared/types';

export interface Notice {
  id: ID;
  title: string;
  /** Short text (up to 300 characters). Can be empty. */
  body: string;
  /** Optional https:// link shown as a button. */
  linkUrl?: string;
  /** Optional last day it shows (studio date, inclusive). Unset = until removed. */
  showUntil?: ISODate;
  /** Pinned notices come first. */
  pinned: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface NoticeInput {
  /** Set to change an existing notice. */
  id?: ID;
  title: string;
  body?: string;
  linkUrl?: string;
  showUntil?: ISODate;
  pinned?: boolean;
}

export interface NoticesStore {
  /** The notices still showing (not past their "show until" day), pinned first then newest. Anyone signed in to the studio. */
  listActive(): Promise<Notice[]>;
  /** Owner and manager: every notice, finished ones included. Pinned first then newest. */
  listAll(): Promise<Notice[]>;
  /** Owner and manager: post (no id) or change a notice. */
  save(input: NoticeInput): Promise<Notice>;
  setPinned(id: ID, pinned: boolean): Promise<Notice>;
  remove(id: ID): Promise<void>;
}

declare module '../../shared/store' {
  interface FeatureStores { notices: NoticesStore }
}
