/**
 * Reviews and NPS after class (ROADMAP B5). Everything for it lives in src/features/reviews/.
 * SQL: supabase/migrations/1600_reviews.sql (range 1600-1699), tests supabase/tests/reviews_*.sql.
 */
import type { ID, ISODateTime } from '../../shared/types';

/** The class a client can be asked about: their latest checked-in class that has finished and hasn't been rated or dismissed. */
export interface ReviewPrompt {
  bookingId: ID;
  sessionId: ID;
  classTypeId: ID;
  className: string;
  instructorId: ID;
  instructorName: string;
  startsAt: ISODateTime;
}

export interface ReviewInput {
  /** 1 to 5 flowers. */
  rating: number;
  /** "Would you recommend us?" 0 to 10. Optional. */
  nps?: number | null;
  comment?: string;
}

/** One review as staff see it. */
export interface ReviewEntry {
  id: ID;
  bookingId: ID;
  sessionId: ID;
  classTypeId: ID;
  instructorId: ID;
  clientFirstName: string;
  rating: number;
  nps: number | null;
  comment: string | null;
  createdAt: ISODateTime;
}

export interface ReviewSubmitResult {
  /** Set only when the client scored us 9 or 10 and the studio saved a Google review link. */
  googleUrl?: string;
}

export interface ReviewsSettings {
  /** "Ask happy clients (9 to 10) to leave a Google review": the link to send them to. Empty = off. */
  googleReviewUrl: string;
}

export interface ReviewsStore {
  /** Client: the class to ask about, or null. */
  pendingPrompt(): Promise<ReviewPrompt | null>;
  /** Client: rate a class (once per booking). */
  submit(bookingId: ID, input: ReviewInput): Promise<ReviewSubmitResult>;
  /** Client: "Not now": never ask about this booking again. */
  dismiss(bookingId: ID): Promise<void>;
  /** Staff: owner and manager get every review; an instructor gets only their own classes'. Newest first. */
  list(): Promise<ReviewEntry[]>;
  getSettings(): Promise<ReviewsSettings>;
  /** Owner and manager. */
  saveSettings(patch: Partial<ReviewsSettings>): Promise<ReviewsSettings>;
}

declare module '../../shared/store' {
  interface FeatureStores { reviews: ReviewsStore }
}
