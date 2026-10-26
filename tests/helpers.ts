/** Test helpers: a tiny hand-built studio state + a demo store with an injectable clock. */
import type { DataStore } from '../src/shared/store';
import type { AuthUser, ClassSession, Client, ID } from '../src/shared/types';
import { studioToUTC } from '../src/shared/format';
import { createDemoStore, memoryStorage } from '../src/data/demo';
import { STATE_VERSION, type DemoState } from '../src/data/demo/engine';
import { CLASS_TYPES, PRODUCTS, STAFF, defaultSettings } from '../src/data/demo/fixtures';

export const at = (date: string, hhmm: string) => new Date(studioToUTC(date, hhmm));

export function mkClient(id: ID, firstName: string, extra: Partial<Client> = {}): Client {
  return {
    id, firstName, lastName: 'Test', email: `${firstName.toLowerCase()}@example.com`, createdAt: '2026-01-01T00:00:00.000Z',
    marketingOptIn: false, waiverSignedAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

export function mkSession(id: ID, date: string, hhmm: string, extra: Partial<ClassSession> = {}): ClassSession {
  const startsAt = studioToUTC(date, hhmm);
  return {
    id, classTypeId: 'ct_mat', startsAt, endsAt: new Date(Date.parse(startsAt) + 55 * 60_000).toISOString(),
    instructorId: 'st_julia', capacity: 14, status: 'scheduled', ...extra,
  };
}

export function baseState(over: Partial<DemoState> = {}): DemoState {
  return {
    version: STATE_VERSION, seededAt: '2026-01-01T00:00:00.000Z', historyFrom: '2026-01-01', settings: defaultSettings(),
    staff: STAFF.map((s) => ({ ...s })), classTypes: CLASS_TYPES.map((c) => ({ ...c })), templates: [], sessions: [], bookings: [],
    clients: [], products: PRODUCTS.map((p) => ({ ...p })), passes: [], sales: [], passSale: {}, outbox: [], ...over,
  };
}

export const OWNER: AuthUser = { kind: 'staff', staffId: 'st_libby', email: 'libby@snowypilatesclub.com', name: 'Libby', role: 'owner' };
export const JULIA: AuthUser = { kind: 'staff', staffId: 'st_julia', email: 'julia@snowypilatesclub.com', name: 'Julia', role: 'instructor' };
export const asClient = (clientId: ID): AuthUser => ({ kind: 'client', clientId, email: '', name: '' });

export interface Harness {
  store: DataStore;
  setNow(d: Date): void;
  as(u: AuthUser): Promise<void>;
  /** Buy a product for a client as the owner (cash). */
  give(clientId: ID, productId: ID): Promise<ID>;
}

export async function harness(state: DemoState, now: Date): Promise<Harness> {
  let t = now;
  const store = createDemoStore({ sampleBilling: false, now: () => t, latencyMs: 0, storage: memoryStorage(), initialState: state, app: 'studio' });
  const h: Harness = {
    store,
    setNow: (d) => { t = d; },
    as: async (u) => { await store.demoSignInAs!(u); },
    give: async (clientId, productId) => {
      await store.demoSignInAs!(OWNER);
      const r = await store.purchase({ clientId, productId, method: 'cash' });
      return r.pass!.id;
    },
  };
  await h.as(OWNER);
  return h;
}

export async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c !== code) throw new Error(`expected ${code}, got ${c}: ${(e as Error).message}`);
    return;
  }
  throw new Error(`expected ${code}, but it resolved`);
}
