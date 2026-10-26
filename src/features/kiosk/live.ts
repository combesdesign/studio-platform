/** Live (Supabase) KioskStore. The PIN is hashed in the database and never sent back: supabase/migrations/1500_kiosk_pin.sql. */
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';

registerLiveFeature({
  name: 'kiosk',
  create: (ctx) => ({
    hasPin: () => ctx.read(async () => (await ctx.rpc('kiosk_has_pin')) === true),
    setPin: (pin) => ctx.write(async () => { await ctx.rpc('kiosk_set_pin', { p_pin: pin }); }),
    checkPin: (pin) => ctx.read(async () => (await ctx.rpc('kiosk_check_pin', { p_pin: pin })) === true),
  }),
});
