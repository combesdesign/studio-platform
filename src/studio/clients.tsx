import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, store, useAction, useData, useToast } from '../shared/react';
import { addDays, money, studioDate, time } from '../shared/format';
import type { Client, Pass, Sale } from '../shared/types';
import type { BookingWithDetails, CreditSummary } from '../shared/store';
import { Avatar, Empty, Icon, Loading, PageHead, Seg, SheetHead, cx, dayShort, fullName, toCents, toDollars, useStudio } from './ui';
import { BookClientSheet, NewClientSheet, WaiverSheet } from './book';
import { computePassStatus, isPassCurrent } from '../domain';

// ------------------------------------------------------------------ list
type Filter = 'all' | 'nowaiver' | 'new' | 'injury';
export function Clients() {
  const { can } = useStudio();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(() => can('editClients') && /[?&]new=1/.test(location.hash));
  const res = useData(() => store.listClients({ search: q.trim() || undefined }), [q]);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
  const list = (res.data ?? []).filter((c) =>
    filter === 'nowaiver' ? !c.waiverSignedAt : filter === 'new' ? c.createdAt >= monthAgo : filter === 'injury' ? !!(c.injuries || c.healthForm?.injuries) : true,
  ).sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const total = res.data?.length ?? 0;

  return (
    <div className="clients">
      <PageHead eyebrow={res.data ? `${total} ${q ? 'matching' : 'active'} clients` : 'Clients'} title={<>Your <em>clients</em></>}
        actions={can('editClients') && <button className="btn" onClick={() => setAdding(true)}><Icon name="userPlus" size={20} />New client</button>} />
      <div className="toolbar">
        <label className="search-in grow">
          <Icon name="search" size={20} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone" aria-label="Search clients" />
        </label>
        <Seg value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'new', label: 'New' }, { value: 'nowaiver', label: 'No waiver' }, { value: 'injury', label: 'Injuries' },
        ]} />
      </div>
      {res.loading && !res.data ? <Loading /> : list.length === 0 ? (
        <div className="card"><Empty title="No clients found">{q ? 'Try a different name, email or phone.' : 'Nothing in this filter.'}</Empty></div>
      ) : (
        <div className="card clist">
          {list.map((c) => (
            <a key={c.id} href={`#/clients/${c.id}`} className="crow">
              <Avatar name={fullName(c)} size={44} />
              <span className="cr-name"><strong>{fullName(c)}</strong><span className="cr-sub">{c.email}</span></span>
              <span className="cr-phone">{c.phone ?? <span className="faint">No phone</span>}</span>
              <span className="cr-flags">
                {!c.waiverSignedAt && <span className="chip danger">No waiver</span>}
                {(c.injuries || c.healthForm?.injuries) && <span className="chip warn">Injury</span>}
                {c.createdAt >= monthAgo && <span className="chip navy">New</span>}
              </span>
              <span className="cr-since faint small">Since {new Date(c.createdAt).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</span>
              <Icon name="right" size={18} className="faint" />
            </a>
          ))}
        </div>
      )}
      <NewClientSheet open={adding} onClose={() => { setAdding(false); if (location.hash.includes('new=1')) history.replaceState(null, '', '#/clients'); }} onCreated={(c) => { setAdding(false); location.hash = `/clients/${c.id}`; }} />
    </div>
  );
}

