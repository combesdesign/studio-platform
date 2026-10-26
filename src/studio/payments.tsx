/**
 * Card payments for a studio on the multi-studio platform (Stripe Connect). The studio owns its own Stripe account and
 * gets paid directly; this shows "Connect Stripe", "Finish setup" or "Connected ✓" and sends the owner to Stripe's
 * hosted onboarding. Used by Settings -> Payments and the setup wizard's Payments step.
 * Owners only (the store refuses anyone else). A single-account deployment such as Snowy has no Payments tab at all.
 */
import React from 'react';
import { store, useAction, useData } from '../shared/react';
import { Icon, Loading } from './ui';

/** Where Stripe sends the owner back to: this same screen. */
const hereAt = (route: string) => `${location.href.split('#')[0]}#${route}`;

export function PaymentsPanel({ returnRoute }: { returnRoute: string }) {
  const status = useData(() => store.getPaymentsStatus(), []);
  const { busy, run } = useAction();
  const s = status.data;

  const connect = async () => {
    const r = await run(() => store.startPaymentsOnboarding(hereAt(returnRoute)));
    if (r === undefined) return;          // it failed and run() already showed why
    if (r && r.url) { location.href = r.url; return; }
    status.reload();                      // demo: connected straight away
  };

  if (status.loading && !s) return <Loading />;
  if (!s) return <p className="muted">{status.error?.message || 'We couldn’t load payment settings. Please try again.'}</p>;

  if (!s.connectMode) {
    return (
      <div className="panel">
        <strong>Card payments</strong>
        <p className="small muted" style={{ marginTop: 4 }}>This app takes card payments on its own Stripe account, so there’s nothing to connect here.</p>
      </div>
    );
  }

  const done = s.connected && s.detailsSubmitted;
  const started = !!s.accountId && !done;
  return (
    <div className="stack" data-testid="payments-panel">
      <div className="pay-state">
        {done
          ? <span className="chip ok">Connected ✓</span>
          : <span className={started ? 'chip warn' : 'chip'}>{started ? 'Setup not finished' : 'Not connected'}</span>}
      </div>
      {done ? (
        <>
          <p>Card payments from your clients go straight to your own Stripe account. You manage payouts, refunds and disputes in your Stripe dashboard.</p>
          <ul className="pay-list small">
            <li><Icon name="check" size={16} />Charges are on</li>
            <li>{s.payoutsEnabled ? <Icon name="check" size={16} /> : <Icon name="clock" size={16} />}{s.payoutsEnabled ? 'Payouts are on' : 'Payouts are waiting on Stripe (usually a day or two)'}</li>
          </ul>
          <div className="row">
            <a className="btn ghost" href="https://dashboard.stripe.com" target="_blank" rel="noreferrer noopener">Open Stripe dashboard</a>
          </div>
        </>
      ) : (
        <>
          <p>{started
            ? 'Stripe still needs a few details before you can take card payments. It only takes a few minutes, and you’ll land back here afterwards.'
            : 'Connect your own Stripe account so clients can pay by card in the app and the money goes straight to you. Until then, clients are asked to pay at the studio.'}</p>
          <div className="row">
            <button className="btn" onClick={connect} disabled={busy}>{busy ? 'Opening…' : started ? 'Finish setup' : 'Connect Stripe'}<Icon name="right" size={18} /></button>
            {started && <button className="btn ghost" onClick={() => status.reload()} disabled={busy}>Check again</button>}
          </div>
        </>
      )}
    </div>
  );
}
