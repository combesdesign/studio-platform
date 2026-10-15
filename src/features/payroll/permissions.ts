/**
 * Payroll permission actions ('payroll.<action>'), checked with can(role, 'payroll.<action>') in the stores and the UI.
 * Example:
 *   registerPermissions({ 'payroll.view': ['owner', 'manager', 'front_desk'], 'payroll.manage': ['owner', 'manager'] });
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({});
