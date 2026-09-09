/**
 * P0.1 — reject invalid OSRM geometry before persistence.
 *
 * Root problem this closes: a trip whose route legitimately drove outside
 * this OSRM instance's loaded road network (Hessen + a buffer — real example
 * from production: Liempde, Netherlands → Lierenfeld/Düsseldorf) still gets
 * `code: 'Ok'` back from OSRM, with a polyline silently snapped onto the
 * nearest road it actually has data for — which can be 100+ km from where
 * the car really was. P0 already guarded distanceKm against this; nothing
 * guarded the rendered route geometry itself until now.
 */

import { validateOsrmGeometry } from '../src/trips/osrm-geometry-validation.util';

function encodePolyline(points: Array<[number, number]>): string {
  let out = '', prevLat = 0, prevLng = 0;
  const encodeValue = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode(((0x20 | (n & 0x1f)) + 63)); n >>= 5; }
    s += String.fromCharCode(n + 63);
    return s;
  };
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeValue(iLat - prevLat) + encodeValue(iLng - prevLng);
    prevLat = iLat; prevLng = iLng;
  }
  return out;
}

describe('validateOsrmGeometry', () => {
  it('accepts a matched geometry whose endpoints land within the dense-GPS threshold (300m)', () => {
    const polyline = encodePolyline([
      [50.121338, 8.523644], // start ≈ real fix
      [50.100000, 8.450000],
      [50.063600, 8.368700], // end ~10m from real fix
    ]);
    const result = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.063518, lon: 8.368649 },
      isSparseOrBridged: false,
    });
    expect(result.accepted).toBe(true);
    expect(result.rejectionReason).toBeNull();
    expect(result.thresholdMeters).toBe(300);
    expect(result.startEndpointErrorMeters).toBeLessThan(300);
    expect(result.endEndpointErrorMeters).toBeLessThan(300);
  });

  it('rejects when only the start endpoint exceeds the threshold', () => {
    const polyline = encodePolyline([
      [50.500000, 8.523644], // ~42km off from the real start fix
      [50.063518, 8.368649], // end matches exactly
    ]);
    const result = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.063518, lon: 8.368649 },
      isSparseOrBridged: false,
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBe('start_endpoint_too_far');
    expect(result.endEndpointErrorMeters).toBe(0);
    expect(result.startEndpointErrorMeters).toBeGreaterThan(1000);
  });

  it('rejects when only the end endpoint exceeds the threshold', () => {
    const polyline = encodePolyline([
      [50.121338, 8.523644], // start matches exactly
      [50.500000, 8.368649], // ~42km off from the real end fix
    ]);
    const result = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.063518, lon: 8.368649 },
      isSparseOrBridged: false,
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBe('end_endpoint_too_far');
    expect(result.startEndpointErrorMeters).toBe(0);
  });

  it('rejects a Liempde → Düsseldorf style out-of-coverage mis-snap (100+ km error)', () => {
    // Real production coordinates: trip actually ran Liempde (NL, ~51.55N 5.36E)
    // to Lierenfeld/Düsseldorf (~51.21N 6.82E); this OSRM instance (Hessen-only)
    // snapped both ends onto its own network, ~209km and ~101km away.
    const realStart = { lat: 51.555433, lon: 5.360755 };
    const realEnd   = { lat: 51.213245, lon: 6.824405 };
    // Simulated mis-snap into Hessen, roughly matching the magnitude actually
    // observed in production (209km / 101km).
    const misSnapStart: [number, number] = [50.100000, 8.700000];
    const misSnapEnd:   [number, number] = [50.300000, 8.500000];
    const polyline = encodePolyline([misSnapStart, misSnapEnd]);

    const result = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: realStart,
      lastValidGpsPoint: realEnd,
      isSparseOrBridged: false,
    });

    expect(result.accepted).toBe(false);
    expect(['start_endpoint_too_far', 'end_endpoint_too_far']).toContain(result.rejectionReason);
    expect(result.startEndpointErrorMeters).toBeGreaterThan(100_000); // > 100km
    expect(result.endEndpointErrorMeters).toBeGreaterThan(100_000);
  });

  it('hard-rejects past 1km even when the sparse/bridged threshold would otherwise allow more', () => {
    const polyline = encodePolyline([
      [50.121338, 8.523644],
      [50.130000, 8.530000], // ~1.2km off from the real end fix
    ]);
    const result = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      isSparseOrBridged: true, // would otherwise get the wider 500m threshold
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBe('end_endpoint_too_far');
    expect(result.thresholdMeters).toBe(500);
    expect(result.endEndpointErrorMeters).toBeGreaterThan(1000);
  });

  it('widens the threshold to 500m for sparse/bridged results, accepting what a dense trip would reject', () => {
    const polyline = encodePolyline([
      [50.121338, 8.523644],
      [50.124800, 8.527500], // ≈450m from the real end fix
    ]);
    const denseResult = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      isSparseOrBridged: false,
    });
    const sparseResult = validateOsrmGeometry({
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      isSparseOrBridged: true,
    });
    expect(denseResult.accepted).toBe(false);
    expect(denseResult.thresholdMeters).toBe(300);
    expect(sparseResult.accepted).toBe(true);
    expect(sparseResult.thresholdMeters).toBe(500);
  });

  it('rejects an empty polyline', () => {
    const result = validateOsrmGeometry({
      polyline: '',
      firstValidGpsPoint: { lat: 50.0, lon: 8.0 },
      lastValidGpsPoint: { lat: 50.1, lon: 8.1 },
      isSparseOrBridged: false,
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBe('empty_polyline');
    expect(result.startEndpointErrorMeters).toBeNull();
  });

  it('rejects a malformed/too-short polyline without throwing', () => {
    const result = validateOsrmGeometry({
      polyline: 'xyz',
      firstValidGpsPoint: { lat: 50.0, lon: 8.0 },
      lastValidGpsPoint: { lat: 50.1, lon: 8.1 },
      isSparseOrBridged: false,
    });
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBe('invalid_polyline');
  });

  it('is deterministic — identical input always produces identical output (idempotency guarantee)', () => {
    const polyline = encodePolyline([[50.121338, 8.523644], [50.063518, 8.368649]]);
    const input = {
      polyline,
      firstValidGpsPoint: { lat: 50.121338, lon: 8.523644 },
      lastValidGpsPoint: { lat: 50.063518, lon: 8.368649 },
      isSparseOrBridged: false,
    };
    expect(validateOsrmGeometry(input)).toEqual(validateOsrmGeometry(input));
  });
});
