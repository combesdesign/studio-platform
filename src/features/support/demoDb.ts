/**
 * Demo data for support. Unlike other features it is NOT kept in a studio's demo state: the platform admin inbox
 * reads every studio's requests at once, so the demo keeps one shared list in localStorage (same browser, so the
 * studio app and /admin/ see each other). Outside a browser (tests) it falls back to memory.
 */
import { replyBy } from './hours';
import type { SupportBanner, SupportMessage, SupportRequest } from './types';

const KEY = 'spc-support-demo-v1';
interface Db { requests: SupportRequest[]; banner: SupportBanner | null; seeded: string[] }

let memory: Db | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
function load(): Db {
  const s = storage();
  if (!s) return (memory ??= { requests: [], banner: null, seeded: [] });
  try {
    const raw = s.getItem(KEY);
    if (raw) { const d = JSON.parse(raw) as Db; return { requests: d.requests ?? [], banner: d.banner ?? null, seeded: d.seeded ?? [] }; }
  } catch { /* corrupt: start again */ }
  return { requests: [], banner: null, seeded: [] };
}
function save(db: Db): void {
  const s = storage();
  if (!s) { memory = db; } else { try { s.setItem(KEY, JSON.stringify(db)); } catch { /* storage full or blocked: keep going */ } }
  for (const l of [...listeners]) { try { l(); } catch (e) { console.error(e); } }
}

export const demoDb = {
  read<T>(fn: (db: Db) => T): T { return fn(load()); },
  write<T>(fn: (db: Db) => T): T { const db = load(); const out = fn(db); save(db); return out; },
  /** Fires on changes here and in other tabs. */
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(); };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => { listeners.delete(cb); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
  },
  /** Test helper. */
  reset() { memory = null; storage()?.removeItem(KEY); },
};

let nid = 0;
export const newDemoId = (p: string) => `${p}_${Date.now().toString(36)}${(++nid).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function msg(from: SupportMessage['from'], author: string, body: string, at: Date): SupportMessage {
  return { id: newDemoId('sm'), from, author, body, at: at.toISOString() };
}

// ---------------------------------------------------------------- seed
interface Seed { studioId: string; studioName: string; slug: string }
type StaffRef = { id: string; name: string; role: SupportRequest['staffRole'] };

const MIN = 60_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** A few believable requests for each demo studio, once per studio. Pass the studio's staff when you have them so "My requests" lines up. */
export function ensureSeed(studios: Seed[], staffOf: (studioId: string) => StaffRef[] = () => [], now = new Date()): void {
  const todo = studios.filter((s) => !load().seeded.includes(s.studioId) && (s.slug === 'snowy' || s.slug === 'harbour'));
  if (!todo.length) return;
  demoDb.write((db) => {
    for (const s of todo) {
      db.seeded.push(s.studioId);
      const staff = staffOf(s.studioId);
      const by = (role: StaffRef['role'], name: string): StaffRef => staff.find((x) => x.role === role) ?? { id: '', name, role };
      const ago = (m: number) => new Date(now.getTime() - m * MIN);
      const mk = (who: StaffRef, body: string, o: { urgent?: boolean; minsAgo: number; route: string; status?: SupportRequest['status']; replies?: [number, string][]; ua?: string }): SupportRequest => {
        const at = ago(o.minsAgo);
        const r: SupportRequest = {
          id: newDemoId('sr'), studioId: s.studioId, studioName: s.studioName, staffId: who.id || null, staffName: who.name, staffRole: who.role, body,
          urgent: !!o.urgent, status: o.status ?? 'open', context: { route: o.route, appVersion: '0.1.0', userAgent: o.ua ?? UA }, screenshot: null,
          replyBy: o.urgent ? null : replyBy(at).toISOString(), createdAt: at.toISOString(), updatedAt: at.toISOString(),
          messages: [msg('studio', who.name, body, at)],
        };
        for (const [m, text] of o.replies ?? []) { const t = ago(m); r.messages.push(msg('platform', 'Pete', text, t)); r.updatedAt = t.toISOString(); }
        return r;
      };
      if (s.slug === 'snowy') {
        db.requests.push(
          mk(by('front_desk', 'Fran'), 'Clients are getting an error when they try to pay for a class pack in the app. Two have rung me in the last ten minutes.', { urgent: true, minsAgo: 14, route: '#/pos', ua: UA_PHONE }),
          mk(by('owner', 'Libby'), 'How do I stop a pass from expiring over the Christmas break? Lots of my regulars will be away.', { minsAgo: 190, route: '#/clients', status: 'waiting', replies: [[140, 'Hi Libby, easiest way is to extend the expiry on each pass: open the client, tap the pass, then Adjust. If you want, I can extend every active pass in one go. Just say the date.']] }),
          mk(by('manager', 'Mia'), 'The kiosk keeps asking for the PIN twice after a client checks in.', { minsAgo: 1500, route: '#/kiosk', status: 'resolved', replies: [[1440, 'Thanks Mia, that was a bug on our end. Fixed now, so please refresh the tablet and let me know if it comes back.']] }),
        );
      } else {
        db.requests.push(
          mk(by('owner', 'Hank'), 'Can we put our own logo on the receipts? It shows the platform one at the moment.', { minsAgo: 70, route: '#/settings/branding' }),
        );
      }
    }
  });
}
