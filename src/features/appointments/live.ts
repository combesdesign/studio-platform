/**
 * Live (Supabase) implementation of AppointmentsStore. Register it like this:
 *   registerLiveFeature({ name: 'appointments', create: (ctx) => ({ … ctx.rpc('appointments_…', { … }) … }) });
 * Not registered yet, so store.features.appointments is undefined until this feature is built.
 */
import './permissions';
