/**
 * Spot (mat / reformer) selection. Pure, shared by the demo engine, the apps and the tests; the database does the same in
 * supabase/migrations/2300_spots.sql (app.session_layout, app.pick_spot, the booking trigger).
 *
 * A room may have a SpotLayout: a grid of cells, row by row. Each cell is a 'spot' (bookable, its label is its id, e.g. "7" or "R3"),
 * the 'instructor' (shown, never bookable) or 'unavailable' (a broken reformer, a pillar). A class uses it only when its class type
 * has "Let clients pick a spot" on AND it is in a room with a layout. Everything else is exactly as before.
 *
 * Capacity is never touched here: it is still the class capacity (and held-back partner spots) that decide who is booked or
 * waitlisted. A layout with more spots than capacity just leaves some empty; one with fewer leaves the extra people without a spot.
 */
import type { ClassSession, ClassType, Location, Room, SpotCell, SpotKind, SpotLayout } from '../shared/types';

export const MAX_SPOT_ROWS = 10;
export const MAX_SPOT_COLS = 12;
export const MAX_SPOT_LABEL = 8;

/** A fresh grid, every cell a spot numbered 1..n row by row. */
export function makeLayout(rows: number, cols: number): SpotLayout {
  const r = clampInt(rows, 1, MAX_SPOT_ROWS), c = clampInt(cols, 1, MAX_SPOT_COLS);
  return renumber({ rows: r, cols: c, cells: Array.from({ length: r * c }, () => ({ label: '', kind: 'spot' as SpotKind })) });
}

/** Resize, keeping cells where they were (by row and column); new cells are spots. Then renumber. */
export function resizeLayout(layout: SpotLayout, rows: number, cols: number): SpotLayout {
  const r = clampInt(rows, 1, MAX_SPOT_ROWS), c = clampInt(cols, 1, MAX_SPOT_COLS);
  const cells: SpotCell[] = [];
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    const old = i < layout.rows && j < layout.cols ? layout.cells[i * layout.cols + j] : undefined;
    cells.push(old ? { ...old } : { label: '', kind: 'spot' });
  }
  return renumber({ rows: r, cols: c, cells });
}

/** Number every spot cell 1..n in reading order. Cells that aren't spots get an empty label. */
export function renumber(layout: SpotLayout): SpotLayout {
  let n = 0;
  return { ...layout, cells: layout.cells.map((x) => (x.kind === 'spot' ? { label: String(++n), kind: x.kind } : { label: x.kind === 'instructor' ? 'Instructor' : '', kind: x.kind })) };
}

/** Change one cell's kind. A spot made from a non-spot gets the next free number; a layout keeps the labels it has. */
export function setCellKind(layout: SpotLayout, index: number, kind: SpotKind): SpotLayout {
  const cells = layout.cells.map((x) => ({ ...x }));
  const cell = cells[index];
  if (!cell || cell.kind === kind) return layout;
  cell.kind = kind;
  cell.label = kind === 'instructor' ? 'Instructor' : '';
  if (kind === 'spot') cell.label = nextFreeLabel(cells.filter((_, i) => i !== index));
  return { ...layout, cells };
}

function nextFreeLabel(cells: readonly SpotCell[]): string {
  const used = new Set(cells.filter((x) => x.kind === 'spot').map((x) => x.label.toLowerCase()));
  for (let n = 1; n < 1000; n++) if (!used.has(String(n))) return String(n);
  return '999';
}

