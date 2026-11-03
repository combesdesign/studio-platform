/**
 * Should `?demo=1` in the address force the demo data?
 * Only when the build has no Supabase URL (it is a demo build anyway), or when the build was made with
 * ALLOW_DEMO_PARAM=1 (e.g. a staging site). A live build ignores it, so nobody can flip a real studio into fake data.
 */
export function demoParamForcesDemo(opts: { supabaseUrl: string; allowDemoParam: boolean; search: string }): boolean {
  if (!/[?&]demo=1(&|$)/.test(opts.search)) return false;
  return !opts.supabaseUrl || opts.allowDemoParam;
}
