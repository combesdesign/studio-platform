/** Signed-out screens: welcome, sign in, sign up, forgot password. */
import React, { useEffect, useState } from 'react';
import type { AuthUser } from '../shared/types';
import { store, useData, errorMessage, useToast } from '../shared/react';
import { Arrow, Avatar, BackPill, Flower, Logo } from './ui';
import { backOut, flowFrom, goFlow, markLaunched, pathOnly, swapFlow } from './lib';
import { FlowerStars, Marquee } from '../shared/brand';

type Nav = (to: string, o?: { replace?: boolean }) => void;

export function AuthScreens({ path, nav, onSignedIn }: { path: string; nav: Nav; onSignedIn: () => void }) {
  const p = pathOnly(path);
  // The welcome hero is the launch moment for signed-out visitors; don't replay it after they sign in.
  useEffect(() => { markLaunched(); }, []);
  if (p === '/signin') return <SignIn nav={nav} onSignedIn={onSignedIn} path={p} />;
  if (p === '/signup') return <SignUp nav={nav} onSignedIn={onSignedIn} path={p} />;
  if (p === '/forgot') return <Forgot nav={nav} path={p} />;
  return <Welcome nav={nav} onSignedIn={onSignedIn} />;
}

function Welcome({ nav, onSignedIn }: { nav: Nav; onSignedIn: () => void }) {
  return (
    <div className="welcome">
      <section className="welcome-hero">
        <img src="img/wide.webp" alt="" className="welcome-img" />
        <div className="welcome-shade" />
        <div className="welcome-copy">
          <Logo animate white width={252} />
          <h1>Join the newest club to hit <em>Cooma!</em></h1>
          <p className="lede">Movement isn’t a chore. Book classes, manage your passes and keep your health info up to date, all in one calm little place.</p>
          <div className="welcome-actions">
            <button className="btn white" onClick={() => goFlow(nav, '/signup', { label: 'Welcome', where: '/' })}>Join the club <Arrow /></button>
            <button className="btn glass" onClick={() => goFlow(nav, '/signin', { label: 'Welcome', where: '/' })}>Sign in</button>
          </div>
        </div>
      </section>
      <Marquee />
      <div className="welcome-body">
        <figure className="pull">
          <blockquote>“I loved it. Snowy Pilates Club is a masterclass in form, balance. My mind feels clear and my core feels amazing.”</blockquote>
          <figcaption><FlowerStars /> Reena S., Google review</figcaption>
        </figure>
        {store.mode === 'demo' && <DemoPersonas onSignedIn={onSignedIn} />}
      </div>
    </div>
  );
}

