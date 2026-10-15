/**
 * Appointments feature: Appointments and events: private/duet appointments, availability, workshops, courses, spot selection (ROADMAP B1).
 * Owner: the appointments feature agent. Everything for this feature lives in src/features/appointments/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1100_appointments_*.sql (range 1100–1199), tests supabase/tests/appointments_*.sql.
 */

/** What the apps can call as store.features.appointments. Add methods here; implement them in demo.ts and live.ts. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AppointmentsStore {}

declare module '../../shared/store' {
  interface FeatureStores { appointments: AppointmentsStore }
}
