/**
 * Pure rendering for marketing messages: merge tags, the email block layout (heading, text, image, button,
 * divider) in the studio's brand, plain-text versions, and SMS length counting.
 *
 * SELF-CONTAINED ON PURPOSE (no imports): supabase/functions/marketing-send/render.ts is a byte-for-byte copy so
 * the edge function (Deno) sends exactly what the studio app previews. tests/marketing-render.test.ts fails if the
 * two files differ. Edit this one, then `cp src/features/marketing/render.ts supabase/functions/marketing-send/render.ts`.
 */

export interface RenderBlock {
  id?: string;
  type: 'heading' | 'text' | 'image' | 'button' | 'divider';
  text?: string;
  src?: string;
  alt?: string;
  label?: string;
  url?: string;
}

/** Colours and fonts as resolved hex values + font names (email clients can't use CSS variables). */
export interface EmailBrand {
  name: string;
  primary: string;
  ink: string;
  accent: string;
  soft: string;
  highlight: string;
  bg: string;
  displayFont: string;
  bodyFont: string;
  /** Absolute URL of a logo image. Without one the studio name is set in the display font. */
  logoUrl?: string;
}

export interface RenderOptions {
  subject: string;
  preheader?: string;
  blocks: RenderBlock[];
  brand: EmailBrand;
  /** Merge tag values: { first_name: 'Hannah', studio_name: '…' }. */
  vars?: Record<string, string>;
  /** Studio address + extra line for the footer. */
  address?: string;
  footerNote?: string;
  /** Adds an "Unsubscribe" link (and a reason line). Omit for service messages / the editor preview where it is shown as a stub. */
  unsubscribeUrl?: string;
  /** Marketing messages say why the person is receiving them. */
  reason?: string;
  /** Absolute origin for relative image / link paths, e.g. 'https://app.example/'. */
  baseUrl?: string;
  /** Rewrite a link for click tracking: (absolute url, link index) -> tracked url. */
  trackLink?: (url: string, index: number) => string;
  /** Tracking pixel url (opens). */
  openPixelUrl?: string;
  /** Add a Google Fonts <link> (the in-app preview only; real email clients ignore it). */
  previewFonts?: boolean;
}

// ------------------------------------------------------------------ text helpers

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Replace {{first_name}} style tags. Unknown tags become empty so a typo never leaks "{{…}}" into an inbox. */
export function mergeTags(text: string, vars: Record<string, string> = {}): string {
  return String(text ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, k: string) => vars[k.toLowerCase()] ?? '');
}

/** The merge tags the editors offer. */
export const MERGE_TAGS: { tag: string; label: string }[] = [
  { tag: 'first_name', label: 'First name' },
  { tag: 'last_name', label: 'Last name' },
  { tag: 'studio_name', label: 'Studio name' },
  { tag: 'app_url', label: 'App link' },
];

/** Studio-picked absolute URL, or null for anything that isn't http(s) / mailto / tel (blocks javascript: links). */
export function safeUrl(url: string | undefined, baseUrl?: string): string | null {
  const u = (url ?? '').trim();
  if (!u) return null;
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // javascript:, data:, etc.
  if (!baseUrl) return null;
  try { return new URL(u.replace(/^\/+/, ''), baseUrl).toString(); } catch { return null; }
}

function paragraphs(text: string, style: string): string {
  return String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="${style}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** "Find your *flow*" -> accent-coloured italic word. Everything else is escaped. */
function accented(text: string, accent: string): string {
  return esc(text).replace(/\*([^*]+)\*/g, `<em style="color:${accent};font-style:italic">$1</em>`);
}

const stack = (font: string, fallback: string) => `'${font.replace(/'/g, '')}', ${fallback}`;
const SERIF = 'Georgia, \'Times New Roman\', serif';
const SANS = '-apple-system, \'Segoe UI\', Helvetica, Arial, sans-serif';

function fontsLink(brand: EmailBrand): string {
  const fam = [...new Set([brand.displayFont, brand.bodyFont])].filter(Boolean).map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}`);
  return fam.length ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fam.join('&')}&display=swap">` : '';
}

// ------------------------------------------------------------------ email

