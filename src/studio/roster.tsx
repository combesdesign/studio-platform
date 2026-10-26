import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, match, store, useAction, useBackHandler, useData, useToast } from '../shared/react';
import { Slot } from '../shared/slots';
import { studioDate, studioToUTC, time, weekStart, LOCALE, TZ } from '../shared/format';
import type { Booking, Pass, SessionWithCounts } from '../shared/types';
import type { RosterEntry } from '../shared/store';
import { Flower } from '../shared/brand';
import { Accent, Avatar, Confirm, Empty, Fill, Icon, Loading, PageHead, Sep, SheetHead, backFrom, cx, dayLong, fullName, goFromSheet, useSnack, useStudio } from './ui';
import { AddClientSheet, SessionPicker, WaiverSheet, WalkInSheet } from './book';
import { useNow } from './today';
import { RestoreClassSheet, useUndoSnack } from './undo';

type Flag = RosterEntry['flags'][number];
const FLAG: Record<Flag, { label: string; tone: string; icon: string }> = {
  first_class: { label: 'First class', tone: 'navy', icon: 'sparkle' },
  no_waiver: { label: 'No waiver', tone: 'danger', icon: 'doc' },
  injury: { label: 'Injury', tone: 'warn', icon: 'injury' },
  birthday: { label: 'Birthday', tone: 'cream', icon: 'cake' },
  last_credit: { label: 'Last credit', tone: 'warn', icon: 'ticket' },
  pass_expiring: { label: 'Pass expiring', tone: 'warn', icon: 'clock' },
};
const FLAG_ORDER: Flag[] = ['no_waiver', 'injury', 'first_class', 'birthday', 'last_credit', 'pass_expiring'];

export function passLabel(e: { pass?: Pass; passId?: string; status: Booking['status'] }): string {
  const p = e.pass;
  if (!p) return e.status === 'waitlisted' ? 'No credit taken yet' : 'Comp · no credit';
  if (p.credits == null) return p.name;
  if (p.kind === 'membership') return `${p.name}`;
  return `${p.name} · ${Math.max(0, p.credits - p.creditsUsed)} left`;
}

const ATTENDING = new Set(['booked', 'checked_in']);
const STATUS_LABEL: Record<string, string> = { cancelled: 'Cancelled', late_cancelled: 'Late cancel', no_show: 'No-show', removed: 'Removed' };

