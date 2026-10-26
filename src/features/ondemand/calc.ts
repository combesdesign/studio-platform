/** Online classes: pure helpers shared by the demo store, the live store, the apps and the tests. */
import { computePassStatus, isPassCurrent } from '../../domain/rules';
import type { Pass } from '../../shared/types';
import type { AdminVideo, ClientVideo, VideoInput } from './types';

export const SUGGESTED_CATEGORIES = ['Mums + Bubs', 'Core', 'Stretch', 'Full body'];
export const SUGGESTED_LEVELS = ['All levels', 'Beginner', 'Intermediate', 'Advanced', 'Postnatal'];

// ---------------------------------------------------------------- where a video lives
export type VideoSource =
  | { kind: 'youtube'; id: string }
  | { kind: 'vimeo'; id: string; hash?: string }
  | { kind: 'file'; url: string }
  | { kind: 'invalid' };

const FILE_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;

/** Work out what a pasted link is: a YouTube or Vimeo page, a direct video file, or something we can't play. */
export function parseVideoUrl(raw: string): VideoSource {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { kind: 'invalid' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'invalid' };
  const host = u.hostname.toLowerCase().replace(/^(www|m|player)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = '';
    if (host === 'youtu.be') id = parts[0] ?? '';
    else if (parts[0] === 'watch') id = u.searchParams.get('v') ?? '';
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? '';
    return /^[\w-]{11}$/.test(id) ? { kind: 'youtube', id } : { kind: 'invalid' };
  }
  if (host === 'vimeo.com') {
    const i = parts.findIndex((p) => /^\d{6,}$/.test(p));
    if (i < 0) return { kind: 'invalid' };
    const next = parts[i + 1] ?? '';
    const hash = u.searchParams.get('h') ?? (/^[0-9a-f]{6,20}$/i.test(next) ? next : undefined);
    return { kind: 'vimeo', id: parts[i]!, ...(hash ? { hash } : {}) };
  }
  if (FILE_EXT.test(u.pathname)) return { kind: 'file', url: u.toString() };
  return { kind: 'invalid' };
}

/** The address to put in an iframe (autoplay is for after the client pressed play). null for a direct file. */
export function embedUrl(src: VideoSource): string | null {
  if (src.kind === 'youtube') return `https://www.youtube-nocookie.com/embed/${src.id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  if (src.kind === 'vimeo') return `https://player.vimeo.com/video/${src.id}?${src.hash ? `h=${src.hash}&` : ''}autoplay=1&dnt=1&title=0&byline=0&portrait=0`;
  return null;
}

// ---------------------------------------------------------------- access
/** Does this pass give online access? Active (or a cancelled membership still running to the end of its period), on a flagged product. */
export function passGivesAccess(pass: Pass, flagged: ReadonlySet<string>, now: Date): boolean {
  if (!flagged.has(pass.productId)) return false;
  const st = computePassStatus(pass, now);
  return st === 'active' || (st === 'cancelled' && isPassCurrent(pass, now));
}
export const hasOnlineAccess = (passes: readonly Pass[], flagged: ReadonlySet<string>, now: Date): boolean =>
  passes.some((p) => passGivesAccess(p, flagged, now));

/** The client's view of a video: locked unless it's free or they have access; the address is withheld while locked. */
export function toClientVideo(v: AdminVideo, access: boolean, lastWatchedAt: string | null): ClientVideo {
  const locked = !(v.free || access);
  return {
    id: v.id, title: v.title, description: v.description, instructor: v.instructor, durationMin: v.durationMin, level: v.level,
    category: v.category, thumbnailUrl: v.thumbnailUrl, free: v.free, locked, videoUrl: locked ? null : v.videoUrl, lastWatchedAt,
  };
}

// ---------------------------------------------------------------- checks (the same limits as the SQL)
export const bySortOrder = <T extends { sortOrder: number; id: string }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);

export interface CleanVideo {
  title: string; description: string; instructor: string; durationMin: number; level: string; category: string;
  thumbnailUrl: string; videoUrl: string; published: boolean; free: boolean;
}
const bad = (m: string): never => { throw new Error(`INVALID: ${m}`); };

export function cleanVideo(i: VideoInput): CleanVideo {
  const title = (i.title ?? '').trim();
  const category = (i.category ?? '').trim();
  const description = (i.description ?? '').trim();
  const instructor = (i.instructor ?? '').trim();
  const level = (i.level ?? '').trim() || 'All levels';
  const thumbnailUrl = (i.thumbnailUrl ?? '').trim();
  const videoUrl = (i.videoUrl ?? '').trim();
  const durationMin = Number(i.durationMin);
  if (!title || title.length > 120) bad('Give the video a title (up to 120 characters).');
  if (!category || category.length > 40) bad('Choose a category (up to 40 characters).');
  if (description.length > 1000) bad('The description can be up to 1000 characters.');
  if (instructor.length > 80) bad('The instructor name can be up to 80 characters.');
  if (level.length > 40) bad('The level can be up to 40 characters.');
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 600) bad('Enter the length in whole minutes (1 to 600).');
  if (thumbnailUrl && (thumbnailUrl.length > 500 || /^\s*(javascript|data|vbscript):/i.test(thumbnailUrl))) bad('That thumbnail address doesn\'t look right.');
  if (videoUrl.length > 500 || parseVideoUrl(videoUrl).kind === 'invalid') bad('Paste a Vimeo or YouTube link, or a direct .mp4 link.');
  return { title, description, instructor, durationMin, level, category, thumbnailUrl, videoUrl, published: !!i.published, free: !!i.free };
}

/** '12 min', '1 hr 5 min'. */
export function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Categories in use, in the order the first video of each appears. */
export const categoriesOf = (videos: readonly { category: string }[]): string[] => [...new Set(videos.map((v) => v.category))];
