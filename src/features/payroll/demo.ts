/**
 * Demo implementation of PayrollStore, plugged into the demo store. Register it like this:
 *   registerDemoFeature({ name: 'payroll', seed: ({ studio, state, now, newId }) => ({ … }), create: (ctx) => ({ … }) });
 * Not registered yet, so store.features.payroll is undefined until this feature is built.
 */
import './permissions';
