/**
 * Live (Supabase) implementation of CommerceStore. Register it like this:
 *   registerLiveFeature({ name: 'commerce', create: (ctx) => ({ … ctx.rpc('commerce_…', { … }) … }) });
 * Not registered yet, so store.features.commerce is undefined until this feature is built.
 */
import './permissions';
