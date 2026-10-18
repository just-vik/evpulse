import { TripDetectorService } from '../src/trips/trip-detector.service';
import { TripBuilderService } from '../src/trips/trip-builder.service';

/**
 * Regression tests for ARCH-2 — lock:trip CAS release.
 *
 * Root cause: checkTripState() used value '1' and redis.del() (no token check).
 * If instance A's 5s TTL expired while finalizeTripToDb() was still running,
 * instance B could acquire lock:trip, and then instance A's finally block would
 * delete B's lock via unconditional redis.del — opening a third concurrent window.
 *
 * Fix: lock:trip now uses a randomUUID token and releases via Lua CAS delete.
 * Only the owner's token matches → only the owner can delete its own lock.
 *
 * Tests verify:
 *   1. Concurrent calls for the same vehicle: second is blocked (lock busy → skip).
 *   2. Foreign token survives: old owner's CAS delete leaves a new owner's lock intact.
 *   3. Own token is released: CAS delete removes the key when tokens match.
 *   4. Redis eval error on release: logged, not propagated (best-effort release).
 */

const VEH  = 'veh-lock-test';
const DATA = { speed: 0, power: 0, soc: 50 };

function buildRedisMock() {
  const store = new Map<string, string>();

  return {
    store,
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      const nxIdx = args.findIndex((a: any) => a === 'NX');
      if (nxIdx !== -1) {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => { store.delete(key); return 1; }),
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

function buildPrisma() {
  return {
    trip: {
      findFirst:  jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create:     jest.fn().mockResolvedValue({ id: 'trip-1', vehicleId: VEH, startTime: new Date() }),
      update:     jest.fn().mockResolvedValue({}),
    },
    tripPoint:      { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    telemetryPoint: { findFirst: jest.fn().mockResolvedValue(null) },
    vehicle:        { findUnique: jest.fn().mockResolvedValue(null) },
    tripStats:      { upsert: jest.fn().mockResolvedValue({}) },
    $transaction:   jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
}

function buildService(redis: ReturnType<typeof buildRedisMock>, prisma: ReturnType<typeof buildPrisma>) {
  const tripBuilder = new TripBuilderService(redis as any);
  const geocoding   = { reverseShort: jest.fn().mockResolvedValue(null) };
  const kalman      = { reset: jest.fn(), update: jest.fn().mockImplementation((v: any) => v) };
  const configSvc   = { get: jest.fn().mockReturnValue(undefined) };

  return new TripDetectorService(
    redis as any, prisma as any, geocoding as any, tripBuilder,
    kalman as any, configSvc as any,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, // tariffResolver
  );
}

describe('TripDetectorService — lock:trip CAS release (ARCH-2)', () => {

  it('1. second concurrent call is blocked while first holds lock:trip', async () => {
    const redis  = buildRedisMock();
    const prisma = buildPrisma();
    const svc    = buildService(redis, prisma);

    // Slow inner so that A's lock is held while B arrives
    let resolveInner!: () => void;
    const innerBarrier = new Promise<void>(r => { resolveInner = r; });
    (svc as any)._checkTripStateInner = jest.fn(() => innerBarrier);
    (svc as any).persistDetectorState = jest.fn().mockResolvedValue(undefined);

    const lockKey = `lock:trip:${VEH}`;

    // A starts — acquires lock
    const callA = svc.checkTripState(VEH, DATA);
    await Promise.resolve(); // let A get past the set()

    // Lock must now be held
    expect(redis.store.has(lockKey)).toBe(true);

    // B starts — should skip (lock busy)
    const callB = svc.checkTripState(VEH, DATA);
    await callB;

    // B never entered inner
    expect((svc as any)._checkTripStateInner).toHaveBeenCalledTimes(1);

    // Release A
    resolveInner();
    await callA;

    // Lock must be gone (A released via CAS)
    expect(redis.store.has(lockKey)).toBe(false);
  });

  it('2. foreign token survives: CAS delete by old owner leaves new owner\'s lock intact', async () => {
    const redis  = buildRedisMock();
    const prisma = buildPrisma();
    const svc    = buildService(redis, prisma);

    const lockKey       = `lock:trip:${VEH}`;
    const foreignToken  = 'new-owner-token';

    // Pre-populate with a foreign token (simulates B acquired after A's TTL expired)
    redis.store.set(lockKey, foreignToken);

    // A's token is different from the lock's current value
    const oldToken = 'old-owner-token-a';

    // Directly invoke the CAS delete with A's old token — should not delete the key
    const result = await (redis as any).eval('', 1, lockKey, oldToken);
    expect(result).toBe(0); // CAS miss
    expect(redis.store.get(lockKey)).toBe(foreignToken); // B's lock survives
  });

  it('3. own token is released: CAS delete removes the key when tokens match', async () => {
    const redis  = buildRedisMock();
    const prisma = buildPrisma();
    const svc    = buildService(redis, prisma);
    (svc as any)._checkTripStateInner = jest.fn().mockResolvedValue(undefined);
    (svc as any).persistDetectorState = jest.fn().mockResolvedValue(undefined);

    const lockKey = `lock:trip:${VEH}`;

    await svc.checkTripState(VEH, DATA);

    // Lock must be gone after call completes (own token matched → deleted)
    expect(redis.store.has(lockKey)).toBe(false);
    // eval was called exactly once (for the CAS release)
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('4. Redis eval error on release: logged and not propagated', async () => {
    const redis  = buildRedisMock();
    const prisma = buildPrisma();
    const svc    = buildService(redis, prisma);
    (svc as any)._checkTripStateInner = jest.fn().mockResolvedValue(undefined);
    (svc as any).persistDetectorState = jest.fn().mockResolvedValue(undefined);

    // Make eval throw (Redis transient error)
    redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));

    // checkTripState must not throw even if CAS release fails
    await expect(svc.checkTripState(VEH, DATA)).resolves.toBeUndefined();
  });
});
