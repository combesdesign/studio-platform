/**
 * Demo store hook for feature modules (src/features/<name>/demo.ts).
 *
 *   registerDemoFeature({
 *     name: 'appointments',
 *     seed: ({ studio, state, now, newId }) => ({ slots: [] }),      // optional: initial data per studio
 *     create: (ctx) => ({ listSlots: () => ctx.read(() => ctx.slice<MySlice>().slots) }),
 *   });
 *
 * The slice lives in the studio's demo state under features[name], so it persists, syncs across tabs and is
 * wiped by demo reset like everything else. ctx.write() rolls the whole studio back if fn throws.
 */
import type { StoreError } from '../../shared/store';
import type { FeatureStores } from '../../shared/store';
import type { AuthUser, ID, Staff, Studio } from '../../shared/types';
import type { DemoState, Engine } from './engine';

export interface DemoFeatureContext {
  readonly studioId: ID;
  studio(): Studio;
  now(): Date;
  /** This feature's slice of the studio's demo data (created by seed(), or {} if there was none). */
  slice<T>(): T;
  /** Read with demo latency, cross-tab sync and a deep copy of the result. */
  read<T>(fn: () => T): Promise<T>;
  /** Write: latency, rollback on error, persist, notify subscribers. */
  write<T>(fn: () => T): Promise<T>;
  /** Signed-in user in this studio (throws AUTH_REQUIRED). */
  me(): AuthUser;
  /** Signed-in staff with a permission (core StaffAction or a registered feature action). Throws NOT_ALLOWED. */
  requireStaff(action: string): Staff;
  /** The client themselves, or staff with `action` (default clients_view). */
  requireSelfOrStaff(clientId: ID, action?: string): AuthUser;
  /** Core studio data (clients, sessions, bookings…) and the booking engine, for reading and for core operations. */
  core(): { state: DemoState; engine: Engine };
  newId(prefix: string): ID;
  error(code: string, message: string): StoreError;
}

export interface DemoFeature<K extends keyof FeatureStores = keyof FeatureStores> {
  name: K;
  seed?(args: { studio: Studio; state: DemoState; now: Date; newId: (prefix: string) => ID }): unknown;
  create(ctx: DemoFeatureContext): FeatureStores[K];
}

const features: DemoFeature[] = [];
export function registerDemoFeature<K extends keyof FeatureStores>(f: DemoFeature<K>): void {
  const i = features.findIndex((x) => x.name === f.name);
  if (i >= 0) features.splice(i, 1);
  features.push(f as unknown as DemoFeature);
}
export function demoFeatures(): readonly DemoFeature[] { return features; }

/** Run every feature's seed for one studio's freshly seeded state. */
export function seedFeatures(studio: Studio, state: DemoState, now: Date): void {
  let n = 0;
  for (const f of features) {
    if (!f.seed) continue;
    const slice = f.seed({ studio, state, now, newId: (p) => `${p}_${f.name}_${(++n).toString(36)}` });
    if (slice !== undefined) (state.features ??= {})[f.name] = slice;
  }
}
