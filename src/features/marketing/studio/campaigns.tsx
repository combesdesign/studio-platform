/** Studio › Marketing › Campaigns: list, editor (email blocks or a text), schedule / send, results. */
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { Confirm, Empty, Icon, Loading, Seg, SheetHead, cx, useStudio } from '../../../studio/ui';
import { appUrl, brandOf, dayTime, defaultSchedule, dmTime, needMarketing, pct, plural, STATUS_LABEL, STATUS_TONE } from '../api';
import { describeFilter } from '../catalog';
import { MERGE_TAGS, renderEmail, smsInfo, SMS_OPT_OUT } from '../render';
import type { Campaign, CampaignInput, Channel, EmailBlock, EmailBlockType, SegmentWithCount } from '../types';
import { Kpi, Tone } from './bits';

const newBlock = (type: EmailBlockType): EmailBlock => ({
  id: Math.random().toString(36).slice(2, 9), type,
  ...(type === 'heading' ? { text: '' } : type === 'text' ? { text: '' } : type === 'button' ? { label: 'Book a class', url: '{{app_url}}' } : type === 'image' ? { src: '', alt: '' } : {}),
});

export function CampaignsTab() {
  const { can } = useStudio();
  const list = useData(() => needMarketing().listCampaigns(), []);
  const [edit, setEdit] = useState<Campaign | 'new' | null>(null);
  const [view, setView] = useState<string | null>(null);
  if (list.error && !list.data) return <Empty title="That didn’t load">{list.error.message}</Empty>;
  if (!list.data) return <Loading />;
  const sent = list.data.filter((c) => c.status === 'sent' || c.status === 'sending');
  const totalSent = sent.reduce((n, c) => n + c.stats.sent, 0);
  const emails = sent.filter((c) => c.channel === 'email');
  const opened = emails.reduce((n, c) => n + c.stats.opened, 0), emailSent = emails.reduce((n, c) => n + c.stats.sent, 0);
  return (
    <>
      <div className="mk-kpis">
        <Kpi tone="hero" label="Campaigns sent" value={sent.length} sub={`${totalSent} messages out`} />
        <Kpi label="Open rate" value={pct(opened, emailSent)} sub="Emails, all time" />
        <Kpi label="Scheduled" value={list.data.filter((c) => c.status === 'scheduled').length} sub="Waiting to go" />
        <Kpi tone="mist" label="Drafts" value={list.data.filter((c) => c.status === 'draft').length} sub="Not sent yet" />
      </div>
      <div className="sec-head">
        <h2>Your <em>campaigns</em></h2>
        {can('marketing.manage') && <button className="btn" onClick={() => setEdit('new')}><Icon name="plus" size={18} />New campaign</button>}
      </div>
      {list.data.length === 0 ? <Empty title="No campaigns yet">Send news, an offer or a reminder to everyone, or to a group you choose.</Empty> : (
        <div className="card mk-list">
          {list.data.map((c) => (
            <button key={c.id} className="mk-row" onClick={() => (c.status === 'draft' || c.status === 'scheduled') && can('marketing.manage') ? setEdit(c) : setView(c.id)}>
              <span className="mk-row-ic"><Icon name={c.channel === 'sms' ? 'phone' : 'mail'} size={20} /></span>
              <span className="mk-row-main">
                <strong>{c.name}</strong>
                <span>{c.channel === 'sms' ? 'Text' : 'Email'} to {c.segmentName ?? 'All clients'}{c.scheduledFor && c.status === 'scheduled' ? ` · ${dayTime(c.scheduledFor)}` : c.sentAt ? ` · ${dmTime(c.sentAt)}` : ''}</span>
              </span>
              <span className="mk-row-stats">
                {(c.status === 'sent' || c.status === 'sending') ? (
                  <><strong>{c.stats.sent}</strong><span>{c.channel === 'email' ? `${pct(c.stats.opened, c.stats.sent)} opened` : 'texts sent'}</span></>
                ) : <span className="faint">{plural(c.stats.audience, 'person', 'people')}</span>}
              </span>
              <Tone tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Tone>
            </button>
          ))}
        </div>
      )}
      <Sheet open={!!edit} onClose={() => setEdit(null)} label="Campaign">
        {edit && <CampaignEditor campaign={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSent={(id) => { setEdit(null); setView(id); }} />}
      </Sheet>
      <Sheet open={!!view} onClose={() => setView(null)} label="Campaign results">
        {view && <CampaignResults id={view} onClose={() => setView(null)} />}
      </Sheet>
    </>
  );
}

// ------------------------------------------------------------------ editor
function CampaignEditor({ campaign, onClose, onSent }: { campaign: Campaign | null; onClose: () => void; onSent: (id: string) => void }) {
  const { studio, can } = useStudio();
  const m = needMarketing;
  const { busy, run } = useAction();
  const segs = useData(() => m().listSegments(), []);
  const [id, setId] = useState(campaign?.id);
  const [name, setName] = useState(campaign?.name ?? '');
  const [channel, setChannel] = useState<Channel>(campaign?.channel ?? 'email');
  const [segmentId, setSegmentId] = useState(campaign?.segmentId ?? '');
  const [subject, setSubject] = useState(campaign?.subject ?? '');
  const [preheader, setPreheader] = useState(campaign?.preheader ?? '');
  const [blocks, setBlocks] = useState<EmailBlock[]>(campaign?.blocks?.length ? campaign.blocks : [{ ...newBlock('heading'), text: 'Hi {{first_name}}' }, newBlock('text'), newBlock('button')]);
  const [body, setBody] = useState(campaign?.body ?? '');
  const [when, setWhen] = useState(campaign?.scheduledFor ? toLocal(campaign.scheduledFor) : defaultSchedule());
  const [step, setStep] = useState<'write' | 'preview'>('write');
  const [confirm, setConfirm] = useState<'send' | null>(null);
  const [testTo, setTestTo] = useState('');
  const scheduled = campaign?.status === 'scheduled';
  const seg: SegmentWithCount | undefined = segs.data?.find((s) => s.id === segmentId);
  const input = (): CampaignInput => ({
    ...(id ? { id } : {}), name, channel, segmentId: segmentId || null,
    ...(channel === 'email' ? { subject, preheader, blocks } : { body }),
  });
  const save = async (): Promise<Campaign | undefined> => {
    if (scheduled && campaign) await m().unscheduleCampaign(campaign.id);
    const c = await m().saveCampaign(input());
    setId(c.id);
    return c;
  };
  const everyone = useData(() => m().previewAudience({ match: 'all', rules: [] }), []);
  const audience = seg ? seg.optedIn : everyone.data?.optedIn;

  const html = useMemo(() => {
    if (channel !== 'email') return '';
    return renderEmail({
      subject, preheader, blocks, brand: brandOf(studio), vars: { first_name: 'Hannah', last_name: 'Smith', studio_name: studio.name, app_url: appUrl() },
      address: studio.address ?? '', unsubscribeUrl: '#', reason: `You’re getting this because you said yes to news and offers from ${studio.name}.`, baseUrl: appUrl(), previewFonts: true,
    }).html;
  }, [channel, subject, preheader, blocks, studio]);
  const smsText = channel === 'sms' ? `${body.trim()}\n${SMS_OPT_OUT}` : '';
  const info = smsInfo(smsText);

  const patch = (bid: string, p: Partial<EmailBlock>) => setBlocks(blocks.map((b) => (b.id === bid ? { ...b, ...p } : b)));
  const move = (i: number, d: number) => { const n = [...blocks]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setBlocks(n); };
  const readOnly = !can('marketing.manage');

  return (
    <>
      <SheetHead title={campaign ? 'Edit campaign' : 'New campaign'} sub="Only people who said yes to news and offers will get it." onClose={onClose} />
      <div className="mk-form">
        <div className="form-grid">
          <label className="field span2"><span>Campaign name (only you see this)</span><input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Spring term launch" /></label>
          <div className="field"><span>Send as</span><Seg value={channel} options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'Text' }]} onChange={setChannel} /></div>
          <label className="field"><span>Who gets it</span>
            <select className="select" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
              <option value="">All clients</option>
              {segs.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.optedIn})</option>)}
            </select>
          </label>
        </div>
        <p className="mk-aud small">{seg ? <>{describeFilter(seg.filter)}. </> : null}<strong>{audience ?? '…'}</strong> {audience === 1 ? 'person' : 'people'} can get {channel === 'sms' ? 'a text' : 'an email'} (opted in{channel === 'sms' ? ', with a mobile number' : ''}).</p>

        {channel === 'email' ? (
          <>
            <div className="form-grid">
              <label className="field span2"><span>Subject</span><input className="input" value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} placeholder="New classes are up, {{first_name}}" /></label>
              <label className="field span2"><span>Preview line (shown next to the subject)</span><input className="input" value={preheader} maxLength={200} onChange={(e) => setPreheader(e.target.value)} /></label>
            </div>
            <Seg value={step} options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} onChange={setStep} />
            {step === 'write' ? (
              <div className="mk-blocks">
                {blocks.map((b, i) => (
                  <div key={b.id} className="mk-block">
                    <div className="mk-block-top">
                      <span className="mk-block-type">{({ heading: 'Heading', text: 'Text', image: 'Image', button: 'Button', divider: 'Divider' } as const)[b.type]}</span>
                      <span className="mk-block-tools">
                        <button className="btn sm ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="down" size={16} className="mk-flip" /></button>
                        <button className="btn sm ghost" aria-label="Move down" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}><Icon name="down" size={16} /></button>
                        <button className="btn sm ghost" aria-label="Remove block" onClick={() => setBlocks(blocks.filter((x) => x.id !== b.id))}><Icon name="trash" size={16} /></button>
                      </span>
                    </div>
                    {b.type === 'heading' && <input className="input" value={b.text ?? ''} onChange={(e) => patch(b.id, { text: e.target.value })} placeholder="A short headline. *Stars* make a word italic." aria-label="Heading" />}
                    {b.type === 'text' && <textarea className="textarea" rows={5} value={b.text ?? ''} onChange={(e) => patch(b.id, { text: e.target.value })} placeholder="Write your message. A blank line starts a new paragraph." aria-label="Text" />}
                    {b.type === 'image' && (
                      <div className="form-grid">
                        <label className="field span2"><span>Image address (https://…)</span><input className="input" value={b.src ?? ''} onChange={(e) => patch(b.id, { src: e.target.value })} /></label>
                        <label className="field"><span>Description</span><input className="input" value={b.alt ?? ''} onChange={(e) => patch(b.id, { alt: e.target.value })} /></label>
                        <label className="field"><span>Link (optional)</span><input className="input" value={b.url ?? ''} onChange={(e) => patch(b.id, { url: e.target.value })} /></label>
                      </div>
                    )}
                    {b.type === 'button' && (
                      <div className="form-grid">
                        <label className="field"><span>Button label</span><input className="input" value={b.label ?? ''} onChange={(e) => patch(b.id, { label: e.target.value })} /></label>
                        <label className="field"><span>Goes to</span><input className="input" value={b.url ?? ''} onChange={(e) => patch(b.id, { url: e.target.value })} placeholder="{{app_url}}" /></label>
                      </div>
                    )}
                    {b.type === 'divider' && <hr className="mk-hr" />}
                  </div>
                ))}
                <div className="mk-add">
                  {(['heading', 'text', 'image', 'button', 'divider'] as EmailBlockType[]).map((t) => (
                    <button key={t} className="chip-btn" onClick={() => setBlocks([...blocks, newBlock(t)])}><Icon name="plus" size={16} />{t[0]!.toUpperCase() + t.slice(1)}</button>
                  ))}
                </div>
                <p className="faint small">Merge tags: {MERGE_TAGS.map((t) => `{{${t.tag}}}`).join('  ')}. Every email gets your studio’s look and an unsubscribe link.</p>
              </div>
            ) : (
              <iframe className="mk-frame" title="Email preview" sandbox="" srcDoc={html} />
            )}
          </>
        ) : (
          <>
            <label className="field"><span>Message</span>
              <textarea className="textarea" rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hi {{first_name}}, new classes are up. Book at {{app_url}}" aria-label="Text message" />
            </label>
            <p className={cx('small', info.segments > 1 ? 'mk-warn' : 'faint')}>{info.length} characters with “{SMS_OPT_OUT}” added · {plural(info.segments, 'text')} per person ({info.encoding}).</p>
          </>
        )}

        {!readOnly && (
          <div className="mk-test">
            <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={channel === 'sms' ? 'Your mobile number' : 'Your email address'} aria-label="Send a test to" />
            <button className="btn soft" disabled={busy || !testTo.trim()} onClick={() => run(async () => { await m().sendTest(input(), testTo); }, 'Test sent')}>Send a test</button>
          </div>
        )}
      </div>
      {scheduled && campaign?.scheduledFor && <p className="panel small">Scheduled for {dayTime(campaign.scheduledFor)}. Saving takes it off the schedule so you can change it.</p>}
      <div className="sh-foot mk-foot">
        {!readOnly && (
          <>
            {campaign && <button className="btn ghost danger" disabled={busy} onClick={() => run(async () => { await m().deleteCampaign(campaign.id); onClose(); }, 'Campaign deleted')}>Delete</button>}
            <span className="mk-grow" />
            <button className="btn soft" disabled={busy} onClick={() => run(async () => { await save(); onClose(); }, 'Draft saved')}>Save draft</button>
            <label className="mk-when"><span className="mk-sr">Send at</span><input className="input sm" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
            <button className="btn soft" disabled={busy} onClick={() => run(async () => {
              const c = await save(); if (!c) return;
              await m().scheduleCampaign(c.id, new Date(when).toISOString()); onClose();
            }, 'Scheduled')}>Schedule</button>
            <button className="btn" disabled={busy} onClick={() => run(async () => { await save(); setConfirm('send'); })}>Send now</button>
          </>
        )}
      </div>
      <Confirm open={confirm === 'send'} title="Send this now?" confirmLabel="Send" busy={busy} onClose={() => setConfirm(null)}
        body={`${name || 'This campaign'} goes to ${audience ?? 'everyone in the audience'} ${audience === 1 ? 'person' : 'people'} straight away. You can’t undo a send.`}
        onConfirm={() => run(async () => { const c = await m().sendCampaign(id!); setConfirm(null); onSent(c.id); }, 'On its way')} />
    </>
  );
}

