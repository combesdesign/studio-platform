/** Settings › Branding: the studio's logo, colours, fonts, words and photos, with a live preview of the client app. */
import React, { useEffect, useState } from 'react';
import type { StudioBranding } from '../shared/types';
import { store, useAction } from '../shared/react';
import { applyBranding } from '../shared/branding';
import { BrandingEditor, BrandPreview } from '../shared/branding-editor';
import { useStudio } from './ui';

export function BrandingTab() {
  const { studio, can } = useStudio();
  const [b, setB] = useState<StudioBranding>(studio.branding);
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => { setB(studio.branding); setDirty(false); }, [studio.branding]);
  const change = (next: StudioBranding) => { setB(next); setDirty(true); };
  const save = async () => {
    const r = await run(() => store.updateStudio({ branding: b }), 'Branding saved');
    if (r) { applyBranding(r.branding, { title: `Studio · ${r.branding.appName}`, themeColor: r.branding.colors.ink }); setDirty(false); }
  };
  const editable = can('settings');
  return (
    <div className="brand-tab">
      <div className="brand-edit">
        <p className="muted">How your studio looks in the client app and here. Changes show in the preview straight away and go live when you save.</p>
        <fieldset disabled={!editable} className="bare-fieldset">
          <BrandingEditor value={b} onChange={change} name={studio.name} {...(store.uploadBrandingImage ? { upload: (f: File) => store.uploadBrandingImage!(f) } : {})} />
        </fieldset>
        {editable && dirty && (
          <div className="savebar">
            <span>Unsaved branding</span>
            <button className="btn sm glass" disabled={busy} onClick={() => { setB(studio.branding); setDirty(false); }}>Undo</button>
            <button className="btn sm white" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        )}
      </div>
      <aside className="brand-preview"><BrandPreview branding={b} name={studio.name} /></aside>
    </div>
  );
}
