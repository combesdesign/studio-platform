/**
 * Settings > Emails (owner and manager): every email clients get (classes, receipts, gift cards, appointments, events), with an on/off switch, an editable subject and
 * intro paragraph (merge tags like {first_name}), a live preview in the studio's own colours and "Send me a test".
 * Defaults are the wording the app has always sent (src/domain/emails.ts); only changes are saved, per studio.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { store, useAction, useData, useToast } from '../shared/react';
import { getBranding } from '../shared/branding';
import { EMAIL_DEFS, EMAIL_TAGS, emailDef, renderEmail, samplePayload, type EmailDef, type EmailKind } from '../domain/emails';
import type { EmailTemplateRow } from '../shared/types';
import { Icon, Loading, cx, useStudio } from './ui';

function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={cx('mk-switch', on && 'on')} onClick={() => onChange(!on)}><span /></button>;
}

const GROUPS: EmailDef['group'][] = ['Classes', 'Appointments', 'Events', 'Payments'];

export function EmailsTab() {
  const rows = useData(() => store.listEmailTemplates(), []);
  const [kind, setKind] = useState<EmailKind>(EMAIL_DEFS[0]!.kind);
  const byKind = useMemo(() => new Map((rows.data ?? []).map((r) => [r.kind, r])), [rows.data]);
  if (rows.error && !rows.data) return <section className="card pad"><p className="muted">That didn’t load. {rows.error.message}</p></section>;
  if (!rows.data) return <Loading />;
  return (
    <div className="eml">
      <section className="card pad eml-list" aria-label="Emails">
        <h3>Client <em>emails</em></h3>
        <p className="muted small">Everything your clients get from you. Pick one to change the wording or turn it off.</p>
        {GROUPS.map((g) => (
          <React.Fragment key={g}>
            <h4 className="eml-group">{g}</h4>
            <ul>
              {EMAIL_DEFS.filter((d: EmailDef) => d.group === g).map((d) => {
                const r = byKind.get(d.kind);
                const off = r?.enabled === false;
                return (
                  <li key={d.kind}>
                    <button type="button" className={cx('eml-item', kind === d.kind && 'on')} aria-current={kind === d.kind ? 'true' : undefined} onClick={() => setKind(d.kind)}>
                      <span className="eml-item-t"><strong>{d.label}</strong><span className="muted small">{off ? 'Off' : r?.subject || r?.intro ? 'Your own wording' : 'Standard wording'}</span></span>
                      <span className={cx('eml-dot', off ? 'off' : 'on')} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </React.Fragment>
        ))}
      </section>
      <EmailEditor key={kind} kind={kind} row={byKind.get(kind)} onSaved={rows.reload} />
    </div>
  );
}

function EmailEditor({ kind, row, onSaved }: { kind: EmailKind; row: EmailTemplateRow | undefined; onSaved: () => void }) {
  const def = emailDef(kind)!;
  const { studio } = useStudio();
  const { busy, run } = useAction();
  const enabled = row?.enabled !== false;
  const [subject, setSubject] = useState(row?.subject ?? def.subject);
  const [intro, setIntro] = useState(row?.intro ?? def.intro);
  useEffect(() => { setSubject(row?.subject ?? def.subject); setIntro(row?.intro ?? def.intro); }, [row?.subject, row?.intro, def]);
  const focus = useRef<'subject' | 'intro'>('intro');
  const subjectRef = useRef<HTMLInputElement>(null);
  const introRef = useRef<HTMLTextAreaElement>(null);
  const dirty = subject !== (row?.subject ?? def.subject) || intro !== (row?.intro ?? def.intro);
  const custom = subject.trim() !== def.subject || intro.trim() !== def.intro;

  /** The studio's look, as the email payload carries it. */
  const payload = useMemo(() => {
    const b = getBranding();
    const c = b.colors;
    return {
      ...samplePayload(studio.name, kind), address: studio.address ?? '', cta_url: '#',
      brand: { primary: c.primary, ink: c.ink, soft: c.soft, bg: c.bg },
    };
  }, [studio.name, studio.address, kind]);
  const preview = useMemo(() => renderEmail(kind, payload, { subject, intro }), [kind, payload, subject, intro]);

  const insert = (tag: string) => {
    const field = focus.current, el = field === 'subject' ? subjectRef.current : introRef.current;
    const text = `{${tag}}`;
    const cur = field === 'subject' ? subject : intro;
    const a = el?.selectionStart ?? cur.length, z = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, a) + text + cur.slice(z);
    (field === 'subject' ? setSubject : setIntro)(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + text.length, a + text.length); });
  };

  /** Only wording that differs from the standard is stored; blank or standard = back to the default. */
  const patch = () => ({ subject: subject.trim() && subject.trim() !== def.subject ? subject.trim() : null, intro: intro.trim() && intro.trim() !== def.intro ? intro.trim() : null });
  const save = () => run(async () => { await store.saveEmailTemplate(kind, patch()); onSaved(); }, 'Saved');
  const toggle = (v: boolean) => run(async () => { await store.saveEmailTemplate(kind, { enabled: v }); onSaved(); }, v ? `${def.label} is on` : `${def.label} is off`);
  const toast = useToast();
  const test = async () => {
    const r = await run(async () => {
      if (dirty) { await store.saveEmailTemplate(kind, patch()); onSaved(); }   // the test uses what's saved, so save first
      return store.sendTestEmail(kind);
    });
    if (r) toast(store.mode === 'demo' ? `Demo: a test would go to ${r.to}` : `Test sent to ${r.to}. It can take a minute or two to arrive.`);
  };
  const tags = EMAIL_TAGS.filter((t) => def.tags.includes(t.tag));

  return (
    <div className="eml-edit">
      <section className="card pad eml-form">
        <div className="eml-head">
          <div><h3>{def.label}</h3><p className="muted small">{def.when}</p></div>
          <label className="eml-on"><span>{enabled ? 'On' : 'Off'}</span><Toggle on={enabled} label={`Send "${def.label}"`} disabled={busy} onChange={toggle} /></label>
        </div>
        {!enabled && <p className="eml-off small">This email is switched off, so clients won’t get it. Your wording below is kept.</p>}
        <div className="stack">
          <label className="field"><span>Subject</span>
            <input ref={subjectRef} className="input" value={subject} maxLength={150} onFocus={() => { focus.current = 'subject'; }} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="field"><span>Intro paragraph</span>
            <textarea ref={introRef} className="textarea" rows={5} value={intro} maxLength={1500} onFocus={() => { focus.current = 'intro'; }} onChange={(e) => setIntro(e.target.value)} />
          </label>
          <div className="field">
            <span>Merge tags (tap one to add it)</span>
            <div className="eml-tags">
              {tags.map((t) => <button key={t.tag} type="button" className="chip" title={`${t.label}, e.g. ${t.example.trim()}`} onClick={() => insert(t.tag)}>{`{${t.tag}}`}</button>)}
            </div>
          </div>
        </div>
        <div className="eml-actions">
          <button className="btn" disabled={busy || !dirty} onClick={save}>Save changes</button>
          <button className="btn soft" disabled={busy} onClick={test}><Icon name="mail" size={18} />Send me a test</button>
          {custom && <button className="btn ghost" disabled={busy} onClick={() => { setSubject(def.subject); setIntro(def.intro); }}>Use standard wording</button>}
        </div>
        <p className="faint small">The heading, class or session details, notes and your cancellation policy are added by the app. Test emails use a made-up booking.</p>
      </section>
      <section className="card pad eml-preview" aria-label="Preview">
        <div className="eml-pv-head"><h3>Preview</h3><span className="faint small">In your studio’s colours</span></div>
        <p className="eml-subject"><span className="faint small">Subject</span><strong>{preview?.subject}</strong></p>
        <iframe className="eml-frame" title="Email preview" sandbox="" srcDoc={preview?.html ?? ''} />
      </section>
    </div>
  );
}