function DemoPersonas({ onSignedIn }: { onSignedIn: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // The demo store lists its client personas in a fixed order: brand new, member, pack, intro.
  const HINTS = ['Brand new – no waiver or passes yet', 'Member · 2 classes a week', '4 class pack · 1 credit left', 'On the intro offer'];
  const { data } = useData(async () => {
    const clients = (await store.demoPersonas()).filter((u: AuthUser) => u.kind === 'client');
    return clients.map((u, i) => ({ u, hint: clients.length === HINTS.length ? HINTS[i]! : u.email }));
  }, []);
  const clients = data ?? [];
  if (!data || !store.demoSignInAs) return null;
  const go = async (u: AuthUser) => {
    setBusy(u.email);
    try { await store.demoSignInAs!(u); onSignedIn(); }
    catch (e) { toast(errorMessage(e)); }
    finally { setBusy(null); }
  };
  return (
    <section className="demo-box">
      <header className="sec-head">
        <span className="tag cream">Demo</span>
        <h2>Try it <em>as…</em></h2>
      </header>
      <div className="list-card">
        {clients.map(({ u, hint }) => (
          <button key={u.email} className="list-row" onClick={() => go(u)} disabled={!!busy}>
            <Avatar name={u.name} size={42} className="ringed" />
            <span className="list-row-main">
              <span className="list-row-title">{u.name}</span>
              <span className="list-row-sub">{hint}</span>
            </span>
            {busy === u.email ? <Flower size={20} spin /> : <Arrow size={18} />}
          </button>
        ))}
        {clients.length === 0 && <p className="muted pad-16">No demo clients yet.</p>}
      </div>
      <p className="muted fine center">Demo data lives in this browser only. No real bookings or payments.</p>
    </section>
  );
}

/** Signed-out page with a pinned "‹ Welcome" / "‹ Sign in" back pill (pops history when we know where it came from). */
function AuthFrame({ title, sub, children, nav, path, back = '/', backLabel = 'Welcome' }: { title: React.ReactNode; sub?: string; children: React.ReactNode; nav: Nav; path: string; back?: string; backLabel?: string }) {
  const label = flowFrom(path)?.label ?? backLabel;
  return (
    <div className="auth">
      <div className="auth-top">
        <BackPill label={label} onClick={() => backOut(nav, path, back)} />
        <Logo width={96} />
        <span className="auth-top-gap" />
      </div>
      <div className="auth-body">
        <h1>{title}</h1>
        {sub && <p className="lede">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

function SignIn({ nav, onSignedIn, path }: { nav: Nav; onSignedIn: () => void; path: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await store.signIn(email.trim(), password); onSignedIn(); }
    catch (x) { setErr(errorMessage(x)); }
    finally { setBusy(false); }
  };
  return (
    <AuthFrame title={<>Welcome <em>back</em></>} sub="Sign in to book your next class." nav={nav} path={path}>
      <form className="stack lg" onSubmit={submit}>
        <label className="field"><span>Email</span>
          <input className="input" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span>Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" className="link-btn" onClick={() => goFlow(nav, '/forgot', { label: 'Sign in', where: '/signin' })}>Forgot your password?</button>
      </form>
      <p className="auth-foot muted">New here? <button className="link-btn inline" onClick={() => swapFlow(nav, path, '/signup')}>Create an account</button></p>
    </AuthFrame>
  );
}

function SignUp({ nav, onSignedIn, path }: { nav: Nav; onSignedIn: () => void; path: string }) {
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', password: '', marketingOptIn: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.password.length < 8) { setErr('Use at least 8 characters for your password.'); return; }
    setBusy(true);
    try {
      await store.signUpClient({ ...f, email: f.email.trim(), phone: f.phone.trim() || undefined });
      onSignedIn();
    } catch (x) { setErr(errorMessage(x)); }
    finally { setBusy(false); }
  };
  return (
    <AuthFrame title={<>Join the <em>club</em></>} sub="Create your account, then grab the intro offer – two weeks of unlimited classes for new clients." nav={nav} path={path}>
      <form className="stack lg" onSubmit={submit}>
        <div className="grid2">
          <label className="field"><span>First name</span><input className="input" autoComplete="given-name" required value={f.firstName} onChange={set('firstName')} /></label>
          <label className="field"><span>Last name</span><input className="input" autoComplete="family-name" required value={f.lastName} onChange={set('lastName')} /></label>
        </div>
        <label className="field"><span>Email</span><input className="input" type="email" inputMode="email" autoComplete="email" required value={f.email} onChange={set('email')} /></label>
        <label className="field"><span>Mobile <i className="faint">(optional)</i></span><input className="input" type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" autoComplete="new-password" required minLength={8} value={f.password} onChange={set('password')} placeholder="At least 8 characters" /></label>
        <label className="check"><input type="checkbox" checked={f.marketingOptIn} onChange={set('marketingOptIn')} /><span>Send me news, new classes and the odd offer. No spam, promise.</span></label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Creating your account…' : 'Create account'}</button>
      </form>
      <p className="auth-foot muted">Already a member? <button className="link-btn inline" onClick={() => swapFlow(nav, path, '/signin')}>Sign in</button></p>
    </AuthFrame>
  );
}

function Forgot({ nav, path }: { nav: Nav; path: string }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await store.requestPasswordReset(email.trim()); setSent(true); }
    catch (x) { setErr(errorMessage(x)); }
    finally { setBusy(false); }
  };
  if (sent) {
    return (
      <AuthFrame title={<>Check your <em>inbox</em></>} nav={nav} path={path} back="/signin" backLabel="Sign in">
        <div className="panel-soft stack">
          <Flower size={28} />
          <p>If there’s an account for <strong>{email}</strong>, we’ve sent a link to reset your password. It can take a minute or two – and check your junk folder just in case.</p>
        </div>
        <button className="btn block" onClick={() => backOut(nav, path, '/signin')}>Back to sign in</button>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={<>Forgot your <em>password?</em></>} sub="No worries. Pop your email in and we’ll send you a reset link." nav={nav} path={path} back="/signin" backLabel="Sign in">
      <form className="stack lg" onSubmit={submit}>
        <label className="field"><span>Email</span>
          <input className="input" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
      </form>
    </AuthFrame>
  );
}
