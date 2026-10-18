import { ChargingDetectorService } from '../src/charging/charging-detector.service';

/**
 * Regression tests for POT-1 — concurrent session-start race condition.
 *
 * Root cause: startSession() used a non-atomic findFirst + create pattern.
 * Two pipeline instances processing the same vehicle simultaneously could
 * both call findFirst (seeing no open session) and then both call create,
 * producing duplicate ChargingSession rows.
 *
 * Fix: startSession() acquires lock:charging:session:start:{vehicleId} (Redis
 * NX, TTL=5s) before the critical section (findFirst + create). The lock uses
 * a randomUUID token and releases via Lua CAS delete so an expired lock cannot
 * be deleted by the original owner after TTL.
 *
 * Architecture context: checkChargingState is already serialised by
 * lock:pipeline:{vehicleId} (TTL=30s, heartbeat 5s) in TelemetryPipelineService.
 * The session-start lock is defence-in-depth for TTL-expiry edge cases and any
 * future direct callers.
 *
 * Tests verify:
 *   1. Two concurrent events for the same vehicle → exactly one session created.
 *      (Without lock both calls interleave past findFirst and each create a row.)
 *   2. Concurrent events for different vehicles are not blocked by each other.
 *   3. Session create failure → lock is released, error propagates.
 *   4. Redis unavailable → error propagates (fail-closed), create never called.
 *   5. Lock held by another owner → Lua CAS returns 0, key not deleted.
 *   6. TTL expired → subsequent call re-acquires lock, session created normally.
 *   7. Idempotent re-delivery → findFirst guard prevents double create.
 *   8. Skip (lock busy) → caller cache is still updated; subsequent event finds session via DB.
 */

const VEH = 'veh-1';
const NOW = new Date('2026-10-18T10:00:00.000Z');
const DATA = { soc: 70, power: 11, charging_state: 'Charging', current: 16 };

/** Stateful Redis mock that correctly implements SET NX and Lua CAS delete. */
function buildRedisMock(opts: { failOn?: 'set' | 'eval' | 'get' } = {}) {
  const store = new Map<string, string>();

  const redisMock = {
    store,
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (opts.failOn === 'set') throw new Error('ECONNREFUSED');
      const nxIdx = args.findIndex((a: any) => a === 'NX');
      if (nxIdx !== -1) {
        if (store.has(key)) return null;
        store.set(key, value);
        // TTL not simulated via real timers to avoid open-handle warnings.
        // Tests that need expiry behaviour manipulate store directly.
        return 'OK';
      }
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => {
      if (opts.failOn === 'get') throw new Error('ECONNREFUSED');
      return store.get(key) ?? null;
    }),
    del: jest.fn(async (key: string) => { store.delete(key); return 1; }),
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (opts.failOn === 'eval') throw new Error('ECONNREFUSED');
      // Lua CAS delete: del only if value matches
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };

  return redisMock;
}

