/**
 * Integrations (ROADMAP B5): ClassPass / Gympass partner hooks, and the Xero export.
 * Everything for it lives in src/features/integrations/.
 * SQL: supabase/migrations/1700-1701_integrations_*.sql (range 1700-1799), tests supabase/tests/integrations_*.sql.
 * Edge function: supabase/functions/partner-webhook (a stub). Notes: docs/features/integrations.md.
 *
 * REAL USE OF CLASSPASS OR GYMPASS NEEDS A PARTNER AGREEMENT with that company. This is the studio's side of the
 * plumbing, ready for when an agreement gives you a partner ID, an API key and the real webhook format.
 */
import type { ID, ISODateTime } from '../../shared/types';
import type { AccountingSettings } from './xero';

export type Partner = 'classpass' | 'gympass';
export const PARTNERS: readonly Partner[] = ['classpass', 'gympass'];
export const PARTNER_LABEL: Record<Partner, string> = { classpass: 'ClassPass', gympass: 'Gympass' };

export interface PartnerSetting {
  partner: Partner;
  enabled: boolean;
  /** The studio's own ID at the partner. An incoming webhook says which studio it is for with this. */
  partnerStudioId: string;
  /** An API key is saved. The key itself can never be read back (write-only). */
  keySet: boolean;
}

export interface PartnerSettingPatch {
  enabled?: boolean;
  partnerStudioId?: string;
  /** Owner only. undefined = leave it; '' = remove it. Never stored in the browser, never returned. */
  apiKey?: string;
}

/** Spots held back for a partner in every class of one class type. */
export interface ReservedSpots { classTypeId: ID; partner: Partner; spots: number }

/** A roster row that came from a partner. */
export interface PartnerBooking {
  bookingId: ID;
  sessionId: ID;
  source: Partner;
  partnerBookingId: string;
  memberName: string;
  createdAt: ISODateTime;
}

export interface IntegrationsStore {
  /** Owner and manager. Always both partners. */
  listPartners(): Promise<PartnerSetting[]>;
  savePartner(partner: Partner, patch: PartnerSettingPatch): Promise<PartnerSetting>;
  /** Any staff (the roster shows them). */
  listReserved(): Promise<ReservedSpots[]>;
  /** Owner and manager. 0 clears it. */
  setReserved(classTypeId: ID, partner: Partner, spots: number): Promise<void>;
  /** Any staff: the partner bookings in one class (for the roster badge). */
  partnerBookings(sessionId: ID): Promise<PartnerBooking[]>;
  /**
   * Demo only: stands in for the partner's webhook, so the roster badge and spot rules can be tried without a partner.
   * Same rules as the database function the real webhook calls. Live: undefined.
   */
  demoPartnerBook?(partner: Partner, sessionId: ID, memberName?: string): Promise<PartnerBooking>;

  /** Owner and manager: Xero account codes (defaults filled in). */
  getAccounting(): Promise<AccountingSettings>;
  saveAccounting(patch: Partial<AccountingSettings>): Promise<AccountingSettings>;
}

declare module '../../shared/store' {
  interface FeatureStores { integrations: IntegrationsStore }
}
