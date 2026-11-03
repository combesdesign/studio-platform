/**
 * Push notifications: one small abstraction with two providers.
 *   web         the browser's Push API, through the app's service worker. Needs the server's VAPID public key.
 *   capacitor   the native iOS / Android shell (@capacitor/push-notifications), loaded on demand by shared/native.ts
 *               only in the app build, so the web bundle stays free of native code.
 * Both just register a device token with the store (store.features.marketing.registerPush). Sending is server-side and needs
 * keys (VAPID, FCM, APNs): until those are set, a registration is saved and getPushStatus says needsKeys. See NOTES.md › marketing.
 *
 * Capacitor (the iOS / Android apps): the shell calls @capacitor/push-notifications and registers the APNs (iOS) or FCM (Android)
 * token through the same registerPush call, with platform 'ios' | 'android' (capacitorProvider below). Saving the token works today.
 * DELIVERY to native devices is not built yet: the server only sends to 'web' devices (see the TODO in
 * supabase/functions/_shared/marketing.ts deliverPush and docs/APP-STORES.md, "Push notifications").
 */
import type { PushPlatform, PushRegistration } from './types';
import { isNative, nativePlatform } from '../../shared/nativeEnv';
import { plugins } from '../../shared/native';

declare const __VAPID_PUBLIC_KEY__: string;
/** The web push public key, set at build time (VAPID_PUBLIC_KEY in build.mjs). '' means web push isn't switched on. */
export const VAPID_PUBLIC_KEY: string = typeof __VAPID_PUBLIC_KEY__ === 'string' ? __VAPID_PUBLIC_KEY__ : '';

export type PushPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export interface PushProvider {
  platform: PushPlatform;
  /** Can this device receive push at all? */
  supported(): boolean;
  permission(): PushPermission;
  /** Ask for permission and return the registration to hand to the store. Throws a friendly Error when it can't. */
  subscribe(opts: { vapidPublicKey?: string }): Promise<PushRegistration>;
  /** Forget this device. Returns the token that was registered, if any. */
  unsubscribe(): Promise<string | null>;
}

// ------------------------------------------------------------------ native (Capacitor)

/** Just the parts of @capacitor/push-notifications we use (the plugin is loaded on demand, see shared/native.ts). */
interface CapacitorPush {
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  unregister?(): Promise<void>;
  addListener(ev: string, fn: (e: { value?: string; error?: string }) => void): Promise<{ remove(): void }> | { remove(): void };
}
const loadPush = async (): Promise<CapacitorPush> => ((await plugins.push()) as { PushNotifications: CapacitorPush }).PushNotifications;

export const capacitorProvider: PushProvider = {
  platform: 'ios',
  supported: () => isNative(),
  permission() { return this.supported() ? 'default' : 'unsupported'; },
  async subscribe() {
    const p = await loadPush().catch(() => null);
    if (!p) throw new Error('Notifications need the studio’s app.');
    const perm = await p.requestPermissions();
    if (perm.receive !== 'granted') throw new Error('Notifications are turned off for this app. You can switch them on in your phone’s settings.');
    const handles: { remove(): void }[] = [];
    const token = await new Promise<string>((resolve, reject) => {
      void Promise.resolve(p.addListener('registration', (e) => resolve(e.value ?? ''))).then((h) => handles.push(h), reject);
      void Promise.resolve(p.addListener('registrationError', (e) => reject(new Error(e.error || 'Couldn’t register this device.')))).then((h) => handles.push(h), reject);
      p.register().catch(reject);
    }).finally(() => handles.forEach((h) => h.remove()));
    if (!token) throw new Error('Couldn’t register this device.');
    lastNative = token;
    // iOS gives an APNs token, Android an FCM token. The server picks the sender from `platform`.
    return { platform: nativePlatform() === 'android' ? 'android' : 'ios', token };
  },
  async unsubscribe() {
    const t = lastNative;
    lastNative = null;
    try { await (await loadPush()).unregister?.(); } catch { /* already gone */ }
    return t;
  },
};
let lastNative: string | null = null;

// ------------------------------------------------------------------ web push

const b64 = (s: string): Uint8Array => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const toB64 = (buf: ArrayBuffer | null): string => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

export const webProvider: PushProvider = {
  platform: 'web',
  supported: () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  permission() {
    if (!this.supported()) return 'unsupported';
    return Notification.permission as PushPermission;
  },
  async subscribe({ vapidPublicKey }) {
    if (!this.supported()) throw new Error('This browser can’t show notifications. On iPhone, add the app to your home screen first.');
    if (!vapidPublicKey) throw new Error('Notifications aren’t switched on for this studio yet.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. You can allow them in your browser’s site settings.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(vapidPublicKey) as BufferSource }));
    return { platform: 'web', token: sub.endpoint, keys: { p256dh: toB64(sub.getKey('p256dh')), auth: toB64(sub.getKey('auth')) }, userAgent: navigator.userAgent.slice(0, 200) };
  },
  async unsubscribe() {
    if (!this.supported()) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return null;
      const token = sub.endpoint;
      await sub.unsubscribe();
      return token;
    } catch { return null; }
  },
};

/** The provider for this device: the native shell when there is one, otherwise the browser. */
export function pushProvider(): PushProvider { return capacitorProvider.supported() ? capacitorProvider : webProvider; }

/** The token this device registered (kept so "turn off" works without asking the browser again). */
const KEY = 'mk-push-token';
export const savedToken = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const saveToken = (t: string | null): void => { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

/** Can this device be offered the notification switch? The app: always. The browser: it must support web push and there must be a VAPID public key. */
export function canOptIn(serverKey?: string): boolean {
  if (capacitorProvider.supported()) return true;
  return webProvider.supported() && !!(VAPID_PUBLIC_KEY || serverKey);
}
