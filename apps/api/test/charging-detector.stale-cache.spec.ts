import { ChargingDetectorService } from '../src/charging/charging-detector.service';

/**
 * Regression test for stale-cache bug discovered 2026-10-18.
 *
 * Root cause: closeStaleChargingSessions() (TripCleanupService cron, every 20 min)
 * force-closes charging sessions in DB after 8+ hours of inactivity, but does NOT
 * reset the in-memory cache of ChargingDetectorService. When telemetry for a NEW
 * charging session (e.g. Supercharger) arrives later, checkChargingState() finds
 * isCharging=true in the cache and routes to the ACTIVE CHARGING branch instead of
 * SESSION START. recordPoint() then finds no open session in DB and silently returns,
 * so the new session is never created.
 *
 * Fix: when recordPoint() finds no open session in DB but the cache says
 * isCharging=true, reset the cache to isCharging=false. The NEXT active telemetry
 * point will then correctly enter SESSION START.
 *
 * Tests verify:
 *   1. recordPoint() resets stale isCharging=true cache when no open session in DB.
 *   2. The telemetry point AFTER the stale-cache reset opens a new session.
 *   3. Normal path (open session exists) still records the point and does not reset.
 */

describe('ChargingDetectorService — stale cache reset after watchdog close', () => {

  function makeTs(offsetSec: number) {
    return new Date(Date.now() - 3600_000 + offsetSec * 1000).toISOString();
  }

  function buildService(opts: {
    openSession?: { id: string; maxPowerKw: number | null } | null;
  } = {}) {
    const sessions: any[] = [];
    const points:   any[] = [];
    const openSession = opts.openSession !== undefined ? opts.openSession : null;

    const prisma = {
      chargingSession: {
        // Used by cold-start cache restore (returns nothing → no cached state seeded)
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where?.endTime === null) return Promise.resolve(openSession ?? null);
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }: any) => {
          const sess = { id: `sess-${sessions.length + 1}`, endTime: null, chargerType: 'tesla_sc', ...data };
          sessions.push(sess);
          // After creation, findFirst should return the new session
          (prisma.chargingSession.findFirst as jest.Mock).mockResolvedValue(sess);
          return Promise.resolve(sess);
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      chargingPoint: {
        create: jest.fn().mockImplementation((args: any) => {
          points.push(args.data);
          return Promise.resolve({ id: 'pt-1', ...args.data });
        }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ batteryCapacityDetected: 75 }),
      },
      vehicleSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };

    const service = new ChargingDetectorService(prisma as any);
    return { service, sessions, points, prisma };
  }

  /** Seed the in-memory cache to isCharging=true (simulates state before watchdog fired). */
  async function seedStaleCache(service: ChargingDetectorService, vehicleId: string) {
    // Call with an open-session mock so the first point creates cache with isCharging=true
    const prismaWithSession = {
      chargingSession: {
        findFirst: jest.fn().mockResolvedValue({ id: 'old-sess', maxPowerKw: 2 }),
      },
      chargingPoint: { create: jest.fn().mockResolvedValue({ id: 'pt-0' }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    // Inject a temporary prisma to get the cache seeded
    (service as any).prisma = prismaWithSession;
    await service.checkChargingState(vehicleId, {
      charging_state: 'Charging', power: 2, current: 8, soc: 27, speed: 0,
      timestamp: makeTs(-3600),
    });
    // Now swap in the real prisma (where the session is already closed = not found)
  }

  it('1. recordPoint resets stale isCharging=true cache when no open session in DB', async () => {
    const { service, sessions, prisma } = buildService({ openSession: null });

    // Seed cache so isCharging=true (mimics state after home charging + before watchdog close)
    await seedStaleCache(service, 'veh-stale');

    // Restore no-open-session prisma after seeding
    (service as any).prisma = prisma;

    // Simulate first SC telemetry arriving — isCharging=true in cache, no open session in DB
    await service.checkChargingState('veh-stale', {
      charging_state: 'Charging', power: 67, current: 0, soc: 65, speed: 0,
      charge_energy_added: 29.3,
      timestamp: makeTs(0),
    });

    // No new session should have been created (current point is in ACTIVE branch)
    expect(sessions).toHaveLength(0);

    // But cache must now be isCharging=false (reset by recordPoint)
    const cache = (service as any).cache.get('veh-stale');
    expect(cache).toBeDefined();
    expect(cache.isCharging).toBe(false);
  });

  it('2. telemetry point after cache reset opens a new session', async () => {
    const { service, sessions, prisma } = buildService({ openSession: null });
    await seedStaleCache(service, 'veh-stale-2');
    (service as any).prisma = prisma;

    // First SC point — stale cache → recordPoint resets it
    await service.checkChargingState('veh-stale-2', {
      charging_state: 'Charging', power: 67, current: 0, soc: 65, speed: 0,
      charge_energy_added: 29.3,
      timestamp: makeTs(0),
    });

    // Second SC point — cache is now isCharging=false → SESSION START
    await service.checkChargingState('veh-stale-2', {
      charging_state: 'Charging', power: 62, current: 0, soc: 69, speed: 0,
      charge_energy_added: 32.56,
      timestamp: makeTs(240),
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].startSoc).toBe(69);
  });

  it('3. normal path: open session exists → point recorded, cache NOT reset', async () => {
    const existingSession = { id: 'live-sess', maxPowerKw: 50 };
    const { service, sessions, points } = buildService({ openSession: existingSession });

    // Seed normal isCharging=true via first point
    await service.checkChargingState('veh-normal', {
      charging_state: 'Charging', power: 67, current: 0, soc: 65, speed: 0,
      timestamp: makeTs(-60),
    });

    // Second point — open session still exists
    await service.checkChargingState('veh-normal', {
      charging_state: 'Charging', power: 62, current: 0, soc: 69, speed: 0,
      timestamp: makeTs(0),
    });

    // Cache should remain isCharging=true (no stale reset)
    const cache = (service as any).cache.get('veh-normal');
    expect(cache?.isCharging).toBe(true);

    // A charging point should have been recorded (at least one)
    expect(points.length).toBeGreaterThan(0);
    // No extra sessions created (we already had one via seed)
    expect(sessions).toHaveLength(0);
  });
});
