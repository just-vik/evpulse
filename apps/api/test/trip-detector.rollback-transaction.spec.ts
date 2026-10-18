import { TripDetectorService } from '../src/trips/trip-detector.service';
import { TripBuilderService, BufferedPoint } from '../src/trips/trip-builder.service';

/**
 * Regression tests for DEF-1 — atomic rollback in TripDetectorService.
 *
 * Before the fix, four rollback paths (impossible speed, GPS drift, false start,
 * finalizeTripFromDb) did sequential deleteMany(tripPoints) + delete(trip) with
 * no transaction. A crash between the two steps left a zombie Trip row with no
 * points that triggered an FK error on the next finalize attempt.
 *
 * After the fix, each pair is wrapped in prisma.$transaction([...]), making the
 * deletion atomic: either both succeed or neither does.
 *
 * Tests verify:
 *   1. $transaction called for impossible-speed rollback (> 300 km/h avg).
 *   2. $transaction called for GPS-drift rollback (< 5 km/h avg AND < 2 km).
 *   3. $transaction called for false-start rollback (< 500 m).
 *   4. $transaction called in finalizeTripFromDb recovery path.
 *   5. Redis trip:id key is deleted AFTER $transaction completes (not before).
 *   6. $transaction failure propagates — no partial state.
 */

beforeAll(() => { jest.spyOn(Math, 'random').mockReturnValue(0); });
afterAll(() => { jest.restoreAllMocks(); });

const VEHICLE_ID = 'veh-1';
const TRIP_ID    = 'trip-abc';
const T0 = 1_760_000_000_000; // ms epoch base

function buildRedisMock() {
  const store = new Map<string, string>();
  store.set(`trip:id:${VEHICLE_ID}`, TRIP_ID);
  return {
    store,
    get:  jest.fn(async (k: string) => store.get(k) ?? null),
    set:  jest.fn(async (k: string, v: string, ..._: any[]) => { store.set(k, v); return 'OK'; }),
    del:  jest.fn(async (k: string) => { store.delete(k); return 1; }),
    keys: jest.fn(async () => []),
  };
}

function buildPoint(offsetMs: number, lat: number, lon: number, speed: number): BufferedPoint {
  return {
    timestamp: new Date(T0 + offsetMs),
    speed, power: 10, soc: 70,
    latitude: lat, longitude: lon,
    elevationM: null, interpolated: false,
  };
}

function buildDetector(
  redis: ReturnType<typeof buildRedisMock>,
  tripBuilder: TripBuilderService,
  prismaOverrides: Record<string, any> = {},
) {
  const transactionMock = jest.fn().mockImplementation(
    (ops: any[]) => Promise.all(ops),
  );

  const prisma = {
    trip: {
      findUnique: jest.fn().mockResolvedValue({
        id: TRIP_ID, vehicleId: VEHICLE_ID,
        startTime: new Date(T0), endTime: null,
        startSoc: 80, startOdometer: 1000,
        startLocation: null, endLocation: null,
        distanceKm: null, energyUsedKwh: null,
        efficiencyWhkm: null, reliabilityScore: null,
        anomalyFlags: null, repairReason: null,
        polyline: null, qualityScore: null,
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      create:    jest.fn().mockResolvedValue({ id: TRIP_ID }),
      update:    jest.fn().mockResolvedValue({}),
      delete:    jest.fn().mockResolvedValue({}),
    },
    tripPoint: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany:   jest.fn().mockResolvedValue([]),
    },
    tripStats: { upsert: jest.fn().mockResolvedValue({}) },
    vehicle:   { findUnique: jest.fn().mockResolvedValue(null) },
    telemetryPoint: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: transactionMock,
    ...prismaOverrides,
  };

  const geocoding    = { reverseShort: jest.fn().mockResolvedValue(null) };
  const kalman       = { reset: jest.fn() };
  const configSvc    = { get: jest.fn().mockReturnValue(undefined) };
  const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };

  const svc = new TripDetectorService(
    redis as any, prisma as any, geocoding as any, tripBuilder,
    kalman as any, configSvc as any,
    undefined, undefined, undefined, undefined, undefined, undefined,
    tariffResolver as any,
  );

  return { svc, prisma, transactionMock };
}

/**
 * Seed a TripBuilder buffer with given points via the public API.
 * This is what finalizeTripToDb reads via tripBuilder.finalize(vehicleId).
 */
