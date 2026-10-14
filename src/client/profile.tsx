/** Profile tab: details, health, marketing opt-in, receipts, studio info, install hint, sign out. */
import React, { useEffect, useState } from 'react';
import type { Sale } from '../shared/types';
import { store, useData, useToast, errorMessage, Sheet, useBackHandler } from '../shared/react';
import { money, studioDate } from '../shared/format';
import { Arrow, Avatar, Flower, Icon, Logo, SectionHead, SheetHead, Toggle, useApp } from './ui';
import { Receipt, ReceiptSkeleton } from './passes';
import { Policies } from './bookings';
import { dateShortNoDay, goFlow, isIOS, isNative, isStandalone, mapsUrl, saveClient, staffRole } from './lib';

type Nav = (to: string, o?: { replace?: boolean }) => void;

// Android/desktop Chrome install prompt (captured early in main.tsx).
let deferredPrompt: any = null;
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e: any) => { e.preventDefault(); deferredPrompt = e; });
}

export function Profile({ nav }: { nav: Nav }) {
  const app = useApp();
  const toast = useToast();
  const c = app.client;
  const [sheet, setSheet] = useState<'details' | 'history' | null>(null);
  const [savingOpt, setSavingOpt] = useState(false);
  const sales = useData(() => store.listSales({ from: '2000-01-01', to: studioDate(), clientId: c.id }).catch(() => null), [c.id]);
  const salesList = (sales.data ?? []).filter((s) => !s.clientId || s.clientId === c.id);

  const setOptIn = async (v: boolean) => {
    setSavingOpt(true);
    try { await saveClient(c, { marketingOptIn: v }); toast(v ? 'You’re on the list' : 'No more marketing emails'); app.refreshAuth(); }
    catch (e) { toast(errorMessage(e)); } finally { setSavingOpt(false); }
  };
  const signOut = async () => {
    try { await store.signOut(); } catch { /* ignore */ }
    app.refreshAuth(); nav('/', { replace: true });
  };
  const resetDemo = async () => {
    if (!store.demoReset) return;
    try { await store.demoReset(); await store.signOut().catch(() => {}); app.refreshAuth(); nav('/', { replace: true }); toast('Demo data reset'); }
    catch (e) { toast(errorMessage(e)); }
  };

  const since = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', month: 'long', year: 'numeric' }).format(new Date(c.createdAt));
  const s = app.settings;
  const team = app.staff.filter((x) => x.active && !!x.photoUrl);

  return (
    <div className="screen">
      <header className="me">
        <Avatar name={`${c.firstName} ${c.lastName}`} size={92} className="me-avatar" />
        <h1>Hi, <em>{c.firstName}</em></h1>
        <p className="muted">Member since {since}</p>
      </header>

      <InstallHint />

      <div className="group">
        <div className="group-label">You</div>
        <div className="list-card">
          <button className="list-row" onClick={() => setSheet('details')}>
            <span className="row-ic"><Icon name="user" size={20} /></span>
            <span className="list-row-main"><span className="list-row-title">Your details</span><span className="list-row-sub">{c.email}</span></span>
            <Icon name="chevron" size={18} className="faint" />
          </button>
          <button className="list-row" onClick={() => goFlow(nav, '/waiver?edit=1', { label: 'Profile', where: '/profile' })}>
            <span className="row-ic"><Icon name="shield" size={20} /></span>
            <span className="list-row-main">
              <span className="list-row-title">Health + waiver</span>
              <span className="list-row-sub">{c.waiverSignedAt ? `Signed ${dateShortNoDay(c.waiverSignedAt)}${c.healthForm?.injuries || c.injuries ? ' · injuries noted' : ''}` : 'Needed before your first booking'}</span>
            </span>
            {c.waiverSignedAt ? <Icon name="chevron" size={18} className="faint" /> : <span className="tag warn">To do</span>}
          </button>
          {sales.data !== null && (
            <button className="list-row" onClick={() => setSheet('history')}>
              <span className="row-ic"><Icon name="receipt" size={20} /></span>
              <span className="list-row-main"><span className="list-row-title">Purchases + receipts</span><span className="list-row-sub">{sales.data ? (salesList.length ? `${salesList.length} purchase${salesList.length === 1 ? '' : 's'}` : 'Nothing yet') : 'Loading…'}</span></span>
              <Icon name="chevron" size={18} className="faint" />
            </button>
          )}
          <div className="list-row">
            <span className="row-ic"><Icon name="bell" size={20} /></span>
            <span className="list-row-main"><span className="list-row-title">News + offers</span><span className="list-row-sub">New classes, events and the odd offer by email</span></span>
            <Toggle checked={!!c.marketingOptIn} disabled={savingOpt} onChange={setOptIn} label="News and offers emails" />
          </div>
        </div>
      </div>

      {team.length > 0 && (
        <section className="team-band">
          <SectionHead title={<>Meet your <em>instructors</em></>} />
          <div className="team">
            {team.map((m) => (
              <figure key={m.id} className="member">
                <span className="member-pic"><Avatar name={m.name} src={m.photoUrl} size={96} /></span>
                <span className="member-name serif">{m.name}</span>
                <span className="member-role">{staffRole(m)}</span>
              </figure>
            ))}
          </div>
        </section>
      )}

      <div className="group">
        <div className="group-label">Waitlists + cancellations</div>
        <Policies />
      </div>

      <div className="stack mt-28">
        <button className="btn soft block" onClick={signOut}><Icon name="logout" size={18} />Sign out</button>
        {store.mode === 'demo' && store.demoReset && <button className="btn link-btn block" onClick={resetDemo}>Reset demo data</button>}
      </div>

      <footer className="studio-foot">
        <Logo white width={150} />
        <p className="foot-tagline">Feel-good mat Pilates in Cooma, where movement becomes addictive.</p>
        <div className="foot-group">
          <small>Studio</small>
          <a href={mapsUrl(s.address)} target="_blank" rel="noopener"><span>{s.address}</span><Arrow /></a>
        </div>
        <div className="foot-group">
          <small>Connect</small>
          <a href={`mailto:${s.email}`}><span>{s.email}</span><Arrow /></a>
          {s.phone && <a href={`tel:${s.phone.replace(/\s+/g, '')}`}><span>{s.phone}</span><Arrow /></a>}
          <a href="https://snowypilatesclub.com" target="_blank" rel="noopener"><span>snowypilatesclub.com</span><Arrow /></a>
        </div>
        <p className="foot-base">Mat Pilates for every body · Cooma NSW</p>
      </footer>

      <DetailsSheet open={sheet === 'details'} onClose={() => setSheet(null)} />
      <HistorySheet open={sheet === 'history'} onClose={() => setSheet(null)} sales={salesList} />
    </div>
  );
}

