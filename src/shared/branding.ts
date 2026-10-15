/**
 * White-label branding: turns a studio's StudioBranding into the CSS variables every app uses, loads its
 * Google Fonts and keeps the "current branding" that the brand components (src/shared/brand.tsx) draw from.
 *
 *   brandTokens(branding)  -> { '--primary': '#5069AC', '--ink-rgb': '36, 52, 95', ... }   (pure, tested)
 *   applyBranding(branding) -> sets them on <html>, loads fonts, sets theme-color          (browser)
 *
 * Colour roles (the only colour names the apps use):
 *   --primary (+ --primary-600, --primary-rgb)  main brand colour (Snowy navy)
 *   --ink (+ --ink-2, --ink-rgb)                 text and the darkest surfaces
 *   --accent                                     italic accent word, the mark (Snowy sky)
 *   --soft (+ --soft-2, --soft-3, --soft-light, --soft-white)   panels, toggles (Snowy mist)
 *   --highlight (+ --highlight-2, --highlight-light, --highlight-hover)  badges, offers (Snowy cream)
 *   --bg (+ --bg-rgb, --bg-light)                page background
 *   --muted, --faint                             secondary text
 *   --shade-rgb                                  dark photo overlays
 *   --display, --body                            font stacks
 * OWNED BY THE LEAD / PLATFORM.
 */
import type { BrandColors, ClassType, StudioBranding } from './types';

type WithTokens = StudioBranding;

