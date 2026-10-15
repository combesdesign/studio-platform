/**
 * Commerce permission actions ('commerce.<action>'), checked with can(role, 'commerce.<action>') in the stores and the UI.
 * Example:
 *   registerPermissions({ 'commerce.view': ['owner', 'manager', 'front_desk'], 'commerce.manage': ['owner', 'manager'] });
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({});