function InstallHint() {
  const [dismissed, setDismissed] = useState(() => { try { return !!localStorage.getItem('spc.installHint'); } catch { return false; } });
  const [canPrompt, setCanPrompt] = useState(!!deferredPrompt);
  useEffect(() => {
    const on = () => setCanPrompt(true);
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  if (dismissed || isStandalone() || isNative()) return null;
  const ios = isIOS();
  if (!ios && !canPrompt) return null;
  const close = () => { setDismissed(true); try { localStorage.setItem('spc.installHint', '1'); } catch { /* */ } };
  return (
    <div className="install">
      <img src="icons/icon-192.png" alt="" className="install-icon" />
      <div className="install-main">
        <strong>Get the app on your phone</strong>
        {ios ? (
          <p className="muted">Tap <span className="kbd"><Icon name="share" size={16} /></span> Share in Safari, then <span className="kbd"><Icon name="addbox" size={16} /></span> Add to Home Screen.</p>
        ) : (
          <p className="muted">Install it for one-tap booking.</p>
        )}
        {!ios && canPrompt && <button className="btn sm mt-8" onClick={async () => { const p = deferredPrompt; deferredPrompt = null; if (p) { p.prompt(); await p.userChoice.catch(() => {}); } close(); }}>Install</button>}
      </div>
      <button className="icon-btn sm" aria-label="Dismiss" onClick={close}><Icon name="close" size={18} /></button>
    </div>
  );
}

function DetailsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const c = app.client;
  const init = () => ({
    firstName: c.firstName, lastName: c.lastName, phone: c.phone ?? '', birthday: c.birthday ?? '',
    emergencyContactName: c.emergencyContactName ?? '', emergencyContactPhone: c.emergencyContactPhone ?? '',
  });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF(init()); }, [open]);
  const set = (k: keyof ReturnType<typeof init>) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await saveClient(c, {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(), phone: f.phone.trim() || undefined, birthday: f.birthday || undefined,
        emergencyContactName: f.emergencyContactName.trim() || undefined, emergencyContactPhone: f.emergencyContactPhone.trim() || undefined,
      });
      app.refreshAuth();
      toast('Details saved'); onClose();
    } catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} label="Your details">
      <SheetHead back={{ label: 'Profile', onClick: onClose }} title={<>Your <em>details</em></>} />
      <form className="stack lg" onSubmit={save}>
        <div className="grid2">
          <label className="field"><span>First name</span><input className="input" required value={f.firstName} onChange={set('firstName')} autoComplete="given-name" /></label>
          <label className="field"><span>Last name</span><input className="input" required value={f.lastName} onChange={set('lastName')} autoComplete="family-name" /></label>
        </div>
        <label className="field"><span>Email</span><input className="input" value={c.email} disabled /><small className="muted fine">To change your email, flick the studio a message.</small></label>
        <div className="grid2">
          <label className="field"><span>Mobile</span><input className="input" type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" /></label>
          <label className="field"><span>Birthday</span><input className="input" type="date" value={f.birthday} onChange={set('birthday')} /></label>
        </div>
        <div className="group-head"><h3>Emergency contact</h3></div>
        <div className="grid2">
          <label className="field"><span>Name</span><input className="input" value={f.emergencyContactName} onChange={set('emergencyContactName')} /></label>
          <label className="field"><span>Phone</span><input className="input" type="tel" inputMode="tel" value={f.emergencyContactPhone} onChange={set('emergencyContactPhone')} /></label>
        </div>
        <button className="btn block" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </Sheet>
  );
}

