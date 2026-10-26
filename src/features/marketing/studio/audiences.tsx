/** Studio › Marketing › Audiences: saved segments built from client filters, and the tags you put on clients. */
import React, { useEffect, useState } from 'react';
import { Sheet, useAction, useData } from '../../../shared/react';
import { Empty, Icon, Loading, Seg, SheetHead, useStudio } from '../../../studio/ui';
import { needMarketing, plural } from '../api';
import { RULE_DEFS, describeFilter, ruleDef } from '../catalog';
import type { AudiencePreview, SegmentFilter, SegmentRule, SegmentRuleType, SegmentWithCount } from '../types';

export function AudiencesTab() {
  const { can } = useStudio();
  const segs = useData(() => needMarketing().listSegments(), []);
  const tags = useData(() => needMarketing().listTags(), []);
  const [edit, setEdit] = useState<SegmentWithCount | 'new' | null>(null);
  if (segs.error && !segs.data) return <Empty title="That didn’t load">{segs.error.message}</Empty>;
  if (!segs.data) return <Loading />;
  return (
    <>
      <div className="sec-head">
        <h2>Who you can <em>reach</em></h2>
        {can('marketing.manage') && <button className="btn" onClick={() => setEdit('new')}><Icon name="plus" size={18} />New audience</button>}
      </div>
      <p className="muted mk-sub">An audience is a saved filter of your clients. The number in bold is how many have said yes to news and offers: those are the only people a campaign reaches.</p>
      <div className="mk-segs">
        {segs.data.map((s) => (
          <button key={s.id} className="card mk-seg" onClick={() => setEdit(s)}>
            <strong className="serif mk-seg-n">{s.optedIn}</strong>
            <span className="mk-seg-name">{s.name}</span>
            <span className="muted small">{s.description || describeFilter(s.filter)}</span>
            <span className="faint small">{plural(s.count, 'client')} match{s.count === 1 ? 'es' : ''}, {s.optedIn} opted in</span>
          </button>
        ))}
      </div>
      <section className="card pad mk-tags">
        <h3>Client <em>tags</em></h3>
        <p className="muted small">Add tags to a client from their profile (“VIP”, “Teacher training”) and use them to build an audience.</p>
        <div className="mk-chips">
          {tags.data?.length ? tags.data.map((t) => <span key={t.tag} className="mk-chip">{t.tag}<em>{t.count}</em></span>) : <span className="faint small">No tags yet.</span>}
        </div>
      </section>
      <Sheet open={!!edit} onClose={() => setEdit(null)} label="Audience">
        {edit && <SegmentEditor seg={edit === 'new' ? null : edit} onClose={() => { setEdit(null); segs.reload(); }} />}
      </Sheet>
    </>
  );
}

