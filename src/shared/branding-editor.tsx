/**
 * Branding editor + live preview of the client app, shared by the admin app (Pete), the studio app's
 * Settings › Branding and the onboarding wizard. Works on a StudioBranding value; the caller saves it.
 * OWNED BY THE LEAD / PLATFORM.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { BrandColors, StudioBranding } from './types';
import { brandAsset, brandTokens, brandingWarnings, fontsUrl, textLogo, DEFAULT_MARK } from './branding';
import { Accented, Flower, Logo, Marquee } from './brand';

/** Google Fonts that read well in the apps (any Google Fonts family name also works). */
export const DISPLAY_FONTS = ['Instrument Serif', 'Gloock', 'Fraunces', 'Playfair Display', 'Cormorant Garamond', 'DM Serif Display', 'Young Serif', 'Lora', 'Libre Baskerville', 'Bricolage Grotesque'];
export const BODY_FONTS = ['Questrial', 'Work Sans', 'Instrument Sans', 'Inter', 'DM Sans', 'Manrope', 'Outfit', 'Nunito Sans', 'Karla', 'Lato'];

const COLOR_FIELDS: { key: keyof BrandColors; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Buttons, bands, the studio sidebar' },
  { key: 'ink', label: 'Ink', hint: 'Text and the darkest surfaces' },
  { key: 'accent', label: 'Accent', hint: 'The italic word, your mark' },
  { key: 'soft', label: 'Soft', hint: 'Panels and toggles' },
  { key: 'highlight', label: 'Highlight', hint: 'Badges and offers' },
  { key: 'bg', label: 'Background', hint: 'The page' },
];

/** Starting palettes for new studios. */
export const PALETTES: { name: string; colors: BrandColors }[] = [
  { name: 'Coastal', colors: { primary: '#2E5E7E', ink: '#17293A', accent: '#8FB8D0', soft: '#E9F1F5', highlight: '#F1E3C8', bg: '#F8F6F1' } },
  { name: 'Harbour', colors: { primary: '#1F4A3D', ink: '#14261F', accent: '#C9A877', soft: '#EAE6DB', highlight: '#E4D3B2', bg: '#F6F3EC' } },
  { name: 'Clay', colors: { primary: '#9A5B3F', ink: '#3A2419', accent: '#E0A98A', soft: '#F4EBE5', highlight: '#EED9B8', bg: '#FBF7F2' } },
  { name: 'Slate', colors: { primary: '#3E5466', ink: '#1F2A33', accent: '#93A9B8', soft: '#EDF1F3', highlight: '#EDE3D1', bg: '#F9F8F5' } },
  { name: 'Plum', colors: { primary: '#5B4470', ink: '#2A1F35', accent: '#B9A3CF', soft: '#F1ECF5', highlight: '#EFE2CC', bg: '#FAF8F6' } },
];

const readAsDataUrl = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(new Error('That file couldn’t be read.'));
  r.readAsDataURL(f);
});
async function imageAspect(url: string): Promise<number> {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth / Math.max(1, i.naturalHeight)); i.onerror = () => res(2.5); i.src = url; });
}

