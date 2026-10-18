import { TripDetectorService } from '../src/trips/trip-detector.service';
import { TripBuilderService, BufferedPoint } from '../src/trips/trip-builder.service';

/**
 * Regression tests for POT-2 — tariff resolver exception must not leave a trip open.
 *
 * Root cause: finalizeTripToDb() called tariffResolver.resolve() with no error handling.
 * A transient DB error (e.g. resolveVehicleSettings timeout) propagated out of
 * finalizeTripToDb before prisma.trip.update() ran, leaving the trip open (endTime: null)
 * for the idempotency-key TTL (~10 min) and then closing it without costTotal.
 *
 * Fix: resolve() is now wrapped in try/catch. On any error, costTotal is set to null
 * with a WARN log, and finalization continues normally.
 *
 * IMPORTANT: TripPostProcessorService does NOT currently recalculate trip costTotal.
 * costTotal = null has NO automatic recovery. A cost-backfill stage in the post-processor
 * is needed to repair trips affected by this failure mode.
 *
 * Tests verify:
 *   1. resolve() throws (transient DB error) → trip.update() called, costTotal=null.
 *   2. tariffResolver is undefined (unit-test isolation) → trip.update() called, costTotal=null.
 *   3. Normal resolve path → costTotal calculated and stored correctly.
 *   4. DB write failure (trip.update throws) → error propagates; not masked by tariff catch.
 *   5. After tariff error, redis.del('trip:id:…') is called (Redis state cleaned up).
 */

const VEH    = 'veh-1';
const TRIP_ID = 'trip-tariff-test';
const T0_MS   = new Date('2026-10-18T09:00:00.000Z').getTime();
const T0      = new Date(T0_MS);
const NOW     = new Date(T0_MS + 300_000); // 5 min later

