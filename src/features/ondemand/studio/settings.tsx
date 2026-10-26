/** Settings › Online classes: which products include online access. */
import React, { useEffect, useState } from 'react';
import { money } from '../../../shared/format';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { Loading } from '../../../studio/ui';

export function OnDemandSettingsTab() {
  const toast = useToast();
  const od = store.features.ondemand;
  const cur = useData(async () => (od ? od.getSettings() : { productIds: [] as string[] }), []);
  const products = useData(() => store.listProducts({ includeInactive: false }), []);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data) setIds(cur.data.productIds); }, [cur.data]);
  if (!od) return null;
  if (!cur.data || !products.data) return <Loading />;
  const list = products.data.filter((p) => p.kind !== 'retail').sort((a, b) => a.sortOrder - b.sortOrder);
  const dirty = [...ids].sort().join() !== [...cur.data.productIds].sort().join();
  const toggle = (id: string) => setIds((x) => (x.includes(id) ? x.filter((i) => i !== id) : [...x, id]));
  const save = async () => {
    setBusy(true);
    try { await od.saveSettings({ productIds: ids }); toast('Online access saved'); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card pad">
      <h3>Who gets <em>online classes</em></h3>
      <p className="muted">Clients with an active pass or membership from a ticked product can watch every online class. Free videos are open to anyone signed in. Tip: make an “Online membership” product in Products &amp; pricing, then tick it here.</p>
      <ul className="od-prods">
        {list.map((p) => (
          <li key={p.id}>
            <label className="check"><input type="checkbox" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} /><span>{p.name}<span className="muted"> · {money(p.priceCents)}{p.billingInterval ? ` / ${p.billingInterval}` : ''}</span></span></label>
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 12 }}><button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>Save</button></div>
    </section>
  );
}
