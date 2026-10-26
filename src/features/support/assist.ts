/**
 * The help assistant's answer when there's no AI (demo mode, or the support-assist edge function isn't switched on or fails):
 * the first steps of the best-matching help article plus a link, shaped like the AI's answer so the Help sheet treats both the same.
 */
import { searchArticles } from './articles';
import { SUPPORT_NAME } from './config';
import type { SupportAssist } from './types';

export function articleAnswer(question: string): SupportAssist {
  const a = searchArticles(question, 1)[0];
  if (!a) return { answer: `I couldn't find a guide for that one. Send it to ${SUPPORT_NAME} and he'll sort it out.`, suggestHuman: true };
  const steps = a.steps.slice(0, 3).map((s, i) => `${i + 1}. ${s}`).join('\n');
  return {
    answer: `${a.summary}\n${steps}`,
    suggestHuman: false,
    link: { label: `Read "${a.title}"`, href: `#/help/${a.slug}` },
  };
}

/** What gets added to a request when someone sends it on after reading an answer, so the reply can see what was suggested. */
export function withAssistContext(body: string, answer: SupportAssist | null): string {
  if (!answer) return body;
  const note = `\n\n---\nThe help assistant suggested:\n${answer.answer}`.slice(0, 1300);
  return body.length + note.length <= 4000 ? body + note : body;
}
