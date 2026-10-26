/**
 * Payroll permission actions ('payroll.<action>'), checked with can(role, 'payroll.<action>') in the stores and the UI.
 *
 * Pay stays owner-only where RULES.md says so: only the owner changes pay rules, adjusts, approves hours, marks a
 * period paid or exports. Managers can read pay (like the instructor pay table in Reports) and run the cover desk.
 * Mirrored in supabase/migrations/1401_payroll_rpcs.sql.
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** See cover requests, ask for cover on your own class, claim one you're eligible for. */
  'payroll.cover': ['owner', 'manager', 'front_desk', 'instructor'],
  /** Approve or decline claims, post or cancel cover for anyone's class, switch auto-approval on. */
  'payroll.cover_approve': ['owner', 'manager'],
  /** Your own timesheet and the clock. */
  'payroll.clock': ['owner', 'manager', 'front_desk', 'instructor'],
  /** See and enter everyone's timesheets (pending until the owner approves). */
  'payroll.timesheets': ['owner', 'manager'],
  /** Approve or reject hours. */
  'payroll.timesheets_approve': ['owner'],
  /** The Payroll screen: pay periods, pay rules (read only for managers). */
  'payroll.view': ['owner', 'manager'],
  /** Edit pay rules. */
  'payroll.rules': ['owner'],
  /** Adjustments, mark paid, reopen, export, pay period settings. */
  'payroll.manage': ['owner'],
});
