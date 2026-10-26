/**
 * Online classes: on-demand video library. Everything for it lives in src/features/ondemand/.
 * SQL: supabase/migrations/1900_ondemand.sql (range 1900-1999), tests supabase/tests/ondemand_*.sql.
 */
import type { ID, ISODateTime } from '../../shared/types';

/** What staff type in (create and edit). */
export interface VideoInput {
  title: string;
  description?: string;
  instructor?: string;
  /** Whole minutes. */
  durationMin: number;
  level?: string;
  /** 'Mums + Bubs', 'Core', 'Stretch', 'Full body'... free text, the chips are built from what's in use. */
  category: string;
  /** Image path ('img/wide.webp') or https address. Optional. */
  thumbnailUrl?: string;
  /** A Vimeo or YouTube link (unlisted is fine) or a direct .mp4 address. */
  videoUrl: string;
  published?: boolean;
  /** Free for anyone signed in. */
  free?: boolean;
}

/** One video as staff see it. */
export interface AdminVideo {
  id: ID;
  title: string;
  description: string;
  instructor: string;
  durationMin: number;
  level: string;
  category: string;
  thumbnailUrl: string;
  videoUrl: string;
  published: boolean;
  free: boolean;
  sortOrder: number;
  /** Total plays (each press of play by a signed-in client). */
  views: number;
}

/** One video as a client sees it: the address only comes back when it is unlocked. */
export interface ClientVideo {
  id: ID;
  title: string;
  description: string;
  instructor: string;
  durationMin: number;
  level: string;
  category: string;
  thumbnailUrl: string;
  free: boolean;
  locked: boolean;
  /** null while locked. */
  videoUrl: string | null;
  /** When this client last pressed play. */
  lastWatchedAt: ISODateTime | null;
}

export interface OnDemandCatalog {
  /** True when the client has an active pass from a product that includes online classes (or is studio staff). */
  access: boolean;
  /** Published videos, in the studio's order. */
  videos: ClientVideo[];
}

export interface OnDemandSettings {
  /** Product ids that include online classes. */
  productIds: ID[];
}

export interface OnDemandStore {
  /** Client: the library. Locked videos come back without their address. */
  list(): Promise<OnDemandCatalog>;
  /** Client: pressed play (counts a view and feeds "Recently watched"). Refused while locked. */
  recordView(videoId: ID): Promise<void>;
  /** Owner and manager: every video, drafts included, with view counts. */
  adminList(): Promise<AdminVideo[]>;
  /** Owner and manager: add (no id) or edit. */
  save(input: VideoInput, id?: ID): Promise<AdminVideo>;
  setPublished(id: ID, published: boolean): Promise<void>;
  /** Owner and manager: the new order, every video id once. */
  reorder(ids: ID[]): Promise<void>;
  remove(id: ID): Promise<void>;
  getSettings(): Promise<OnDemandSettings>;
  saveSettings(settings: OnDemandSettings): Promise<OnDemandSettings>;
}

declare module '../../shared/store' {
  interface FeatureStores { ondemand: OnDemandStore }
}
