/**
 * The gift card as it looks in the app and in the email: the studio's logo and mark on its own colours.
 * Used by the client's buy flow (live preview), the client's card list, and the studio's gift card sheet.
 */
import React from 'react';
import { Flower, Logo, logoAspect } from '../../shared/brand';
import { brandAsset, getBranding } from '../../shared/branding';
import { money } from '../../shared/format';
import { dm, dmy } from './api';
import { GIFT_STATE_LABEL, maskGiftCode } from './logic';
import type { GiftCardState } from './types';
import './commerce.css';

export interface ECardProps {
  amountCents: number;
  /** Shows the money left as the big number, with "of $100" under it. */
  balanceCents?: number;
  to?: string;
  from?: string;
  message?: string;
  /** Full code. Omit for a preview before purchase. */
  code?: string;
  /** Show only the last four characters of the code. */
  masked?: boolean;
  sendOn?: string;
  expiresAt?: string;
  state?: GiftCardState;
  /** 'Gift card' (default) or 'Account credit'. */
  label?: string;
  /** Show the whole message instead of the first few lines. */
  full?: boolean;
  className?: string;
}

export function ECard({ amountCents, balanceCents, to, from, message, code, masked, sendOn, expiresAt, state, label = 'Gift card', full, className }: ECardProps) {
  const b = getBranding();
  const photo = brandAsset(b.photos.offer ?? b.photos.hero);
  const dead = state && state !== 'active' && state !== 'pending';
  const shown = balanceCents ?? amountCents;
  return (
    <div className={'cm-ecard' + (dead ? ' dead' : '') + (className ? ' ' + className : '')}>
      {photo && <span className="cm-ec-photo" style={{ backgroundImage: `url(${photo})` }} aria-hidden="true" />}
      <Flower size={230} color="var(--highlight)" className="cm-ec-mark" />
      <div className="cm-ec-top">
        <Logo letters="var(--highlight)" flower="var(--accent)" style={{ width: 118, height: 'auto', aspectRatio: String(logoAspect()) }} />
        <span className="cm-ec-kind">{label}</span>
      </div>
      <div className="cm-ec-mid">
        <div className="cm-ec-amount serif">{money(shown)}</div>
        {balanceCents != null && balanceCents !== amountCents && <div className="cm-ec-of">of {money(amountCents)}</div>}
        {message ? <p className={'cm-ec-msg' + (full ? ' full' : '')}>“{message}”</p> : null}
      </div>
      <div className="cm-ec-foot">
        {(to || from) && (
          <div className="cm-ec-names">
            {to ? <span><small>For</small>{to}</span> : null}
            {from ? <span><small>From</small>{from}</span> : null}
          </div>
        )}
        <div className="cm-ec-code" aria-label={code ? 'Gift card code' : 'Your code appears here'}>
          {code ? (masked ? maskGiftCode(code) : code) : 'XXXX-XXXX-XXXX'}
        </div>
        {(sendOn || expiresAt) && (
          <div className="cm-ec-fine">
            {sendOn ? <>Arrives {dm(sendOn)}</> : null}
            {sendOn && expiresAt ? ' · ' : null}
            {expiresAt ? <>Expires {dmy(expiresAt)}</> : null}
          </div>
        )}
      </div>
      {dead && <span className="cm-ec-stamp">{GIFT_STATE_LABEL[state!]}</span>}
    </div>
  );
}
