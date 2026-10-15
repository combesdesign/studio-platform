/**
 * Which studio? For the studio app on the platform when the address doesn't say: staff sign in once (person
 * level), then go to their studio (or pick one if they work at several). Plus the in-app studio switcher.
 * Neutral platform look until a studio is chosen.
 */
import React, { useEffect, useState } from 'react';
import type { Studio, StudioMembership } from '../shared/types';
import { platform } from '../data';
import { Accented, Flower, Logo } from '../shared/brand';
import { PLATFORM_NAME } from '../shared/branding';
import { rememberStudio, switchStudio } from '../shared/boot';
import { Sheet } from '../shared/react';
import { Icon, SheetHead } from './ui';

const ROLE: Record<string, string> = { owner: 'Owner', manager: 'Manager', front_desk: 'Front desk', instructor: 'Instructor' };
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export function ChooseStudio({ start, missing }: { start: (s: Studio) => void; missing?: string }) {
  const [person, setPerson] = useState<{ email: string; name: string } | null | undefined>(undefined);
  const [mine, setMine] = useState<StudioMembership[] | null>(null);
  const [err, setErr] = useState('');
  const go = async (studioId: string) => {
    const s = await platform.findStudio({ id: studioId });
    if (!s) { setErr('That studio isn’t available right now.'); return; }
    rememberStudio('studio', s.slug);
    history.replaceState(history.state, '', location.pathname + location.search + '#/');
    start(s);
  };
  const load = async () => {
    const p = await platform.currentPerson().catch(() => null);
    setPerson(p);
    if (!p) return;
    const m = (await platform.myMemberships()).filter((x) => x.kind === 'staff' && x.status !== 'suspended');
    setMine(m);
    if (m.length === 1) await go(m[0]!.studioId);
  };
  useEffect(() => { void load(); }, []);

  return (
    <div className="choose">
      <div className="choose-card">
        <Logo className="choose-logo" label={PLATFORM_NAME} />
        {person === undefined ? <div className="choose-wait"><Flower size={28} spin /></div>
          : !person ? <PlatformSignIn onDone={load} missing={missing} />
          : (
            <>
              <p className="eyebrow">Signed in as {person.email}</p>
              <h1><Accented text="Choose your *studio*" /></h1>
              {err && <p className="form-error" role="alert">{err}</p>}
              {mine === null ? <div className="choose-wait"><Flower size={28} spin /></div>
                : mine.length === 0 ? <p className="muted">You’re not on the team at any studio yet. Ask the studio owner to add you with this email.</p>
                : (
                  <div className="choose-list">
                    {mine.map((m) => (
                      <button key={m.studioId} className="persona" onClick={() => go(m.studioId)}>
                        <span className="choose-initial serif">{m.name.charAt(0)}</span>
                        <span className="persona-t"><strong>{m.name}</strong><span>{ROLE[m.role ?? ''] ?? 'Staff'}{m.status === 'onboarding' ? ' · setting up' : ''}</span></span>
                        <Icon name="right" size={18} />
                      </button>
                    ))}
                  </div>
                )}
              <button className="btn ghost block" onClick={async () => { await platform.signOut(); setMine(null); void load(); }}>Sign out</button>
            </>
          )}
      </div>
    </div>
  );
}

function PlatformSignIn({ onDone, missing }: { onDone: () => void; missing?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(missing ? `We couldn’t find the studio “${missing}”. Sign in to see yours.` : '');
  const [busy, setBusy] = useState(false);
  const [personas, setPersonas] = useState<{ email: string; name: string; hint: string }[]>([]);
  useEffect(() => { platform.demoPersonas?.('studio').then(setPersonas, () => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await platform.signIn(email.trim(), password); onDone(); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  const quick = async (em: string) => {
    setErr(''); setBusy(true);
    try { await platform.demoSignInAs!(em); onDone(); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <p className="eyebrow">Studio app</p>
      <h1><Accented text="Welcome *back*" /></h1>
      <p className="muted">Sign in with your staff email. We’ll take you to your studio.</p>
      <form className="stack lg choose-form" onSubmit={submit}>
        <label className="field"><span>Email</span><input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {personas.length > 0 && (
        <div className="choose-demo">
          <p className="eyebrow"><Flower size={10} /> Demo: sign in as</p>
          <div className="choose-list">
            {personas.map((p) => (
              <button key={p.email} className="persona" onClick={() => quick(p.email)} disabled={busy}>
                <span className="choose-initial serif">{p.name.charAt(0)}</span>
                <span className="persona-t"><strong>{p.name}</strong><span>{p.hint}</span></span>
                <Icon name="right" size={18} />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** "Switch studio" for staff who work at more than one (hidden otherwise). */
export function StudioSwitcher({ current, variant = 'side' }: { current: Studio; variant?: 'side' | 'row' }) {
  const [list, setList] = useState<StudioMembership[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    platform.myMemberships().then((m) => setList(m.filter((x) => x.kind === 'staff' && x.status !== 'suspended')), () => {});
  }, []);
  if (list.length < 2) return null;
  return (
    <>
      {variant === 'side'
        ? <button className="side-link side-switch" onClick={() => setOpen(true)}><Icon name="repeat" size={18} /><span>Switch studio</span></button>
        : <button onClick={() => setOpen(true)}><Icon name="repeat" />Switch studio<Icon name="right" size={18} className="push" /></button>}
      <Sheet open={open} onClose={() => setOpen(false)} label="Switch studio">
        <SheetHead title={<>Switch <em>studio</em></>} onClose={() => setOpen(false)} />
        <div className="choose-list">
          {list.map((m) => (
            <button key={m.studioId} className="persona" disabled={m.studioId === current.id} onClick={() => switchStudio('studio', m.slug)}>
              <span className="choose-initial serif">{m.name.charAt(0)}</span>
              <span className="persona-t"><strong>{m.name}</strong><span>{ROLE[m.role ?? ''] ?? 'Staff'}{m.studioId === current.id ? ' · you’re here' : ''}</span></span>
              <Icon name="right" size={18} />
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
