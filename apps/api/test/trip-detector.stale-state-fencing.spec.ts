import { TripDetectorService } from '../src/trips/trip-detector.service';
import { TripBuilderService, BufferedPoint } from '../src/trips/trip-builder.service';

/**
 * Regression tests for the Trip live-state fencing audit (Oct 2026).
 *
 * Real incidents observed in production:
 *   - cmur2984800bjy88hsz8ev6e1 (2026-10-03 05:01): a buffer restored from a stale
 *     Redis checkpoint at process startup forced-ended into a Trip row that had
 *     already been deleted — "Record to delete does not exist".
 *   - cmuvbhepe055xjx1ozer4y8jq (2026-10-05/06): the same symptom family — a live
 *     buffer referenced a dbTripId whose row no longer existed by the time
 *     finalizeTripToDb() ran — this time surfacing as
 *     `Foreign key constraint violated: trip_points_tripId_fkey` on createMany().
 *
 * trip-reconciler.service.ts and trip-cleanup.service.ts were investigated and
 * ruled out as the deletion mechanism for either incident: both only ever touch
 * trips where endTime IS NOT NULL (confirmed by reading their delete call sites),
 * so neither can remove a trip TripBuilder still considers "live". The actual gap
 * is in TripBuilderService/TripDetectorService's own restore paths (onModuleInit's
 * blind Redis-checkpoint restore, and the DB-driven cache-miss restoreFromDb
 * safety net): neither re-validates, right before a DB mutation, that the
 * dbTripId it is about to write against is still the SAME open trip it was
 * when the live/checkpointed state was first created.
 *
 * These tests characterize that invariant directly against finalizeTripToDb()
 * (accessed via cast, consistent with this codebase's existing white-box test
 * convention) rather than relying on Postgres's FK constraint to surface it —
 * a missing re-validation is a bug regardless of whether a particular schema
 * happens to have a constraint that turns it into a loud error instead of a
 * silent one. Scenarios A and B are expected to FAIL against the pre-fix code:
 * they exist to prove the defect, then prove the fix.
 */
