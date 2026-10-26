/** Live (Supabase) row mapping and queries shared by the studio store (live.ts) and the admin inbox (admin/store.ts). */
import type { SupportBanner, SupportMessage, SupportRequest, SupportStatus } from './types';

const str = (v: unknown) => (v == null ? '' : String(v));

export const toMessage = (r: Record<string, unknown>): SupportMessage => ({
  id: str(r.id), from: r.from_platform ? 'platform' : 'studio', author: str(r.author_name), body: str(r.body), at: str(r.created_at),
});

export const toRequest = (r: Record<string, unknown>, messages: SupportMessage[]): SupportRequest => ({
  id: str(r.id), studioId: str(r.studio_id), studioName: str(r.studio_name), staffId: r.staff_id ? str(r.staff_id) : null,
  staffName: str(r.staff_name), staffRole: str(r.staff_role) as SupportRequest['staffRole'], body: str(r.body), urgent: !!r.urgent,
  status: str(r.status) as SupportStatus, context: { route: str(r.route), appVersion: str(r.app_version), userAgent: str(r.user_agent) },
  screenshot: r.screenshot ? str(r.screenshot) : null, replyBy: r.reply_by ? str(r.reply_by) : null, createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  messages,
});

export const toBanner = (r: Record<string, unknown> | undefined | null): SupportBanner | null =>
  r && str(r.message) ? { message: str(r.message), tone: r.tone === 'warn' ? 'warn' : 'info', updatedAt: str(r.updated_at) } : null;

type Rows = (q: PromiseLike<{ data: unknown; error: unknown }>) => Promise<Record<string, unknown>[]>;

/** Requests (newest first) with their threads. RLS decides which ones you can see. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadRequests(sb: any, rows: Rows): Promise<SupportRequest[]> {
  const reqs = await rows(sb.from('support_requests').select('*').order('created_at', { ascending: false }).limit(300));
  if (!reqs.length) return [];
  const msgs = await rows(sb.from('support_messages').select('*').in('request_id', reqs.map((r) => r.id)).order('created_at', { ascending: true }));
  const by = new Map<string, SupportMessage[]>();
  for (const m of msgs) { const k = str(m.request_id); (by.get(k) ?? by.set(k, []).get(k)!).push(toMessage(m)); }
  return reqs.map((r) => toRequest(r, by.get(str(r.id)) ?? []));
}

export async function loadOne(rpcResult: unknown, sb: unknown, rows: Rows): Promise<SupportRequest> {
  const id = str((rpcResult as Record<string, unknown>).id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [r] = await rows((sb as any).from('support_requests').select('*').eq('id', id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = await rows((sb as any).from('support_messages').select('*').eq('request_id', id).order('created_at', { ascending: true }));
  return toRequest(r ?? (rpcResult as Record<string, unknown>), m.map(toMessage));
}
