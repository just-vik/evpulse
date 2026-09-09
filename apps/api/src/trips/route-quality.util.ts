export type RouteQuality = 'HIGH' | 'MEDIUM' | 'PARTIAL' | 'LOW' | 'UNAVAILABLE';

export interface RouteQualityInput {
  /** Real (non-interpolated, non-null) GPS fixes available for this trip. */
  rawGpsPointsCount: number;
  /** How many segments were only formed by bridging an isolated fix to a neighbor. */
  singletonBridgesCount: number;
  /** Largest gap (seconds) between consecutive real GPS fixes. */
  largestGapSeconds: number;
  /** % of the matched route's distance covered by 2-point /route legs rather than a real /match trace. */
  reconstructedDistancePercent: number;
}

/**
 * Route geometry confidence — distinct from a trip's overall `reliability`
 * (which also factors in energy/SOC quality). A trip can have good energy
 * data but a road-network-guessed route, or vice versa.
 *
 * A 2-point OSRM /route call (used for bridged singletons, and for any
 * naturally sparse 2-point segment) is a plausible road path between two
 * real fixes, not a verified trace of where the car actually drove — so
 * any reliance on it caps quality at PARTIAL, regardless of how many total
 * points the trip has.
 */
export function resolveRouteQuality(input: RouteQualityInput): RouteQuality {
  if (input.rawGpsPointsCount < 3) {
    return 'UNAVAILABLE';
  }

  if (
    input.singletonBridgesCount > 0 ||
    input.largestGapSeconds > 120 ||
    input.reconstructedDistancePercent > 20
  ) {
    return 'PARTIAL';
  }

  if (input.rawGpsPointsCount >= 15 && input.largestGapSeconds <= 30) {
    return 'HIGH';
  }

  return 'MEDIUM';
}