function SegmentEditor({ seg, onClose }: { seg: SegmentWithCount | null; onClose: () => void }) {
  const { can } = useStudio();
  const { busy, run } = useAction();
  const [name, setName] = useState(seg?.name ?? '');
  const [description, setDescription] = useState(seg?.description ?? '');
  const [filter, setFilter] = useState<SegmentFilter>(seg?.filter ?? { match: 'all', rules: [] });
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const disabled = !can('marketing.manage');
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => { needMarketing().previewAudience(filter).then((p) => alive && setPreview(p), () => {}); }, 150);
    return () => { alive = false; window.clearTimeout(t); };
  }, [filter]);
  const setRule = (i: number, p: Partial<SegmentRule>) => setFilter({ ...filter, rules: filter.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const addRule = (type: SegmentRuleType) => setFilter({ ...filter, rules: [...filter.rules, { type, ...ruleDef(type).defaults }] });
  return (
    <>
      <SheetHead title={seg ? 'Edit audience' : 'New audience'} onClose={onClose} />
      <div className="mk-form">
        <div className="form-grid">
          <label className="field span2"><span>Name</span><input className="input" value={name} maxLength={60} disabled={disabled} onChange={(e) => setName(e.target.value)} placeholder="Members who haven’t been in a while" /></label>
          <label className="field span2"><span>Note (optional)</span><input className="input" value={description} maxLength={140} disabled={disabled} onChange={(e) => setDescription(e.target.value)} /></label>
        </div>
        <div className="mk-rules">
          <div className="mk-rules-h"><strong>Match</strong>
            <Seg value={filter.match} options={[{ value: 'all', label: 'All of these' }, { value: 'any', label: 'Any of these' }]} onChange={(v) => !disabled && setFilter({ ...filter, match: v })} />
          </div>
          {filter.rules.length === 0 && <p className="muted small">No rules: everyone.</p>}
          {filter.rules.map((r, i) => {
            const d = ruleDef(r.type);
            return (
              <div key={i} className="mk-rule">
                <select className="select sm" aria-label="Rule" value={r.type} disabled={disabled} onChange={(e) => setRule(i, { type: e.target.value as SegmentRuleType, ...ruleDef(e.target.value as SegmentRuleType).defaults })}>
                  {RULE_DEFS.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}
                </select>
                {d.params?.includes('days') && <label className="mk-num"><input className="input sm" type="number" min={1} max={730} value={r.days ?? ''} disabled={disabled} onChange={(e) => setRule(i, { days: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} aria-label="Days" /><span>days</span></label>}
                {d.params?.includes('credits') && <label className="mk-num"><input className="input sm" type="number" min={0} max={50} value={r.credits ?? ''} disabled={disabled} onChange={(e) => setRule(i, { credits: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} aria-label="Credits" /><span>credits</span></label>}
                {d.params?.includes('tag') && <input className="input sm" placeholder="tag" value={r.tag ?? ''} disabled={disabled} onChange={(e) => setRule(i, { tag: e.target.value })} aria-label="Tag" />}
                <label className="check"><input type="checkbox" checked={!!r.not} disabled={disabled} onChange={(e) => setRule(i, { not: e.target.checked })} /><span>Not</span></label>
                {!disabled && <button className="btn sm ghost" aria-label="Remove rule" onClick={() => setFilter({ ...filter, rules: filter.rules.filter((_, j) => j !== i) })}><Icon name="x" size={16} /></button>}
              </div>
            );
          })}
          {!disabled && <div className="mk-add">{RULE_DEFS.filter((d) => !filter.rules.some((r) => r.type === d.type) || d.type === 'tag').map((d) => <button key={d.type} className="chip-btn" onClick={() => addRule(d.type)}><Icon name="plus" size={16} />{d.label}</button>)}</div>}
        </div>
        <div className="panel mk-preview" aria-live="polite">
          {preview ? (
            <>
              <p><strong>{preview.count}</strong> {preview.count === 1 ? 'client matches' : 'clients match'}, <strong>{preview.optedIn}</strong> can get marketing.</p>
              {preview.sample.length > 0 && <p className="faint small">{preview.sample.map((p) => `${p.firstName} ${p.lastName}${p.optIn ? '' : ' (not opted in)'}`).join(', ')}{preview.count > preview.sample.length ? '…' : ''}</p>}
            </>
          ) : <span className="faint small">Counting…</span>}
        </div>
      </div>
      <div className="sh-foot">
        {seg && !disabled && <button className="btn ghost danger" disabled={busy} onClick={() => run(async () => { await needMarketing().deleteSegment(seg.id); onClose(); }, 'Audience deleted')}>Delete</button>}
        <span className="mk-grow" />
        <button className="btn ghost" onClick={onClose}>{disabled ? 'Close' : 'Cancel'}</button>
        {!disabled && <button className="btn" disabled={busy || !name.trim()} onClick={() => run(async () => { await needMarketing().saveSegment({ ...(seg ? { id: seg.id } : {}), name, description, filter }); onClose(); }, 'Saved')}>Save</button>}
      </div>
    </>
  );
}
