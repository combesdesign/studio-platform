/**
 * "Choose a new password" for staff: forgot-password and staff-invite links.
 * The store calls onPasswordRecovery's handler when someone lands from an emailed link ('recovery' or 'invite');
 * live, the link has already signed them in. We register at startup (this module loads before React renders).
 */
import React, { useEffect, useState } from 'react';
import { errorMessage, store, useRoute } from '../shared/react';
import { StoreError } from '../shared/store';
import { Flower } from '../shared/brand';
import { Icon } from './ui';
import { SignInArt, clearResetNote } from './signin';

export type PasswordLinkKind = 'invite' | 'recovery';
const LINK_KEY = 'spc.studio.pwlink';
const BOOT_HASH = typeof location !== 'undefined' ? location.hash : '';
let linkKind: PasswordLinkKind | null = (() => { try { const v = sessionStorage.getItem(LINK_KEY); return v === 'invite' || v === 'recovery' ? v : null; } catch { return null; } })();
let linkQueued: PasswordLinkKind | null = null;
const listeners = new Set<(k: PasswordLinkKind) => void>();
/** Opened from the demo button on the sign-in screen (pushed, so back returns there) vs a real link (replaced). */
let fromSignIn = false;
let pushed = false;

store.onPasswordRecovery?.((kind?: PasswordLinkKind) => {
  const k: PasswordLinkKind = kind === 'invite' ? 'invite' : 'recovery';
  linkKind = k;
  try { sessionStorage.setItem(LINK_KEY, k); } catch { /* private mode */ }
  if (listeners.size) listeners.forEach((l) => l(k)); else linkQueued = k;
});

