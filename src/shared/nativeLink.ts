/**
 * Pure helpers for the Capacitor (App Store / Google Play) build: the app id, the custom URL scheme, the
 * "bridge" page address Stripe returns to, and turning an opened link back into an in-app hash route.
 * No browser or Capacitor code here, so build.mjs, capacitor.config.ts, the app and the tests can all share it.
 * OWNED BY THE LEAD / PLATFORM.
 */

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Reverse-domain app id for a studio: `com.snowypilatesclub.app` from its website (snowypilatesclub.com).
 * Falls back to `app.studioplatform.<slug>` when the studio has no website. Override with APP_ID at build time.
 */
export function deriveAppId(studio: { slug: string; website?: string }): string {
  let host = '';
  try { host = new URL(studio.website ?? '').hostname.toLowerCase().replace(/^www\./, ''); } catch { /* no website */ }
  const labels = host.split('.').map(clean).filter(Boolean);
  const twoPart = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && ['com', 'net', 'org', 'co', 'gov', 'edu', 'asn', 'id'].includes(labels[labels.length - 2]!); // harbour.com.au
  const base = labels.length >= 2 ? labels.slice(twoPart ? -3 : -2).reverse() : ['app', 'studioplatform', clean(studio.slug) || 'studio'];
  const parts = labels.length >= 2 ? [...base, 'app'] : base;
  // each part must start with a letter (Android package rule) and never be a Java keyword; keep it simple
  return parts.map((p) => (/^[a-z]/.test(p) ? p : 'x' + p)).join('.');
}

export const isValidAppId = (id: string): boolean => /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(id);

/** The custom URL scheme that opens the app. Same as the app id (Apple's advice: reverse-DNS so it can't clash). */
export const appSchemeFor = (appId: string): string => appId;
const SCHEME_RE = /^[a-z][a-z0-9.+-]{2,60}$/;

/**
 * Where Stripe (or any web page) sends the person back to. A page on the studio's own web address (public/open.html)
 * that opens the app. If universal links / app links are set up, the phone opens the app straight from this https
 * address and the page never shows.
 */
export function bridgeUrl(webUrl: string, scheme: string, route: string): string {
  const base = webUrl.replace(/\/+$/, '');
  return `${base}/open.html?scheme=${encodeURIComponent(scheme)}&to=${encodeURIComponent(cleanRoute(route) ?? '/')}`;
}

/** The custom-scheme address the bridge page opens: `<scheme>://open?to=%2Fpasses%3Fpaid%3D1`. */
export function schemeUrl(scheme: string, route: string): string | null {
  if (!SCHEME_RE.test(scheme)) return null;
  return `${scheme}://open?to=${encodeURIComponent(cleanRoute(route) ?? '/')}`;
}

/** '/passes?paid=1' for '#/passes?paid=1' or '/passes?paid=1'; null for anything that isn't an in-app route. */
export function cleanRoute(r: string | null | undefined): string | null {
  if (!r) return null;
  let s = r.trim().replace(/^#/, '');
  if (!s.startsWith('/') || s.startsWith('//') || /[\u0000-\u001f\\]/.test(s) || /^\/*[a-z]+:/i.test(s)) return null;
  if (s.length > 600) return null;
  if (s === '/') s = '/';
  return s;
}

/**
 * Turn a link the app was opened with into a hash route (without '#'), or null if it isn't ours.
 *   com.x.app://open?to=%2Fpasses%3Fpaid%3D1   -> /passes?paid=1     (Stripe return via the bridge page)
 *   com.x.app://class/abc                      -> /class/abc          (hand-made links)
 *   https://app.x.com/#/class/abc              -> /class/abc          (universal / app links)
 *   https://app.x.com/open.html?to=%2Fpasses   -> /passes
 */
export function routeFromDeepLink(raw: string, opts: { scheme?: string; hosts?: string[] } = {}): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const proto = u.protocol.replace(/:$/, '');
  const web = proto === 'https' || proto === 'http';
  if (web) {
    if (opts.hosts && !opts.hosts.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase())) return null;
  } else if (opts.scheme && proto !== opts.scheme.toLowerCase()) return null;
  else if (proto === 'javascript' || proto === 'data' || proto === 'file') return null;
  const to = u.searchParams.get('to');
  if (to) return cleanRoute(to);
  if (u.hash.startsWith('#/')) return cleanRoute(u.hash);
  if (!web) {
    // com.x.app://class/abc -> host 'class', path '/abc'
    const p = `/${decodeURIComponent(u.host)}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return u.host === 'open' || !u.host ? '/' : cleanRoute(p);
  }
  return null;
}
