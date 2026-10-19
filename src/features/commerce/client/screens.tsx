/** Commerce in the client app: gift cards (buy, list, check a balance), refer a friend, and codes at checkout. */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, errorMessage, leaveSheets, store, useBackHandler, useData, useToast } from '../../../shared/react';
import { addDays, money, studioDate } from '../../../shared/format';
import type { Product, Sale } from '../../../shared/types';
import { Accent, Arrow, BackPill, CardSkeletons, ErrorBlock, Flower, Icon, ScreenHead, SectionHead, SheetHead, useApp } from '../../../client/ui';
import { backOut, flowFrom, goFlow } from '../../../client/lib';
import { Receipt } from '../../../client/passes';
import { commerce, copyText, dm, dmy, inputToCents, needCommerce, referralLink } from '../api';
import { ECard } from '../ecard';
import { EMAIL_RE, GIFT_STATE_LABEL, normaliseGiftCode, normalisePromoCode } from '../logic';
import type { GiftCard, GiftCardLookup, Quote } from '../types';

type Nav = (to: string, o?: { replace?: boolean }) => void;

export const GiftIcon = ({ size = 20 }: { size?: number }) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="9" width="16" height="11.5" rx="1.5" /><path d="M3 9h18M12 9v11.5M12 9c-1.5-3.5-5.5-4-5.5-1.5S12 9 12 9Zm0 0c1.5-3.5 5.5-4 5.5-1.5S12 9 12 9Z" />
  </svg>
);
export const FriendsIcon = ({ size = 20 }: { size?: number }) => (
  <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="9" r="3.3" /><path d="M3 19c.9-3 3.2-4.6 6-4.6s5.1 1.6 6 4.6" /><path d="M17 8v6M14 11h6" />
  </svg>
);

const cardLabel = (c: Pick<GiftCard, 'kind'>) => (c.kind === 'credit' ? 'Account credit' : 'Gift card');

// ------------------------------------------------------------------ demo card payment (same look as the core checkout)
function PayStep({ amountCents, busy, onPay, note }: { amountCents: number; busy: false | 'pay' | 'apple'; onPay: (via: 'pay' | 'apple') => void; note?: React.ReactNode }) {
  const app = useApp();
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', exp: '12 / 29', cvc: '123', name: `${app.client.firstName} ${app.client.lastName}`.trim() });
  return (
    <>
      {store.mode === 'demo' && <div className="demo-strip"><Icon name="info" size={18} />Demo – no real payment is taken</div>}
      <button className="apple-pay" disabled={!!busy} onClick={() => onPay('apple')} aria-label="Pay with Apple Pay">
        {busy === 'apple' ? <Flower size={22} white spin /> : <><Icon name="apple" fill size={22} /><span>Pay</span></>}
      </button>
      <div className="or"><span>or pay with card</span></div>
      <div className="card-form">
        <label className="field"><span>Card number</span>
          <div className="input-icon"><Icon name="card" size={20} /><input className="input" inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} /></div>
        </label>
        <div className="grid2">
          <label className="field"><span>Expiry</span><input className="input" autoComplete="cc-exp" value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} /></label>
          <label className="field"><span>CVC</span><input className="input" inputMode="numeric" autoComplete="cc-csc" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} /></label>
        </div>
        <label className="field"><span>Name on card</span><input className="input" autoComplete="cc-name" value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} /></label>
      </div>
      <button className="btn block big" disabled={!!busy} onClick={() => onPay('pay')}>
        {busy === 'pay' ? 'Processing…' : <><Icon name="lock" size={17} />Pay {money(amountCents, { cents: true })}</>}
      </button>
      {note && <p className="fine muted center">{note}</p>}
    </>
  );
}

