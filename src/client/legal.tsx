/**
 * Privacy policy and terms: public pages (#/privacy, #/terms, reachable signed out) and an in-place sheet for the sign-up form,
 * the waiver step and Profile. The text comes from src/shared/legal.ts (a draft, to be reviewed by a lawyer) filled in with the
 * studio's details, unless the studio saved its own text in Settings.
 */
import React from 'react';
import { store, useData, Sheet } from '../shared/react';
import { customLegalDoc, privacyPolicy, termsOfUse, type LegalDoc } from '../shared/legal';
import { BackPill, ErrorBlock, Logo, SheetHead, Skeleton } from './ui';
import { backOut } from './lib';

export type LegalKind = 'privacy' | 'terms';
type Nav = (to: string, o?: { replace?: boolean }) => void;

export const LEGAL_PATHS: Record<string, LegalKind> = { '/privacy': 'privacy', '/terms': 'terms' };

/** The document for this studio, or null while loading. Works signed out (studio details and settings are public). */
export function useLegalDoc(kind: LegalKind) {
  return useData(async (): Promise<LegalDoc> => {
    const [studio, s] = await Promise.all([store.getStudio().catch(() => null), store.getSettings().catch(() => null)]);
    const custom = (kind === 'privacy' ? s?.privacyPolicyText : s?.termsText)?.trim();
    if (custom) return customLegalDoc(kind === 'privacy' ? 'Privacy policy' : 'Terms of use', custom);
    const ctx = {
      studioName: s?.name || studio?.name || '', abn: s?.abn || studio?.taxId, abnLabel: studio?.taxIdLabel || 'ABN',
      email: s?.email || studio?.email || '', phone: s?.phone || studio?.phone, address: s?.address || studio?.address || '',
    };
    return kind === 'privacy' ? privacyPolicy(ctx) : termsOfUse(ctx);
  }, [kind]);
}

export function LegalBody({ doc }: { doc: LegalDoc }) {
  return (
    <article className="legal">
      {doc.intro && <p className="lede">{doc.intro}</p>}
      {doc.updated && <p className="muted fine">Last updated {doc.updated}</p>}
      {doc.sections.map((sec, i) => (
        <section key={i}>
          {sec.heading && <h3>{sec.heading}</h3>}
          {sec.paragraphs?.map((p, j) => <p key={j}>{p}</p>)}
          {sec.bullets && <ul>{sec.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>}
        </section>
      ))}
    </article>
  );
}

function Loaded({ kind }: { kind: LegalKind }) {
  const d = useLegalDoc(kind);
  if (d.error && !d.data) return <ErrorBlock error={d.error} onRetry={d.reload} />;
  if (!d.data) return <div className="stack"><Skeleton h={22} w="60%" /><Skeleton h={90} /><Skeleton h={90} /></div>;
  return <LegalBody doc={d.data} />;
}

/** Full page at #/privacy or #/terms (public). */
export function LegalPage({ kind, nav, path }: { kind: LegalKind; nav: Nav; path: string }) {
  const other: LegalKind = kind === 'privacy' ? 'terms' : 'privacy';
  return (
    <div className="auth legal-page">
      <div className="auth-top">
        <BackPill label="Back" onClick={() => backOut(nav, path, '/')} />
        <Logo width={96} />
        <span className="auth-top-gap" />
      </div>
      <div className="auth-body">
        <h1>{kind === 'privacy' ? <>Privacy <em>policy</em></> : <>Terms of <em>use</em></>}</h1>
        <Loaded kind={kind} />
        <p className="legal-other"><button type="button" className="btn link-btn" onClick={() => nav('/' + other, { replace: true })}>{other === 'privacy' ? 'Read our privacy policy' : 'Read our terms of use'}</button></p>
      </div>
    </div>
  );
}

/** The same text in a sheet, so a half-filled form stays where it is. */
export function LegalSheet({ kind, onClose }: { kind: LegalKind | null; onClose: () => void }) {
  const last = React.useRef<LegalKind>('privacy');
  if (kind) last.current = kind;
  const k = kind ?? last.current;
  return (
    <Sheet open={!!kind} onClose={onClose} label={k === 'privacy' ? 'Privacy policy' : 'Terms of use'}>
      <SheetHead title={k === 'privacy' ? <>Privacy <em>policy</em></> : <>Terms of <em>use</em></>} onClose={onClose} />
      {kind && <Loaded kind={k} />}
    </Sheet>
  );
}

/** "By continuing you accept our Terms and Privacy policy" with both opening the sheet. */
export function LegalLinks({ lead, onOpen }: { lead?: string; onOpen: (k: LegalKind) => void }) {
  return (
    <p className="muted fine legal-links">
      {lead ? lead + ' ' : ''}
      <button type="button" className="link-btn inline" onClick={() => onOpen('terms')}>Terms of use</button> and{' '}
      <button type="button" className="link-btn inline" onClick={() => onOpen('privacy')}>Privacy policy</button>.
    </p>
  );
}
