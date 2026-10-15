/**
 * Sample studio #2 for the demo: Harbour Reformer Co., a reformer studio in Double Bay, Sydney.
 * Deliberately different from Snowy (deep harbour green + sand, Gloock + Work Sans, a sun-over-water mark)
 * to prove the white-label branding end to end. Photos are generated art (scripts/studio-art.mjs).
 */
import type { Studio, StudioBranding } from '../../shared/types';

export const HARBOUR_ID = 'studio_harbour';

const MARK_D = 'M24 54A26 26 0 0 1 76 54Z M10 64Q20 56 30 64Q40 72 50 64Q60 56 70 64Q80 72 90 64L90 72Q80 80 70 72Q60 64 50 72Q40 80 30 72Q20 64 10 72Z M20 80Q30 72 40 80Q50 88 60 80Q70 72 80 80L80 87Q70 79 60 87Q50 95 40 87Q30 79 20 87Z';
const MARK_VB = '8 26 84 70';

const LOGO_SVG =
  `<svg class="lf" style="--n:0" x="0" y="22" width="132" height="110" viewBox="${MARK_VB}"><path d="${MARK_D}" fill="var(--logo-mark)"/></svg>`
  + '<text class="lt" style="--n:1" x="150" y="98" font-family="var(--display)" font-size="88" fill="var(--logo-letters)">Harbour</text>'
  + '<text class="lt" style="--n:2" x="154" y="146" font-family="var(--body)" font-size="25" letter-spacing="9.5" fill="var(--logo-letters)">REFORMER CO.</text>';

export const HARBOUR_BRANDING: StudioBranding = {
  appName: 'Harbour Reformer Co.',
  shortName: 'Harbour',
  colors: {
    primary: '#1F4A3D', primaryDeep: '#173A30', ink: '#14261F', accent: '#C9A877', soft: '#EAE6DB', softDeep: '#DFD9CA',
    highlight: '#E4D3B2', highlightSoft: '#F1E8D6', bg: '#F6F3EC', muted: '#55645C', faint: '#8B958F',
  },
  fonts: { display: 'Gloock', body: 'Work Sans' },
  logo: { svg: LOGO_SVG, viewBox: '0 0 560 160', aspect: 560 / 160 },
  mark: { d: MARK_D, viewBox: MARK_VB },
  photos: {
    hero: 'studios/harbour/hero.webp', offer: 'studios/harbour/offer.webp', class: 'studios/harbour/foundations.webp',
    classes: { 'Reformer Flow': 'studios/harbour/flow.webp', 'Jumpboard Burn': 'studios/harbour/jumpboard.webp' },
  },
  marquee: ['Slow is strong', 'Springs + breath', 'Eight reformers, no crowds', 'Bayside since 2019', 'Leave taller'],
  welcome: {
    headline: 'Reformer by the *bay*',
    copy: 'Small classes on eight reformers, a minute from the water. Book, manage your pack and check your spot from your phone.',
    quote: { text: 'Small classes, brilliant coaching and the best post-class view in Sydney. I’m hooked.', by: 'Tom W., Google review' },
  },
  launchLine: 'Slow is strong',
  tagline: 'Small-group reformer Pilates in Double Bay.',
  footerLine: 'Reformer Pilates · Double Bay NSW',
  staffHeadline: 'The front desk, *on the water.*',
};

export const HARBOUR_STUDIO: Studio = {
  id: HARBOUR_ID,
  slug: 'harbour',
  name: 'Harbour Reformer Co.',
  timezone: 'Australia/Sydney',
  currency: 'AUD',
  locale: 'en-AU',
  email: 'hello@harbourreformer.example',
  phone: '02 9000 1234',
  address: '12 Bay Street, Double Bay NSW 2028',
  website: 'https://harbourreformer.example',
  taxId: '98 765 432 109',
  taxIdLabel: 'ABN',
  taxName: 'GST',
  taxRate: 0.1,
  taxRegistered: true,
  status: 'live',
  branding: HARBOUR_BRANDING,
  createdAt: '2026-10-08T00:00:00.000Z',
};