// ------------------------------------------------------------------ /gift-cards
export function GiftCardsScreen({ nav, path }: { nav: Nav; path: string }) {
  const app = useApp();
  const cards = useData(() => needCommerce().myGiftCards(), []);
  const [open, setOpen] = useState<GiftCard | null>(null);
  const back = flowFrom(path);
  const mine = cards.data ?? [];
  const live = mine.filter((c) => c.state === 'active' || c.state === 'pending');
  const old = mine.filter((c) => !(c.state === 'active' || c.state === 'pending'));
  const credit = live.filter((c) => c.kind === 'credit' && c.ownerClientId === app.client.id).reduce((n, c) => n + c.balanceCents, 0);
  const buy = () => goFlow(nav, '/gift-cards/buy', { label: 'Gift cards', where: '/gift-cards' });

  return (
    <div className="screen">
      <div className="screen-back"><BackPill label={back?.label ?? 'Profile'} onClick={() => backOut(nav, path, '/profile')} /></div>
      <ScreenHead title={<>Gift <em>cards</em></>} sub="Give someone you love the gift of movement, or keep track of cards you’ve been given." />

      <div className="cm-hero-card">
        <ECard amountCents={10000} to="Someone special" from={app.client.firstName} message="Time on the mat, just for you." />
      </div>
      <button className="btn block big mt-20" onClick={buy}><GiftIcon size={19} />Buy a gift card</button>

      {credit > 0 && (
        <div className="note cream mt-20">
          <Flower size={20} />
          <div>You have <strong>{money(credit, { cents: true })}</strong> of account credit. Add its code when you buy a pass or extra in the shop.</div>
        </div>
      )}

      <div className="group mt-28">
        <div className="group-label">Your cards</div>
        {cards.error && !cards.data ? <ErrorBlock error={cards.error} onRetry={cards.reload} /> :
          !cards.data ? <CardSkeletons n={2} h={72} /> :
            live.length === 0 ? <p className="panel-soft">No gift cards yet. Cards you buy, cards sent to {app.client.email} and referral credit will show up here.</p> : (
              <div className="list-card">
                {live.map((c) => <CardRow key={c.id} c={c} me={app.client.id} onOpen={() => setOpen(c)} />)}
              </div>
            )}
      </div>
      {old.length > 0 && (
        <div className="group mt-20">
          <div className="group-label">Used and expired</div>
          <div className="list-card">{old.map((c) => <CardRow key={c.id} c={c} me={app.client.id} onOpen={() => setOpen(c)} />)}</div>
        </div>
      )}

      <BalanceCheck />

      <Sheet open={!!open} onClose={() => setOpen(null)} label="Gift card">
        {open && <CardSheet c={open} me={app.client.id} onClose={() => setOpen(null)} />}
      </Sheet>
    </div>
  );
}

function CardRow({ c, me, onOpen }: { c: GiftCard; me: string; onOpen: () => void }) {
  const bought = c.purchaserClientId === me && c.ownerClientId !== me;
  const sub = c.kind === 'credit' ? 'Referral credit'
    : bought ? `For ${c.recipientName ?? 'a friend'}${c.sentAt ? ` · sent ${dm(c.sentAt)}` : c.sendOn ? ` · arrives ${dm(c.sendOn)}` : ''}`
      : `From ${c.fromName ?? 'a friend'}`;
  return (
    <button className="list-row" onClick={onOpen}>
      <span className="row-ic">{c.kind === 'credit' ? <Flower size={20} /> : <GiftIcon />}</span>
      <span className="list-row-main">
        <span className="list-row-title">{money(c.balanceCents, { cents: c.balanceCents % 100 !== 0 })} <span className="muted">{c.balanceCents !== c.initialCents ? `left of ${money(c.initialCents)}` : cardLabel(c).toLowerCase()}</span></span>
        <span className="list-row-sub">{sub}</span>
      </span>
      {c.state !== 'active' ? <span className="tag">{GIFT_STATE_LABEL[c.state]}</span> : <Icon name="chevron" size={18} className="faint" />}
    </button>
  );
}

