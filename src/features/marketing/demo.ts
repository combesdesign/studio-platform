/**
 * Demo implementation of MarketingStore, plugged into the demo store. Register it like this:
 *   registerDemoFeature({ name: 'marketing', seed: ({ studio, state, now, newId }) => ({ … }), create: (ctx) => ({ … }) });
 * Not registered yet, so store.features.marketing is undefined until this feature is built.
 */
import './permissions';
