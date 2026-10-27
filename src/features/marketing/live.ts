/**
 * Live (Supabase) implementation of MarketingStore. Tables and RPCs: supabase/migrations/1200_marketing_core.sql,
 * 1201_marketing_rpc.sql and 1202_marketing_queue.sql. Every change goes through a marketing_* RPC (same rules and
 * error codes as demo.ts); the RPCs already return camelCase JSON shaped like types.ts, so this file mostly passes
 * arguments through. Sending happens in the marketing-send edge function: the RPCs only queue.
 *
 * Gaps (see NOTES.md › marketing): real push delivery (needs VAPID / FCM keys) and a status endpoint for the SMS / email
 * providers, so getProviders and sendTestPush describe the setup instead of probing it.
 */
import './permissions';
import { registerLiveFeature, type LiveFeatureContext } from '../../data/supabase/features';
import { validateCampaign } from './validate';
import type {
  AudiencePreview, Automation, AutomationRun, Campaign, CampaignDetail, InboxAccess, InboxMessage, InboxThread, InboxThreadDetail, MarketingSettings,
  MarketingStore, MessageLogEntry, MyThread, ProviderStatus, PushStatus, Segment, SegmentWithCount,
} from './types';

type Row = Record<string, unknown>;

function create(ctx: LiveFeatureContext): MarketingStore {
  const rpc = async <T,>(name: string, args?: Row): Promise<T> => (await ctx.rpc(name, args)) as T;
  const err = ctx.error;

  /** Ask the sender to deliver now instead of waiting for the next scheduled run. Best effort: the queue drains either way. */
  const kick = async () => {
    try { await ctx.sb.functions.invoke('marketing-send', { body: { kick: true, studioId: ctx.studioId } }); } catch { /* the schedule picks it up */ }
  };

  return {
    // ---------------------------------------------------------------- segments + tags
    listSegments: () => ctx.read(() => rpc<SegmentWithCount[]>('marketing_list_segments')),
    previewAudience: (filter) => ctx.read(() => rpc<AudiencePreview>('marketing_preview_audience', { p_filter: filter })),
    saveSegment: (input) => ctx.write(() => rpc<Segment>('marketing_save_segment', {
      p_id: input.id ?? null, p_name: input.name, p_description: input.description ?? null, p_filter: input.filter,
    })),
    deleteSegment: (id) => ctx.write(async () => { await ctx.rpc('marketing_delete_segment', { p_id: id }); }),
    listTags: () => ctx.read(() => rpc<{ tag: string; count: number }[]>('marketing_list_tags')),
    getClientTags: (clientId) => ctx.read(() => rpc<string[]>('marketing_get_client_tags', { p_client_id: clientId })),
    setClientTags: (clientId, tags) => ctx.write(() => rpc<string[]>('marketing_set_client_tags', { p_client_id: clientId, p_tags: tags })),

    // ---------------------------------------------------------------- campaigns
    listCampaigns: () => ctx.read(() => rpc<Campaign[]>('marketing_list_campaigns')),
    getCampaign: (id) => ctx.read(() => rpc<CampaignDetail>('marketing_get_campaign', { p_id: id })),
    saveCampaign: (input) => ctx.write(() => rpc<Campaign>('marketing_save_campaign', {
      p_input: { ...(input.id ? { id: input.id } : {}), name: input.name, channel: input.channel, segmentId: input.segmentId ?? null,
        subject: input.subject ?? '', preheader: input.preheader ?? '', blocks: input.blocks ?? [], body: input.body ?? '' },
    })),
    deleteCampaign: (id) => ctx.write(async () => { await ctx.rpc('marketing_delete_campaign', { p_id: id }); }),
    sendCampaign: (id) => ctx.write(async () => {
      const c = await rpc<Campaign>('marketing_send_campaign', { p_id: id });
      void kick();
      return c;
    }),
    scheduleCampaign: (id, at) => ctx.write(() => rpc<Campaign>('marketing_schedule_campaign', { p_id: id, p_at: at })),
    unscheduleCampaign: (id) => ctx.write(() => rpc<Campaign>('marketing_unschedule_campaign', { p_id: id })),
    sendTest: (input, to) => ctx.write(async () => {
      validateCampaign(input, err, { forSend: true });
      const dest = (to ?? '').trim();
      if (input.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) throw err('INVALID', 'Enter a valid email address.');
      if (input.channel === 'sms' && dest.replace(/[^\d]/g, '').length < 8) throw err('INVALID', 'Enter a valid mobile number.');
      const res = (await ctx.sb.functions.invoke('marketing-send', {
        body: { test: { channel: input.channel, subject: input.subject ?? '', preheader: input.preheader ?? '', blocks: input.blocks ?? [], body: input.body ?? '' }, to: dest, studioId: ctx.studioId },
      })) as { error?: { message?: string; context?: { json?: () => Promise<{ message?: string }> } } };
      if (res.error) {
        let msg = 'We couldn’t send the test. Please try again.';
        try { const j = await res.error.context?.json?.(); if (j?.message) msg = j.message; } catch { /* not JSON */ }
        throw err('ERROR', msg);
      }
    }),

    // ---------------------------------------------------------------- automations
    listAutomations: () => ctx.read(() => rpc<(Automation & { sentLast30Days: number })[]>('marketing_list_automations')),
    saveAutomation: (input) => ctx.write(() => rpc<Automation>('marketing_save_automation', { p_input: input as unknown as Row })),
    runAutomations: ({ dryRun }) => ctx.write(async () => {
      const run = await rpc<AutomationRun>('marketing_run_automations', { p_dry_run: dryRun });
      if (!dryRun && run.items.length) void kick();
      return run;
    }),
    listMessageLog: (opts) => ctx.read(() => rpc<MessageLogEntry[]>('marketing_message_log', { p_limit: opts?.limit ?? 50 })),

    // ---------------------------------------------------------------- inbox (staff)
    listThreads: () => ctx.read(() => rpc<InboxThread[]>('marketing_list_threads')),
    getThread: (clientId) => ctx.read(() => rpc<InboxThreadDetail>('marketing_get_thread', { p_client_id: clientId })),
    sendStaffMessage: (clientId, body) => ctx.write(() => rpc<InboxMessage>('marketing_send_staff_message', { p_client_id: clientId, p_body: body })),
    sendText: (clientId, body) => ctx.write(async () => {
      const m = await rpc<InboxMessage>('marketing_send_text', { p_client_id: clientId, p_body: body });
      void kick();
      return m;
    }),
    markThreadRead: (clientId) => ctx.write(async () => { await ctx.rpc('marketing_mark_thread_read', { p_client_id: clientId }); }),
    inboxUnreadCount: () => ctx.read(async () => Number(await ctx.rpc('marketing_inbox_unread'))),

    // ---------------------------------------------------------------- inbox (the client)
    getMyThread: () => ctx.read(() => rpc<MyThread>('marketing_my_thread')),
    sendMyMessage: (body) => ctx.write(() => rpc<InboxMessage>('marketing_send_my_message', { p_body: body })),
    markMyThreadRead: () => ctx.write(async () => { await ctx.rpc('marketing_mark_my_thread_read'); }),
    myUnreadCount: () => ctx.read(async () => Number(await ctx.rpc('marketing_my_unread'))),
    /** New messages arrive through Supabase realtime (RLS limits each side to its own rows). */
    subscribeInbox: (onChange) => {
      const ch = ctx.sb.channel(`marketing-inbox-${ctx.studioId}-${Math.random().toString(36).slice(2, 8)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'marketing_thread_messages' }, () => onChange())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'marketing_threads' }, () => onChange())
        .subscribe();
      return () => { try { void ctx.sb.removeChannel(ch); } catch { /* already closed */ } };
    },

    // ---------------------------------------------------------------- push (tokens are stored; delivery needs keys, see NOTES.md)
    getPushStatus: () => ctx.read(() => rpc<PushStatus>('marketing_push_status')),
    registerPush: (reg) => ctx.write(async () => {
      await ctx.rpc('marketing_register_push', { p_platform: reg.platform, p_token: reg.token, p_keys: reg.keys ?? null, p_user_agent: reg.userAgent ?? null });
    }),
    unregisterPush: (token) => ctx.write(async () => { await ctx.rpc('marketing_unregister_push', { p_token: token }); }),
    sendTestPush: () => ctx.read(async () => {
      const s = await rpc<PushStatus>('marketing_push_status');
      return { sent: 0, note: s.registered
        ? 'This device is registered. Push delivery isn’t switched on yet: it needs VAPID keys (web) and FCM / APNs credentials (apps).'
        : 'Turn on notifications on this device first.' };
    }),

    // ---------------------------------------------------------------- settings
    getSettings: () => ctx.read(() => rpc<MarketingSettings>('marketing_get_settings')),
    getInboxAccess: () => ctx.read(() => rpc<{ access: InboxAccess; allowed: boolean }>('marketing_inbox_access')),
    updateSettings: (patch) => ctx.write(() => rpc<MarketingSettings>('marketing_update_settings', { p_patch: patch as unknown as Row })),
    getProviders: () => ctx.read(async (): Promise<ProviderStatus> => ({
      sms: { provider: 'stub', ready: false, note: 'Texts are queued and logged by a stub until Twilio is set up. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to the marketing-send function to send real ones.' },
      email: { provider: 'resend', ready: true, note: 'Emails go out through Resend from the marketing-send function, in your studio’s colours and name.' },
      push: { ready: false, note: 'Devices are saved, but sending needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for web push, plus FCM or APNs credentials for the apps.' },
    })),
  };
}

registerLiveFeature({ name: 'marketing', create });
