/**
 * Demo implementation of OnDemandStore. Lives in the studio's demo state under features.ondemand (persists, syncs across
 * tabs, resets with the demo). Seeded for Snowy (6 videos, a seeded "Online membership" product) and Harbour (4 videos).
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import { PERSONA_EMAILS } from '../../data/demo/seed';
import type { ID, Pass, Product, Studio } from '../../shared/types';
import type { DemoState } from '../../data/demo/engine';
import { bySortOrder, cleanVideo, hasOnlineAccess, toClientVideo } from './calc';
import type { AdminVideo, OnDemandStore } from './types';

interface Watch { clientId: ID; videoId: ID; count: number; at: string }
interface Slice { videos?: AdminVideo[]; productIds?: ID[]; watched?: Watch[] }
type Full = Required<Slice>;

function norm(raw: Slice): Full {
  raw.videos ??= [];
  raw.productIds ??= [];
  raw.watched ??= [];
  return raw as Full;
}

function fail(ctx: DemoFeatureContext, e: unknown): never {
  const m = /^([A-Z_]+): (.*)$/.exec(e instanceof Error ? e.message : '');
  throw m ? ctx.error(m[1]!, m[2]!) : e;
}

function create(ctx: DemoFeatureContext): OnDemandStore {
  const slice = () => norm(ctx.slice<Slice>());
  const sorted = () => [...slice().videos].sort(bySortOrder);
  const find = (id: ID) => {
    const v = slice().videos.find((x) => x.id === id);
    if (!v) throw ctx.error('NOT_FOUND', 'We couldn\'t find that video.');
    return v;
  };
  /** Does the signed-in person have the whole library? Clients through a flagged pass; owner and manager always. */
  const accessFor = (): { access: boolean; clientId: ID | null } => {
    const me = ctx.me();
    if (me.kind === 'client') {
      const passes: Pass[] = ctx.core().state.passes.filter((p) => p.clientId === me.clientId);
      return { access: hasOnlineAccess(passes, new Set(slice().productIds), ctx.now()), clientId: me.clientId };
    }
    ctx.requireStaff('ondemand.manage');
    return { access: true, clientId: null };
  };

  return {
    list: () => ctx.read(() => {
      const { access, clientId } = accessFor();
      const s = slice();
      const last = new Map(s.watched.filter((w) => w.clientId === clientId).map((w) => [w.videoId, w.at]));
      return { access, videos: sorted().filter((v) => v.published).map((v) => toClientVideo(v, access, last.get(v.id) ?? null)) };
    }),

    recordView: (videoId) => ctx.write(() => {
      const { access, clientId } = accessFor();
      const v = find(videoId);
      if (!v.published) throw ctx.error('NOT_FOUND', 'We couldn\'t find that video.');
      if (!(v.free || access)) throw ctx.error('LOCKED', 'Unlock this video with an Online membership.');
      if (!clientId) return; // staff previewing don't count
      const s = slice();
      const w = s.watched.find((x) => x.clientId === clientId && x.videoId === videoId);
      if (w) { w.count += 1; w.at = ctx.now().toISOString(); } else s.watched.push({ clientId, videoId, count: 1, at: ctx.now().toISOString() });
      v.views += 1;
    }),

    adminList: () => ctx.read(() => { ctx.requireStaff('ondemand.manage'); return sorted(); }),

    save: (input, id) => ctx.write(() => {
      ctx.requireStaff('ondemand.manage');
      let c;
      try { c = cleanVideo(input); } catch (e) { fail(ctx, e); }
      const s = slice();
      if (id) { const v = find(id); Object.assign(v, c); return { ...v }; }
      const v: AdminVideo = { id: ctx.newId('od'), ...c!, sortOrder: Math.max(0, ...s.videos.map((x) => x.sortOrder)) + 10, views: 0 };
      s.videos.push(v);
      return { ...v };
    }),

    setPublished: (id, published) => ctx.write(() => { ctx.requireStaff('ondemand.manage'); find(id).published = published; }),

    reorder: (ids) => ctx.write(() => {
      ctx.requireStaff('ondemand.manage');
      const s = slice();
      if (new Set(ids).size !== ids.length || ids.some((i) => !s.videos.some((v) => v.id === i))) throw ctx.error('INVALID', 'That order doesn\'t match the videos.');
      ids.forEach((i, n) => { find(i).sortOrder = (n + 1) * 10; });
    }),

    remove: (id) => ctx.write(() => {
      ctx.requireStaff('ondemand.manage');
      const s = slice();
      find(id);
      s.videos = s.videos.filter((v) => v.id !== id);
      s.watched = s.watched.filter((w) => w.videoId !== id);
    }),

    getSettings: () => ctx.read(() => { ctx.requireStaff('ondemand.manage'); return { productIds: [...slice().productIds] }; }),

    saveSettings: (settings) => ctx.write(() => {
      ctx.requireStaff('ondemand.manage');
      const known = new Set(ctx.core().state.products.map((p) => p.id));
      if (settings.productIds.some((p) => !known.has(p))) throw ctx.error('INVALID', 'One of those products no longer exists.');
      slice().productIds = [...new Set(settings.productIds)];
      return { productIds: [...slice().productIds] };
    }),
  };
}

// ---------------------------------------------------------------- seed
// Public sample files (Google's open sample bucket) and a public YouTube upload stand in for the studio's own videos.
const BUCKET = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/';
const MP4 = { a: BUCKET + 'BigBuckBunny.mp4', b: BUCKET + 'ElephantsDream.mp4', c: BUCKET + 'ForBiggerJoyrides.mp4', d: BUCKET + 'Sintel.mp4', e: BUCKET + 'ForBiggerBlazes.mp4' };
const YT = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

