/**
 * Pure, dependency-free classifier for Home's "Last trip" card.
 *
 * P1.2.1: `GET /trips/vehicle/:id?limit=1` returns the most recent trip row
 * regardless of completion state — an in-progress or not-yet-finalized trip
 * is a real, truthy row with null distanceKm/efficiencyWhkm, which must
 * never render as "— km · — Wh/km". This module distinguishes the real
 * states so Home can render each honestly instead of dashing out nulls.
 *
 * Blocker B (P1.2.1 review): deliberately does NOT decide whether backend
 * trip-finalization is "overdue" — that is a server-side lifecycle question
 * (apps/api/src/trips/trip-cleanup.service.ts owns the real 30-minute
 * watchdog SLA) and duplicating its threshold here would create a second,
 * driftable source of truth for the same rule. This classifier uses only
 * data availability: a trip is either fully finalized (real metrics) or not
 * yet (a single calm "still processing" state) — no elapsed-time math, no
 * vehicle-state guessing about why it isn't finalized yet.
 */

export interface LastTripRow {
  startTime: string;
  endTime: string | null;
  distanceKm: number | null;
  efficiencyWhkm: number | null;
}

export type LastTripState =
  | { kind: 'completed'; distanceKm: number; efficiencyWhkm: number; startTime: string }
  | { kind: 'processing'; startTime: string }
  | { kind: 'empty' };

export function classifyLastTrip(trip: LastTripRow | null): LastTripState {
  if (!trip) return { kind: 'empty' };

  if (trip.endTime != null && trip.distanceKm != null && trip.efficiencyWhkm != null) {
    return {
      kind: 'completed',
      distanceKm: trip.distanceKm,
      efficiencyWhkm: trip.efficiencyWhkm,
      startTime: trip.startTime,
    };
  }

  // Not yet fully finalized — whether that's because it's actively in
  // progress or because the backend watchdog hasn't closed it out yet is a
  // server-side lifecycle detail this client does not attempt to infer.
  return { kind: 'processing', startTime: trip.startTime };
}
