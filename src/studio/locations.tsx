/** Multi-location and rooms in the studio app: the Settings tab, the location filter, the room picker. Nothing here shows for a one-location studio. */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, store, useAction, useData } from '../shared/react';
import { hasFeature } from '../shared/plans';
import { isSingleStudio } from '../shared/boot';
import { readLocationPref, validLocationPref, writeLocationPref } from '../shared/locationPref';
import { effectiveLocationId, hasManyLocations, hasManyRooms, roomsAt } from '../domain';
import type { ID, Location, Room } from '../shared/types';
import { Icon, Loading, Seg, SheetHead, cx, useStudio } from './ui';

/** The studio's locations and rooms, kept up to date. `many` = more than one active location: only then does any location UI show. */
export function useLocations() {
  const res = useData(async () => ({ locations: await store.listLocations(), rooms: await store.listRooms() }), []);
  const locations = res.data?.locations ?? [];
  const rooms = res.data?.rooms ?? [];
  return { locations, rooms, ready: !!res.data, many: hasManyLocations(locations), manyRooms: hasManyRooms(rooms), reload: res.reload };
}

/**
 * Is the Locations & rooms settings tab shown? The plan has multi_location, or the studio already runs more than one location.
 * A single-studio build (Snowy's own app) has no plans, so there it only shows once a second location exists.
 */
export function useLocationsTabVisible(): boolean {
  const { studio } = useStudio();
  const { locations, ready } = useLocations();
  return (hasFeature(studio, 'multi_location') && !isSingleStudio()) || (ready && locations.filter((l) => l.active).length > 1);
}

/** The filter, remembered on this device. Returns '' for all locations. */
export function useLocationFilter(locations: readonly Location[]): [ID | '', (id: ID | '') => void] {
  const { studio } = useStudio();
  const [pick, setPick] = useState<ID | ''>(() => readLocationPref('studio', studio.id));
  const value = validLocationPref(pick, locations);
  return [value, (id) => { setPick(id); writeLocationPref('studio', studio.id, id); }];
}

/** All locations / each location, as a segmented control (a dropdown past four). Renders nothing for a one-location studio. */
export function LocationFilter({ locations, value, onChange, className }: { locations: readonly Location[]; value: ID | ''; onChange: (id: ID | '') => void; className?: string }) {
  const active = locations.filter((l) => l.active);
  if (active.length < 2) return null;
  if (active.length > 4) {
    return (
      <select className={cx('select loc-select', className)} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Location">
        <option value="">All locations</option>
        {active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    );
  }
  return <Seg className={cx('sm loc-seg', className)} value={value} onChange={onChange} options={[{ value: '', label: 'All locations' }, ...active.map((l) => ({ value: l.id, label: l.name }))]} />;
}

/** Keep what happens at the chosen location (classes without a place belong to the default location). */
export function useAtLocation<T extends { locationId?: ID | undefined }>(items: readonly T[], value: ID | '', locations: readonly Location[]): T[] {
  return useMemo(() => (value ? items.filter((i) => effectiveLocationId(i, locations) === value) : [...items]), [items, value, locations]);
}

/** Room dropdown for class and weekly-class editors: shown when the studio has more than one room, otherwise nothing. */
export function RoomPicker({ roomId, onChange, warning, className }: { roomId?: ID | undefined; onChange: (room: Room | undefined) => void; warning?: string | undefined; className?: string }) {
  const { locations, rooms, manyRooms } = useLocations();
  if (!manyRooms) return null;
  const byLoc = locations.filter((l) => l.active).map((l) => ({ l, rs: roomsAt(rooms, l.id) })).filter((g) => g.rs.length);
  return (
    <label className={cx('field span2 room-field', className)}>
      <span>Room</span>
      <select className="select" value={roomId ?? ''} onChange={(e) => onChange(rooms.find((r) => r.id === e.target.value))} aria-describedby={warning ? 'room-warn' : undefined}>
        <option value="">No particular room</option>
        {byLoc.map(({ l, rs }) => (
          <optgroup key={l.id} label={byLoc.length > 1 ? `${l.name}` : l.name}>
            {rs.map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` · ${r.capacity} spots` : ''}</option>)}
          </optgroup>
        ))}
      </select>
      {warning && <span id="room-warn" className="room-warn" role="alert"><Icon name="alert" size={16} />{warning}</span>}
    </label>
  );
}

