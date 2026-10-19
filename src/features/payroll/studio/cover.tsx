/**
 * Sub / cover requests, studio app: the Cover page (open · claimed · history), the roster header strip, and the Today widget.
 * Instructors ask for cover on their own classes; eligible staff are told in-app (and by email on live) and can claim;
 * the owner or a manager approves unless the studio has auto-approval on. Approval changes the class's instructor.
 */
import React, { useState } from 'react';
import { Sheet, store, useAction, useData } from '../../../shared/react';
import { Flower } from '../../../shared/brand';
import { time } from '../../../shared/format';
import type { SessionWithCounts } from '../../../shared/types';
import { Avatar, Confirm, Empty, Icon, Loading, PageHead, Seg, SheetHead, cx, dateTime, dayShort, useStudio } from '../../../studio/ui';
import type { CoverRequestView } from '../types';
import { payroll } from './bits';

// ---------------------------------------------------------------- one request

const STATUS_CHIP: Record<string, { label: string; tone: string }> = {
  open: { label: 'Needs cover', tone: 'warn' },
  claimed: { label: 'Waiting for approval', tone: 'cream' },
  approved: { label: 'Covered', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: '' },
  expired: { label: 'Not covered', tone: 'danger' },
};

/** Everything a person can do to a request, with toasts and confirmations wired up. */
function useCoverActions() {
  const { busy, run } = useAction();
  const pr = payroll();
  return {
    busy,
    claim: (r: CoverRequestView, then?: () => void) => run(async () => { const v = await pr!.claimCover(r.id); then?.(); return v; }, 'Thanks! You’re down for it'),
    withdraw: (r: CoverRequestView) => run(() => pr!.withdrawCoverClaim(r.id), 'No worries, it’s back up for grabs'),
    approve: (r: CoverRequestView) => run(() => pr!.decideCover(r.id, 'approve'), 'Approved. The class has a new instructor'),
    decline: (r: CoverRequestView, note: string) => run(() => pr!.decideCover(r.id, 'decline', note), 'Declined. It’s open again'),
    cancel: (r: CoverRequestView) => run(() => pr!.cancelCover(r.id), 'Cover request cancelled'),
  };
}

