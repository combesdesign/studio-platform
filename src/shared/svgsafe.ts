/**
 * A studio's logo can be inline SVG (branding.logo.svg) that the apps render as markup. The database refuses unsafe SVG on the way
 * in (app.svg_is_safe, migration 2900); this is the same rule on the way out, so a logo saved any other way (older rows, a restored
 * backup, the demo) can never run script in a client's or the platform admin's browser. Keep the two in step.
 */
const TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'lineargradient',
  'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc']);
const BAD_ATTRS = new Set(['href', 'xlink:href', 'src', 'srcdoc', 'action', 'formaction']);

export function isSafeSvg(svg: string | null | undefined): boolean {
  if (svg === null || svg === undefined || svg === '') return true;
  if (typeof svg !== 'string' || svg.length > 200000) return false;
  if (/<!|<\?/.test(svg)) return false;
  for (const m of svg.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:_-]*)/g)) if (!TAGS.has(m[1]!.toLowerCase())) return false;
  for (const m of svg.matchAll(/[\s"'/]([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=/g)) {
    const a = m[1]!.toLowerCase();
    if (a.startsWith('on') || BAD_ATTRS.has(a)) return false;
  }
  if (/javascript:|vbscript:|data:|expression\s*\(|@import|url\s*\(\s*['"]?\s*(https?:|\/\/|data:)/i.test(svg)) return false;
  return true;
}
