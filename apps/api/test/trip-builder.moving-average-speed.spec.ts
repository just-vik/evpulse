import {
  BufferedPoint,
  calculateMovingDistanceKm,
  calculateMovingAverageSpeed,
  haversineKm,
} from '../src/trips/trip-builder.service';

/**
 * Regression tests for the P1.1 avgSpeed fix (Oct 2026 telemetry audit, commit
 * "align average speed with moving segments"). TripStats.avgSpeed used to be a plain
 * mean(speed samples) — unweighted by time, biased toward whichever driving regime
 * sends denser samples. It's now movingDistanceKm / movingHours, where both halves
 * share the exact segment definition addPoint() already uses for movingMs: real
 * (non-interpolated) points, ≤60s apart, speed > 5 km/h at the end of the segment.
 *
 * calculateMovingDistanceKm's whole job is picking the *same* segments movingMs
 * picks — the arithmetic (calculateMovingAverageSpeed) is trivial by comparison and
 * tested separately so geometry bugs and arithmetic bugs can't hide each other.
 */

const LON = 8.6;
const BASE_TIME = new Date('2026-05-01T10:00:00.000Z');

function pt(opts: { tSec: number; lat: number; speed: number; interpolated?: boolean }): BufferedPoint {
  return {
    timestamp: new Date(BASE_TIME.getTime() + opts.tSec * 1000),
    speed: opts.speed,
    power: null,
    soc: null,
    latitude: opts.lat,
    longitude: LON,
    elevationM: null,
    interpolated: opts.interpolated ?? false,
  };
}

describe('calculateMovingAverageSpeed — pure arithmetic', () => {
  it('100 km / 2h moving → 50 km/h', () => {
    expect(calculateMovingAverageSpeed(100, 2 * 3_600_000)).toBeCloseTo(50, 6);
  });

  it('100 km / 1h moving → 100 km/h', () => {
    expect(calculateMovingAverageSpeed(100, 1 * 3_600_000)).toBeCloseTo(100, 6);
  });

  it('0 km moving distance → null', () => {
    expect(calculateMovingAverageSpeed(0, 3_600_000)).toBeNull();
  });

  it('movingMs = 0 → null', () => {
    expect(calculateMovingAverageSpeed(100, 0)).toBeNull();
  });

  it('negative/invalid duration or distance → null', () => {
    expect(calculateMovingAverageSpeed(100, -1_000)).toBeNull();
    expect(calculateMovingAverageSpeed(-5, 3_600_000)).toBeNull();
    expect(calculateMovingAverageSpeed(-5, -1_000)).toBeNull();
  });

  it('regression: total trip spans 2h but only 1.5h was moving → 66.67 km/h, not diluted by the stopped 30min', () => {
    // movingDistanceKm here is ONLY the distance covered during moving segments
    // (never the whole-trip distanceKm) — that's what makes this different from the
    // old mean(speed) formula, which stops no longer dilute, and from a naive
    // distance/totalElapsedTime, which stops WOULD dilute.
    expect(calculateMovingAverageSpeed(100, 1.5 * 3_600_000)).toBeCloseTo(66.67, 1);
  });
});

