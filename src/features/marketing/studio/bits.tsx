/** Small presentational pieces shared by the marketing studio screens. */
import React from 'react';
import { cx } from '../../../studio/ui';

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