function CardSheet({ c, me, onClose }: { c: GiftCard; me: string; onClose: () => void }) {
  const toast = useToast();
  const bought = c.purchaserClientId === me && c.ownerClientId !== me;
  const copy = async () => toast((await copyText(c.code)) ? 'Code copied' : 'Couldn’t copy. Long-press the code instead.');
  return (
    <>
      <SheetHead eyebrow={cardLabel(c)} title={<>{money(c.balanceCents, { cents: c.balanceCents % 100 !== 0 })} <span className="muted-serif">left</span></>} onClose={onClose} />
      <div className="stack lg">
        <ECard amountCents={c.initialCents} balanceCents={c.balanceCents} to={c.recipientName} from={c.fromName} message={c.message} code={c.code}
          expiresAt={c.expiresAt} state={c.state} label={cardLabel(c)} full />
        <button className="btn soft block" onClick={copy}><Icon name="share" size={18} />Copy the code</button>
        {bought && c.recipientEmail && (
          <p className="panel-soft">{c.sentAt ? <>Emailed to <strong>{c.recipientEmail}</strong> on {dm(c.sentAt)}.</> : <>We’ll email it to <strong>{c.recipientEmail}</strong> on {dm(c.sendOn ?? studioDate())}.</>}</p>
        )}
        <ul className="ticks">
          <li><Flower size={14} />Use it in the app: add the code when you buy a pass or extra in the shop.</li>
          <li><Flower size={14} />Or read the code out at the front desk.</li>
          <li><Flower size={14} />Spend it over as many visits as you like. Whatever’s left stays on the card.</li>
        </ul>
      </div>
    </>
  );
}

