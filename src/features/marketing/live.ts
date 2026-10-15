/**
 * Live (Supabase) implementation of MarketingStore. Register it like this:
 *   registerLiveFeature({ name: 'marketing', create: (ctx) => ({ … ctx.rpc('marketing_…', { … }) … }) });
 * Not registered yet, so store.features.marketing is undefined until this feature is built.
 */
import './permissions';
