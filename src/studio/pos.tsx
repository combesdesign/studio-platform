import React, { useEffect, useRef, useState } from 'react';
import { Sheet, store, useAction, useData, useToast } from '../shared/react';
import { gstOf, money } from '../shared/format';
import type { Client, Pass, PaymentMethod, Product, Sale } from '../shared/types';
import { FlowerStars, Logo } from '../shared/brand';
import { Avatar, BackLink, Icon, Loading, PageHead, Seg, SheetHead, backFrom, cx, dateTime, fullName, toCents, useStudio, type BackTo } from './ui';
import { ClientSearch, MethodPicker, NewClientSheet, productKindLabel } from './book';
import { METHOD_LABEL } from './clients';

const KIND_ORDER: Product['kind'][] = ['intro', 'dropin', 'pack', 'membership', 'retail'];
type Line = { productId: string; qty: number };

export function Pos({ clientId }: { clientId?: string }) {
  const { me, can } = useStudio();
  const toast = useToast();
  const prods = useData(() => store.listProducts(), []);
  const [cart, setCart] = useState<Line[]>([]);
  const [client, setClient] = useState<Client | null>(null);
  const [pick, setPick] = useState<null | 'search' | 'new' | 'search-new'>(null); // search-new: New client opened from the search
  const [discType, setDiscType] = useState<'$' | '%'>('$');
  const [disc, setDisc] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('card_reader');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<{ sale: Sale; passes: Pass[]; client: Client | null } | null>(null);
  const { busy, run } = useAction();
  const cartRef = useRef<HTMLDivElement>(null);
  const [cartInView, setCartInView] = useState(false);
  useEffect(() => {
    const el = cartRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setCartInView(!!e && e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [prods.data]);

  const preset = useData(() => (clientId ? store.getClient(clientId) : Promise.resolve(null)), [clientId]);
  useEffect(() => { if (preset.data) setClient(preset.data); }, [preset.data]);
  const intro = useData(() => (client ? store.isIntroEligible(client.id) : Promise.resolve(true)), [client?.id]);

  const products = prods.data ?? [];
  const byId = (id: string) => products.find((p) => p.id === id);
  const groups = KIND_ORDER.map((k) => [k, products.filter((p) => p.kind === k).sort((a, b) => a.sortOrder - b.sortOrder)] as const).filter(([, l]) => l.length);

  const lines = cart.map((l) => ({ ...l, p: byId(l.productId)! })).filter((l) => l.p);
  const subtotal = lines.reduce((n, l) => n + l.p.priceCents * l.qty, 0);
  const discCents = Math.min(subtotal, discType === '$' ? toCents(disc) : Math.round((subtotal * Math.min(100, parseFloat(disc) || 0)) / 100));
  const total = method === 'comp' ? 0 : subtotal - discCents;
  const needsClient = lines.some((l) => l.p.kind !== 'retail');
  const count = lines.reduce((n, l) => n + l.qty, 0);

  const add = (p: Product) => {
    if (p.kind === 'intro' && client && intro.data === false) { toast(`${client.firstName} has already had a class pass, so the intro offer isn't available`); return; }
    setCart((c) => {
      const ex = c.find((l) => l.productId === p.id);
      if (ex) {
        if (p.kind !== 'retail') { toast('Class passes are one per sale'); return c; }
        if (p.stock != null && ex.qty >= p.stock) { toast(`Only ${p.stock} in stock`); return c; }
        return c.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...c, { productId: p.id, qty: 1 }];
    });
  };
  const setQty = (id: string, q: number) => setCart((c) => (q <= 0 ? c.filter((l) => l.productId !== id) : c.map((l) => (l.productId === id ? { ...l, qty: q } : l))));
  const reset = () => { setCart([]); setDisc(''); setNote(''); setMethod('card_reader'); setReceipt(null); if (!clientId) setClient(null); };

  const charge = async () => {
    const r = await run(() => store.checkoutCart({
      clientId: client?.id, items: cart, method, staffId: me.staffId,
      discountCents: method === 'comp' ? subtotal : discCents || undefined, note: note.trim() || undefined,
    }));
    if (r) setReceipt({ ...r, client });
  };

  // Opened for a client (from their profile): back to that client.
  const who = preset.data?.firstName ?? 'Client';
  const back: BackTo | undefined = clientId ? backFrom((r) => (r === `/clients/${clientId}` ? who : null), { href: `#/clients/${clientId}`, label: who }) : undefined;

  if (receipt) return <Receipt r={receipt} onNew={reset} back={back} />;

  return (
    <div className="pos">
      <PageHead back={back} eyebrow="Point of sale" title={<>Make a <em>sale</em></>} sub="Tap products to add them to the cart." />
      {prods.loading && !prods.data ? <Loading /> : (
        <div className="pos-grid">
          <div className="pos-products">
            {groups.map(([k, list]) => (
              <section key={k} className="pg">
                <div className="eyebrow">{productKindLabel(k)}</div>
                <div className="tiles">
                  {list.map((p) => {
                    const inCart = cart.find((l) => l.productId === p.id)?.qty ?? 0;
                    const out = p.kind === 'retail' && p.stock != null && p.stock <= 0;
                    const notEligible = p.kind === 'intro' && !!client && intro.data === false;
                    return (
                      <button key={p.id} className={cx('tile', !!p.highlight && 'pick', inCart > 0 && 'in', (out || notEligible) && 'off', `k-${p.kind}`)} onClick={() => add(p)} disabled={out}>
                        {p.highlight && <span className="tile-badge">{p.highlight}</span>}
                        {inCart > 0 && <span className="tile-qty">{inCart}</span>}
                        <span className="tile-name">{p.name}</span>
                        <span className="tile-desc">{notEligible ? 'Not eligible (had a pass before)' : p.kind === 'retail' ? (p.stock != null ? (out ? 'Out of stock' : `${p.stock} in stock`) : p.description) : passBlurb(p)}</span>
                        <span className="tile-price">{money(p.priceCents)}{p.kind === 'membership' ? <span>/{p.billingInterval ?? 'week'}</span> : null}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="pos-cart card" ref={cartRef}>
            <div className="pc-client">
              {client ? (
                <div className="pc-who">
                  <Avatar name={fullName(client)} photo={client.photoUrl} size={44} />
                  <div className="grow"><strong>{fullName(client)}</strong><div className="muted small">{client.email}</div></div>
                  <button className="btn sm ghost" onClick={() => setClient(null)}>Change</button>
                </div>
              ) : (
                <div className="pc-noclient">
                  <button className="btn soft block" onClick={() => setPick('search')}><Icon name="search" size={18} />Add client</button>
                  <p className={cx('small', needsClient ? 'warn-text' : 'faint')}>{needsClient ? 'Class passes need a client.' : 'Optional for retail.'}{can('editClients') && <> <button className="linkish" onClick={() => setPick('new')}>New client</button></>}</p>
                </div>
              )}
            </div>

            <div className="pc-lines">
              {lines.length === 0 ? <p className="faint pc-empty">Cart is empty</p> : lines.map((l) => (
                <div key={l.productId} className="pc-line">
                  <div className="grow"><strong>{l.p.name}</strong><div className="faint small">{money(l.p.priceCents)}{l.p.kind === 'membership' ? ' first week' : ''}</div></div>
                  {l.p.kind === 'retail' ? (
                    <div className="mini-step">
                      <button onClick={() => setQty(l.productId, l.qty - 1)} aria-label="One less"><Icon name="minus" size={16} /></button>
                      <span>{l.qty}</span>
                      <button onClick={() => add(l.p)} aria-label="One more"><Icon name="plus" size={16} /></button>
                    </div>
                  ) : <button className="pc-x" onClick={() => setQty(l.productId, 0)} aria-label={`Remove ${l.p.name}`}><Icon name="x" size={16} /></button>}
                  <span className="pc-amt">{money(l.p.priceCents * l.qty)}</span>
                </div>
              ))}
            </div>

            {lines.length > 0 && (
              <>
                <div className="pc-disc">
                  <span className="muted small">Discount</span>
                  <Seg value={discType} onChange={setDiscType} options={[{ value: '$', label: '$' }, { value: '%', label: '%' }]} className="sm" />
                  <input className="input sm" inputMode="decimal" value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="0" aria-label="Discount" disabled={method === 'comp'} />
                </div>
                <MethodPicker value={method} onChange={setMethod} />
                {method === 'card_reader' && <p className="pc-hint"><Icon name="card" size={16} />Run the card on the studio terminal, then tap Charge to record it. Stripe tap-to-pay is coming later.</p>}
                {method === 'comp' && <p className="pc-hint"><Icon name="gift" size={16} />Recorded as complimentary, $0 total.</p>}
                <input className="input sm pc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
                <div className="pc-totals">
                  <div><span>Subtotal</span><span>{money(subtotal, { cents: true })}</span></div>
                  {(discCents > 0 || method === 'comp') && <div><span>Discount</span><span>−{money(method === 'comp' ? subtotal : discCents, { cents: true })}</span></div>}
                  <div className="pc-total"><span>Total</span><span>{money(total, { cents: true })}</span></div>
                  <div className="faint small"><span>Includes GST</span><span>{money(gstOf(total), { cents: true })}</span></div>
                </div>
                <button className="btn block pc-charge" disabled={busy || (needsClient && !client)} onClick={charge}>
                  {busy ? 'Processing…' : needsClient && !client ? 'Add a client to continue' : method === 'comp' ? 'Complete comp sale' : `Charge ${money(total, { cents: true })}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {lines.length > 0 && !cartInView && (
        <button className="pos-bar" onClick={() => cartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <span>{count} item{count === 1 ? '' : 's'}</span><strong>{money(total, { cents: true })}</strong><span className="pb-go">Checkout<Icon name="down" size={16} /></span>
        </button>
      )}

      <Sheet open={pick === 'search'} onClose={() => setPick(null)} label="Choose client">
        <SheetHead title={<>Choose a <em>client</em></>} onClose={() => setPick(null)} />
        <ClientSearch autoFocus onPick={(c) => { setClient(c); setPick(null); }} />
        {can('editClients') && <div className="sh-foot"><button className="btn ghost" onClick={() => setPick('search-new')}><Icon name="userPlus" size={18} />New client</button></div>}
      </Sheet>
      <NewClientSheet open={pick === 'new' || pick === 'search-new'} onClose={() => setPick(null)} onCreated={(c) => { setClient(c); setPick(null); }}
        onBack={pick === 'search-new' ? () => setPick('search') : undefined} backLabel="Choose a client" />
    </div>
  );
}

function passBlurb(p: Product): string {
  if (p.kind === 'membership') return p.credits == null ? 'Unlimited classes' : `${p.credits} class${p.credits === 1 ? '' : 'es'} a week`;
  if (p.kind === 'intro') return `Unlimited for ${p.validityDays ?? 14} days`;
  const c = p.credits ?? 1;
  const v = p.validityDays ? `, ${Math.round(p.validityDays / 30.5)} mo` : '';
  return `${c} class${c === 1 ? '' : 'es'}${v}`;
}

function Receipt({ r, onNew, back }: { r: { sale: Sale; passes: Pass[]; client: Client | null }; onNew: () => void; back?: BackTo }) {
  const { settings } = useStudio();
  const s = r.sale;
  const sub = s.items.reduce((n, i) => n + i.unitCents * i.qty, 0);
  const disc = sub - s.totalCents;
  return (
    <div className="receipt-wrap">
      {back && <BackLink {...back} className="ph-back no-print" />}
      <div className="rc-done no-print"><span className="rc-tick"><Icon name="check" size={30} /></span><h1>All <em>done</em></h1><p className="muted">{s.method === 'comp' ? 'Comp sale recorded.' : `${money(s.totalCents, { cents: true })} paid by ${(METHOD_LABEL[s.method] ?? s.method).toLowerCase()}.`}{r.passes.length ? ` ${r.passes.map((p) => p.name).join(', ')} added to ${r.client?.firstName}'s account.` : ''}</p></div>
      <article className="receipt card">
        <Logo className="rc-logo" />
        <div className="rc-studio">
          <div>{settings.name || 'Snowy Pilates Club'}</div>
          <div>{settings.address}</div>
          {settings.abn && <div>ABN {settings.abn}</div>}
        </div>
        <div className="rc-title">Tax invoice</div>
        <div className="rc-meta"><span>{dateTime(s.createdAt)}</span><span>#{s.id.slice(-6).toUpperCase()}</span></div>
        {r.client && <div className="rc-meta"><span>Client</span><span>{fullName(r.client)}</span></div>}
        <div className="rc-items">
          {s.items.map((i, k) => <div key={k}><span>{i.qty > 1 ? `${i.qty} × ` : ''}{i.name}</span><span>{money(i.unitCents * i.qty, { cents: true })}</span></div>)}
          {disc > 0 && <div><span>Discount</span><span>−{money(disc, { cents: true })}</span></div>}
        </div>
        <div className="rc-total"><span>Total</span><span>{money(s.totalCents, { cents: true })}</span></div>
        {settings.gstRegistered !== false && <div className="rc-gst">Total includes GST of {money(gstOf(s.totalCents), { cents: true })}</div>}
        <div className="rc-meta"><span>Paid by</span><span>{METHOD_LABEL[s.method] ?? s.method}</span></div>
        <div className="rc-thanks"><FlowerStars count={5} size={12} /><p>Thank you for moving with us.</p></div>
      </article>
      <div className="rc-actions no-print">
        <button className="btn soft" onClick={() => window.print()}><Icon name="print" size={20} />Print</button>
        {r.client && <a className="btn soft" href={`#/clients/${r.client.id}`}>View {r.client.firstName}</a>}
        <button className="btn" onClick={onNew}><Icon name="plus" size={20} />New sale</button>
      </div>
    </div>
  );
}