function seedTripBuilder(tripBuilder: TripBuilderService, points: BufferedPoint[]) {
  tripBuilder.start(VEHICLE_ID, {
    dbTripId:      TRIP_ID,
    startSoc:      80,
    startLat:      points[0].latitude,
    startLon:      points[0].longitude,
    startOdometer: null,
    now:           points[0].timestamp,
  });
  let prev = points[0].timestamp.getTime();
  for (const pt of points) {
    const dt = pt.timestamp.getTime() - prev;
    tripBuilder.addPoint(VEHICLE_ID, pt, dt);
    prev = pt.timestamp.getTime();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TripDetectorService — rollback paths use $transaction', () => {

  it('1. impossible-speed rollback (> 300 km/h avg) calls $transaction', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);
    const { svc, transactionMock } = buildDetector(redis, tripBuilder);

    // 10 km in 1 minute = 600 km/h avg → impossible speed
    const pts = [
      buildPoint(0,       50.00000, 8.40000, 200),
      buildPoint(60_000,  50.09000, 8.40000, 200),
    ];
    seedTripBuilder(tripBuilder, pts);

    await (svc as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 70, latitude: 50.09, longitude: 8.40 },
      new Date(T0 + 60_000),
      TRIP_ID,
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
    const [ops] = transactionMock.mock.calls[0];
    expect(Array.isArray(ops)).toBe(true);
    expect(ops).toHaveLength(2);
  });

  it('2. GPS-drift rollback (< 5 km/h avg AND < 2 km) calls $transaction', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);
    const { svc, transactionMock } = buildDetector(redis, tripBuilder);

    // 0.5 km in 10 minutes = 3 km/h → GPS drift
    const pts = [
      buildPoint(0,         50.00000, 8.40000, 2),
      buildPoint(600_000,   50.00450, 8.40000, 2),
    ];
    seedTripBuilder(tripBuilder, pts);

    await (svc as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 70, latitude: 50.00450, longitude: 8.40000 },
      new Date(T0 + 600_000),
      TRIP_ID,
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('3. false-start rollback (< 500 m) calls $transaction', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);
    const { svc, transactionMock } = buildDetector(redis, tripBuilder);

    // 200 m in 30 seconds → false start
    const pts = [
      buildPoint(0,       50.00000, 8.40000, 20),
      buildPoint(30_000,  50.00180, 8.40000, 20),
    ];
    seedTripBuilder(tripBuilder, pts);

    await (svc as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 70, latitude: 50.00180, longitude: 8.40000 },
      new Date(T0 + 30_000),
      TRIP_ID,
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('4. finalizeTripFromDb recovery rollback calls $transaction', async () => {
    const redis = buildRedisMock();
    // No buffer seeded → finalizeTripToDb falls through to finalizeTripFromDb
    const tripBuilder = new TripBuilderService(redis as any);

    // DB returns 2 points with 0.2 km separation → false start in recovery path
    const dbPoints = [
      { id: 'p1', tripId: TRIP_ID, timestamp: new Date(T0), latitude: 50.00000, longitude: 8.40000, speed: 20 },
      { id: 'p2', tripId: TRIP_ID, timestamp: new Date(T0 + 30_000), latitude: 50.00180, longitude: 8.40000, speed: 20 },
    ];

    const { svc, transactionMock } = buildDetector(redis, tripBuilder, {
      tripPoint: {
        createMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany:   jest.fn().mockResolvedValue(dbPoints),
      },
    });

    await (svc as any).finalizeTripFromDb(
      VEHICLE_ID, TRIP_ID,
      { soc: 70, latitude: 50.00180, longitude: 8.40000 },
      new Date(T0 + 30_000),
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('5. Redis trip:id key is deleted AFTER $transaction completes', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);
    const callOrder: string[] = [];

    const transactionMock = jest.fn().mockImplementation(async () => {
      callOrder.push('transaction');
    });
    redis.del = jest.fn(async (k: string) => { callOrder.push(`del:${k}`); return 1; });

    const { svc } = buildDetector(redis, tripBuilder, { $transaction: transactionMock });

    // False start: 200 m / 30 s
    const pts = [
      buildPoint(0,       50.00000, 8.40000, 20),
      buildPoint(30_000,  50.00180, 8.40000, 20),
    ];
    seedTripBuilder(tripBuilder, pts);

    await (svc as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 70, latitude: 50.00180, longitude: 8.40000 },
      new Date(T0 + 30_000),
      TRIP_ID,
    );

    const txIdx  = callOrder.indexOf('transaction');
    const delIdx = callOrder.findIndex(s => s.startsWith('del:trip:id:'));
    expect(txIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(txIdx);
  });

  it('6. $transaction failure propagates — no Redis trip:id del, no partial state', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);

    const { svc } = buildDetector(redis, tripBuilder, {
      $transaction: jest.fn().mockRejectedValue(new Error('DB error')),
    });

    // False start: 200 m / 30 s
    const pts = [
      buildPoint(0,       50.00000, 8.40000, 20),
      buildPoint(30_000,  50.00180, 8.40000, 20),
    ];
    seedTripBuilder(tripBuilder, pts);

    await expect(
      (svc as any).finalizeTripToDb(
        VEHICLE_ID,
        { soc: 70, latitude: 50.00180, longitude: 8.40000 },
        new Date(T0 + 30_000),
        TRIP_ID,
      ),
    ).rejects.toThrow('DB error');

    // Redis must NOT have been cleared — transaction failed, state is unknown
    expect(redis.del).not.toHaveBeenCalledWith(`trip:id:${VEHICLE_ID}`);
  });
});
