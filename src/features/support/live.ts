/** Live (Supabase) SupportStore: supabase/migrations/2000_support.sql. Writes go through RPCs; staff read the tables (RLS: your own, or the studio's for owner and manager). */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
import { loadOne, loadRequests, toBanner } from './rows';

registerLiveFeature({
  name: 'support',
  create: (ctx) => ({
    send: (input) => ctx.write(async () => {
      const r = await ctx.rpc('support_send', {
        p_body: input.body, p_urgent: input.urgent, p_screenshot: input.screenshot ?? null, p_route: input.context.route,
        p_app_version: input.context.appVersion, p_user_agent: input.context.userAgent, p_reply_by: input.replyBy,
      });
      return loadOne(r, ctx.sb, ctx.rows);
    }),
    listMine: () => ctx.read(() => loadRequests(ctx.sb, ctx.rows)),
    follow: (requestId, body) => ctx.write(async () => loadOne(await ctx.rpc('support_follow', { p_request_id: requestId, p_body: body }), ctx.sb, ctx.rows)),
    banner: () => ctx.read(async () => toBanner((await ctx.rows(ctx.sb.from('support_status').select('*').limit(1)))[0])),
  }),
});
