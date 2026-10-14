import React, { useState } from 'react';
import { errorMessage, store, useData } from '../shared/react';
import type { AuthUser } from '../shared/types';
import { Flower, Logo, Marquee } from '../shared/brand';
import { Avatar, Icon, roleLabel, teacherIds } from './ui';

export function SignIn({ notStaff, onDone }: { notStaff?: boolean; onDone?: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(notStaff ? 'That account is a client account. Sign in with your staff email.' : null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const personas = useData(async () => {
    if (store.mode !== 'demo') return [];
    const list = (await store.demoPersonas()).filter((p) => p.kind === 'staff');
    const [staff, templates] = await Promise.all([store.listStaff().catch(() => []), store.listTemplates().catch(() => [])]);
    const teaching = teacherIds(templates);
    return list.map((p) => ({
      p, photo: p.kind === 'staff' ? staff.find((s) => s.id === p.staffId)?.photoUrl : undefined,
      role: p.kind === 'staff' ? roleLabel(p.role, teaching.has(p.staffId)) : 'Client',
    }));
  }, []);

  const finish = (u: AuthUser) => {
    if (u.kind !== 'staff') { setErr('That account is a client account. Sign in with your staff email.'); store.signOut(); return; }
    location.hash = '/';
    onDone?.();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { finish(await store.signIn(email.trim(), password)); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  const quick = async (p: AuthUser) => {
    setErr(null); setBusy(true);
    try { finish(store.demoSignInAs ? await store.demoSignInAs(p) : await store.signIn(p.email, 'demo')); } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!email.trim()) { setErr('Enter your email first, then tap "Forgot password".'); return; }
    try { await store.requestPasswordReset(email.trim()); setResetSent(true); setErr(null); } catch (x) { setErr(errorMessage(x)); }
  };

  return (
    <div className="signin">
      <section className="si-art">
        <img className="si-photo" src="../img/wide.webp" alt="" />
        <div className="si-art-inner">
          <Logo animate className="si-logo" letters="var(--cream)" flower="var(--sky)" />
          <div className="si-copy">
            <p className="si-quote">Behind the scenes at the newest club in <em>Cooma.</em></p>
            <p className="si-addr">Studio app<Flower size={9} />57 Vale Street, Cooma</p>
          </div>
        </div>
        <Marquee tone="navy" speed={60} />
      </section>
      <section className="si-form">
        <div className="si-box">
          <div className="eyebrow"><Flower size={12} className="eb-fl" />Staff only</div>
          <h1>Welcome <em>back</em></h1>
          <p className="muted" style={{ marginTop: 10 }}>Sign in to run today's classes, check people in and look after clients.</p>

          <form className="stack" style={{ marginTop: 26 }} onSubmit={submit}>
            <label className="field"><span>Email</span>
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@snowypilatesclub.com" />
            </label>
            <label className="field"><span>Password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {err && <p className="form-err" role="alert">{err}</p>}
            {resetSent && <p className="form-ok">If that email has a staff account, a reset link is on its way.</p>}
            <button className="btn block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <button type="button" className="linkish" onClick={reset}>Forgot password?</button>
          </form>

          {(personas.data?.length ?? 0) > 0 && (
            <div className="si-demo">
              <div className="si-demo-head"><span className="chip cream">Demo</span><span className="muted small">Quick sign in, no password needed</span></div>
              <div className="si-personas">
                {personas.data!.map(({ p, photo, role }) => (
                  <button key={p.kind === 'staff' ? p.staffId : p.email} className="persona" onClick={() => quick(p)} disabled={busy}>
                    <Avatar name={p.name} photo={photo} size={40} />
                    <span className="persona-t"><strong>Sign in as {p.name}</strong><span>{role}</span></span>
                    <Icon name="right" size={18} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <a className="si-client" href="../"><Icon name="external" size={18} />Looking to book a class? Open the client app</a>
        </div>
      </section>
    </div>
  );
}
