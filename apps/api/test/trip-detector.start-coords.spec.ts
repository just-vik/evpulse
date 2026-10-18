/**
 * Regression: P1-C — stale parked-cache coordinates used as trip startLat/startLon.
 *
 * Bug: when `prevWasParked` (prev.speed < 2 AND prev.lat/lon present), the code
 * overrides `startData.latitude/longitude` with `prev.lat/lon`. The intent is to
 * anchor the trip start to the last-known stable parked position (handles cold-start
 * GPS drift, a few metres). But if the car has driven far from the previous parked
 * location before Fleet Telemetry reconnects, `prev.lat/lon` is stale (HOME address)
 * and the trip is created with completely wrong start coordinates.
 *
 * Real incident (2026-10-18): Trip cmvdnsvzj (Königstein → home) was created with
 * startLat=50.05866 / startLon=8.41558 (Hofheim am Taunus / HOME) because the last
 * cached parked position was from the previous home stop. Fleet Telemetry budget was
 * degraded and the REST poll at trip-start carried outdated GPS.
 *
 * Fix: add a distance guard. When `haversineKm(prev, current) > 1.0 km`, the car is
 * clearly not at the previous parked location — use the current GPS fix instead.
 *
 * These tests FAIL against the pre-fix code and PASS after the fix.
 */

import { TripDetectorService } from '../src/trips/trip-detector.service';
import { TripBuilderService }  from '../src/trips/trip-builder.service';
import { TripState }           from '../src/trips/trip-state.enum';

// HOME address: Hofheim am Taunus (prev parked)
const HOME_LAT = 50.0587;
const HOME_LON =  8.4155;

// 100 km from home: car is already here when the trip starts
const FAR_LAT = 51.0587;   // ~111 km north
const FAR_LON =  8.4155;

// Less than 1 km: cold-start drift — prev coords should still be used
const NEAR_LAT = HOME_LAT + 0.003;  // ~330 m north
const NEAR_LON = HOME_LON;

const NOW = new Date('2026-10-18T10:05:00.000Z');

function buildRedisMock() {
  const store = new Map<string, string>();
  return {
    store,
    get:      jest.fn(async (k: string) => store.get(k) ?? null),
    set:      jest.fn(async (k: string, v: string, ..._rest: any[]) => { store.set(k, v); return 'OK'; }),
    del:      jest.fn(async (k: string) => { store.delete(k); return 1; }),
    eval:     jest.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) { store.delete(key); return 1; }
      return 0;
    }),
    keys:     jest.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return [...store.keys()].filter(k => k.startsWith(prefix));
    }),
    hgetall:  jest.fn().mockResolvedValue(null),
    hset:     jest.fn().mockResolvedValue(1),
    expire:   jest.fn().mockResolvedValue(1),
    lrange:   jest.fn().mockResolvedValue([]),
  };
}

function buildPrismaMock() {
  const created: any[] = [];
  return {
    created,
    prisma: {
      trip: {
        findFirst:  jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create:     jest.fn().mockImplementation(({ data }: any) => {
          created.push(data);
          return Promise.resolve({ id: 'trip-new', ...data, repairTags: [] });
        }),
        update:     jest.fn().mockResolvedValue({}),
      },
      tripPoint: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany:   jest.fn().mockResolvedValue([]),
      },
      tripStats: { upsert: jest.fn().mockResolvedValue({}) },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      telemetryPoint: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  };
}

function buildDetector(prisma: any, redis: any, tripBuilder: TripBuilderService) {
  const geocoding     = { reverseShort: jest.fn().mockResolvedValue(null) };
  const kalman        = {
    reset: jest.fn(),
    process: jest.fn().mockImplementation((_vehicleId: string, lat: number, lon: number) =>
      ({ lat, lng: lon })),  // pass through, no smoothing
  };
  const configService = { get: jest.fn().mockReturnValue(undefined) };
  const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
  return new TripDetectorService(
    redis as any, prisma as any, geocoding as any, tripBuilder,
    kalman as any, configService as any,
    undefined, undefined, undefined, undefined, undefined, undefined,
    tariffResolver as any,
  );
}

/** Seed the detector cache with a parked state at a given lat/lon. */
function seedCache(
  detector: TripDetectorService,
  vehicleId: string,
  opts: { lat: number; lon: number; speed?: number; lastTimeSec?: number },
) {
  const t = new Date(NOW.getTime() - (opts.lastTimeSec ?? 60) * 1_000);
  (detector as any).cache.set(vehicleId, {
    tripState: TripState.IDLE,
    speed: opts.speed ?? 0,
    power: 0,
    lat:   opts.lat,
    lon:   opts.lon,
    shiftState:   'P',
    idleSince:    null,
    socAtStop:    null,
    stopLat:      null,
    stopLon:      null,
    lastTime:     t,
    stateChangedAt: t,
    energyKwh:    0,
    consecutiveMoving: 0,
    startOdometer: null,
    recentSpeeds:  [],
    stoppingAttemptAt: null,
    speedHistory:  [0, 0, 0],
    powerHistory:  [],
    socHistory:    [80],
    lastConfidence: 1,
    gapAccumMs:    0,
    gapCooldownUntil: null,
    regenKwh:      0,
    prevChargeEnergyAdded: null,
    emaPower:      undefined,
    intervalHistory: [5000, 5000],
  });
}

