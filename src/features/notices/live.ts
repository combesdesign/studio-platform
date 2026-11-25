/** Live (Supabase) NoticesStore: supabase/migrations/3303_notices.sql. Reads go through RLS (clients only ever get notices still showing); writes through RPCs. */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
import { studioDate } from '../../shared/format';
import { isActive, sortNotices } from './calc';
import type { Notice } from './types';

const toNotice = (r: Record<string, unknown>): Notice => ({
  id: String(r.id), title: String(r.title ?? ''), body: String(r.body ?? ''), pinned: r.pinned === true,
  createdAt: String(r.created_at ?? r.createdAt), updatedAt: String(r.updated_at ?? r.updatedAt),
  ...((r.link_url ?? r.linkUrl) ? { linkUrl: String(r.link_url ?? r.linkUrl) } : {}),
  ...((r.show_until ?? r.showUntil) ? { showUntil: String(r.show_until ?? r.showUntil).slice(0, 10) } : {}),
});

registerLiveFeature({
  name: 'notices',
  create: (ctx) => {
    const all = async () => (await ctx.rows(ctx.sb.from('notices').select('*').order('created_at', { ascending: false }).limit(500))).map(toNotice);
    return {
      // owners and managers can read finished notices through RLS, so filter here too
      listActive: () => ctx.read(async () => sortNotices((await all()).filter((n) => isActive(n, studioDate())))),
      listAll: () => ctx.read(async () => sortNotices(await all())),
      save: (input) => ctx.write(async () => toNotice((await ctx.rpc('notices_save', { p: { id: input.id ?? null, title: input.title, body: input.body ?? '', linkUrl: input.linkUrl ?? null, showUntil: input.showUntil ?? null, pinned: !!input.pinned } })) as Record<string, unknown>)),
      setPinned: (id, pinned) => ctx.write(async () => toNotice((await ctx.rpc('notices_set_pinned', { p_id: id, p_pinned: pinned })) as Record<string, unknown>)),
      remove: (id) => ctx.write(async () => { await ctx.rpc('notices_remove', { p_id: id }); }),
    };
  },
});
