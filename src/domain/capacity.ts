/**
 * Spots a feature keeps back from DIRECT client bookings (e.g. spots held for ClassPass). Pure, shared by the demo
 * engine; the database does the same in app.held_back_spots (supabase/migrations/1703). The core never knows who holds
 * the spots: a feature registers a "held back" hook (DemoFeature.heldBack in the demo, app.register_capacity_hook in SQL)
 * and these helpers only take the number. Staff and the roster keep using the real capacity.
 */

/** True when a direct client can't take another spot: the class is full once the held-back spots are set aside. */
export function directFull(capacity: number, booked: number, heldBack: number): boolean {
  return booked >= capacity - Math.max(0, heldBack);
}

/** Spots a direct client sees: capacity, minus who's booked, minus the spots still held back. */
export function directSpotsLeft(capacity: number, booked: number, heldBack: number): number {
  return Math.max(0, capacity - booked - Math.max(0, heldBack));
}
