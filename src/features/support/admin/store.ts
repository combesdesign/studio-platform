/**
 * Platform admin side of support: works across studios, so it isn't part of the studio DataStore. Picks the demo
 * (shared localStorage list) or live (Supabase, as the signed-in platform admin) from the platform's mode.
 * The only thing it borrows from core is the platform's signed-in supabase client (live) and the studio list (demo seed).
 */
import { platform } from '../../../data';
import { cleanBanner, cleanBody, statusAfter } from '../calc';
import { demoDb, ensureSeed, msg } from '../demoDb';
import { loadOne, loadRequests, toBanner } from '../rows';
import type { SupportAdminStore, SupportBanner, SupportRequest } from '../types';

const NAME = 'Pete';

function demoAdmin(): SupportAdminStore {
  const seed = async () => {
    const studios = await platform.listStudios({ includeAll: true });
    ensureSeed(studios.map((s) => ({ studioId: s.id, studioName: s.name, slug: s.slug })));
  };
  const one = (id: string) => {
    const r = demoDb.read((db) => db.requests.find((x) => x.id === id));
    if (!r) throw new Error('NOT_FOUND: We couldn\'t find that request.');
    return r;
  };
  return {
    list: async () => { await seed(); return demoDb.read((db) => [...db.requests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))); },
    reply: async (id, text, status) => {
      const body = cleanBody(text); one(id);
      return demoDb.write((db) => {
        const r = db.requests.find((x) => x.id === id)!;
        const now = new Date();
        r.messages.push(msg('platform', NAME, body, now));
        r.status = statusAfter('platform', status);
        r.updatedAt = now.toISOString();
        return { ...r };
      });
    },
    setStatus: async (id, status) => { one(id); return demoDb.write((db) => { const r = db.requests.find((x) => x.id === id)!; r.status = status; r.updatedAt = new Date().toISOString(); return { ...r }; }); },
    getBanner: async () => demoDb.read((db) => db.banner),
    setBanner: async (message, tone = 'info') => {
      const m = cleanBanner(message);
      return demoDb.write((db): SupportBanner | null => { db.banner = m ? { message: m, tone, updatedAt: new Date().toISOString() } : null; return db.banner; });
    },
    subscribe: (cb) => demoDb.subscribe(cb),
  };
}

function liveAdmin(): SupportAdminStore {
  // The platform's own signed-in client (no x-studio header, so a platform admin reads across studios).
  const sb = () => (platform as unknown as { shared?: { sb?: any } }).shared?.sb; // eslint-disable-line @typescript-eslint/no-explicit-any
  const must = () => { const c = sb(); if (!c) throw new Error('Support inbox needs a live connection.'); return c; };
  const rows = async (q: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await q;
    if (error) throw new Error(((error as { message?: string }).message ?? 'Something went wrong.').replace(/^[A-Z_]+: /, ''));
    return (data ?? []) as Record<string, unknown>[];
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await must().rpc(name, args);
    if (error) throw new Error(((error as { message?: string }).message ?? 'Something went wrong.').replace(/^[A-Z_]+: /, ''));
    return data;
  };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    list: () => loadRequests(must(), rows),
    reply: async (id, body, status) => { const r = await loadOne(await rpc('support_admin_reply', { p_request_id: id, p_body: body, p_status: status ?? null }), must(), rows); emit(); return r; },
    setStatus: async (id, status) => { const r = await loadOne(await rpc('support_admin_set_status', { p_request_id: id, p_status: status }), must(), rows); emit(); return r; },
    getBanner: async () => toBanner((await rows(must().from('support_status').select('*').limit(1)))[0]),
    setBanner: async (message, tone = 'info') => { const r = await rpc('support_admin_set_banner', { p_message: message ?? '', p_tone: tone }); emit(); return toBanner(r as Record<string, unknown>); },
    subscribe: (cb) => {
      listeners.add(cb);
      timer ??= setInterval(emit, 20_000); // new requests arrive from other people: look again every 20 seconds
      return () => { listeners.delete(cb); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
    },
  };
}

let cached: SupportAdminStore | null = null;
export function supportAdmin(): SupportAdminStore {
  return (cached ??= platform.mode === 'live' ? liveAdmin() : demoAdmin());
}
export type { SupportRequest };
