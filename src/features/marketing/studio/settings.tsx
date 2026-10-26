/** Settings › Marketing: sender details, how texts and push are set up, and this device's notifications. */
import React, { useEffect, useState } from 'react';
import { useAction, useData, useToast } from '../../../shared/react';
import { Loading, useStudio } from '../../../studio/ui';
import { needMarketing } from '../api';
import { pushProvider, saveToken, savedToken } from '../push';
import type { MarketingSettings } from '../types';
import { Tone } from './bits';

export function MarketingSettingsTab() {
  const { can, studio } = useStudio();
  const s = useData(() => needMarketing().getSettings(), []);
  const prov = useData(() => needMarketing().getProviders(), []);
  const push = useData(() => needMarketing().getPushStatus(), []);
  const [d, setD] = useState<MarketingSettings | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => { if (s.data) setD(s.data); }, [s.data]);
  if (!d || !s.data) return s.error ? <p className="form-err">{s.error.message}</p> : <Loading />;
  const disabled = !can('marketing.manage');
  const dirty = JSON.stringify(d) !== JSON.stringify(s.data);
  const set = (k: keyof MarketingSettings, v: string) => setD({ ...d, [k]: v });
  const p = pushProvider();
  const mine = push.data?.registered;
  const turnOn = () => run(async () => {
    const reg = await p.subscribe(push.data?.vapidPublicKey ? { vapidPublicKey: push.data.vapidPublicKey } : {});
    await needMarketing().registerPush(reg); saveToken(reg.token); push.reload();
  }, 'Notifications are on for this device');
  const turnOff = () => run(async () => {
    const t = (await p.unsubscribe()) ?? savedToken();
    if (t) await needMarketing().unregisterPush(t);
    saveToken(null); push.reload();
  }, 'Notifications are off for this device');
  return (
    <div className="set-grid">
      <section className="card pad">
        <h3>Sender <em>details</em></h3>
        <p className="muted small mk-set-sub">How your emails and texts look to the people who get them. Colours, fonts and logo come from your branding.</p>
        <div className="form-grid">
          <label className="field"><span>“From” name on emails</span><input className="input" value={d.fromName} disabled={disabled} placeholder={studio.name} onChange={(e) => set('fromName', e.target.value)} /></label>
          <label className="field"><span>Replies go to</span><input className="input" type="email" value={d.replyTo} disabled={disabled} placeholder={studio.email || 'hello@yourstudio.com'} onChange={(e) => set('replyTo', e.target.value)} /></label>
          <label className="field"><span>Text sender name or number</span><input className="input" value={d.smsSender} disabled={disabled} placeholder="Provider default" onChange={(e) => set('smsSender', e.target.value)} /></label>
          <label className="field span2"><span>Extra line in the email footer</span><input className="input" value={d.footerNote} disabled={disabled} onChange={(e) => set('footerNote', e.target.value)} placeholder="You’re getting this because you joined our newsletter." /></label>
        </div>
      </section>
      <section className="card pad">
        <h3>How things <em>send</em></h3>
        {prov.data ? (
          <ul className="mk-prov">
            <li><span><strong>Email</strong>{prov.data.email.note}</span><Tone tone={prov.data.email.ready ? 'ok' : 'warn'}>{prov.data.email.ready ? 'Ready' : 'Demo'}</Tone></li>
            <li><span><strong>Texts</strong>{prov.data.sms.note}</span><Tone tone={prov.data.sms.ready ? 'ok' : 'warn'}>{prov.data.sms.ready ? 'Ready' : 'Stub'}</Tone></li>
            <li><span><strong>Push</strong>{prov.data.push.note}</span><Tone tone={prov.data.push.ready ? 'ok' : 'warn'}>{prov.data.push.ready ? 'Ready' : 'Needs keys'}</Tone></li>
          </ul>
        ) : <Loading />}
      </section>
      <section className="card pad">
        <h3>Notifications on <em>this device</em></h3>
        <p className="muted small mk-set-sub">Get a nudge when a client messages you. {push.data ? `Devices signed up: ${push.data.devices.web} web, ${push.data.devices.ios} iPhone, ${push.data.devices.android} Android.` : ''}</p>
        {!p.supported() ? <p className="faint small">This browser can’t receive notifications.</p> : (
          <div className="mk-inline">
            {mine ? <button className="btn soft" disabled={busy} onClick={turnOff}>Turn off</button> : <button className="btn" disabled={busy} onClick={turnOn}>Turn on</button>}
            {mine && <button className="btn ghost" disabled={busy} onClick={() => run(async () => { toast((await needMarketing().sendTestPush()).note); })}>Send a test</button>}
          </div>
        )}
      </section>
      {dirty && !disabled && (
        <div className="savebar"><span>Unsaved changes</span><button className="btn sm ghost light" onClick={() => setD(s.data!)}>Discard</button><button className="btn sm cream" disabled={busy} onClick={() => run(async () => { await needMarketing().updateSettings(d); s.reload(); }, 'Marketing settings saved')}>Save changes</button></div>
      )}
    </div>
  );
}
