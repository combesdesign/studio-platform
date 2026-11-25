/**
 * Notice board permission actions ('notices.<action>'). Mirrored in supabase/migrations/3303_notices.sql.
 * Clients read active notices (no staff permission needed).
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** Post, edit, pin and remove notices (Settings › Notice board). */
  'notices.manage': ['owner', 'manager'],
});
