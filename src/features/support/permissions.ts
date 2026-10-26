/** Support permission actions ('support.<action>'). Mirrored in supabase/migrations/2000_support.sql. Platform admins are handled separately (platform_admins). */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** The Help button: every staff role can ask for help and read their own thread. */
  'support.use': ['owner', 'manager', 'front_desk', 'instructor'],
  /** See every request from the studio (not just your own). */
  'support.all': ['owner', 'manager'],
});