function BalanceCheck() {
  const [code, setCode] = useState('');
  const [res, setRes] = useState<GiftCardLookup | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const check = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErr(''); setRes(null);
    if (!normaliseGiftCode(code)) { setErr('Gift card codes are 12 letters and numbers, like ABCD-EFGH-JKMN.'); return; }
    setBusy(true);
    try { setRes(await needCommerce().lookupGiftCard(code)); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <form className="group mt-28" onSubmit={check}>
      <div className="group-label">Check a balance</div>
      <div className="cm-code-row">
        <input className="input" value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setRes(null); setErr(''); }} placeholder="XXXX-XXXX-XXXX" aria-label="Gift card code" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
        <button className="btn soft" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Check'}</button>
      </div>
      {err && <p className="form-error mt-8">{err}</p>}
      {res && (
        <p className="panel-soft mt-8">
          {res.state === 'active' ? <><strong>{money(res.balanceCents, { cents: true })}</strong> left{res.expiresAt ? `, use by ${dmy(res.expiresAt)}` : ''}.</> : <>This card is <strong>{GIFT_STATE_LABEL[res.state].toLowerCase()}</strong>.</>}
        </p>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ /gift-cards/buy
export function BuyGiftCardScreen({ nav, path }: { nav: Nav; path: string }) {
  const app = useApp();
  const toast = useToast();
  const settings = useData(() => needCommerce().getSettings(), []);
  const today = studioDate();
  const [amount, setAmount] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [toName, setToName] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [message, setMessage] = useState('');
  const [fromName, setFromName] = useState(app.client.firstName);
  const [later, setLater] = useState(false);
  const [sendOn, setSendOn] = useState(addDays(today, 1));
  const [step, setStep] = useState<'details' | 'pay' | 'done'>('details');
  const [busy, setBusy] = useState<false | 'pay' | 'apple'>(false);
  const [done, setDone] = useState<{ card: GiftCard; sale?: Sale } | null>(null);
  useBackHandler(step === 'pay', () => setStep('details'));
  const back = flowFrom(path);
  const leave = () => backOut(nav, path, '/gift-cards');

  const s = settings.data;
  useEffect(() => { if (s && amount === null && !custom) setAmount(s.giftCardAmounts[1] ?? s.giftCardAmounts[0] ?? null); }, [s]);
  const cents = custom ? inputToCents(custom) : amount ?? 0;
  const problems = useMemo(() => {
    const p: string[] = [];
    if (s && (cents < s.giftCardMinCents || cents > s.giftCardMaxCents)) p.push(`Choose an amount from ${money(s.giftCardMinCents)} to ${money(s.giftCardMaxCents)}.`);
    if (!toName.trim()) p.push('Add who it’s for.');
    if (!EMAIL_RE.test(toEmail.trim())) p.push('Add their email address.');
    if (later && (sendOn < today || sendOn > addDays(today, 365))) p.push('Choose a send date in the next year.');
    return p;
  }, [s, cents, toName, toEmail, later, sendOn]);

  const pay = async (via: 'pay' | 'apple') => {
    setBusy(via);
    try {
      await new Promise((r) => setTimeout(r, 650));
      const r = await needCommerce().buyGiftCard({
        amountCents: cents, recipientName: toName.trim(), recipientEmail: toEmail.trim(), ...(message.trim() ? { message: message.trim() } : {}),
        ...(fromName.trim() ? { fromName: fromName.trim() } : {}), sendOn: later ? sendOn : today,
      });
      if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
      setDone({ card: r.card, ...(r.sale ? { sale: r.sale } : {}) }); setStep('done');
      window.scrollTo(0, 0);
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };

  if (settings.error && !s) return <div className="screen"><ErrorBlock error={settings.error} onRetry={settings.reload} /></div>;

  if (step === 'done' && done) {
    const c = done.card;
    return (
      <div className="screen">
        <div className="success">
          <div className="success-mark"><Flower size={64} className="bloom" /></div>
          <h2>Gift <em>sent</em></h2>
          <p className="muted">{c.sentAt ? <>It’s on its way to {c.recipientName} at <strong>{c.recipientEmail}</strong>.</> : <>We’ll email {c.recipientName} at <strong>{c.recipientEmail}</strong> on {dm(c.sendOn ?? today)}.</>}</p>
          <div className="cm-success-card"><ECard amountCents={c.initialCents} to={c.recipientName} from={c.fromName} message={c.message} code={c.code} masked expiresAt={c.expiresAt} /></div>
          {done.sale && <Receipt sale={done.sale} />}
          <div className="stack">
            <button className="btn block" onClick={() => { setDone(null); setToName(''); setToEmail(''); setMessage(''); setStep('details'); }}>Buy another</button>
            <button className="btn ghost block" onClick={leave}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  const preview = <ECard amountCents={cents || s?.giftCardAmounts[0] || 0} to={toName.trim() || 'Their name'} from={fromName.trim() || app.client.firstName} message={message.trim() || undefined} sendOn={later ? sendOn : undefined} />;

  if (step === 'pay') {
    return (
      <div className="screen">
        <div className="screen-back"><BackPill label="Gift card details" onClick={() => setStep('details')} /></div>
        <ScreenHead eyebrow="Checkout" title={<>{money(cents)} <em>gift card</em></>} sub={`For ${toName.trim()}, sent to ${toEmail.trim()}${later ? ` on ${dm(sendOn)}` : ' today'}.`} />
        <div className="stack lg">
          <PayStep amountCents={cents} busy={busy} onPay={pay} note={`Gift cards last ${s && s.giftCardExpiryMonths ? `${Math.round(s.giftCardExpiryMonths / 12 * 10) / 10} years` : 'forever'} and can be used on classes, packs and extras.`} />
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="screen-back"><BackPill label={back?.label ?? 'Gift cards'} onClick={leave} /></div>
      <ScreenHead title={<>Give the gift of <em>movement</em></>} sub="They’ll get a beautiful e-card by email with a code to use in the app or at the front desk." />
      {!s ? <CardSkeletons n={2} h={140} /> : (
        <div className="cm-buy">
          <div className="cm-buy-preview">{preview}</div>
          <div className="stack lg">
            <fieldset className="cm-fs">
              <legend>Amount</legend>
              <div className="cm-amounts">
                {s.giftCardAmounts.map((a) => (
                  <button key={a} type="button" className={'cm-amt' + (!custom && amount === a ? ' on' : '')} aria-pressed={!custom && amount === a} onClick={() => { setAmount(a); setCustom(''); }}>{money(a)}</button>
                ))}
              </div>
              <label className="field"><span>Or another amount ({money(s.giftCardMinCents)} to {money(s.giftCardMaxCents)})</span>
                <div className="cm-money"><span>$</span><input className="input" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /></div>
              </label>
            </fieldset>
            <fieldset className="cm-fs">
              <legend>Who’s it for?</legend>
              <label className="field"><span>Their name</span><input className="input" value={toName} onChange={(e) => setToName(e.target.value)} autoComplete="off" maxLength={60} /></label>
              <label className="field"><span>Their email</span><input className="input" type="email" inputMode="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} autoComplete="off" /></label>
              <label className="field"><span>Your message (optional)</span><textarea className="input cm-textarea" value={message} onChange={(e) => setMessage(e.target.value.slice(0, 400))} rows={3} placeholder="Happy birthday! Enjoy some time for you." /></label>
              <span className="cm-count fine muted">{message.length}/400</span>
              <label className="field"><span>From</span><input className="input" value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={60} /></label>
            </fieldset>
            <fieldset className="cm-fs">
              <legend>When should it arrive?</legend>
              <div className="picker-list">
                <button type="button" className={'picker-opt' + (!later ? ' on' : '')} onClick={() => setLater(false)}><span className="radio" /><span className="picker-main"><span className="picker-name">Send it now</span><span className="muted">Straight after you pay</span></span></button>
                <button type="button" className={'picker-opt' + (later ? ' on' : '')} onClick={() => setLater(true)}><span className="radio" /><span className="picker-main"><span className="picker-name">Send on a date</span><span className="muted">Perfect for birthdays</span></span></button>
              </div>
              {later && <label className="field"><span>Send on</span><input className="input" type="date" min={today} max={addDays(today, 365)} value={sendOn} onChange={(e) => setSendOn(e.target.value)} /></label>}
            </fieldset>
            {problems.length > 0 && (toName || toEmail) ? <p className="fine muted">{problems[0]}</p> : null}
            <button className="btn block big" disabled={problems.length > 0} onClick={() => { setStep('pay'); window.scrollTo(0, 0); }}>Continue to payment · {money(cents || 0)} <Arrow /></button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ /refer
export function ReferScreen({ nav, path }: { nav: Nav; path: string }) {
  const toast = useToast();
  const ref = useData(() => needCommerce().myReferral(), []);
  const [claim, setClaim] = useState('');
  const [busy, setBusy] = useState(false);
  const back = flowFrom(path);
  const r = ref.data;
  const link = r ? referralLink(r.code) : '';
  const reward = r ? `${money(r.rewardCents)} ${r.rewardKind === 'credit' ? 'credit' : 'gift card'}` : '';
  const share = async () => {
    if (!r) return;
    const text = `Come to a class with me! Use my code ${r.code} when you join.`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Join me', text, url: link }); return; }
    } catch { return; /* closed the share sheet */ }
    toast((await copyText(`${text} ${link}`)) ? 'Link copied. Paste it to a friend.' : 'Couldn’t copy the link.');
  };
  const doClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { const x = await needCommerce().claimReferral(claim); toast(`Thanks! ${x.referrerName} will get a thank-you when you buy your first pass.`); setClaim(''); }
    catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };

  return (
    <div className="screen">
      <div className="screen-back"><BackPill label={back?.label ?? 'Profile'} onClick={() => backOut(nav, path, '/profile')} /></div>
      <ScreenHead title={<>Bring a <em>friend</em></>} sub={r ? (r.enabled ? `When a friend joins with your code and buys their first pass, you get ${reward}. Thank you for spreading the word.` : 'Referral rewards are paused at the moment, but friends are always welcome.') : undefined} />
      {ref.error && !r ? <ErrorBlock error={ref.error} onRetry={ref.reload} /> : !r ? <CardSkeletons n={2} h={110} /> : (
        <div className="stack lg">
          <section className="cm-refer">
            <Flower size={170} className="cm-refer-mark" />
            <div className="kicker">Your code</div>
            <div className="cm-refer-code serif">{r.code}</div>
            <button className="btn white block" onClick={share}><Icon name="share" size={18} />Share your link</button>
            <button className="btn glass block" onClick={async () => toast((await copyText(r.code)) ? 'Code copied' : 'Couldn’t copy the code.')}>Copy the code</button>
          </section>
          <div className="cm-ref-stats">
            <div><strong className="serif">{r.referrals.length}</strong><span>friend{r.referrals.length === 1 ? '' : 's'} joined</span></div>
            <div><strong className="serif">{money(r.earnedCents)}</strong><span>earned so far</span></div>
          </div>
          {r.referrals.length > 0 && (
            <div className="group">
              <div className="group-label">Friends</div>
              <div className="list-card">
                {r.referrals.map((f, i) => (
                  <div key={i} className="list-row">
                    <span className="row-ic"><FriendsIcon /></span>
                    <span className="list-row-main"><span className="list-row-title">{f.name}</span><span className="list-row-sub">Joined {dm(f.at)}</span></span>
                    <span className={'tag' + (f.status === 'rewarded' ? ' cm-tag-ok' : '')}>{f.status === 'rewarded' ? 'Reward earned' : 'Yet to buy a pass'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {r.referredBy ? (
            <p className="panel-soft">You joined with {r.referredBy}’s code. Welcome to the club!</p>
          ) : r.enabled ? (
            <form className="group" onSubmit={doClaim}>
              <div className="group-label">Got a friend’s code?</div>
              <div className="cm-code-row">
                <input className="input" value={claim} onChange={(e) => setClaim(e.target.value.toUpperCase())} placeholder="Their code" aria-label="Friend’s referral code" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
                <button className="btn soft" disabled={busy || !claim.trim()}>{busy ? 'Adding…' : 'Add'}</button>
              </div>
              <p className="fine muted mt-8">For new clients, before your first pass.</p>
            </form>
          ) : null}
          {r.rewardKind === 'credit' && r.earnedCents > 0 && (
            <button className="btn ghost block" onClick={() => goFlow(nav, '/gift-cards', { label: 'Bring a friend', where: '/refer' })}>See your credit</button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Passes tab: gift cards + "use a code" checkout (client.shop slot)
export function ShopExtras() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  if (!commerce()) return null;
  const go = (to: string) => goFlow((p) => { location.hash = p; }, to, { label: 'Passes', where: '/passes' });
  return (
    <section className="cm-shop">
      <SectionHead title={<>Give the gift of <em>movement</em></>} sub="E-gift cards for any amount, sent by email on the day you choose." />
      <button className="cm-gift-banner" onClick={() => go('/gift-cards/buy')} aria-label="Buy a gift card">
        <ECard amountCents={10000} to="Someone special" from={app.client.firstName} />
        <span className="btn block">Buy a gift card <Arrow /></span>
      </button>
      <div className="list-card mt-20">
        <button className="list-row" onClick={() => setOpen(true)}>
          <span className="row-ic"><Icon name="ticket" size={20} /></span>
          <span className="list-row-main"><span className="list-row-title">Have a code?</span><span className="list-row-sub">Use a promo code, gift card or credit on a pass or extra</span></span>
          <Icon name="chevron" size={18} className="faint" />
        </button>
        <button className="list-row" onClick={() => go('/gift-cards')}>
          <span className="row-ic"><GiftIcon /></span>
          <span className="list-row-main"><span className="list-row-title">Your gift cards</span><span className="list-row-sub">Balances, codes and cards you’ve sent</span></span>
          <Icon name="chevron" size={18} className="faint" />
        </button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} label="Use a code">
        {open && <CodeCheckout onClose={() => setOpen(false)} />}
      </Sheet>
    </section>
  );
}

function CodeCheckout({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const products = useData(() => store.listProducts(), []);
  const intro = useData(() => store.isIntroEligible(app.client.id), [app.client.id]);
  const [productId, setProductId] = useState<string>('');
  const [promoIn, setPromoIn] = useState('');
  const [promo, setPromo] = useState('');
  const [giftIn, setGiftIn] = useState('');
  const [gifts, setGifts] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [step, setStep] = useState<'build' | 'pay' | 'done'>('build');
  const [busy, setBusy] = useState<false | 'pay' | 'apple'>(false);
  const [sale, setSale] = useState<Sale | null>(null);
  useBackHandler(step === 'pay', () => setStep('build'));

  const list = useMemo(() => (products.data ?? []).filter((p) => p.active && p.kind !== 'membership' && (p.kind !== 'intro' || intro.data) && !(p.kind === 'retail' && p.stock === 0))
    .sort((a, b) => (a.kind === 'retail' ? 1 : 0) - (b.kind === 'retail' ? 1 : 0) || a.sortOrder - b.sortOrder), [products.data, intro.data]);
  const product: Product | undefined = list.find((p) => p.id === productId);

  useEffect(() => {
    let live = true;
    if (!productId) { setQuote(null); return; }
    needCommerce().quote({ items: [{ productId, qty: 1 }], ...(promo ? { promoCode: promo } : {}), ...(gifts.length ? { giftCodes: gifts } : {}) })
      .then((q) => { if (live) setQuote(q); }, (e) => { if (live) toast(errorMessage(e)); });
    return () => { live = false; };
  }, [productId, promo, gifts.join('|')]);

  const applyPromo = (e: React.FormEvent) => { e.preventDefault(); setPromo(normalisePromoCode(promoIn)); };
  const addGift = (e: React.FormEvent) => {
    e.preventDefault();
    const c = normaliseGiftCode(giftIn) || giftIn.trim().toUpperCase();
    if (c && !gifts.includes(c)) setGifts([...gifts, c]);
    setGiftIn('');
  };
  const giftErr = (code: string) => quote?.giftErrors.find((g) => g.code === code)?.message;
  const ok = !!quote && !quote.promoError && quote.giftErrors.length === 0 && (!!promo || gifts.length > 0);

  const buy = async (via: 'pay' | 'apple') => {
    if (!product) return;
    setBusy(via);
    try {
      if (quote && quote.totalCents > 0) await new Promise((r) => setTimeout(r, 650));
      const r = await needCommerce().purchaseWithCodes({ productId: product.id, ...(promo ? { promoCode: promo } : {}), ...(gifts.length ? { giftCodes: gifts } : {}) });
      if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
      if (r.sale) { setSale(r.sale); setStep('done'); }
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };

  if (step === 'done' && sale) {
    return (
      <>
        <SheetHead onClose={onClose} />
        <div className="success">
          <div className="success-mark"><Flower size={64} className="bloom" /></div>
          <h2>You’re all <em>set</em></h2>
          <p className="muted">{product?.kind === 'retail' ? 'Grab it from the front desk next time you’re in.' : 'Your pass is in the Passes tab, ready to book.'}</p>
          <Receipt sale={sale} />
          <button className="btn block" onClick={() => leaveSheets(() => { location.hash = product?.kind === 'retail' ? '/passes' : '/'; })}>{product?.kind === 'retail' ? 'Done' : 'Book a class'}</button>
        </div>
      </>
    );
  }

  if (step === 'pay' && quote && product) {
    return (
      <div className="stack lg">
        <SheetHead back={{ label: 'Your codes', onClick: () => setStep('build') }} eyebrow="Checkout" title={<>{money(quote.totalCents, { cents: true })} <span className="muted-serif">· {product.name}</span></>} onClose={onClose} />
        <PayStep amountCents={quote.totalCents} busy={busy} onPay={buy} note={`${money(quote.promoCents + quote.giftCents, { cents: true })} taken off with your codes.`} />
      </div>
    );
  }

  return (
    <div className="stack lg">
      <SheetHead eyebrow="Shop" title={<Accent text="Use a code" />} onClose={onClose} />
      <fieldset className="cm-fs">
        <legend>What would you like?</legend>
        {!products.data ? <CardSkeletons n={2} h={60} /> : (
          <div className="picker-list">
            {list.map((p) => (
              <button key={p.id} type="button" className={'picker-opt' + (p.id === productId ? ' on' : '')} onClick={() => setProductId(p.id)}>
                <span className="radio" />
                <span className="picker-main"><span className="picker-name">{p.name}</span><span className="muted">{p.kind === 'retail' ? 'Studio extra' : p.kind === 'intro' ? 'New clients only' : p.kind === 'dropin' ? 'Single class' : 'Class pack'}</span></span>
                <span className="serif cm-price">{money(p.priceCents)}</span>
              </button>
            ))}
          </div>
        )}
        <p className="fine muted">Memberships are billed weekly, so codes can’t be used on them here.</p>
      </fieldset>

      <form className="cm-fs" onSubmit={applyPromo}>
        <div className="cm-legend">Promo code</div>
        <div className="cm-code-row">
          <input className="input" value={promoIn} onChange={(e) => setPromoIn(e.target.value.toUpperCase())} placeholder="e.g. SPRING" aria-label="Promo code" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          {promo ? <button type="button" className="btn soft" onClick={() => { setPromo(''); setPromoIn(''); }}>Remove</button> : <button className="btn soft" disabled={!promoIn.trim()}>Apply</button>}
        </div>
        {promo && productId && quote?.promoError && <p className="form-error">{quote.promoError}</p>}
        {promo && !productId && <p className="fine muted">Choose what you’d like and we’ll check the code.</p>}
      </form>

      <form className="cm-fs" onSubmit={addGift}>
        <div className="cm-legend">Gift card or credit</div>
        {gifts.map((g) => (
          <div key={g} className="cm-applied">
            <span className="cm-code">{g}</span>
            <span className="grow fine">{giftErr(g) ? <span className="danger-text">{giftErr(g)}</span> : quote?.gifts.find((x) => x.code === g) ? <>−{money(quote.gifts.find((x) => x.code === g)!.appliedCents, { cents: true })} <span className="muted">of {money(quote.gifts.find((x) => x.code === g)!.balanceCents, { cents: true })}</span></> : productId ? '' : <span className="muted">Choose something first</span>}</span>
            <button type="button" className="icon-btn" onClick={() => setGifts(gifts.filter((x) => x !== g))} aria-label={`Remove ${g}`}><Icon name="close" size={18} /></button>
          </div>
        ))}
        <div className="cm-code-row">
          <input className="input" value={giftIn} onChange={(e) => setGiftIn(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" aria-label="Gift card code" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          <button className="btn soft" disabled={!giftIn.trim()}>Add</button>
        </div>
      </form>

      {quote && product && (
        <div className="cm-sum">
          <div><span>{product.name}</span><span>{money(quote.subtotalCents, { cents: true })}</span></div>
          {quote.promo && quote.promoCents > 0 && <div><span>Promo {quote.promo.code} · {quote.promo.label}</span><span>−{money(quote.promoCents, { cents: true })}</span></div>}
          {quote.giftCents > 0 && <div><span>Gift cards and credit</span><span>−{money(quote.giftCents, { cents: true })}</span></div>}
          <div className="cm-sum-total"><span>To pay</span><span>{money(quote.totalCents, { cents: true })}</span></div>
        </div>
      )}
      <button className="btn block big" disabled={!ok || !!busy} onClick={() => (quote!.totalCents > 0 ? setStep('pay') : buy('pay'))}>
        {!product ? 'Choose what you’d like' : !(promo || gifts.length) ? 'Add a code' : !ok ? 'Check your codes' : busy ? 'One moment…' : quote!.totalCents > 0 ? <>Continue to payment <Arrow /></> : 'Complete with your codes'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ ?ref=CODE: remember it, and claim it once signed in
const REF_KEY = 'spc-commerce-ref';
export function captureReferral() {
  try {
    const fromSearch = new URLSearchParams(location.search).get('ref');
    const h = location.hash.indexOf('?');
    const fromHash = h >= 0 ? new URLSearchParams(location.hash.slice(h + 1)).get('ref') : null;
    const code = (fromSearch || fromHash || '').trim();
    if (code && /^[A-Za-z0-9-]{4,24}$/.test(code)) localStorage.setItem(REF_KEY, code.toUpperCase());
  } catch { /* storage blocked: nothing to remember */ }
}

/** Invisible: lives in the timetable slot, so it runs once the client is signed in. */
export function ReferralClaimer() {
  const toast = useToast();
  useEffect(() => {
    let code: string | null = null;
    try { code = localStorage.getItem(REF_KEY); } catch { return; }
    const cm = commerce();
    if (!code || !cm) return;
    const forget = () => { try { localStorage.removeItem(REF_KEY); } catch { /* */ } };
    cm.myReferral().then((r) => {
      if (r.referredBy || !r.enabled || r.code === code) { forget(); return; }
      return cm.claimReferral(code!).then((x) => { forget(); toast(`Welcome! You joined with ${x.referrerName}’s code.`); });
    }).catch(() => forget());
  }, []);
  return null;
}
