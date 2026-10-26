// A studio whose plan payment is overdue past the grace period is read-only for STAFF (docs/PLATFORM.md, "Plans and billing").
// Staff-initiated edge functions (refunds, membership changes, staff invites, marketing sends) call this first. Anything a client
// does (booking, buying, the client billing portal) never does: studios don't punish their own clients.
import type { Db } from './db.ts';
import { must } from './db.ts';
import { HttpError } from './http.ts';

export const READ_ONLY_MESSAGE = 'This studio is read-only until its plan payment is sorted out. Clients can still book.';

export async function assertStudioWritable(admin: Db, studioId: string | null | undefined): Promise<void> {
  if (!studioId) return;
  // A single-studio deployment (STUDIO_SLUG) has no plan to pay for.
  if ((Deno.env.get('STUDIO_SLUG') ?? '').trim()) return;
  const ro = must(await admin.rpc('studio_read_only', { p_studio: studioId }));
  if (ro === true) throw new HttpError(403, 'READ_ONLY', READ_ONLY_MESSAGE);
}
