/** Notice board rules shared by the demo and live stores and the screens. Pure. */
import type { ISODate } from '../../shared/types';
import type { Notice, NoticeInput } from './types';

export const MAX_TITLE = 80;
export const MAX_BODY = 300;

/** Still showing on `today` (a studio date): no end date, or the end date is today or later. */
export const isActive = (n: Pick<Notice, 'showUntil'>, today: ISODate): boolean => !n.showUntil || n.showUntil >= today;

/** Pinned first, then newest first. */
export const sortNotices = (list: Notice[]): Notice[] =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

/** Clean the form: trimmed text, blanks dropped. Returns the problem in plain words instead when it can't be saved. */
export function cleanNotice(input: NoticeInput, today: ISODate): { ok: true; value: Required<Pick<NoticeInput, 'title' | 'body' | 'pinned'>> & Pick<NoticeInput, 'linkUrl' | 'showUntil'> } | { ok: false; problem: string } {
  const title = (input.title ?? '').trim();
  const body = (input.body ?? '').trim();
  const linkUrl = (input.linkUrl ?? '').trim();
  const showUntil = (input.showUntil ?? '').trim();
  if (!title) return { ok: false, problem: 'Give the notice a title.' };
  if (title.length > MAX_TITLE) return { ok: false, problem: `Keep the title to ${MAX_TITLE} characters or fewer.` };
  if (body.length > MAX_BODY) return { ok: false, problem: `Keep the text to ${MAX_BODY} characters or fewer.` };
  if (linkUrl && (!/^https?:\/\//i.test(linkUrl) || linkUrl.length > 500)) return { ok: false, problem: 'That doesn’t look like a web address. Start it with https://' };
  if (showUntil) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(showUntil) || Number.isNaN(Date.parse(showUntil))) return { ok: false, problem: 'Pick a valid “show until” date.' };
    if (showUntil < today) return { ok: false, problem: 'The “show until” date can’t be in the past.' };
  }
  return { ok: true, value: { title, body, pinned: !!input.pinned, ...(linkUrl ? { linkUrl } : {}), ...(showUntil ? { showUntil } : {}) } };
}
