/**
 * Which studio does this page belong to? Pure functions (tested in tests/platform.test.ts); src/shared/boot.tsx
 * does the async part (looking the hints up in the PlatformStore).
 *
 * Order, first match wins:
 *   1. build-time config   STUDIO_SLUG=snowy node build.mjs   (the Snowy single-studio deployment: nothing else applies)
 *   2. hostname            harbour.<platform domain>, or a studio's custom domain (app.snowypilatesclub.com)
 *   3. path                #/s/<slug>  (hash routing, so it works inside Capacitor too)
 *   4. query               ?studio=<slug>
 *   5. remembered          the studio picked last time on this device
 *   6. nothing             client app: "Find your studio"; studio app: the staff member's memberships
 */

export type HintSource = 'build' | 'subdomain' | 'domain' | 'path' | 'query' | 'remembered';
export interface StudioHint { source: HintSource; slug?: string; domain?: string }

/** Subdomains of the platform domain that are never studios. */
export const NON_STUDIO_SUBDOMAINS = ['www', 'app', 'admin', 'api', 'studio', 'studios'];

export function cleanSlug(s?: string | null): string | undefined {
  const v = decodeURIComponent((s ?? '').trim()).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(v) ? v : undefined;
}

const isLocalHost = (h: string) => !h || h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.endsWith('.local') || h === '[::1]';

/** '#/s/harbour/passes?x=1' -> 'harbour' */
export function slugFromHash(hash: string): string | undefined {
  const m = /^#?\/s\/([^/?#]+)/.exec(hash || '');
  return m ? cleanSlug(m[1]) : undefined;
}
/** '#/s/harbour/passes' -> '#/passes'; anything else unchanged. */
export function stripStudioPath(hash: string): string {
  const m = /^#?\/s\/[^/?#]+(.*)$/.exec(hash || '');
  if (!m) return hash;
  const rest = m[1] || '/';
  return '#' + (rest.startsWith('/') ? rest : '/' + rest);
}

export function studioHints(i: {
  buildSlug?: string;
  host?: string;
  platformDomain?: string;
  hash?: string;
  search?: string;
  remembered?: string | null;
}): StudioHint[] {
  const build = cleanSlug(i.buildSlug);
  if (build) return [{ source: 'build', slug: build }];
  const out: StudioHint[] = [];
  const host = (i.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const domain = (i.platformDomain ?? '').toLowerCase().replace(/^\.+/, '');
  if (domain && host.endsWith('.' + domain)) {
    const label = host.slice(0, -(domain.length + 1)).split('.').pop() ?? '';
    const slug = cleanSlug(label);
    if (slug && !NON_STUDIO_SUBDOMAINS.includes(slug)) out.push({ source: 'subdomain', slug });
  } else if (!isLocalHost(host) && host !== domain && !(domain && host === 'www.' + domain)) {
    out.push({ source: 'domain', domain: host });
  }
  const path = slugFromHash(i.hash ?? '');
  if (path) out.push({ source: 'path', slug: path });
  const q = cleanSlug(new URLSearchParams((i.search ?? '').replace(/^\?/, '')).get('studio'));
  if (q) out.push({ source: 'query', slug: q });
  const r = cleanSlug(i.remembered);
  if (r) out.push({ source: 'remembered', slug: r });
  return out;
}
