/**
 * Marketing feature: Marketing and messaging: campaigns, segments, automations, inbox, push (ROADMAP B2).
 * Owner: the marketing feature agent. Everything for this feature lives in src/features/marketing/ (see AGENTS.md › How to add a feature).
 * SQL: supabase/migrations/1200_marketing_*.sql (range 1200–1299), tests supabase/tests/marketing_*.sql.
 */

/** What the apps can call as store.features.marketing. Add methods here; implement them in demo.ts and live.ts. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MarketingStore {}

declare module '../../shared/store' {
  interface FeatureStores { marketing: MarketingStore }
}