function CoverCard({ r, strip }: { r: CoverRequestView; strip?: boolean }) {
  const { me, can, staffById, typeById } = useStudio();
  const act = useCoverActions();
  const [confirm, setConfirm] = useState<'cancel' | 'decline' | null>(null);
  const [note, setNote] = useState('');
  const ct = typeById(r.session.classTypeId);
  const asker = staffById(r.requestedBy);
  const claimer = r.claimedBy ? staffById(r.claimedBy) : undefined;
  const approver = can('payroll.cover_approve');
  const mine = r.requestedBy === me.staffId || r.postedBy === me.staffId;
  const chip = STATUS_CHIP[r.status] ?? { label: r.status, tone: '' };
  const decider = r.decidedBy ? staffById(r.decidedBy)?.name : undefined;
  const t = time(r.session.startsAt);
  const face = r.status === 'approved' || r.status === 'claimed' ? claimer : asker;

  let line: React.ReactNode;
  if (r.status === 'approved') line = <>{claimer?.name ?? 'Someone'} covered for {asker?.name ?? 'the instructor'}{r.autoApproved ? ' · approved automatically' : decider ? ` · approved by ${decider}` : ''}</>;
  else if (r.status === 'claimed') line = <><strong>{claimer?.name ?? 'Someone'}</strong> offered to cover for {asker?.name ?? 'the instructor'}{approver ? '' : ' · waiting for the owner or a manager'}</>;
  else if (r.status === 'expired') line = <>Nobody picked this up in time. {asker?.name ?? 'The instructor'} taught it.</>;
  else if (r.status === 'cancelled') line = <>{asker?.name ?? 'The instructor'} no longer needs cover</>;
  else line = <><strong>{asker?.name ?? 'An instructor'}</strong> needs cover{mine ? ' (you asked)' : ''}</>;

  return (
    <article className={cx('cv-card', strip && 'strip', `st-${r.status}`)} style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>
      <div className="cv-when"><strong>{t.replace(/(am|pm)$/, '')}</strong><span>{t.slice(-2)}</span><em>{dayShort(r.session.startsAt)}</em></div>
      <div className="cv-body">
        <div className="cv-title">{ct?.name ?? 'Class'}<span className={cx('chip', chip.tone)}>{chip.label}</span></div>
        <div className="cv-who">
          {face && <Avatar name={face.name} photo={face.photoUrl} size={26} />}
          <span>{line}</span>
        </div>
        {r.reason && <p className="cv-reason">“{r.reason}”</p>}
        {r.status === 'open' && !strip && <p className="cv-meta">{r.notified.length} {r.notified.length === 1 ? 'person was' : 'people were'} told</p>}
        {r.decisionNote && r.status !== 'approved' && <p className="cv-meta">Note: {r.decisionNote}</p>}
      </div>
      <div className="cv-actions">
        {r.status === 'open' && r.canClaim && <button className="btn" disabled={act.busy} onClick={() => act.claim(r)}><Icon name="check" size={18} />I’ll take it</button>}
        {r.status === 'claimed' && approver && <button className="btn" disabled={act.busy} onClick={() => act.approve(r)}><Icon name="check" size={18} />Approve</button>}
        {r.status === 'claimed' && approver && <button className="btn soft" disabled={act.busy} onClick={() => setConfirm('decline')}>Decline</button>}
        {r.status === 'claimed' && r.claimedBy === me.staffId && <button className="btn ghost" disabled={act.busy} onClick={() => act.withdraw(r)}>Step back</button>}
        {(r.status === 'open' || r.status === 'claimed') && (mine || approver) && <button className="btn ghost danger-text" disabled={act.busy} onClick={() => setConfirm('cancel')}>Cancel request</button>}
        {r.status === 'approved' && <a className="btn soft" href={`#/class/${r.sessionId}`}>Open class</a>}
      </div>
      <Confirm open={confirm === 'cancel'} onClose={() => setConfirm(null)} title={<>Cancel this <em>request</em>?</>} confirmLabel="Cancel request" danger busy={act.busy}
        body={`${ct?.name ?? 'The class'} at ${dateTime(r.session.startsAt)} stays with ${asker?.name ?? 'the instructor'}.`}
        onConfirm={async () => { await act.cancel(r); setConfirm(null); }} />
      <Confirm open={confirm === 'decline'} onClose={() => setConfirm(null)} title={<>Decline <em>{claimer?.name.split(' ')[0] ?? 'this offer'}</em>?</>} confirmLabel="Decline" busy={act.busy}
        body="The request goes back to open and they can’t claim it again."
        onConfirm={async () => { await act.decline(r, note); setConfirm(null); setNote(''); }}>
        <label className="field"><span>Note (optional)</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Shown on the request" /></label>
      </Confirm>
    </article>
  );
}

// ---------------------------------------------------------------- ask for cover

