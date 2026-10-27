/** Settings › Reviews: the optional "Ask happy clients (9 to 10) to leave a Google review" link. */
import React, { useEffect, useState } from 'react';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { Switch } from '../../marketing/studio/bits';

export function ReviewsSettingsTab() {
  const toast = useToast();
  const reviews = store.features.reviews;
  const cur = useData(async () => (reviews ? reviews.getSettings() : { googleReviewUrl: '', googleAskEnabled: false, googleAskEvery: 5 }), []);
  const [url, setUrl] = useState('');
  const [every, setEvery] = useState('5');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data) { setUrl(cur.data.googleReviewUrl); setEvery(String(cur.data.googleAskEvery)); } }, [cur.data]);
  if (!reviews) return null;
  const save = async (value: string) => {
    setBusy(true);
    try { await reviews.saveSettings({ googleReviewUrl: value }); toast(value.trim() ? 'Google review link saved' : 'Google review ask turned off'); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  const on = !!cur.data?.googleReviewUrl;
  const ask = cur.data?.googleAskEnabled === true;
  const saveAsk = async (patch: { googleAskEnabled?: boolean; googleAskEvery?: number }, done: string) => {
    setBusy(true);
    try { await reviews.saveSettings(patch); cur.reload(); toast(done); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  const everyN = Math.floor(Number(every));
  return (
    <section className="card pad">
      <h3>Reviews <em>after class</em></h3>
      <p className="muted">
        After a class, clients rate it with flowers and say how likely they are to recommend you (0 to 10).
        {' '}Paste your Google review link and anyone who scores 9 or 10 gets a button to share it on Google too.
        {on ? ' The Google ask is on.' : ' The Google ask is off.'}
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void save(url); }} className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 320px' }}>
          <span>Ask happy clients (9 to 10) to leave a Google review</span>
          <input className="input" type="url" inputMode="url" autoComplete="off" placeholder="https://g.page/r/…/review" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <button className="btn primary" type="submit" disabled={busy || url.trim() === (cur.data?.googleReviewUrl ?? '')}>Save</button>
        {on && <button className="btn" type="button" disabled={busy} onClick={() => { setUrl(''); void save(''); }}>Turn off</button>}
      </form>
      <div className="rv-ask">
        <div className="rv-ask-row">
          <div>
            <strong>Ask for a Google review every <input className="input sm rv-every" type="number" min={1} max={100} inputMode="numeric" aria-label="Classes between asks" value={every}
              onChange={(e) => setEvery(e.target.value)} onBlur={() => { if (cur.data && everyN >= 1 && everyN <= 100 && everyN !== cur.data.googleAskEvery) void saveAsk({ googleAskEvery: everyN }, 'Saved'); else setEvery(String(cur.data?.googleAskEvery ?? 5)); }} /> classes</strong>
            <p className="muted small">
              After a client&rsquo;s {everyN > 0 ? everyN : 'Nth'}th class, then every {everyN > 0 ? everyN : 'N'} after that, they get a friendly email with your Google link.
              {' '}Never more than once every 60 days, and it stops for anyone who has clicked. You can change the wording under Marketing &rsaquo; Automations. {ask ? 'Only clients who said yes to news and offers get it.' : ''}
            </p>
            {!on && <p className="faint small">Save your Google review link above to turn this on.</p>}
          </div>
          <Switch checked={ask} label="Ask for a Google review every few classes" disabled={busy || !on} onChange={(v) => void saveAsk({ googleAskEnabled: v }, v ? 'Google review ask is on' : 'Google review ask is off')} />
        </div>
      </div>
    </section>
  );
}
