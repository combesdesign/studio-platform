/** Settings › Reviews: the optional "Ask happy clients (9 to 10) to leave a Google review" link. */
import React, { useEffect, useState } from 'react';
import { errorMessage, store, useData, useToast } from '../../../shared/react';

export function ReviewsSettingsTab() {
  const toast = useToast();
  const reviews = store.features.reviews;
  const cur = useData(async () => (reviews ? reviews.getSettings() : { googleReviewUrl: '' }), []);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data) setUrl(cur.data.googleReviewUrl); }, [cur.data]);
  if (!reviews) return null;
  const save = async (value: string) => {
    setBusy(true);
    try { await reviews.saveSettings({ googleReviewUrl: value }); toast(value.trim() ? 'Google review link saved' : 'Google review ask turned off'); } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  const on = !!cur.data?.googleReviewUrl;
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
    </section>
  );
}
