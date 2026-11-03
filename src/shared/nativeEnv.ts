/**
 * Is this the App Store / Google Play app, and where do web pages send people back to. No Capacitor imports (safe anywhere).
 * OWNED BY THE LEAD / PLATFORM. See native.ts for the plugin side.
 */
import { bridgeUrl } from './nativeLink';

declare const __NATIVE_BUILD__: boolean;
declare const __APP_SCHEME__: string;
declare const __WEB_URL__: string;

export const NATIVE_BUILD = typeof __NATIVE_BUILD__ === 'boolean' && __NATIVE_BUILD__;
export const SCHEME = typeof __APP_SCHEME__ === 'string' ? __APP_SCHEME__ : '';
export const WEB_URL = typeof __WEB_URL__ === 'string' ? __WEB_URL__ : '';

interface CapGlobal { isNativePlatform?(): boolean; getPlatform?(): string }
const cap = (): CapGlobal | null => (typeof window === 'undefined' ? null : ((window as unknown as { Capacitor?: CapGlobal }).Capacitor ?? null));

/** True inside the iOS / Android app (checks window.Capacitor, which only exists there). */
export const isNative = (): boolean => !!cap()?.isNativePlatform?.();
export const nativePlatform = (): 'ios' | 'android' | 'web' => (isNative() ? (cap()?.getPlatform?.() === 'android' ? 'android' : 'ios') : 'web');

/**
 * Where Stripe should send people back to for an in-app route like '/passes?paid=p1'.
 * Web: this page plus '#route', exactly as before. App: the studio's web bridge page (public/open.html), which opens the app by
 * universal link / app link or the custom URL scheme. Needs WEB_URL (a studio custom domain or website) at build time.
 */
export function appReturnUrl(route: string): string {
  if (isNative() && WEB_URL && SCHEME) return bridgeUrl(WEB_URL, SCHEME, route);
  return location.href.split('#')[0] + '#' + route;
}

