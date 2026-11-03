/**
 * The App Store / Google Play shell (Capacitor). Everything here is guarded by isNative(), so the web build behaves exactly as before.
 * Capacitor plugins are loaded with dynamic import() behind __NATIVE_BUILD__ (set by `npm run build:app`), so the normal web
 * bundle contains no Capacitor code at all. Plugins: browser, app, status-bar, splash-screen, push-notifications.
 * OWNED BY THE LEAD / PLATFORM. Docs: docs/APP-STORES.md.
 */
import { routeFromDeepLink } from './nativeLink';
import { NATIVE_BUILD, SCHEME, WEB_URL, isNative, nativePlatform } from './nativeEnv';

export { isNative, nativePlatform, appReturnUrl } from './nativeEnv';

const off = (): never => { throw new Error('Not running in the app'); };
/** Plugin loaders. In a web build the ternary folds away, so the import() (and the plugin) never reach the bundle. */
export const plugins = {
  // @ts-ignore: the @capacitor/* packages are only installed on a machine that has run npm install
  browser: () => (NATIVE_BUILD ? import('@capacitor/browser') : off()),
  // @ts-ignore
  app: () => (NATIVE_BUILD ? import('@capacitor/app') : off()),
  // @ts-ignore
  statusBar: () => (NATIVE_BUILD ? import('@capacitor/status-bar') : off()),
  // @ts-ignore
  splash: () => (NATIVE_BUILD ? import('@capacitor/splash-screen') : off()),
  // @ts-ignore
  push: () => (NATIVE_BUILD ? import('@capacitor/push-notifications') : off()),
};

// ------------------------------------------------------------------ links

/** Open a web page (Stripe, a studio website, a Google review). In the app: the system in-app browser. On the web: a new tab. */
export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    try { const { Browser } = await plugins.browser(); await Browser.open({ url }); return; } catch { /* fall through to the webview */ }
  }
  window.open(url, '_blank', 'noopener');
}

/** Leave for a payment or portal page. Web: same tab, as before. App: the in-app browser, and Stripe sends them back through a deep link. */
export function goExternal(url: string): void {
  if (isNative()) { void openExternal(url); return; }
  location.href = url;
}

function webHost(): string[] { try { return WEB_URL ? [new URL(WEB_URL).hostname] : []; } catch { return []; } }

// ------------------------------------------------------------------ start-up

const lightBg = (hex: string): boolean => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1]!, 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.55;
};
const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let started = false;
/** Called once from the client entry. Does nothing on the web. */
export function startNative(): void {
  if (started || !isNative()) return;
  started = true;
  const root = document.documentElement;
  root.classList.add('native', 'native-' + nativePlatform());

  // Links to other websites open in the in-app browser (mailto: and tel: are left to the phone).
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    let u: URL;
    try { u = new URL(a.href, location.href); } catch { return; }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin) { e.preventDefault(); void openExternal(u.href); }
  }, true);

  void (async () => {
    // Deep links: Stripe returning through the bridge page, universal links, or the custom URL scheme.
    try {
      const { App } = await plugins.app();
      await App.addListener('appUrlOpen', (ev: { url: string }) => {
        const route = routeFromDeepLink(ev.url, { scheme: SCHEME, hosts: webHost() });
        if (!route) return;
        void plugins.browser().then((b) => b.Browser.close()).catch(() => { /* already closed */ });
        const to = '#' + route;
        if (location.hash === to) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = to;
      });
      // Android hardware back: close sheets and step back through history like the in-app back buttons; at the top, leave the app.
      await App.addListener('backButton', ({ canGoBack }: { canGoBack: boolean }) => {
        const here = location.hash.replace(/^#/, '').split('?')[0] || '/';
        if (canGoBack) history.back();
        else if (here !== '/' && here !== '/timetable') location.replace('#/');
        else void App.exitApp();
      });
    } catch { /* plugin missing: the app still works, just without these */ }
  })();

  void (async () => {
    try {
      const { StatusBar, Style } = await plugins.statusBar();
      const bg = cssVar('--bg') || '#ffffff';
      await StatusBar.setStyle({ style: lightBg(bg) ? Style.Light : Style.Dark }); // Light = dark text
      if (nativePlatform() === 'android') await StatusBar.setBackgroundColor({ color: bg });
    } catch { /* not available */ }
  })();

  // Hide the launch splash once the app has painted its first screen (or after 4 seconds, whatever happens).
  let hidden = false;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    void plugins.splash().then((s) => s.SplashScreen.hide({ fadeOutDuration: 250 })).catch(() => { /* none */ });
  };
  const rootEl = document.getElementById('root');
  const painted = () => requestAnimationFrame(() => requestAnimationFrame(hide));
  if (rootEl?.childElementCount) painted();
  else if (rootEl) { const mo = new MutationObserver(() => { if (rootEl.childElementCount) { mo.disconnect(); painted(); } }); mo.observe(rootEl, { childList: true }); }
  setTimeout(hide, 4000);
}
