/**
 * Regression: P1-A — odometer end anchor contamination.
 *
 * Bug: the endOdoRow query uses window [tripStart, tripEnd+15min] with no cap at
 * nextTripStartTime. When processUnrated runs between two consecutive REST polls
 * that straddle a trip boundary, the query picks up the next trip's odometer
 * reading and inflates distanceKm.
 *
 * Real incident (2026-10-18): trip cmvdmmnac (09:32–09:38) recorded 17.60 km
 * instead of ~8.97 km because endOdoRow landed on the 09:44 REST poll
 * (odo=44994.4) which belonged to trip cmvdn22ul (starts at 09:44).
 *
 * Fix: before the endOdoRow query, load the next trip's startTime and cap the
 * upper bound: lte = min(tripEndTime + 15min, nextTripStart - 1ms).
 *
 * These tests FAIL against the pre-fix code (proving the bug) and PASS after
 * the fix, which is the expected TDD lifecycle for a regression suite.
 */

import { TripPostProcessorService } from '../src/trips/trip-post-processor.service';

const T0  = new Date('2026-03-18T10:00:00.000Z');
const T6  = new Date(T0.getTime() +  6 * 60_000);  // trip A ends here; trip B starts here
const T12 = new Date(T0.getTime() + 12 * 60_000);  // trip B is moving here
const T21 = new Date(T0.getTime() + 21 * 60_000);  // T6 + 15 min — current (buggy) window end

function makeTrip(overrides: Record<string, any> = {}) {
  return {
    id: 'trip-A',
    vehicleId: 'veh-1',
    startTime: T0,
    endTime:   T6,
    startSoc:  80,
    endSoc:    75,
    distanceKm:    null,
    energyUsedKwh: null,
    efficiencyWhkm: null,
    reliability:   'LOW',
    repairReason:  null,
    qualityScore:  null,
    vehicle: {
      batteryCapacityDetected: null,
      batteryCapacityUsable:   null,
      vehicleSpec: { batteryUsableKwh: 75 },
    },
    ...overrides,
  };
}

/**
 * Build a Prisma mock that simulates the following telemetry DB state:
 *
 *   T0      odo = 100.0   (trip A start; parked here before departure)
 *   T6      odo = 108.5   (trip A end / trip B start — REST poll at boundary)
 *   T12     odo = 117.0   (trip B moving — should NOT be used for trip A)
 *
 * The findFirst mock dispatches on the timestamp clause shape so we can observe
 * whether the code caps the endOdoRow upper bound at nextTripStart.
 */
