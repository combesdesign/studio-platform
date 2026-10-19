/** Studio › Shop: gift cards, promo codes, referrals and retail stock, one tab each (#/shop/<tab>). */
import React, { useMemo, useState } from 'react';
import { Sheet, store, useAction, useData, useToast } from '../../../shared/react';
import { addDays, money, studioDate } from '../../../shared/format';
import { Empty, Icon, Loading, PageHead, Seg, SheetHead, cx, fullName, replaceRoute, useStudio } from '../../../studio/ui';
import { ClientSearch, MethodPicker } from '../../../studio/book';
import type { Client, PaymentMethod } from '../../../shared/types';
import { GIFT_STATE_TONE, copyText, dm, dmTime, dmy, inputToCents, needCommerce } from '../api';
import { ECard } from '../ecard';
import { EMAIL_RE, GIFT_STATE_LABEL } from '../logic';
import type { GiftCard, GiftCardDetail } from '../types';
import { PromosTab } from './promos';
import { ReferralsTab } from './referrals';
import { StockTab } from './stock';
import { Kpi, Tone } from './bits';

const TABS = [
  { key: 'gift-cards', label: 'Gift cards', perm: 'commerce.view' },
  { key: 'promos', label: 'Promo codes', perm: 'commerce.view' },
  { key: 'referrals', label: 'Referrals', perm: 'commerce.view' },
  { key: 'stock', label: 'Retail stock', perm: 'commerce.stock' },
];

export function ShopPage({ tab }: { tab?: string }) {
  const { can } = useStudio();
  const tabs = TABS.filter((t) => can(t.perm));
  const cur = tabs.find((t) => t.key === tab)?.key ?? tabs[0]?.key ?? 'gift-cards';
  return (
    <div className="cm-page">
      <PageHead eyebrow="Shop" title={<>Gift cards &amp; <em>extras</em></>} sub="Gift cards, promo codes, referral rewards and the retail shelf." />
      <nav className="tabs" aria-label="Shop sections">
        {tabs.map((t) => (
          <a key={t.key} href={`#/shop/${t.key}`} className={cx(cur === t.key && 'on')} aria-current={cur === t.key ? 'page' : undefined}
            onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); replaceRoute(`/shop/${t.key}`); }}>{t.label}</a>
        ))}
      </nav>
      {cur === 'gift-cards' && <GiftCardsTab />}
      {cur === 'promos' && <PromosTab />}
      {cur === 'referrals' && <ReferralsTab />}
      {cur === 'stock' && <StockTab />}
    </div>
  );
}

// ------------------------------------------------------------------ gift cards
type Filter = 'active' | 'all' | 'scheduled' | 'done';
function GiftCardsTab() {
  const { can } = useStudio();
  const cards = useData(() => needCommerce().listGiftCards(), []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [open, setOpen] = useState<string | null>(null);
  const [sell, setSell] = useState(false);
  const list = cards.data ?? [];
  const today = studioDate();
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/[^a-z0-9@. ]/g, '');
    return list.filter((c) => {
      if (filter === 'active' && c.state !== 'active') return false;
      if (filter === 'scheduled' && !(c.state === 'active' && c.recipientEmail && !c.sentAt)) return false;
      if (filter === 'done' && (c.state === 'active' || c.state === 'pending')) return false;
      if (!s) return true;
      return [c.code.replace(/-/g, ''), c.recipientName, c.recipientEmail, c.purchaserName, c.fromName].some((x) => (x ?? '').toLowerCase().replace(/-/g, '').includes(s.replace(/ /g, '')) || (x ?? '').toLowerCase().includes(s));
    });
  }, [list, q, filter]);
  const active = list.filter((c) => c.state === 'active');
  const outstanding = active.reduce((n, c) => n + c.balanceCents, 0);
  const since = addDays(today, -30);
  const sold30 = list.filter((c) => c.kind === 'gift_card' && c.source !== 'studio' && studioDate(c.createdAt) >= since);
  const scheduled = active.filter((c) => c.recipientEmail && !c.sentAt);

  if (cards.error && !cards.data) return <Empty title="That didn’t load">{cards.error.message}</Empty>;
  if (!cards.data) return <Loading />;
  return (
    <>
      <div className="cm-kpis">
        <Kpi tone="hero" label="Owing on cards" value={money(outstanding)} sub={`${active.length} active card${active.length === 1 ? '' : 's'} and credits`} />
        <Kpi label="Sold, last 30 days" value={money(sold30.reduce((n, c) => n + c.initialCents, 0))} sub={`${sold30.length} card${sold30.length === 1 ? '' : 's'}`} />
        <Kpi label="Waiting to send" value={scheduled.length} sub={scheduled[0]?.sendOn ? `Next on ${dm(scheduled[0].sendOn)}` : 'Emails go out on the day'} />
        <Kpi tone="mist" label="Redeemed so far" value={money(list.filter((c) => c.state !== 'void').reduce((n, c) => n + Math.max(0, c.initialCents - c.balanceCents), 0))} sub="Across every card" />
      </div>
      <div className="toolbar">
        <label className="search-in grow"><Icon name="search" size={18} /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, name or email" aria-label="Search gift cards" /></label>
        <Seg value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'done', label: 'Used & expired' }, { value: 'all', label: 'All' }]} />
        {can('commerce.sell') && <button className="btn" onClick={() => setSell(true)}><Icon name="plus" size={18} />Sell a gift card</button>}
      </div>
      {shown.length === 0 ? <Empty title="No gift cards here">{q ? 'Nothing matches that search.' : 'Cards sold in the app or at the front desk show up here.'}</Empty> : (
        <div className="card cm-list">
          {shown.map((c) => <GiftRow key={c.id} c={c} onOpen={() => setOpen(c.id)} />)}
        </div>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} label="Gift card">
        {open && <GiftCardSheet id={open} onClose={() => setOpen(null)} />}
      </Sheet>
      <SellGiftCardSheet open={sell} onClose={() => setSell(false)} />
    </>
  );
}