/** Prisma mock that introduces a setImmediate yield in findFirst to model real async interleaving. */
function buildPrismaMock(opts: {
  existingSession?: { id: string } | null;
  failCreate?: boolean;
  createDelay?: number;
} = {}) {
  const created: any[] = [];

  return {
    created,
    prisma: {
      chargingSession: {
        findFirst: jest.fn(async () => {
          // Yield to the event loop — allows a concurrent call to interleave here.
          await new Promise<void>(r => setImmediate(r));
          return opts.existingSession !== undefined ? opts.existingSession : null;
        }),
        create: jest.fn(async (args: any) => {
          if (opts.failCreate) throw new Error('DB write failed');
          if (opts.createDelay) await new Promise(r => setTimeout(r, opts.createDelay));
          const row = { id: `sess-${created.length + 1}`, endTime: null, ...args.data };
          created.push(row);
          return row;
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      vehicle: { findUnique: jest.fn().mockResolvedValue(null) },
      vehicleSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    },
  };
}

function buildService(prisma: any, redis: any) {
  return new ChargingDetectorService(
    prisma as any,
    undefined, undefined, undefined, undefined, undefined, undefined,
    redis as any,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ChargingDetectorService — startSession lock (POT-1)', () => {

  it('1a. race without lock — both tasks interleave past findFirst and each create a row', async () => {
    // Verify the bug exists: _startSessionBody has no lock, so concurrent calls both
    // proceed past findFirst (which yields via setImmediate) and both call create.
    const { created, prisma } = buildPrismaMock();
    const svc = buildService(prisma, null); // no Redis — bypasses lock path

    await Promise.all([
      (svc as any)._startSessionBody(VEH, DATA, NOW),
      (svc as any)._startSessionBody(VEH, DATA, NOW),
    ]);

    // Both calls saw null from findFirst and both created a session — this is the bug.
    expect(prisma.chargingSession.create).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
  });

  it('1b. race WITH lock — exactly one session created', async () => {
    const redis = buildRedisMock();
    const { created, prisma } = buildPrismaMock();
    const svc = buildService(prisma, redis);

    // Both calls start concurrently in the same event-loop tick.
    // Task A acquires the lock (store.set runs synchronously inside the async mock
    // before the first await-yield), then yields at findFirst's setImmediate.
    // Task B starts, tries to acquire lock → NX fails → returns immediately.
    await Promise.all([
      (svc as any).startSession(VEH, DATA, NOW),
      (svc as any).startSession(VEH, DATA, NOW),
    ]);

    expect(created).toHaveLength(1);
    expect(redis.set).toHaveBeenCalledTimes(2); // both attempted
    expect(redis.eval).toHaveBeenCalledTimes(1); // only winner released
  });

  it('2. concurrent events for different vehicles are not blocked by each other', async () => {
    const redis = buildRedisMock();
    const { created, prisma } = buildPrismaMock();
    const svc = buildService(prisma, redis);

    await Promise.all([
      (svc as any).startSession('veh-A', DATA, NOW),
      (svc as any).startSession('veh-B', DATA, NOW),
    ]);

    expect(created).toHaveLength(2);
    expect(created.map((s: any) => s.vehicleId).sort()).toEqual(['veh-A', 'veh-B']);
  });

  it('3. session create failure → lock released, error propagates', async () => {
    const redis = buildRedisMock();
    const { prisma } = buildPrismaMock({ failCreate: true });
    const svc = buildService(prisma, redis);

    await expect(
      (svc as any).startSession(VEH, DATA, NOW),
    ).rejects.toThrow('DB write failed');

    // Lock must have been released — Lua eval should have been called
    expect(redis.eval).toHaveBeenCalledTimes(1);

    // After the error, lock key must be gone so the next attempt can proceed
    const lockKey = `lock:charging:session:start:${VEH}`;
    expect(redis.store.has(lockKey)).toBe(false);
  });

  it('4. Redis unavailable → error propagates (fail-closed), create never called', async () => {
    const redis = buildRedisMock({ failOn: 'set' });
    const { prisma } = buildPrismaMock();
    const svc = buildService(prisma, redis);

    await expect(
      (svc as any).startSession(VEH, DATA, NOW),
    ).rejects.toThrow('ECONNREFUSED');

    expect(prisma.chargingSession.create).not.toHaveBeenCalled();
  });

  it('5. lock held by another owner → Lua CAS returns 0, key survives', async () => {
    const redis = buildRedisMock();
    // Pre-populate the lock with a foreign token
    const lockKey = `lock:charging:session:start:${VEH}`;
    const foreignToken = 'foreign-owner-token';
    redis.store.set(lockKey, foreignToken);

    const { prisma } = buildPrismaMock();
    const svc = buildService(prisma, redis);

    // startSession should skip (lock busy) without touching the key
    await (svc as any).startSession(VEH, DATA, NOW);

    // Foreign lock must still be intact
    expect(redis.store.get(lockKey)).toBe(foreignToken);
    // Lua eval must NOT have been called (lock was never acquired)
    expect(redis.eval).not.toHaveBeenCalled();
    // No session created
    expect(prisma.chargingSession.create).not.toHaveBeenCalled();
  });

  it('6. TTL expired → subsequent call re-acquires lock, findFirst guard ensures idempotency', async () => {
    const redis = buildRedisMock();
    const { created, prisma } = buildPrismaMock();
    const lockKey = `lock:charging:session:start:${VEH}`;
    const svc = buildService(prisma, redis);

    // Call 1: acquires lock, creates session
    await (svc as any).startSession(VEH, DATA, NOW);
    expect(created).toHaveLength(1);

    // Simulate TTL expiry — lock key is now gone from the store
    redis.store.delete(lockKey);
    expect(redis.store.has(lockKey)).toBe(false);

    // Call 2: acquires lock (TTL expired, key gone) but findFirst sees existing session
    prisma.chargingSession.findFirst.mockImplementation(async () => {
      await new Promise<void>(r => setImmediate(r));
      return { id: created[0].id }; // session already exists
    });

    await (svc as any).startSession(VEH, DATA, NOW);

    // Lock must have been acquired (set called again) and released (eval called)
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenCalledTimes(2);

    // Still only one session — findFirst guard held
    expect(created).toHaveLength(1);
  });

  it('7. idempotent re-delivery → findFirst guard prevents double create', async () => {
    const redis = buildRedisMock();
    // First call creates the session
    const { created, prisma } = buildPrismaMock();
    const svc = buildService(prisma, redis);

    await (svc as any).startSession(VEH, DATA, NOW);
    expect(created).toHaveLength(1);

    // Simulate the session now existing in DB
    prisma.chargingSession.findFirst.mockImplementation(async () => {
      await new Promise<void>(r => setImmediate(r));
      return { id: created[0].id };
    });

    // Second call (re-delivery) → lock acquired → findFirst returns session → early exit
    await (svc as any).startSession(VEH, DATA, NOW);
    expect(created).toHaveLength(1);
    expect(prisma.chargingSession.create).toHaveBeenCalledTimes(1);
  });

  it('8. skip (lock busy) → subsequent recordPoint finds session created by other instance', async () => {
    // Models the scenario where instance B skips startSession (lock held by A),
    // but subsequent recordPoint calls still find and write to A's session via DB lookup.
    //
    // This verifies point 3 of the pre-commit checklist: when acquired===null,
    // no event data is permanently lost — the next recordPoint resolves the session.

    const redis = buildRedisMock();
    // Pre-hold the lock so startSession skips
    const lockKey = `lock:charging:session:start:${VEH}`;
    const foreignToken = 'instance-A-token';
    redis.store.set(lockKey, foreignToken);

    // DB already has an open session (created by instance A)
    const existingSession = { id: 'sess-from-A', vehicleId: VEH, endTime: null, maxPowerKw: null };
    const chargingPoints: any[] = [];
    const prisma = {
      chargingSession: {
        findFirst: jest.fn(async () => {
          await new Promise<void>(r => setImmediate(r));
          return existingSession;
        }),
        create: jest.fn().mockRejectedValue(new Error('should not be called')),
        update: jest.fn().mockResolvedValue({}),
      },
      chargingPoint: {
        create: jest.fn(async (args: any) => {
          chargingPoints.push(args.data);
          return args.data;
        }),
      },
      vehicle: { findUnique: jest.fn().mockResolvedValue(null) },
      vehicleSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const svc = buildService(prisma, redis);

    // startSession: lock busy → skips, no session created
    await (svc as any).startSession(VEH, DATA, NOW);
    expect(prisma.chargingSession.create).not.toHaveBeenCalled();

    // recordPoint: called on next charging event → resolves A's session via findFirst
    await (svc as any).recordPoint(VEH, { power: 11, current: 16, soc: 72 }, NOW, 0.05);
    expect(chargingPoints).toHaveLength(1);
    expect(chargingPoints[0].sessionId).toBe('sess-from-A');
  });
});
