// Used only when @supabase/supabase-js isn't installed (offline sandbox builds). Demo mode never calls it.
export function createClient(): never {
  throw new Error('@supabase/supabase-js is not installed. Run npm install for the live build.');
}
export type SupabaseClient = any;