function GiftRow({ c, onOpen }: { c: GiftCard; onOpen: () => void }) {
  const who = c.kind === 'credit' ? `${c.recipientName ?? 'Client'} (credit)` : c.recipientName || c.purchaserName || 'Front desk sale';
  const sub = c.kind === 'credit' ? 'Referral reward'
    : c.source === 'pos' ? `Sold at the desk ${dm(c.createdAt)}` : c.source === 'studio' ? `Issued by the studio ${dm(c.createdAt)}`
      : `From ${c.purchaserName ?? c.fromName ?? 'a client'} · ${c.sentAt ? `sent ${dm(c.sentAt)}` : c.sendOn ? `sends ${dm(c.sendOn)}` : dm(c.createdAt)}`;
  const pct = c.initialCents > 0 ? Math.max(0, Math.min(100, Math.round((c.balanceCents / c.initialCents) * 100))) : 0;
  return (
    <button className="cm-row" onClick={onOpen}>
      <span className="cm-code">{c.code}</span>
      <span className="cm-row-main"><strong>{who}</strong><span>{sub}</span></span>
      <span className="cm-row-bal">
        <strong>{money(c.balanceCents, { cents: c.balanceCents % 100 !== 0 })}</strong>
        <span className="cm-meter" aria-hidden="true"><span style={{ width: pct + '%' }} /></span>
        <span className="faint">of {money(c.initialCents)}</span>
      </span>
      <Tone tone={GIFT_STATE_TONE[c.state]}>{GIFT_STATE_LABEL[c.state]}</Tone>
      <Icon name="right" size={18} className="faint cm-row-go" />
    </button>
  );
}

const ENTRY_LABEL: Record<string, string> = { issue: 'Issued', redeem: 'Used', adjust: 'Adjusted', void: 'Voided', refund: 'Refunded' };

function GiftCardSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useStudio();
  const toast = useToast();
  const d = useData(() => needCommerce().getGiftCard(id), [id]);
  const [mode, setMode] = useState<null | 'adjust' | 'void' | 'resend'>(null);
  const [dir, setDir] = useState<'add' | 'remove'>('add');
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  const [email, setEmail] = useState('');
  const { busy, run } = useAction();
  const c: GiftCardDetail | undefined = d.data;
  if (d.error && !c) return <><SheetHead title="Gift card" onClose={onClose} /><p className="form-err">{d.error.message}</p></>;
  if (!c) return <><SheetHead title="Gift card" onClose={onClose} /><Loading /></>;
  const done = () => { setMode(null); setAmt(''); setReason(''); };
  const adjust = async () => { const cents = inputToCents(amt) * (dir === 'add' ? 1 : -1); if (await run(() => needCommerce().adjustGiftCard(c.id, cents, reason), 'Balance updated')) done(); };
  const voidIt = async () => { if (await run(() => needCommerce().voidGiftCard(c.id, reason), 'Gift card voided')) done(); };
  const resend = async () => { if (await run(() => needCommerce().resendGiftCard(c.id, email.trim() || undefined), 'Gift card email sent')) done(); };
  const manage = can('commerce.manage');
  return (
    <>
      <SheetHead title={<>{money(c.balanceCents, { cents: true })} <em>left</em></>} sub={`${c.kind === 'credit' ? 'Account credit' : 'Gift card'} · ${GIFT_STATE_LABEL[c.state]}${c.expiresAt ? ` · expires ${dmy(c.expiresAt)}` : ''}`} onClose={onClose} />
      <div className="stack lg">
        <ECard amountCents={c.initialCents} balanceCents={c.balanceCents} to={c.recipientName} from={c.fromName} message={c.message} code={c.code} state={c.state} label={c.kind === 'credit' ? 'Account credit' : 'Gift card'} full />
        <div className="cm-facts">
          <div><span>Code</span><button className="linkish" onClick={async () => toast((await copyText(c.code)) ? 'Code copied' : 'Couldn’t copy')}>{c.code}</button></div>
          {c.purchaserName && <div><span>Bought by</span><a className="linkish" href={`#/clients/${c.purchaserClientId}`}>{c.purchaserName}</a></div>}
          {c.recipientEmail && <div><span>Email</span><span>{c.recipientEmail} · {c.sentAt ? `sent ${dmTime(c.sentAt)}` : `sends ${dm(c.sendOn ?? studioDate())}`}</span></div>}
          <div><span>Created</span><span>{dmy(c.createdAt)}</span></div>
        </div>

        {c.status === 'active' && !mode && (
          <div className="cm-actions">
            {c.recipientEmail || c.kind === 'gift_card' ? can('commerce.sell') && <button className="btn soft" onClick={() => { setMode('resend'); setEmail(c.recipientEmail ?? ''); }}><Icon name="mail" size={18} />{c.sentAt ? 'Resend email' : 'Send now'}</button> : null}
            {manage && <button className="btn soft" onClick={() => setMode('adjust')}><Icon name="edit" size={18} />Adjust balance</button>}
            {manage && <button className="btn danger" onClick={() => setMode('void')}><Icon name="ban" size={18} />Void</button>}
          </div>
        )}
        {mode === 'adjust' && (
          <div className="panel stack">
            <Seg value={dir} onChange={setDir} options={[{ value: 'add', label: 'Add money' }, { value: 'remove', label: 'Take money off' }]} />
            <div className="form-grid">
              <label className="field"><span>Amount</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" /></div></label>
              <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Class cancelled by us" /></label>
            </div>
            <div className="cm-actions"><button className="btn ghost" onClick={done}>Cancel</button><button className="btn" disabled={busy || !inputToCents(amt) || !reason.trim()} onClick={adjust}>{dir === 'add' ? 'Add' : 'Take off'} {inputToCents(amt) ? money(inputToCents(amt), { cents: true }) : ''}</button></div>
          </div>
        )}
        {mode === 'void' && (
          <div className="panel stack">
            <p>Voiding writes off the {money(c.balanceCents, { cents: true })} left and the code stops working. This can’t be undone.</p>
            <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Refunded to the buyer" /></label>
            <div className="cm-actions"><button className="btn ghost" onClick={done}>Keep it</button><button className="btn danger-solid" disabled={busy || !reason.trim()} onClick={voidIt}>Void gift card</button></div>
          </div>
        )}
        {mode === 'resend' && (
          <div className="panel stack">
            <label className="field"><span>Send to</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
            <div className="cm-actions"><button className="btn ghost" onClick={done}>Cancel</button><button className="btn" disabled={busy || !EMAIL_RE.test(email.trim())} onClick={resend}><Icon name="mail" size={18} />Send gift card</button></div>
          </div>
        )}

        <section>
          <h3 className="cm-h3">History</h3>
          <div className="cm-ledger">
            {c.entries.map((e) => (
              <div key={e.id} className="cm-led">
                <span className="cm-led-t"><strong>{ENTRY_LABEL[e.kind] ?? e.kind}{e.state === 'held' ? ' (at the till)' : ''}</strong><span>{e.note ?? ''}{e.staffName ? ` · ${e.staffName}` : ''}</span></span>
                <span className="faint">{dmTime(e.at)}</span>
                <span className={cx('cm-led-amt', e.cents < 0 && 'neg')}>{e.cents < 0 ? '−' : '+'}{money(Math.abs(e.cents), { cents: true })}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

export function SellGiftCardSheet({ open, onClose, clientId }: { open: boolean; onClose: () => void; clientId?: string }) {
  return (
    <Sheet open={open} onClose={onClose} label="Sell a gift card">
      {open && <SellBody onClose={onClose} clientId={clientId} />}
    </Sheet>
  );
}

function SellBody({ onClose, clientId }: { onClose: () => void; clientId?: string }) {
  const { can } = useStudio();
  const settings = useData(() => needCommerce().getSettings(), []);
  const preset = useData(() => (clientId ? store.getClient(clientId) : Promise.resolve(null)), [clientId]);
  const [amount, setAmount] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [client, setClient] = useState<Client | null>(null);
  const [pick, setPick] = useState(false);
  const [toName, setToName] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [message, setMessage] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('card_reader');
  const [sold, setSold] = useState<GiftCard | null>(null);
  const { busy, run } = useAction();
  const s = settings.data;
  const buyer = client ?? preset.data ?? null;
  const cents = custom ? inputToCents(custom) : amount ?? s?.giftCardAmounts[0] ?? 0;
  const tooSmall = !!s && (cents < s.giftCardMinCents || cents > s.giftCardMaxCents);
  const sell = async () => {
    const r = await run(() => needCommerce().sellGiftCard({
      amountCents: cents, method: method as 'card_reader' | 'cash' | 'comp', ...(buyer ? { clientId: buyer.id } : {}),
      ...(toName.trim() ? { recipientName: toName.trim() } : {}), ...(toEmail.trim() ? { recipientEmail: toEmail.trim() } : {}), ...(message.trim() ? { message: message.trim() } : {}),
      ...(buyer ? { fromName: buyer.firstName } : {}),
    }));
    if (r) setSold(r.card);
  };
  if (sold) {
    return (
      <>
        <SheetHead title={<>Gift card <em>ready</em></>} sub={sold.recipientEmail ? `Emailed to ${sold.recipientEmail}.` : 'Write the code on a card or print this page for them.'} onClose={onClose} />
        <ECard amountCents={sold.initialCents} to={sold.recipientName} from={sold.fromName} message={sold.message} code={sold.code} expiresAt={sold.expiresAt} full />
        <div className="sh-foot"><button className="btn soft" onClick={() => window.print()}><Icon name="print" size={18} />Print</button><button className="btn" onClick={onClose}>Done</button></div>
      </>
    );
  }
  if (pick) {
    return (
      <>
        <SheetHead title={<>Who’s <em>buying?</em></>} onClose={onClose} back={{ label: 'Gift card', onClick: () => setPick(false) }} />
        <ClientSearch autoFocus onPick={(c) => { setClient(c); setPick(false); }} />
      </>
    );
  }
  return (
    <>
      <SheetHead title={<>Sell a gift <em>card</em></>} sub="The code works in the app and at the front desk." onClose={onClose} />
      {!s ? <Loading /> : (
        <div className="stack lg">
          <div className="cm-amounts">
            {s.giftCardAmounts.map((a) => <button key={a} type="button" className={cx('cm-amt', !custom && (amount ?? s.giftCardAmounts[0]) === a && 'on')} onClick={() => { setAmount(a); setCustom(''); }}>{money(a)}</button>)}
            <div className="money-in cm-amt-custom"><span>$</span><input className="input" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="Other" aria-label="Other amount" /></div>
          </div>
          {tooSmall && <p className="form-err">Gift cards are {money(s.giftCardMinCents)} to {money(s.giftCardMaxCents)}.</p>}
          <div className="cm-buyer">
            {buyer ? <><span className="grow">Bought by <strong>{fullName(buyer)}</strong></span><button className="btn sm ghost" onClick={() => { setClient(null); setPick(true); }}>Change</button></>
              : <><span className="grow muted">Buyer (optional)</span><button className="btn sm soft" onClick={() => setPick(true)}><Icon name="search" size={16} />Add client</button></>}
          </div>
          <div className="form-grid">
            <label className="field"><span>For (optional)</span><input className="input" value={toName} onChange={(e) => setToName(e.target.value)} /></label>
            <label className="field"><span>Email it to (optional)</span><input className="input" type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} /></label>
            <label className="field span2"><span>Message (optional)</span><input className="input" value={message} onChange={(e) => setMessage(e.target.value.slice(0, 400))} /></label>
          </div>
          <MethodPicker value={method} onChange={(m) => setMethod(m === 'comp' && !can('commerce.manage') ? method : m)} />
          {method === 'comp' && <p className="muted small">A free card from the studio. No sale is recorded.</p>}
          <div className="sh-foot">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={busy || tooSmall || !cents || (!!toEmail.trim() && !EMAIL_RE.test(toEmail.trim()))} onClick={sell}>
              {busy ? 'Saving…' : method === 'comp' ? `Issue ${money(cents)} card` : `Charge ${money(cents, { cents: true })}`}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
