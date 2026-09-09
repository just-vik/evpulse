/**
 * P0.1 — reject invalid OSRM geometry before persistence.
 *
 * P0 (map-matching.service.ts singleton bridging) fixed distance safety:
 * an OSRM result whose distance disagrees with the odometer reference is
 * never applied (see trip-post-processor's `osrmOk` gate). But nothing
 * validated the *geometry* itself — a matched/routed polyline can be
 * snapped onto a road network that doesn't cover the trip's actual region
 * (this OSRM instance only loads Hessen + a buffer). For a trip that left
 * that coverage (e.g. Liempde, NL → Düsseldorf), OSRM still returns
 * `code: 'Ok'` with a plausible-looking polyline — just snapped to the
 * nearest road it actually has data for, which can be 100+ km from where
 * the car really was. distanceKm was already guarded; the rendered route
 * line was not.
 *
 * This module is the single place that decides whether a matched polyline
 * is trustworthy enough to persist, based purely on whether its start/end
 * coordinates land near the trip's actual first/last valid GPS fix.
 * Deliberately self-contained (own decode/haversine, no imports from
 * map-matching.service.ts) — same pattern as route-quality.util.ts —
 * so it stays trivially unit-testable and has zero coupling to how the
 * polyline was produced.
 */

export type GeometryRejectionReason =
  | 'empty_polyline'
  | 'invalid_polyline'
  | 'start_endpoint_too_far'
  | 'end_endpoint_too_far';

export interface GeometryValidationResult {
  accepted: boolean;
  rejectionReason: GeometryRejectionReason | null;
  startEndpointErrorMeters: number | null;
  endEndpointErrorMeters: number | null;
  thresholdMeters: number;
}

export interface GeometryValidationInput {
  /** OSRM result polyline (Google polyline5 encoded), before persistence. */
  polyline: string;
  /** The trip's first coordinate-valid, jump-filtered GPS fix. */
  firstValidGpsPoint: { lat: number; lon: number };
  /** The trip's last coordinate-valid, jump-filtered GPS fix. */
  lastValidGpsPoint: { lat: number; lon: number };
  /**
   * True when the result relied on sparse GPS or a singleton bridge —
   * widens the acceptance threshold (300m → 500m) because a bridged leg's
   * road-network guess is inherently less precise at its shared boundary
   * point, not because sparse data deserves more trust.
   */
  isSparseOrBridged: boolean;
}

const DEFAULT_THRESHOLD_M = 300;
const SPARSE_THRESHOLD_M = 500;
/** Absolute ceiling regardless of sparse/bridged status — an error this
 *  large is not "imprecise GPS matching," it's a different road network
 *  entirely (out-of-coverage mis-snap), and must never be persisted. */
const HARD_REJECT_M = 1000;

export function validateOsrmGeometry(input: GeometryValidationInput): GeometryValidationResult {
  const thresholdMeters = input.isSparseOrBridged ? SPARSE_THRESHOLD_M : DEFAULT_THRESHOLD_M;

  if (!input.polyline || input.polyline.length === 0) {
    return { accepted: false, rejectionReason: 'empty_polyline', startEndpointErrorMeters: null, endEndpointErrorMeters: null, thresholdMeters };
  }

  const decoded = decodePolylineSafe(input.polyline);
  if (decoded.length < 2) {
    return { accepted: false, rejectionReason: 'invalid_polyline', startEndpointErrorMeters: null, endEndpointErrorMeters: null, thresholdMeters };
  }

  const [startLat, startLon] = decoded[0];
  const [endLat, endLon] = decoded[decoded.length - 1];

  const startEndpointErrorMeters = Math.round(
    haversineKm(startLat, startLon, input.firstValidGpsPoint.lat, input.firstValidGpsPoint.lon) * 1000,
  );
  const endEndpointErrorMeters = Math.round(
    haversineKm(endLat, endLon, input.lastValidGpsPoint.lat, input.lastValidGpsPoint.lon) * 1000,
  );

  // Hard ceiling first — an out-of-coverage mis-snap must reject regardless
  // of how the adaptive threshold would otherwise classify this trip.
  if (startEndpointErrorMeters > HARD_REJECT_M) {
    return { accepted: false, rejectionReason: 'start_endpoint_too_far', startEndpointErrorMeters, endEndpointErrorMeters, thresholdMeters };
  }
  if (endEndpointErrorMeters > HARD_REJECT_M) {
    return { accepted: false, rejectionReason: 'end_endpoint_too_far', startEndpointErrorMeters, endEndpointErrorMeters, thresholdMeters };
  }

  if (startEndpointErrorMeters > thresholdMeters) {
    return { accepted: false, rejectionReason: 'start_endpoint_too_far', startEndpointErrorMeters, endEndpointErrorMeters, thresholdMeters };
  }
  if (endEndpointErrorMeters > thresholdMeters) {
    return { accepted: false, rejectionReason: 'end_endpoint_too_far', startEndpointErrorMeters, endEndpointErrorMeters, thresholdMeters };
  }

  return { accepted: true, rejectionReason: null, startEndpointErrorMeters, endEndpointErrorMeters, thresholdMeters };
}

// ── Self-contained helpers (deliberately duplicated — see module docstring) ──

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodePolylineSafe(encoded: string): Array<[number, number]> {
  try {
    const points: Array<[number, number]> = [];
    let idx = 0, lat = 0, lng = 0;
    while (idx < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(idx++) - 63;
        if (idx > encoded.length + 1) throw new Error('malformed polyline');
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;
      shift = 0; result = 0;
      do {
        b = encoded.charCodeAt(idx++) - 63;
        if (idx > encoded.length + 1) throw new Error('malformed polyline');
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : result >> 1;
      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  } catch {
    return [];
  }
}
