/** Settings › Shop: gift card amounts and expiry, referral reward, low-stock level. */
import React, { useEffect, useState } from 'react';
import { useAction, useData } from '../../../shared/react';
import { money } from '../../../shared/format';
import { Loading, useStudio } from '../../../studio/ui';
import { centsToInput, inputToCents, needCommerce } from '../api';
import type { CommerceSettings } from '../types';

export function ShopSettings() {
  const { can } = useStudio();
  const s = useData(() => needCommerce().getSettings(), []);
  const [d, setD] = useState<CommerceSettings | null>(null);
  const [amounts, setAmounts] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (s.data) { setD(s.data); setAmounts(s.data.giftCardAmounts.map((a) => centsToInput(a)).join(', ')); } }, [s.data]);
  if (!d || !s.data) return s.error ? <p className="form-err">{s.error.message}</p> : <Loading />;
  const parsed = amounts.split(/[,\s]+/).map((x) => inputToCents(x)).filter((x) => x > 0);
  const next: CommerceSettings = { ...d, giftCardAmounts: parsed };
  const dirty = JSON.stringify(next) !== JSON.stringify(s.data);
  const set = <K extends keyof CommerceSettings>(k: K, v: CommerceSettings[K]) => setD({ ...d, [k]: v });
  const save = () => run(() => needCommerce().updateSettings(next), 'Shop settings saved');
  const reset = () => { setD(s.data!); setAmounts(s.data!.giftCardAmounts.map((a) => centsToInput(a)).join(', ')); };
  const disabled = !can('commerce.manage');
  return (
    <div className="set-grid">
      <section className="card pad">
        <h3>Gift <em>cards</em></h3>
        <p className="muted small cm-set-sub">Clients buy e-gift cards in the app. Staff sell them at the till.</p>
        <div className="form-grid">
          <label className="field span2"><span>Amount buttons in the app (dollars, comma separated)</span><input className="input" value={amounts} disabled={disabled} onChange={(e) => setAmounts(e.target.value)} placeholder="50, 100, 150" /></label>
          <label className="field"><span>Smallest card</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" disabled={disabled} defaultValue={centsToInput(d.giftCardMinCents)} key={'min' + d.giftCardMinCents} onBlur={(e) => set('giftCardMinCents', inputToCents(e.target.value))} /></div></label>
          <label className="field"><span>Largest card</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" disabled={disabled} defaultValue={centsToInput(d.giftCardMaxCents)} key={'max' + d.giftCardMaxCents} onBlur={(e) => set('giftCardMaxCents', inputToCents(e.target.value))} /></div></label>
          <label className="field span2"><span>Cards expire after (months, 0 = never)</span><input className="input" type="number" min={0} max={120} disabled={disabled} value={d.giftCardExpiryMonths} onChange={(e) => set('giftCardExpiryMonths', Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
        </div>
        {d.giftCardExpiryMonths > 0 && d.giftCardExpiryMonths < 36 && <p className="cm-warn small">In Australia, gift cards sold to the public generally need to last at least 3 years (36 months).</p>}
      </section>
      <section className="card pad">
        <h3>Referral <em>rewards</em></h3>
        <p className="muted small cm-set-sub">Clients share a code from their profile. When a friend joins with it and buys their first paid pass, the client is rewarded.</p>
        <div className="form-grid">
          <label className="check span2"><input type="checkbox" disabled={disabled} checked={d.referralEnabled} onChange={(e) => set('referralEnabled', e.target.checked)} /><span>Give referral rewards</span></label>
          <label className="field"><span>Reward</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" disabled={disabled || !d.referralEnabled} defaultValue={centsToInput(d.referralRewardCents)} key={'rr' + d.referralRewardCents} onBlur={(e) => set('referralRewardCents', inputToCents(e.target.value))} /></div></label>
          <label className="field"><span>Paid as</span>
            <select className="select" disabled={disabled || !d.referralEnabled} value={d.referralRewardKind} onChange={(e) => set('referralRewardKind', e.target.value as CommerceSettings['referralRewardKind'])}>
              <option value="credit">Account credit (just for them)</option>
              <option value="gift_card">Gift card (they can pass it on)</option>
            </select>
          </label>
        </div>
        {d.referralEnabled && <p className="panel small cm-set-note">A client who refers a friend gets {money(d.referralRewardCents)} {d.referralRewardKind === 'credit' ? 'of account credit' : 'as a gift card'}, shown under Gift cards in their app.</p>}
      </section>
      <section className="card pad">
        <h3>Retail <em>stock</em></h3>
        <p className="muted small cm-set-sub">Products at or below this count show as low on Today and in Shop › Retail stock. Each product can have its own level.</p>
        <div className="form-grid">
          <label className="field"><span>Low-stock alert at</span><input className="input" type="number" min={0} disabled={disabled} value={d.lowStockDefault} onChange={(e) => set('lowStockDefault', Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
        </div>
      </section>
      {dirty && !disabled && (
        <div className="savebar"><span>Unsaved changes</span><button className="btn sm ghost light" onClick={reset}>Discard</button><button className="btn sm cream" onClick={save} disabled={busy}>Save changes</button></div>
      )}
    </div>
  );
}
