// Generates the demo's sample-studio photos (abstract art, no stock photos needed):
//   public/studios/harbour/*.webp  (Harbour Reformer Co.: deep harbour green + sand)
//   public/studios/default/*.webp  (neutral placeholders for a brand-new studio)
// Run: node scripts/studio-art.mjs   (needs sharp; the outputs are committed)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch { sharp = createRequire('/opt/npm-tools/node_modules/')('sharp'); }
const root = path.dirname(new URL(import.meta.url).pathname) + '/..';

const waves = (w, h, y0, gap, n, color, op, amp = 18) => Array.from({ length: n }, (_, i) => {
  const y = y0 + i * gap;
  let d = `M -20 ${y}`;
  for (let x = -20; x <= w + 40; x += 80) d += ` Q ${x + 20} ${y - amp} ${x + 40} ${y} T ${x + 80} ${y}`;
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${2 + (i % 3)}" opacity="${op * (1 - i / (n + 2))}"/>`;
}).join('');

/** A calm reformer drawn in lines: frame, carriage, footbar, straps. */
const reformer = (x, y, s, c, op = 0.85) => `<g transform="translate(${x} ${y}) scale(${s})" stroke="${c}" fill="none" stroke-linecap="round" opacity="${op}">
  <rect x="0" y="40" width="620" height="26" rx="13" stroke-width="5"/>
  <rect x="300" y="18" width="190" height="22" rx="8" stroke-width="5"/>
  <path d="M40 66 L40 110 M580 66 L580 110" stroke-width="5"/>
  <path d="M30 40 C 20 -10, 70 -40, 96 -8 L 96 40" stroke-width="6"/>
  <path d="M600 40 L 600 -60 M 560 -60 L 640 -60" stroke-width="5"/>
  <path d="M600 -60 Q 470 -30 420 18" stroke-width="2.5" stroke-dasharray="6 7"/>
</g>`;

function harbour(w, h, variant) {
  const sun = variant === 'flow' ? [w * 0.28, h * 0.42, h * 0.2] : variant === 'jump' ? [w * 0.7, h * 0.3, h * 0.15] : [w * 0.72, h * 0.4, h * 0.22];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2C5E4E"/><stop offset=".62" stop-color="#1F4A3D"/><stop offset="1" stop-color="#14261F"/></linearGradient>
    <radialGradient id="glow" cx="${sun[0] / w}" cy="${sun[1] / h}" r=".55"><stop offset="0" stop-color="#E4D3B2" stop-opacity=".45"/><stop offset="1" stop-color="#E4D3B2" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <circle cx="${sun[0]}" cy="${sun[1]}" r="${sun[2]}" fill="#C9A877" opacity=".9"/>
  <rect x="0" y="${h * 0.58}" width="${w}" height="${h * 0.42}" fill="#173A30" opacity=".8"/>
  ${waves(w, h, h * 0.6, h * 0.045, 9, '#E4D3B2', 0.55)}
  ${variant === 'offer' ? '' : reformer(w * (variant === 'flow' ? 0.36 : 0.08), h * (variant === 'jump' ? 0.66 : 0.7), (w / 1600) * (variant === 'hero' ? 1.15 : 1.25), '#F1E8D6', 0.8)}
  ${variant === 'jump' ? `<g stroke="#C9A877" stroke-width="5" fill="none" opacity=".8"><rect x="${w * 0.78}" y="${h * 0.42}" width="${w * 0.05}" height="${h * 0.3}" rx="10"/></g>` : ''}
</svg>`;
}

function neutral(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A6274"/><stop offset="1" stop-color="#1F2A33"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w * 0.75}" cy="${h * 0.38}" r="${Math.min(w, h) * 0.22}" fill="#EDE3D1" opacity=".22"/>
  <circle cx="${w * 0.25}" cy="${h * 0.7}" r="${Math.min(w, h) * 0.3}" fill="#93A9B8" opacity=".18"/>
  ${waves(w, h, h * 0.66, h * 0.05, 6, '#EDF1F3', 0.35, 12)}
</svg>`;
}

async function out(file, svg) {
  const p = path.join(root, 'public', file);
  mkdirSync(path.dirname(p), { recursive: true });
  await sharp(Buffer.from(svg)).webp({ quality: 82 }).toFile(p);
  console.log('wrote', file);
}

await out('studios/harbour/hero.webp', harbour(1600, 1000, 'hero'));
await out('studios/harbour/offer.webp', harbour(900, 900, 'offer'));
await out('studios/harbour/foundations.webp', harbour(1200, 800, 'foundations'));
await out('studios/harbour/flow.webp', harbour(1200, 800, 'flow'));
await out('studios/harbour/jumpboard.webp', harbour(1200, 800, 'jump'));
await out('studios/default/hero.webp', neutral(1600, 1000));
await out('studios/default/square.webp', neutral(900, 900));
