/**
 * Family accounts, client side: Profile → Family (add, edit, remove dependants, sign their waivers) and the
 * "Who's coming?" picker that class, workshop and appointment booking share.
 * Rules (also in docs/features/family.md): a dependant is a client row with no login. Credits come from their own passes first,
 * then the parent's family-shareable passes (packs by default; memberships only if the studio flags the product).
 */
import React, { useEffect, useState } from 'react';
import type { CreditSummary } from '../shared/store';
import type { Client } from '../shared/types';
import { store, useData, useToast, errorMessage, Sheet, leaveSheets } from '../shared/react';
import { studioDate } from '../shared/format';
import { Avatar, BackPill, CardSkeletons, ErrorBlock, Icon, SheetHead, useApp } from './ui';
import { backOut, flowFrom, goFlow, queryOf } from './lib';

type Nav = (to: string, o?: { replace?: boolean }) => void;

export const fullName = (c: Pick<Client, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`.trim();

/** "5 months", "3 yrs". Empty when we don't know. */
export function ageLabel(birthday?: string): string {
  if (!birthday) return '';
  const [y, m, d] = birthday.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = studioDate().split('-').map(Number) as [number, number, number];
  let months = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0);
  if (months < 0) months = 0;
  if (months < 24) return months < 1 ? 'Newborn' : `${months} month${months === 1 ? '' : 's'}`;
  return `${Math.floor(months / 12)} yrs`;
}

/** The signed-in parent's dependants (empty, and quick, for everyone else). */
export function useDependants() {
  const app = useApp();
  const r = useData(() => (store.listDependants ? store.listDependants(app.client.id) : Promise.resolve([] as Client[])), [app.client.id]);
  return { deps: r.data ?? [], loading: r.loading && !r.data, reload: r.reload, error: r.error };
}

/** One line on what a person's credits would be, for the family screen and the picker. */
export function creditLine(who: Client, c: CreditSummary | undefined, parentFirst: string): { text: string; ok: boolean } {
  if (!c) return { text: who.guardianClientId ? 'Needs a pass' : 'No pass yet', ok: false };
  const own = c.pass.clientId === who.id;
  return { text: `${own ? c.pass.name : `${parentFirst === 'You' ? 'Your' : `${parentFirst}’s`} ${c.pass.name}`} · ${c.label}`, ok: true };
}

// ------------------------------------------------------------------ Profile → Family
export function Family({ nav, path }: { nav: Nav; path: string }) {
  const app = useApp();
  const q = queryOf(path);
  const { deps, loading, reload, error } = useDependants();
  const [edit, setEdit] = useState<Partial<Client> | null>(null);
  const [waiverFor, setWaiverFor] = useState<Client | null>(null);
  const credits = useData(async () => {
    const out: Record<string, CreditSummary[]> = {};
    for (const d of deps) out[d.id] = await store.getCreditSummary(d.id);
    return out;
  }, [deps.map((d) => d.id).join(',')]);
  const origin = flowFrom(path);
  const then = q.get('then') || undefined;
  const leave = () => backOut(nav, path, '/profile');

  // '?sign=<id>' (from the class picker) opens that person's waiver straight away
  const signId = q.get('sign');
  useEffect(() => {
    if (signId && deps.length) { const d = deps.find((x) => x.id === signId); if (d) setWaiverFor(d); }
  }, [signId, deps.length]);

  return (
    <div className="flow">
      <div className="flow-top"><BackPill label={origin?.label ?? 'Profile'} onClick={leave} /></div>
      <div className="flow-body fam">
        <div className="kicker">Profile</div>
        <h1>Your <em>family</em></h1>
        <p className="lede">Add your kids, or a partner who doesn’t have their own login, and book for everyone from your account.</p>

        {error && !deps.length ? <ErrorBlock error={error} onRetry={reload} /> : loading ? <CardSkeletons n={2} h={120} /> : (
          <div className="stack lg">
            {deps.length === 0 && (
              <div className="panel-soft fam-empty">
                <Icon name="users" size={24} />
                <div><strong>No one added yet</strong><p className="muted">Add a child or partner and you’ll see a “Who’s coming?” choice whenever you book.</p></div>
              </div>
            )}
            {deps.map((d) => {
              const c = credits.data?.[d.id]?.[0];
              const line = creditLine(d, c, app.client.firstName);
              const age = ageLabel(d.birthday);
              return (
                <section key={d.id} className="card fam-card" aria-label={fullName(d)}>
                  <div className="fam-top">
                    <Avatar name={fullName(d)} src={d.photoUrl} size={52} />
                    <div className="fam-who">
                      <strong className="serif">{fullName(d)}</strong>
                      <span className="muted">{age || 'Date of birth not added'}</span>
                    </div>
                    <button className="btn sm soft" onClick={() => setEdit(d)} aria-label={`Edit ${d.firstName}`}>Edit</button>
                  </div>
                  {d.injuries && <p className="fam-notes"><Icon name="info" size={16} />{d.injuries}</p>}
                  <div className="fam-tags">
                    {d.waiverSignedAt ? <span className="tag ok"><Icon name="check" size={14} />Waiver signed</span> : <span className="tag warn">Waiver needed</span>}
                    <span className={'tag ' + (line.ok ? 'line' : 'warn')}><Icon name="ticket" size={14} />{line.text}</span>
                  </div>
                  <div className="fam-actions">
                    <button className={'btn sm ' + (d.waiverSignedAt ? 'soft' : '')} onClick={() => setWaiverFor(d)}>{d.waiverSignedAt ? 'Update waiver' : `Sign ${d.firstName}’s waiver`}</button>
                    <button className="btn sm soft" onClick={() => goFlow(nav, `/passes?who=${encodeURIComponent(d.id)}`, { label: 'Family', where: '/family' })}>Buy a pass</button>
                  </div>
                </section>
              );
            })}
            <button className="btn block" onClick={() => setEdit({})}><Icon name="plus" size={18} />Add someone</button>
            <div className="panel-soft fam-rules">
              <strong>How credits work</strong>
              <p className="muted">Everyone takes their own spot in class. Passes marked family-shareable (usually class packs) can be used for anyone in your family. Memberships and intro offers are personal, so each person needs their own. You can buy one for them in Passes.</p>
            </div>
          </div>
        )}
      </div>

      <DependantSheet open={!!edit} d={edit} onClose={() => setEdit(null)} onSaved={reload} />
      <DependantWaiverSheet d={waiverFor} onClose={() => setWaiverFor(null)} onSigned={() => { reload(); if (then) leaveSheets(leave); else setWaiverFor(null); }} />
    </div>
  );
}

// ------------------------------------------------------------------ add / edit
function DependantSheet({ open, d, onClose, onSaved }: { open: boolean; d: Partial<Client> | null; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [v, setV] = useState({ firstName: '', lastName: '', birthday: '', injuries: '' });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (open) { setV({ firstName: d?.firstName ?? '', lastName: d?.lastName ?? '', birthday: d?.birthday ?? '', injuries: d?.injuries ?? '' }); setConfirm(false); }
  }, [open, d?.id]);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store.saveDependant) return;
    setBusy(true);
    try {
      await store.saveDependant(app.client.id, {
        ...(d?.id ? { id: d.id } : {}), firstName: v.firstName, lastName: v.lastName, birthday: v.birthday || undefined, injuries: v.injuries || undefined,
      });
      toast(d?.id ? 'Saved' : `${v.firstName.trim()} added`);
      onSaved(); onClose();
    } catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!d?.id || !store.removeDependant) return;
    setBusy(true);
    try { await store.removeDependant(d.id); toast(`${d.firstName} removed`); onSaved(); onClose(); }
    catch (x) { toast(errorMessage(x)); setConfirm(false); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} label={d?.id ? 'Edit family member' : 'Add family member'}>
      <SheetHead back={{ label: 'Family', onClick: onClose }} title={d?.id ? <>Edit <em>{d.firstName}</em></> : <>Add <em>someone</em></>} />
      <form className="stack lg" onSubmit={save}>
        <div className="grid2">
          <label className="field"><span>First name</span><input className="input" required value={v.firstName} onChange={set('firstName')} autoComplete="off" /></label>
          <label className="field"><span>Last name</span><input className="input" value={v.lastName} onChange={set('lastName')} placeholder={app.client.lastName} autoComplete="off" /></label>
        </div>
        <label className="field"><span>Date of birth <i className="faint">(optional)</i></span><input className="input" type="date" max={studioDate()} value={v.birthday} onChange={set('birthday')} /></label>
        <label className="field"><span>Notes or injuries <i className="faint">(optional)</i></span>
          <textarea className="textarea" rows={3} value={v.injuries} onChange={set('injuries')} placeholder="Anything your instructor should know" />
          <small className="muted fine">Instructors see this on the class list.</small>
        </label>
        <button className="btn block" disabled={busy || !v.firstName.trim()}>{busy ? 'Saving…' : d?.id ? 'Save changes' : 'Add to my family'}</button>
        {d?.id && (confirm ? (
          <div className="panel-soft stack">
            <p><strong>Remove {d.firstName}?</strong> Their class history stays with the studio, but you won’t be able to book for them. You can only remove someone who has no upcoming classes.</p>
            <button type="button" className="btn danger block" disabled={busy} onClick={remove}>Yes, remove {d.firstName}</button>
            <button type="button" className="btn ghost block" onClick={() => setConfirm(false)}>Keep {d.firstName}</button>
          </div>
        ) : <button type="button" className="btn plain block" onClick={() => setConfirm(true)}>Remove {d.firstName}</button>)}
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ the parent signs the waiver
type YN = 'Yes' | 'No' | '';
function DependantWaiverSheet({ d, onClose, onSigned }: { d: Client | null; onClose: () => void; onSigned: () => void }) {
  return (
    <Sheet open={!!d} onClose={onClose} label="Waiver and health form">
      {d && <WaiverBody key={d.id} d={d} onClose={onClose} onSigned={onSigned} />}
    </Sheet>
  );
}

function WaiverBody({ d, onClose, onSigned }: { d: Client; onClose: () => void; onSigned: () => void }) {
  const app = useApp();
  const toast = useToast();
  const qs = app.settings.healthQuestions ?? [];
  const [answers, setAnswers] = useState<Record<string, { yn: YN; detail: string }>>(() => Object.fromEntries(qs.map((x) => [x, { yn: '' as YN, detail: '' }])));
  const [injuries, setInjuries] = useState(d.healthForm?.injuries ?? d.injuries ?? '');
  const [agree, setAgree] = useState(false);
  const [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);
  const paras = (app.settings.waiverText || '').split(/\n{2,}|\r?\n/).filter((s) => s.trim());
  const ok = qs.every((x) => answers[x]?.yn) && agree && sig.trim().length >= 2;
  const submit = async () => {
    setBusy(true);
    try {
      const out: Record<string, string> = {};
      qs.forEach((x) => { const a = answers[x]!; out[x] = a.yn === 'Yes' ? (a.detail.trim() ? `Yes: ${a.detail.trim()}` : 'Yes') : 'No'; });
      out['Signed by parent or guardian'] = sig.trim();
      await store.submitWaiver(d.id, { answers: out, ...(injuries.trim() ? { injuries: injuries.trim() } : {}) });
      toast(`${d.firstName}’s waiver is signed`);
      onSigned();
    } catch (x) { toast(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <div className="stack lg">
      <SheetHead back={{ label: 'Family', onClick: onClose }} title={<>{d.firstName}’s <em>waiver</em></>} />
      <p className="muted">You’re signing for {d.firstName} as their parent or guardian. Please answer the questions about {d.firstName}, not yourself.</p>
      {qs.map((x) => {
        const a = answers[x]!;
        return (
          <div key={x} className="fam-q">
            <p>{x}</p>
            <div className="fam-yn" role="radiogroup" aria-label={x}>
              {(['Yes', 'No'] as const).map((yn) => (
                <button key={yn} type="button" role="radio" aria-checked={a.yn === yn} className={'btn sm ' + (a.yn === yn ? '' : 'soft')} onClick={() => setAnswers({ ...answers, [x]: { ...a, yn } })}>{yn}</button>
              ))}
            </div>
            {a.yn === 'Yes' && <input className="input" aria-label="Details" placeholder="A few details" value={a.detail} onChange={(e) => setAnswers({ ...answers, [x]: { ...a, detail: e.target.value } })} />}
          </div>
        );
      })}
      <label className="field"><span>Injuries or notes <i className="faint">(optional)</i></span><textarea className="textarea" rows={2} value={injuries} onChange={(e) => setInjuries(e.target.value)} /></label>
      {paras.length > 0 && <div className="panel-soft fam-waiver">{paras.map((p, i) => <p key={i}>{p}</p>)}</div>}
      <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I’m {d.firstName}’s parent or legal guardian, and I agree to the waiver on their behalf.</span></label>
      <label className="field"><span>Type your full name to sign</span><input className="input" value={sig} onChange={(e) => setSig(e.target.value)} placeholder={fullName(app.client)} autoComplete="off" /></label>
      <button className="btn block" disabled={!ok || busy} onClick={submit}>{busy ? 'Signing…' : 'Sign waiver'}</button>
    </div>
  );
}

// ------------------------------------------------------------------ "Who's coming?"
export interface WhoOption {
  id: string;
  name: string;
  /** Second line: what they'd use, e.g. "Your 4 class pack · 3 left". */
  sub?: string;
  /** Short flag, e.g. "Waiver needed". */
  flag?: string;
  /** Booked already, or can't be picked right now. */
  disabled?: boolean;
  photoUrl?: string;
}

/** Tick the people coming. Only shown when the parent has dependants. */
export function WhosComing({ options, selected, onChange, title = 'Who’s coming?', single }: { options: WhoOption[]; selected: string[]; onChange: (ids: string[]) => void; title?: string; /** Pick exactly one (a private session, or a paid online checkout). */ single?: boolean }) {
  const toggle = (id: string) => onChange(single ? [id] : selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="picker who" role={single ? 'radiogroup' : 'group'} aria-label={title}>
      <div className="kicker">{title}</div>
      <div className="picker-list">
        {options.map((o) => {
          const on = selected.includes(o.id) && !o.disabled;
          return (
            <button key={o.id} type="button" role={single ? 'radio' : 'checkbox'} aria-checked={on} disabled={o.disabled} className={'picker-opt' + (on ? ' on' : '')} onClick={() => toggle(o.id)}>
              <span className={single ? 'radio' : 'tickbox'} aria-hidden="true">{on && !single && <Icon name="check" size={15} />}</span>
              <Avatar name={o.name} src={o.photoUrl} size={36} />
              <span className="picker-main">
                <span className="picker-name">{o.name}</span>
                {o.sub && <span className="muted">{o.sub}</span>}
              </span>
              {o.flag && <span className="tag warn">{o.flag}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
