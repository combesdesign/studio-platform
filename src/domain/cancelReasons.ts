/** Why a membership is being cancelled: a short list plus "Other" with typed text. The store takes one plain string. */
export const CANCEL_REASONS: readonly string[] = [
  'Too expensive',
  'Not using it enough',
  'Schedule or classes don’t suit',
  'Moving away',
  'Injury or health',
  'Taking a break',
  'Other',
];

export const CANCEL_REASON_MAX = 300;

/** The text to save for a picked option (and typed detail for "Other"), or null while it isn't complete yet. */
export function cancelReasonText(pick: string, other: string): string | null {
  if (!CANCEL_REASONS.includes(pick)) return null;
  if (pick !== 'Other') return pick;
  const t = other.trim().replace(/\s+/g, ' ');
  return t ? `Other: ${t}`.slice(0, CANCEL_REASON_MAX) : null;
}

/** Server-side check shared by the demo store: a trimmed, non-empty reason of at most 300 characters. */
export function cancelReasonProblem(reason: string | undefined): string | null {
  const t = (reason ?? '').trim();
  if (!t) return 'Please tell us why you’re cancelling.';
  if (t.length > CANCEL_REASON_MAX) return `Please keep the reason to ${CANCEL_REASON_MAX} characters or fewer.`;
  return null;
}
