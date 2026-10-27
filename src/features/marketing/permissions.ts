/**
 * Marketing permission actions ('marketing.<action>'), checked with can(role, 'marketing.<action>') in the stores and the UI.
 *   marketing.view    campaigns, segments, automations and their stats (read only)
 *   marketing.manage  create and send campaigns, edit segments and automations, sender settings, run automations
 *   marketing.inbox   the studio inbox: read and reply to client messages. Registered for every role; WHO really gets in is the studio's
 *                     setting Settings › Marketing › Who can use the inbox (see canUseInbox), which the stores and the UI check as well.
 * Instructors get view and manage never, and the inbox only when the studio picks "All staff". Mirror in SQL with app.has_role_in(studio_id, 'owner', 'manager', …).
 */
import { registerPermissions } from '../../domain/permissions';
import type { StaffRole } from '../../shared/types';
import type { InboxAccess } from './types';

registerPermissions({
  'marketing.view': ['owner', 'manager', 'front_desk'],
  'marketing.manage': ['owner', 'manager'],
  'marketing.inbox': ['owner', 'manager', 'front_desk', 'instructor'],
});

/** Who can use the inbox, by the studio's setting. The default, no_instructors, is what the inbox always did. Mirrors app.marketing_inbox_roles in SQL. */
export const INBOX_ACCESS_ROLES: Record<InboxAccess, readonly StaffRole[]> = {
  owner: ['owner'],
  owner_manager: ['owner', 'manager'],
  no_instructors: ['owner', 'manager', 'front_desk'],
  all_staff: ['owner', 'manager', 'front_desk', 'instructor'],
};
export const DEFAULT_INBOX_ACCESS: InboxAccess = 'no_instructors';
export const canUseInbox = (role: StaffRole, access: InboxAccess | undefined): boolean => INBOX_ACCESS_ROLES[access ?? DEFAULT_INBOX_ACCESS].includes(role);
