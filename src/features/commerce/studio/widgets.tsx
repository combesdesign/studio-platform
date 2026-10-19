/** Today › Low stock widget, and the gift card / referral card on a client's profile. */
import React, { useState } from 'react';
import { useData } from '../../../shared/react';
import { money } from '../../../shared/format';
import type { Client } from '../../../shared/types';
import { Flower } from '../../../shared/brand';
import { Icon, useStudio } from '../../../studio/ui';
import { commerce, dm } from '../api';
import { SellGiftCardSheet } from './shop';

export function LowStockWidget() {
  const items = useData(() => commerce()?.listRetail() ?? Promise.resolve([]), []);
  const low = (items.data ?? []).filter((i) => i.active && (i.status === 'low' || i.status === 'out')).sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));
  if (!low.length) return null;
  return (
    <section className="card pad alerts cm-lowstock">
      <h3><Flower size={16} className="h-fl" />Low <em>stock</em></h3>
      <div className="cm-alerts">
        {low.slice(0, 5).map((i) => (
          <a key={i.productId} className="alert-row" href="#/shop/stock">
            <span className={'cm-dot' + (i.status === 'out' ? ' out' : '')} aria-hidden="true" />
            <span className="grow"><strong>{i.name}</strong><span className="muted small"> · {i.stock === 0 ? 'out of stock' : `${i.stock} left`}</span></span>
            <Icon name="right" size={16} />
          </a>
        ))}
      </div>
      {low.length > 5 && <a className="linkish" href="#/shop/stock">{low.length - 5} more</a>}
    </section>
  );
}

export function ClientCommerceCard({ client }: { client: Client }) {
  const { can } = useStudio();
  const [sell, setSell] = useState(false);
  const data = useData(async () => {
    const cm = commerce();
    if (!cm) return null;
    const [cards, refs] = await Promise.all([cm.listGiftCards(), cm.referralStats()]);
    return {
      credit: cards.filter((c) => c.ownerClientId === client.id && c.state === 'active'),
      bought: cards.filter((c) => c.purchaserClientId === client.id && c.ownerClientId !== client.id),
      received: cards.filter((c) => c.state === 'active' && !!c.recipientEmail && c.recipientEmail.toLowerCase() === client.email.toLowerCase()),
      referred: refs.recent.filter((r) => r.referrerClientId === client.id),
      by: refs.recent.find((r) => r.referredClientId === client.id),
    };
  }, [client.id]);
  const d = data.data;
  if (!d) return null;
  const creditCents = d.credit.reduce((n, c) => n + c.balanceCents, 0);
  const receivedCents = d.received.reduce((n, c) => n + c.balanceCents, 0);
  const empty = !d.credit.length && !d.bought.length && !d.received.length && !d.referred.length && !d.by;
  return (
    <section className="card pad cm-client">
      <div className="sec-head"><h3>Gift cards &amp; <em>credit</em></h3>{can('commerce.sell') && <button className="linkish" onClick={() => setSell(true)}>Sell a gift card<Icon name="right" size={16} /></button>}</div>
      {empty ? <p className="muted">No gift cards, credit or referrals yet.</p> : (
        <div className="cm-client-grid">
          {creditCents > 0 && <div><strong className="serif">{money(creditCents, { cents: creditCents % 100 !== 0 })}</strong><span>account credit{d.credit[0] ? ` · code ${d.credit[0].code}` : ''}</span></div>}
          {receivedCents > 0 && <div><strong className="serif">{money(receivedCents, { cents: receivedCents % 100 !== 0 })}</strong><span>on gift cards sent to them</span></div>}
          {d.bought.length > 0 && <div><strong className="serif">{d.bought.length}</strong><span>gift card{d.bought.length === 1 ? '' : 's'} bought, last {dm(d.bought[0]!.createdAt)}</span></div>}
          {d.referred.length > 0 && <div><strong className="serif">{d.referred.length}</strong><span>friend{d.referred.length === 1 ? '' : 's'} referred</span></div>}
          {d.by && <div className="cm-span"><span>Joined with {d.by.referrerName}’s referral code{d.by.status === 'rewarded' ? '' : ' (reward pending their first pass)'}</span></div>}
        </div>
      )}
      <SellGiftCardSheet open={sell} onClose={() => setSell(false)} clientId={client.id} />
    </section>
  );
}
