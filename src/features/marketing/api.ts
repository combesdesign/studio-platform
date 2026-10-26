/** Small helpers the marketing screens (client and studio) share. No React in here. */
import { store } from '../../data';
import { LOCALE, dateFormat } from '../../shared/format';
import type { Studio } from '../../shared/types';
import type { EmailBrand } from './render';
import type { CampaignStatus, MarketingStore } from './types';

/** The marketing store, or undefined when this studio's build doesn't have it. */
export const marketing = (): MarketingStore | undefined => store.features.marketing;

/** For loaders: the store, or a friendly error the screen's error block can show. */
export function needMarketing(): MarketingStore {
  const m = marketing();
  if (!m) throw new Error('Marketing isn’t available just yet.');
  return m;
}

/** '14 Oct' in studio time. */
export const dm = (iso: string): string => dateFormat({ day: 'numeric', month: 'short' }).format(new Date(iso));
/** '14 Oct, 3:05pm' */
export function dmTime(iso: string): string {
  return `${dm(iso)}, ${dateFormat({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\s?([ap]m)/i, (_m, x: string) => x.toLowerCase())}`;
}
/** 'Tue 14 Oct, 3:05pm' */
export const dayTime = (iso: string): string => `${dateFormat({ weekday: 'short' }).format(new Date(iso))} ${dmTime(iso)}`;

/** '3m', '2h', 'Tue', '14 Oct': the short stamp on an inbox row. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 6 * 86_400) return dateFormat({ weekday: 'short' }).format(new Date(iso));
  return dm(iso);
}

export const pct = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : '–');

export const STATUS_LABEL: Record<CampaignStatus, string> = { draft: 'Draft', scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent', failed: 'Failed' };
export const STATUS_TONE: Record<CampaignStatus, string> = { draft: '', scheduled: 'warn', sending: 'warn', sent: 'ok', failed: 'danger' };

/** The studio's colours and fonts as the email renderer wants them (preview only: real sends read the studios row on the server). */
export function brandOf(studio: Studio): EmailBrand {
  const b = studio.branding;
  const logo = b.logo?.imageUrl && /^https?:\/\//i.test(b.logo.imageUrl) ? b.logo.imageUrl : undefined;
  return {
    name: studio.name, primary: b.colors.primary, ink: b.colors.ink, accent: b.colors.accent, soft: b.colors.soft, highlight: b.colors.highlight, bg: b.colors.bg,
    displayFont: b.fonts.display, bodyFont: b.fonts.body, ...(logo ? { logoUrl: logo } : {}),
  };
}

/** The app's address, for {{app_url}} in a preview. */
export function appUrl(): string {
  if (typeof location === 'undefined') return '';
  return `${location.origin}${location.pathname.replace(/studio\/?$/, '')}`;
}

/** datetime-local value (studio wall clock isn't needed: the browser's own clock is what the person sees) for 'tomorrow 9am'. */
export function defaultSchedule(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(9, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

export const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;
void LOCALE;
