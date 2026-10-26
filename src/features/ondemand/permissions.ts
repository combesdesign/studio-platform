/** Online classes permission actions ('ondemand.<action>'). Mirrored in supabase/migrations/1900_ondemand.sql. Clients watch with no staff permission. */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** The Online classes page and Settings › Online classes. */
  'ondemand.manage': ['owner', 'manager'],
});