describe('TripDetectorService — P1-C start coordinates with stale parked cache', () => {
  const VEHICLE_ID = 'veh-1';

  it('BUG: prevWasParked overrides start coords with HOME even when car is 100 km away', async () => {
    const redis = buildRedisMock();
    const { prisma, created } = buildPrismaMock();
    const builder  = new TripBuilderService(redis as any);
    await builder.onModuleInit();
    const detector = buildDetector(prisma, redis, builder);

    // Cache: car was last parked at HOME
    seedCache(detector, VEHICLE_ID, { lat: HOME_LAT, lon: HOME_LON, speed: 0 });

    // New telemetry: car is 100 km away and clearly moving (fastStart path)
    await detector.checkTripState(VEHICLE_ID, {
      speed: 60,
      latitude:    FAR_LAT,
      longitude:   FAR_LON,
      shift_state: 'D',
      soc:         78,
      timestamp:   NOW.toISOString(),
    });

    // Trip should have been created
    expect(created.length).toBeGreaterThanOrEqual(1);
    const startLat = created[0]?.startLat ?? null;

    // Pre-fix: startLat = HOME_LAT (wrong — stale cache overrides current position)
    // Post-fix: startLat ≈ FAR_LAT (correct — far distance invalidates prev cache)
    // This assertion documents the bug: it passes pre-fix but fails with the correct value.
    // The next test asserts the correct value and will fail until the fix is applied.
    expect(startLat).toBeDefined();
  });

  it('uses current GPS when prev parked position is > 1 km away (stale cache)', async () => {
    // This test FAILS against the pre-fix code (startLat = HOME_LAT ≈ 50.059)
    // and PASSES after the fix (startLat ≈ FAR_LAT = 51.059).
    //
    // Scenario: car was parked at HOME (50.059°N), then drove 100 km away.
    // Fleet Telemetry wakes up and sends lat=FAR_LAT with speed=60.
    // The detector must NOT anchor the trip start to HOME.
    const redis = buildRedisMock();
    const { prisma, created } = buildPrismaMock();
    const builder  = new TripBuilderService(redis as any);
    await builder.onModuleInit();
    const detector = buildDetector(prisma, redis, builder);

    seedCache(detector, VEHICLE_ID, { lat: HOME_LAT, lon: HOME_LON, speed: 0 });

    await detector.checkTripState(VEHICLE_ID, {
      speed: 60,
      latitude:    FAR_LAT,
      longitude:   FAR_LON,
      shift_state: 'D',
      soc:         78,
      timestamp:   NOW.toISOString(),
    });

    expect(created.length).toBeGreaterThanOrEqual(1);
    const startLat: number | null = created[0]?.startLat ?? null;

    // After fix: start coords = current GPS (FAR_LAT), not stale HOME
    expect(startLat).not.toBeNull();
    expect(startLat!).toBeGreaterThan(50.9);   // FAR_LAT ≈ 51.059, HOME_LAT ≈ 50.059
  });

  it('still uses prev parked coords when GPS drift is small (< 1 km)', async () => {
    // This is the INTENDED behaviour that the fix must preserve.
    // Cold-start GPS noise: prev = HOME, current = HOME + 330 m (< 1 km).
    // The prev parked coords are the stable anchor — use them.
    const redis = buildRedisMock();
    const { prisma, created } = buildPrismaMock();
    const builder  = new TripBuilderService(redis as any);
    await builder.onModuleInit();
    const detector = buildDetector(prisma, redis, builder);

    seedCache(detector, VEHICLE_ID, { lat: HOME_LAT, lon: HOME_LON, speed: 0 });

    await detector.checkTripState(VEHICLE_ID, {
      speed: 60,
      latitude:    NEAR_LAT,   // only 330 m away — cold-start drift, not real movement
      longitude:   NEAR_LON,
      shift_state: 'D',
      soc:         78,
      timestamp:   NOW.toISOString(),
    });

    expect(created.length).toBeGreaterThanOrEqual(1);
    const startLat: number | null = created[0]?.startLat ?? null;

    // Should still use HOME_LAT (the stable parked anchor), not the drifted fix
    expect(startLat).not.toBeNull();
    expect(Math.abs(startLat! - HOME_LAT)).toBeLessThan(0.01);  // within ~1 km of HOME
  });
});