describe('Trip live-state fencing — stale dbTripId must not reach a DB mutation', () => {
  const VEHICLE_ID = 'veh-1';

  function buildRedisMock() {
    const store = new Map<string, string>();
    return {
      store,
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string, ..._rest: any[]) => { store.set(k, v); return 'OK'; }),
      del: jest.fn(async (k: string) => { const had = store.delete(k); return had ? 1 : 0; }),
      keys: jest.fn(async (pattern: string) => {
        const prefix = pattern.replace('*', '');
        return [...store.keys()].filter(k => k.startsWith(prefix));
      }),
    };
  }

  function buildPrismaMock(tripRow: any) {
    return {
      trip: {
        findUnique: jest.fn().mockResolvedValue(tripRow),
        findFirst:  jest.fn().mockResolvedValue(null),
        create:     jest.fn(),
        update:     jest.fn().mockResolvedValue({}),
        delete:     jest.fn().mockResolvedValue({}),
      },
      tripPoint: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany:   jest.fn().mockResolvedValue([]),
      },
      tripStats: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue(null), // → usableKwh falls back to 75
      },
      telemetryPoint: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
  }

  function buildDetector(prisma: any, redis: any, tripBuilder: TripBuilderService) {
    const geocoding       = { reverseShort: jest.fn().mockResolvedValue(null) };
    const kalman          = { reset: jest.fn() };
    const configService   = { get: jest.fn().mockReturnValue(undefined) };
    const tariffResolver  = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
    return new TripDetectorService(
      redis as any, prisma as any, geocoding as any, tripBuilder,
      kalman as any, configService as any,
      undefined, undefined, undefined, undefined, undefined, undefined,
      tariffResolver as any,
    );
  }

  function gpsPoint(opts: { tSec: number; lat: number; lon: number; speed: number }): BufferedPoint {
    return {
      timestamp: new Date(opts.tSec * 1000),
      speed: opts.speed,
      power: 10,
      soc: 78,
      latitude: opts.lat,
      longitude: opts.lon,
      elevationM: null,
      interpolated: false,
    };
  }

  const T0 = 1_760_000_000; // arbitrary fixed epoch-seconds base

  it('Scenario A — buffer restored from a stale Redis checkpoint after the Trip row was deleted externally: finalize must not call tripPoint.createMany()', async () => {
    const redis = buildRedisMock();

    // Process #1: a trip starts and buffers two real points, checkpointed to Redis.
    const builderBeforeRestart = new TripBuilderService(redis as any);
    builderBeforeRestart.start(VEHICLE_ID, {
      dbTripId: 'trip-A-deleted', startSoc: 80,
      startLat: 48.0, startLon: 8.6, startOdometer: 1000,
      now: new Date(T0 * 1000),
    });
    builderBeforeRestart.addPoint(VEHICLE_ID, gpsPoint({ tSec: T0, lat: 48.0, lon: 8.6, speed: 40 }), 0);
    builderBeforeRestart.addPoint(VEHICLE_ID, gpsPoint({ tSec: T0 + 300, lat: 48.018, lon: 8.6, speed: 40 }), 300_000);
    await (builderBeforeRestart as any).checkpoint(VEHICLE_ID); // force a checkpoint write (normally every 50 pts)

    // "The process restarts" — a brand-new TripBuilderService instance, same Redis.
    const builderAfterRestart = new TripBuilderService(redis as any);
    await builderAfterRestart.onModuleInit(); // blindly restores the stale checkpoint
    expect(builderAfterRestart.has(VEHICLE_ID)).toBe(true); // confirms the resurrection actually happened

    // The shared "current trip" pointer other consumers (TripEngineV2) key off —
    // set when the trip originally started, independent of TripBuilder's own checkpoint.
    await redis.set(`trip:id:${VEHICLE_ID}`, 'trip-A-deleted', 'EX', 7200);

    // Meanwhile, in Postgres, the Trip row no longer exists (deleted by some other process).
    const prisma = buildPrismaMock(null);
    const detector = buildDetector(prisma, redis, builderAfterRestart);

    await (detector as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 75, latitude: 48.02, longitude: 8.6, odometer: 1002 },
      new Date((T0 + 400) * 1000),
      'trip-A-deleted',
    );

    expect(prisma.tripPoint.createMany).not.toHaveBeenCalled();
    expect(prisma.trip.update).not.toHaveBeenCalled();
    // Full invalidation, not just an early return: no stale buffer left in
    // memory, no stale Redis checkpoint, no stale shared trip-id pointer.
    expect(builderAfterRestart.has(VEHICLE_ID)).toBe(false);
    expect(await redis.get(`trip:builder:${VEHICLE_ID}`)).toBeNull();
    expect(await redis.get(`trip:id:${VEHICLE_ID}`)).toBeNull();
  });

  it('Scenario B — live buffer still references a Trip that was already finalized independently: finalize must not re-write points or re-finalize it', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);

    tripBuilder.start(VEHICLE_ID, {
      dbTripId: 'trip-B-closed', startSoc: 80,
      startLat: 48.0, startLon: 8.6, startOdometer: 1000,
      now: new Date(T0 * 1000),
    });
    tripBuilder.addPoint(VEHICLE_ID, gpsPoint({ tSec: T0, lat: 48.0, lon: 8.6, speed: 40 }), 0);
    tripBuilder.addPoint(VEHICLE_ID, gpsPoint({ tSec: T0 + 300, lat: 48.018, lon: 8.6, speed: 40 }), 300_000);

    await redis.set(`trip:id:${VEHICLE_ID}`, 'trip-B-closed', 'EX', 7200);

    // Postgres says this trip was already closed by someone else — endTime is set.
    const prisma = buildPrismaMock({
      id: 'trip-B-closed', vehicleId: VEHICLE_ID,
      startTime: new Date(T0 * 1000), startSoc: 80,
      endTime: new Date((T0 + 250) * 1000),
    });
    const detector = buildDetector(prisma, redis, tripBuilder);

    await (detector as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 75, latitude: 48.02, longitude: 8.6, odometer: 1002 },
      new Date((T0 + 400) * 1000),
      'trip-B-closed',
    );

    expect(prisma.tripPoint.createMany).not.toHaveBeenCalled();
    expect(prisma.trip.update).not.toHaveBeenCalled();
    expect(tripBuilder.has(VEHICLE_ID)).toBe(false);
    expect(await redis.get(`trip:builder:${VEHICLE_ID}`)).toBeNull();
    expect(await redis.get(`trip:id:${VEHICLE_ID}`)).toBeNull();
  });

  it('Scenario C (control) — a genuinely open Trip still finalizes normally: the fix must not reject legitimate finalization', async () => {
    const redis = buildRedisMock();
    const tripBuilder = new TripBuilderService(redis as any);

    tripBuilder.start(VEHICLE_ID, {
      dbTripId: 'trip-C-open', startSoc: 80,
      startLat: 48.0, startLon: 8.6, startOdometer: 1000,
      now: new Date(T0 * 1000),
    });
    tripBuilder.addPoint(VEHICLE_ID, gpsPoint({ tSec: T0, lat: 48.0, lon: 8.6, speed: 40 }), 0);
    tripBuilder.addPoint(VEHICLE_ID, gpsPoint({ tSec: T0 + 300, lat: 48.018, lon: 8.6, speed: 40 }), 300_000);

    const prisma = buildPrismaMock({
      id: 'trip-C-open', vehicleId: VEHICLE_ID,
      startTime: new Date(T0 * 1000), startSoc: 80,
      endTime: null,
    });
    const detector = buildDetector(prisma, redis, tripBuilder);

    await (detector as any).finalizeTripToDb(
      VEHICLE_ID,
      { soc: 75, latitude: 48.02, longitude: 8.6, odometer: 1002 },
      new Date((T0 + 400) * 1000),
      'trip-C-open',
    );

    expect(prisma.tripPoint.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ tripId: 'trip-C-open' })]),
      }),
    );
    expect(prisma.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'trip-C-open' },
        data: expect.objectContaining({ endTime: expect.any(Date) }),
      }),
    );
    // Legitimate finalize must still clear the live buffer/checkpoint.
    expect(tripBuilder.has(VEHICLE_ID)).toBe(false);
  });
});
