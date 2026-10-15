/**
 * Demo implementation of AppointmentsStore, plugged into the demo store. Register it like this:
 *   registerDemoFeature({ name: 'appointments', seed: ({ studio, state, now, newId }) => ({ … }), create: (ctx) => ({ … }) });
 * Not registered yet, so store.features.appointments is undefined until this feature is built.
 */
import './permissions';
