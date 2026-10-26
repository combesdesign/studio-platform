/**
 * Push notifications: one small abstraction with two providers.
 *   web         the browser's Push API, through the app's service worker. Needs the server's VAPID public key.
 *   capacitor   the native iOS / Android shell (@capacitor/push-notifications), found at runtime on window.Capacitor, so
 *               nothing is imported and the web build stays free of native code.
 * Both just register a device token with the store (store.features.marketing.registerPush). Sending is server-side and needs
 * keys (VAPID, FCM, APNs): until those are set, a registration is saved and getPushStatus says needsKeys. See NOTES.md › marketing.
 *
 * Capacitor (native apps, later): the native shell would call @capacitor/push-notifications and register the APNs / FCM token
 * through the same registerPush call, with platform 'ios' | 'android' (that is what capacitorProvider below does). The server has
 * no APNs / FCM sender yet, so only 'web' devices are sent to. Until that sender exists the opt-in is web only (canOptIn),
 * so the native shell doesn't show a switch that can't deliver; flip that one line when APNs / FCM sending is built.
 */
import type { PushPlatform, PushRegistration } from './types';

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

interface CapacitorPush {
  requestPermissions(): Promise<{ receive: string }>;
  checkPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  unregister?(): Promise<void>;
  addListener(ev: string, fn: (e: { value?: string; error?: string }) => void): Promise<{ remove(): void }> | { remove(): void };
}
interface CapacitorGlobal { isNativePlatform?(): boolean; getPlatform?(): string; Plugins?: Record<string, unknown> }

const cap = (): CapacitorGlobal | null => (typeof window === 'undefined' ? null : ((window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null));
const capPlugin = (): CapacitorPush | null => (cap()?.Plugins?.PushNotifications as CapacitorPush | undefined) ?? null;

export const capacitorProvider: PushProvider = {
  platform: 'ios',
  supported: () => !!(cap()?.isNativePlatform?.() && capPlugin()),
  permission() { return this.supported() ? 'default' : 'unsupported'; },
  async subscribe() {
    const p = capPlugin();
    if (!p) throw new Error('Notifications need the studio’s app.');
    const perm = await p.requestPermissions();
    if (perm.receive !== 'granted') throw new Error('Notifications are turned off for this app. You can switch them on in your phone’s settings.');
    const token = await new Promise<string>((resolve, reject) => {
      void Promise.resolve(p.addListener('registration', (e) => resolve(e.value ?? ''))).catch(reject);
      void Promise.resolve(p.addListener('registrationError', (e) => reject(new Error(e.error || 'Couldn’t register this device.')))).catch(reject);
      p.register().catch(reject);
    });
    if (!token) throw new Error('Couldn’t register this device.');
    lastNative = token;
    return { platform: cap()?.getPlatform?.() === 'android' ? 'android' : 'ios', token };
  },
  async unsubscribe() {
    const t = lastNative;
    lastNative = null;
    try { await capPlugin()?.unregister?.(); } catch { /* already gone */ }
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

/** Can this device be offered the notification switch? Web push only for now: the browser must support it and there must be a VAPID public key. */
export function canOptIn(serverKey?: string): boolean {
  return pushProvider() === webProvider && webProvider.supported() && !!(VAPID_PUBLIC_KEY || serverKey);
}
