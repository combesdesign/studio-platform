/**
 * Demo implementation of SupportStore. The data lives in demoDb (one shared list, so the admin inbox sees every studio),
 * not in the studio's demo state. Seeded for Snowy and Harbour.
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import { can } from '../../domain/permissions';
import { cleanBody, cleanScreenshot, statusAfter } from './calc';
import { demoDb, ensureSeed, msg } from './demoDb';
import type { SupportRequest, SupportStore } from './types';

function fail(ctx: DemoFeatureContext, e: unknown): never {
  const m = /^([A-Z_]+): (.*)$/.exec(e instanceof Error ? e.message : '');
  throw m ? ctx.error(m[1]!, m[2]!) : e;
}

function create(ctx: DemoFeatureContext): SupportStore {
  const seed = () => {
    const st = ctx.studio();
    ensureSeed([{ studioId: st.id, studioName: st.name, slug: st.slug }], () => ctx.core().state.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, role: s.role })), ctx.now());
  };
  const mine = (r: SupportRequest, staff: { id: string; name: string; role: SupportRequest['staffRole'] }) =>
    r.studioId === ctx.studioId && (can(staff.role, 'support.all') || (r.staffId ? r.staffId === staff.id : r.staffName === staff.name));

  return {
    send: (input) => ctx.write(() => {
      const staff = ctx.requireStaff('support.use');
      let body: string, screenshot: string | null;
      try { body = cleanBody(input.body); screenshot = cleanScreenshot(input.screenshot); } catch (e) { fail(ctx, e); }
      seed();
      const now = ctx.now();
      const r: SupportRequest = {
        id: ctx.newId('sr'), studioId: ctx.studioId, studioName: ctx.studio().name, staffId: staff.id, staffName: staff.name, staffRole: staff.role, body,
        urgent: !!input.urgent, status: 'open', context: { route: input.context.route.slice(0, 300), appVersion: input.context.appVersion.slice(0, 40), userAgent: input.context.userAgent.slice(0, 400) },
        screenshot, replyBy: input.urgent ? null : input.replyBy, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        messages: [msg('studio', staff.name, body, now)],
      };
      demoDb.write((db) => { db.requests.push(r); });
      return r;
    }),

    listMine: () => ctx.read(() => {
      const staff = ctx.requireStaff('support.use');
      seed();
      return demoDb.read((db) => db.requests.filter((r) => mine(r, staff)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    }),

    follow: (requestId, text) => ctx.write(() => {
      const staff = ctx.requireStaff('support.use');
      let body: string;
      try { body = cleanBody(text); } catch (e) { fail(ctx, e); }
      return demoDb.write((db) => {
        const r = db.requests.find((x) => x.id === requestId);
        if (!r || !mine(r, staff)) throw ctx.error('NOT_FOUND', 'We couldn\'t find that request.');
        const now = ctx.now();
        r.messages.push(msg('studio', staff.name, body, now));
        r.status = statusAfter('studio');
        r.updatedAt = now.toISOString();
        return { ...r };
      });
    }),

    banner: () => ctx.read(() => demoDb.read((db) => db.banner)),
  };
}

registerDemoFeature({ name: 'support', create });
