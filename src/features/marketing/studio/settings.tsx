/** Settings › Marketing: sender details, how texts and push are set up, and this device's notifications. */
import React, { useEffect, useState } from 'react';
import { useAction, useData, useToast } from '../../../shared/react';
import { Loading, useStudio } from '../../../studio/ui';
import { needMarketing } from '../api';
import { pushProvider, saveToken, savedToken } from '../push';
import type { InboxAccess, MarketingSettings } from '../types';
import { Switch, Tone } from './bits';

const INBOX_OPTIONS: [InboxAccess, string][] = [
  ['owner', 'Owner only'], ['owner_manager', 'Owner and managers'], ['no_instructors', 'All staff except instructors (default)'], ['all_staff', 'All staff'],
];

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
  const set = <K extends keyof MarketingSettings>(k: K, v: MarketingSettings[K]) => setD({ ...d, [k]: v });
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
        <h3>Client <em>messages</em></h3>
        <p className="muted small mk-set-sub">Clients write to you from Profile › Messages in their app. Choose who reads the inbox and how you and your clients hear about new messages.</p>
        <div className="form-grid">
          <label className="field span2"><span>Who can use the inbox</span>
            <select className="input" value={d.inboxAccess} disabled={disabled} onChange={(e) => set('inboxAccess', e.target.value as InboxAccess)}>
              {INBOX_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
        </div>
        <ul className="mk-prov">
          <li><span><strong>Email me when a client messages</strong>Goes to {studio.email || 'the owner’s email'}, with a snippet and a link to the inbox. At most one every 15 minutes per conversation.</span><Switch checked={d.emailStudio} disabled={disabled} label="Email me when a client messages" onChange={(v) => set('emailStudio', v)} /></li>
          <li><span><strong>Email clients when we reply (if they don’t have notifications on)</strong>So they don’t miss it. Same 15 minute limit. You can reword it in Settings › Emails.</span><Switch checked={d.emailClient} disabled={disabled} label="Email clients when we reply" onChange={(v) => set('emailClient', v)} /></li>
        </ul>
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
