/**
 * Demo implementation of MarketingStore, plugged into the demo store. Everything lives in the studio's demo state
 * (see slice.ts), so it persists, syncs between tabs (the studio app and the client app) and resets with the demo.
 * Nothing is really sent: emails and texts go into a send log, with simulated opens and clicks.
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import type { ID } from '../../shared/types';
import { AUTOMATION_CATALOG, defaultAutomations } from './catalog';
import { automationCandidates, filterAudience } from './segments';
import { seedMarketing } from './seed';
import {
  audienceOf, deliverCampaign, emptySlice, hash, toCampaign, type Slice, type StoredCampaign, type StoredLog,
} from './slice';
import { cleanAutomation, cleanBody, cleanFilter, cleanTags, validateCampaign } from './validate';
import type {
  AudiencePreview, Automation, AutomationInput, AutomationRun, Campaign, CampaignDetail, InboxMessage, InboxThread,
  InboxThreadDetail, MarketingSettings, MarketingStore, MessageLogEntry, MyThread, ProviderStatus, PushPlatform, PushRegistration,
  PushStatus, Segment, SegmentWithCount,
} from './types';

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

function appUrl(): string {
  if (typeof location === 'undefined') return 'https://app.example.test/';
  return `${location.origin}${location.pathname.replace(/studio\/?$/, '')}`;
}

function create(ctx: DemoFeatureContext): MarketingStore {
  const err = ctx.error;

  /** This studio's slice, with anything missing filled in (a studio created before this feature, or a partial test state). */
  const S = (): Slice => {
    const x = ctx.slice<Record<string, unknown>>();
    for (const [k, v] of Object.entries(emptySlice())) if (x[k] === undefined) x[k] = v;
    const sl = x as unknown as Slice;
    for (const d of defaultAutomations()) if (!sl.automations.some((a) => a.key === d.key)) sl.automations.push(d);
    return sl;
  };
  const members = () => audienceOf(ctx.core().state, ctx.now(), S().tags);
  const clientOf = (id: ID) => {
    const c = ctx.core().state.clients.find((x) => x.id === id);
    if (!c) throw err('NOT_FOUND', 'We couldn’t find that client.');
    return c;
  };
  const mask = (l: StoredLog): MessageLogEntry => {
    const t = ctx.now().getTime();
    const { dedupeKey: _d, ...rest } = l;
    const out: MessageLogEntry = { ...rest };
    if (out.openedAt && Date.parse(out.openedAt) > t) delete out.openedAt;
    if (out.clickedAt && Date.parse(out.clickedAt) > t) delete out.clickedAt;
    return out;
  };

  const sendNow = (c: StoredCampaign, at: Date, fast: boolean) => {
    const sl = S();
    const seg = sl.segments.find((s) => s.id === c.segmentId);
    const people = filterAudience(members(), seg ? seg.filter : { match: 'all', rules: [] }, ctx.now());
    c.filterAtSend = seg?.filter;
    c.segmentName = seg ? seg.name : c.segmentName ?? 'All clients';
    deliverCampaign(sl, c, people, ctx.newId, at, fast);
  };
  /** Scheduled campaigns whose time has come go out (like the scheduler does live). */
  const settle = () => {
    const now = ctx.now();
    for (const c of S().campaigns) {
      if (c.status !== 'scheduled' || !c.scheduledFor || Date.parse(c.scheduledFor) > now.getTime()) continue;
      const when = new Date(c.scheduledFor);
      sendNow(c, when, now.getTime() - when.getTime() < 120_000);
    }
  };
  const findCampaign = (id: ID): StoredCampaign => {
    const c = S().campaigns.find((x) => x.id === id);
    if (!c) throw err('NOT_FOUND', 'We couldn’t find that campaign.');
    return c;
  };
  const segmentName = (id?: ID | null) => (id ? S().segments.find((s) => s.id === id)?.name : undefined) ?? 'All clients';

  // ---------------------------------------------------------------- inbox helpers
  const threadFor = (clientId: ID) => S().threads.find((t) => t.clientId === clientId);
  const msgsOf = (threadId: ID) => S().messages.filter((m) => m.threadId === threadId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const toThread = (t: Slice['threads'][number]): InboxThread => {
    const c = clientOf(t.clientId);
    const last = msgsOf(t.id).at(-1);
    return {
      id: t.id, clientId: t.clientId, clientName: fullName(c), ...(c.photoUrl ? { clientPhotoUrl: c.photoUrl } : {}),
      lastMessageAt: last?.at ?? t.createdAt, lastMessagePreview: (last?.body ?? '').replace(/\s+/g, ' ').slice(0, 140), lastFrom: last?.from ?? 'client', unread: t.staffUnread,
    };
  };
  const addMessage = (clientId: ID, from: 'client' | 'staff', body: string, staffName?: string): InboxMessage => {
    const sl = S();
    let t = threadFor(clientId);
    if (!t) { t = { id: ctx.newId('th'), clientId, createdAt: ctx.now().toISOString(), staffUnread: 0, clientUnread: 0 }; sl.threads.push(t); }
    const m: InboxMessage = { id: ctx.newId('mm'), threadId: t.id, from, ...(staffName ? { staffName } : {}), body, at: ctx.now().toISOString() };
    sl.messages.push(m);
    if (from === 'client') t.staffUnread++; else t.clientUnread++;
    return m;
  };
  const myClient = () => {
    const u = ctx.me();
    if (u.kind !== 'client') throw err('NOT_ALLOWED', 'Messages from clients can only be sent from the client app.');
    return u.clientId;
  };
  const whoKey = () => { const u = ctx.me(); return u.kind === 'client' ? `client:${u.clientId}` : `staff:${u.staffId}`; };

  return {
    // ================================================================ segments + tags
    listSegments: () => ctx.read(() => {
      ctx.requireStaff('marketing.view'); settle();
      const all = members(), now = ctx.now();
      return S().segments.map((s): SegmentWithCount => {
        const hit = filterAudience(all, s.filter, now);
        return { ...s, count: hit.length, optedIn: hit.filter((m) => m.optIn).length };
      });
    }),
    previewAudience: (filter) => ctx.read((): AudiencePreview => {
      ctx.requireStaff('marketing.view');
      const hit = filterAudience(members(), cleanFilter(filter, err), ctx.now());
      return {
        count: hit.length, optedIn: hit.filter((m) => m.optIn).length,
        sample: hit.slice(0, 6).map((m) => ({ clientId: m.clientId, firstName: m.firstName, lastName: m.lastName, optIn: m.optIn })),
      };
    }),
    saveSegment: (input) => ctx.write((): Segment => {
      ctx.requireStaff('marketing.manage');
      const name = (input.name ?? '').trim();
      if (!name) throw err('INVALID', 'Give the segment a name.');
      if (name.length > 60) throw err('INVALID', 'Segment names can be up to 60 characters.');
      const filter = cleanFilter(input.filter, err);
      const sl = S();
      if (sl.segments.some((s) => s.id !== input.id && s.name.toLowerCase() === name.toLowerCase())) throw err('INVALID', 'You already have a segment with that name.');
      const desc = (input.description ?? '').trim().slice(0, 140);
      if (input.id) {
        const cur = sl.segments.find((s) => s.id === input.id);
        if (!cur) throw err('NOT_FOUND', 'We couldn’t find that segment.');
        cur.name = name; cur.filter = filter;
        if (desc) cur.description = desc; else delete cur.description;
        return cur;
      }
      const seg: Segment = { id: ctx.newId('sg'), name, ...(desc ? { description: desc } : {}), filter, createdAt: ctx.now().toISOString() };
      sl.segments.push(seg);
      return seg;
    }),
    deleteSegment: (id) => ctx.write(() => {
      ctx.requireStaff('marketing.manage');
      const sl = S();
      if (!sl.segments.some((s) => s.id === id)) throw err('NOT_FOUND', 'We couldn’t find that segment.');
      if (sl.campaigns.some((c) => c.segmentId === id && (c.status === 'draft' || c.status === 'scheduled'))) {
        throw err('INVALID', 'A draft or scheduled campaign still uses this segment. Change or delete that campaign first.');
      }
      sl.segments = sl.segments.filter((s) => s.id !== id);
    }),
    listTags: () => ctx.read(() => {
      ctx.requireStaff('marketing.view');
      const live = new Set(ctx.core().state.clients.filter((c) => !c.archived).map((c) => c.id));
      const n = new Map<string, number>();
      for (const [cid, tags] of Object.entries(S().tags)) if (live.has(cid)) for (const t of tags) n.set(t, (n.get(t) ?? 0) + 1);
      return [...n.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }),
    getClientTags: (clientId) => ctx.read(() => { ctx.requireStaff('marketing.view'); clientOf(clientId); return [...(S().tags[clientId] ?? [])]; }),
    setClientTags: (clientId, tags) => ctx.write(() => {
      ctx.requireStaff('marketing.manage'); clientOf(clientId);
      const clean = cleanTags(tags, err);
      if (clean.length) S().tags[clientId] = clean; else delete S().tags[clientId];
      return clean;
    }),

    // ================================================================ campaigns
    listCampaigns: () => ctx.read(() => {
      ctx.requireStaff('marketing.view'); settle();
      const now = ctx.now();
      const rank = (c: StoredCampaign) => (c.status === 'scheduled' ? 0 : c.status === 'draft' ? 1 : 2);
      const when = (c: StoredCampaign) => c.sentAt ?? c.scheduledFor ?? c.createdAt;
      return [...S().campaigns].sort((a, b) => rank(a) - rank(b) || when(b).localeCompare(when(a))).map((c) => toCampaign(c, S().log, now));
    }),
    getCampaign: (id) => ctx.read((): CampaignDetail => {
      ctx.requireStaff('marketing.view'); settle();
      const c = findCampaign(id);
      const recipients = S().log.filter((l) => l.source === 'campaign' && l.refId === id).map(mask)
        .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '') || a.clientName.localeCompare(b.clientName)).slice(0, 200);
      return { campaign: toCampaign(c, S().log, ctx.now()), segment: S().segments.find((s) => s.id === c.segmentId) ?? null, recipients };
    }),
    saveCampaign: (input) => ctx.write((): Campaign => {
      const staff = ctx.requireStaff('marketing.manage');
      const sl = S();
      const v = validateCampaign(input, err, { forSend: false });
      if (input.segmentId && !sl.segments.some((s) => s.id === input.segmentId)) throw err('NOT_FOUND', 'We couldn’t find that segment.');
      const fields = {
        name: v.name, channel: v.channel, ...(input.segmentId ? { segmentId: input.segmentId } : {}), segmentName: segmentName(input.segmentId),
        ...(v.channel === 'email' ? { subject: v.subject, preheader: v.preheader, blocks: v.blocks } : { body: v.body }),
      };
      if (input.id) {
        const c = findCampaign(input.id);
        if (c.status !== 'draft') throw err('INVALID', c.status === 'scheduled' ? 'Unschedule this campaign before changing it.' : 'Sent campaigns can’t be changed. Duplicate it to send something similar.');
        for (const k of ['segmentId', 'subject', 'preheader', 'blocks', 'body'] as const) delete c[k];
        Object.assign(c, fields);
        return toCampaign(c, sl.log, ctx.now());
      }
      const c: StoredCampaign = { id: ctx.newId('cp'), status: 'draft', createdAt: ctx.now().toISOString(), createdByName: staff.name, audience: 0, skipped: 0, unsubscribed: 0, ...fields };
      sl.campaigns.push(c);
      return toCampaign(c, sl.log, ctx.now());
    }),
    deleteCampaign: (id) => ctx.write(() => {
      ctx.requireStaff('marketing.manage');
      const c = findCampaign(id);
      if (c.status === 'sent' || c.status === 'sending') throw err('INVALID', 'Sent campaigns are kept so your numbers stay right.');
      S().campaigns = S().campaigns.filter((x) => x.id !== id);
    }),
    sendCampaign: (id) => ctx.write((): Campaign => {
      ctx.requireStaff('marketing.manage');
      const c = findCampaign(id);
      if (c.status !== 'draft' && c.status !== 'scheduled') throw err('INVALID', 'That campaign has already gone out.');
      validateCampaign(c, err, { forSend: true });
      const sl = S();
      const seg = sl.segments.find((s) => s.id === c.segmentId);
      const people = filterAudience(members(), seg ? seg.filter : { match: 'all', rules: [] }, ctx.now());
      const reachable = people.filter((m) => m.optIn && (c.channel === 'sms' ? !!m.phone : !!m.email.trim())).length;
      if (reachable === 0) throw err('INVALID', 'Nobody in this audience has opted into marketing yet, so there’s no one to send to.');
      sendNow(c, ctx.now(), true);
      return toCampaign(c, sl.log, ctx.now());
    }),
    scheduleCampaign: (id, at) => ctx.write((): Campaign => {
      ctx.requireStaff('marketing.manage');
      const c = findCampaign(id);
      if (c.status !== 'draft' && c.status !== 'scheduled') throw err('INVALID', 'That campaign has already gone out.');
      validateCampaign(c, err, { forSend: true });
      const when = Date.parse(at);
      if (!isFinite(when)) throw err('INVALID', 'Pick a date and time.');
      if (when < ctx.now().getTime() + 60_000) throw err('INVALID', 'Pick a time in the future.');
      if (when > ctx.now().getTime() + 365 * 86_400_000) throw err('INVALID', 'Pick a time within the next year.');
      c.status = 'scheduled';
      c.scheduledFor = new Date(when).toISOString();
      return toCampaign(c, S().log, ctx.now());
    }),
    unscheduleCampaign: (id) => ctx.write((): Campaign => {
      ctx.requireStaff('marketing.manage');
      const c = findCampaign(id);
      if (c.status !== 'scheduled') throw err('INVALID', 'That campaign isn’t scheduled.');
      c.status = 'draft';
      delete c.scheduledFor;
      return toCampaign(c, S().log, ctx.now());
    }),
    sendTest: (input, to) => ctx.write(() => {
      ctx.requireStaff('marketing.manage');
      const v = validateCampaign(input, err, { forSend: true });
      const dest = (to ?? '').trim();
      if (v.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) throw err('INVALID', 'Enter a valid email address.');
      if (v.channel === 'sms' && dest.replace(/[^\d]/g, '').length < 8) throw err('INVALID', 'Enter a valid mobile number.');
      // Demo: nothing leaves the browser. Live sends one real message through the same path as a campaign.
    }),

    // ================================================================ automations
    listAutomations: () => ctx.read(() => {
      ctx.requireStaff('marketing.view');
      const since = ctx.now().getTime() - 30 * 86_400_000;
      return AUTOMATION_CATALOG.map((d) => {
        const a = S().automations.find((x) => x.key === d.key)!;
        const sent = S().log.filter((l) => l.source === 'automation' && l.refId === d.key && l.status === 'sent' && Date.parse(l.sentAt ?? '') >= since).length;
        return { ...a, sentLast30Days: sent };
      });
    }),
    saveAutomation: (input: AutomationInput) => ctx.write((): Automation => {
      ctx.requireStaff('marketing.manage');
      const a = S().automations.find((x) => x.key === input.key);
      if (!a) throw err('NOT_FOUND', 'We couldn’t find that automation.');
      Object.assign(a, cleanAutomation(input, a, err), { updatedAt: ctx.now().toISOString() });
      return { ...a };
    }),
    runAutomations: ({ dryRun }) => ctx.write((): AutomationRun => {
      ctx.requireStaff(dryRun ? 'marketing.view' : 'marketing.manage');
      const sl = S(), now = ctx.now();
      const sentKeys = new Set(sl.log.map((l) => l.dedupeKey).filter((k): k is string => !!k));
      const plan = automationCandidates(sl.automations, members(), { now, studioName: ctx.studio().name, appUrl: appUrl(), sentKeys });
      if (!dryRun) {
        plan.items.forEach((it, i) => {
          const h = hash(it.dedupeKey);
          const e: StoredLog = {
            id: ctx.newId('ml'), channel: it.channel, source: 'automation', refId: it.key, refName: it.automationName, clientId: it.clientId, clientName: it.clientName,
            to: it.to, status: 'sent', sentAt: now.toISOString(), subject: it.subject, dedupeKey: it.dedupeKey,
          };
          if (it.channel === 'email' && (h + i) % 100 < 52) e.openedAt = new Date(now.getTime() + 8_000 + (h % 70_000)).toISOString();
          sl.log.push(e);
        });
      }
      return { dryRun, items: plan.items, skipped: plan.skipped };
    }),
    listMessageLog: (opts) => ctx.read(() => {
      ctx.requireStaff('marketing.view'); settle();
      return [...S().log].sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? '')).slice(0, opts?.limit ?? 50).map(mask);
    }),

    // ================================================================ inbox (staff)
    listThreads: () => ctx.read(() => {
      ctx.requireStaff('marketing.inbox');
      const live = new Set(ctx.core().state.clients.filter((c) => !c.archived).map((c) => c.id));
      return S().threads.filter((t) => live.has(t.clientId)).map(toThread).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    }),
    getThread: (clientId) => ctx.read((): InboxThreadDetail => {
      ctx.requireStaff('marketing.inbox'); clientOf(clientId);
      const t = threadFor(clientId);
      return { thread: t ? toThread(t) : null, messages: t ? msgsOf(t.id) : [] };
    }),
    sendStaffMessage: (clientId, body) => ctx.write((): InboxMessage => {
      const staff = ctx.requireStaff('marketing.inbox'); clientOf(clientId);
      const m = addMessage(clientId, 'staff', cleanBody(body, err), staff.name);
      threadFor(clientId)!.staffUnread = 0; // replying means they've read it
      return m;
    }),
    markThreadRead: (clientId) => ctx.write(() => {
      ctx.requireStaff('marketing.inbox');
      const t = threadFor(clientId);
      if (t) t.staffUnread = 0;
    }),
    inboxUnreadCount: () => ctx.read(() => {
      ctx.requireStaff('marketing.inbox');
      return S().threads.reduce((n, t) => n + t.staffUnread, 0);
    }),

    // ================================================================ inbox (the client)
    getMyThread: () => ctx.read((): MyThread => {
      const t = threadFor(myClient());
      return t ? { threadId: t.id, messages: msgsOf(t.id), unread: t.clientUnread } : { messages: [], unread: 0 };
    }),
    sendMyMessage: (body) => ctx.write((): InboxMessage => {
      const id = myClient();
      const m = addMessage(id, 'client', cleanBody(body, err));
      threadFor(id)!.clientUnread = 0; // sending means they're in the conversation
      return m;
    }),
    markMyThreadRead: () => ctx.write(() => { const t = threadFor(myClient()); if (t) t.clientUnread = 0; }),
    myUnreadCount: () => ctx.read(() => threadFor(myClient())?.clientUnread ?? 0),

    // ================================================================ push
    getPushStatus: () => ctx.read((): PushStatus => {
      const u = ctx.me(), mine = whoKey();
      const sl = S();
      const scope = u.kind === 'staff' ? sl.devices : sl.devices.filter((d) => d.who === mine);
      const devices: Record<PushPlatform, number> = { web: 0, ios: 0, android: 0 };
      for (const d of scope) devices[d.platform]++;
      return { registered: sl.devices.some((d) => d.who === mine), needsKeys: true, devices };
    }),
    registerPush: (reg: PushRegistration) => ctx.write(() => {
      const mine = whoKey();
      if (!['web', 'ios', 'android'].includes(reg.platform)) throw err('INVALID', 'Unknown device type.');
      if (!reg.token || reg.token.length > 2000) throw err('INVALID', 'That device can’t be registered.');
      const sl = S();
      const cur = sl.devices.find((d) => d.token === reg.token);
      if (cur) { cur.who = mine; cur.at = ctx.now().toISOString(); return; }
      sl.devices.push({ id: ctx.newId('pd'), who: mine, platform: reg.platform, token: reg.token, at: ctx.now().toISOString() });
    }),
    unregisterPush: (token) => ctx.write(() => {
      const mine = whoKey();
      S().devices = S().devices.filter((d) => !(d.token === token && d.who === mine));
    }),
    sendTestPush: () => ctx.write(() => {
      ctx.requireStaff('marketing.view');
      const n = S().devices.filter((d) => d.who === whoKey()).length;
      if (!n) throw err('INVALID', 'Turn on notifications on this device first.');
      return { sent: 0, note: `Demo: ${n} device${n === 1 ? '' : 's'} registered, but nothing was sent. Real push needs VAPID keys (web) and FCM credentials (apps).` };
    }),

    // ================================================================ settings
    getSettings: () => ctx.read((): MarketingSettings => { ctx.requireStaff('marketing.view'); return { ...S().settings }; }),
    updateSettings: (patch) => ctx.write((): MarketingSettings => {
      ctx.requireStaff('marketing.manage');
      const s = S().settings;
      for (const k of ['fromName', 'replyTo', 'smsSender', 'footerNote'] as const) {
        const v = patch[k];
        if (v === undefined) continue;
        const t = String(v).trim();
        if (t.length > 200) throw err('INVALID', 'That’s a bit long. Keep it under 200 characters.');
        if (k === 'replyTo' && t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw err('INVALID', 'Enter a valid reply-to email address.');
        s[k] = t;
      }
      return { ...s };
    }),
    getProviders: () => ctx.read((): ProviderStatus => {
      ctx.requireStaff('marketing.view');
      return {
        sms: { provider: 'stub', ready: false, note: 'Texts are simulated here. Live, add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to send real ones.' },
        email: { provider: 'demo', ready: false, note: 'Emails are simulated here. Live studios send through Resend.' },
        push: { ready: false, note: 'Needs real keys: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for web, FCM credentials for the iOS and Android apps.' },
      };
    }),
  };
}

registerDemoFeature({ name: 'marketing', seed: (a) => seedMarketing(a), create });