/** "Bondi · Studio A" for a class, '' when the studio has one location and one room. */
export function placeLabel(s: { locationId?: ID | undefined; roomId?: ID | undefined }, locations: readonly Location[], rooms: readonly Room[]): string {
  const loc = locations.find((l) => l.id === effectiveLocationId(s, locations));
  const room = rooms.find((r) => r.id === s.roomId);
  return [hasManyLocations(locations) ? loc?.name : '', hasManyRooms(rooms) ? room?.name : ''].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ Settings > Locations & rooms
export function LocationsTab() {
  const { locations, rooms, ready } = useLocations();
  const [editLoc, setEditLoc] = useState<Partial<Location> | null>(null);
  const [editRoom, setEditRoom] = useState<Partial<Room> | null>(null);
  if (!ready) return <Loading />;
  return (
    <div className="loc-tab">
      <div className="tab-head">
        <p className="muted">Where your classes happen. Each location has its own rooms, and a room can only hold one class at a time.</p>
        <button className="btn" onClick={() => setEditLoc({ active: true })}><Icon name="plus" size={20} />Add location</button>
      </div>
      <div className="loc-grid">
        {locations.map((l) => {
          const rs = rooms.filter((r) => r.locationId === l.id);
          return (
            <section key={l.id} className={cx('card loc-card', !l.active && 'off')}>
              <header className="loc-head">
                <div>
                  <h3 className="loc-name">{l.name}</h3>
                  <p className="loc-addr">{l.address || 'No address yet'}</p>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {l.isDefault && <span className="chip cream">Main location</span>}
                  {!l.active && <span className="chip">Switched off</span>}
                  <button className="btn sm soft" onClick={() => setEditLoc(l)} aria-label={`Edit ${l.name}`}><Icon name="edit" size={16} />Edit</button>
                </div>
              </header>
              <ul className="loc-rooms">
                {rs.map((r) => (
                  <li key={r.id}>
                    <button className={cx('loc-room', !r.active && 'off')} onClick={() => setEditRoom(r)} aria-label={`Edit ${r.name}`}>
                      <span className="loc-room-name">{r.name}</span>
                      <span className="loc-room-meta">{r.capacity ? `${r.capacity} spots` : 'No default size'}{!r.active ? ' · switched off' : ''}</span>
                      <Icon name="edit" size={16} />
                    </button>
                  </li>
                ))}
                {rs.length === 0 && <li className="faint small">No rooms yet</li>}
              </ul>
              <button className="btn sm ghost" onClick={() => setEditRoom({ locationId: l.id, active: true })}><Icon name="plus" size={16} />Add room</button>
            </section>
          );
        })}
      </div>
      <LocationSheet l={editLoc} onClose={() => setEditLoc(null)} />
      <RoomSheet r={editRoom} locations={locations} onClose={() => setEditRoom(null)} />
    </div>
  );
}

function LocationSheet({ l, onClose }: { l: Partial<Location> | null; onClose: () => void }) {
  const { studio } = useStudio();
  const [v, setV] = useState<Partial<Location>>({});
  const { busy, run } = useAction();
  useEffect(() => { if (l) setV(l); }, [l]);
  const save = async () => {
    const r = await run(() => store.upsertLocation({
      ...(v.id ? { id: v.id } : {}), name: (v.name ?? '').trim(), address: (v.address ?? '').trim(), active: v.active !== false,
      ...(v.timezone?.trim() ? { timezone: v.timezone.trim() } : {}), ...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {}),
    }), 'Location saved');
    if (r) onClose();
  };
  return (
    <Sheet open={!!l} onClose={onClose} label="Location">
      <SheetHead title={v.id ? <>Edit <em>{l?.name || 'location'}</em></> : <>New <em>location</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Name</span><input className="input" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Bondi" /></label>
        <label className="field span2"><span>Address (clients get directions to this)</span><input className="input" value={v.address ?? ''} onChange={(e) => setV({ ...v, address: e.target.value })} placeholder="e.g. 2/118 Campbell Parade, Bondi Beach NSW 2026" /></label>
        <label className="field span2"><span>Timezone (leave empty for {studio.timezone})</span><input className="input" value={v.timezone ?? ''} onChange={(e) => setV({ ...v, timezone: e.target.value })} placeholder={studio.timezone} /></label>
        {!l?.isDefault && <label className="check span2"><input type="checkbox" checked={v.active !== false} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Active (switch off to hide it from clients and new classes)</span></label>}
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !(v.name ?? '').trim()}>Save</button></div>
    </Sheet>
  );
}

function RoomSheet({ r, locations, onClose }: { r: Partial<Room> | null; locations: readonly Location[]; onClose: () => void }) {
  const [v, setV] = useState<Partial<Room>>({});
  const { busy, run } = useAction();
  useEffect(() => { if (r) setV(r); }, [r]);
  const save = async () => {
    const out = await run(() => store.upsertRoom({
      ...(v.id ? { id: v.id } : {}), locationId: v.locationId ?? locations[0]!.id, name: (v.name ?? '').trim(), active: v.active !== false,
      ...(v.capacity ? { capacity: Number(v.capacity) } : {}),
    }), 'Room saved');
    if (out) onClose();
  };
  return (
    <Sheet open={!!r} onClose={onClose} label="Room">
      <SheetHead title={v.id ? <>Edit <em>{r?.name || 'room'}</em></> : <>New <em>room</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Name</span><input className="input" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Studio A" /></label>
        <label className="field"><span>Location</span>
          <select className="select" value={v.locationId ?? ''} onChange={(e) => setV({ ...v, locationId: e.target.value })} disabled={!!v.id}>
            {locations.filter((x) => x.active || x.id === v.locationId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Spots (prefills new classes)</span><input className="input" type="number" min={1} value={v.capacity ?? ''} onChange={(e) => setV({ ...v, capacity: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label className="check span2"><input type="checkbox" checked={v.active !== false} onChange={(e) => setV({ ...v, active: e.target.checked })} /><span>Active</span></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !(v.name ?? '').trim()}>Save</button></div>
    </Sheet>
  );
}