// ------------------------------------------------------------------ colour maths (no dependencies)
type RGB = [number, number, number];
export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n) || h.length < 6) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Mix a towards b by t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}
const rgbList = (hex: string) => hexToRgb(hex).join(', ');
/** Relative luminance (WCAG), 0..1. */
export function luminance(hex: string): number {
  const c = hexToRgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const fontStack = (family: string, kind: 'display' | 'body') => {
  const f = family.trim().replace(/['"]/g, '');
  const fallback = kind === 'display' ? 'Georgia, serif' : "system-ui, -apple-system, 'Segoe UI', sans-serif";
  return f ? `'${f}', ${fallback}` : fallback;
};

/** Every CSS variable a studio's branding produces. Derived shades can be pinned with branding.tokens. */
export function brandTokens(b: Pick<StudioBranding, 'colors' | 'fonts' | 'tokens'>): Record<string, string> {
  const c: BrandColors = b.colors;
  const white = '#FFFFFF', black = '#000000';
  const t: Record<string, string> = {
    '--primary': c.primary,
    '--primary-600': c.primaryDeep ?? mix(c.primary, black, 0.12),
    '--primary-rgb': rgbList(c.primary),
    '--ink': c.ink,
    '--ink-2': mix(c.ink, black, 0.2),
    '--ink-rgb': rgbList(c.ink),
    '--accent': c.accent,
    '--soft': c.soft,
    '--soft-2': c.softDeep ?? mix(c.soft, c.primary, 0.08),
    '--soft-3': mix(c.soft, c.accent, 0.25),
    '--soft-light': mix(c.soft, white, 0.5),
    '--soft-white': mix(c.soft, white, 0.8),
    '--highlight': c.highlight,
    '--highlight-2': c.highlightSoft ?? mix(c.highlight, white, 0.45),
    '--highlight-light': mix(c.highlight, white, 0.6),
    '--highlight-hover': mix(c.highlight, black, 0.05),
    '--bg': c.bg,
    '--bg-rgb': rgbList(c.bg),
    '--bg-light': mix(c.bg, white, 0.5),
    '--muted': c.muted ?? mix(c.ink, c.bg, 0.3),
    '--faint': c.faint ?? mix(c.ink, c.bg, 0.55),
    '--shade-rgb': rgbList(mix(c.ink, black, 0.28)),
    '--display': fontStack(b.fonts.display, 'display'),
    '--body': fontStack(b.fonts.body, 'body'),
  };
  return { ...t, ...(b.tokens ?? {}) };
}

/**
 * Display families with a true italic on Google Fonts. Asking Google for an italic a family doesn't have
 * ('Gloock:ital@0;1') fails the whole stylesheet, so everything else is requested upright only
 * (the browser slants it for the *accent* word).
 */
export const ITALIC_FAMILIES = ['Instrument Serif', 'Fraunces', 'Playfair Display', 'Cormorant Garamond', 'Cormorant', 'DM Serif Display',
  'Lora', 'Libre Baskerville', 'Crimson Pro', 'IBM Plex Serif', 'EB Garamond', 'Newsreader', 'Source Serif 4', 'Spectral', 'Bodoni Moda'];

/** Google Fonts stylesheet URL for the studio's two families (plus the display face's italic when it has one). */
export function fontsUrl(fonts: StudioBranding['fonts']): string {
  const fam = (f: string, ital: boolean) => 'family=' + encodeURIComponent(f.trim()).replace(/%20/g, '+') + (ital ? ':ital@0;1' : '');
  const list = [fam(fonts.display, ITALIC_FAMILIES.some((x) => x.toLowerCase() === fonts.display.trim().toLowerCase()))];
  if (fonts.body.trim() && fonts.body.trim() !== fonts.display.trim()) list.push(fam(fonts.body, false));
  return `https://fonts.googleapis.com/css2?${list.join('&')}&display=swap`;
}

/** Problems worth flagging in the branding editor (contrast of text on surfaces). */
export function brandingWarnings(b: Pick<StudioBranding, 'colors'>): string[] {
  const c = b.colors, out: string[] = [];
  if (contrast(c.ink, c.bg) < 7) out.push('Text colour is a bit light on the background. Darken the ink colour for easier reading.');
  if (contrast('#FFFFFF', c.primary) < 3) out.push('White text on the primary colour is hard to read. Try a deeper primary.');
  return out;
}

// ------------------------------------------------------------------ asset paths
// Branding photos are relative to the client app root ('img/wide.webp'). The studio and admin apps live one
// folder down, so boot sets the base to '../' there.
let assetBase = '';
export function setAssetBase(base: string): void { assetBase = base; }
export function brandAsset(u?: string | null): string | undefined {
  if (!u) return undefined;
  if (/^(https?:|data:|blob:)/.test(u)) return u;
  return assetBase + u.replace(/^(\.\.\/|\.\/|\/)+/, '');
}

// ------------------------------------------------------------------ the current studio's branding
let current: WithTokens | null = null;
const listeners = new Set<() => void>();
export function getBranding(): WithTokens {
  return current ?? PLATFORM_BRANDING;
}
export function onBrandingChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Apply a studio's branding to the page: CSS variables, fonts, theme colour. Safe to call again (live preview). */
export function applyBranding(b: WithTokens, opts: { root?: HTMLElement; title?: string; themeColor?: string } = {}): void {
  current = b;
  if (typeof document !== 'undefined') {
    const root = opts.root ?? document.documentElement;
    for (const [k, v] of Object.entries(brandTokens(b))) root.style.setProperty(k, v);
    if (!opts.root) {
      const href = fontsUrl(b.fonts);
      let link = document.getElementById('brand-fonts') as HTMLLinkElement | null;
      if (!link) { link = document.createElement('link'); link.id = 'brand-fonts'; link.rel = 'stylesheet'; document.head.appendChild(link); }
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
      if (opts.title) document.title = opts.title;
      if (opts.themeColor) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', opts.themeColor);
    }
  }
  listeners.forEach((l) => l());
}

/** Photo for a class: its own image, else the studio's photo for that class name, else the default class photo. */
export function classPhotoFor(b: StudioBranding, ct?: Pick<ClassType, 'name' | 'imageUrl'> | string): string {
  const name = typeof ct === 'string' ? ct : ct?.name;
  const own = typeof ct === 'object' ? ct?.imageUrl : undefined;
  return own || (name && b.photos.classes?.[name]) || b.photos.class || b.photos.hero;
}

/** '*Cooma!*' markup -> parts, so the UI can wrap the accent word in <em>. */
export function accentParts(text: string): { text: string; em: boolean }[] {
  return text.split(/(\*[^*]+\*)/).filter(Boolean).map((p) => (p.startsWith('*') && p.endsWith('*') && p.length > 2 ? { text: p.slice(1, -1), em: true } : { text: p, em: false }));
}

// ------------------------------------------------------------------ defaults
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** A tidy typographic wordmark for studios without a logo yet: the name in the display face, the mark beside it. */
export function textLogo(name: string, opts: { markD?: string; markViewBox?: string } = {}): { svg: string; viewBox: string; aspect: number } {
  const words = name.trim().split(/\s+/);
  const first = words.length > 2 ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : words[0] ?? name;
  const rest = words.length > 2 ? words.slice(Math.ceil(words.length / 2)).join(' ') : words.slice(1).join(' ');
  const w = Math.max(first.length * 46, rest.length * 22, 200) + 150;
  const mark = opts.markD
    ? `<svg class="lf" style="--n:0" x="0" y="34" width="112" height="112" viewBox="${opts.markViewBox ?? '0 0 100 100'}"><path d="${opts.markD}" fill="var(--logo-mark)"/></svg>`
    : '';
  const svg = `${mark}<text class="lt" style="--n:1" x="${mark ? 136 : 0}" y="${rest ? 108 : 124}" font-family="var(--display)" font-size="92" fill="var(--logo-letters)">${esc(first)}</text>`
    + (rest ? `<text class="lt" style="--n:2" x="${mark ? 140 : 4}" y="160" font-family="var(--body)" font-size="28" letter-spacing="8" fill="var(--logo-letters)">${esc(rest.toUpperCase())}</text>` : '');
  return { svg, viewBox: `0 0 ${w} 180`, aspect: w / 180 };
}

/** A soft four-petal mark for studios that haven't uploaded one. */
export const DEFAULT_MARK = {
  d: 'M50 6c8 14 8 26 0 38c-8-12-8-24 0-38zM94 50c-14 8-26 8-38 0c12-8 24-8 38 0zM50 94c-8-14-8-26 0-38c8 12 8 24 0 38zM6 50c14-8 26-8 38 0c-12 8-24 8-38 0z',
  viewBox: '0 0 100 100',
};

/** Calm neutral starting point for a brand-new studio (the onboarding wizard changes it). */
export function defaultBranding(name: string): StudioBranding {
  const logo = textLogo(name, { markD: DEFAULT_MARK.d });
  return {
    appName: name,
    shortName: name.length <= 12 ? name : name.split(/\s+/)[0]!.slice(0, 12),
    colors: { primary: '#3E5466', ink: '#1F2A33', accent: '#93A9B8', soft: '#EDF1F3', highlight: '#EDE3D1', bg: '#F9F8F5' },
    fonts: { display: 'Instrument Serif', body: 'Instrument Sans' },
    logo: { svg: logo.svg, viewBox: logo.viewBox, aspect: logo.aspect },
    mark: { ...DEFAULT_MARK },
    photos: { hero: 'studios/default/hero.webp', offer: 'studios/default/square.webp' },
    marquee: ['Move well', 'Feel strong', 'Every body welcome', 'Breathe deep'],
    welcome: { headline: `Welcome to *${name}*`, copy: 'Book classes, manage your passes and keep your details up to date, all in one place.' },
    launchLine: 'Move well',
    tagline: `${name}. See you in class.`,
  };
}

/** The platform's own neutral look (admin app, "Find your studio", the studio app before a studio is picked). */
export const PLATFORM_NAME = 'Studio Platform';
export const PLATFORM_BRANDING: StudioBranding = {
  appName: PLATFORM_NAME,
  shortName: 'Studios',
  colors: { primary: '#2F3B4C', ink: '#1A212C', accent: '#8FA0B5', soft: '#EEF0F3', highlight: '#E9E2D6', bg: '#F7F7F4', muted: '#5B6573', faint: '#8B939E' },
  fonts: { display: 'Instrument Serif', body: 'Instrument Sans' },
  logo: { ...textLogo(PLATFORM_NAME, { markD: DEFAULT_MARK.d }) },
  mark: { ...DEFAULT_MARK },
  photos: { hero: 'studios/default/hero.webp' },
  marquee: [],
  welcome: { headline: 'Find your *studio*', copy: 'Pick your studio to book classes and manage your passes.' },
};