/** Load the families used in a preview (once per URL). */
function usePreviewFonts(fonts: StudioBranding['fonts']) {
  const href = fontsUrl(fonts);
  useEffect(() => {
    if (typeof document === 'undefined' || document.querySelector(`link[data-preview-fonts="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-preview-fonts', href);
    document.head.appendChild(l);
  }, [href]);
}

export function BrandingEditor({ value, onChange, name, upload, compact }: {
  value: StudioBranding;
  onChange: (b: StudioBranding) => void;
  /** Studio name, for the text logo. */
  name: string;
  /** Upload an image and return its URL (default: keep it inline as a data URL, fine for the demo). */
  upload?: (file: File) => Promise<string>;
  /** Fewer fields (onboarding): logo, colours, fonts. */
  compact?: boolean;
}) {
  const b = value;
  const set = (patch: Partial<StudioBranding>) => onChange({ ...b, ...patch });
  const setColor = (k: keyof BrandColors, v: string) => {
    const colors = { ...b.colors, [k]: v };
    // Hand-tuned shades belong to the old colours: let them be worked out again.
    if (k === 'primary') delete colors.primaryDeep;
    if (k === 'soft') delete colors.softDeep;
    if (k === 'highlight') delete colors.highlightSoft;
    if (k === 'ink' || k === 'bg') { delete colors.muted; delete colors.faint; }
    const { tokens: _t, ...rest } = b;
    onChange({ ...rest, colors });
  };
  const [err, setErr] = useState('');
  const warn = brandingWarnings(b);
  const pick = (accept: string, then: (url: string, file: File) => void) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) { setErr('That image is over 4 MB. Please choose a smaller one.'); return; }
      setErr('');
      try { then(upload ? await upload(f) : await readAsDataUrl(f), f); } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed.'); }
    };
    input.click();
  };
  const uploadLogo = () => pick('image/png,image/svg+xml,image/webp,image/jpeg', async (url) => {
    const aspect = await imageAspect(brandAsset(url) ?? url);
    set({ logo: { imageUrl: url, aspect } });
  });
  const useTextLogo = () => {
    const t = textLogo(name, { markD: b.mark.d ?? DEFAULT_MARK.d, ...(b.mark.viewBox ? { markViewBox: b.mark.viewBox } : {}) });
    set({ logo: { svg: t.svg, viewBox: t.viewBox, aspect: t.aspect } });
  };
  const fontField = (k: 'display' | 'body', list: string[]) => (
    <label className="field">
      <span>{k === 'display' ? 'Headings font' : 'Body font'}</span>
      <input className="input" list={`bf-${k}`} value={b.fonts[k]} onChange={(e) => set({ fonts: { ...b.fonts, [k]: e.target.value } })} />
      <datalist id={`bf-${k}`}>{list.map((f) => <option key={f} value={f} />)}</datalist>
    </label>
  );

  return (
    <div className="be">
      <section className="be-sec">
        <h3>Logo</h3>
        <div className="be-logo">
          <div className="be-logo-box"><Logo branding={b} className="be-logo-img" style={{ width: '100%', height: 'auto' }} /></div>
          <div className="be-logo-actions">
            <button type="button" className="btn soft sm" onClick={uploadLogo}>Upload a logo</button>
            <button type="button" className="btn ghost sm" onClick={useTextLogo}>Use a text logo</button>
            <span className="small muted">PNG, SVG or WebP. A wide logo on a clear background works best.</span>
          </div>
        </div>
      </section>

      <section className="be-sec">
        <h3>Colours</h3>
        <div className="be-palettes" role="group" aria-label="Starting palettes">
          {PALETTES.map((p) => (
            <button key={p.name} type="button" className="be-pal" onClick={() => { const { tokens: _t, ...rest } = b; onChange({ ...rest, colors: { ...p.colors } }); }} title={p.name}>
              {(['primary', 'accent', 'highlight', 'soft'] as const).map((k) => <span key={k} style={{ background: p.colors[k] }} />)}
              <em>{p.name}</em>
            </button>
          ))}
        </div>
        <div className="be-colors">
          {COLOR_FIELDS.map((c) => (
            <label key={c.key} className="be-color">
              <input type="color" value={b.colors[c.key] ?? '#000000'} onChange={(e) => setColor(c.key, e.target.value.toUpperCase())} aria-label={`${c.label} colour`} />
              <span><strong>{c.label}</strong><small>{c.hint}</small></span>
              <input className="input sm" value={b.colors[c.key] ?? ''} onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && setColor(c.key, e.target.value.toUpperCase())} aria-label={`${c.label} hex`} />
            </label>
          ))}
        </div>
        {warn.map((w) => <p key={w} className="small be-warn">{w}</p>)}
      </section>

      <section className="be-sec">
        <h3>Fonts</h3>
        <div className="be-grid">{fontField('display', DISPLAY_FONTS)}{fontField('body', BODY_FONTS)}</div>
        <p className="small muted">Any Google Fonts family works. Type its name exactly as it appears on fonts.google.com.</p>
      </section>

      {!compact && (
        <>
          <section className="be-sec">
            <h3>Words</h3>
            <div className="be-grid">
              <label className="field"><span>App name</span><input className="input" value={b.appName} onChange={(e) => set({ appName: e.target.value })} /></label>
              <label className="field"><span>Short name (home screen)</span><input className="input" maxLength={12} value={b.shortName} onChange={(e) => set({ shortName: e.target.value })} /></label>
            </div>
            <label className="field"><span>Welcome headline (wrap the accent word in *stars*)</span><input className="input" value={b.welcome.headline} onChange={(e) => set({ welcome: { ...b.welcome, headline: e.target.value } })} /></label>
            <label className="field"><span>Welcome line</span><textarea className="textarea" value={b.welcome.copy} onChange={(e) => set({ welcome: { ...b.welcome, copy: e.target.value } })} /></label>
            <label className="field"><span>Scrolling phrases (one per line)</span><textarea className="textarea" value={b.marquee.join('\n')} onChange={(e) => set({ marquee: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></label>
          </section>
          <section className="be-sec">
            <h3>Photos</h3>
            <div className="be-photos">
              {([['hero', 'Main photo'], ['offer', 'Offer photo']] as const).map(([k, label]) => (
                <div key={k} className="be-photo">
                  <span className="be-photo-img">{(b.photos[k] ?? (k === 'offer' ? b.photos.hero : '')) && <img src={brandAsset(b.photos[k] ?? b.photos.hero)} alt="" />}</span>
                  <button type="button" className="btn soft sm" onClick={() => pick('image/jpeg,image/png,image/webp', (url) => set({ photos: { ...b.photos, [k]: url } }))}>{label}</button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
    </div>
  );
}

/** A phone-sized preview of the client app (welcome + timetable) in a studio's branding. */
export function BrandPreview({ branding, name }: { branding: StudioBranding; name: string }) {
  usePreviewFonts(branding.fonts);
  const style = useMemo(() => brandTokens(branding) as React.CSSProperties, [branding]);
  const b = branding;
  return (
    <div className="bp" style={style} aria-label={`Preview of ${name}'s client app`}>
      <div className="bp-phone">
        <section className="bp-hero">
          {b.photos.hero && <img src={brandAsset(b.photos.hero)} alt="" />}
          <div className="bp-shade" />
          <div className="bp-copy">
            <Logo branding={b} letters="var(--highlight)" flower="var(--accent)" style={{ width: 150, height: 'auto' }} />
            <h2><Accented text={b.welcome.headline} /></h2>
            <div className="bp-actions"><span className="bp-btn white">Join</span><span className="bp-btn glass">Sign in</span></div>
          </div>
        </section>
        <Marquee branding={b} speed={30} />
        <div className="bp-body">
          <div className="bp-kicker"><Flower branding={b} size={10} /> Tomorrow</div>
          {[['6:15', 'am', 'Morning flow', '3 spots'], ['12:15', 'pm', 'Foundations', 'Full · waitlist'], ['5:45', 'pm', 'Evening class', '5 spots']].map(([t, ap, n, s], i) => (
            <div key={i} className="bp-cls"><span className="bp-time">{t}<small>{ap}</small></span><span className="bp-name">{n}<small>{s}</small></span><span className="bp-book">Book</span></div>
          ))}
          <div className="bp-offer"><strong>Intro offer</strong><span>New clients</span></div>
        </div>
        <nav className="bp-tabs"><span className="on">Timetable</span><span>Bookings</span><span>Passes</span><span>Profile</span></nav>
      </div>
    </div>
  );
}
