/**
 * Read-only mode for a studio's STAFF when its plan payment has been overdue past the grace period (see billingState in
 * src/shared/plans.ts). The studio app wraps its store with this: anything that reads still works, anything that writes says so
 * plainly. Clients are never wrapped: they can still book. The database enforces the same rule for staff
 * (app.billing_read_only_guard in 0012_platform_billing.sql); this is what makes the app say it nicely instead of showing a raw error.
 *
 * Allow-list, not deny-list: a method counts as a read when its name starts with get / list / find / preview / quote / is / has / my /
 * export / search / count / check / read / can, or is one of the few account and billing methods below. Everything else (every new
 * write added later, core or feature) is blocked by default.
 */
import { StoreError, type DataStore } from '../shared/store';

export const READ_ONLY_MESSAGE = 'Your studio is read-only until the plan payment is sorted out. Your clients can still book.';

const READ = /^(get|list|find|preview|quote|is|has|my|export|search|count|check|read|can)([A-Z_]|$)/;
const ALLOWED = new Set([
  'subscribe', 'currentUser', 'signIn', 'signOut', 'requestPasswordReset', 'setNewPassword', 'onPasswordRecovery',
  'startPlanCheckout', 'openBillingPortal', 'demoSignInAs', 'demoReset', 'demoPersonas', 'demoOpenPasswordLink',
]);
/** Feature stores that stay fully usable (asking us for help is never blocked). */
const OPEN_FEATURES = new Set(['support']);

const isRead = (name: string): boolean => ALLOWED.has(name) || READ.test(name);
const blocked = (): Promise<never> => Promise.reject(new StoreError('READ_ONLY', READ_ONLY_MESSAGE));

function wrapObject<T extends object>(obj: T, bindTo: object): T {
  return new Proxy(obj, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== 'function' || typeof k !== 'string') return v;
      return isRead(k) ? v.bind(bindTo) : blocked;
    },
  });
}

export function readOnlyStore(inner: DataStore): DataStore {
  return new Proxy(inner, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k === 'features') {
        const raw = v as Record<string, object | undefined>;
        return new Proxy(raw, {
          get: (ft, name) => {
            const f = Reflect.get(ft, name, ft) as object | undefined;
            return f && typeof name === 'string' && !OPEN_FEATURES.has(name) ? wrapObject(f, f) : f;
          },
        });
      }
      if (typeof v !== 'function' || typeof k !== 'string') return v;
      return isRead(k) ? v.bind(t) : blocked;
    },
  });
}
