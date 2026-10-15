/**
 * The data layer the apps import.
 *   platform        PlatformStore: studios, person-level sign-in, platform admin (demo or live)
 *   store           DataStore bound to the current studio. A live binding: it's replaced by bindStudio() at boot,
 *                   so always read `store.x` at call time (never copy `store` into a module-level constant).
 *   bindStudio(s)   bind `store` to a studio and switch dates / money to its timezone, locale and currency.
 *
 * Live (Supabase) when the build has SUPABASE_URL + SUPABASE_ANON_KEY, otherwise the demo (fake data in the browser).
 * Build-time studio: STUDIO_SLUG (the Snowy single-studio deployment). Platform domain: PLATFORM_DOMAIN.
 * OWNED BY THE LEAD / PLATFORM.
 */
import { StoreError, type DataStore, type PlatformStore } from '../shared/store';
import type { Studio } from '../shared/types';
import { setStudioFormat } from '../shared/format';
import { createDemoPlatform } from './demo';
import { createSupabasePlatform } from './supabase';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;
declare const __STUDIO_SLUG__: string;
declare const __PLATFORM_DOMAIN__: string;

const url = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
const key = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : '';
const forceDemo = typeof location !== 'undefined' && /[?&]demo=1/.test(location.search);

/** Set at build time for a single-studio deployment (e.g. 'snowy'); '' for the platform. */
export const BUILD_STUDIO = typeof __STUDIO_SLUG__ === 'string' ? __STUDIO_SLUG__ : '';
/** The platform's own domain, for <slug>.<domain> studio subdomains (e.g. 'studioplatform.app'). */
export const PLATFORM_DOMAIN = typeof __PLATFORM_DOMAIN__ === 'string' ? __PLATFORM_DOMAIN__ : '';

export const platform: PlatformStore = url && key && !forceDemo ? createSupabasePlatform(url, key) : createDemoPlatform();

/** Until a studio is bound, every call fails with NO_STUDIO (boot binds before any app screen renders). */
function unbound(): DataStore {
  const fail = () => Promise.reject(new StoreError('NO_STUDIO', 'Pick a studio first.'));
  return new Proxy({} as DataStore, {
    get: (_t, k) => (k === 'mode' ? platform.mode : k === 'features' ? {} : k === 'studioId' ? '' : k === 'subscribe' ? () => () => {} : fail),
  });
}

export let store: DataStore = unbound();
export let currentStudio: Studio | null = null;

export function bindStudio(studio: Studio): DataStore {
  currentStudio = studio;
  store = platform.forStudio(studio);
  setStudioFormat({ timezone: studio.timezone, locale: studio.locale, currency: studio.currency, taxRate: studio.taxRate });
  return store;
}
