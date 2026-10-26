/** Partner spot rules. Pure functions: the demo store uses them, and the SQL in 1701_integrations_rpcs.sql does the same checks. */
import type { Partner, ReservedSpots } from './types';

export interface PartnerCheck {
  /** Class capacity and how many hold a spot (booked or checked in) right now. */
  capacity: number;
  booked: number;
  /** Spots held for this partner in this class type, and how many partner bookings are in the class already. */
  held: number;
  used: number;
  cancelled?: boolean;
  started?: boolean;
}

/** null when the partner may book; otherwise the error to give them ('CODE: friendly message'). */
export function partnerBookError(c: PartnerCheck): { code: string; message: string } | null {
  if (c.cancelled) return { code: 'CLASS_CANCELLED', message: 'This class has been cancelled.' };
  if (c.started) return { code: 'TOO_LATE', message: 'This class has already started.' };
  if (c.held <= 0) return { code: 'NO_PARTNER_SPOTS', message: 'No spots are held for this partner in that class.' };
  if (c.used >= c.held) return { code: 'NO_PARTNER_SPOTS', message: 'The spots held for this partner are all taken.' };
  if (c.booked >= c.capacity) return { code: 'CLASS_FULL', message: 'This class is full.' };
  return null;
}

export const heldFor = (reserved: ReservedSpots[], classTypeId: string, partner: Partner): number =>
  reserved.find((r) => r.classTypeId === classTypeId && r.partner === partner)?.spots ?? 0;

/** The webhook gets the class type's name from its id and the studio's setting; this is the roster header line. */
export function heldSummary(partner: string, held: number, used: number): string {
  return `${partner}: ${used} of ${held} held ${held === 1 ? 'spot' : 'spots'} booked`;
}

/** Spots still held for a partner (held minus its bookings already in the class): what direct clients can't take. */
export const unfilledHeld = (held: number, used: number): number => Math.max(0, held - used);
