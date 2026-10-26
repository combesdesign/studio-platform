/** Live (Supabase) SupportStore: supabase/migrations/2000_support.sql. Writes go through RPCs; staff read the tables (RLS: your own, or the studio's for owner and manager). */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
import { articleAnswer } from './assist';
import { loadOne, loadRequests, toBanner } from './rows';

registerLiveFeature({
  name: 'support',
  create: (ctx) => ({
    // The support-assist edge function. Not switched on (501) or failing (502, network): fall back to the best-matching
    // article, so the sheet always answers. Over the daily cap (429): say so.
    assist: async (input) => {
      try {
        const res = (await ctx.sb.functions.invoke('support-assist', { body: { question: input.question, page: input.page, studioId: ctx.studioId } })) as { data?: { answer?: string; suggestHuman?: boolean }; error?: { context?: { status?: number; json?: () => Promise<{ message?: string }> } } };
        if (!res.error && res.data && typeof res.data.answer === 'string') return { answer: res.data.answer, suggestHuman: res.data.suggestHuman === true };
        if (res.error?.context?.status === 429) {
          let message = 'You\'ve used today\'s quick answers. Send it to us and we\'ll reply.';
          try { message = (await res.error.context.json?.())?.message || message; } catch { /* not JSON */ }
          throw ctx.error('RATE_LIMITED', message);
        }
      } catch (e) {
        if ((e as { code?: string })?.code === 'RATE_LIMITED') throw e;
      }
      return articleAnswer(input.question);
    },
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
