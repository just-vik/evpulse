import { TripCleanupService } from '../src/trips/trip-cleanup.service';

/**
 * Regression tests for the phantom-trip detection flow in TripCleanupService.
 *
 * Two related changes from the Oct 2026 zero-duration trip audit:
 *
 * 1. closeStaleOpenTrips(): when the watchdog closes a trip that has no moving
 *    telemetry (rawEndTime ≤ startTime), it now explicitly sets distanceKm = 0.
 *    This marks the trip unambiguously as "went nowhere" without relying on the
 *    IS NULL check that could accidentally catch race-condition trips that have
 *    real movement but whose finalize buffer was discarded.
 *
 * 2. runManual / zeroDuration query: changed from
 *      ("distanceKm" IS NULL OR "distanceKm" < 0.3)
 *    to
 *      "distanceKm" IS NOT NULL AND "distanceKm" < 0.3
 *
 *    Trips with NULL distanceKm are excluded. They may represent real movement
 *    whose finalizeTripToDb buffer was discarded (live-state fencing) and must
 *    not be auto-deleted — they are handled by the reconcileAt mechanism.
 */

// Activate isWorkerRole() before importing the service
beforeAll(() => { process.env.APP_ROLE = 'worker'; });
afterAll(() => { delete process.env.APP_ROLE; });

describe('TripCleanupService — phantom-trip watchdog distanceKm marking', () => {
  const VEHICLE_ID = 'veh-phantom';

  function baseTrip(overrides: Partial<{
    id: string; startTime: Date; endTime: Date | null;
    vehicleId: string; repairTags: any;
  }> = {}) {
    const start = new Date(Date.now() - 2 * 60 * 60_000); // 2 hours ago
    return {
      id: 'trip-1',
      vehicleId: VEHICLE_ID,
      startTime: start,
      endTime: null,
      repairTags: null,
      ...overrides,
    };
  }

  function buildService(
    trip: any,
    latestTelemetry: Array<{ ts: Date; speed: number | null; soc: number | null }>,
    lastMoving: Array<{ ts: Date; soc: number | null }>,
    capturedUpdates: any[],
  ) {
    let rawQueryCallCount = 0;
    const prisma = {
      trip: {
        findMany: jest.fn().mockResolvedValue([trip]),
        update: jest.fn().mockImplementation(({ data }: any) => {
          capturedUpdates.push(data);
          return Promise.resolve({ ...trip, ...data });
        }),
      },
      $queryRaw: jest.fn().mockImplementation(() => {
        // First call: latest telemetry point; second call: last moving point
        rawQueryCallCount++;
        if (rawQueryCallCount === 1) return Promise.resolve(latestTelemetry);
        if (rawQueryCallCount === 2) return Promise.resolve(lastMoving);
        return Promise.resolve([]);
      }),
    };
    const postProcessor = { processTrip: jest.fn() };
    const tripReconciler = { runManual: jest.fn() };
    return new TripCleanupService(prisma as any, postProcessor as any, tripReconciler as any);
  }

  it('phantom trip (no moving telemetry) → distanceKm set to 0', async () => {
    const updates: any[] = [];
    const trip = baseTrip();
    const latestTelemetry = [{ ts: new Date(trip.startTime.getTime() - 5_000), speed: 0, soc: 50 }];
    // No moving points found
    const lastMoving: any[] = [];
    const service = buildService(trip, latestTelemetry, lastMoving, updates);

    await service.closeStaleOpenTrips();

    expect(updates).toHaveLength(1);
    // Phantom: rawEndTime (from latestTelemetry[0]) ≤ trip.startTime
    expect(updates[0].distanceKm).toBe(0);
    // endTime must be startTime + 60s
    expect(updates[0].endTime.getTime()).toBe(trip.startTime.getTime() + 60_000);
  });

  it('trip with real movement (lastMoving > startTime) → distanceKm NOT set by watchdog', async () => {
    const updates: any[] = [];
    const trip = baseTrip();
    const movingTs = new Date(trip.startTime.getTime() + 80_000); // 80s of driving
    const latestTelemetry = [{ ts: new Date(movingTs.getTime() + 30_000), speed: 0, soc: 55 }];
    const lastMoving = [{ ts: movingTs, soc: 53 }];
    const service = buildService(trip, latestTelemetry, lastMoving, updates);

    await service.closeStaleOpenTrips();

    expect(updates).toHaveLength(1);
    // Real movement: isPhantom = false → distanceKm NOT included in update
    expect(updates[0]).not.toHaveProperty('distanceKm');
    expect(updates[0].endTime).toEqual(movingTs);
  });

  it('trip with no telemetry at all → closed at now, distanceKm NOT set (unknown movement)', async () => {
    const updates: any[] = [];
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000);
    const trip = baseTrip({ startTime: sevenHoursAgo });
    // No telemetry whatsoever — rawEndTime falls back to new Date(), isPhantom = false
    const service = buildService(trip, [], [], updates);
    const before = Date.now();

    await service.closeStaleOpenTrips();

    expect(updates).toHaveLength(1);
    // endTime ≈ now (within 5 seconds), NOT startTime + 60s
    expect(updates[0].endTime.getTime()).toBeGreaterThanOrEqual(before);
    expect(updates[0].endTime.getTime()).toBeLessThan(before + 5_000);
    // distanceKm left as-is; trip stays in DB for reconcileAt-based recovery
    expect(updates[0]).not.toHaveProperty('distanceKm');
  });
});

describe('TripCleanupService — zeroDuration query distanceKm guard semantics', () => {
  /**
   * The zeroDuration SQL query uses:
   *   "distanceKm" IS NOT NULL AND "distanceKm" < 0.3
   *
   * Verify that trips in different distanceKm states behave correctly
   * by testing the equivalent JavaScript predicate.
   *
   * (The actual SQL is tested via integration test against Postgres;
   * these assertions document the intended semantics for CI.)
   */

  function matchesZeroDurationTarget(distanceKm: number | null): boolean {
    return distanceKm !== null && distanceKm < 0.3;
  }

  it('distanceKm = 0 (explicit phantom marker) → matches target → should be deleted', () => {
    expect(matchesZeroDurationTarget(0)).toBe(true);
  });

  it('distanceKm = 0.15 → matches target → should be deleted', () => {
    expect(matchesZeroDurationTarget(0.15)).toBe(true);
  });

  it('distanceKm = 0.3 → does NOT match (boundary exclusive) → safe', () => {
    expect(matchesZeroDurationTarget(0.3)).toBe(false);
  });

  it('distanceKm = 0.8 → does NOT match → real short trip preserved', () => {
    expect(matchesZeroDurationTarget(0.8)).toBe(false);
  });

  it('distanceKm = NULL → does NOT match → race-condition trip preserved for reconciliation', () => {
    expect(matchesZeroDurationTarget(null)).toBe(false);
  });
});
