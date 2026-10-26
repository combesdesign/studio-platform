/** Studio › Online classes: the library with add, edit, publish/unpublish, reorder and a views count. */
import React, { useEffect, useState } from 'react';
import { brandAsset } from '../../../shared/branding';
import { Sheet, errorMessage, store, useData } from '../../../shared/react';
import { Confirm, Empty, Icon, Loading, PageHead, SheetHead, useSnack } from '../../../studio/ui';
import { SUGGESTED_CATEGORIES, SUGGESTED_LEVELS, durationLabel, parseVideoUrl } from '../calc';
import type { AdminVideo, VideoInput } from '../types';

const BLANK: VideoInput = { title: '', description: '', instructor: '', durationMin: 20, level: 'All levels', category: 'Core', thumbnailUrl: '', videoUrl: '', published: false, free: false };

export function OnDemandPage() {
  const snack = useSnack();
  const od = store.features.ondemand;
  const list = useData(async () => (od ? od.adminList() : ([] as AdminVideo[])), []);
  const [edit, setEdit] = useState<{ id?: string; v: VideoInput } | null>(null);
  const [del, setDel] = useState<AdminVideo | null>(null);
  const [busy, setBusy] = useState(false);
  if (!od) return null;
  const videos = list.data ?? [];

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) snack(ok); } catch (e) { snack(errorMessage(e)); } finally { setBusy(false); }
  };
  const move = (i: number, d: -1 | 1) => {
    const ids = videos.map((v) => v.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void act(() => od.reorder(ids));
  };
  const total = videos.reduce((a, v) => a + v.views, 0);

  return (
    <>
      <PageHead
        eyebrow="Library"
        title={<>Online <em>classes</em></>}
        sub={videos.length ? `${videos.length} ${videos.length === 1 ? 'video' : 'videos'} · ${videos.filter((v) => v.published).length} published · ${total} views` : 'On-demand video for your clients.'}
        actions={<button className="btn" onClick={() => setEdit({ v: { ...BLANK } })}><Icon name="plus" size={18} />Add video</button>}
      />
      {list.error && !list.data ? <Empty title="That didn’t load">{list.error.message}</Empty> : !list.data ? <Loading /> : videos.length === 0 ? (
        <Empty title="No videos yet">Paste a Vimeo or YouTube link (unlisted is fine) or a direct .mp4 link to add your first online class. Then choose which products include online access in Settings.</Empty>
      ) : (
        <ul className="od-list">
          {videos.map((v, i) => {
            const img = brandAsset(v.thumbnailUrl);
            return (
              <li key={v.id} className={'card od-item' + (v.published ? '' : ' draft')}>
                <div className="od-pic">{img ? <img src={img} alt="" loading="lazy" /> : <Icon name="play" size={22} />}</div>
                <div className="od-main">
                  <div className="od-name">{v.title}</div>
                  <div className="od-sub muted">{[v.category, v.instructor, durationLabel(v.durationMin), v.level].filter(Boolean).join(' · ')}</div>
                  <div className="od-flags">
                    <span className={'chip ' + (v.published ? 'ok' : '')}>{v.published ? 'Published' : 'Draft'}</span>
                    {v.free && <span className="chip">Free for everyone</span>}
                    <span className="od-views muted"><Icon name="eye" size={15} />{v.views} {v.views === 1 ? 'view' : 'views'}</span>
                  </div>
                </div>
                <div className="od-acts">
                  <button className="btn sm ghost" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${v.title} up`}><Icon name="down" size={16} className="od-flip" /></button>
                  <button className="btn sm ghost" disabled={busy || i === videos.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${v.title} down`}><Icon name="down" size={16} /></button>
                  <button className="btn sm" disabled={busy} onClick={() => void act(() => od.setPublished(v.id, !v.published), v.published ? 'Moved back to draft' : 'Published')}>{v.published ? 'Unpublish' : 'Publish'}</button>
                  <button className="btn sm ghost" onClick={() => setEdit({ id: v.id, v: { ...v } })} aria-label={`Edit ${v.title}`}><Icon name="edit" size={16} /></button>
                  <button className="btn sm ghost" onClick={() => setDel(v)} aria-label={`Delete ${v.title}`}><Icon name="trash" size={16} /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <VideoSheet edit={edit} onClose={() => setEdit(null)} onSave={(v, id) => act(async () => { await od.save(v, id); setEdit(null); }, id ? 'Video saved' : 'Video added')} busy={busy} />
      <Confirm open={!!del} title={<>Delete <em>{del?.title}</em>?</>} body="It disappears from the app and its views are cleared. You can add it again any time." confirmLabel="Delete" danger busy={busy}
        onClose={() => setDel(null)} onConfirm={() => void act(async () => { await od.remove(del!.id); setDel(null); }, 'Video deleted')} />
    </>
  );
}

function VideoSheet({ edit, onClose, onSave, busy }: { edit: { id?: string; v: VideoInput } | null; onClose: () => void; onSave: (v: VideoInput, id?: string) => void; busy: boolean }) {
  const [v, setV] = useState<VideoInput>(BLANK);
  useEffect(() => { if (edit) setV(edit.v); }, [edit]);
  const set = <K extends keyof VideoInput>(k: K, val: VideoInput[K]) => setV((x) => ({ ...x, [k]: val }));
  const text = (k: 'title' | 'instructor' | 'level' | 'category' | 'thumbnailUrl' | 'videoUrl') => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value);
  const kind = v.videoUrl.trim() ? parseVideoUrl(v.videoUrl).kind : null;
  const hint = kind === null ? 'Vimeo or YouTube (unlisted is fine), or a direct .mp4 link.'
    : kind === 'invalid' ? 'That link isn’t a Vimeo, YouTube or video file link.'
      : kind === 'file' ? 'Direct video file: it plays in the app.' : `${kind === 'youtube' ? 'YouTube' : 'Vimeo'} link: it plays in the app.`;
  return (
    <Sheet open={!!edit} onClose={onClose} label="Video">
      <SheetHead title={edit?.id ? <>Edit <em>video</em></> : <>Add a <em>video</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field span2"><span>Title</span><input className="input" value={v.title} onChange={text('title')} placeholder="Mums + Bubs: getting started" /></label>
        <label className="field span2"><span>Video link</span><input className="input" type="url" inputMode="url" value={v.videoUrl} onChange={text('videoUrl')} placeholder="https://vimeo.com/…" aria-invalid={kind === 'invalid'} /><small className={kind === 'invalid' ? 'od-hint bad' : 'od-hint muted'}>{hint}</small></label>
        <label className="field span2"><span>Description</span><textarea className="textarea" rows={3} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} /></label>
        <label className="field"><span>Instructor</span><input className="input" value={v.instructor ?? ''} onChange={text('instructor')} /></label>
        <label className="field"><span>Length (minutes)</span><input className="input" type="number" min={1} value={v.durationMin || ''} onChange={(e) => set('durationMin', Number(e.target.value))} /></label>
        <label className="field"><span>Category</span><input className="input" list="od-cats" value={v.category} onChange={text('category')} /><datalist id="od-cats">{SUGGESTED_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist></label>
        <label className="field"><span>Level</span><input className="input" list="od-levels" value={v.level ?? ''} onChange={text('level')} /><datalist id="od-levels">{SUGGESTED_LEVELS.map((c) => <option key={c} value={c} />)}</datalist></label>
        <label className="field span2"><span>Thumbnail (optional)</span><input className="input" value={v.thumbnailUrl ?? ''} onChange={text('thumbnailUrl')} placeholder="img/wide.webp or https://…" /></label>
        <label className="check span2"><input type="checkbox" checked={!!v.free} onChange={(e) => set('free', e.target.checked)} /><span>Free: anyone signed in can watch (good for a Mums + Bubs intro)</span></label>
        <label className="check span2"><input type="checkbox" checked={!!v.published} onChange={(e) => set('published', e.target.checked)} /><span>Published (show it in the app)</span></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !v.title.trim() || !v.videoUrl.trim() || kind === 'invalid'} onClick={() => onSave(v, edit?.id)}>Save</button></div>
    </Sheet>
  );
}