/** null = fine, else a plain message. */
export function validateLayout(layout: unknown): string | null {
  const l = layout as Partial<SpotLayout> | null | undefined;
  if (!l || typeof l !== 'object') return 'That spot layout isn’t valid.';
  if (!Number.isInteger(l.rows) || !Number.isInteger(l.cols) || (l.rows as number) < 1 || (l.cols as number) < 1
    || (l.rows as number) > MAX_SPOT_ROWS || (l.cols as number) > MAX_SPOT_COLS) return `A layout can be up to ${MAX_SPOT_ROWS} rows by ${MAX_SPOT_COLS} columns.`;
  if (!Array.isArray(l.cells) || l.cells.length !== (l.rows as number) * (l.cols as number)) return 'That spot layout isn’t valid.';
  const seen = new Set<string>();
  for (const c of l.cells) {
    if (!c || (c.kind !== 'spot' && c.kind !== 'instructor' && c.kind !== 'unavailable') || typeof c.label !== 'string') return 'That spot layout isn’t valid.';
    if (c.kind !== 'spot') continue;
    const label = c.label.trim();
    if (!label) return 'Every spot needs a number or name.';
    if (label.length > MAX_SPOT_LABEL) return `Spot names can be up to ${MAX_SPOT_LABEL} characters.`;
    if (seen.has(label.toLowerCase())) return `Two spots are called “${label}”. Each spot needs its own name.`;
    seen.add(label.toLowerCase());
  }
  if (seen.size === 0) return 'A layout needs at least one spot clients can book.';
  return null;
}

/** Tidy a layout for saving: trim labels. */
export function cleanLayout(layout: SpotLayout): SpotLayout {
  return { rows: layout.rows, cols: layout.cols, cells: layout.cells.map((x) => ({ label: x.label.trim(), kind: x.kind })) };
}

/** Bookable spot ids, in reading order. */
export function bookableSpots(layout: SpotLayout): string[] {
  return layout.cells.filter((x) => x.kind === 'spot').map((x) => x.label);
}

export function cellIndexOf(layout: SpotLayout, spot: string): number {
  return layout.cells.findIndex((x) => x.kind === 'spot' && x.label === spot);
}

export function isBookableSpot(layout: SpotLayout, spot: string): boolean {
  return cellIndexOf(layout, spot) >= 0;
}

/**
 * The spot "Pick for me" gives: the first free one in reading order, or the free one closest to `near` (a parent's spot, so a
 * family sits together). Undefined when nothing is free.
 */
export function pickSpot(layout: SpotLayout, taken: Iterable<string>, near: readonly string[] = []): string | undefined {
  const used = new Set(taken);
  const free = layout.cells.map((x, i) => ({ x, i })).filter(({ x }) => x.kind === 'spot' && !used.has(x.label));
  if (!free.length) return undefined;
  const anchors = near.map((s) => cellIndexOf(layout, s)).filter((i) => i >= 0);
  if (!anchors.length) return free[0]!.x.label;
  const dist = (i: number) => Math.min(...anchors.map((a) => Math.abs(Math.floor(a / layout.cols) - Math.floor(i / layout.cols)) * 2 + Math.abs((a % layout.cols) - (i % layout.cols))));
  return free.reduce((best, f) => (dist(f.i) < dist(best.i) ? f : best)).x.label;
}

/** The room a session uses for its layout: its own room, else the studio's only room at the default location. */
export function roomForSession(session: Pick<ClassSession, 'roomId'>, rooms: readonly Room[], locations: readonly Location[]): Room | undefined {
  if (session.roomId) return rooms.find((r) => r.id === session.roomId);
  const def = locations.find((l) => l.isDefault);
  if (!def) return undefined;
  const here = rooms.filter((r) => r.locationId === def.id && r.active);
  return here.length === 1 ? here[0] : undefined;
}

/** The layout this session uses, or undefined when spots are off for it (class type off, no room, or the room has no layout). */
export function sessionLayout(session: Pick<ClassSession, 'roomId'>, classType: Pick<ClassType, 'spotPicking'> | undefined, rooms: readonly Room[], locations: readonly Location[]): SpotLayout | undefined {
  if (!classType?.spotPicking) return undefined;
  return roomForSession(session, rooms, locations)?.spotLayout ?? undefined;
}

/** True when the layout has fewer bookable spots than the class has places (the extra people simply won't get a spot). */
export function layoutShort(layout: SpotLayout, capacity: number): boolean {
  return bookableSpots(layout).length < capacity;
}

/** Walk-in / roster label for a spot: "Spot 4". */
export function spotLabel(spot: string | undefined | null): string {
  if (!spot) return '';
  return /^\d+$/.test(spot) ? `Spot ${spot}` : spot;
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
}
