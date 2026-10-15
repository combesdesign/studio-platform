/**
 * Appointments permission actions ('appointments.<action>'), checked with can(role, 'appointments.<action>') in the stores and the UI.
 * Example:
 *   registerPermissions({ 'appointments.view': ['owner', 'manager', 'front_desk'], 'appointments.manage': ['owner', 'manager'] });
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({});
