// Supabase clients for edge functions.
//   adminClient()  - service role: bypasses RLS. Only for things the caller has already been checked for.
//   userClient(req) - acts as the signed-in person (their JWT), so RLS + function permission checks apply.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { env, HttpError } from './http.ts';

// deno-lint-ignore no-explicit-any
export type Db = any;

export function adminClient(): Db {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
}

/** `studio` (id or slug) scopes every call to that studio, like the x-studio header the apps send. Omitted = the default studio. */
export function userClient(req: Request, studio?: string): Db {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.');
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth, ...(studio ? { 'x-studio': studio } : {}) } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Unwrap { data, error } and turn database errors into HttpErrors the app understands.
 *  Rows are untyped (no generated DB types), hence `any`. */
// deno-lint-ignore no-explicit-any
export function must(res: { data: any; error: { message?: string; code?: string } | null }): any {
  if (res.error) {
    const msg = res.error.message ?? 'Database error';
    const m = /^([A-Z][A-Z_]+):\s*([\s\S]*)$/.exec(msg);
    if (m) throw new HttpError(400, m[1] ?? 'ERROR', m[2] ?? msg);
    if (res.error.code === '42501') throw new HttpError(403, 'NOT_ALLOWED', 'You don’t have permission to do that.');
    console.error('db error', res.error);
    throw new HttpError(500, 'ERROR', 'Something went wrong. Please try again.');
  }
  return res.data;
}

export interface Me {
  kind: 'client' | 'staff';
  client_id?: string;
  staff_id?: string;
  role?: 'owner' | 'manager' | 'instructor' | 'front_desk';
  email: string;
  name: string;
}

export async function whoami(user: Db): Promise<Me> {
  const me = must(await user.rpc('whoami')) as Me | null;
  if (!me) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.');
  return me;
}