describe('calculateMovingDistanceKm — segment selection', () => {
  it('short gap (≤60s), moving at the end → segment counted', () => {
    const points = [
      pt({ tSec: 0,  lat: 50.000, speed: 40 }),
      pt({ tSec: 30, lat: 50.002, speed: 45 }),
    ];
    const expected = haversineKm(50.000, LON, 50.002, LON);
    expect(calculateMovingDistanceKm(points)).toBeCloseTo(expected, 9);
    expect(expected).toBeGreaterThan(0); // sanity: the fixture actually moves
  });

  it('gap >60s between two real points → segment excluded entirely', () => {
    const points = [
      pt({ tSec: 0,  lat: 50.000, speed: 40 }),
      pt({ tSec: 90, lat: 50.002, speed: 45 }), // 90s > 60s cap
    ];
    expect(calculateMovingDistanceKm(points)).toBe(0);
  });

  it('interpolated 60s–5min gap: synthetic points never contribute distance, real↔interpolated pairs excluded too', () => {
    // Mirrors what addPoint() actually inserts for a 2-minute gap: last real point,
    // three synthetic 10s-spaced interpolated points, then the next real point.
    const points = [
      pt({ tSec: 0,   lat: 50.000,  speed: 40 }),
      pt({ tSec: 10,  lat: 50.0003, speed: 42, interpolated: true }),
      pt({ tSec: 60,  lat: 50.001,  speed: 44, interpolated: true }),
      pt({ tSec: 110, lat: 50.0017, speed: 46, interpolated: true }),
      pt({ tSec: 120, lat: 50.002,  speed: 45 }),
    ];
    // Every consecutive pair touches at least one interpolated point (there is no
    // real→real pair in this sequence at all — the real points aren't adjacent).
    expect(calculateMovingDistanceKm(points)).toBe(0);
  });

  it('long real gap (>5min, no interpolation) → the spanning segment is excluded, not counted as one big jump', () => {
    const points = [
      pt({ tSec: 0,   lat: 50.00, speed: 40 }),
      pt({ tSec: 700, lat: 50.10, speed: 45 }), // 11m40s gap, no synthetic points
    ];
    expect(calculateMovingDistanceKm(points)).toBe(0);
  });

  it('stopped segment (speed ≤ 5 at the end) → excluded even though the gap is short', () => {
    const points = [
      pt({ tSec: 0,  lat: 50.0000, speed: 40 }),
      pt({ tSec: 20, lat: 50.0005, speed: 3 }), // dt=20s ok, but curr.speed=3 ≤ 5
    ];
    expect(calculateMovingDistanceKm(points)).toBe(0);
  });

  it('exactly at the speed threshold (speed = 5) → excluded (strictly > 5 required, matching addPoint\'s `stopped = speed <= 5`)', () => {
    const points = [
      pt({ tSec: 0,  lat: 50.0000, speed: 40 }),
      pt({ tSec: 20, lat: 50.0005, speed: 5 }),
    ];
    expect(calculateMovingDistanceKm(points)).toBe(0);
  });

  it('mixed trip: drive → stop → drive → telemetry gap → drive — only the two real driving segments count', () => {
    const points = [
      pt({ tSec: 0,   lat: 50.000,  speed: 40 }), // drive start
      pt({ tSec: 20,  lat: 50.002,  speed: 42 }), // +20s driving → counted (A→B)
      pt({ tSec: 40,  lat: 50.0025, speed: 2 }),  // stopped → B→C excluded (speed≤5)
      pt({ tSec: 70,  lat: 50.0026, speed: 1 }),  // still stopped, and dt=30s but speed≤5 → C→D excluded
      pt({ tSec: 90,  lat: 50.004,  speed: 38 }), // moving again → dt=20s, speed=38 → D→E counted
      pt({ tSec: 95,  lat: 50.0042, speed: 10, interpolated: true }), // interpolated gap-filler → E→F excluded
      pt({ tSec: 220, lat: 50.010,  speed: 50 }), // real point after gap → F→G excluded (touches interpolated)
    ];
    const segAB = haversineKm(50.000, LON, 50.002, LON);
    const segDE = haversineKm(50.0026, LON, 50.004, LON);
    expect(calculateMovingDistanceKm(points)).toBeCloseTo(segAB + segDE, 9);
  });

  it('end-to-end: mixed trip distance/time fed through calculateMovingAverageSpeed yields a plausible city-driving speed, not inflated by the excluded stop/gap', () => {
    const points = [
      pt({ tSec: 0,   lat: 50.000,  speed: 40 }),
      pt({ tSec: 20,  lat: 50.002,  speed: 42 }),
      pt({ tSec: 40,  lat: 50.0025, speed: 2 }),
      pt({ tSec: 70,  lat: 50.0026, speed: 1 }),
      pt({ tSec: 90,  lat: 50.004,  speed: 38 }),
    ];
    const movingDistanceKm = calculateMovingDistanceKm(points);
    // What addPoint() would have accumulated into movingMs for this same sequence:
    // A→B (20s, moving), B→C (20s, but C.speed=2≤5 → stoppedMs not movingMs),
    // C→D (30s, stopped), D→E (20s, moving) → movingMs = 20s + 20s = 40s.
    const movingMs = 40_000;
    const avgSpeedKmh = calculateMovingAverageSpeed(movingDistanceKm, movingMs);
    expect(avgSpeedKmh).not.toBeNull();
    // Sanity bound only (exact value depends on the lat deltas above) — the point of
    // this test is that it doesn't blow up or go near the GPS-artifact range.
    expect(avgSpeedKmh!).toBeGreaterThan(0);
    expect(avgSpeedKmh!).toBeLessThan(160);
  });

  it('empty points array → 0', () => {
    expect(calculateMovingDistanceKm([])).toBe(0);
  });

  it('single point → 0 (no segment possible)', () => {
    expect(calculateMovingDistanceKm([pt({ tSec: 0, lat: 50, speed: 40 })])).toBe(0);
  });
});