export function Roster({ id }: { id: string }) {
  const { me, can, staffById, typeById, settings } = useStudio();
  const snack = useSnack();
  const toast = useToast();
  const now = useNow(20000);
  const sess = useData(() => store.getSession(id), [id]);
  const roster = useData(() => store.getRoster(id), [id]);
  const [pending, setPending] = useState<Record<string, Booking['status']>>({});
  useEffect(() => setPending({}), [roster.data]);

  const [sheet, setSheet] = useState<null | 'add' | 'walkin' | 'edit' | 'cancel' | 'noshow' | 'menu' | 'restore'>(null);
  const undoSnack = useUndoSnack();
  const [detail, setDetail] = useState<RosterEntry | null>(null);
  const [injury, setInjury] = useState<RosterEntry | null>(null);
  const [waiverFor, setWaiverFor] = useState<RosterEntry | null>(null);
  const { busy, run } = useAction();

  const s = sess.data;
  const entries = (roster.data ?? []).map((e) => (pending[e.id] ? { ...e, status: pending[e.id]! } : e));
  const attending = useMemo(() => entries.filter((e) => ATTENDING.has(e.status)).sort((a, b) => fullName(a.client).localeCompare(fullName(b.client))), [entries]);
  const waitlist = entries.filter((e) => e.status === 'waitlisted').sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0));
  const notComing = entries.filter((e) => !ATTENDING.has(e.status) && e.status !== 'waitlisted');
  const checked = attending.filter((e) => e.status === 'checked_in').length;
  const stillBooked = attending.filter((e) => e.status === 'booked');

  if (sess.error) return <div className="card pad" style={{ marginTop: 40 }}><Empty title="Class not found"><a href="#/schedule">Back to the schedule</a></Empty></div>;
  if (!s) return <Loading />;
  const ct = typeById(s.classTypeId); const ins = staffById(s.instructorId);
  if (!can('allRosters') && s.instructorId !== me.staffId) {
    return <div className="card pad" style={{ marginTop: 40 }}><Empty title="Not your class">You can open the rosters for classes you teach. <a href="#/">Back to today</a></Empty></div>;
  }
  const started = now >= new Date(s.startsAt).getTime();
  const ended = now >= new Date(s.endsAt).getTime();
  const cancelled = s.status === 'cancelled';
  const isToday = studioDate(s.startsAt) === studioDate();
  // Back to wherever you opened the roster from (Today, the schedule, a client); else by the class date.
  const back = backFrom((r) => {
    if (r === '/') return 'Today';
    if (r === '/schedule/timetable') return 'Timetable';
    if (r.startsWith('/schedule')) return 'Schedule';
    if (r === '/clients') return 'Clients';
    const cm = match('/clients/:id', r);
    if (cm) return entries.find((e) => e.clientId === cm.id)?.client.firstName ?? 'Client';
    return null;
  }, isToday ? { href: '#/', label: 'Today' } : { href: `#/schedule/${weekStart(studioDate(s.startsAt))}`, label: 'Schedule' });

  const toggle = async (e: RosterEntry) => {
    const name = e.client.firstName;
    if (e.status === 'booked') {
      setPending((p) => ({ ...p, [e.id]: 'checked_in' }));
      const r = await run(() => store.checkIn(e.id));
      if (!r) { setPending((p) => { const n = { ...p }; delete n[e.id]; return n; }); return; }
      snack(`${name} checked in`, { label: 'Undo', run: () => { setPending((p) => ({ ...p, [e.id]: 'booked' })); run(() => store.undoCheckIn(e.id)); } });
    } else if (e.status === 'checked_in') {
      setPending((p) => ({ ...p, [e.id]: 'booked' }));
      const r = await run(() => store.undoCheckIn(e.id));
      if (!r) { setPending((p) => { const n = { ...p }; delete n[e.id]; return n; }); return; }
      snack(`${name} un-checked`);
    }
  };

  const markRest = async () => {
    const ids = stillBooked.map((e) => e.id);
    const ok = await run(async () => { for (const id of ids) await store.markNoShow(id); return true; });
    if (ok) {
      undoSnack(`${ids.length} marked as no-show`, store.undoNoShow && (async () => { for (const id of ids) await store.undoNoShow!(id); }), 'No-shows undone, everyone is booked again');
      setSheet(null);
    }
  };

  return (
    <div className="roster">
      <PageHead
        back={back}
        eyebrow={<>{dayLong(s.startsAt)}<Sep />{time(s.startsAt)} – {time(s.endsAt)}</>}
        title={<Accent text={ct?.name ?? 'Class'} />}
        sub={
          <div className="rs-sub">
            {ins && <Avatar name={ins.name} photo={ins.photoUrl} size={30} />}
            <span>with {ins?.name ?? 'no instructor'}{ins && ins.id === me.staffId ? ' (you)' : ''}</span>
            {s.note && <span className="chip">{s.note}</span>}
            {cancelled && <span className="chip danger">Cancelled{s.cancelReason ? ` · ${s.cancelReason}` : ''}</span>}
            {!cancelled && started && !ended && <span className="chip ok"><Flower size={11} spin className="live-fl" color="currentColor" />On now</span>}
            {!cancelled && ended && <span className="chip">Finished</span>}
          </div>
        }
        actions={cancelled ? (can('editClass') && store.restoreSession && !ended && <button className="btn" onClick={() => setSheet('restore')}><Icon name="undo" size={20} />Restore class</button>) : (
          <>
            {can('editClients') && can('pos') && <button className="btn soft" onClick={() => setSheet('walkin')}><Icon name="userPlus" size={20} />Walk-in</button>}
            <button className="btn" onClick={() => setSheet('add')}><Icon name="plus" size={20} />Add client</button>
            <button className="btn icon soft" onClick={() => setSheet('menu')} aria-label="Class actions"><Icon name="more" /></button>
          </>
        )}
      />
      <Slot name="roster.header" props={{ session: s }} can={can} />

      {!cancelled && (
        <div className="rs-summary card">
          <div className="rs-big">
            <span className="rs-num">{checked}<span>/{attending.length}</span></span>
            <span className="rs-lab">checked in</span>
          </div>
          <div className="rs-bar"><Fill value={checked} max={Math.max(attending.length, 1)} /></div>
          <div className="rs-facts">
            <div><strong>{s.bookedCount}/{s.capacity}</strong><span>booked</span></div>
            <div><strong>{Math.max(0, s.capacity - s.bookedCount)}</strong><span>spots left</span></div>
            <div><strong>{waitlist.length}</strong><span>waitlist</span></div>
          </div>
          {started && stillBooked.length > 0 && (
            <button className="btn sm ghost rs-noshow" onClick={() => setSheet('noshow')}>Mark rest as no-show ({stillBooked.length})</button>
          )}
        </div>
      )}

      {roster.loading && !roster.data ? <Loading /> : (
        <>
          <section className="rs-sec">
            {attending.length === 0 ? (
              <div className="card"><Empty title={cancelled ? 'This class was cancelled' : 'No one booked in yet'}>{cancelled ? 'Everyone was removed and their credits returned.' : 'Tap “Add client” to book someone in.'}</Empty></div>
            ) : (
              <div className="rlist">
                {attending.map((e) => (
                  <RosterRow key={e.id} e={e} s={s} onToggle={() => toggle(e)} onOpen={() => setDetail(e)} onInjury={() => setInjury(e)} onWaiver={() => setWaiverFor(e)} disabled={cancelled} />
                ))}
              </div>
            )}
          </section>

          {waitlist.length > 0 && (
            <section className="rs-sec">
              <div className="sec-head"><h3>Waitlist <span className="count">{waitlist.length}</span></h3><span className="muted small">Auto-books in order until {settings.waitlistCutoffHours} hr before class</span></div>
              <div className="rlist">
                {waitlist.map((e, i) => (
                  <div key={e.id} className="rrow wl">
                    <button className="rr-who" onClick={() => setDetail(e)}>
                      <span className="wl-pos">{i + 1}</span>
                      <Avatar name={fullName(e.client)} photo={e.client.photoUrl} size={44} />
                      <span className="rr-t"><strong>{fullName(e.client)}</strong><span>Joined {time(e.createdAt)}</span></span>
                    </button>
                    <button className="btn sm soft" onClick={() => setDetail(e)}>Options</button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {notComing.length > 0 && (
            <details className="rs-sec not-coming">
              <summary><span>Not coming</span><span className="count">{notComing.length}</span><Icon name="down" size={18} /></summary>
              <div className="rlist">
                {notComing.map((e) => (
                  <div key={e.id} className="rrow muted-row">
                    <a className="rr-who" href={`#/clients/${e.clientId}`}>
                      <Avatar name={fullName(e.client)} photo={e.client.photoUrl} size={40} />
                      <span className="rr-t"><strong>{fullName(e.client)}</strong><span>{passLabel(e)}</span></span>
                    </a>
                    <span className={cx('chip', e.status === 'cancelled' || e.status === 'removed' ? '' : 'warn')}>{STATUS_LABEL[e.status] ?? e.status}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      <AddClientSheet open={sheet === 'add'} onClose={() => setSheet(null)} session={s} exclude={entries.filter((e) => ATTENDING.has(e.status) || e.status === 'waitlisted').map((e) => e.clientId)} />
      <WalkInSheet open={sheet === 'walkin'} onClose={() => setSheet(null)} session={s} />
      {sheet === 'restore' && <RestoreClassSheet s={s} onClose={() => setSheet(null)} />}
      <EditSessionSheet open={sheet === 'edit'} onClose={() => setSheet(null)} s={s} onBack={() => setSheet('menu')} />
      <CancelSessionSheet open={sheet === 'cancel'} onClose={() => setSheet(null)} s={s} count={attending.length + waitlist.length} onBack={() => setSheet('menu')} />
      <Confirm open={sheet === 'noshow'} onClose={() => setSheet(null)} title={<>Mark rest as <em>no-show</em>?</>} busy={busy} confirmLabel={`Mark ${stillBooked.length} as no-show`} onConfirm={markRest}
        body={`${stillBooked.map((e) => e.client.firstName).join(', ')} didn't check in. They'll lose the credit for this class${settings.noShowFeeCents ? ' and be charged the no-show fee' : ''}.`} />
      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} label="Class actions">
        <SheetHead title={<>Class <em>actions</em></>} onClose={() => setSheet(null)} />
        <div className="action-list">
          {can('editClass') && <button onClick={() => setSheet('edit')}><Icon name="edit" /><span><strong>Edit class</strong><span>Instructor cover, capacity, time or note</span></span></button>}
          <button onClick={() => setSheet('noshow')} disabled={stillBooked.length === 0}><Icon name="ban" /><span><strong>Mark rest as no-show</strong><span>{stillBooked.length ? `${stillBooked.length} not checked in` : 'Everyone is checked in'}</span></span></button>
          {can('editClass') && <button className="danger" onClick={() => setSheet('cancel')}><Icon name="x" /><span><strong>Cancel class</strong><span>Removes everyone and returns their credits</span></span></button>}
        </div>
      </Sheet>

      {detail && <EntrySheet e={detail} s={s} onClose={() => setDetail(null)} onWaiver={() => { setWaiverFor(detail); setDetail(null); }} onToggle={() => { toggle(detail); setDetail(null); }} />}
      <Sheet open={!!injury} onClose={() => setInjury(null)} label="Injury notes">
        {injury && <>
          <SheetHead title={<>{injury.client.firstName}'s <em>notes</em></>} onClose={() => setInjury(null)} />
          <div className="injury-box"><Icon name="injury" size={22} /><p>{injury.client.injuries || injury.client.healthForm?.injuries || 'No details recorded.'}</p></div>
          {injury.client.healthForm?.pregnantOrPostnatal && <p className="chip cream" style={{ marginTop: 12 }}>Pregnant or postnatal</p>}
          <div className="sh-foot"><a className="btn soft" href={`#/clients/${injury.clientId}`} onClick={(ev) => goFromSheet(ev, `#/clients/${injury.clientId}`)}>View profile</a><button className="btn" onClick={() => setInjury(null)}>Got it</button></div>
        </>}
      </Sheet>
      {waiverFor && <WaiverSheet open onClose={() => setWaiverFor(null)} client={waiverFor.client} />}
    </div>
  );
}

function RosterRow({ e, s, onToggle, onOpen, onInjury, onWaiver, disabled }: { e: RosterEntry; s: SessionWithCounts; onToggle: () => void; onOpen: () => void; onInjury: () => void; onWaiver: () => void; disabled?: boolean }) {
  const inn = e.status === 'checked_in';
  const flags = FLAG_ORDER.filter((f) => e.flags.includes(f));
  return (
    <div className={cx('rrow', inn && 'in')}>
      <button className="rr-who" onClick={onOpen} aria-label={`${fullName(e.client)} options`}>
        <Avatar name={fullName(e.client)} photo={e.client.photoUrl} size={52} />
        <span className="rr-t"><strong>{fullName(e.client)}</strong><span>{passLabel(e)}</span></span>
      </button>
      <div className="rr-flags">
        {flags.map((f) => {
          const F = FLAG[f];
          const click = f === 'injury' ? onInjury : f === 'no_waiver' ? onWaiver : onOpen;
          return <button key={f} className={cx('chip', 'flag', F.tone)} onClick={click}><Icon name={F.icon} size={15} />{F.label}</button>;
        })}
        <Slot name="roster.entry" props={{ entry: e, session: s }} />
      </div>
      <button className={cx('ci', inn && 'on')} onClick={onToggle} disabled={disabled} aria-pressed={inn} aria-label={inn ? `Undo check-in for ${e.client.firstName}` : `Check in ${e.client.firstName}`}>
        <span className="ci-circle"><Icon name="check" size={26} /></span>
        <span className="ci-l">{inn ? (e.checkedInAt ? time(e.checkedInAt) : 'In') : 'Check in'}</span>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ one booking: actions
function EntrySheet({ e, s, onClose, onWaiver, onToggle }: { e: RosterEntry; s: SessionWithCounts; onClose: () => void; onWaiver: () => void; onToggle: () => void }) {
  const { settings, can } = useStudio();
  const toast = useToast();
  const undoSnack = useUndoSnack();
  const [view, setView] = useState<'main' | 'cancel' | 'move' | 'promote'>('main');
  const [waive, setWaive] = useState(false);
  const [comp, setComp] = useState(false);
  const { busy, run } = useAction();
  const late = Date.now() > new Date(s.startsAt).getTime() - settings.cancelWindowHours * 3600e3;
  const name = e.client.firstName;
  const wl = e.status === 'waitlisted';
  // cancel / move / book-in are steps inside the sheet: back (pill, button or gesture) returns to the options
  useBackHandler(view !== 'main', () => setView('main'));

  const done = (msg: string) => { toast(msg); onClose(); };
  // These three show an Undo snack for 10 seconds; undo reverses them exactly (credit, spot and waitlist place).
  const noShow = async () => {
    if (!(await run(() => store.markNoShow(e.id)))) return;
    undoSnack(`${name} marked as no-show`, store.undoNoShow && (() => store.undoNoShow!(e.id)), `${name} is booked again`);
    onClose();
  };
  const cancel = async () => {
    const r = await run(() => store.cancelBooking(e.id, { asStaff: true, waivePenalty: waive }));
    if (!r) return;
    undoSnack(r.creditReturned ? `${name}'s booking cancelled, credit returned` : `${name} late-cancelled, credit used`,
      store.undoCancelBooking && (() => store.undoCancelBooking!(e.id, r.promoted ? { demotePromotedId: r.promoted.id } : {})), `${name} is back in the class`);
    onClose();
  };
  const leave = async () => {
    if (!(await run(() => store.leaveWaitlist(e.id)))) return;
    undoSnack(`${name} removed from the waitlist`, store.undoCancelBooking && (() => store.undoCancelBooking!(e.id)), `${name} is back on the waitlist`);
    onClose();
  };
  const promote = async () => {
    const r = await run(async () => {
      await store.leaveWaitlist(e.id);
      try { return await store.bookClass(e.clientId, s.id, { asStaff: true, allowOverCapacity: true, skipCredit: comp }); }
      catch (x) { await store.bookClass(e.clientId, s.id, { asStaff: true }).catch(() => undefined); throw x; }
    });
    if (r) done(`${name} is booked in`);
  };
  const move = async (to: SessionWithCounts) => {
    const r = await run(async () => {
      if (store.moveBooking) return store.moveBooking(e.id, to.id);
      await store.cancelBooking(e.id, { asStaff: true, waivePenalty: true });
      return store.bookClass(e.clientId, to.id, { asStaff: true, allowOverCapacity: true });
    });
    if (r) done(`${name} moved to ${time(to.startsAt)}`);
  };

  return (
    <Sheet open onClose={onClose} label={fullName(e.client)}>
      <SheetHead title={view === 'main' ? fullName(e.client) : view === 'cancel' ? <>Cancel <em>booking</em></> : view === 'move' ? <>Move <em>{name}</em></> : <>Book <em>{name}</em> in</>}
        sub={view === 'main' ? (wl ? `Waitlist position ${e.waitlistPosition ?? ''}` : passLabel(e)) : fullName(e.client)}
        back={view === 'main' ? undefined : { label: name, onClick: () => setView('main') }} onClose={onClose} />
      {view === 'main' && (
        <>
          {e.flags.length > 0 && (
            <div className="flag-detail">
              {FLAG_ORDER.filter((f) => e.flags.includes(f)).map((f) => (
                <div key={f} className={cx('fd', FLAG[f].tone)}><Icon name={FLAG[f].icon} size={18} />
                  <span><strong>{FLAG[f].label}</strong>
                    {f === 'injury' && <span>{e.client.injuries || e.client.healthForm?.injuries}</span>}
                    {f === 'first_class' && <span>Give them a warm welcome and a quick intro to the studio.</span>}
                    {f === 'no_waiver' && <span>Ask them to sign before class.</span>}
                    {f === 'birthday' && <span>Birthday this week{e.client.birthday ? ` (${new Date(e.client.birthday + 'T00:00:00').toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' })})` : ''}.</span>}
                    {f === 'last_credit' && <span>This is the last credit on their pack. A good moment to mention a new one.</span>}
                    {f === 'pass_expiring' && <span>Their pass expires {e.pass?.expiresAt ? `on ${new Date(e.pass.expiresAt).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'within 7 days'}.</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="action-list">
            {!wl && <button onClick={onToggle}><Icon name={e.status === 'checked_in' ? 'undo' : 'check'} /><span><strong>{e.status === 'checked_in' ? 'Undo check-in' : 'Check in'}</strong></span></button>}
            {e.status === 'booked' && <button onClick={noShow} disabled={busy}><Icon name="ban" /><span><strong>Mark no-show</strong><span>Credit is used{settings.noShowFeeCents ? ', fee applies' : ''}</span></span></button>}
            {!wl && e.status !== 'checked_in' && <button onClick={() => setView('cancel')}><Icon name="x" /><span><strong>Cancel booking</strong><span>{late ? 'Inside the cancel window (late cancel)' : 'Credit goes back to their pass'}</span></span></button>}
            {e.status === 'booked' && <button onClick={() => setView('move')}><Icon name="move" /><span><strong>Move to another class</strong><span>The credit moves with them</span></span></button>}
            {wl && <button onClick={() => setView('promote')}><Icon name="plus" /><span><strong>Book in now</strong><span>Squeeze them in ahead of the waitlist</span></span></button>}
            {wl && <button onClick={leave} disabled={busy}><Icon name="x" /><span><strong>Remove from waitlist</strong><span>No penalty</span></span></button>}
            {!e.client.waiverSignedAt && can('waiver') && <button onClick={onWaiver}><Icon name="doc" /><span><strong>Record waiver</strong><span>Signed in person today</span></span></button>}
            <a href={`#/clients/${e.clientId}`} onClick={(ev) => goFromSheet(ev, `#/clients/${e.clientId}`)}><Icon name="users" /><span><strong>View profile</strong><span>{e.client.email}</span></span></a>
          </div>
        </>
      )}
      {view === 'cancel' && (
        <div className="stack">
          <p className="muted">{late
            ? `It's within ${settings.cancelWindowHours} hours of class, so this counts as a late cancel and ${name} loses the credit${settings.lateCancelFeeCents ? ' and pays the late fee' : ''}.`
            : `It's more than ${settings.cancelWindowHours} hours before class, so ${name} gets the credit back.`}</p>
          {late && (
            <label className="check squeeze"><input type="checkbox" checked={waive} onChange={(x) => setWaive(x.target.checked)} />
              <span><strong>Waive the penalty</strong><br /><span className="muted small">Return the credit and record it as a normal cancel</span></span></label>
          )}
          <div className="sh-foot"><button className="btn ghost" onClick={() => setView('main')}>Back</button><button className="btn danger-solid" onClick={cancel} disabled={busy}>{late && !waive ? 'Late cancel' : 'Cancel booking'}</button></div>
        </div>
      )}
      {view === 'move' && (
        <div>
          <SessionPicker excludeId={s.id} onPick={move} title="Move to" noFull clientId={e.clientId} />
          <div className="sh-foot"><button className="btn ghost" onClick={() => setView('main')}>Back</button></div>
        </div>
      )}
      {view === 'promote' && (
        <div className="stack">
          <p className="muted">Book {name} in now, even if the class is full.</p>
          <label className={cx('opt', !comp && 'on')}><input type="radio" checked={!comp} onChange={() => setComp(false)} /><span className="opt-t"><strong>Use their credit</strong><span>Takes 1 credit from their best pass</span></span></label>
          {can('pos') && <label className={cx('opt', comp && 'on')}><input type="radio" checked={comp} onChange={() => setComp(true)} /><span className="opt-t"><strong>Comp, no credit</strong><span>Nothing is taken from their passes</span></span></label>}
          <div className="sh-foot"><button className="btn ghost" onClick={() => setView('main')}>Back</button><button className="btn" onClick={promote} disabled={busy}>Book in</button></div>
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ class edit / cancel
export function EditSessionSheet({ open, onClose, s, onBack }: { open: boolean; onClose: () => void; s: SessionWithCounts; onBack?: () => void }) {
  const { staff, typeById } = useStudio();
  const [date, setDate] = useState(''); const [hhmm, setHhmm] = useState('');
  const [instructorId, setIns] = useState(''); const [cap, setCap] = useState(''); const [note, setNote] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    if (!open) return;
    setDate(studioDate(s.startsAt));
    setHhmm(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.startsAt)));
    setIns(s.instructorId); setCap(String(s.capacity)); setNote(s.note ?? '');
  }, [open, s]);
  const save = async () => {
    const dur = new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime();
    const startsAt = studioToUTC(date, hhmm);
    const r = await run(() => store.upsertSession({
      id: s.id, classTypeId: s.classTypeId, templateId: s.templateId, status: s.status, cancelReason: s.cancelReason,
      startsAt, endsAt: new Date(new Date(startsAt).getTime() + dur).toISOString(), instructorId, capacity: Math.max(1, parseInt(cap) || 1), note: note.trim() || undefined,
    }), 'Class updated');
    if (r) onClose();
  };
  const teachers = staff.filter((x) => x.active || x.id === s.instructorId);
  return (
    <Sheet open={open} onClose={onClose} label="Edit class">
      <SheetHead title={<>Edit <em>class</em></>} sub={`${typeById(s.classTypeId)?.name}. Changes apply to this class only.`} onClose={onClose} back={onBack && { label: 'Class actions', onClick: onBack }} />
      <div className="form-grid">
        <label className="field"><span>Date</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span>Start time</span><input className="input" type="time" value={hhmm} onChange={(e) => setHhmm(e.target.value)} /></label>
        <label className="field"><span>Instructor (cover)</span>
          <select className="select" value={instructorId} onChange={(e) => setIns(e.target.value)}>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <label className="field"><span>Capacity</span><input className="input" type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <label className="field span2"><span>Note on the timetable</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bring a towel" /></label>
      </div>
      {parseInt(cap) < s.bookedCount && <p className="note warn" style={{ marginTop: 14 }}><Icon name="alert" size={18} />{s.bookedCount} people are already booked. No one is removed, but the class will show as over capacity.</p>}
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>Save changes</button></div>
    </Sheet>
  );
}

function CancelSessionSheet({ open, onClose, s, count, onBack }: { open: boolean; onClose: () => void; s: SessionWithCounts; count: number; onBack?: () => void }) {
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => { if (open) { setReason(''); setSure(false); } }, [open]);
  const go = async () => {
    const r = await run(async () => { await store.cancelSession(s.id, reason.trim()); return true; }, 'Class cancelled. Clients have been notified.');
    if (r) onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} label="Cancel class">
      <SheetHead title={<>Cancel this <em>class</em>?</>} sub={`${time(s.startsAt)} ${dayLong(s.startsAt)}`} onClose={onClose} back={onBack && { label: 'Class actions', onClick: onBack }} />
      <p className="muted">{count ? `${count} ${count === 1 ? 'person' : 'people'} will be removed, get their credit back and be told by email or push.` : 'No one is booked in yet.'}</p>
      <label className="field" style={{ marginTop: 16 }}><span>Reason (shown to clients)</span>
        <textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Instructor unwell, sorry!" />
      </label>
      <label className="check" style={{ marginTop: 14 }}><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /><span>Yes, cancel the class</span></label>
      <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Keep class</button><button className="btn danger-solid" disabled={!sure || !reason.trim() || busy} onClick={go}>Cancel class</button></div>
    </Sheet>
  );
}
