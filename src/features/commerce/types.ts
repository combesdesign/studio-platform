/**
 * Commerce feature: Selling extras: gift cards, promo codes, referrals, retail stock (ROADMAP B3).
 * Owner: the commerce feature agent. Everything for this feature lives in src/features/commerce/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1300_commerce_*.sql (range 1300–1399), tests supabase/tests/commerce_*.sql.
 */

/** What the apps can call as store.features.commerce. Add methods here; implement them in demo.ts and live.ts. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CommerceStore {}

declare module '../../shared/store' {
  interface FeatureStores { commerce: CommerceStore }
}
