/** Signed-out screens: welcome, sign in, sign up, forgot password. */
import React, { useEffect, useState } from 'react';
import type { AuthUser } from '../shared/types';
import { store, useData, errorMessage, useToast } from '../shared/react';
import { StoreError } from '../shared/store';
import { Arrow, Avatar, BackPill, Flower, Icon, Logo } from './ui';
import {
  backOut, demoOpenPasswordLink, endPasswordLink, flowFrom, goFlow, markLaunched, pathOnly, setLinkOrigin, swapFlow, takeLinkProblem,
  type PasswordLinkKind,
} from './lib';
import { Accented, FlowerStars, Marquee } from '../shared/brand';
import { brandAsset, getBranding } from '../shared/branding';

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
  const b = getBranding();
  return (
    <div className="welcome">
      <section className="welcome-hero">
        <img src={brandAsset(b.photos.hero)} alt="" className="welcome-img" />
        <div className="welcome-shade" />
        <div className="welcome-copy">
          <Logo animate white width={252} />
          <h1><Accented text={b.welcome.headline} /></h1>
          <p className="lede">{b.welcome.copy}</p>
          <div className="welcome-actions">
            <button className="btn white" onClick={() => goFlow(nav, '/signup', { label: 'Welcome', where: '/' })}>Join the club <Arrow /></button>
            <button className="btn glass" onClick={() => goFlow(nav, '/signin', { label: 'Welcome', where: '/' })}>Sign in</button>
          </div>
        </div>
      </section>
      <Marquee />
      <div className="welcome-body">
        {b.welcome.quote && (
          <figure className="pull">
            <blockquote>“{b.welcome.quote.text}”</blockquote>
            <figcaption><FlowerStars /> {b.welcome.quote.by}</figcaption>
          </figure>
        )}
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
  const openInvite = async () => {
    setBusy('invite');
    setLinkOrigin({ label: 'Welcome', where: '/' });
    try { if (!(await demoOpenPasswordLink('invite'))) { setLinkOrigin(null); toast('The invite link isn’t available right now.'); } }
    catch (e) { setLinkOrigin(null); toast(errorMessage(e)); }
    finally { setBusy(null); }
  };
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
      <button className="demo-invite" onClick={openInvite} disabled={!!busy}>
        <Flower size={18} />
        <span><strong>Moving over from Momence?</strong> See what imported clients get: open Margaret’s invite link</span>
        <Arrow size={16} />
      </button>
      <p className="muted fine center">Demo data lives in this browser only. No real bookings or payments.</p>
    </section>
  );
}

/** Signed-out page with a pinned "‹ Welcome" / "‹ Sign in" back pill (pops history when we know where it came from). */
function AuthFrame({ title, sub, children, nav, path, back = '/', backLabel = 'Welcome', onBack, className }: { title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode; nav: Nav; path: string; back?: string; backLabel?: string; onBack?: () => void; className?: string }) {
  const label = flowFrom(path)?.label ?? backLabel;
  return (
    <div className={'auth' + (className ? ' ' + className : '')}>
      <div className="auth-top">
        <BackPill label={label} onClick={() => { onBack?.(); backOut(nav, path, back); }} />
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
  const [confirm, setConfirm] = useState('');
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
    } catch (x) {
      // Live with "Confirm email" on: the account is made and a link is on its way. That's good news, not an error.
      if (x instanceof StoreError && x.code === 'CONFIRM_EMAIL') setConfirm(f.email.trim());
      else setErr(errorMessage(x));
    }
    finally { setBusy(false); }
  };
  if (confirm) {
    return (
      <AuthFrame title={<>Check your <em>inbox</em></>} nav={nav} path={path}>
        <div className="panel-soft stack">
          <Flower size={28} />
          <p>Almost there! We’ve sent a link to <strong>{confirm}</strong>. Tap it to confirm your email, then sign in. Check your junk folder if it’s not there in a minute or two.</p>
        </div>
        <button className="btn block" onClick={() => swapFlow(nav, path, '/signin')}>Go to sign in</button>
      </AuthFrame>
    );
  }
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

// Kept while the app is open, so coming back from the demo reset link returns to "Check your inbox".
let forgotEmail = '';
let backToSent = false;

function Forgot({ nav, path }: { nav: Nav; path: string }) {
  const toast = useToast();
  const [email, setEmail] = useState(forgotEmail);
  const [problem] = useState(takeLinkProblem);
  const [sent, setSent] = useState(() => { const v = backToSent && !problem && !!forgotEmail; backToSent = false; return v; });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { forgotEmail = email; }, [email]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await store.requestPasswordReset(email.trim()); setSent(true); }
    catch (x) { setErr(errorMessage(x)); }
    finally { setBusy(false); }
  };
  const openDemoLink = async () => {
    setBusy(true);
    setLinkOrigin({ label: 'Inbox', where: path });
    backToSent = true;
    const failed = (m: string) => { setLinkOrigin(null); backToSent = false; toast(m); };
    try { if (!(await demoOpenPasswordLink('recovery', email.trim()))) failed('The reset link isn’t available right now.'); }
    catch (x) { failed(errorMessage(x)); }
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
        {store.mode === 'demo' && (
          <div className="demo-link">
            <span className="tag cream">Demo</span>
            <p>The demo doesn’t send real emails. Open the link here to see what happens next.</p>
            <button className="btn soft block" onClick={openDemoLink} disabled={busy}>{busy ? 'Opening…' : 'Demo: open the reset link'} <Arrow /></button>
          </div>
        )}
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={<>Forgot your <em>password?</em></>} sub="No worries. Pop your email in and we’ll send you a reset link." nav={nav} path={path} back="/signin" backLabel="Sign in">
      <form className="stack lg" onSubmit={submit}>
        {problem && <p className="form-note" role="status"><Icon name="info" size={20} />{problem}</p>}
        <label className="field"><span>Email</span>
          <input className="input" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
      </form>
    </AuthFrame>
  );
}

