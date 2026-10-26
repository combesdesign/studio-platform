/** Settings › Kiosk: the 4-digit PIN staff use to leave kiosk mode. */
import React, { useState } from 'react';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { isPin } from '../logic';

export function KioskSettingsTab() {
  const toast = useToast();
  const kiosk = store.features.kiosk;
  const has = useData(async () => (kiosk ? kiosk.hasPin() : false), []);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  if (!kiosk) return null;
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await kiosk.setPin(value);
      setPin('');
      toast(value ? 'Kiosk PIN saved' : 'Kiosk PIN removed');
    } catch (e) { toast(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card pad kiosk-settings">
      <h3>Kiosk <em>PIN</em></h3>
      <p className="muted">
        Kiosk mode is the full-screen check-in for the front-desk iPad. Staff leave it with this PIN.
        {has.data ? ' A PIN is set.' : ' No PIN is set yet, so staff leave with their own password.'}
      </p>
      <form onSubmit={(e) => { e.preventDefault(); if (isPin(pin)) void save(pin); }} className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field">
          <span>{has.data ? 'New PIN' : 'PIN'} (4 numbers)</span>
          <input className="input" inputMode="numeric" pattern="[0-9]*" maxLength={4} autoComplete="off" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" style={{ width: 140, letterSpacing: '.3em' }} />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !isPin(pin)}>{has.data ? 'Change PIN' : 'Set PIN'}</button>
        {has.data && <button className="btn" type="button" disabled={busy} onClick={() => save(null)}>Remove PIN</button>}
      </form>
    </section>
  );
}