/** ISO instant -> value for <input type="datetime-local"> in the browser's own time. */
function toLocal(iso: string): string {
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ results
function CampaignResults({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useData(() => needMarketing().getCampaign(id), [id]);
  useEffect(() => { const t = window.setInterval(() => d.reload(), 15_000); return () => window.clearInterval(t); }, [d.reload]);
  if (!d.data) return <><SheetHead title="Campaign" onClose={onClose} />{d.error ? <p className="form-err">{d.error.message}</p> : <Loading />}</>;
  const { campaign: c, recipients } = d.data;
  const s = c.stats;
  return (
    <>
      <SheetHead title={c.name} sub={`${c.channel === 'sms' ? 'Text' : 'Email'} to ${c.segmentName ?? 'All clients'}${c.sentAt ? ` · ${dmTime(c.sentAt)}` : ''}`} onClose={onClose} />
      {c.simulated && <p className="panel small">Demo numbers: nothing was really sent, and opens and clicks arrive on a timer.</p>}
      <div className="mk-kpis tight">
        <Kpi label="Sent" value={s.sent} sub={s.skipped ? `${s.skipped} left out (not opted in or no address)` : `of ${s.audience}`} />
        {c.channel === 'email' && <><Kpi label="Opened" value={pct(s.opened, s.sent)} sub={`${s.opened} people`} /><Kpi label="Clicked" value={pct(s.clicked, s.sent)} sub={`${s.clicked} people`} /></>}
        <Kpi label="Unsubscribed" value={s.unsubscribed} sub={s.failed ? `${s.failed} failed` : 'Stopped news and offers'} />
      </div>
      <div className="table-wrap mk-recips">
        <table className="tbl">
          <thead><tr><th>Client</th><th>Sent to</th><th>Status</th>{c.channel === 'email' && <th>Opened</th>}</tr></thead>
          <tbody>
            {recipients.map((r) => (
              <tr key={r.id}>
                <td><a className="linkish" href={`#/clients/${r.clientId}`}>{r.clientName}</a></td><td>{r.to}</td>
                <td><Tone tone={r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'danger' : r.status === 'skipped' ? '' : 'warn'}>{r.status === 'skipped' ? 'Left out' : r.status[0]!.toUpperCase() + r.status.slice(1)}</Tone>{r.error && <span className="faint small"> {r.error}</span>}</td>
                {c.channel === 'email' && <td>{r.openedAt ? dmTime(r.openedAt) : <span className="faint">–</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {recipients.length === 0 && <p className="muted pad">Nothing has gone out yet.</p>}
      </div>
    </>
  );
}
