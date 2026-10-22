/**
 * Demo implementation of KioskStore. The exit PIN lives in the studio's demo state under features.kiosk (so it
 * persists, syncs across tabs and resets with the demo). It's a demo, so it's kept as typed; live hashes it.
 */
import './permissions';
import { registerDemoFeature } from '../../data/demo/features';
import { isPin } from './logic';

interface Slice { pin?: string }

registerDemoFeature({
  name: 'kiosk',
  create: (ctx) => ({
    hasPin: () => ctx.read(() => { ctx.requireStaff('kiosk.use'); return !!ctx.slice<Slice>().pin; }),
    setPin: (pin) => ctx.write(() => {
      ctx.requireStaff('kiosk.manage');
      const s = ctx.slice<Slice>();
      if (pin === null) { delete s.pin; return; }
      if (!isPin(pin)) throw ctx.error('INVALID', 'The PIN is 4 numbers.');
      s.pin = pin;
    }),
    checkPin: (pin) => ctx.read(() => { ctx.requireStaff('kiosk.use'); const p = ctx.slice<Slice>().pin; return !!p && p === pin; }),
  }),
});