type Seed = Omit<AdminVideo, 'id' | 'sortOrder'>;
const SNOWY: Seed[] = [
  { title: 'Mums + Bubs: getting started', description: 'A gentle first session for new mums. Breathing, pelvic floor connection and easy mat work you can do with bub beside you. Start here.', instructor: 'Grace P', durationMin: 18, level: 'Postnatal', category: 'Mums + Bubs', thumbnailUrl: 'img/portrait.webp', videoUrl: MP4.a, published: true, free: true, views: 214 },
  { title: 'Core foundations', description: 'Slow, honest core work to find your deep abdominals again. Props optional.', instructor: 'Julia', durationMin: 25, level: 'All levels', category: 'Core', thumbnailUrl: 'img/julia.webp', videoUrl: MP4.b, published: true, free: false, views: 96 },
  { title: 'Morning stretch and reset', description: 'Wake up your spine, hips and shoulders before the day gets busy.', instructor: 'Libby', durationMin: 12, level: 'All levels', category: 'Stretch', thumbnailUrl: 'img/square.webp', videoUrl: YT, published: true, free: true, views: 158 },
  { title: 'Full body mat flow', description: 'A classic mat session with a little extra burn. Everything from the studio, at home.', instructor: 'Libby', durationMin: 40, level: 'Intermediate', category: 'Full body', thumbnailUrl: 'img/libby.webp', videoUrl: MP4.c, published: true, free: false, views: 71 },
  { title: 'Mums + Bubs: strong and steady', description: 'Rebuild strength through the back and hips with bub on the mat. A little more challenge than the intro.', instructor: 'Grace P', durationMin: 30, level: 'Postnatal', category: 'Mums + Bubs', thumbnailUrl: 'img/grace-p.webp', videoUrl: MP4.d, published: true, free: false, views: 63 },
  { title: 'Lower back release', description: 'Long, slow stretches for a tight lower back and hips. Perfect after a desk day.', instructor: 'Grace T', durationMin: 20, level: 'All levels', category: 'Stretch', thumbnailUrl: 'img/grace-t.webp', videoUrl: MP4.e, published: true, free: false, views: 49 },
];
const HARBOUR: Seed[] = [
  { title: 'Reformer-free foundations', description: 'Learn the shapes and the breath on the mat before you step onto the reformer.', instructor: 'Isla Moreau', durationMin: 22, level: 'Beginner', category: 'Core', thumbnailUrl: 'studios/harbour/foundations.webp', videoUrl: MP4.a, published: true, free: true, views: 120 },
  { title: 'Flow and lengthen', description: 'A continuous, calming sequence to lengthen through the whole body.', instructor: 'Ava Chen', durationMin: 30, level: 'All levels', category: 'Full body', thumbnailUrl: 'studios/harbour/flow.webp', videoUrl: MP4.b, published: true, free: false, views: 64 },
  { title: 'Jumpboard conditioning prep', description: 'Warm up the legs and glutes for jumpboard work with this mat primer.', instructor: 'Noah Price', durationMin: 18, level: 'Intermediate', category: 'Core', thumbnailUrl: 'studios/harbour/jumpboard.webp', videoUrl: MP4.c, published: true, free: false, views: 41 },
  { title: 'Evening wind-down stretch', description: 'Ten calm minutes to let the day go.', instructor: 'Isla Moreau', durationMin: 10, level: 'All levels', category: 'Stretch', thumbnailUrl: 'studios/harbour/hero.webp', videoUrl: MP4.d, published: true, free: false, views: 38 },
];

function seedSlice(studio: Studio, state: DemoState, now: Date, newId: (p: string) => ID): Full {
  const harbour = studio.slug === 'harbour';
  const list = harbour ? HARBOUR : studio.slug === 'snowy' ? SNOWY : [];
  const out: Full = { videos: list.map((v, i) => ({ ...v, id: newId('od'), sortOrder: (i + 1) * 10 })), productIds: [], watched: [] };
  if (harbour) {
    if (state.products.some((p) => p.id === 'hb_pr_mu')) out.productIds.push('hb_pr_mu');
  } else if (list.length) {
    // "Online membership": a monthly product that includes the library. Limited to a class type that has no sessions,
    // so it never gives studio class credits.
    if (!state.products.some((p) => p.id === 'pr_online')) {
      const online: Product = {
        id: 'pr_online', kind: 'membership', name: 'Online membership',
        description: 'The whole on-demand library, any time: Mums + Bubs, core, stretch and full body classes to do at home. Doesn\'t include studio classes.',
        priceCents: 1900, credits: null, validityDays: null, billingInterval: 'month', classTypeIds: ['ct_online'], active: true, sortOrder: 14, highlight: 'Online',
      };
      state.products.push(online);
    }
    out.productIds.push('pr_online', 'pr_mu'); // Unlimited studio members get the library too
    const hannah = state.clients.find((c) => c.email === PERSONA_EMAILS.member);
    if (hannah) {
      const free = out.videos.filter((v) => v.free);
      free.forEach((v, i) => out.watched.push({ clientId: hannah.id, videoId: v.id, count: 1, at: new Date(now.getTime() - (i + 1) * 26 * 3_600_000).toISOString() }));
    }
  }
  return out;
}

registerDemoFeature({
  name: 'ondemand',
  seed: ({ studio, state, now, newId }) => seedSlice(studio, state, now, newId),
  create,
});
