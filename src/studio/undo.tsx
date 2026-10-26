import React, { useState } from 'react';
import { Sheet, errorMessage, store, useAction, useData, useToast } from '../shared/react';
import { money, studioDate, time } from '../shared/format';
import type { Sale } from '../shared/types';
import type { RestoreSessionResult, SessionWithCounts, VoidResult } from '../shared/store';
import { Icon, SheetHead, dayLong, useSnack } from './ui';

const METHOD: Record<string, string> = { card_online: 'card', card_reader: 'card reader', cash: 'cash', comp: 'comp', imported: 'imported' };

/** Can this sale still be voided from the desk? (The database makes the final call.) */
export function canVoidSale(s: Sale): boolean {
  return !!store.voidSale && !s.refundedAt && s.method !== 'card_online' && !s.stripePaymentIntentId && studioDate(s.createdAt) === studioDate();
}
export const wasVoided = (s: Sale) => /Refund: Voided/.test(s.note ?? '');

/** Shows a snack with an Undo button that runs `undo`, then says `back` (or the error). */
export function useUndoSnack() {
  const snack = useSnack();
  const toast = useToast();
  return (msg: string, undo?: () => Promise<unknown>, back = 'Undone') =>
    snack(msg, undo ? { label: 'Undo', run: () => { undo().then(() => toast(back), (e) => toast(errorMessage(e))); } } : undefined);
}

// ------------------------------------------------------------------ void a desk sale
/** What voiding will do, in plain English, built from the sale and the dry run. */
function describe(s: Sale, v: VoidResult, who?: string) {
  const items = s.items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ''}${i.name}`).join(', ');
  const lines: string[] = [];
  lines.push(`This takes the ${money(s.totalCents, { cents: true })} ${(METHOD[s.method] ?? s.method)} sale (${items}) out of today's takings, as if it never happened.`);
  for (const p of v.passes) lines.push(`${who ? `${who}'s ` : 'The '}${p.name} is cancelled. It hasn't been used for any classes.`);
  if (s.items.some((i) => i.productId && !v.passes.some((p) => p.name === i.name))) lines.push('Any retail items go back on the shelf, and any gift card or credit used on the sale gets its money back.');
  if (s.totalCents > 0) {
    lines.push(s.method === 'cash' ? `No cash moves in the app. If you've already taken ${money(s.totalCents, { cents: true })}, hand it back from the till.`
      : s.method === 'card_reader' ? 'The card reader isn\'t touched. If the payment already went through on the reader, reverse it there too.' : 'No money moves in the app.');
  }
  return lines;
}

export function VoidSaleSheet({ sale, clientName, onClose }: { sale: Sale; clientName?: string; onClose: (voided?: boolean) => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const dry = useData(() => store.voidSale!(sale.id, { dryRun: true }), [sale.id]);
  const v = dry.data;
  const go = async () => { if (await run(() => store.voidSale!(sale.id, { reason: reason.trim() || undefined }), 'Sale voided')) onClose(true); };
  return (
    <Sheet open onClose={() => onClose()} label="Void sale">
      <SheetHead title={<>Void this <em>sale</em>?</>} sub="For a sale made by mistake today" onClose={() => onClose()} />
      {!v && !dry.error && <p className="muted">Checking…</p>}
      {dry.error && <p className="note warn"><Icon name="alert" size={18} />{errorMessage(dry.error)}</p>}
      {v?.blocked && <p className="note warn"><Icon name="alert" size={18} />{v.blocked}</p>}
      {v && !v.blocked && (
        <div className="stack">
          <ul className="void-list">{describe(sale, v, clientName).map((l) => <li key={l}>{l}</li>)}</ul>
          <label className="field"><span>What went wrong? (optional)</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong client" /></label>
        </div>
      )}
      <div className="sh-foot">
        <button className="btn ghost" onClick={() => onClose()}>Keep the sale</button>
        <button className="btn danger-solid" onClick={go} disabled={busy || !v || !!v.blocked}>Void sale</button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ restore a cancelled class
export function RestoreClassSheet({ s, onClose }: { s: SessionWithCounts; onClose: () => void }) {
  const { busy, run } = useAction();
  const [res, setRes] = useState<RestoreSessionResult | null>(null);
  const go = async () => { const r = await run(() => store.restoreSession!(s.id)); if (r) setRes(r); };
  return (
    <Sheet open onClose={onClose} label="Restore class">
      <SheetHead title={<>Restore this <em>class</em>?</>} sub={`${time(s.startsAt)} ${dayLong(s.startsAt)}`} onClose={onClose} />
      {!res ? (
        <>
          <ul className="void-list">
            <li>The class goes back on the timetable.</li>
            <li>Everyone who was booked is put back in, and their credits are taken again.</li>
            <li>Anyone who has booked another class at that time, or has no credit left, isn't rebooked. You'll get a list so you can sort them out.</li>
            <li>People rebooked are emailed. The waitlist goes back in its old order.</li>
          </ul>
          <div className="sh-foot"><button className="btn ghost" onClick={onClose}>Not now</button><button className="btn" onClick={go} disabled={busy}>Restore class</button></div>
        </>
      ) : (
        <>
          <p className="muted">The class is back on. {res.restored.length ? `${res.restored.length} rebooked or back on the waitlist.` : ''}</p>
          {res.restored.length > 0 && <ul className="void-list ok">{res.restored.map((r) => <li key={r.bookingId}><strong>{r.name}</strong> {r.status === 'waitlisted' ? 'is back on the waitlist' : 'is booked in again'}</li>)}</ul>}
          {res.needsAttention.length > 0 && (
            <>
              <p className="note warn" style={{ marginTop: 12 }}><Icon name="alert" size={18} />{res.needsAttention.length} {res.needsAttention.length === 1 ? 'person needs' : 'people need'} you to sort them out.</p>
              <ul className="void-list">{res.needsAttention.map((r) => <li key={r.bookingId}><a href={`#/clients/${r.clientId}`}><strong>{r.name}</strong></a>: {r.reason}</li>)}</ul>
            </>
          )}
          <div className="sh-foot"><button className="btn" onClick={onClose}>Done</button></div>
        </>
      )}
    </Sheet>
  );
}