export function renderEmail(o: RenderOptions): { html: string; text: string } {
  const b = o.brand;
  const vars = o.vars ?? {};
  const m = (s: string | undefined) => mergeTags(s ?? '', vars);
  const display = stack(b.displayFont, SERIF), body = stack(b.bodyFont, SANS);
  let linkN = 0;
  const link = (url: string | undefined): string | null => {
    const abs = safeUrl(m(url), o.baseUrl);
    if (!abs) return null;
    const i = linkN++;
    return o.trackLink && /^https?:/i.test(abs) ? o.trackLink(abs, i) : abs;
  };
  const textLines: string[] = [];

  const rows = o.blocks.map((blk): string => {
    switch (blk.type) {
      case 'heading': {
        const t = m(blk.text);
        textLines.push(t.replace(/\*/g, ''), '');
        return `<tr><td style="padding:8px 32px 4px;font-family:${display};font-size:32px;line-height:1.1;letter-spacing:-0.01em;color:${b.ink}">${accented(t, b.accent)}</td></tr>`;
      }
      case 'text': {
        const t = m(blk.text);
        textLines.push(t, '');
        return `<tr><td style="padding:8px 32px;font-family:${body};font-size:16px;line-height:1.6;color:${b.ink}">${paragraphs(t, 'margin:0 0 14px')}</td></tr>`;
      }
      case 'image': {
        const src = safeUrl(m(blk.src), o.baseUrl);
        if (!src) return '';
        const img = `<img src="${esc(src)}" alt="${esc(m(blk.alt))}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:16px;border:0">`;
        const href = blk.url ? link(blk.url) : null;
        return `<tr><td style="padding:8px 32px">${href ? `<a href="${esc(href)}" style="text-decoration:none">${img}</a>` : img}</td></tr>`;
      }
      case 'button': {
        const href = link(blk.url);
        const label = m(blk.label) || 'Open';
        if (!href) return '';
        textLines.push(`${label}: ${href}`, '');
        return `<tr><td style="padding:14px 32px 18px"><a href="${esc(href)}" style="display:inline-block;background:${b.primary};color:#ffffff;text-decoration:none;font-family:${body};font-size:16px;line-height:1;padding:16px 30px;border-radius:999px">${esc(label)}</a></td></tr>`;
      }
      case 'divider':
        textLines.push('----', '');
        return `<tr><td style="padding:14px 32px"><div style="height:1px;line-height:1px;background:${b.soft}">&nbsp;</div></td></tr>`;
      default:
        return '';
    }
  }).join('\n');

  const unsub = o.unsubscribeUrl ? `<a href="${esc(o.unsubscribeUrl)}" style="color:${b.primary}">Unsubscribe</a>` : '';
  const brandHead = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.name)}" height="34" style="display:block;height:34px;width:auto;border:0">`
    : `<span style="font-family:${display};font-size:26px;letter-spacing:-0.01em;color:${b.primary}">${esc(b.name)}</span>`;
  const pre = o.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(m(o.preheader))}</div>` : '';
  const pixel = o.openPixelUrl ? `<img src="${esc(o.openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : '';
  const footerBits = [o.reason ? esc(o.reason) : '', o.footerNote ? esc(m(o.footerNote)) : '', o.address ? esc(o.address) : '', unsub].filter(Boolean);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m(o.subject))}</title>${o.previewFonts ? fontsLink(b) : ''}</head>
<body style="margin:0;padding:0;background:${b.bg}">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${b.bg}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="padding:28px 32px 10px;background:${b.soft}">${brandHead}</td></tr>
<tr><td style="height:12px;line-height:12px;font-size:0">&nbsp;</td></tr>
${rows}
<tr><td style="padding:22px 32px 30px;font-family:${body};font-size:12.5px;line-height:1.6;color:${b.ink};opacity:.7">${footerBits.join('<br>')}</td></tr>
</table></td></tr></table>${pixel}</body></html>`;

  const footerText = [o.reason ?? '', o.footerNote ? m(o.footerNote) : '', o.address ?? '', o.unsubscribeUrl ? `Unsubscribe: ${o.unsubscribeUrl}` : ''].filter(Boolean);
  const text = [b.name.toUpperCase(), '', ...textLines, '--', ...footerText].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { html, text };
}

// ------------------------------------------------------------------ SMS

export const SMS_OPT_OUT = 'Reply STOP to opt out';

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€\f';

export interface SmsInfo {
  encoding: 'GSM-7' | 'UCS-2';
  /** Characters as the carrier counts them (GSM extension characters count twice). */
  length: number;
  segments: number;
  /** Characters per segment at this length. */
  perSegment: number;
  /** Characters left in the current segment. */
  remaining: number;
}

export function smsInfo(text: string): SmsInfo {
  let gsm = true, len = 0;
  for (const ch of String(text ?? '')) {
    if (GSM_BASIC.includes(ch)) len += 1;
    else if (GSM_EXT.includes(ch)) len += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    const segments = len <= 160 ? (len === 0 ? 0 : 1) : Math.ceil(len / 153);
    const per = len <= 160 ? 160 : 153;
    return { encoding: 'GSM-7', length: len, segments, perSegment: per, remaining: Math.max(0, per * Math.max(1, segments) - len) };
  }
  const units = [...String(text)].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  const per = units <= 70 ? 70 : 67;
  return { encoding: 'UCS-2', length: units, segments, perSegment: per, remaining: Math.max(0, per * segments - units) };
}

/** The text that actually goes out: merged body + the opt-out line (marketing texts always carry it). */
export function buildSms(body: string, vars: Record<string, string> = {}, opts: { marketing?: boolean; optOut?: string } = {}): string {
  const merged = mergeTags(body, vars).trim();
  const marketing = opts.marketing ?? true;
  return marketing ? `${merged}\n${opts.optOut ?? SMS_OPT_OUT}` : merged;
}

// ------------------------------------------------------------------ automations

/** An automation's copy as email blocks: heading, paragraphs, a button to the app. */
export function automationBlocks(a: { heading: string; body: string; buttonLabel: string }): RenderBlock[] {
  const out: RenderBlock[] = [];
  if (a.heading.trim()) out.push({ type: 'heading', text: a.heading });
  if (a.body.trim()) out.push({ type: 'text', text: a.body });
  if (a.buttonLabel.trim()) out.push({ type: 'button', label: a.buttonLabel, url: '{{app_url}}' });
  return out;
}
