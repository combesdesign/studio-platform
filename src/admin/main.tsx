/**
 * Platform admin (served at /admin/), for Pete, the platform owner (role platform_admin): every studio and
 * its status, create a studio, edit its branding with a live preview of its client app, invite its owner,
 * suspend or reopen it. Neutral "Studio Platform" look, never a studio's.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './admin.css';
import type { PlatformUser, Studio, StudioBranding, StudioStatus } from '../shared/types';
import { PLATFORM_DOMAIN, platform } from '../data';
import { MAX_DOMAINS, dnsSteps, domainOwners, domainProblem, normaliseDomain } from './domains';
import { ToastProvider, match, useRoute, useToast } from '../shared/react';
import { Accented, Flower, Logo } from '../shared/brand';
import { applyBranding, brandAsset, defaultBranding, PLATFORM_BRANDING, PLATFORM_NAME, setAssetBase } from '../shared/branding';
import { BrandingEditor, BrandPreview, PALETTES } from '../shared/branding-editor';
import { SupportInbox, SupportNavLink } from '../features/support/admin/inbox';
import { MrrLine, PlanBadge, PlansPage, StudioPlanTab } from './plans';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');
const STATUS: Record<StudioStatus, { label: string; tone: string }> = {
  live: { label: 'Live', tone: 'ok' }, onboarding: { label: 'Setting up', tone: 'cream' }, suspended: { label: 'Suspended', tone: 'danger' },
};
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const appLink = (s: Studio, app: 'client' | 'studio') => `../${app === 'studio' ? 'studio/' : ''}?studio=${encodeURIComponent(s.slug)}#/`;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((data) => live && setState({ data }), (e) => live && setState({ error: msg(e) }));
    const off = platform.subscribe(() => setN((x) => x + 1));
    return () => { live = false; off(); };
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

function App() {
  const me = useLoad(() => platform.platformUser(), []);
  if (me.data === undefined && !me.error) return <div className="ad-boot"><Flower size={32} spin /></div>;
  if (!me.data) return <SignIn onDone={me.reload} />;
  return <Shell me={me.data} />;
}

// ------------------------------------------------------------------ sign in
function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const personas = useLoad(async () => (await platform.demoPersonas?.('admin')) ?? [], []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await platform.signIn(email.trim(), password); onDone(); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="ad-signin">
      <div className="ad-signin-card">
        <Logo className="ad-logo" label={PLATFORM_NAME} />
        <p className="eyebrow">Platform admin</p>
        <h1><Accented text="Sign *in*" /></h1>
        <form className="stack lg" onSubmit={submit}>
          <label className="field"><span>Email</span><input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {err && <p className="form-error" role="alert">{err}</p>}
          <button className="btn block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {(personas.data?.length ?? 0) > 0 && (
          <div className="ad-demo">
            <p className="eyebrow"><Flower size={10} /> Demo</p>
            {personas.data!.map((p) => (
              <button key={p.email} className="ad-row" disabled={busy} onClick={async () => { setBusy(true); try { await platform.demoSignInAs!(p.email); onDone(); } catch (x) { setErr(msg(x)); } finally { setBusy(false); } }}>
                <span className="ad-av">{p.name.charAt(0)}</span><span className="ad-row-t"><strong>Sign in as {p.name}</strong><span>{p.email} · {p.hint}</span></span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shell
function Shell({ me }: { me: PlatformUser }) {
  const [path] = useRoute();
  const p = path.split('?')[0]!;
  let m: Record<string, string> | null;
  let page: React.ReactNode;
  if (p === '/new') page = <NewStudio />;
  else if (p === '/support') page = <SupportInbox />;
  else if (p === '/plans') page = <PlansPage />;
  else if ((m = match('/studios/:id', p))) page = <StudioPage id={m.id!} tab="overview" />;
  else if ((m = match('/studios/:id/:tab', p))) page = <StudioPage id={m.id!} tab={m.tab!} />;
  else page = <Studios />;
  return (
    <div className="ad">
      <header className="ad-top">
        <a href="#/" className="ad-brand"><Logo className="ad-top-logo" label={PLATFORM_NAME} /><span className="ad-tag">Admin</span></a>
        <nav className="ad-nav" aria-label="Admin sections"><a href="#/" className={p !== '/support' && p !== '/plans' ? 'on' : ''}>Studios</a><a href="#/plans" className={p === '/plans' ? 'on' : ''}>Plans</a><SupportNavLink active={p === '/support'} /></nav>
        <div className="ad-me">
          <span className="ad-av">{me.name.charAt(0)}</span>
          <span className="ad-me-t"><strong>{me.name}</strong><span>{me.email}</span></span>
          <button className="btn ghost sm" onClick={async () => { await platform.signOut(); location.hash = '/'; location.reload(); }}>Sign out</button>
        </div>
      </header>
      <main className="ad-main" key={p}>{page}</main>
      {platform.mode === 'demo' && <div className="demo-badge">DEMO</div>}
    </div>
  );
}

// ------------------------------------------------------------------ studios list
function Studios() {
  const list = useLoad(() => platform.listStudios({ includeAll: true }), []);
  const stats = useLoad(async () => (await platform.studioStats?.()) ?? {}, []);
  const [q, setQ] = useState('');
  const shown = (list.data ?? []).filter((s) => `${s.name} ${s.slug} ${s.address}`.toLowerCase().includes(q.toLowerCase()));
  const counts = useMemo(() => {
    const c = { live: 0, onboarding: 0, suspended: 0 } as Record<StudioStatus, number>;
    for (const s of list.data ?? []) c[s.status]++;
    return c;
  }, [list.data]);
  return (
    <div className="stack lg">
      <div className="ad-head">
        <div>
          <p className="eyebrow">{(list.data?.length ?? 0)} studios · {counts.live} live · {counts.onboarding} setting up · {counts.suspended} suspended · <MrrLine studios={list.data ?? []} /></p>
          <h1><Accented text="Your *studios*" /></h1>
        </div>
        <a className="btn" href="#/new">New studio</a>
      </div>
      <input className="input ad-search" type="search" placeholder="Search studios" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search studios" />
      {list.error && <p className="form-error">{list.error}</p>}
      <div className="ad-table" role="table" aria-label="Studios">
        <div className="ad-tr ad-th" role="row"><span role="columnheader">Studio</span><span role="columnheader">Status</span><span role="columnheader">Plan</span><span role="columnheader">Clients</span><span role="columnheader">Staff</span><span role="columnheader">Classes (7 days)</span><span role="columnheader" /></div>
        {shown.map((s) => {
          const st = stats.data?.[s.id];
          return (
            <a key={s.id} className="ad-tr" role="row" href={`#/studios/${s.id}`}>
              <span className="ad-studio" role="cell">
                <span className="ad-sw" style={{ background: s.branding?.colors?.primary ?? '#999' }}>{s.branding?.mark?.d && <svg viewBox={s.branding.mark.viewBox ?? '0 0 100 100'} width="18" height="18" aria-hidden="true"><path d={s.branding.mark.d} fill={s.branding.colors.accent} /></svg>}</span>
                <span className="ad-studio-t"><strong>{s.name}</strong><span>{s.slug} · {s.address || 'No address yet'}</span></span>
              </span>
              <span role="cell"><span className={`chip ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span></span>
              <span role="cell"><PlanBadge studio={s} /></span>
              <span role="cell" className="ad-num">{st?.clients ?? '·'}</span>
              <span role="cell" className="ad-num">{st?.staff ?? '·'}</span>
              <span role="cell" className="ad-num">{st?.classesNext7Days ?? '·'}</span>
              <span role="cell" className="ad-go">Open</span>
            </a>
          );
        })}
        {list.data && shown.length === 0 && <p className="muted ad-empty">No studios match.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ create
function NewStudio() {
  const toast = useToast();
  const [v, setV] = useState({ name: '', slug: '', email: '', address: '', timezone: 'Australia/Sydney', currency: 'AUD', palette: 'Slate' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const f = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const val = e.target.value;
    setV((x) => ({ ...x, [k]: val, ...(k === 'name' && !slugTouched ? { slug: slugify(val) } : {}) }));
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const branding = defaultBranding(v.name.trim() || 'New studio');
      const pal = PALETTES.find((p) => p.name === v.palette);
      if (pal) branding.colors = { ...pal.colors };
      const s = await platform.createStudio({ name: v.name.trim(), slug: v.slug.trim(), email: v.email.trim(), address: v.address.trim(), timezone: v.timezone, currency: v.currency, branding });
      toast(`${s.name} created`);
      location.hash = `/studios/${s.id}/owner`;
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="stack lg ad-narrow">
      <a className="back-pill" href="#/"><svg className="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M14.5 6l-6 6 6 6" /></svg><span>Studios</span></a>
      <h1><Accented text="New *studio*" /></h1>
      <p className="muted">It starts in “setting up”. Next you’ll invite the owner, who finishes setup in their studio app.</p>
      <form className="card pad stack lg" onSubmit={create}>
        <div className="ad-form">
          <label className="field span2"><span>Studio name</span><input className="input" required value={v.name} onChange={f('name')} /></label>
          <label className="field span2"><span>Web address</span>
            <span className="ad-slug"><input className="input" required value={v.slug} onChange={(e) => { setSlugTouched(true); f('slug')(e); }} pattern="[a-z0-9\-]{2,40}" /><span className="muted small">#/s/{v.slug || 'your-studio'}</span></span>
          </label>
          <label className="field"><span>Studio email</span><input className="input" type="email" required value={v.email} onChange={f('email')} /></label>
          <label className="field"><span>Address</span><input className="input" value={v.address} onChange={f('address')} /></label>
          <label className="field"><span>Timezone</span><select className="select" value={v.timezone} onChange={f('timezone')}>
            {['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Australia/Hobart', 'Pacific/Auckland', 'Europe/London'].map((z) => <option key={z}>{z}</option>)}
          </select></label>
          <label className="field"><span>Currency</span><select className="select" value={v.currency} onChange={f('currency')}>{['AUD', 'NZD', 'GBP', 'USD'].map((c) => <option key={c}>{c}</option>)}</select></label>
        </div>
        <div className="field"><span>Starting colours</span>
          <div className="be-palettes">{PALETTES.map((p) => (
            <button key={p.name} type="button" className={`be-pal${v.palette === p.name ? ' on' : ''}`} onClick={() => setV({ ...v, palette: p.name })} aria-pressed={v.palette === p.name}>
              {(['primary', 'accent', 'highlight', 'soft'] as const).map((k) => <span key={k} style={{ background: p.colors[k] }} />)}<em>{p.name}</em>
            </button>
          ))}</div>
        </div>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create studio'}</button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ one studio
function StudioPage({ id, tab }: { id: string; tab: string }) {
  const s = useLoad(() => platform.findStudio({ id }), [id]);
  if (s.error) return <p className="form-error">{s.error}</p>;
  if (s.data === undefined) return <div className="ad-boot"><Flower size={28} spin /></div>;
  if (!s.data) return <p className="muted">That studio could not be found. <a href="#/">Back to studios</a></p>;
  const studio = s.data;
  const tabs = [['overview', 'Overview'], ['plan', 'Plan'], ['branding', 'Branding'], ['domains', 'Domains'], ['owner', 'Owner']] as const;
  return (
    <div className="stack lg">
      <a className="back-pill" href="#/"><svg className="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M14.5 6l-6 6 6 6" /></svg><span>Studios</span></a>
      <div className="ad-head">
        <div>
          <p className="eyebrow"><span className={`chip ${STATUS[studio.status].tone}`}>{STATUS[studio.status].label}</span> {studio.slug}</p>
          <h1>{studio.name}</h1>
        </div>
        <div className="row">
          <a className="btn soft" href={appLink(studio, 'client')} target="_blank" rel="noopener">Client app</a>
          <a className="btn soft" href={appLink(studio, 'studio')} target="_blank" rel="noopener">Studio app</a>
        </div>
      </div>
      <nav className="tabs" aria-label="Studio sections">
        {tabs.map(([k, l]) => <a key={k} href={`#/studios/${studio.id}${k === 'overview' ? '' : '/' + k}`} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined}>{l}</a>)}
      </nav>
      {tab === 'plan' ? <StudioPlanTab studio={studio} /> : tab === 'branding' ? <BrandingPage studio={studio} /> : tab === 'owner' ? <OwnerPage studio={studio} /> : tab === 'domains' ? <DomainsPage studio={studio} /> : <Overview studio={studio} />}
    </div>
  );
}

function Overview({ studio }: { studio: Studio }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const setStatus = async (status: StudioStatus) => {
    setBusy(true);
    try { await platform.setStudioStatus(studio.id, status); setConfirming(false); toast(status === 'suspended' ? `${studio.name} suspended` : `${studio.name} is ${STATUS[status].label.toLowerCase()}`); }
    catch (x) { toast(msg(x)); } finally { setBusy(false); }
  };
  const rows: [string, React.ReactNode][] = [
    ['Address', studio.address || '·'], ['Email', studio.email || '·'], ['Phone', studio.phone || '·'], ['Website', studio.website || '·'],
    ['Timezone', studio.timezone], ['Currency', `${studio.currency} · ${studio.locale}`],
    [studio.taxIdLabel, studio.taxId || '·'], ['Tax', `${studio.taxName} ${Math.round(studio.taxRate * 1000) / 10}%${studio.taxRegistered ? '' : ' (not registered)'}`],
    ['Custom domains', studio.customDomains?.join(', ') || '·'], ['Created', new Date(studio.createdAt).toLocaleDateString()],
  ];
  return (
    <div className="ad-grid">
      <section className="card pad">
        <h3>Details</h3>
        <dl className="ad-dl">{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
      </section>
      <section className="card pad stack">
        <h3>Status</h3>
        <p className="muted small">{studio.status === 'live' ? 'Live: in the app’s studio list, clients can book.' : studio.status === 'onboarding' ? 'Setting up: the owner is finishing setup. Not in the studio list yet.' : 'Suspended: hidden from the studio list, and nobody can book or change anything.'}</p>
        {studio.status !== 'live' && <button className="btn" disabled={busy} onClick={() => setStatus('live')}>{studio.status === 'suspended' ? 'Reopen studio' : 'Make live now'}</button>}
        {studio.status !== 'suspended' && !confirming && <button className="btn danger" disabled={busy} onClick={() => setConfirming(true)}>Suspend studio</button>}
        {confirming && (
          <div className="note warn ad-confirm">
            <p>Suspend {studio.name}? Clients and staff won’t be able to book or change anything until you reopen it.</p>
            <div className="row"><button className="btn danger" disabled={busy} onClick={() => setStatus('suspended')}>Yes, suspend</button><button className="btn ghost" onClick={() => setConfirming(false)}>Keep it open</button></div>
          </div>
        )}
      </section>
    </div>
  );
}

function DomainsPage({ studio }: { studio: Studio }) {
  const toast = useToast();
  const all = useLoad(() => platform.listStudios({ includeAll: true }), []);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState('');
  const domains = (studio.customDomains ?? []).map((d) => d.toLowerCase());
  const save = async (next: string[], done: string) => {
    setBusy(true); setErr('');
    try { await platform.updateStudioAsAdmin(studio.id, { customDomains: next }); setText(''); setRemoving(''); toast(done); }
    catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const d = normaliseDomain(text);
    const problem = domainProblem(d, { platformDomain: PLATFORM_DOMAIN, existing: domains, takenBy: domainOwners(all.data ?? [], studio.id) });
    if (problem) { setErr(problem); return; }
    void save([...domains, d], `${d} added`);
  };
  const shown = normaliseDomain(text);
  const steps = dnsSteps(domains[domains.length - 1] ?? 'book.yourstudio.com.au', studio.slug, PLATFORM_DOMAIN);
  const forDomain = domains[domains.length - 1];
  return (
    <div className="ad-grid">
      <section className="card pad stack">
        <h3>Custom domains</h3>
        <p className="muted small">Let {studio.name} use its own address, like book.yourstudio.com.au, instead of {studio.slug}{PLATFORM_DOMAIN ? '.' + PLATFORM_DOMAIN : ''}. Up to {MAX_DOMAINS}. A domain can only belong to one studio.</p>
        {domains.length === 0 ? <p className="muted">No custom domains yet.</p> : (
          <ul className="ad-doms">
            {domains.map((d) => (
              <li key={d} className="ad-dom">
                <b>{d}</b>
                {removing === d ? (
                  <span className="row"><button className="btn danger sm" disabled={busy} onClick={() => save(domains.filter((x) => x !== d), `${d} removed`)}>Yes, remove</button><button className="btn ghost sm" onClick={() => setRemoving('')}>Keep it</button></span>
                ) : <button className="btn ghost sm" disabled={busy} onClick={() => setRemoving(d)} aria-label={`Remove ${d}`}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        {removing && <p className="muted small">Removing a domain stops it opening this studio. Clients using it get the studio picker until you point it somewhere else.</p>}
        <form className="stack" onSubmit={add} noValidate>
          <label className="field"><span>Add a domain</span>
            <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="book.yourstudio.com.au" value={text} onChange={(e) => { setText(e.target.value); setErr(''); }} />
          </label>
          {shown && shown !== text.trim() && <p className="muted small">Will be saved as {shown}</p>}
          {err && <p className="form-error" role="alert">{err}</p>}
          <button className="btn" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Add domain'}</button>
        </form>
      </section>
      <section className="card pad stack">
        <h3>How to point {forDomain ?? 'a domain'} here</h3>
        <p className="muted small">{forDomain ? `Steps for ${forDomain}.` : 'Example steps, shown for a sample domain until one is added.'} Nothing goes live until the DNS is set; this screen can’t check it for you.</p>
        <ol className="ad-steps">
          {steps.map((st) => (
            <li key={st.title}>
              <b>{st.title}</b>
              <p className="small">{st.body}</p>
              {st.record && <dl className="ad-dnsrec"><dt>Type</dt><dd>{st.record.type}</dd><dt>Name</dt><dd>{st.record.name}</dd><dt>Points to</dt><dd>{st.record.value}</dd></dl>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function BrandingPage({ studio }: { studio: Studio }) {
  const toast = useToast();
  const [b, setB] = useState<StudioBranding>(studio.branding?.colors ? studio.branding : defaultBranding(studio.name));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await platform.updateStudioAsAdmin(studio.id, { branding: b }); setDirty(false); toast('Branding saved'); }
    catch (x) { toast(msg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="ad-brandpage">
      <div className="stack lg">
        <BrandingEditor value={b} onChange={(x) => { setB(x); setDirty(true); }} name={studio.name} />
        <div className="ad-save">
          <button className="btn ghost" disabled={!dirty || busy} onClick={() => { setB(studio.branding); setDirty(false); }}>Undo changes</button>
          <button className="btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save branding'}</button>
        </div>
      </div>
      <aside className="ad-preview">
        <p className="eyebrow">Live preview · client app</p>
        <BrandPreview branding={b} name={studio.name} />
      </aside>
    </div>
  );
}

function OwnerPage({ studio }: { studio: Studio }) {
  const toast = useToast();
  const [v, setV] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const st = await platform.inviteOwner(studio.id, { name: v.name.trim(), email: v.email.trim() }); setSent(st.email); toast(`Invite sent to ${st.email}`); setV({ name: '', email: '' }); }
    catch (x) { toast(msg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="ad-grid">
      <form className="card pad stack lg" onSubmit={invite}>
        <h3>Invite the <em>owner</em></h3>
        <p className="muted small">They’re added to {studio.name} as its owner and get an email to set a password. They then sign in to the studio app and finish setup: details, branding, classes, pricing, policies, staff and going live.</p>
        <label className="field"><span>Owner’s name</span><input className="input" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <label className="field"><span>Owner’s email</span><input className="input" type="email" required value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></label>
        <button className="btn" disabled={busy}>{busy ? 'Inviting…' : 'Send invite'}</button>
        {sent && <p className="note ok small">Invited {sent}. {platform.mode === 'demo' ? 'Demo: open the studio app and sign in as them from the demo list.' : ''}</p>}
      </form>
      <section className="card pad stack">
        <h3>Their app</h3>
        <p className="muted small">Clients use <strong>{appLink(studio, 'client')}</strong>. On the platform domain that’s also <strong>{studio.slug}.your-platform-domain</strong>.</p>
        {studio.branding?.photos?.hero && <img className="ad-hero" src={brandAsset(studio.branding.photos.hero)} alt="" />}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ boot
setAssetBase('../');
applyBranding(PLATFORM_BRANDING, { title: `${PLATFORM_NAME} · Admin`, themeColor: PLATFORM_BRANDING.colors.ink });
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <App />
  </ToastProvider>,
);
