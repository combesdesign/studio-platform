/** Studio › Marketing › Automations: eight messages that send themselves, each switched on or off and editable. */
import React, { useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { Empty, Icon, Loading, Seg, SheetHead, useStudio } from '../../../studio/ui';
import { appUrl, brandOf, needMarketing, plural } from '../api';
import { automationDef } from '../catalog';
import { MERGE_TAGS, renderEmail, automationBlocks, smsInfo } from '../render';
import type { Automation, AutomationKey, AutomationRun, Channel } from '../types';
import { Switch, Tone } from './bits';

type Row = Automation & { sentLast30Days: number };

const ZERO: Partial<Record<AutomationKey, string>> = { welcome: 'Sends straight after they join', birthday: 'Sends on their birthday', after_first_class: 'Sends the same day as their first class' };
/** 'Sends 3 days after they join', 'Sends on their birthday'. */
function whenText(key: AutomationKey, n: number): string {
  const d = automationDef(key);
  if (n === 0 && ZERO[key]) return ZERO[key]!;
  return `${d.delay.before} ${n} ${d.delay.after.replace(/^days/, n === 1 ? 'day' : 'days').replace(/ \(0 = on the day\)$/, '')}`;
}

export function AutomationsTab() {
  const { can } = useStudio();
  const list = useData(() => needMarketing().listAutomations(), []);
  const [edit, setEdit] = useState<AutomationKey | null>(null);
  const [plan, setPlan] = useState<AutomationRun | null>(null);
  const { busy, run } = useAction();
  const toggle = (a: Row, v: boolean) => run(async () => { await needMarketing().saveAutomation({ key: a.key, enabled: v }); list.reload(); });
  if (list.error && !list.data) return <Empty title="That didn’t load">{list.error.message}</Empty>;
  if (!list.data) return <Loading />;
  const cur = list.data.find((a) => a.key === edit);
  return (
    <>
      <div className="sec-head">
        <h2>Messages that <em>send themselves</em></h2>
        <button className="btn soft" disabled={busy} onClick={() => run(async () => setPlan(await needMarketing().runAutomations({ dryRun: true })))}><Icon name="eye" size={18} />Who’s next?</button>
      </div>
      <p className="muted mk-sub">They run in the background every few minutes. Each person gets each message once. Welcome, offers and win-back only go to clients who said yes to news and offers; messages about someone’s own pass or membership go to everyone.</p>
      <div className="mk-autos">
        {list.data.map((a) => {
          const d = automationDef(a.key);
          return (
            <article key={a.key} className="card mk-auto">
              <div className="mk-auto-top">
                <span className="mk-row-ic"><Icon name={a.channel === 'sms' ? 'phone' : 'mail'} size={20} /></span>
                <h3 className="serif">{d.name}</h3>
                <Switch checked={a.enabled} label={`${d.name} on`} disabled={!can('marketing.manage') || busy} onChange={(v) => toggle(a, v)} />
              </div>
              <p className="muted">{d.description}</p>
              <p className="mk-auto-when small">{whenText(a.key, a.delay)}</p>
              <div className="mk-auto-foot">
                <Tone tone={d.kind === 'marketing' ? '' : 'ok'}>{d.kind === 'marketing' ? 'Opted-in clients' : 'Everyone it applies to'}</Tone>
                <span className="faint small">{plural(a.sentLast30Days, 'send')} in 30 days</span>
                {can('marketing.manage') && <button className="btn sm soft mk-push" onClick={() => setEdit(a.key)}>Edit</button>}
              </div>
            </article>
          );
        })}
      </div>
      <Sheet open={!!cur} onClose={() => setEdit(null)} label="Automation">
        {cur && <AutomationEditor a={cur} onClose={() => { setEdit(null); list.reload(); }} />}
      </Sheet>
      <Sheet open={!!plan} onClose={() => setPlan(null)} label="Who’s next">
        {plan && <PlanSheet plan={plan} onClose={() => { setPlan(null); list.reload(); }} />}
      </Sheet>
    </>
  );
}

function AutomationEditor({ a, onClose }: { a: Row; onClose: () => void }) {
  const { studio } = useStudio();
  const d = automationDef(a.key);
  const { busy, run } = useAction();
  const [channel, setChannel] = useState<Channel>(a.channel);
  const [delay, setDelay] = useState(a.delay);
  const [subject, setSubject] = useState(a.subject);
  const [heading, setHeading] = useState(a.heading);
  const [body, setBody] = useState(a.body);
  const [button, setButton] = useState(a.buttonLabel);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const vars = { first_name: 'Hannah', last_name: 'Smith', studio_name: studio.name, app_url: appUrl(), ...Object.fromEntries(d.tags.map((t) => [t.tag, t.example])) };
  const html = tab === 'preview' && channel === 'email' ? renderEmail({
    subject, blocks: automationBlocks({ heading, body, buttonLabel: button }), brand: brandOf(studio), vars, address: studio.address ?? '', baseUrl: appUrl(), previewFonts: true,
    ...(d.kind === 'marketing' ? { unsubscribeUrl: '#', reason: `You’re getting this because you said yes to news and offers from ${studio.name}.` } : {}),
  }).html : '';
  const info = smsInfo(body);
  return (
    <>
      <SheetHead title={d.name} sub={d.description} onClose={onClose} />
      <div className="mk-form">
        <div className="form-grid">
          <div className="field"><span>Send as</span><Seg value={channel} options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'Text' }]} onChange={setChannel} /></div>
          <label className="field"><span>{d.delay.before} … {d.delay.after}</span>
            <input className="input" type="number" min={d.delay.min} max={d.delay.max} value={delay} onChange={(e) => setDelay(Math.max(d.delay.min, Math.min(d.delay.max, Math.floor(Number(e.target.value) || 0))))} />
          </label>
        </div>
        {channel === 'email' && <Seg value={tab} options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} onChange={setTab} />}
        {tab === 'preview' && channel === 'email' ? <iframe className="mk-frame" title="Email preview" sandbox="" srcDoc={html} /> : (
          <div className="form-grid">
            {channel === 'email' && <>
              <label className="field span2"><span>Subject</span><input className="input" value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} /></label>
              <label className="field span2"><span>Heading (*stars* make a word italic)</span><input className="input" value={heading} maxLength={150} onChange={(e) => setHeading(e.target.value)} /></label>
            </>}
            <label className="field span2"><span>Message</span><textarea className="textarea" rows={7} value={body} onChange={(e) => setBody(e.target.value)} /></label>
            {channel === 'email' && <label className="field span2"><span>Button label (leave empty for no button)</span><input className="input" value={button} maxLength={60} onChange={(e) => setButton(e.target.value)} /></label>}
          </div>
        )}
        {channel === 'sms' && <p className="faint small">{info.length} characters · {plural(info.segments, 'text')} ({info.encoding}).</p>}
        <p className="faint small">Merge tags: {[...MERGE_TAGS.map((t) => t.tag), ...d.tags.map((t) => t.tag)].map((t) => `{{${t}}}`).join('  ')}</p>
      </div>
      <div className="sh-foot">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy} onClick={() => run(async () => { await needMarketing().saveAutomation({ key: a.key, channel, delay, subject, heading, body, buttonLabel: button }); onClose(); }, 'Saved')}>Save</button>
      </div>
    </>
  );
}

