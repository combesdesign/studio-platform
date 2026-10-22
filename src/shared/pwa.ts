/**
 * Home-screen identity for the multi-studio build: the web app manifest and apple-touch-icon follow the current studio,
 * made at runtime from its branding (name, colours, icon or mark). The single-studio build (STUDIO_SLUG) already gets its
 * own at build time (build.mjs), so boot.tsx doesn't call this there. Browser-only; the pure parts are exported for tests.
 * OWNED BY THE LEAD / PLATFORM.
 */
import type { StudioBranding } from './types';

export type PwaApp = 'client' | 'studio';

export interface PwaIdentity {
  name: string;
  shortName: string;
  /** Background of the generated icon and the launch screen. */
  iconBg: string;
  iconFg: string;
  themeColor: string;
  backgroundColor: string;
}

/** What the client and studio apps are called and coloured on a home screen. The studio app uses the darker ink, like Snowy's. */
export function pwaIdentity(b: StudioBranding, app: PwaApp, studioName: string): PwaIdentity {
  const name = b.appName || studioName;
  const short = b.shortName || name.slice(0, 12);
  return app === 'studio'
    ? { name: `${name} Studio`, shortName: `${short} Studio`.slice(0, 16), iconBg: b.colors.ink, iconFg: b.colors.bg, themeColor: b.colors.ink, backgroundColor: b.colors.bg }
    : { name, shortName: short, iconBg: b.colors.primary, iconFg: b.colors.bg, themeColor: b.colors.primary, backgroundColor: b.colors.bg };
}

/** Up to two capital letters for an icon with no mark: "Harbour Reformer Co." -> "HR". */
export function initialsFor(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

export function manifestFor(id: PwaIdentity, o: { startUrl: string; scope: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] }): Record<string, unknown> {
  return {
    name: id.name, short_name: id.shortName, start_url: o.startUrl, scope: o.scope, display: 'standalone',
    background_color: id.backgroundColor, theme_color: id.themeColor, icons: o.icons,
  };
}

// ------------------------------------------------------------------ browser side

function drawIcon(b: StudioBranding, id: PwaIdentity, size: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = id.iconBg;
  g.fillRect(0, 0, size, size); // full bleed: iOS rounds it, Android masks it
  g.fillStyle = id.iconFg;
  if (b.mark?.d && typeof Path2D !== 'undefined') {
    const vb = (b.mark.viewBox ?? '0 0 100 100').split(/\s+/).map(Number);
    const [vx = 0, vy = 0, vw = 100, vh = 100] = vb;
    const box = size * 0.5; // inside the maskable safe zone
    const k = box / Math.max(vw, vh);
    g.translate((size - vw * k) / 2 - vx * k, (size - vh * k) / 2 - vy * k);
    g.scale(k, k);
    g.fill(new Path2D(b.mark.d));
  } else {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${Math.round(size * 0.36)}px "${b.fonts.display}", Georgia, serif`;
    g.fillText(initialsFor(id.name), size / 2, size * 0.53);
  }
  return canvas.toDataURL('image/png');
}

function setLink(rel: string, href: string, extra: Record<string, string> = {}): void {
  document.head.querySelectorAll(`link[rel="${rel}"]`).forEach((n) => n.remove());
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  for (const [k, v] of Object.entries(extra)) link.setAttribute(k, v);
  document.head.appendChild(link);
}

/** Make the manifest and touch icon for this studio and put them on the page. Never throws (it's polish). */
export async function applyPwaIdentity(b: StudioBranding, app: PwaApp, studio: { slug: string; name: string }): Promise<void> {
  try {
    const id = pwaIdentity(b, app, studio.name);
    // Draw with the studio's display font when it has loaded (it's requested by applyBranding); don't wait long.
    try { await Promise.race([document.fonts.load(`40px "${b.fonts.display}"`), new Promise((r) => setTimeout(r, 1200))]); } catch { /* fine */ }
    const here = new URL(location.href);
    const url = (u: string) => new URL(u, here).href;
    // The client app has its own icon file when the studio uploaded one; otherwise everything is drawn.
    const own = app === 'client' && b.iconUrl ? url(b.iconUrl) : null;
    const i192 = own ?? drawIcon(b, id, 192);
    const i512 = own ?? drawIcon(b, id, 512);
    const touch = own ?? drawIcon(b, id, 180);
    const dir = here.origin + here.pathname.replace(/[^/]*$/, '');
    const start = new URL(dir);
    start.searchParams.set('studio', studio.slug); // a studio's own subdomain or domain wins over this, so it's harmless there
    const icons = [i192 && { src: i192, sizes: '192x192', type: 'image/png' }, i512 && { src: i512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }].filter(Boolean) as { src: string; sizes: string; type: string; purpose?: string }[];
    const manifest = manifestFor(id, { startUrl: start.href, scope: dir, icons });
    setLink('manifest', URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' })));
    if (touch) setLink('apple-touch-icon', touch);
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', id.shortName);
  } catch (e) {
    console.warn('Could not make the home screen icon for this studio', e);
  }
}
