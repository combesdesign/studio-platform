/** The .ics calendar file a client can download for a class (a data: URL, no network). Pure. */
import type { ClassType, Location, SessionWithCounts, Staff, StudioSettings } from '../shared/types';

const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function icsDataUrl(s: SessionWithCounts, ct: ClassType | undefined, instructor: Staff | undefined, settings: StudioSettings, place?: Location): string {
  const name = ct?.name ?? 'Pilates class';
  const desc = [instructor ? `With ${(instructor.name || '').trim().split(/\s+/)[0]}` : '', ct?.bookingNote ?? '', settings.cancellationPolicyText ?? '']
    .filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsEsc(settings.name)}//Client app//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${s.id}@${(settings.email.split('@')[1] || 'studio.app').toLowerCase()}`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(s.startsAt)}`,
    `DTEND:${icsTime(s.endsAt)}`,
    `SUMMARY:${icsEsc(`${name} · ${settings.name}`)}`,
    `LOCATION:${icsEsc(place ? [place.name, place.address || settings.address].filter(Boolean).join(', ') : settings.address)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(name)} in 1 hour`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.join('\r\n'));
}

