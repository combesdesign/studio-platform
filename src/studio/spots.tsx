/**
 * Spot (mat / reformer) selection in the studio app: the layout editor (Settings > Locations & rooms, or Class types for a studio with one
 * room), the roster's small map and "Move spot" step, and the optional spot when staff book someone in. Rules: src/domain/spots.ts.
 */
import React, { useState } from 'react';
import { Sheet, store, useAction, useData } from '../shared/react';
import { SpotGrid, SpotKey } from '../shared/spots';
import {
  MAX_SPOT_COLS, MAX_SPOT_LABEL, MAX_SPOT_ROWS, bookableSpots, cleanLayout, makeLayout, renumber, resizeLayout, setCellKind, spotLabel, validateLayout,
} from '../domain/spots';
import type { ID, Room, SessionSpots, SpotKind, SpotLayout } from '../shared/types';
import { Icon, Loading, SheetHead, cx } from './ui';
import { useLocations } from './locations';

const allNumbered = (l: SpotLayout) => l.cells.every((c) => c.kind !== 'spot' || /^\d+$/.test(c.label));
/** Numbered layouts stay numbered 1..n in reading order as cells change; a layout with names of its own is left alone. */
const keepNumbered = (before: SpotLayout, after: SpotLayout) => (allNumbered(before) ? renumber(after) : after);