// ------------------------------------------------------------------ choose a new password (reset + invite links)
/**
 * Shown when someone lands from an emailed link (store.onPasswordRecovery). Live, the link has already signed
 * them in; after saving they land on the timetable. Invites (imported Momence clients) get a welcome heading.
 */
export function NewPassword({ kind, path, nav, email, signedIn, onSaved }: {
  kind: PasswordLinkKind; path: string; nav: Nav; email?: string; signedIn: boolean; onSaved: (kind: PasswordLinkKind) => Promise<void> | void;
}) {
  const invite = kind === 'invite';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<{ msg: string; field?: 'pw' | 'pw2' } | null>(null);
  const [busy, setBusy] = useState(false);
  const long = pw.length >= 8;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!long) { setErr({ field: 'pw', msg: pw ? `That’s only ${pw.length} character${pw.length === 1 ? '' : 's'}. Make it at least 8 – a short phrase works well.` : 'Pop in a new password – at least 8 characters.' }); return; }
    if (!pw2) { setErr({ field: 'pw2', msg: 'Type your new password once more to confirm it.' }); return; }
    if (pw !== pw2) { setErr({ field: 'pw2', msg: 'Those two don’t quite match. Have another go.' }); return; }
    setErr(null); setBusy(true);
    try {
      if (!store.setNewPassword) throw new Error('Setting a password isn’t available right now. Please contact the studio.');
      await store.setNewPassword(pw);
      backToSent = false;
      await onSaved(kind);
    } catch (x) {
      setErr({ msg: x instanceof StoreError && x.code === 'LINK_EXPIRED' ? 'That link has expired. Go back and ask for a new one – it only takes a moment.' : errorMessage(x) });
      setBusy(false);
    }
  };
  const bad = (f: 'pw' | 'pw2') => (err?.field === f ? true : undefined);
  return (
    <AuthFrame
      className="new-pw"
      title={invite ? <>Welcome to the new {getBranding().appName} <em>app</em></> : <>Choose a new <em>password</em></>}
      sub={invite ? 'Set a password to see your credits.' : 'Make it something you’ll remember. You’ll use it to sign in from now on.'}
      nav={nav} path={path} back={signedIn ? '/' : '/signin'} backLabel={signedIn ? 'Timetable' : 'Sign in'} onBack={endPasswordLink}>
      {email && <p className="for-account"><Icon name="user" size={18} /><span>{email}</span></p>}
      <form className="stack lg" onSubmit={submit} noValidate>
        {email && <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />}
        <div className="field">
          <label htmlFor="new-pw">{invite ? 'Password' : 'New password'}</label>
          <PasswordInput id="new-pw" value={pw} show={show} invalid={bad('pw')} autoFocus
            onChange={(v) => { setPw(v); if (err?.field === 'pw') setErr(null); }} onToggle={() => setShow(!show)} />
          <p className={'pw-hint' + (long ? ' ok' : '')} id="new-pw-hint">
            {long ? <Icon name="check" size={18} /> : <Flower size={14} />}At least 8 characters
          </p>
        </div>
        <div className="field">
          <label htmlFor="new-pw2">Confirm password</label>
          <PasswordInput id="new-pw2" value={pw2} show={show} invalid={bad('pw2')}
            onChange={(v) => { setPw2(v); if (err?.field === 'pw2') setErr(null); }} />
        </div>
        {err && <p className="form-error" role="alert">{err.msg}</p>}
        <button className="btn block big" disabled={busy}>{busy ? 'Saving…' : invite ? 'Save password and see my credits' : 'Save new password'}</button>
      </form>
    </AuthFrame>
  );
}

function PasswordInput({ id, value, onChange, show, onToggle, invalid, autoFocus }: {
  id: string; value: string; onChange: (v: string) => void; show: boolean; onToggle?: () => void; invalid?: boolean; autoFocus?: boolean;
}) {
  // Skip autofocus on phones: the keyboard would push the heading out of view.
  const focus = autoFocus && typeof window !== 'undefined' && window.matchMedia?.('(min-width: 700px)').matches;
  return (
    <div className={'pw-wrap' + (onToggle ? ' has-eye' : '')}>
      <input id={id} className="input" type={show ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} autoFocus={focus} aria-describedby={id === 'new-pw' ? 'new-pw-hint' : undefined} />
      {onToggle && (
        <button type="button" className="pw-eye" onClick={onToggle} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
          <Icon name={show ? 'eyeoff' : 'eye'} size={22} />
        </button>
      )}
    </div>
  );
}
