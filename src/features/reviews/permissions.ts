/**
 * Reviews permission actions ('reviews.<action>'). Mirrored in supabase/migrations/1600_reviews.sql.
 * Clients rate their own classes (no staff permission needed).
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  /** The Reviews page. Owner and manager see every review; an instructor sees only their own classes'. */
  'reviews.view': ['owner', 'manager', 'instructor'],
  /** See all reviews (not just your own). */
  'reviews.all': ['owner', 'manager'],
  /** Settings › Reviews (the Google review link). */
  'reviews.manage': ['owner', 'manager'],
});