export function RequestCoverSheet({ open, onClose, session }: { open: boolean; onClose: () => void; session?: SessionWithCounts | null }) {
  const { me, can, staff, typeById } = useStudio();
  const { busy, run } = useAction();
  const [picked, setPicked] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const approver = can('payroll.cover_approve');
  const classes = useData(async () => {
    if (!open || session) return [] as SessionWithCounts[];
    const from = new Date(), to = new Date(Date.now() + 28 * 864e5);
    const all = await store.listSessions({ from: from.toISOString(), to: to.toISOString(), includeCancelled: false });
    const live = new Set((await payroll()!.listCover()).filter((r) => r.status === 'open' || r.status === 'claimed').map((r) => r.sessionId));
    return all.filter((s) => (approver || s.instructorId === me.staffId) && !live.has(s.id) && new Date(s.startsAt).getTime() > Date.now());
  }, [open, !!session]);
  const chosen = session ?? classes.data?.find((s) => s.id === picked) ?? null;
  const close = () => { setPicked(null); setReason(''); onClose(); };
  const submit = async () => {
    if (!chosen) return;
    const r = await run(() => payroll()!.requestCover({ sessionId: chosen.id, ...(reason.trim() ? { reason } : {}) }), 'Cover requested. We’ve let the team know');
    if (r) close();
  };
  return (
    <Sheet open={open} onClose={close} label="Ask for cover">
      <SheetHead title={<>Ask for <em>cover</em></>} sub="Everyone who can teach is told straight away. The owner or a manager approves who takes it." onClose={close}
        back={!session && chosen ? { label: 'Pick another class', onClick: () => setPicked(null) } : undefined} />
      {!chosen ? (
        classes.loading && !classes.data ? <Loading /> : (classes.data?.length ?? 0) === 0 ? (
          <p className="muted">{approver ? 'There are no upcoming classes without a cover request.' : 'You’re not teaching anything in the next four weeks that still needs cover.'}</p>
        ) : (
          <div className="cv-pick">
            {classes.data!.map((s) => {
              const ct = typeById(s.classTypeId);
              const who = staff.find((x) => x.id === s.instructorId);
              return (
                <button key={s.id} className="cv-pick-row" onClick={() => setPicked(s.id)} style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>
                  <span className="cv-pick-t"><strong>{time(s.startsAt)}</strong><span>{dayShort(s.startsAt)}</span></span>
                  <span className="cv-pick-n">{ct?.name ?? 'Class'}{approver && who ? <span className="faint small"> · {who.name}</span> : null}</span>
                  <Icon name="right" size={18} />
                </button>
              );
            })}
          </div>
        )
      ) : (
        <>
          <div className="cv-chosen" style={{ ['--ct' as string]: typeById(chosen.classTypeId)?.color ?? 'var(--accent)' }}>
            <strong>{typeById(chosen.classTypeId)?.name ?? 'Class'}</strong>
            <span>{dateTime(chosen.startsAt)} · {staff.find((x) => x.id === chosen.instructorId)?.name}</span>
          </div>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Reason (optional)</span>
            <textarea className="textarea" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="So people know what’s up, like “Dentist, can’t move it”." />
          </label>
          <div className="sh-foot"><button className="btn ghost" onClick={close}>Not now</button><button className="btn" disabled={busy} onClick={submit}>Ask for cover</button></div>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- the Cover page

export function CoverPage() {
  if (!payroll()) return null;
  return <CoverPageInner />;
}
function CoverPageInner() {
  const { can, me } = useStudio();
  const pr = payroll()!;
  const [tab, setTab] = useState<'open' | 'claimed' | 'history'>('open');
  const [ask, setAsk] = useState(false);
  const list = useData(() => pr.listCover(), []);
  const settings = useData(() => pr.getSettings(), []);
  const { busy, run } = useAction();
  const all = list.data ?? [];
  const open = all.filter((r) => r.status === 'open');
  const claimed = all.filter((r) => r.status === 'claimed');
  const history = all.filter((r) => !['open', 'claimed'].includes(r.status)).sort((a, b) => b.session.startsAt.localeCompare(a.session.startsAt));
  const approver = can('payroll.cover_approve');
  const rows = tab === 'open' ? open : tab === 'claimed' ? claimed : history;
  const forYou = open.filter((r) => r.canClaim).length;
  const sub = list.loading && !list.data ? 'Checking the board…'
    : open.length + claimed.length === 0 ? 'Every class has its instructor. Lovely.'
    : [open.length ? `${open.length} ${open.length === 1 ? 'class needs' : 'classes need'} cover${forYou ? `, ${forYou} you could take` : ''}` : '', claimed.length ? `${claimed.length} waiting for approval` : ''].filter(Boolean).join(' · ');
  const toggleAuto = (v: boolean) => run(() => pr.updateSettings({ coverAutoApprove: v }), v ? 'Claims now go straight through' : 'Claims now wait for approval');

  return (
    <div className="cover-page">
      <PageHead eyebrow="Sub + cover" title={<>Class <em>cover</em></>} sub={sub}
        actions={<button className="btn" onClick={() => setAsk(true)}><Icon name="plus" size={20} />{approver ? 'Post a request' : 'I need cover'}</button>} />
      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[
          { value: 'open', label: <>Open{open.length > 0 && <span className="count">{open.length}</span>}</> },
          { value: 'claimed', label: <>Claimed{claimed.length > 0 && <span className="count">{claimed.length}</span>}</> },
          { value: 'history', label: 'History' },
        ]} />
      </div>
      {list.loading && !list.data ? <Loading /> : rows.length === 0 ? (
        <div className="card"><Empty title={tab === 'open' ? 'All covered' : tab === 'claimed' ? 'Nothing to approve' : 'No history yet'}>
          {tab === 'open' ? 'Nobody needs a sub right now. If you can’t make a class, tap “I need cover”.' : tab === 'claimed' ? 'When someone puts their hand up for a class, it shows here.' : 'Covered and cancelled requests from the last couple of months show here.'}
        </Empty></div>
      ) : (
        <div className={cx('cv-list', list.loading && 'dim')}>{rows.map((r) => <CoverCard key={r.id} r={r} />)}</div>
      )}
      {approver && settings.data && (
        <section className="card pad cv-setting">
          <label className="check">
            <input type="checkbox" checked={settings.data.coverAutoApprove} disabled={busy} onChange={(e) => toggleAuto(e.target.checked)} />
            <span><strong>Approve claims automatically</strong><br /><span className="muted small">{settings.data.coverAutoApprove ? 'The first eligible person to claim a class gets it, and the instructor changes straight away.' : `Claims wait for ${me.role === 'owner' ? 'you' : 'the owner or a manager'} to approve before the instructor changes.`}</span></span>
          </label>
        </section>
      )}
      <RequestCoverSheet open={ask} onClose={() => setAsk(false)} />
    </div>
  );
}

// ---------------------------------------------------------------- roster header slot

export function RosterCover({ session }: { session: SessionWithCounts }) {
  if (!payroll()) return null;
  return <RosterCoverInner session={session} />;
}
function RosterCoverInner({ session }: { session: SessionWithCounts }) {
  const { me, can, staffById } = useStudio();
  const pr = payroll()!;
  const [ask, setAsk] = useState(false);
  const cover = useData(() => pr.coverForSession(session.id), [session.id, session.instructorId]);
  const r = cover.data;
  const upcoming = session.status === 'scheduled' && new Date(session.startsAt).getTime() > Date.now();
  const mayAsk = upcoming && (session.instructorId === me.staffId || can('payroll.cover_approve'));
  if (!r) {
    if (!mayAsk || cover.loading) return null;
    return (
      <div className="cv-strip-ask">
        <button className="btn soft sm" onClick={() => setAsk(true)}><Icon name="repeat" size={18} />Need cover for this class?</button>
        <RequestCoverSheet open={ask} onClose={() => setAsk(false)} session={session} />
      </div>
    );
  }
  if (r.status === 'approved' && !upcoming) return null;
  if (!['open', 'claimed', 'approved'].includes(r.status)) return null;
  return <div className="cv-strip"><Flower size={16} className="cv-fl" /><CoverCard r={r} strip /></div>;
}

// ---------------------------------------------------------------- Today widget

export function CoverToday() {
  if (!payroll()) return null;
  return <CoverTodayInner />;
}
function CoverTodayInner() {
  const { me, can, staffById, typeById } = useStudio();
  const pr = payroll()!;
  const list = useData(() => pr.listCover(), []);
  const act = useCoverActions();
  const all = (list.data ?? []).filter((r) => new Date(r.session.startsAt).getTime() > Date.now());
  const approver = can('payroll.cover_approve');
  const items = [
    ...all.filter((r) => r.status === 'claimed' && approver),
    ...all.filter((r) => r.status === 'open' && r.canClaim),
    ...all.filter((r) => r.status === 'open' && !r.canClaim && (r.requestedBy === me.staffId || approver)),
    ...all.filter((r) => r.status === 'claimed' && !approver && (r.claimedBy === me.staffId || r.requestedBy === me.staffId)),
  ];
  if (!items.length) return null;
  return (
    <section className="card pad cv-today">
      <div className="sec-head" style={{ marginBottom: 6 }}>
        <h3><Flower size={16} className="h-fl" />Class <em>cover</em></h3>
        <a className="linkish" href="#/cover">See all<Icon name="right" size={16} /></a>
      </div>
      <div className="cv-mini">
        {items.slice(0, 4).map((r) => {
          const ct = typeById(r.session.classTypeId);
          const asker = staffById(r.requestedBy)?.name.split(' ')[0] ?? 'Someone';
          const claimer = r.claimedBy ? staffById(r.claimedBy)?.name.split(' ')[0] ?? 'Someone' : '';
          return (
            <div key={r.id} className="cv-mini-row" style={{ ['--ct' as string]: ct?.color ?? 'var(--accent)' }}>
              <div className="cv-mini-t">
                <strong>{ct?.name ?? 'Class'}</strong>
                <span>{dateTime(r.session.startsAt)}</span>
                <span className="faint">{r.status === 'claimed' ? `${claimer} offered to cover ${asker}` : r.requestedBy === me.staffId ? 'Waiting for someone to claim' : `${asker} needs cover`}</span>
              </div>
              {r.status === 'open' && r.canClaim && <button className="btn sm" disabled={act.busy} onClick={() => act.claim(r)}>Claim</button>}
              {r.status === 'claimed' && approver && <button className="btn sm" disabled={act.busy} onClick={() => act.approve(r)}>Approve</button>}
            </div>
          );
        })}
        {items.length > 4 && <p className="faint small">+ {items.length - 4} more</p>}
      </div>
    </section>
  );
}
