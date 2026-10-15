/**
 * Marketing permission actions ('marketing.<action>'), checked with can(role, 'marketing.<action>') in the stores and the UI.
 * Example:
 *   registerPermissions({ 'marketing.view': ['owner', 'manager', 'front_desk'], 'marketing.manage': ['owner', 'manager'] });
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({});
