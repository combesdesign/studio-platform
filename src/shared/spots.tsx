/**
 * The spot grid: one calm drawing of a room's layout, used by the client picker, the studio's layout editor and the roster map.
 * Presentational only (rules live in src/domain/spots.ts). Styles are in theme.css (.spot-*), colours come from the studio's theme.
 */
import React from 'react';
import type { SpotLayout } from './types';

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

export interface SpotGridProps {
  layout: SpotLayout;
  /** Spots someone holds: greyed and not tappable. */
  taken?: Iterable<string>;
  /** The viewer's own current spot. */
  mine?: string | undefined;
  /** A spot chosen but not saved yet. */
  selected?: string | undefined;
  /** Roster map: spot -> the first name shown under its number. */
  names?: Readonly<Record<string, string>>;
  /** Makes free spots buttons. */
  onPick?: ((spot: string) => void) | undefined;
  /** Editor: every cell is a button; gets the cell's index. */
  onCell?: ((index: number) => void) | undefined;
  /** Editor: the cell being edited. */
  activeIndex?: number | undefined;
  /** Smaller cells for a read-only overview. */
  compact?: boolean;
  label?: string;
}

function InstructorMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.2" /><path d="M5.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6" />
    </svg>
  );
}

export function SpotGrid({ layout, taken, mine, selected, names, onPick, onCell, activeIndex, compact, label }: SpotGridProps) {
  const takenSet = new Set(taken ?? []);
  return (
    <div className={cx('spot-wrap', compact && 'compact')}>
      <div className="spot-grid" role={onPick || onCell ? 'group' : 'img'} aria-label={label ?? 'Room layout'}
        style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, minWidth: layout.cols * (compact ? 52 : 48) }}>
        {layout.cells.map((c, i) => {
          if (onCell) {
            return (
              <button key={i} type="button" className={cx('spot-cell', 'edit', c.kind, activeIndex === i && 'active')} onClick={() => onCell(i)}
                aria-label={c.kind === 'spot' ? `Spot ${c.label}` : c.kind === 'instructor' ? 'Instructor' : 'Unavailable'}>
                {c.kind === 'spot' ? <span className="spot-n">{c.label}</span> : c.kind === 'instructor' ? <InstructorMark /> : <span className="spot-x" aria-hidden="true" />}
              </button>
            );
          }
          if (c.kind === 'instructor') return <div key={i} className="spot-cell instructor" aria-label="Instructor"><InstructorMark /></div>;
          if (c.kind === 'unavailable') return <div key={i} className="spot-cell unavailable" aria-hidden="true"><span className="spot-x" /></div>;
          const isMine = mine === c.label, isSel = selected === c.label, isTaken = takenSet.has(c.label) && !isMine;
          const who = names?.[c.label];
          const state = isSel ? 'selected' : isMine ? 'mine' : isTaken ? 'taken' : 'free';
          const inner = <><span className="spot-n">{c.label}</span>{who && <span className="spot-who">{who}</span>}</>;
          const aria = `Spot ${c.label}${isMine ? ', yours' : isTaken ? `, taken${who ? ` by ${who}` : ''}` : isSel ? ', chosen' : ', free'}`;
          if (onPick && !isTaken) return <button key={i} type="button" className={cx('spot-cell', state)} onClick={() => onPick(c.label)} aria-pressed={isSel || isMine} aria-label={aria}>{inner}</button>;
          return <div key={i} className={cx('spot-cell', state)} aria-label={aria} {...(onPick ? { 'aria-disabled': true } : {})}>{inner}</div>;
        })}
      </div>
    </div>
  );
}

/** "Free", "Yours", "Taken" key under a picker. */
export function SpotKey({ showSelected }: { showSelected?: boolean }) {
  return (
    <div className="spot-key" aria-hidden="true">
      <span><i className="free" />Free</span>
      {showSelected && <span><i className="selected" />Your pick</span>}
      <span><i className="taken" />Taken</span>
    </div>
  );
}