/** Expired or already-used link (Supabase: '#error=…&error_code=otp_expired'): the sign-in screen explains. */
export const LINK_PROBLEM = /[#&]error(_code)?=/.test(BOOT_HASH) && /otp_expired|access_denied|invalid/i.test(BOOT_HASH)
  ? 'That link has expired or was already used. Enter your email and tap "Forgot password?" for a fresh one.' : null;

export function setLinkOrigin(signIn: boolean) { fromSignIn = signIn; }
export function endPasswordLink() {
  linkKind = null;
  try { sessionStorage.removeItem(LINK_KEY); } catch { /* private mode */ }
}
/** Demo only: the demo store's stand-in for tapping the emailed link (not part of DataStore). */
export function demoOpenPasswordLink(kind: PasswordLinkKind, email?: string): Promise<boolean> {
  const s = store as unknown as { demoOpenPasswordLink?: (k: PasswordLinkKind, e?: string) => Promise<boolean> };
  return s.demoOpenPasswordLink ? s.demoOpenPasswordLink(kind, email) : Promise.resolve(false);
}

/** While '#/new-password' is up for a link that arrived this session: its kind. arriving = supabase-js still signing the link in. */
export function usePasswordLink(): { kind: PasswordLinkKind | null; arriving: boolean } {
  const [path, nav] = useRoute();
  const [kind, setKind] = useState<PasswordLinkKind | null>(linkKind);
  const [arriving, setArriving] = useState(() => /access_token=/.test(BOOT_HASH) && /type=(invite|recovery)/.test(BOOT_HASH));
  useEffect(() => {
    const on = (k: PasswordLinkKind) => {
      setKind(k);
      setArriving(false);
      pushed = fromSignIn;
      fromSignIn = false;
      nav('/new-password', { replace: !pushed });
    };
    listeners.add(on);
    if (linkQueued) { const k = linkQueued; linkQueued = null; on(k); }
    const t = window.setTimeout(() => setArriving(false), 6000);
    return () => { listeners.delete(on); window.clearTimeout(t); };
  }, []);
  const onScreen = path.split('?')[0] === '/new-password';
  useEffect(() => { if (!onScreen && kind) setKind(null); }, [onScreen]);
  return { kind: onScreen ? kind : null, arriving };
}

export function NewPassword({ kind, email, signedIn, onSaved }: {
  kind: PasswordLinkKind; email?: string; signedIn: boolean; onSaved: (kind: PasswordLinkKind) => Promise<void> | void;
}) {
  const invite = kind === 'invite';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<{ msg: string; field?: 'pw' | 'pw2' } | null>(null);
  const [busy, setBusy] = useState(false);
  const long = pw.length >= 8;
  const back = () => {
    endPasswordLink();
    if (pushed) { pushed = false; history.back(); } else location.replace('#/');
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!long) { setErr({ field: 'pw', msg: pw ? `That’s only ${pw.length} character${pw.length === 1 ? '' : 's'}. Make it at least 8 – a short phrase works well.` : 'Pop in a new password – at least 8 characters.' }); return; }
    if (!pw2) { setErr({ field: 'pw2', msg: 'Type your new password once more to confirm it.' }); return; }
    if (pw !== pw2) { setErr({ field: 'pw2', msg: 'Those two don’t quite match. Have another go.' }); return; }
    setErr(null); setBusy(true);
    try {
      if (!store.setNewPassword) throw new Error('Setting a password isn’t available right now. Please ask Libby.');
      await store.setNewPassword(pw);
      pushed = false;
      clearResetNote();
      await onSaved(kind);
    } catch (x) {
      setErr({ msg: x instanceof StoreError && x.code === 'LINK_EXPIRED' ? 'That link has expired. Go back and tap "Forgot password?" for a new one.' : errorMessage(x) });
      setBusy(false);
    }
  };
  const bad = (f: 'pw' | 'pw2') => (err?.field === f ? true : undefined);
  const wide = typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 700px)').matches;
  return (
    <div className="signin new-pw">
      <SignInArt />
      <section className="si-form">
        <div className="si-box">
          <button type="button" className="back-pill si-back" onClick={back}><Icon name="left" size={20} /><span>{signedIn ? 'Today' : 'Sign in'}</span></button>
          <div className="eyebrow"><Flower size={12} className="eb-fl" />{invite ? 'Staff invite' : 'Password reset'}</div>
          <h1>{invite ? <>Welcome to the <em>team</em></> : <>Choose a new <em>password</em></>}</h1>
          <p className="muted" style={{ marginTop: 10 }}>
            {invite ? 'Set a password for your staff login. You’ll use it to sign in to the studio app on the front-desk iPad or your phone.'
              : 'Make it something you’ll remember. You’ll use it to sign in to the studio app from now on.'}
          </p>
          {email && <p className="for-account"><Icon name="users" size={18} /><span>{email}</span></p>}

          <form className="stack" style={{ marginTop: email ? 18 : 26 }} onSubmit={submit} noValidate>
            {email && <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />}
            <div className="field">
              <label htmlFor="new-pw">{invite ? 'Password' : 'New password'}</label>
              <div className="pw-wrap">
                <input id="new-pw" className="input" type={show ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={pw} onChange={(e) => { setPw(e.target.value); if (err?.field === 'pw') setErr(null); }} aria-invalid={bad('pw')} aria-describedby="new-pw-hint" autoFocus={wide} />
                <button type="button" className="pw-eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                  <Icon name={show ? 'eyeoff' : 'eye'} size={22} />
                </button>
              </div>
              <p className={'pw-hint' + (long ? ' ok' : '')} id="new-pw-hint">{long ? <Icon name="check" size={18} /> : <Flower size={13} />}At least 8 characters</p>
            </div>
            <div className="field">
              <label htmlFor="new-pw2">Confirm password</label>
              <input id="new-pw2" className="input" type={show ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                value={pw2} onChange={(e) => { setPw2(e.target.value); if (err?.field === 'pw2') setErr(null); }} aria-invalid={bad('pw2')} />
            </div>
            {err && <p className="form-err" role="alert">{err.msg}</p>}
            <button className="btn block" disabled={busy}>{busy ? 'Saving…' : invite ? 'Save password' : 'Save new password'}</button>
          </form>
        </div>
      </section>
    </div>
  );
}
