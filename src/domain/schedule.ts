/** Weekly templates → dated class sessions. Pure and DST-safe (uses studio-local wall-clock times). */
import type { ClassSession, ClassType, ID, ISODate, ScheduleTemplate } from '../shared/types';
import { addDays, studioToUTC, weekday } from '../shared/format';
import { MINUTE_MS } from './rules';

/** Deterministic id for the session a template produces on a date. Makes generation idempotent. */
export function templateSessionId(templateId: ID, date: ISODate): ID {
  return `se_${templateId}_${date.replace(/-/g, '')}`;
}

export function datesBetween(from: ISODate, to: ISODate, max = 400): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Build the session a template would produce on `date` (no existence checks). */
export function sessionFromTemplate(t: ScheduleTemplate, ct: ClassType, date: ISODate): ClassSession {
  const startsAt = studioToUTC(date, t.startTime);
  return {
    id: templateSessionId(t.id, date),
    classTypeId: t.classTypeId,
    templateId: t.id,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + ct.durationMin * MINUTE_MS).toISOString(),
    instructorId: t.instructorId,
    capacity: t.capacity ?? ct.defaultCapacity,
    status: 'scheduled',
  };
}

/**
 * Sessions that should exist for active templates between from..to (inclusive studio dates)
 * and don't yet (by id). Templates whose class type is missing or inactive are skipped.
 */
export function generateSessions(args: {
  templates: readonly ScheduleTemplate[];
  classTypes: readonly ClassType[];
  from: ISODate;
  to: ISODate;
  existingIds: ReadonlySet<ID>;
}): ClassSession[] {
  const out: ClassSession[] = [];
  const types = new Map(args.classTypes.map((c) => [c.id, c]));
  const active = args.templates.filter((t) => t.active);
  if (!active.length || args.from > args.to) return out;
  for (const date of datesBetween(args.from, args.to)) {
    const wd = weekday(date);
    for (const t of active) {
      if (t.weekday !== wd || date < t.startsOn || (t.endsOn && date > t.endsOn)) continue;
      const ct = types.get(t.classTypeId);
      if (!ct || !ct.active) continue;
      const id = templateSessionId(t.id, date);
      if (args.existingIds.has(id)) continue;
      out.push(sessionFromTemplate(t, ct, date));
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
