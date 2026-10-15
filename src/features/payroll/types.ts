/**
 * Payroll feature: Staff and payroll: sub/cover requests, pay rules, timesheets, payroll export (ROADMAP B4).
 * Owner: the payroll feature agent. Everything for this feature lives in src/features/payroll/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1400_payroll_*.sql (range 1400–1499), tests supabase/tests/payroll_*.sql.
 */

/** What the apps can call as store.features.payroll. Add methods here; implement them in demo.ts and live.ts. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PayrollStore {}

declare module '../../shared/store' {
  interface FeatureStores { payroll: PayrollStore }
}
