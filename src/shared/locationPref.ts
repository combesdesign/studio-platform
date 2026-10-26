/** The location a person last picked as a filter, remembered per device (and per studio). Never throws: storage can be blocked. */
import type { ID, Location } from './types';

const key = (app: 'client' | 'studio', studioId: string) => `spc.loc.${app}.${studioId}`;

export function readLocationPref(app: 'client' | 'studio', studioId: string): ID | '' {
  try { return localStorage.getItem(key(app, studioId)) ?? ''; } catch { return ''; }
}
export function writeLocationPref(app: 'client' | 'studio', studioId: string, locationId: ID | ''): void {
  try { if (locationId) localStorage.setItem(key(app, studioId), locationId); else localStorage.removeItem(key(app, studioId)); } catch { /* private mode */ }
}
/** A remembered location that was since switched off or removed means "all locations". */
export function validLocationPref(pref: ID | '', locations: readonly Location[]): ID | '' {
  return pref && locations.some((l) => l.id === pref && l.active) ? pref : '';
}
