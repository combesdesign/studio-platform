/**
 * Kiosk permission actions ('kiosk.<action>'). Mirrored in supabase/migrations/1500_kiosk_pin.sql.
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** Open kiosk mode, check clients in, exit with the PIN. Not instructors: it sits on the front desk. */
  'kiosk.use': ['owner', 'manager', 'front_desk'],
  /** Set or remove the exit PIN (Settings › Kiosk). */
  'kiosk.manage': ['owner', 'manager'],
});
