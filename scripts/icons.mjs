// Generate app icons from the flower mark. node scripts/icons.mjs
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
const flower = readFileSync('public/brand/flower.svg', 'utf8');
const white = readFileSync('public/brand/flower-white.svg', 'utf8');
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const vb = flower.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
function icon(bg, svg, pad) {
  const [x, y, w, h] = vb, S = Math.max(w, h) / (1 - 2 * pad);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x - (S - w) / 2} ${y - (S - h) / 2} ${S} ${S}"><rect x="${x - (S - w) / 2}" y="${y - (S - h) / 2}" width="${S}" height="${S}" fill="${bg}"/>${inner(svg)}</svg>`);
}
mkdirSync('public/icons', { recursive: true });
for (const s of [192, 512]) {
  await sharp(icon('#FAF8F3', flower, .2)).resize(s, s).png().toFile(`public/icons/icon-${s}.png`);
  await sharp(icon('#5069AC', white, .22)).resize(s, s).png().toFile(`public/icons/studio-${s}.png`);
}
await sharp(icon('#FAF8F3', flower, .3)).resize(512, 512).png().toFile('public/icons/icon-512-maskable.png');
await sharp(icon('#FAF8F3', flower, .2)).resize(180, 180).png().toFile('public/apple-touch-icon.png');
console.log('icons ok');