// ------------------------------------------------------------------ profile
type Prof = { client: Client; passes: Pass[]; credits: CreditSummary[]; upcoming: BookingWithDetails[]; past: BookingWithDetails[] };
export function ClientProfile({ id }: { id: string }) {
  const { can } = useStudio();
  const today = studioDate();
  const res = useData<Prof>(async () => {
    const [client, passes, credits, upcoming, past] = await Promise.all([
      store.getClient(id), store.listPasses(id, { includeInactive: true }), store.getCreditSummary(id),
      store.listClientBookings(id, { when: 'upcoming' }), store.listClientBookings(id, { when: 'past' }),
    ]);
    return { client, passes, credits, upcoming, past };
  }, [id]);
  const sales = useData(() => (can('salesView') ? store.listSales({ from: '2000-01-01', to: addDays(today, 1), clientId: id }) : Promise.resolve([] as Sale[])), [id, today]);
  const [sheet, setSheet] = useState<null | 'edit' | 'book' | 'waiver'>(null);
  const [passSheet, setPassSheet] = useState<{ kind: 'adjust' | 'pause' | 'cancel'; pass: Pass } | null>(null);
  const [refund, setRefund] = useState<Sale | null>(null);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');

  if (res.error) return <div className="card pad" style={{ marginTop: 40 }}><Empty title="Client not found"><a href="#/clients">Back to clients</a></Empty></div>;
  if (!res.data) return <Loading />;
  const { client: c, passes, credits, upcoming, past } = res.data;
  const injuries = c.injuries || c.healthForm?.injuries;
  const nowD = new Date();
  const activePasses = passes.filter((p) => isPassCurrent(p, nowD));
  const oldPasses = passes.filter((p) => !isPassCurrent(p, nowD));
  const attended = past.filter((b) => b.status === 'checked_in').length;
  const age = c.birthday ? Math.floor((Date.now() - new Date(c.birthday).getTime()) / (365.25 * 864e5)) : null;

  return (
    <div className="profile">
      <a className="back" href="#/clients"><Icon name="left" size={18} />Clients</a>
      <header className="pf-head">
        <Avatar name={fullName(c)} size={84} className="pf-av" />
        <div className="pf-text">
          <h1>{c.firstName} <em>{c.lastName}</em></h1>
          <div className="pf-chips">
            {c.waiverSignedAt ? <span className="chip ok"><Icon name="check" size={14} />Waiver signed</span> : <button className="chip danger flag" onClick={() => setSheet('waiver')} disabled={!can('waiver')}><Icon name="doc" size={14} />No waiver</button>}
            {injuries && <span className="chip warn"><Icon name="injury" size={14} />Injury noted</span>}
            {c.healthForm?.pregnantOrPostnatal && <span className="chip cream">Pregnant / postnatal</span>}
            <span className="chip">Client since {new Date(c.createdAt).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</span>
            {c.archived && <span className="chip">Archived</span>}
          </div>
        </div>
        <div className="pf-actions">
          <button className="btn" onClick={() => setSheet('book')}><Icon name="calendar" size={20} />Book into class</button>
          {can('pos') && <a className="btn soft" href={`#/pos/${c.id}`}><Icon name="bag" size={20} />Sell</a>}
          {can('editClients') && <button className="btn icon soft" onClick={() => setSheet('edit')} aria-label="Edit details"><Icon name="edit" /></button>}
        </div>
      </header>

      <div className="pf-stats">
        <div><strong>{attended}</strong><span>classes attended</span></div>
        <div><strong>{upcoming.filter((b) => b.status === 'booked' || b.status === 'waitlisted').length}</strong><span>upcoming</span></div>
        <div><strong>{past.filter((b) => b.status === 'no_show').length}</strong><span>no-shows</span></div>
        <div><strong>{past.filter((b) => b.status === 'late_cancelled').length}</strong><span>late cancels</span></div>
      </div>

      <div className="pf-grid">
        <div className="stack lg">
          <section className="card pad">
            <div className="sec-head"><h3>Passes</h3>{can('pos') && <a className="linkish" href={`#/pos/${c.id}`}>Sell a pass<Icon name="right" size={16} /></a>}</div>
            {activePasses.length === 0 && <p className="muted">No active passes. {can('pos') && <a href={`#/pos/${c.id}`}>Sell one</a>}</p>}
            <div className="passes">
              {activePasses.map((p) => <PassCard key={p.id} p={p} summary={credits.find((x) => x.pass.id === p.id)} onAction={(kind) => setPassSheet({ kind, pass: p })} />)}
            </div>
            {oldPasses.length > 0 && (
              <details className="old-passes">
                <summary>{oldPasses.length} past {oldPasses.length === 1 ? 'pass' : 'passes'}<Icon name="down" size={16} /></summary>
                <div className="list">
                  {oldPasses.map((p) => (
                    <div key={p.id} className="spread op-row">
                      <span>{p.name}<span className="faint small"> · bought {dayShort(p.purchasedAt)}</span></span>
                      <span className="row" style={{ gap: 8 }}>
                        <span className="chip">{PASS_STATUS[computePassStatus(p, nowD)]}</span>
                        {can('adjustPasses') && p.kind !== 'membership' && computePassStatus(p, nowD) !== 'cancelled' && <button className="btn sm soft" onClick={() => setPassSheet({ kind: 'adjust', pass: p })}>Adjust</button>}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          <section className="card pad">
            <div className="sec-head"><h3>Bookings</h3><Seg value={tab} onChange={setTab} options={[{ value: 'upcoming', label: `Upcoming (${upcoming.length})` }, { value: 'past', label: `Past (${past.length})` }]} /></div>
            <BookingList list={tab === 'upcoming' ? upcoming : [...past].reverse()} empty={tab === 'upcoming' ? 'No upcoming classes.' : 'No past classes yet.'} />
          </section>

          {can('salesView') && (
            <section className="card pad">
              <div className="sec-head"><h3>Purchases</h3></div>
              {(sales.data ?? []).length === 0 ? <p className="muted">No purchases yet.</p> : (
                <div className="list sales">
                  {[...(sales.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => (
                    <div key={s.id} className="sale-row">
                      <span className="sr-date">{dayShort(s.createdAt)}<span className="faint small">{new Date(s.createdAt).getFullYear()}</span></span>
                      <span className="sr-items">{s.items.map((i) => `${i.qty > 1 ? i.qty + ' × ' : ''}${i.name}`).join(', ')}<span className="faint small">{METHOD_LABEL[s.method] ?? s.method}</span></span>
                      <span className="sr-total">{money(s.totalCents)}{s.refundedCents ? <span className="chip danger">Refunded {money(s.refundedCents)}</span> : null}</span>
                      {can('refund') && (s.refundedCents ?? 0) < s.totalCents && s.method !== 'comp' && s.totalCents > 0 && <button className="btn sm ghost" onClick={() => setRefund(s)}>Refund</button>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="stack lg">
          <section className="card pad">
            <div className="sec-head"><h3>Details</h3>{can('editClients') && <button className="linkish" onClick={() => setSheet('edit')}>Edit</button>}</div>
            <dl className="dl">
              <dt>Email</dt><dd><a href={`mailto:${c.email}`}>{c.email}</a></dd>
              <dt>Mobile</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className="faint">Not added</span>}</dd>
              <dt>Birthday</dt><dd>{c.birthday ? `${new Date(c.birthday + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long' })}${age ? ` (${age})` : ''}` : <span className="faint">Not added</span>}</dd>
              <dt>Emergency</dt><dd>{c.emergencyContactName ? `${c.emergencyContactName}${c.emergencyContactPhone ? ', ' + c.emergencyContactPhone : ''}` : <span className="faint">Not added</span>}</dd>
              <dt>Marketing</dt><dd>{c.marketingOptIn ? 'Happy to get news' : 'No marketing emails'}</dd>
            </dl>
          </section>

          <section className="card pad">
            <div className="sec-head"><h3>Health &amp; <em>waiver</em></h3>{can('waiver') && <button className="linkish" onClick={() => setSheet('waiver')}>{c.waiverSignedAt ? 'Update' : 'Record'}</button>}</div>
            <p className="small muted">{c.waiverSignedAt ? `Waiver signed ${dayShort(c.waiverSignedAt)} ${new Date(c.waiverSignedAt).getFullYear()}` : 'No waiver yet. They must sign before booking in the app.'}</p>
            {injuries && <div className="injury-box" style={{ marginTop: 12 }}><Icon name="injury" size={20} /><p>{injuries}</p></div>}
            {c.healthForm && Object.keys(c.healthForm.answers).length > 0 && (
              <dl className="dl qa">
                {Object.entries(c.healthForm.answers).map(([q, a]) => <React.Fragment key={q}><dt>{q}</dt><dd>{a || <span className="faint">No answer</span>}</dd></React.Fragment>)}
              </dl>
            )}
          </section>

          {can('staffNotes') && <NotesCard c={c} />}
        </aside>
      </div>

      {sheet === 'edit' && <EditClientSheet c={c} onClose={() => setSheet(null)} />}
      <BookClientSheet open={sheet === 'book'} onClose={() => setSheet(null)} client={c} />
      <WaiverSheet open={sheet === 'waiver'} onClose={() => setSheet(null)} client={c} />
      {passSheet?.kind === 'adjust' && <AdjustSheet p={passSheet.pass} onClose={() => setPassSheet(null)} />}
      {passSheet?.kind === 'pause' && <PauseSheet p={passSheet.pass} onClose={() => setPassSheet(null)} />}
      {passSheet?.kind === 'cancel' && <CancelMembershipSheet p={passSheet.pass} onClose={() => setPassSheet(null)} />}
      {refund && <RefundSheet s={refund} onClose={() => setRefund(null)} />}
    </div>
  );
}

export const METHOD_LABEL: Record<string, string> = { card_online: 'Card (online)', card_reader: 'Card reader', cash: 'Cash', comp: 'Comp', imported: 'Imported' };
const PASS_STATUS: Record<string, string> = { active: 'Active', paused: 'Paused', expired: 'Expired', cancelled: 'Cancelled', used_up: 'Used up' };
const KIND_LABEL: Record<string, string> = { membership: 'Membership', pack: 'Class pack', intro: 'Intro offer', dropin: 'Drop-in' };

function PassCard({ p, summary, onAction }: { p: Pass; summary?: CreditSummary; onAction: (k: 'adjust' | 'pause' | 'cancel') => void }) {
  const { can } = useStudio();
  const toast = useToast();
  const { run } = useAction();
  const left = p.credits == null ? null : p.kind === 'membership' ? null : Math.max(0, p.credits - p.creditsUsed);
  const pct = p.credits && p.kind !== 'membership' ? (left! / p.credits) * 100 : 100;
  const st = computePassStatus(p, new Date());
  const resume = async () => { if (await run(() => store.resumePass(p.id))) toast(st === 'paused' ? 'Membership resumed' : 'Pause cancelled'); };
  const pauseBooked = st === 'active' && !!p.pausedFrom && !!p.pausedUntil && p.pausedUntil >= studioDate();
  return (
    <div className={cx('pass', st === 'paused' && 'paused')}>
      <div className="pass-top">
        <span className="pass-kind">{KIND_LABEL[p.kind]}</span>
        {st === 'paused' && <span className="chip warn">Paused{p.pausedUntil ? ` until ${dayShort(p.pausedUntil + 'T02:00:00Z')}` : ''}</span>}
        {pauseBooked && <span className="chip warn">Pause from {dayShort(p.pausedFrom + 'T02:00:00Z')}</span>}
        {st === 'cancelled' && <span className="chip">Cancelled{p.nextBillingAt ? ` · ends ${dayShort(p.nextBillingAt)}` : ''}</span>}
      </div>
      <div className="pass-name">{p.name}</div>
      <div className="pass-credit">
        {summary ? summary.label : p.credits == null ? 'Unlimited' : p.kind === 'membership' ? `${p.credits} per week` : `${left} of ${p.credits} left`}
      </div>
      {left != null && <div className="pass-bar"><span style={{ width: pct + '%' }} /></div>}
      <div className="pass-meta">
        {p.activatedAt ? (p.expiresAt ? <>Expires {dayShort(p.expiresAt)} {new Date(p.expiresAt).getFullYear()}</> : 'No expiry') : 'Starts on first booking'}
        {p.nextBillingAt && p.kind === 'membership' && st !== 'cancelled' && <> · Next billing {dayShort(p.nextBillingAt)}</>}
      </div>
      {p.adjustments && p.adjustments.length > 0 && (
        <details className="adj"><summary>{p.adjustments.length} adjustment{p.adjustments.length > 1 ? 's' : ''}</summary>
          {p.adjustments.map((a, i) => <div key={i} className="small muted">{dayShort(a.at)}: {a.delta > 0 ? '+' : ''}{a.delta ? `${a.delta} credit${Math.abs(a.delta) === 1 ? '' : 's'}, ` : ''}{a.reason}</div>)}
        </details>
      )}
      {can('adjustPasses') && st !== 'cancelled' && (
        <div className="pass-actions">
          {p.kind !== 'membership' && <button className="btn sm soft" onClick={() => onAction('adjust')}>Adjust</button>}
          {p.kind === 'membership' && st === 'active' && !pauseBooked && <button className="btn sm soft" onClick={() => onAction('pause')}><Icon name="pause" size={16} />Pause</button>}
          {p.kind === 'membership' && (st === 'paused' || pauseBooked) && <button className="btn sm soft" onClick={resume}><Icon name="play" size={16} />{st === 'paused' ? 'Resume' : 'Cancel pause'}</button>}
          {p.kind === 'membership' && <button className="btn sm ghost danger-text" onClick={() => onAction('cancel')}>Cancel</button>}
        </div>
      )}
    </div>
  );
}

function BookingList({ list, empty }: { list: BookingWithDetails[]; empty: string }) {
  if (list.length === 0) return <p className="muted">{empty}</p>;
  const ST: Record<string, [string, string]> = {
    booked: ['Booked', 'navy'], waitlisted: ['Waitlist', 'cream'], checked_in: ['Attended', 'ok'], cancelled: ['Cancelled', ''],
    late_cancelled: ['Late cancel', 'warn'], no_show: ['No-show', 'danger'], removed: ['Removed', ''],
  };
  return (
    <div className="list blist">
      {list.slice(0, 40).map((b) => {
        const [l, tone] = ST[b.status] ?? [b.status, ''];
        return (
          <a key={b.id} href={`#/class/${b.sessionId}`} className="b-row" style={{ ['--ct' as string]: b.classType.color }}>
            <span className="b-date"><strong>{dayShort(b.session.startsAt)}</strong><span>{time(b.session.startsAt)}</span></span>
            <span className="b-t"><strong>{b.classType.name}</strong><span>{b.instructor?.name ?? ''}{b.session.status === 'cancelled' ? ' · class cancelled' : ''}</span></span>
            <span className={cx('chip', tone)}>{l}</span>
          </a>
        );
      })}
    </div>
  );
}

function NotesCard({ c }: { c: Client }) {
  const [v, setV] = useState(c.staffNotes ?? '');
  const { busy, run } = useAction();
  useEffect(() => setV(c.staffNotes ?? ''), [c.staffNotes]);
  const dirty = v !== (c.staffNotes ?? '');
  const save = () => run(() => store.upsertClient({ ...c, staffNotes: v.trim() || undefined }), 'Notes saved');
  return (
    <section className="card pad notes">
      <div className="sec-head"><h3>Staff <em>notes</em></h3><span className="faint small">Never shown to the client</span></div>
      <textarea className="textarea" value={v} onChange={(e) => setV(e.target.value)} placeholder="Preferences, payment arrangements, anything the team should know" rows={4} />
      {dirty && <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}><button className="btn sm ghost" onClick={() => setV(c.staffNotes ?? '')}>Discard</button><button className="btn sm" onClick={save} disabled={busy}>Save notes</button></div>}
    </section>
  );
}

function EditClientSheet({ c, onClose }: { c: Client; onClose: () => void }) {
  const [v, setV] = useState({ ...c });
  const { busy, run } = useAction();
  const f = (k: keyof Client) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value || undefined });
  const save = async () => { if (await run(() => store.upsertClient({ ...v, firstName: v.firstName || c.firstName, email: v.email || c.email }), 'Details saved')) onClose(); };
  return (
    <Sheet open onClose={onClose} label="Edit client">
      <SheetHead title={<>Edit <em>details</em></>} onClose={onClose} />
      <div className="form-grid">
        <label className="field"><span>First name</span><input className="input" value={v.firstName ?? ''} onChange={f('firstName')} /></label>
        <label className="field"><span>Last name</span><input className="input" value={v.lastName ?? ''} onChange={f('lastName')} /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={v.email ?? ''} onChange={f('email')} /></label>
        <label className="field"><span>Mobile</span><input className="input" type="tel" value={v.phone ?? ''} onChange={f('phone')} /></label>
        <label className="field"><span>Birthday</span><input className="input" type="date" value={v.birthday ?? ''} onChange={f('birthday')} /></label>
        <span />
        <label className="field"><span>Emergency contact</span><input className="input" value={v.emergencyContactName ?? ''} onChange={f('emergencyContactName')} /></label>
        <label className="field"><span>Emergency phone</span><input className="input" type="tel" value={v.emergencyContactPhone ?? ''} onChange={f('emergencyContactPhone')} /></label>
        <label className="field span2"><span>Injuries or health notes (shown on rosters)</span><textarea className="textarea" rows={2} value={v.injuries ?? ''} onChange={f('injuries')} /></label>
        <label className="check span2"><input type="checkbox" checked={!!v.marketingOptIn} onChange={(e) => setV({ ...v, marketingOptIn: e.target.checked })} /><span>Happy to receive news and offers</span></label>
        <label className="check span2"><input type="checkbox" checked={!!v.archived} onChange={(e) => setV({ ...v, archived: e.target.checked })} /><span>Archive this client (hides them from lists)</span></label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>Save</button></div>
    </Sheet>
  );
}

function AdjustSheet({ p, onClose }: { p: Pass; onClose: () => void }) {
  const [delta, setDelta] = useState(0);
  const [exp, setExp] = useState(p.expiresAt ? studioDate(p.expiresAt) : '');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const hasCredits = p.credits != null && p.kind !== 'membership';
  const left = hasCredits ? Math.max(0, p.credits! - p.creditsUsed) : null;
  const origExp = p.expiresAt ? studioDate(p.expiresAt) : '';
  const changed = delta !== 0 || exp !== origExp;
  const save = async () => {
    const change: { creditsDelta?: number; newExpiresAt?: string | null; reason: string } = { reason: reason.trim() };
    if (delta) change.creditsDelta = delta;
    if (exp !== origExp) change.newExpiresAt = exp ? new Date(exp + 'T13:59:00Z').toISOString() : null;
    if (await run(() => store.adjustPass(p.id, change), 'Pass updated')) onClose();
  };
  return (
    <Sheet open onClose={onClose} label="Adjust pass">
      <SheetHead title={<>Adjust <em>pass</em></>} sub={p.name} onClose={onClose} />
      <div className="stack lg">
        {hasCredits && (
          <div className="adj-credits">
            <span className="muted">Credits</span>
            <div className="stepper">
              <button className="btn icon soft" onClick={() => setDelta(delta - 1)} disabled={left! + delta <= 0} aria-label="Remove a credit"><Icon name="minus" /></button>
              <span className="st-v"><strong>{left! + delta}</strong><span>left{delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}</span></span>
              <button className="btn icon soft" onClick={() => setDelta(delta + 1)} aria-label="Add a credit"><Icon name="plus" /></button>
            </div>
          </div>
        )}
        <label className="field"><span>Expiry date {p.activatedAt ? '' : '(pass not started yet — normally set on first booking)'}</span>
          <input className="input" type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
        </label>
        <label className="field"><span>Reason (kept in the pass history)</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Away sick, extended 2 weeks" />
        </label>
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !changed || !reason.trim()}>Save adjustment</button></div>
    </Sheet>
  );
}

function PauseSheet({ p, onClose }: { p: Pass; onClose: () => void }) {
  const t = studioDate();
  const [from, setFrom] = useState(t);
  const [until, setUntil] = useState(addDays(t, 13));
  const { busy, run } = useAction();
  const days = Math.round((new Date(until).getTime() - new Date(from).getTime()) / 864e5) + 1;
  const save = async () => { if (await run(() => store.pausePass(p.id, from, until), 'Membership paused')) onClose(); };
  return (
    <Sheet open onClose={onClose} label="Pause membership">
      <SheetHead title={<>Pause <em>membership</em></>} sub={`${p.name}. No billing and no bookings while paused. Minimum one week.`} onClose={onClose} />
      <div className="form-grid">
        <label className="field"><span>From</span><input className="input" type="date" value={from} min={t} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>Until</span><input className="input" type="date" value={until} min={addDays(from, 6)} onChange={(e) => setUntil(e.target.value)} /></label>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>{days > 0 ? `${days} days` : 'Pick an end date after the start.'}</p>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || days < 7}>Pause</button></div>
    </Sheet>
  );
}

function CancelMembershipSheet({ p, onClose }: { p: Pass; onClose: () => void }) {
  const { busy, run } = useAction();
  const go = async () => { if (await run(() => store.cancelMembership(p.id), 'Membership cancelled')) onClose(); };
  return (
    <Sheet open onClose={onClose} label="Cancel membership">
      <SheetHead title={<>Cancel <em>membership</em>?</>} sub={p.name} onClose={onClose} />
      <p className="muted">Billing stops. {p.nextBillingAt ? `They can keep booking until ${dayShort(p.nextBillingAt)}, the end of the period they've paid for.` : 'They can keep booking until the end of the period they’ve paid for.'}</p>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Keep membership</button><button className="btn danger-solid" onClick={go} disabled={busy}>Cancel membership</button></div>
    </Sheet>
  );
}

function RefundSheet({ s, onClose }: { s: Sale; onClose: () => void }) {
  const [amt, setAmt] = useState(toDollars(s.totalCents - (s.refundedCents ?? 0)));
  const [cancelPass, setCancelPass] = useState(true);
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const cents = toCents(amt);
  const max = s.totalCents - (s.refundedCents ?? 0);
  const prods = useData(() => store.listProducts({ includeInactive: true }), []);
  const hasPass = useMemo(() => s.items.some((i) => { const pr = prods.data?.find((x) => x.id === i.productId); return pr ? pr.kind !== 'retail' : false; }), [s, prods.data]);
  const go = async () => { if (await run(() => store.refundSale(s.id, { amountCents: cents, cancelPass: hasPass && cancelPass, reason: reason.trim() || undefined }), `Refunded ${money(cents)}`)) onClose(); };
  return (
    <Sheet open onClose={onClose} label="Refund">
      <SheetHead title={<>Refund <em>sale</em></>} sub={`${s.items.map((i) => i.name).join(', ')} · ${money(s.totalCents)} · ${METHOD_LABEL[s.method] ?? s.method}`} onClose={onClose} />
      <div className="stack">
        <label className="field"><span>Amount</span><div className="money-in"><span>$</span><input className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></div></label>
        {hasPass && <label className="check"><input type="checkbox" checked={cancelPass} onChange={(e) => setCancelPass(e.target.checked)} /><span>Also cancel the pass from this sale (remaining credits are removed)</span></label>}
        <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Moving away" /></label>
        {s.method === 'card_reader' || s.method === 'card_online' ? <p className="small muted">Card refunds go back to the original card once Stripe is connected. For now this records the refund.</p> : s.method === 'cash' ? <p className="small muted">Hand back the cash from the till.</p> : null}
      </div>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn danger-solid" onClick={go} disabled={busy || cents <= 0 || cents > max}>Refund {money(cents)}</button></div>
    </Sheet>
  );
}
