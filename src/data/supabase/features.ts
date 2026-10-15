/**
 * Live (Supabase) store hook for feature modules (src/features/<name>/live.ts).
 *
 *   registerLiveFeature({
 *     name: 'appointments',
 *     create: (ctx) => ({
 *       listSlots: (day) => ctx.read(async () => (await ctx.rpc('appointments_list_slots', { p_day: day })) as Slot[]),
 *     }),
 *   });
 *
 * ctx.sb is already scoped to the bound studio (it sends the x-studio header, so RLS and studio-scoped RPCs see
 * only that studio). Database errors 'CODE: message' come back as StoreError(code, message).
 */
import type { FeatureStores, StoreError } from '../../shared/store';
import type { AuthUser, ID } from '../../shared/types';

export interface LiveFeatureContext {
  readonly studioId: ID;
  /** supabase-js client bound to the studio (untyped offline). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly sb: any;
  /** Call a Postgres function; errors become StoreError. */
  rpc(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Await a query builder; returns rows (errors become StoreError). */
  rows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Record<string, unknown>[]>;
  read<T>(fn: () => Promise<T>): Promise<T>;
  /** Writes notify the store's subscribers afterwards. */
  write<T>(fn: () => Promise<T>): Promise<T>;
  currentUser(): Promise<AuthUser | null>;
  error(code: string, message: string): StoreError;
}

export interface LiveFeature<K extends keyof FeatureStores = keyof FeatureStores> {
  name: K;
  create(ctx: LiveFeatureContext): FeatureStores[K];
}

const features: LiveFeature[] = [];
export function registerLiveFeature<K extends keyof FeatureStores>(f: LiveFeature<K>): void {
  const i = features.findIndex((x) => x.name === f.name);
  if (i >= 0) features.splice(i, 1);
  features.push(f as unknown as LiveFeature);
}
export function liveFeatures(): readonly LiveFeature[] { return features; }
