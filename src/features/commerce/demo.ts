/**
 * Demo implementation of CommerceStore, plugged into the demo store. Register it like this:
 *   registerDemoFeature({ name: 'commerce', seed: ({ studio, state, now, newId }) => ({ … }), create: (ctx) => ({ … }) });
 * Not registered yet, so store.features.commerce is undefined until this feature is built.
 */
import './permissions';