// ------------------------------------------------------------------ the editor
type Tool = SpotKind | 'name';
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'spot', label: 'Spot' }, { id: 'instructor', label: 'Instructor' }, { id: 'unavailable', label: 'Not available' }, { id: 'name', label: 'Rename' },
];

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="sl-step" role="group" aria-label={label}>
      <span className="sl-step-l">{label}</span>
      <button type="button" className="btn icon soft" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`}><Icon name="minus" size={18} /></button>
      <strong aria-live="polite">{value}</strong>
      <button type="button" className="btn icon soft" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}><Icon name="plus" size={18} /></button>
    </div>
  );
}

/** A simple grid editor: pick what a tap does (spot, instructor, not available, rename), then tap cells. */
export function SpotLayoutEditor({ value, onChange }: { value: SpotLayout; onChange: (l: SpotLayout) => void }) {
  const [tool, setTool] = useState<Tool>('spot');
  const [active, setActive] = useState<number | undefined>();
  const problem = validateLayout(value);
  const n = bookableSpots(value).length;
  const tap = (i: number) => {
    if (tool === 'name') { setActive(value.cells[i]?.kind === 'spot' ? i : undefined); return; }
    setActive(undefined);
    onChange(keepNumbered(value, setCellKind(value, i, tool)));
  };
  const rename = (label: string) => {
    if (active === undefined) return;
    onChange({ ...value, cells: value.cells.map((c, i) => (i === active ? { ...c, label: label.slice(0, MAX_SPOT_LABEL) } : c)) });
  };
  const cell = active !== undefined ? value.cells[active] : undefined;
  return (
    <div className="sl-editor">
      <div className="sl-steps">
        <Stepper label="Rows" value={value.rows} min={1} max={MAX_SPOT_ROWS} onChange={(r) => onChange(keepNumbered(value, resizeLayout(value, r, value.cols)))} />
        <Stepper label="Columns" value={value.cols} min={1} max={MAX_SPOT_COLS} onChange={(c) => onChange(keepNumbered(value, resizeLayout(value, value.rows, c)))} />
      </div>
      <div className="sl-tools" role="radiogroup" aria-label="What a tap does">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} className={cx('sl-tool', tool === t.id && 'on')} onClick={() => { setTool(t.id); setActive(undefined); }}>{t.label}</button>
        ))}
      </div>
      <SpotGrid layout={value} onCell={tap} activeIndex={active} label="Spot layout editor" />
      {tool === 'name' && (
        <div className="sl-rename">
          {cell ? (
            <label className="field"><span>Name for this spot</span>
              <input className="input" value={cell.label} maxLength={MAX_SPOT_LABEL} onChange={(e) => rename(e.target.value)} autoFocus /></label>
          ) : <p className="muted small">Tap a spot to give it your own name, like R1 or Front left.</p>}
        </div>
      )}
      <div className="sl-foot">
        <span className={cx('small', problem ? 'sl-bad' : 'muted')} role={problem ? 'alert' : undefined}>{problem ?? `${n} ${n === 1 ? 'spot' : 'spots'} clients can pick. Tap a cell to change it.`}</span>
        <button type="button" className="btn sm ghost" onClick={() => onChange(renumber(value))}>Renumber</button>
      </div>
    </div>
  );
}

/** For a room's sheet: nothing yet, or the editor. `onChange(null)` removes the layout. */
export function SpotLayoutField({ layout, onChange }: { layout: SpotLayout | null; onChange: (l: SpotLayout | null) => void }) {
  return (
    <div className="field span2 sl-field">
      <span>Spot layout</span>
      {layout ? (
        <>
          <SpotLayoutEditor value={layout} onChange={onChange} />
          <button type="button" className="btn sm ghost sl-remove" onClick={() => onChange(null)}>Remove the layout</button>
        </>
      ) : (
        <div className="sl-empty">
          <p className="muted">Draw this room so clients can pick their reformer or mat. Switch it on for a class type with “Let clients pick a spot”.</p>
          <button type="button" className="btn soft" onClick={() => onChange(makeLayout(2, 6))}><Icon name="plus" size={18} />Set up a spot layout</button>
        </div>
      )}
    </div>
  );
}

/** Room list line: "8 spots · 2 × 6" or nothing. */
export function layoutSummary(r: Pick<Room, 'spotLayout'>): string {
  const l = r.spotLayout;
  return l ? `${bookableSpots(l).length} spots laid out (${l.rows} × ${l.cols})` : '';
}

/** Save a room's layout on its own (the single-room studio's "Spot layout" card, under Class types). */
export function SingleRoomLayoutCard() {
  const { rooms, manyRooms, ready, reload } = useLocations();
  const [open, setOpen] = useState(false);
  const room = rooms.find((r) => r.active) ?? rooms[0];
  if (!ready || manyRooms || !room) return null;
  return (
    <section className="card sl-card">
      <div className="sl-card-head">
        <div>
          <h3 className="sl-card-t">Spot layout</h3>
          <p className="muted small">{room.spotLayout ? layoutSummary(room) : 'Optional. Draw your room so clients can pick a mat or reformer. Off for every class until you switch it on below.'}</p>
        </div>
        <button className="btn sm soft" onClick={() => setOpen(true)}><Icon name={room.spotLayout ? 'edit' : 'plus'} size={16} />{room.spotLayout ? 'Edit' : 'Set up'}</button>
      </div>
      {room.spotLayout && <SpotGrid layout={room.spotLayout} compact label={`${room.name} layout`} />}
      {open && <RoomLayoutSheet room={room} onClose={() => { setOpen(false); reload(); }} />}
    </section>
  );
}

function RoomLayoutSheet({ room, onClose }: { room: Room; onClose: () => void }) {
  const [layout, setLayout] = useState<SpotLayout | null>(room.spotLayout ?? null);
  const { busy, run } = useAction();
  const bad = layout ? validateLayout(layout) : null;
  const save = async () => {
    const out = await run(() => store.upsertRoom({ id: room.id, locationId: room.locationId, name: room.name, active: room.active, ...(room.capacity ? { capacity: room.capacity } : {}), spotLayout: layout ? cleanLayout(layout) : null }), 'Spot layout saved');
    if (out) onClose();
  };
  return (
    <Sheet open onClose={onClose} label="Spot layout">
      <SheetHead title={<>Spot <em>layout</em></>} sub="Clients pick from these when they book a class that has spot picking on." onClose={onClose} />
      <SpotLayoutField layout={layout} onChange={setLayout} />
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !!bad}>Save</button></div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ in a class: who sits where
/** Whether a class uses spots, its layout and which are taken; undefined while loading or when the store has no spots. */
export function useSessionSpots(sessionId: ID | undefined, refresh?: unknown): SessionSpots | undefined {
  const res = useData(async () => (sessionId && store.getSessionSpots ? store.getSessionSpots(sessionId) : undefined), [sessionId, refresh]);
  return res.data?.enabled ? res.data : undefined;
}

/** The roster's small map: every seat with the first name of whoever has it. */
export function RosterSpotMap({ layout, names, noSpot }: { layout: SpotLayout; names: Record<string, string>; noSpot: string[] }) {
  const free = bookableSpots(layout).filter((s) => !names[s]).length;
  return (
    <section className="card rs-map" aria-label="Where everyone is">
      <div className="rs-map-head"><h3>Layout</h3><span className="muted small">{free} {free === 1 ? 'spot' : 'spots'} free</span></div>
      <SpotGrid layout={layout} compact taken={Object.keys(names)} names={names} label="Who is in each spot" />
      {noSpot.length > 0 && <p className="muted small rs-map-note"><Icon name="alert" size={16} />No spot yet: {noSpot.join(', ')}. The class has more people than spots.</p>}
    </section>
  );
}

/** "Spot 4" chip for a roster row. */
export function SpotChip({ spot, onClick }: { spot: string | undefined; onClick?: () => void }) {
  if (!spot) return null;
  return <button className="chip flag spot-chip" onClick={onClick} aria-label={`${spotLabel(spot)}, change`}>{spotLabel(spot)}</button>;
}

/** The "Move spot" step in a booking's sheet: tap a free spot, or let the app pick. */
export function MoveSpotView({ bookingId, sessionId, current, names, firstName, onDone, onBack }: {
  bookingId: ID; sessionId: ID; current?: string | undefined; names: Record<string, string>; firstName: string; onDone: (spot: string) => void; onBack: () => void;
}) {
  const spots = useSessionSpots(sessionId);
  const [pick, setPick] = useState<string | undefined>(current);
  const { busy, run } = useAction();
  if (!spots?.layout) return <Loading />;
  const taken = spots.taken.filter((s) => s !== current);
  const go = async (spot: string | null) => {
    const r = await run(() => store.chooseSpot!(bookingId, spot));
    if (r) onDone(r.spot ?? '');
  };
  return (
    <div className="stack">
      <p className="muted">{current ? `${firstName} is in ${spotLabel(current).toLowerCase()}.` : `${firstName} doesn’t have a spot yet.`} Tap a free spot to {current ? 'move them' : 'give them one'}.</p>
      <SpotGrid layout={spots.layout} taken={taken} names={names} mine={current} selected={pick !== current ? pick : undefined} onPick={setPick} label="Choose a spot" />
      <SpotKey showSelected />
      <div className="sh-foot">
        <button className="btn ghost" onClick={onBack}>Back</button>
        <button className="btn soft" onClick={() => go(null)} disabled={busy}>Pick for them</button>
        <button className="btn" onClick={() => pick && go(pick)} disabled={busy || !pick || pick === current}>{current ? 'Move' : 'Give spot'}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ booking someone in: the optional spot
/** "Spot: first free" with a Choose button. `value` undefined = automatic. Renders nothing for a class without spots. */
export function StaffSpotField({ sessionId, value, onChange }: { sessionId: ID; value: string | undefined; onChange: (spot: string | undefined) => void }) {
  const spots = useSessionSpots(sessionId);
  const [open, setOpen] = useState(false);
  if (!spots?.layout) return null;
  return (
    <div className="stack sl-staff">
      <div className="eyebrow">Spot</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={cx('pill', !value && 'on')} onClick={() => { onChange(undefined); setOpen(false); }}>First free</button>
        <button type="button" className={cx('pill', !!value && 'on')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{value ? spotLabel(value) : 'Choose a spot'}</button>
      </div>
      {open && (
        <>
          <SpotGrid layout={spots.layout} taken={spots.taken} selected={value} onPick={(s) => { onChange(s); setOpen(false); }} label="Choose a spot" />
          <SpotKey showSelected />
        </>
      )}
    </div>
  );
}

/** First names by spot for a roster (booked and checked-in people with a spot). */
export function namesBySpot(entries: readonly { status: string; spot?: string | undefined; client: { firstName: string } }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) if (e.spot && (e.status === 'booked' || e.status === 'checked_in')) out[e.spot] = e.client.firstName;
  return out;
}
