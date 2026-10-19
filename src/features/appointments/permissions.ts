/**
 * Appointments permission actions ('appointments.<action>'), checked with can(role, 'appointments.<action>') in the stores and the UI.
 *   view    see the appointments calendar. Instructors only ever see their own appointments (the store filters them).
 *   own     edit your own weekly hours and time off; mark your own sessions done / no-show.
 *   book    book, cancel (waiving the late penalty), refund and see attendee lists for anyone: the front desk's job.
 *   manage  appointment types, packs, workshops / courses / events, settings, and everyone's hours.
 * Mirrored in SQL (supabase/migrations/1101_appointments_rpcs.sql).
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  'appointments.view': ['owner', 'manager', 'front_desk', 'instructor'],
  'appointments.own': ['owner', 'manager', 'front_desk', 'instructor'],
  'appointments.book': ['owner', 'manager', 'front_desk'],
  'appointments.manage': ['owner', 'manager'],
});
