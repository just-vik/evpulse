/**
 * Shared ML trip validation filter.
 *
 * Rejects trips that would corrupt ML models:
 *   - No efficiency data (null / 0)
 *   - Physically impossible efficiency (< 80 Wh/km or > 400 Wh/km)
 *   - Too short for meaningful statistics (< 5 km)
 *   - GPS-artifact speeds (> 160 km/h average — not real driving)
 *
 * Apply before any weighted average, regression, or baseline lock.
 */
export interface ValidatableTrip {
  efficiencyWhkm: number | null;
  distanceKm:     number | null;
  stats?:         { avgSpeed?: number | null } | null;
}

export function isValidTrip(t: ValidatableTrip): boolean {
  if (!t.efficiencyWhkm)             return false; // no data
  if (t.efficiencyWhkm < 80)         return false; // physically impossible for an EV
  if (t.efficiencyWhkm > 400)        return false; // extreme outlier (towing, sensor fault)
  if ((t.distanceKm ?? 0) < 5)       return false; // too short for reliable efficiency calc
  if ((t.stats?.avgSpeed ?? 0) > 160) return false; // GPS artifact / test track

  return true;
}
