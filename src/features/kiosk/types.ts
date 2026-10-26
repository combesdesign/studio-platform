/**
 * Check-in kiosk (ROADMAP B5): a full-screen, client-facing check-in for the front-desk iPad.
 * Everything for it lives in src/features/kiosk/. The only thing it stores is the studio's exit PIN.
 * SQL: supabase/migrations/1500_kiosk_pin.sql (range 1500-1599), tests supabase/tests/kiosk_*.sql.
 */
export interface KioskStore {
  /** Is an exit PIN set for this studio? (Staff only. Never returns the PIN.) */
  hasPin(): Promise<boolean>;
  /** Owner / manager: set a 4-digit PIN, or null to remove it (exiting then asks for the staff member's password). */
  setPin(pin: string | null): Promise<void>;
  /** Kiosk staff: is this the studio's PIN? False when none is set. */
  checkPin(pin: string): Promise<boolean>;
}

declare module '../../shared/store' {
  interface FeatureStores { kiosk: KioskStore }
}
