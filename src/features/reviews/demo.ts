/**
 * Demo implementation of ReviewsStore. Everything lives in the studio's demo state under features.reviews, so it
 * persists, syncs across tabs and resets with the demo. Seeded for each built-in studio (Snowy and Harbour): reviews
 * for most past checked-in classes, with each client's latest class left unreviewed so the "How was…?" card shows.
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import type { DemoState } from '../../data/demo/engine';
import { can } from '../../domain/permissions';
import type { ID, ISODateTime, Studio } from '../../shared/types';
import { DEFAULT_ASK_EVERY, HAPPY_NPS, PROMPT_DAYS, byNewest, cleanAskEvery, cleanGoogleUrl, cleanReview } from './calc';
import type { ReviewEntry, ReviewPrompt, ReviewsSettings, ReviewsStore } from './types';

interface Entry extends ReviewEntry { clientId: ID }
interface Slice { entries?: Entry[]; dismissed?: ID[]; settings?: ReviewsSettings }
type Full = Required<Slice>;

function norm(raw: Slice): Full {
  raw.entries ??= [];
  raw.dismissed ??= [];
  raw.settings ??= { googleReviewUrl: '', googleAskEnabled: false, googleAskEvery: DEFAULT_ASK_EVERY };
  raw.settings.googleAskEnabled ??= false;
  raw.settings.googleAskEvery ??= DEFAULT_ASK_EVERY;
  return raw as Full;
}

const DAY = 86_400_000;

function fail(ctx: DemoFeatureContext, e: unknown): never {
  const m = /^([A-Z_]+): (.*)$/.exec(e instanceof Error ? e.message : '');
  throw m ? ctx.error(m[1]!, m[2]!) : e;
}

function create(ctx: DemoFeatureContext): ReviewsStore {
  const slice = () => norm(ctx.slice<Slice>());
  const clientId = () => {
    const me = ctx.me();
    if (me.kind !== 'client') throw ctx.error('NOT_ALLOWED', 'Only clients can review a class.');
    return me.clientId;
  };

  return {
    pendingPrompt: () => ctx.read((): ReviewPrompt | null => {
      const cid = clientId();
      const s = slice();
      const { state } = ctx.core();
      const now = ctx.now().getTime();
      const done = new Set([...s.entries.map((e) => e.bookingId), ...s.dismissed]);
      let best: ReviewPrompt | null = null;
      for (const b of state.bookings) {
        if (b.clientId !== cid || b.status !== 'checked_in' || done.has(b.id)) continue;
        const se = state.sessions.find((x) => x.id === b.sessionId);
        if (!se || Date.parse(se.endsAt) > now || now - Date.parse(se.endsAt) > PROMPT_DAYS * DAY) continue;
        if (best && Date.parse(best.startsAt) >= Date.parse(se.startsAt)) continue;
        best = {
          bookingId: b.id, sessionId: se.id, classTypeId: se.classTypeId, className: state.classTypes.find((c) => c.id === se.classTypeId)?.name ?? 'class',
          instructorId: se.instructorId, instructorName: state.staff.find((x) => x.id === se.instructorId)?.name ?? '', startsAt: se.startsAt,
        };
      }
      return best;
    }),

    submit: (bookingId, input) => ctx.write(() => {
      const cid = clientId();
      const s = slice();
      const { state } = ctx.core();
      const b = state.bookings.find((x) => x.id === bookingId && x.clientId === cid);
      if (!b || b.status !== 'checked_in') throw ctx.error('NOT_FOUND', 'You can rate a class once you\'ve been checked in.');
      if (s.entries.some((e) => e.bookingId === b.id) || s.dismissed.includes(b.id)) throw ctx.error('ALREADY_REVIEWED', 'You\'ve already answered for this class.');
      let c;
      try { c = cleanReview(input); } catch (e) { fail(ctx, e); }
      const se = state.sessions.find((x) => x.id === b.sessionId)!;
      const client = state.clients.find((x) => x.id === cid);
      s.entries.push({
        id: ctx.newId('rv'), bookingId: b.id, sessionId: se.id, classTypeId: se.classTypeId, instructorId: se.instructorId, clientId: cid,
        clientFirstName: client?.firstName ?? '', rating: c.rating, nps: c.nps, comment: c.comment, createdAt: ctx.now().toISOString(),
      });
      const url = s.settings.googleReviewUrl;
      return url && c.nps !== null && c.nps >= HAPPY_NPS ? { googleUrl: url } : {};
    }),

    dismiss: (bookingId) => ctx.write(() => {
      const cid = clientId();
      const s = slice();
      const b = ctx.core().state.bookings.find((x) => x.id === bookingId && x.clientId === cid);
      if (!b) throw ctx.error('NOT_FOUND', 'We couldn\'t find that class.');
      if (!s.entries.some((e) => e.bookingId === b.id) && !s.dismissed.includes(b.id)) s.dismissed.push(b.id);
    }),

    list: () => ctx.read(() => {
      const staff = ctx.requireStaff('reviews.view');
      const all = can(staff.role, 'reviews.all');
      return slice().entries
        .filter((e) => all || e.instructorId === staff.id)
        .map(({ clientId: _c, ...e }): ReviewEntry => e)
        .sort(byNewest);
    }),

    getSettings: () => ctx.read(() => { ctx.requireStaff('reviews.view'); return { ...slice().settings }; }),

    saveSettings: (patch) => ctx.write(() => {
      ctx.requireStaff('reviews.manage');
      const s = slice();
      if (patch.googleReviewUrl !== undefined) {
        try { s.settings.googleReviewUrl = cleanGoogleUrl(patch.googleReviewUrl); } catch (e) { fail(ctx, e); }
      }
      if (patch.googleAskEvery !== undefined) {
        try { s.settings.googleAskEvery = cleanAskEvery(patch.googleAskEvery); } catch (e) { fail(ctx, e); }
      }
      if (patch.googleAskEnabled !== undefined) {
        if (patch.googleAskEnabled && !s.settings.googleReviewUrl) throw ctx.error('INVALID', 'Add your Google review link first.');
        s.settings.googleAskEnabled = patch.googleAskEnabled;
      }
      if (!s.settings.googleReviewUrl) s.settings.googleAskEnabled = false;   // no link, no ask
      return { ...s.settings };
    }),
  };
}

// ---------------------------------------------------------------- seed
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

const COMMENTS: Record<'snowy' | 'harbour', Record<'hi' | 'mid' | 'lo', string[]>> = {
  snowy: {
    hi: ['Such a lovely class. I felt so much better afterwards.', 'Best way to start the morning.', 'Clear instructions and a really friendly room.', 'Loved the pace. My back feels great.', 'The studio feels like home.'],
    mid: ['Good class, a touch crowded for my liking.', 'Nice session. I would love a slightly longer cool down.'],
    lo: ['A bit rushed this week and I struggled to hear the cues.'],
  },
  harbour: {
    hi: ['Brilliant reformer session, challenging in the best way.', 'Spring changes were spot on for me.', 'Calm room, great music, wonderful teacher.', 'Left feeling strong and stretched.'],
    mid: ['Good workout. The room was warm by the end.', 'Enjoyed it, would like more notice when the springs change.'],
    lo: ['The class started late and ran short.'],
  },
};

function seedSlice(studio: Studio, state: DemoState, now: Date, newId: (p: string) => ID): Full {
  const key = studio.slug === 'harbour' ? 'harbour' : 'snowy';
  const out: Full = { entries: [], dismissed: [], settings: { googleReviewUrl: '', googleAskEnabled: false, googleAskEvery: DEFAULT_ASK_EVERY } };
  const nowMs = now.getTime();
  const sessionById = new Map(state.sessions.map((x) => [x.id, x]));
  // every client's most recent finished checked-in class is left for the "How was…?" card
  const latest = new Map<ID, { id: ID; at: number }>();
  const past = state.bookings.flatMap((b) => {
    const se = sessionById.get(b.sessionId);
    if (b.status !== 'checked_in' || !se || se.status !== 'scheduled' || Date.parse(se.endsAt) > nowMs) return [];
    const l = latest.get(b.clientId);
    if (!l || l.at < Date.parse(se.startsAt)) latest.set(b.clientId, { id: b.id, at: Date.parse(se.startsAt) });
    return [{ b, se }];
  });
  for (const { b, se } of past) {
    if (latest.get(b.clientId)?.id === b.id) continue;
    const h = hash(b.id + studio.slug);
    if (h % 10 < 3) continue; // about 70% answer
    const rating = [5, 5, 5, 5, 5, 4, 4, 4, 3, 2][(h >>> 4) % 10]!;
    const nps = (h >>> 9) % 6 === 0 ? null : rating === 5 ? 9 + ((h >>> 12) % 2) : rating === 4 ? 7 + ((h >>> 12) % 3) : rating === 3 ? 6 + ((h >>> 12) % 2) : 3 + ((h >>> 12) % 3);
    const pool = COMMENTS[key][rating >= 4 ? 'hi' : rating === 3 ? 'mid' : 'lo'];
    const comment = (h >>> 15) % 5 < 2 ? pool[(h >>> 18) % pool.length]! : null;
    const client = state.clients.find((x) => x.id === b.clientId);
    out.entries.push({
      id: newId('rv'), bookingId: b.id, sessionId: se.id, classTypeId: se.classTypeId, instructorId: se.instructorId, clientId: b.clientId,
      clientFirstName: client?.firstName ?? '', rating, nps, comment, createdAt: new Date(Date.parse(se.endsAt) + (10 + (h % 600)) * 60_000).toISOString() as ISODateTime,
    });
  }
  return out;
}

registerDemoFeature({
  name: 'reviews',
  seed: ({ studio, state, now, newId }) => seedSlice(studio, state, now, newId),
  create,
});
