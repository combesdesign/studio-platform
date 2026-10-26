/** Locations and rooms: clash checks and location filters. Pure, shared by the demo engine, the apps and the tests (the database does the same in 0013). */
import type { ClassSession, ClassType, ID, ISODateTime, Location, Room, ScheduleTemplate } from '../shared/types';

/** Something that holds a room for a while: a class, an appointment or an event session. */
export interface RoomUse {
  id: ID;
  kind: 'class' | 'appointment' | 'event';
  roomId?: ID | undefined;
  startsAt: ISODateTime;
  endsAt: ISODateTime;
  /** Shown in the warning: 'Reformer Flow'. */
  label?: string;
}

/** Half-open: a class that ends at 9:00 doesn't clash with one that starts at 9:00. */
export function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/** The first use of the same room that overlaps. No room, no clash. */
export function findRoomClash(want: { roomId?: ID | undefined; startsAt: string; endsAt: string; ignoreId?: ID | undefined }, uses: readonly RoomUse[]): RoomUse | undefined {
  if (!want.roomId) return undefined;
  return uses.find((u) => u.roomId === want.roomId && u.id !== want.ignoreId && timesOverlap(want.startsAt, want.endsAt, u.startsAt, u.endsAt));
}

/** Scheduled (not cancelled) classes as room uses. */
export function classUses(sessions: readonly ClassSession[], classTypes: readonly ClassType[]): RoomUse[] {
  const name = new Map(classTypes.map((c) => [c.id, c.name]));
  return sessions.filter((s) => s.status !== 'cancelled' && s.roomId).map((s) => ({ id: s.id, kind: 'class' as const, roomId: s.roomId, startsAt: s.startsAt, endsAt: s.endsAt, label: name.get(s.classTypeId) ?? 'Class' }));
}

/** 'Reformer Flow at 6:15am'-style text for the warning. Time comes from the caller so this stays timezone-free. */
export function clashMessage(roomName: string, use: RoomUse, at: string): string {
  return `${roomName} is already booked at ${at}${use.label ? ` for ${use.label}` : ''}. Pick another room or time.`;
}

/** Weekly slots in the same room, on the same day, that run at the same time while both are active. */
export function templateClashes(t: Pick<ScheduleTemplate, 'roomId' | 'weekday' | 'startTime' | 'classTypeId' | 'startsOn' | 'endsOn' | 'active'> & { id?: ID | undefined }, templates: readonly ScheduleTemplate[], classTypes: readonly ClassType[]): ScheduleTemplate[] {
  if (!t.roomId || t.active === false) return [];
  const dur = (id: ID) => classTypes.find((c) => c.id === id)?.durationMin ?? 50;
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const a0 = mins(t.startTime), a1 = a0 + dur(t.classTypeId);
  return templates.filter((o) => {
    if (o.id === t.id || !o.active || o.roomId !== t.roomId || o.weekday !== t.weekday) return false;
    const b0 = mins(o.startTime), b1 = b0 + dur(o.classTypeId);
    if (!(a0 < b1 && b0 < a1)) return false;
    const aEnd = t.endsOn ?? '9999-12-31', bEnd = o.endsOn ?? '9999-12-31';
    return t.startsOn <= bEnd && o.startsOn <= aEnd;
  });
}

// ---------------------------------------------------------------- locations

/** The location that things without one belong to: the flagged default, else the first active, else the first. */
export function defaultLocation(locations: readonly Location[]): Location | undefined {
  return locations.find((l) => l.isDefault) ?? locations.find((l) => l.active) ?? locations[0];
}

/** Where a class, template or event really is: its own location, else the default. */
export function effectiveLocationId(item: { locationId?: ID | undefined }, locations: readonly Location[]): ID | undefined {
  return item.locationId ?? defaultLocation(locations)?.id;
}

/** Keep what happens at `locationId`. No location chosen = everything. */
export function filterByLocation<T extends { locationId?: ID | undefined }>(items: readonly T[], locationId: ID | undefined | null, locations: readonly Location[]): T[] {
  if (!locationId) return [...items];
  return items.filter((i) => effectiveLocationId(i, locations) === locationId);
}

/** Show the location UI only when there is something to choose: more than one active location. */
export function hasManyLocations(locations: readonly Location[]): boolean {
  return locations.filter((l) => l.active).length > 1;
}

/** Rooms of one location, active only, in name order. */
export function roomsAt(rooms: readonly Room[], locationId: ID | undefined): Room[] {
  return rooms.filter((r) => r.active && (!locationId || r.locationId === locationId)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The room picker shows when the studio has more than one room to choose between. */
export function hasManyRooms(rooms: readonly Room[]): boolean {
  return rooms.filter((r) => r.active).length > 1;
}

/** The location a room is in (rooms are the more exact answer when a class has both). */
export function locationOfRoom(rooms: readonly Room[], roomId: ID | undefined): ID | undefined {
  return roomId ? rooms.find((r) => r.id === roomId)?.locationId : undefined;
}

/** Map links for an address: Apple Maps on iPhone, iPad and Mac, Google Maps elsewhere. */
export function directionsUrl(address: string, platform: 'apple' | 'google'): string {
  const q = encodeURIComponent(address);
  return platform === 'apple' ? `https://maps.apple.com/?daddr=${q}` : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
export function directionsPlatform(ua: string): 'apple' | 'google' {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua) ? 'apple' : 'google';
}
