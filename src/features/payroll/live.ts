/**
 * Live (Supabase) implementation of PayrollStore. Register it like this:
 *   registerLiveFeature({ name: 'payroll', create: (ctx) => ({ … ctx.rpc('payroll_…', { … }) … }) });
 * Not registered yet, so store.features.payroll is undefined until this feature is built.
 */
import './permissions';
