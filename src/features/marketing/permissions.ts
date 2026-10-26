/**
 * Marketing permission actions ('marketing.<action>'), checked with can(role, 'marketing.<action>') in the stores and the UI.
 *   marketing.view    campaigns, segments, automations and their stats (read only)
 *   marketing.manage  create and send campaigns, edit segments and automations, sender settings, run automations
 *   marketing.inbox   the studio inbox: read and reply to client messages
 * Instructors don't get any of these. Mirror in SQL with app.has_role_in(studio_id, 'owner', 'manager', …).
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  'marketing.view': ['owner', 'manager', 'front_desk'],
  'marketing.manage': ['owner', 'manager'],
  'marketing.inbox': ['owner', 'manager', 'front_desk'],
});
