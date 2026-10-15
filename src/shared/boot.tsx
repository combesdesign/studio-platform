/**
 * App boot for every app: work out the studio (src/shared/resolve.ts order), bind the data store to it, apply
 * its branding, then load and mount the app. With no studio, show the app's fallback screen (the client app's
 * "Find your studio", the studio app's "which studio?") in the neutral platform look.
 * OWNED BY THE LEAD / PLATFORM.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Studio } from './types';
import { BUILD_STUDIO, PLATFORM_DOMAIN, bindStudio, platform } from '../data';
import { applyBranding, PLATFORM_BRANDING, PLATFORM_NAME, setAssetBase } from './branding';
import { slugFromHash, studioHints, stripStudioPath, type StudioHint } from './resolve';
import { Flower } from './brand';

export type AppKind = 'client' | 'studio' | 'admin';

const KEY = (app: AppKind) => `platform.studio.${app}`;
export function rememberedStudio(app: AppKind): string | null {
  try { return localStorage.getItem(KEY(app)); } catch { return null; }
}
export function rememberStudio(app: AppKind, slug: string | null): void {
  try { if (slug) localStorage.setItem(KEY(app), slug); else localStorage.removeItem(KEY(app)); } catch { /* private mode */ }
}

/** Is this a single-studio deployment (STUDIO_SLUG set at build time)? Then there's no studio switching. */
export const isSingleStudio = () => !!BUILD_STUDIO;

let resolvedBy: StudioHint | undefined;
/** How the current studio was found (for switching: subdomains switch host, everything else uses ?studio=). */
export const studioSource = () => resolvedBy?.source;

export async function resolveStudio(app: AppKind): Promise<{ studio: Studio | null; missing?: string }> {
  const hints = studioHints({
    buildSlug: BUILD_STUDIO, host: location.host, platformDomain: PLATFORM_DOMAIN,
    hash: location.hash, search: location.search, remembered: rememberedStudio(app),
  });
  for (const h of hints) {
    const s = await platform.findStudio(h.domain ? { domain: h.domain } : { slug: h.slug }).catch(() => null);
    if (s) {
      resolvedBy = h;
      if (h.source === 'path') history.replaceState(history.state, '', location.pathname + location.search + stripStudioPath(location.hash));
      if (h.source !== 'build' && h.source !== 'subdomain' && h.source !== 'domain') rememberStudio(app, s.slug);
      return { studio: s };
    }
    if (h.source === 'build') return { studio: null, missing: h.slug };
    if (h.source === 'remembered') rememberStudio(app, null);
  }
  return { studio: null };
}

/** Where a studio's app lives from here (keeps the app's own path: /, /studio/). */
export function studioUrl(slug: string): string {
  const host = location.host.replace(/:\d+$/, '');
  if (PLATFORM_DOMAIN && resolvedBy?.source === 'subdomain' && host.endsWith('.' + PLATFORM_DOMAIN)) {
    return `${location.protocol}//${slug}.${PLATFORM_DOMAIN}${location.port ? ':' + location.port : ''}${location.pathname}#/`;
  }
  return `${location.pathname}?studio=${encodeURIComponent(slug)}#/`;
}

/** Go to another studio (or, with null, back to the studio picker). Reloads: one bound store per page. */
export function switchStudio(app: AppKind, slug: string | null): void {
  rememberStudio(app, slug);
  if (slug) location.href = studioUrl(slug);
  else { location.href = location.pathname + '#/'; setTimeout(() => location.reload(), 30); }
}

export interface BootOptions {
  /** The app itself, loaded once a studio is bound. */
  load: () => Promise<{ mount: (root: Root, studio: Studio) => void }>;
  /** Shown when there's no studio: picker / sign-in. Call start(studio) to go on without a reload. */
  fallback: (p: { start: (s: Studio) => void; missing?: string }) => React.ReactNode;
  /** Shown instead of the app for a studio that isn't open to this app (e.g. suspended, for clients). */
  closed?: (studio: Studio) => React.ReactNode | null;
}

export function BootSplash() {
  return <div className="boot-splash" aria-busy="true" aria-label="Loading"><Flower size={40} className="boot-flower" /></div>;
}

export async function bootApp(app: AppKind, opts: BootOptions): Promise<void> {
  setAssetBase(app === 'client' ? '' : '../');
  const el = document.getElementById('root');
  if (!el) return;
  const root = createRoot(el);
  const start = async (studio: Studio) => {
    bindStudio(studio);
    const b = studio.branding?.colors ? studio.branding : PLATFORM_BRANDING;
    applyBranding(b, {
      title: app === 'studio' ? `Studio · ${b.appName || studio.name}` : b.appName || studio.name,
      themeColor: app === 'studio' ? b.colors.ink : b.colors.primary,
    });
    const shut = opts.closed?.(studio);
    if (shut) { root.render(shut); return; }
    root.render(<BootSplash />);
    const m = await opts.load();
    m.mount(root, studio);
  };
  if (!BUILD_STUDIO) { applyBranding(PLATFORM_BRANDING, { title: PLATFORM_NAME }); root.render(<BootSplash />); }
  // A '#/s/<slug>' link opened in a tab that's already running: go to that studio (one bound store per page).
  if (!BUILD_STUDIO) {
    window.addEventListener('hashchange', () => {
      const slug = slugFromHash(location.hash);
      if (slug) { rememberStudio(app, slug); location.reload(); }
    });
  }
  const r = await resolveStudio(app);
  if (r.studio) { await start(r.studio); return; }
  applyBranding(PLATFORM_BRANDING, { title: PLATFORM_NAME, themeColor: PLATFORM_BRANDING.colors.primary });
  root.render(opts.fallback({ start: (s) => { void start(s); }, ...(r.missing ? { missing: r.missing } : {}) }));
}
