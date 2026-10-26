// Sends the "you've been invited" email (Supabase Auth invite) for a new studio owner or staff member.
// The staff row already exists (platform_invite_owner, or the studio app's Staff tab); this only sends the
// login link, which opens that studio's studio app. When the person signs up, link_auth_user joins the login
// to their staff row(s) by email.
//
//   POST { studioId, email, name?, role? }
//   Allowed: a platform admin (any studio), or that studio's owner / manager.
//
// Settings: APP_URL (the client app, e.g. https://app.snowypilatesclub.com). Optional PLATFORM_DOMAIN: when set,
// links go to https://<slug>.<PLATFORM_DOMAIN>/studio/ instead of APP_URL/studio/?studio=<slug>.
import { assertStudioWritable } from '../_shared/billing.ts';
import { adminClient, must, userClient } from '../_shared/db.ts';
import { env, HttpError, json, readJson, serve } from '../_shared/http.ts';

serve(async (req) => {
  const body = await readJson(req);
  const studioId = String(body.studioId ?? '');
  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  if (!studioId || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'INVALID', 'Please give a studio and an email address.');

  const caller = userClient(req);
  const { data: who } = await caller.auth.getUser();
  const uid = who?.user?.id;
  if (!uid) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.');

  const admin = adminClient();
  const studio = must(await admin.from('studios').select('id, slug, name, status').eq('id', studioId).maybeSingle()) as
    { id: string; slug: string; name: string; status: string } | null;
  if (!studio) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that studio.');

  const isAdmin = !!must(await admin.from('platform_admins').select('user_id').eq('user_id', uid).maybeSingle());
  if (!isAdmin) {
    const mine = must(await admin.from('staff').select('role').eq('studio_id', studio.id).eq('user_id', uid).eq('active', true)) as { role: string }[];
    if (!mine.some((s) => s.role === 'owner' || s.role === 'manager')) throw new HttpError(403, 'NOT_ALLOWED', 'Only the studio’s owner or a manager can invite staff.');
    await assertStudioWritable(admin, studio.id);
  }
  // The person must already be on that studio's team (so this can't be used to email anyone at all).
  const onTeam = must(await admin.from('staff').select('id').eq('studio_id', studio.id).ilike('email', email).limit(1)) as unknown[];
  if (!onTeam.length) throw new HttpError(404, 'NOT_FOUND', 'Add them to the studio’s team first.');

  const domain = (Deno.env.get('PLATFORM_DOMAIN') ?? '').trim();
  const redirectTo = domain
    ? `https://${studio.slug}.${domain}/studio/`
    : `${env('APP_URL').replace(/\/+$/, '')}/studio/?studio=${encodeURIComponent(studio.slug)}`;

  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo, data: { name, studio: studio.slug } });
  if (error) {
    // Already has a login (e.g. a client somewhere, or staff at another studio): they just sign in with it.
    if (/already|registered|exists/i.test(error.message ?? '')) return json({ invited: false, existingLogin: true });
    console.error('invite failed', error);
    throw new HttpError(500, 'ERROR', 'We couldn’t send the invite. Please try again.');
  }
  return json({ invited: true });
});
