/** Live (Supabase) OnDemandStore: supabase/migrations/1900_ondemand.sql. Everything goes through RPCs (clients can't read the tables, so a locked video's address never reaches them). */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
import type { AdminVideo, ClientVideo, OnDemandCatalog } from './types';

const str = (v: unknown) => (v == null ? '' : String(v));

const toClient = (r: Record<string, unknown>): ClientVideo => ({
  id: String(r.id), title: str(r.title), description: str(r.description), instructor: str(r.instructor), durationMin: Number(r.duration_min), level: str(r.level),
  category: str(r.category), thumbnailUrl: str(r.thumbnail_url), free: !!r.free, locked: !!r.locked, videoUrl: r.video_url == null ? null : String(r.video_url),
  lastWatchedAt: r.last_watched_at == null ? null : String(r.last_watched_at),
});
const toAdmin = (r: Record<string, unknown>): AdminVideo => ({
  id: String(r.id), title: str(r.title), description: str(r.description), instructor: str(r.instructor), durationMin: Number(r.duration_min), level: str(r.level),
  category: str(r.category), thumbnailUrl: str(r.thumbnail_url), videoUrl: str(r.video_url), published: !!r.published, free: !!r.free, sortOrder: Number(r.sort_order), views: Number(r.views ?? 0),
});

registerLiveFeature({
  name: 'ondemand',
  create: (ctx) => ({
    list: () => ctx.read(async (): Promise<OnDemandCatalog> => {
      const r = (await ctx.rpc('ondemand_list_videos')) as { access?: boolean; videos?: Record<string, unknown>[] } | null;
      return { access: !!r?.access, videos: (r?.videos ?? []).map(toClient) };
    }),
    recordView: (videoId) => ctx.write(async () => { await ctx.rpc('ondemand_record_view', { p_video_id: videoId }); }),
    adminList: () => ctx.read(async () => ((await ctx.rpc('ondemand_admin_list')) as Record<string, unknown>[] | null ?? []).map(toAdmin)),
    save: (i, id) => ctx.write(async () => toAdmin((await ctx.rpc('ondemand_save_video', {
      p_id: id ?? null, p_title: i.title, p_description: i.description ?? '', p_instructor: i.instructor ?? '', p_duration_min: i.durationMin, p_level: i.level ?? '',
      p_category: i.category, p_thumbnail_url: i.thumbnailUrl ?? '', p_video_url: i.videoUrl, p_published: !!i.published, p_free: !!i.free,
    })) as Record<string, unknown>)),
    setPublished: (id, published) => ctx.write(async () => { await ctx.rpc('ondemand_set_published', { p_id: id, p_published: published }); }),
    reorder: (ids) => ctx.write(async () => { await ctx.rpc('ondemand_reorder', { p_ids: ids }); }),
    remove: (id) => ctx.write(async () => { await ctx.rpc('ondemand_delete_video', { p_id: id }); }),
    getSettings: () => ctx.read(async () => ({ productIds: (await ctx.rows(ctx.sb.from('ondemand_products').select('product_id'))).map((r) => String(r.product_id)) })),
    saveSettings: (s) => ctx.write(async () => {
      const r = (await ctx.rpc('ondemand_save_products', { p_product_ids: s.productIds })) as string[] | null;
      return { productIds: (r ?? []).map(String) };
    }),
  }),
});