function PlanSheet({ plan, onClose }: { plan: AutomationRun; onClose: () => void }) {
  const { can } = useStudio();
  const { busy, run } = useAction();
  const [done, setDone] = useState<AutomationRun | null>(null);
  const shown = done ?? plan;
  return (
    <>
      <SheetHead title={done ? 'Sent' : 'Who’s next'} sub={done ? `${plural(done.items.length, 'message')} went out.` : 'What would go out if the automations ran right now. Nothing has been sent.'} onClose={onClose} />
      {shown.items.length === 0 ? <Empty title="No one right now">Everyone who qualifies has already had their message.</Empty> : (
        <div className="card mk-list">
          {shown.items.map((it) => (
            <div key={it.dedupeKey} className="mk-row static">
              <span className="mk-row-ic"><Icon name={it.channel === 'sms' ? 'phone' : 'mail'} size={20} /></span>
              <span className="mk-row-main"><strong>{it.clientName} · {it.automationName}</strong><span>{it.reason}</span><span className="faint">{it.preview}</span></span>
            </div>
          ))}
        </div>
      )}
      {shown.skipped.length > 0 && <p className="faint small mk-skip">Left out: {shown.skipped.slice(0, 6).map((s) => `${s.clientName} (${s.why})`).join(', ')}{shown.skipped.length > 6 ? ` and ${shown.skipped.length - 6} more` : ''}.</p>}
      <div className="sh-foot">
        <button className="btn ghost" onClick={onClose}>{done ? 'Done' : 'Close'}</button>
        {!done && can('marketing.manage') && plan.items.length > 0 && <button className="btn" disabled={busy} onClick={() => run(async () => setDone(await needMarketing().runAutomations({ dryRun: false })))}>Send these now</button>}
      </div>
    </>
  );
}
