/** Small presentational pieces shared by the commerce studio screens. */
import React from 'react';
import { cx } from '../../../studio/ui';

export function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'mist' | 'hero' }) {
  return (
    <div className={cx('cm-kpi', tone)}>
      <span className="cm-kpi-l">{label}</span>
      <strong className="cm-kpi-v serif">{value}</strong>
      {sub && <span className="cm-kpi-s">{sub}</span>}
    </div>
  );
}

export const Tone = ({ tone, children }: { tone: string; children: React.ReactNode }) => <span className={cx('cm-tone', tone)}>{children}</span>;
