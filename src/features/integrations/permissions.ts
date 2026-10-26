/**
 * Integrations permission actions ('integrations.<action>'). Mirrored in supabase/migrations/1700-1701_integrations_*.sql.
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** See partner bookings on the roster and the spots held for partners. */
  'integrations.view': ['owner', 'manager', 'front_desk', 'instructor'],
  /** Partner on/off and IDs, spots held per class type. */
  'integrations.manage': ['owner', 'manager'],
  /** Enter or remove a partner API key (write-only). */
  'integrations.keys': ['owner'],
  /** Xero account codes and the sales export. */
  'integrations.accounting': ['owner', 'manager'],
});
