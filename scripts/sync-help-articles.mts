// Regenerates supabase/functions/_shared/help-articles.ts from the help centre (edge functions can't import from src/).
//   node --import tsx scripts/sync-help-articles.mts
import { writeFileSync } from 'node:fs';
import { ARTICLES } from '../src/features/support/articles';

const items = ARTICLES.map(({ slug, title, summary, steps, tip }) => ({ slug, title, summary, steps, ...(tip ? { tip } : {}) }));
writeFileSync(new URL('../supabase/functions/_shared/help-articles.ts', import.meta.url),
`// A copy of the help centre guides (src/features/support/articles.ts) for the support-assist edge function, because
// edge functions can't import from src/. tests/support.test.ts fails if it drifts.
// Regenerate: node --import tsx scripts/sync-help-articles.mts
export const HELP_ARTICLES: { slug: string; title: string; summary: string; steps: string[]; tip?: string }[] = ${JSON.stringify(items, null, 2)};
`);
