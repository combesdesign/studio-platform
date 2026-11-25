/**
 * Demo implementation of NoticesStore. Notices live in the studio's demo state under features.notices (persisted, synced across tabs,
 * reset with the demo). Each built-in studio is seeded with one example notice.
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import { studioDate } from '../../shared/format';
import type { ISODateTime } from '../../shared/types';
import { cleanNotice, isActive, sortNotices } from './calc';
import type { Notice, NoticesStore } from './types';

interface Slice { notices?: Notice[] }

function create(ctx: DemoFeatureContext): NoticesStore {
  const list = () => (ctx.slice<Slice>().notices ??= []);
  const today = () => studioDate(ctx.now());
  const nowIso = () => ctx.now().toISOString() as ISODateTime;
  const find = (id: string) => {
    const n = list().find((x) => x.id === id);
    if (!n) throw ctx.error('NOT_FOUND', 'We couldn’t find that notice.');
    return n;
  };
  return {
    listActive: () => ctx.read(() => { ctx.me(); return sortNotices(list().filter((n) => isActive(n, today()))); }),
    listAll: () => ctx.read(() => { ctx.requireStaff('notices.manage'); return sortNotices(list()); }),
    save: (input) => ctx.write(() => {
      ctx.requireStaff('notices.manage');
      const c = cleanNotice(input, today());
      if (!c.ok) throw ctx.error('INVALID', c.problem);
      const v = c.value;
      if (input.id) {
        const n = find(input.id);
        n.title = v.title; n.body = v.body; n.pinned = v.pinned; n.updatedAt = nowIso();
        if (v.linkUrl) n.linkUrl = v.linkUrl; else delete n.linkUrl;
        if (v.showUntil) n.showUntil = v.showUntil; else delete n.showUntil;
        return n;
      }
      const n: Notice = { id: ctx.newId('nt'), title: v.title, body: v.body, pinned: v.pinned, createdAt: nowIso(), updatedAt: nowIso(), ...(v.linkUrl ? { linkUrl: v.linkUrl } : {}), ...(v.showUntil ? { showUntil: v.showUntil } : {}) };
      list().push(n);
      return n;
    }),
    setPinned: (id, pinned) => ctx.write(() => { ctx.requireStaff('notices.manage'); const n = find(id); n.pinned = pinned; n.updatedAt = nowIso(); return n; }),
    remove: (id) => ctx.write(() => { ctx.requireStaff('notices.manage'); find(id); const s = ctx.slice<Slice>(); s.notices = list().filter((n) => n.id !== id); }),
  };
}

registerDemoFeature({
  name: 'notices',
  seed: ({ now, newId }: { now: Date; newId: (p: string) => string }): Slice => ({
    notices: [{
      id: newId('nt'), title: 'Bring a friend week', pinned: false,
      body: 'Bring a friend to any class this week and they join in for free. Just let the front desk know when you arrive.',
      createdAt: new Date(now.getTime() - 86_400_000).toISOString() as ISODateTime, updatedAt: new Date(now.getTime() - 86_400_000).toISOString() as ISODateTime,
    }],
  }),
  create,
});
