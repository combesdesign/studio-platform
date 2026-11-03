// App icon and splash artwork for one studio's store app, from its branding (mark + colours).
//   node scripts/app-icons.mjs --studio=snowy         (npm run icons:app -- --studio=snowy)
// Writes resources/<slug>/ using the file names @capacitor/assets expects:
//   icon-only.png 1024 (opaque, iOS + store listing), icon-foreground.png 1024 (transparent, Android adaptive),
//   icon-background.png 1024 (solid), splash.png + splash-dark.png 2732 (centred mark).
// Then, on the Mac, after `npx cap add ios && npx cap add android`:
//   npx capacitor-assets generate --assetPath resources/<slug>
import { build } from 'esbuild';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const slug = (process.argv.find((a) => a.startsWith('--studio='))?.slice(9) || process.env.STUDIO_SLUG || '').toLowerCase();
if (!slug) { console.error('Which studio? npm run icons:app -- --studio=snowy'); process.exit(1); }

const r = await build({ entryPoints: ['src/data/studios/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', outdir: 'x', absWorkingDir: root, logLevel: 'silent' });
const { BUILTIN_STUDIOS } = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
const studio = BUILTIN_STUDIOS.find((s) => s.slug === slug);
if (!studio) { console.error(`No built-in studio "${slug}". Known: ${BUILTIN_STUDIOS.map((s) => s.slug).join(', ')}`); process.exit(1); }
const b = studio.branding;
const { primary, ink, bg } = b.colors;

/** The studio mark as SVG content centred in a size x size canvas, `frac` of the canvas wide/tall at most. */
function markSvg(size, frac, fill) {
  if (b.mark?.d) {
    const [vx, vy, vw, vh] = (b.mark.viewBox || '0 0 100 100').split(/\s+/).map(Number);
    const k = (size * frac) / Math.max(vw, vh);
    const tx = (size - vw * k) / 2 - vx * k, ty = (size - vh * k) / 2 - vy * k;
    return `<g transform="translate(${tx} ${ty}) scale(${k})"><path fill="${fill}" d="${b.mark.d}"/></g>`;
  }
  const words = studio.name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const initials = (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  return `<text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Georgia, serif" font-size="${size * frac * 0.8}" fill="${fill}">${initials}</text>`;
}
const svg = (size, inner, background) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''}${inner}</svg>`);

const dir = path.join(root, 'resources', slug);
mkdirSync(dir, { recursive: true });
const png = (name, buf, flatten) => sharp(buf).png().toFile(path.join(dir, name)).then(() => console.log('  ' + path.join('resources', slug, name)));
await png('icon-only.png', await sharp(svg(1024, markSvg(1024, 0.56, bg), primary)).flatten({ background: primary }).png().toBuffer());
await png('icon-foreground.png', svg(1024, markSvg(1024, 0.42, bg))); // Android crops to the middle ~66%
await png('icon-background.png', await sharp(svg(1024, '', primary)).flatten({ background: primary }).png().toBuffer());
await png('splash.png', await sharp(svg(2732, markSvg(2732, 0.2, primary), bg)).flatten({ background: bg }).png().toBuffer());
await png('splash-dark.png', await sharp(svg(2732, markSvg(2732, 0.2, bg), ink)).flatten({ background: ink }).png().toBuffer());
console.log(`Icons and splash for ${studio.name} ready. Next: npx capacitor-assets generate --assetPath resources/${slug}`);
