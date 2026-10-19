/**
 * Commerce permission actions ('commerce.<action>'), checked with can(role, 'commerce.<action>') in the stores and the UI.
 *   view    see gift cards, promo codes, referral stats
 *   sell    sell and redeem gift cards and use promo codes at the till (instructors can run the till)
 *   manage  void or adjust gift cards, create promo codes, change shop settings
 *   stock   see retail stock, adjust it, get low-stock alerts
 * Mirrored in the SQL (supabase/migrations/1300_commerce_*.sql) with app.has_role_in / public.has_role.
 */
import { registerPermissions } from '../../domain/permissions';

registerPermissions({
  'commerce.view': ['owner', 'manager', 'front_desk'],
  'commerce.sell': ['owner', 'manager', 'front_desk', 'instructor'],
  'commerce.manage': ['owner', 'manager'],
  'commerce.stock': ['owner', 'manager', 'front_desk'],
});
