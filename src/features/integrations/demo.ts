/**
 * Demo implementation of IntegrationsStore. Lives in the studio's demo state under features.integrations, so it
 * persists, syncs across tabs and resets with the demo. Seeded for each built-in studio: one partner switched on, spots
 * held for it, and a few partner bookings on upcoming classes.
 *
 * A partner booking is a real booking in the studio's demo bookings (status 'booked', no pass used) for a "partner
 * client" (an ordinary client row), plus a note here saying which partner it came from. API keys are never kept: the
 * demo only remembers that one was entered (live keeps it server-side, write-only).
 */
import './permissions';
import { registerDemoFeature, type DemoFeatureContext } from '../../data/demo/features';
import type { DemoState } from '../../data/demo/engine';
import type { ID, Studio } from '../../shared/types';
import { heldFor, partnerBookError } from './partners';
import { PARTNERS, PARTNER_LABEL, type Partner, type PartnerBooking, type PartnerSetting, type ReservedSpots, type IntegrationsStore } from './types';

interface Member { partner: Partner; memberRef: string; clientId: ID }
interface Slice {
  partners?: PartnerSetting[];
  reserved?: ReservedSpots[];
  bookings?: PartnerBooking[];
  members?: Member[];
}
type Full = Required<Slice>;

function norm(raw: Slice): Full {
  raw.partners ??= [];
  for (const p of PARTNERS) if (!raw.partners.some((x) => x.partner === p)) raw.partners.push({ partner: p, enabled: false, partnerStudioId: '', keySet: false });
  raw.reserved ??= [];
  raw.bookings ??= [];
  raw.members ??= [];
  return raw as Full;
}

const partnerOf = (s: Full, p: Partner) => s.partners.find((x) => x.partner === p)!;

/** Make the partner client and book them, the way integrations_partner_book does in the database. */
function bookPartner(ctx: DemoFeatureContext, s: Full, partner: Partner, sessionId: ID, memberName: string, nextRef: () => string): PartnerBooking {
  const { state, engine } = ctx.core();
  const cfg = partnerOf(s, partner);
  if (!cfg.enabled) throw ctx.error('NOT_FOUND', 'No studio has that partner switched on.');
  const se = state.sessions.find((x) => x.id === sessionId);
  if (!se) throw ctx.error('NOT_FOUND', 'We couldn’t find that class.');
  const booked = state.bookings.filter((b) => b.sessionId === se.id && (b.status === 'booked' || b.status === 'checked_in'));
  const err = partnerBookError({
    capacity: se.capacity, booked: booked.length, held: heldFor(s.reserved, se.classTypeId, partner),
    used: booked.filter((b) => s.bookings.some((pb) => pb.bookingId === b.id && pb.source === partner)).length,
    cancelled: se.status === 'cancelled', started: Date.parse(se.startsAt) <= ctx.now().getTime(),
  });
  if (err) throw ctx.error(err.code, err.message);
  const [first, ...rest] = memberName.trim().split(/\s+/);
  const ref = nextRef();
  const clientId = ctx.newId('cl');
  engine.addClient({
    id: clientId, firstName: first || PARTNER_LABEL[partner], lastName: rest.join(' ') || 'member', email: partnerEmail(partner, ref), createdAt: ctx.now().toISOString(),
    marketingOptIn: false, source: 'import', staffNotes: `${PARTNER_LABEL[partner]} member. Booked through the partner, so no pass is used.`,
  });
  s.members.push({ partner, memberRef: ref, clientId });
  const bookingId = ctx.newId('bk');
  engine.addBooking({ id: bookingId, sessionId: se.id, clientId, status: 'booked', createdAt: ctx.now().toISOString(), source: 'staff' });
  const pb: PartnerBooking = { bookingId, sessionId: se.id, source: partner, partnerBookingId: `${partner.slice(0, 2).toUpperCase()}-${ref}`, memberName: memberName.trim(), createdAt: ctx.now().toISOString() };
  s.bookings.push(pb);
  return pb;
}

/** A made-up, undeliverable address that is unique per member (live leaves the email empty so nothing is ever sent to a partner member). */
const partnerEmail = (partner: Partner, ref: string) => `${partner}.${ref}@partner.invalid`;