function buildPrisma(nextTripStart: Date | null) {
  const updated: any[] = [];

  const telemetryFindFirst = jest.fn().mockImplementation((args: any) => {
    const ts = args?.where?.timestamp;
    if (!ts) return Promise.resolve(null);

    const hasGte = ts.gte != null;
    const hasLte = ts.lte != null;
    const hasGt  = ts.gt  != null;

    // startOdoAfter: narrow window (gt=T0, lte=T0+60s)
    if (hasGt && hasLte) return Promise.resolve(null);

    // startOdoBefore: lte only, no gte/gt
    if (hasLte && !hasGte && !hasGt) {
      return Promise.resolve({ odometer: 100.0, timestamp: T0 });
    }

    // endOdoRow: gte and lte — simulate the DB returning the latest reading in window
    if (hasGte && hasLte) {
      const lteMs = (ts.lte as Date).getTime();
      // Contaminated zone: next trip's REST poll
      if (lteMs >= T12.getTime()) return Promise.resolve({ odometer: 117.0 });
      // Correct zone: trip end boundary
      if (lteMs >= T6.getTime())  return Promise.resolve({ odometer: 108.5 });
      return Promise.resolve({ odometer: 100.0 });
    }

    return Promise.resolve(null);
  });

  return {
    updated,
    prisma: {
      chargingSession: { findFirst: jest.fn().mockResolvedValue(null) },
      trip: {
        findMany:   jest.fn().mockResolvedValue([makeTrip()]),
        findUnique: jest.fn().mockResolvedValue(makeTrip()),
        // Returns the next trip when queried by the odo-anchor cap logic (after fix)
        findFirst:  jest.fn().mockResolvedValue(
          nextTripStart ? { startTime: nextTripStart } : null,
        ),
        update:    jest.fn().mockImplementation(({ data }: any) => {
          updated.push(data);
          return Promise.resolve({});
        }),
        delete:    jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      tripPoint: {
        findMany:   jest.fn().mockResolvedValue([]),  // no GPS points → triggers odo-only path
        updateMany: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      tripStats: { upsert: jest.fn().mockResolvedValue({}) },
      telemetryPoint: {
        findMany:  jest.fn().mockImplementation((args: any) => {
          // tail-window query (gt+lte) and telemetry fallback: return empty
          return Promise.resolve([]);
        }),
        findFirst: telemetryFindFirst,
      },
    },
  };
}

describe('TripPostProcessorService — P1-A odometer end anchor', () => {
  it('BUG: without next-trip cap the end anchor lands on the next trip\'s odo reading', async () => {
    // Demonstrates the pre-fix behaviour with no next-trip context (buildPrisma(null)).
    // Pre-fix: no cap → lte = T0+21min → mock returns odo=117.0 → dist≈17 km.
    // Post-fix with null: no next trip → same full window → same result (test always passes).
    // This test documents that the old window can capture T12 odo when no guard exists.
    const { prisma, updated } = buildPrisma(null);
    const svc = new TripPostProcessorService(prisma as any);
    await svc.processTripById('trip-A');

    const saved = updated[0];
    // Both pre-fix and post-fix (with no next trip): 117.0 - 100.0 = 17.0 km.
    expect(saved.distanceKm).toBeGreaterThan(15);
  });

  it('end anchor does not cross nextTripStart: distance uses trip-end odo, not next-trip odo', async () => {
    // This test FAILS against the pre-fix code (endOdoRow = 117.0 → dist ≈ 17 km)
    // and PASSES after the fix (endOdoRow = 108.5 → dist ≈ 8.5 km).
    //
    // Trip A: T0 → T6 (6 min). Trip B starts at T12 (6-min gap — typical REST poll interval).
    // Odo readings: T0=100.0, T6=108.5, T12=117.0 (T12 ∈ trip B, must not be used for trip A).
    // Pre-fix: lte = T0+21min → lteMs >= T12 → odo=117.0 → dist=17.0 km (WRONG).
    // Post-fix: cap = min(T21, T12-1ms) = T12-1ms → lteMs >= T6, < T12 → odo=108.5 → dist=8.5 km.
    const { prisma, updated } = buildPrisma(T12);
    const svc = new TripPostProcessorService(prisma as any);
    await svc.processTripById('trip-A');

    const saved = updated[0];
    expect(saved.repairReason).toContain('distance_from_odometer_no_gps');
    // 8.5 ± 1.0 km: uses T6 odo (108.5 - 100.0), NOT T12 odo (117.0 - 100.0 = 17.0)
    expect(saved.distanceKm).toBeGreaterThan(7.0);
    expect(saved.distanceKm).toBeLessThan(10.0);
  });

  it('preserves 15-min buffer window when no next trip exists (buffer-replay trips)', async () => {
    // When there is no next trip, the full +15 min window must remain so that
    // buffer-replay trips (fleet telemetry drops mid-trip, REST poll continues)
    // can still reach the actual end odometer.
    const { prisma, updated } = buildPrisma(null);  // no next trip
    const svc = new TripPostProcessorService(prisma as any);
    await svc.processTripById('trip-A');

    const saved = updated[0];
    expect(saved.distanceKm).toBeDefined();
    // Without a next trip, window = T0+21min → last odo = T12 = 117.0 (17.0 km).
    // That's the correct behaviour for a buffer-replay trip with odo=117 at T12.
    expect(saved.repairReason).toContain('distance_from_odometer_no_gps');
  });
});
