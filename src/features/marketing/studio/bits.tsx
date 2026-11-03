/** Small presentational pieces shared by the marketing studio screens. */
import React from 'react';
import { cx } from '../../../studio/ui';
import { MERGE_TAGS } from '../render';

export function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'mist' | 'hero' }) {
  return (
    <div className={cx('mk-kpi', tone)}>
      <span className="mk-kpi-l">{label}</span>
      <strong className="mk-kpi-v serif">{value}</strong>
      {sub && <span className="mk-kpi-s">{sub}</span>}
    </div>
  );
}

export const Tone = ({ tone, children }: { tone?: string; children: React.ReactNode }) => <span className={cx('mk-tone', tone)}>{children}</span>;

/** A switch (the studio app has no shared one). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={cx('mk-switch', checked && 'on')} onClick={() => onChange(!checked)}><span /></button>
  );
}

// ------------------------------------------------------------------ merge tags
// Templates store tags as plain text ({{first_name}}); the editors show them as readable chips instead. Storage is untouched.

let lastField: HTMLInputElement | HTMLTextAreaElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if ((t instanceof HTMLInputElement && (t.type === 'text' || t.type === '')) || t instanceof HTMLTextAreaElement) lastField = t;
  });
}

/** Insert text at the cursor of the last text field the person was in, and tell React it changed. */
function insertAtCursor(text: string): boolean {
  const el = lastField;
  if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
  el.focus();
  const at = el.selectionStart ?? el.value.length;
  const prev = el.value.slice(0, at).slice(-1);
  el.setRangeText((prev && !/\s/.test(prev) ? ' ' : '') + text, at, el.selectionEnd ?? at, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** "First name" for {{first_name}}; unknown tags get a tidied version of their name. */
export function tagLabel(tag: string, extra: { tag: string; label: string }[] = []): string {
  const hit = [...MERGE_TAGS, ...extra].find((t) => t.tag === tag.toLowerCase());
  return hit ? hit.label : tag.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Text with its {{tags}} drawn as small chips: "Hi [First name]". Renders nothing when there are no tags. */
export function TagText({ text, extra }: { text: string; extra?: { tag: string; label: string }[] }) {
  if (!/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(text)) return null;
  const parts = text.split(/(\{\{\s*[a-z0-9_]+\s*\}\})/gi);
  return (
    <p className="mk-tagline faint small" aria-label="How the tags read">
      <span className="mk-tagline-l">Reads as</span>
      {parts.map((p, i) => {
        const m = /^\{\{\s*([a-z0-9_]+)\s*\}\}$/i.exec(p);
        return m ? <span key={i} className="mk-tagchip">{tagLabel(m[1]!, extra)}</span> : <span key={i}>{p}</span>;
      })}
    </p>
  );
}

/** A row of tag chips. Tap one to drop it in where the cursor was. */
export function TagBar({ extra, note }: { extra?: { tag: string; label: string }[]; note?: string }) {
  const [hint, setHint] = React.useState('');
  const all = [...MERGE_TAGS, ...(extra ?? [])];
  return (
    <div className="mk-tagbar">
      <span className="faint small">Personal touches. Tap one to add it where you’re typing:</span>
      <div className="mk-tagbar-chips">
        {all.map((t) => (
          <button
            key={t.tag} type="button" className="mk-tagchip btn-chip"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setHint(insertAtCursor(`{{${t.tag}}}`) ? '' : 'Tap into a field first, then pick a tag.')}
          >{t.label}</button>
        ))}
      </div>
      {(hint || note) && <span className="faint small">{hint || note}</span>}
    </div>
  );
}