// 5 GPS points: 50.0 → 50.045 lat ≈ 5 km, 60 km/h avg, 15 kW, 5% SOC drop.
// Passes all rollback guards: distance > 0.5 km, speed 60 km/h, no impossible speed.
const TRIP_POINTS: BufferedPoint[] = [
  { timestamp: new Date(T0_MS),           speed: 60, power: 15, soc: 80, latitude: 50.000, longitude: 8.4, elevationM: 100, interpolated: false },
  { timestamp: new Date(T0_MS +  75_000), speed: 62, power: 14, soc: 79, latitude: 50.011, longitude: 8.4, elevationM: 101, interpolated: false },
  { timestamp: new Date(T0_MS + 150_000), speed: 58, power: 13, soc: 78, latitude: 50.022, longitude: 8.4, elevationM: 102, interpolated: false },
  { timestamp: new Date(T0_MS + 225_000), speed: 61, power: 14, soc: 77, latitude: 50.033, longitude: 8.4, elevationM: 101, interpolated: false },
  { timestamp: new Date(T0_MS + 300_000), speed: 59, power: 15, soc: 75, latitude: 50.045, longitude: 8.4, elevationM: 100, interpolated: false },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildRedisMock() {
  const store = new Map<string, string>();
  return {
    store,
    set:  jest.fn(async (key: string, value: string, ...args: any[]) => {
      const nxIdx = args.findIndex((a: any) => a === 'NX');
      if (nxIdx !== -1) {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      store.set(key, value);
      return 'OK';
    }),
    get:  jest.fn(async (key: string) => store.get(key) ?? null),
    del:  jest.fn(async (key: string) => { store.delete(key); return 1; }),
    keys: jest.fn(async () => []),
  };
}

function buildPrisma(overrides: Record<string, any> = {}) {
  return {
    trip: {
      findUnique: jest.fn().mockResolvedValue({
        id: TRIP_ID, vehicleId: VEH,
        startTime: T0, endTime: null, startSoc: 80, startOdometer: 1000,
        startLat: 50.0, startLon: 8.4, endLat: null, endLon: null,
        distanceKm: null, energyUsedKwh: null, efficiencyWhkm: null,
        qualityScore: null, anomalyFlags: null, polyline: null, reconcileAt: null,
        costTotal: null, drivingScore: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    tripPoint: { createMany: jest.fn().mockResolvedValue({ count: 5 }) },
    telemetryPoint: { findFirst: jest.fn().mockResolvedValue(null) },
    vehicle: { findUnique: jest.fn().mockResolvedValue({ vehicleSpec: { batteryUsableKwh: 75 } }) },
    tripStats: { upsert: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
    ...overrides,
  };
}

function buildService(
  redis: ReturnType<typeof buildRedisMock>,
  prisma: ReturnType<typeof buildPrisma>,
  tripBuilder: TripBuilderService,
  tariffResolver: any,
) {
  const geocoding  = { reverseShort: jest.fn().mockResolvedValue(null) };
  const kalman     = { reset: jest.fn(), update: jest.fn().mockImplementation((v: any) => v) };
  const configSvc  = { get: jest.fn().mockReturnValue(undefined) };

  return new TripDetectorService(
    redis as any, prisma as any, geocoding as any, tripBuilder,
    kalman as any, configSvc as any,
    undefined, undefined, undefined, undefined, undefined, undefined,
    tariffResolver,
  );
}

/** Seed the TripBuilder buffer with a valid 5-point, 5-km trip. */
function seedBuffer(tripBuilder: TripBuilderService): void {
  tripBuilder.start(VEH, {
    dbTripId:      TRIP_ID,
    startSoc:      80,
    startLat:      TRIP_POINTS[0].latitude,
    startLon:      TRIP_POINTS[0].longitude,
    startOdometer: null,
    now:           TRIP_POINTS[0].timestamp,
  });
  let prev = TRIP_POINTS[0].timestamp.getTime();
  for (const pt of TRIP_POINTS) {
    const dt = pt.timestamp.getTime() - prev;
    tripBuilder.addPoint(VEH, pt, dt);
    prev = pt.timestamp.getTime();
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TripDetectorService — tariff resolution failure (POT-2)', () => {

  it('1. resolve() throws → trip.update() called with costTotal=null, trip is closed', async () => {
    const redis       = buildRedisMock();
    const prisma      = buildPrisma();
    const tripBuilder = new TripBuilderService(redis as any);
    seedBuffer(tripBuilder);

    const tariffResolver = {
      resolve: jest.fn().mockRejectedValue(new Error('ECONNREFUSED: DB unreachable')),
    };
    const svc = buildService(redis, prisma, tripBuilder, tariffResolver);

    // finalizeTripToDb must succeed (not throw)
    await expect(
      (svc as any).finalizeTripToDb(VEH, { soc: 75, latitude: 50.045, longitude: 8.4 }, NOW, TRIP_ID),
    ).resolves.toBeUndefined();

    // trip.update must have been called (trip closed)
    expect(prisma.trip.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.trip.update.mock.calls[0][0];
    expect(updateArg.data.endTime).not.toBeNull();
    expect(updateArg.data.costTotal).toBeNull();
  });

  it('2. tariffResolver undefined → trip.update() called with costTotal=null, trip is closed', async () => {
    const redis       = buildRedisMock();
    const prisma      = buildPrisma();
    const tripBuilder = new TripBuilderService(redis as any);
    seedBuffer(tripBuilder);

    const svc = buildService(redis, prisma, tripBuilder, undefined);

    await expect(
      (svc as any).finalizeTripToDb(VEH, { soc: 75, latitude: 50.045, longitude: 8.4 }, NOW, TRIP_ID),
    ).resolves.toBeUndefined();

    expect(prisma.trip.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.trip.update.mock.calls[0][0];
    expect(updateArg.data.endTime).not.toBeNull();
    expect(updateArg.data.costTotal).toBeNull();
  });

  it('3. successful resolve → costTotal calculated and stored correctly', async () => {
    const redis       = buildRedisMock();
    const prisma      = buildPrisma();
    const tripBuilder = new TripBuilderService(redis as any);
    seedBuffer(tripBuilder);

    const tariffResolver = {
      resolve: jest.fn().mockResolvedValue({ rate: 0.35, currency: 'EUR', source: 'default' }),
    };
    const svc = buildService(redis, prisma, tripBuilder, tariffResolver);

    await (svc as any).finalizeTripToDb(VEH, { soc: 75, latitude: 50.045, longitude: 8.4 }, NOW, TRIP_ID);

    expect(tariffResolver.resolve).toHaveBeenCalledWith({
      purpose: 'actual_cost', vehicleId: VEH,
    });
    const updateArg = prisma.trip.update.mock.calls[0][0];
    expect(updateArg.data.costTotal).not.toBeNull();
    // energyUsedKwh × 0.35 — verify it is a positive number
    expect(updateArg.data.costTotal).toBeGreaterThan(0);
  });

  it('4. trip.update throws → error propagates; DB error is not masked by tariff catch', async () => {
    const redis       = buildRedisMock();
    const prisma      = buildPrisma({
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: TRIP_ID, vehicleId: VEH,
          startTime: T0, endTime: null, startSoc: 80, startOdometer: null,
          startLat: 50.0, startLon: 8.4, endLat: null, endLon: null,
          distanceKm: null, energyUsedKwh: null, efficiencyWhkm: null,
          qualityScore: null, anomalyFlags: null, polyline: null, reconcileAt: null,
          costTotal: null, drivingScore: null,
        }),
        update: jest.fn().mockRejectedValue(new Error('DB write failed')),
      },
    });
    const tripBuilder = new TripBuilderService(redis as any);
    seedBuffer(tripBuilder);

    const tariffResolver = {
      resolve: jest.fn().mockResolvedValue({ rate: 0.35, currency: 'EUR', source: 'default' }),
    };
    const svc = buildService(redis, prisma, tripBuilder, tariffResolver);

    // The DB write error must propagate — it is not masked by the tariff try/catch
    await expect(
      (svc as any).finalizeTripToDb(VEH, { soc: 75, latitude: 50.045, longitude: 8.4 }, NOW, TRIP_ID),
    ).rejects.toThrow('DB write failed');
  });

  it('5. after tariff error, redis trip:id key is deleted (Redis state cleaned up)', async () => {
    const redis       = buildRedisMock();
    // Pre-seed the trip:id key to confirm it gets deleted
    redis.store.set(`trip:id:${VEH}`, TRIP_ID);

    const prisma      = buildPrisma();
    const tripBuilder = new TripBuilderService(redis as any);
    seedBuffer(tripBuilder);

    const tariffResolver = {
      resolve: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const svc = buildService(redis, prisma, tripBuilder, tariffResolver);

    await (svc as any).finalizeTripToDb(VEH, { soc: 75, latitude: 50.045, longitude: 8.4 }, NOW, TRIP_ID);

    // trip:id:{vehicleId} must be cleared — proves state cleanup ran
    expect(redis.store.has(`trip:id:${VEH}`)).toBe(false);
    // And the del was called with that key
    expect(redis.del).toHaveBeenCalledWith(`trip:id:${VEH}`);
  });
});
