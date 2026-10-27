/** Live (Supabase) ReviewsStore: supabase/migrations/1600_reviews.sql. Writes go through RPCs; staff read the table (RLS limits instructors to their own classes). */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
import { byNewest } from './calc';
import type { ReviewEntry, ReviewPrompt, ReviewsSettings } from './types';

const str = (v: unknown) => (v == null ? null : String(v));

const toEntry = (r: Record<string, unknown>): ReviewEntry => ({
  id: String(r.id), bookingId: String(r.booking_id), sessionId: String(r.session_id), classTypeId: String(r.class_type_id), instructorId: String(r.instructor_id),
  clientFirstName: String(r.client_first_name ?? ''), rating: Number(r.rating), nps: r.nps == null ? null : Number(r.nps), comment: str(r.comment), createdAt: String(r.created_at),
});

const toSettings = (r?: Record<string, unknown>): ReviewsSettings => ({
  googleReviewUrl: String(r?.google_review_url ?? ''), googleAskEnabled: r?.google_ask_enabled === true, googleAskEvery: Number(r?.google_ask_every ?? 5) || 5,
});

registerLiveFeature({
  name: 'reviews',
  create: (ctx) => ({
    pendingPrompt: () => ctx.read(async () => {
      const r = (await ctx.rpc('reviews_pending')) as Record<string, unknown> | null;
      if (!r) return null;
      return {
        bookingId: String(r.booking_id), sessionId: String(r.session_id), classTypeId: String(r.class_type_id), className: String(r.class_name),
        instructorId: String(r.instructor_id), instructorName: String(r.instructor_name ?? ''), startsAt: String(r.starts_at),
      } satisfies ReviewPrompt;
    }),
    submit: (bookingId, input) => ctx.write(async () => {
      const r = (await ctx.rpc('reviews_submit', { p_booking_id: bookingId, p_rating: input.rating, p_nps: input.nps ?? null, p_comment: input.comment ?? null })) as Record<string, unknown> | null;
      return r?.google_url ? { googleUrl: String(r.google_url) } : {};
    }),
    dismiss: (bookingId) => ctx.write(async () => { await ctx.rpc('reviews_dismiss', { p_booking_id: bookingId }); }),
    list: () => ctx.read(async () => (await ctx.rows(ctx.sb.from('reviews_entries').select('*').order('created_at', { ascending: false }).limit(2000))).map(toEntry).sort(byNewest)),
    getSettings: () => ctx.read(async (): Promise<ReviewsSettings> => {
      const rows = await ctx.rows(ctx.sb.from('reviews_settings').select('google_review_url, google_ask_enabled, google_ask_every'));
      return toSettings(rows[0]);
    }),
    saveSettings: (patch) => ctx.write(async (): Promise<ReviewsSettings> => {
      const r = (await ctx.rpc('reviews_save_settings', {
        p_google_url: patch.googleReviewUrl ?? null, p_ask_enabled: patch.googleAskEnabled ?? null, p_ask_every: patch.googleAskEvery ?? null,
      })) as Record<string, unknown> | null;
      return toSettings(r ?? undefined);
    }),
  }),
});
