/**
 * Live (Supabase) IntegrationsStore: supabase/migrations/1700-1701_integrations_*.sql.
 * Partner API keys go to an RPC and into a table nobody can read: this store can send a key, never fetch one.
 * Settings and spots are read from RLS-protected tables, every change goes through an RPC.
 */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
import { PARTNERS, type Partner, type PartnerBooking, type PartnerSetting, type ReservedSpots } from './types';

const toPartner = (r: Record<string, unknown>): PartnerSetting => ({
  partner: String(r.partner) as Partner, enabled: r.enabled === true, partnerStudioId: String(r.partner_studio_id ?? ''), keySet: r.key_set === true,
});

registerLiveFeature({
  name: 'integrations',
  create: (ctx) => ({
    listPartners: () => ctx.read(async () => {
      const rows = ((await ctx.rpc('integrations_list_partners')) ?? []) as Record<string, unknown>[];
      return PARTNERS.map((p) => toPartner(rows.find((r) => r.partner === p) ?? { partner: p }));
    }),
    savePartner: (partner, patch) => ctx.write(async () => toPartner((await ctx.rpc('integrations_save_partner', {
      p_partner: partner, p_enabled: patch.enabled ?? null, p_partner_studio_id: patch.partnerStudioId ?? null, p_api_key: patch.apiKey ?? null,
    })) as Record<string, unknown>)),
    listReserved: () => ctx.read(async (): Promise<ReservedSpots[]> =>
      (await ctx.rows(ctx.sb.from('integrations_reserved').select('class_type_id, partner, spots'))).map((r) => ({ classTypeId: String(r.class_type_id), partner: String(r.partner) as Partner, spots: Number(r.spots) }))),
    setReserved: (classTypeId, partner, spots) => ctx.write(async () => { await ctx.rpc('integrations_set_reserved', { p_class_type_id: classTypeId, p_partner: partner, p_spots: spots }); }),
    partnerBookings: (sessionId) => ctx.read(async (): Promise<PartnerBooking[]> =>
      (await ctx.rows(ctx.sb.from('integrations_partner_bookings').select('*').eq('session_id', sessionId))).map((r) => ({
        bookingId: String(r.booking_id), sessionId: String(r.session_id), source: String(r.source) as Partner, partnerBookingId: String(r.partner_booking_id),
        memberName: String(r.member_name ?? ''), createdAt: String(r.created_at),
      }))),
  }),
});
