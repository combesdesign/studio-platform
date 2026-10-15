/**
 * Brand pieces shared by every app, drawn from the current studio's branding (src/shared/branding.ts):
 * the animated logo, the mark (Snowy's flower), mark stars, the phrase marquee and *accent* headlines.
 * OWNED BY THE LEAD / PLATFORM. No studio is named in here.
 */
import React from 'react';
import type { StudioBranding } from './types';
import { accentParts, brandAsset, getBranding } from './branding';

/**
 * The studio's logo. animate=true plays the reveal (letters rise in one by one, then the mark spins in) for
 * path-set and SVG logos. letters/flower = fill colours (default primary + accent; on dark bands use
 * highlight + accent like Snowy's website hero).
 */
export function Logo({ animate = false, letters = 'var(--primary)', flower = 'var(--accent)', className = '', style, label, branding }:
  { animate?: boolean; letters?: string; flower?: string; className?: string; style?: React.CSSProperties; label?: string; branding?: StudioBranding }) {
  const b = branding ?? getBranding();
  const name = label ?? b.appName;
  const cls = `spc-logo${animate ? ' spc-logo-anim' : ''} ${className}`;
  const vars = { ['--logo-letters' as string]: letters, ['--logo-mark' as string]: flower } as React.CSSProperties;
  const { logo } = b;
  if (logo.paths?.length) {
    return (
      <svg className={cls} viewBox={logo.viewBox} role="img" aria-label={name} style={style}>
        {logo.paths.map((p, i) => (
          <path key={i} className={p.c} d={p.d} fill={p.c === 'lf' ? flower : letters} style={{ ['--n' as string]: p.n } as React.CSSProperties} />
        ))}
      </svg>
    );
  }
  if (logo.svg) {
    return <svg className={cls} viewBox={logo.viewBox ?? '0 0 600 180'} role="img" aria-label={name} style={{ ...vars, ...style }} dangerouslySetInnerHTML={{ __html: logo.svg }} />;
  }
  if (logo.imageUrl) {
    return <img className={cls + ' spc-logo-img'} src={brandAsset(logo.imageUrl)} alt={name} style={{ aspectRatio: String(logo.aspect), objectFit: 'contain', ...style }} />;
  }
  return <span className={cls + ' spc-logo-text'} style={{ color: letters, ...style }}>{name}</span>;
}

/** Width / height of the current logo, for sizing (style={{ aspectRatio: logoAspect() }}). */
export const logoAspect = () => getBranding().logo.aspect || 2.3;

/** The studio's mark (Snowy's flower): stars, bullets, separators, empty states. */
export function Flower({ size = 16, color = 'var(--accent)', className = '', spin = false, style, branding }:
  { size?: number | string; color?: string; className?: string; spin?: boolean; style?: React.CSSProperties; branding?: StudioBranding }) {
  const { mark } = branding ?? getBranding();
  const cls = `spc-flower${spin ? ' spc-flower-spin' : ''} ${className}`;
  if (!mark.d && mark.imageUrl) return <img className={cls} src={brandAsset(mark.imageUrl)} width={size} height={size} alt="" aria-hidden="true" style={style} />;
  return (
    <svg className={cls} viewBox={mark.viewBox ?? '0 0 100 100'} width={size} height={size} aria-hidden="true" style={style}>
      <path d={mark.d ?? ''} fill={color} />
    </svg>
  );
}

/** Five marks in place of stars, like Snowy's website reviews. */
export function FlowerStars({ count = 5, size = 13 }: { count?: number; size?: number }) {
  return <span className="spc-stars" aria-label={`${count} stars`}>{Array.from({ length: count }, (_, i) => <Flower key={i} size={size} />)}</span>;
}

/** The studio's scrolling phrases. */
export const brandPhrases = (): string[] => getBranding().marquee;

/** The scrolling phrase strip with mark separators. Renders nothing if the studio has no phrases. */
export function Marquee({ phrases, tone = 'navy', speed = 45, branding }: { phrases?: string[]; tone?: 'navy' | 'mist' | 'cream'; speed?: number; branding?: StudioBranding }) {
  const list = phrases ?? (branding ? branding.marquee : brandPhrases());
  if (!list.length) return null;
  const row = list.map((p, i) => <span key={i}>{p}<Flower size={18} branding={branding} color={tone === 'navy' ? 'var(--accent)' : 'var(--primary)'} /></span>);
  return (
    <div className={`spc-marquee spc-marquee-${tone}`} aria-hidden="true">
      <div className="spc-track" style={{ animationDuration: `${speed}s` }}>{row}{row}</div>
    </div>
  );
}

/** 'Join the newest club to hit *Cooma!*' -> Join the newest club to hit <em>Cooma!</em> */
export function Accented({ text }: { text: string }) {
  return <>{accentParts(text).map((p, i) => (p.em ? <em key={i}>{p.text}</em> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>;
}