function HistorySheet({ open, onClose, sales }: { open: boolean; onClose: () => void; sales: Sale[] }) {
  const [sel, setSel] = useState<Sale | null>(null);
  useEffect(() => { if (!open) setSel(null); }, [open]);
  // a receipt is a step inside the sheet: back returns to the list
  useBackHandler(open && !!sel, () => setSel(null));
  const list = sales.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Sheet open={open} onClose={onClose} label="Purchases">
      {sel ? (
        <div className="stack lg">
          <SheetHead back={{ label: 'Purchases', onClick: () => setSel(null) }} title={<>Your <em>receipt</em></>} onClose={onClose} />
          <Receipt sale={sel} />
        </div>
      ) : (
        <>
          <SheetHead back={{ label: 'Profile', onClick: onClose }} title={<>Purchases + <em>receipts</em></>} />
          {list.length === 0 ? (
            <div className="empty-state"><div className="empty-mark"><Flower size={34} /></div><h3>No purchases yet</h3><p className="muted">Receipts for passes and memberships will live here.</p></div>
          ) : (
            <div className="list-card">
              {list.map((x) => (
                <button key={x.id} className="list-row" onClick={() => setSel(x)}>
                  <span className="row-ic"><Icon name="receipt" size={20} /></span>
                  <span className="list-row-main"><span className="list-row-title">{x.items.map((i) => i.name).join(', ')}</span><span className="list-row-sub">{dateShortNoDay(x.createdAt)}{x.refundedCents ? ' · refunded' : ''}</span></span>
                  <span className="price-sm">{money(x.totalCents)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}


