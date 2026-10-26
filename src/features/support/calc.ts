/** Pure checks and helpers shared by the demo store, the live store and the screens. */
import type { SupportRequest, SupportStatus } from './types';

export const MAX_BODY = 4000;
/** Attached photos are downscaled to a JPEG data URL; anything bigger than this is refused. */
export const MAX_SCREENSHOT_CHARS = 900_000;
export const MAX_BANNER = 200;

export function cleanBody(raw: string): string {
  const body = (raw ?? '').trim();
  if (!body) throw new Error('INVALID: Tell us what\'s going on first.');
  if (body.length > MAX_BODY) throw new Error(`INVALID: That's a bit long. Please keep it under ${MAX_BODY} characters.`);
  return body;
}

export function cleanScreenshot(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(raw)) throw new Error('INVALID: That file isn\'t a photo we can use.');
  if (raw.length > MAX_SCREENSHOT_CHARS) throw new Error('INVALID: That photo is too big. Try a smaller screenshot.');
  return raw;
}

export function cleanBanner(raw: string | null | undefined): string | null {
  const m = (raw ?? '').trim();
  if (!m) return null;
  if (m.length > MAX_BANNER) throw new Error(`INVALID: Keep the status message under ${MAX_BANNER} characters.`);
  return m;
}

/** Urgent first (while not resolved), then newest first. */
export function inboxOrder(list: SupportRequest[]): SupportRequest[] {
  const pinned = (r: SupportRequest) => r.urgent && r.status !== 'resolved';
  return [...list].sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Where a thread goes when someone adds a message. */
export function statusAfter(from: 'studio' | 'platform', explicit?: SupportStatus): SupportStatus {
  return explicit ?? (from === 'studio' ? 'open' : 'waiting');
}

/** Short first line of a request for lists. */
export function snippet(body: string, n = 90): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + '…' : one;
}

/** "Chrome on Mac" style summary of a user agent, for the admin. Falls back to the raw string. */
export function deviceOf(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br && os ? `${br} on ${os}` : br || os || ua.slice(0, 40);
}
