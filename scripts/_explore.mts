import { createDemoPlatform, memoryStorage } from '../src/data/demo';
import { periodFor, shiftPeriod } from '../src/features/payroll/calc';
const NOW = new Date('2026-10-15T01:30:00Z'); // Thursday 12:30 Sydney
const p = createDemoPlatform({ now: () => NOW, latencyMs: 0, storage: memoryStorage(), app: 'studio' });
for (const slug of ['snowy', 'harbour']) {
  const studio = (await p.findStudio({ slug }))!;
  const s = p.forStudio(studio);
  const owner = (await s.demoPersonas()).find((u) => u.kind === 'staff' && u.role === 'owner')!;
  await s.demoSignInAs!(owner);
  const pr = s.features.payroll!;
  const set = await pr.getSettings();
  console.log(slug, set);
  const cur = periodFor('2026-10-15', set);
  for (const per of [shiftPeriod(cur, -2), shiftPeriod(cur, -1), cur]) {
    const v = await pr.getPayPeriod(per);
    console.log(per, v.status, 'total', v.totalCents / 100, 'pending', v.pendingEntries);
    for (const sp of v.staff) console.log('  ', sp.name, sp.classCount, 'classes', sp.attendees, 'att', (sp.totalCents/100), sp.warnings, sp.lines.map(l => `${l.earningsRate} ${l.units}x${l.rateCents/100}=${l.amountCents/100}`));
  }
  const cov = await pr.listCover();
  console.log(cov.map((c) => `${c.status} ${c.session.startsAt} by ${c.requestedBy} claimed ${c.claimedBy} reason ${c.reason}`));
  console.log(await pr.exportCsv(shiftPeriod(cur, -1)));
}