function create(ctx: DemoFeatureContext): IntegrationsStore {
  const slice = () => norm(ctx.slice<Slice>());
  const nextRef = () => String(10000 + Math.floor(Math.random() * 89999));
  return {
    listPartners: () => ctx.read(() => { ctx.requireStaff('integrations.manage'); return slice().partners.map((p) => ({ ...p })); }),

    savePartner: (partner, patch) => ctx.write(() => {
      ctx.requireStaff('integrations.manage');
      if (patch.apiKey !== undefined) ctx.requireStaff('integrations.keys');
      if (!PARTNERS.includes(partner)) throw ctx.error('INVALID', 'Choose ClassPass or Gympass.');
      const s = slice();
      const cur = partnerOf(s, partner);
      const id = patch.partnerStudioId === undefined ? cur.partnerStudioId : patch.partnerStudioId.trim();
      if (id.length > 80) throw ctx.error('INVALID', 'That ID is too long.');
      if (id && s.partners.some((p) => p.partner === partner && p !== cur && p.partnerStudioId === id)) throw ctx.error('INVALID', 'That ID is already linked to another studio.');
      const enabled = patch.enabled ?? cur.enabled;
      if (enabled && !id) throw ctx.error('INVALID', 'Add your partner ID before switching this on.');
      if (patch.apiKey !== undefined && patch.apiKey.trim().length > 400) throw ctx.error('INVALID', 'That key is too long.');
      cur.enabled = enabled; cur.partnerStudioId = id;
      if (patch.apiKey !== undefined) cur.keySet = patch.apiKey.trim() !== ''; // the key itself is dropped, on purpose
      return { ...cur };
    }),

    listReserved: () => ctx.read(() => { ctx.requireStaff('integrations.view'); return slice().reserved.map((r) => ({ ...r })); }),

    setReserved: (classTypeId, partner, spots) => ctx.write(() => {
      ctx.requireStaff('integrations.manage');
      if (!PARTNERS.includes(partner)) throw ctx.error('INVALID', 'Choose ClassPass or Gympass.');
      if (!Number.isInteger(spots) || spots < 0 || spots > 200) throw ctx.error('INVALID', 'Spots can be 0 to 200.');
      if (!ctx.core().state.classTypes.some((c) => c.id === classTypeId)) throw ctx.error('NOT_FOUND', 'We couldn’t find that class type.');
      const s = slice();
      s.reserved = s.reserved.filter((r) => !(r.classTypeId === classTypeId && r.partner === partner));
      if (spots > 0) s.reserved.push({ classTypeId, partner, spots });
    }),

    partnerBookings: (sessionId) => ctx.read(() => { ctx.requireStaff('integrations.view'); return slice().bookings.filter((b) => b.sessionId === sessionId); }),

    demoPartnerBook: (partner, sessionId, memberName) => ctx.write(() => {
      ctx.requireStaff('integrations.manage');
      const names = ['Maya Singh', 'Tom Alvarez', 'Keira Brooks', 'Ben Cho', 'Nina Park'];
      const s = slice();
      return bookPartner(ctx, s, partner, sessionId, memberName?.trim() || names[s.bookings.length % names.length]!, nextRef);
    }),

  };
}

// ---------------------------------------------------------------- seed
function seedSlice(studio: Studio, state: DemoState, now: Date, newId: (p: string) => ID): Full {
  const harbour = studio.slug === 'harbour';
  const partner: Partner = harbour ? 'gympass' : 'classpass';
  const out: Full = norm({});
  const cfg = partnerOf(out, partner);
  cfg.enabled = true; cfg.partnerStudioId = harbour ? 'GP-90711' : 'CP-48213'; cfg.keySet = true;
  // hold spots in the first two bookable class types
  const types = state.classTypes.filter((c) => c.bookable && c.active).slice(0, 2);
  types.forEach((t, i) => out.reserved.push({ classTypeId: t.id, partner, spots: i === 0 ? 2 : 1 }));
  // a few partner bookings on the next classes of the first type
  const names = harbour ? ['Tom Alvarez', 'Keira Brooks', 'Ben Cho'] : ['Maya Singh', 'Nina Park', 'Ben Cho'];
  const upcoming = state.sessions.filter((x) => x.classTypeId === types[0]?.id && x.status === 'scheduled' && Date.parse(x.startsAt) > now.getTime()).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  let n = 0;
  for (const se of upcoming.slice(0, 3)) {
    const booked = state.bookings.filter((b) => b.sessionId === se.id && (b.status === 'booked' || b.status === 'checked_in')).length;
    if (booked >= se.capacity) continue;
    const memberName = names[n % names.length]!;
    const [first, ...rest] = memberName.split(' ');
    const ref = String(harbour ? 30000 + n * 211 : 20000 + n * 137);
    const clientId = newId(`cl_${studio.slug}`);
    state.clients.push({ id: clientId, firstName: first!, lastName: rest.join(' '), email: partnerEmail(partner, ref), createdAt: now.toISOString(), marketingOptIn: false, source: 'import', staffNotes: `${PARTNER_LABEL[partner]} member. Booked through the partner, so no pass is used.` });
    out.members.push({ partner, memberRef: ref, clientId });
    const bookingId = newId(`bk_${studio.slug}`);
    state.bookings.push({ id: bookingId, sessionId: se.id, clientId, status: 'booked', createdAt: new Date(now.getTime() - 3_600_000).toISOString(), source: 'staff' });
    out.bookings.push({ bookingId, sessionId: se.id, source: partner, partnerBookingId: `${partner.slice(0, 2).toUpperCase()}-${ref}`, memberName, createdAt: new Date(now.getTime() - 3_600_000).toISOString() });
    n++;
  }
  return out;
}

registerDemoFeature({
  name: 'integrations',
  seed: ({ studio, state, now, newId }) => seedSlice(studio, state, now, newId),
  create,
});
