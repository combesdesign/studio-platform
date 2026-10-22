/** Partner bookings on the roster: a badge on each row, and a line above the list about the spots held for partners. */
import React, { useEffect, useState } from 'react';
import { store } from '../../../shared/react';
import type { ClassSession } from '../../../shared/types';
import { Icon } from '../../../studio/ui';
import { heldFor, heldSummary } from '../partners';
import { PARTNERS, PARTNER_LABEL, type PartnerBooking, type ReservedSpots } from '../types';

// One fetch per class, shared by every row on the roster, dropped whenever the store changes.
const cache = new Map<string, Promise<PartnerBooking[]>>();
let reservedCache: Promise<ReservedSpots[]> | null = null;
if (typeof window !== 'undefined') store.subscribe(() => { cache.clear(); reservedCache = null; });

function useShared<T>(load: () => Promise<T>, key: string): T | undefined {
  const [v, setV] = useState<T>();
  const [tick, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), []);
  useEffect(() => { let live = true; load().then((x) => { if (live) setV(x); }, () => { /* no access: no badge */ }); return () => { live = false; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return v;
}
const bookingsOf = (sessionId: string) => {
  const api = store.features.integrations;
  if (!api) return Promise.resolve([] as PartnerBooking[]);
  let p = cache.get(sessionId);
  if (!p) { p = api.partnerBookings(sessionId); cache.set(sessionId, p); }
  return p;
};
const reservedAll = () => (reservedCache ??= store.features.integrations ? store.features.integrations.listReserved() : Promise.resolve([] as ReservedSpots[]));

export function PartnerChip({ bookingId, sessionId }: { bookingId: string; sessionId: string }) {
  const list = useShared(() => bookingsOf(sessionId), sessionId);
  const pb = list?.find((b) => b.bookingId === bookingId);
  if (!pb) return null;
  return <span className="chip cream ig-badge" title={`Booked through ${PARTNER_LABEL[pb.source]}. No pass is used.`}><Icon name="ticket" size={14} />{PARTNER_LABEL[pb.source]}</span>;
}

export function PartnerHeld({ session }: { session: Pick<ClassSession, 'id' | 'classTypeId'> }) {
  const list = useShared(() => bookingsOf(session.id), session.id);
  const reserved = useShared(reservedAll, 'reserved');
  if (!list || !reserved) return null;
  const lines = PARTNERS.map((p) => ({ p, held: heldFor(reserved, session.classTypeId, p), used: list.filter((b) => b.source === p).length })).filter((x) => x.held > 0 || x.used > 0);
  if (!lines.length) return null;
  return (
    <p className="ig-held muted" role="note">
      <Icon name="ticket" size={16} />
      {lines.map((l) => heldSummary(PARTNER_LABEL[l.p], l.held, l.used)).join(' · ')}
    </p>
  );
}
