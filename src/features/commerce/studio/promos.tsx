/** Studio › Shop › Promo codes: list, create/edit, usage report. */
import React, { useMemo, useState } from 'react';
import { Sheet, store, useAction, useData } from '../../../shared/react';
import { money } from '../../../shared/format';
import type { Product } from '../../../shared/types';
import { Empty, Icon, Loading, Seg, SheetHead, cx, useStudio } from '../../../studio/ui';
import { PROMO_STATUS_LABEL, PROMO_STATUS_TONE, dm, dmy, inputToCents, needCommerce } from '../api';
import { normalisePromoCode } from '../logic';
import type { Promo, PromoWithUsage } from '../types';
import { Kpi, Tone } from './bits';

export function PromosTab() {
  const { can } = useStudio();
  const promos = useData(() => needCommerce().listPromos(), []);
  const uses = useData(() => needCommerce().promoRedemptions(), []);
  const products = useData(() => store.listProducts(), []);
  const [edit, setEdit] = useState<PromoWithUsage | 'new' | null>(null);
  const [focus, setFocus] = useState<string>('');
  const list = promos.data ?? [];
  const live = list.filter((p) => p.status === 'live');
  const all = uses.data ?? [];
  const shownUses = focus ? all.filter((u) => u.promoId === focus) : all;
  const name = (ids: string[]) => {
    if (!ids.length) return 'Everything';
    const n = ids.map((id) => products.data?.find((p) => p.id === id)?.name).filter(Boolean) as string[];
    return n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
  };
  if (promos.error && !promos.data) return <Empty title="That didn’t load">{promos.error.message}</Empty>;
  if (!promos.data) return <Loading />;
  return (
    <>
      <div className="cm-kpis">
        <Kpi tone="hero" label="Live codes" value={live.length} sub={live.map((p) => p.code).slice(0, 3).join(', ') || 'None running'} />
        <Kpi label="Times used" value={list.reduce((n, p) => n + p.uses, 0)} sub="All codes, all time" />
        <Kpi label="Discount given" value={money(list.reduce((n, p) => n + p.discountCents, 0))} sub="Taken off sales" />
        <Kpi tone="mist" label="Most used" value={[...list].sort((a, b) => b.uses - a.uses)[0]?.code ?? '–'} sub={[...list].sort((a, b) => b.uses - a.uses)[0] ? `${[...list].sort((a, b) => b.uses - a.uses)[0]!.uses} uses` : undefined} />
      </div>
      <div className="sec-head">
        <h2>Promo <em>codes</em></h2>
        {can('commerce.manage') && <button className="btn" onClick={() => setEdit('new')}><Icon name="plus" size={18} />New code</button>}
      </div>
      {list.length === 0 ? <Empty title="No promo codes yet">Make one for a launch, a holiday or a welcome offer.</Empty> : (
        <div className="cm-promos">
          {list.map((p) => (
            <article key={p.id} className={cx('card cm-promo', p.status !== 'live' && 'quiet')}>
              <div className="cm-promo-top">
                <span className="cm-code promo">{p.code}</span>
                <Tone tone={PROMO_STATUS_TONE[p.status]}>{PROMO_STATUS_LABEL[p.status]}</Tone>
              </div>
              <div className="cm-promo-off serif">{p.kind === 'percent' ? `${p.value}% off` : `${money(p.value)} off`}</div>
              <p className="muted">{p.description ? `${p.description}. ` : ''}{name(p.productIds)}.</p>
              <ul className="cm-rules">
                <li>{p.startsOn || p.endsOn ? `${p.startsOn ? dm(p.startsOn) : 'Now'} to ${p.endsOn ? dmy(p.endsOn) : 'no end date'}` : 'No dates'}</li>
                {p.newClientsOnly && <li>New clients only</li>}
                {p.maxUsesPerClient != null && <li>{p.maxUsesPerClient === 1 ? 'Once per client' : `${p.maxUsesPerClient} uses per client`}</li>}
              </ul>
              <div className="cm-promo-use">
                <span><strong>{p.uses}</strong>{p.maxUses != null ? ` of ${p.maxUses}` : ''} used</span>
                <span>{money(p.discountCents)} off</span>
              </div>
              {p.maxUses != null && <span className="cm-meter"><span style={{ width: `${Math.min(100, Math.round((p.uses / p.maxUses) * 100))}%` }} /></span>}
              <div className="cm-actions">
                <button className="btn sm soft" onClick={() => setFocus(focus === p.id ? '' : p.id)}>{focus === p.id ? 'All usage' : 'Usage'}</button>
                {can('commerce.manage') && <button className="btn sm ghost" onClick={() => setEdit(p)}>Edit</button>}
              </div>
            </article>
          ))}
        </div>
      )}

      <section className="card pad cm-usage">
        <div className="sec-head"><h3>Usage <em>report</em></h3>{focus && <button className="linkish" onClick={() => setFocus('')}>Show every code</button>}</div>
        {uses.data && shownUses.length === 0 ? <p className="muted">No one has used {focus ? 'this code' : 'a code'} yet.</p> : !uses.data ? <Loading /> : (
          <>
            <div className="cm-usage-sum">
              {Object.entries(shownUses.reduce<Record<string, { n: number; c: number }>>((m, u) => { const x = m[u.code] ?? { n: 0, c: 0 }; x.n++; x.c += u.discountCents; m[u.code] = x; return m; }, {}))
                .sort((a, b) => b[1].n - a[1].n).map(([code, v]) => (
                  <div key={code}><span className="cm-code promo">{code}</span><span>{v.n} use{v.n === 1 ? '' : 's'}</span><span className="faint">{money(v.c, { cents: true })} off</span></div>
                ))}
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Code</th><th>Client</th><th className="num">Discount</th></tr></thead>
                <tbody>
                  {shownUses.slice(0, 40).map((u) => (
                    <tr key={u.id}>
                      <td>{dmy(u.at)}</td><td>{u.code}</td>
                      <td>{u.clientId ? <a className="linkish" href={`#/clients/${u.clientId}`}>{u.clientName}</a> : <span className="faint">Walk-in</span>}</td>
                      <td className="num">{money(u.discountCents, { cents: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shownUses.length > 40 && <p className="faint small mt-8">Showing the latest 40 of {shownUses.length}.</p>}
          </>
        )}
      </section>

      <Sheet open={!!edit} onClose={() => setEdit(null)} label="Promo code">
        {edit && <PromoEditor promo={edit === 'new' ? null : edit} products={products.data ?? []} onClose={() => setEdit(null)} />}
      </Sheet>
    </>
  );
}

function PromoEditor({ promo, products, onClose }: { promo: Promo | null; products: Product[]; onClose: () => void }) {
  const { busy, run } = useAction();
  const [code, setCode] = useState(promo?.code ?? '');
  const [description, setDescription] = useState(promo?.description ?? '');
  const [kind, setKind] = useState<'percent' | 'amount'>(promo?.kind ?? 'percent');
  const [value, setValue] = useState(promo ? (promo.kind === 'percent' ? String(promo.value) : (promo.value / 100).toFixed(promo.value % 100 ? 2 : 0)) : '10');
  const [every, setEvery] = useState(!promo || promo.productIds.length === 0);
  const [ids, setIds] = useState<string[]>(promo?.productIds ?? []);
  const [startsOn, setStartsOn] = useState(promo?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(promo?.endsOn ?? '');
  const [maxUses, setMaxUses] = useState(promo?.maxUses != null ? String(promo.maxUses) : '');
  const [perClient, setPerClient] = useState(promo?.maxUsesPerClient != null ? String(promo.maxUsesPerClient) : '');
  const [newOnly, setNewOnly] = useState(promo?.newClientsOnly ?? false);
  const [active, setActive] = useState(promo?.active ?? true);
  const sellable = useMemo(() => products.filter((p) => p.active || ids.includes(p.id)).sort((a, b) => a.sortOrder - b.sortOrder), [products]);
  const num = (s: string) => (s.trim() ? Math.floor(Number(s)) : undefined);
  const save = async () => {
    const v = kind === 'percent' ? Math.round(Number(value)) : inputToCents(value);
    const r = await run(() => needCommerce().upsertPromo({
      ...(promo ? { id: promo.id } : {}), code, kind, value: v, productIds: every ? [] : ids, newClientsOnly: newOnly, active,
      ...(description.trim() ? { description: description.trim() } : {}), ...(startsOn ? { startsOn } : {}), ...(endsOn ? { endsOn } : {}),
      ...(num(maxUses) != null ? { maxUses: num(maxUses) } : {}), ...(num(perClient) != null ? { maxUsesPerClient: num(perClient) } : {}),
    }), promo ? 'Promo code saved' : 'Promo code created');
    if (r) onClose();
  };
  return (
    <>
      <SheetHead title={promo ? <>Edit <em>{promo.code}</em></> : <>New promo <em>code</em></>} sub="Clients type the code at checkout in the app, or staff add it at the till." onClose={onClose} />
      <div className="stack lg">
        <div className="form-grid">
          <label className="field"><span>Code</span><input className="input cm-upper" value={code} onChange={(e) => setCode(normalisePromoCode(e.target.value))} placeholder="WELCOME10" maxLength={20} /></label>
          <label className="field"><span>Description (staff only)</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="New client welcome" /></label>
          <div className="field"><span>Discount</span><Seg value={kind} onChange={setKind} options={[{ value: 'percent', label: '% off' }, { value: 'amount', label: '$ off' }]} /></div>
          <label className="field"><span>{kind === 'percent' ? 'Percent off' : 'Amount off'}</span>
            <div className="money-in">{kind === 'amount' && <span>$</span>}<input className={cx('input', kind === 'percent' && 'cm-pct')} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))} /></div>
          </label>
        </div>
        <fieldset className="cm-fs">
          <legend>Applies to</legend>
          <label className="check"><input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} /><span>Everything in the shop</span></label>
          {!every && (
            <div className="cm-prod-pick">
              {sellable.map((p) => (
                <label key={p.id} className={cx('cm-prod', ids.includes(p.id) && 'on')}>
                  <input type="checkbox" checked={ids.includes(p.id)} onChange={(e) => setIds(e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id))} />
                  <span className="grow">{p.name}</span><span className="faint">{money(p.priceCents)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="form-grid">
          <label className="field"><span>Starts (optional)</span><input className="input" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
          <label className="field"><span>Ends (optional)</span><input className="input" type="date" value={endsOn} min={startsOn || undefined} onChange={(e) => setEndsOn(e.target.value)} /></label>
          <label className="field"><span>Total uses (blank = no limit)</span><input className="input" inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>Uses per client (blank = no limit)</span><input className="input" inputMode="numeric" value={perClient} onChange={(e) => setPerClient(e.target.value.replace(/\D/g, ''))} /></label>
          <label className="check span2"><input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} /><span>New clients only (no class pass before)</span></label>
          <label className="check span2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Active (untick to pause the code)</span></label>
        </div>
        <div className="sh-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || code.length < 3 || !value || (!every && ids.length === 0)} onClick={save}>{busy ? 'Saving…' : promo ? 'Save code' : 'Create code'}</button>
        </div>
      </div>
    </>
  );
}
