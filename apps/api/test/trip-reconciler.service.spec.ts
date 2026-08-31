import { TripReconcilerService } from '../src/trips/trip-reconciler.service';

/** End times kept recent so `runManual` window (endTime < now−2m) includes them. */
function makeConsecutiveTrips(gapMs: number, distKm: number) {
  const now = Date.now();
  const bEnd   = new Date(now - 20 * 60_000);
  const bStart = new Date(bEnd.getTime() - 20 * 60_000);
  const aEnd   = new Date(bStart.getTime() - gapMs);
  const aStart = new Date(aEnd.getTime() - 30 * 60_000);

  const latOffset = distKm / 111;

  return [
    {
      id: 'trip-A',
      vehicleId: 'veh-1',
      startTime: aStart,
      endTime: aEnd,
      startSoc: 80,
      endSoc: 65,
      distanceKm: 20,
      energyUsedKwh: 5,
      efficiencyWhkm: 250,
      startLocation: null,
      endLocation: null,
      endLat: 55.0,
      endLon: 37.0,
      startLat: 54.8,
      startLon: 36.8,
    },
    {
      id: 'trip-B',
      vehicleId: 'veh-1',
      startTime: bStart,
      endTime: bEnd,
      startSoc: 65,
      endSoc: 55,
      distanceKm: 15,
      energyUsedKwh: 4,
      efficiencyWhkm: 260,
      startLocation: null,
      endLocation: null,
      endLat: 55.0 + latOffset * 2,
      endLon: 37.0,
      startLat: 55.0 + latOffset,
      startLon: 37.0,
    },
  ];
}

describe('TripReconcilerService merge rules', () => {
  /**
   * `chargingSessionRows` lets individual tests simulate a Supercharger/home-charging
   * session that occurred between trip A and trip B — the production `_reconcile()`
   * always calls `prisma.chargingSession.findFirst`, so the mock must implement it
   * (never silently stub it away) to actually exercise that guard.
   */
  function makePrismaForTrips(trips: any[], chargingSessionRows: any[] = []) {
    const config = { get: jest.fn().mockReturnValue(undefined) } as any;
    const prisma: any = {
      trip: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const endFilter = where.endTime;
          return Promise.resolve(
            trips.filter((t) => {
              if (where.vehicleId && t.vehicleId !== where.vehicleId) return false;
              if (!t.endTime) return false;
              if (endFilter?.gte && t.endTime < endFilter.gte) return false;
              if (endFilter?.lt && t.endTime >= endFilter.lt) return false;
              return true;
            }),
          );
        }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({
          vehicleSpec: { batteryUsableKwh: 75 },
          batteryCapacityDetected: null,
        }),
      },
      chargingSession: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          const match = chargingSessionRows.find((s) =>
            s.vehicleId === where.vehicleId &&
            s.startTime >= where.startTime.gte &&
            s.startTime <= where.startTime.lte &&
            s.endTime != null &&
            s.energyAddedKwh >= (where.energyAddedKwh?.gte ?? 0),
          );
          return Promise.resolve(match ? { id: match.id } : null);
        }),
      },
      // Signal-loss guard reads the last 3 points of trip A to check it was still
      // moving when it ended (not a genuine parking stop). Speed=40 keeps the
      // existing gap/proximity assertions exercising the code path they were
      // designed for, instead of short-circuiting on "trip_A_ended_parked".
      tripPoint: {
        findMany: jest.fn().mockResolvedValue([
          { speed: 40, timestamp: new Date() },
          { speed: 40, timestamp: new Date() },
          { speed: 40, timestamp: new Date() },
        ]),
      },
      $transaction: jest.fn(async (fn: any) => {
        const tx = {
          tripPoint: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          trip: {
            update: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({}),
          },
          tripStats: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        };
        await fn(tx);
        return undefined;
      }),
    };
    return { prisma, config };
  }

  it('merges on short gap even when GPS endpoints are far apart (traffic / drift)', async () => {
    const trips = makeConsecutiveTrips(2 * 60_000, 3.5);
    const { prisma, config } = makePrismaForTrips(trips);
    const svc = new TripReconcilerService(prisma, config);

    const { merged } = await svc.runManual('veh-1', 365);

    expect(merged).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('does not merge long gap with large geographic separation', async () => {
    const trips = makeConsecutiveTrips(5 * 60_000, 4.0);
    const { prisma, config } = makePrismaForTrips(trips);
    const svc = new TripReconcilerService(prisma, config);

    const { merged } = await svc.runManual('veh-1', 365);

    expect(merged).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('merges medium gap when end A is close to start B (multi-stop outing)', async () => {
    const trips = makeConsecutiveTrips(6 * 60_000, 1.5);
    const { prisma, config } = makePrismaForTrips(trips);
    const svc = new TripReconcilerService(prisma, config);

    const { merged } = await svc.runManual('veh-1', 365);

    expect(merged).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  // ── Charging guard ──────────────────────────────────────────────────────

  it('does not merge when a charging session >3 kWh occurred between the trips', async () => {
    // Same gap/proximity as the first (normally-merges) scenario.
    const trips = makeConsecutiveTrips(2 * 60_000, 3.5);
    const chargeStart = new Date(trips[0].endTime.getTime() + 30_000);
    const chargeEnd   = new Date(chargeStart.getTime() + 60_000);
    const chargingSessionRows = [{
      id: 'sess-1',
      vehicleId: 'veh-1',
      startTime: chargeStart,
      endTime: chargeEnd,
      energyAddedKwh: 5, // > 3 kWh threshold
    }];
    const { prisma, config } = makePrismaForTrips(trips, chargingSessionRows);
    const svc = new TripReconcilerService(prisma, config);

    const result = await svc.runManual('veh-1', 365);

    expect(result.merged).toBe(0);
    expect(result.skippedDueToCharging).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still merges when a charging session <=3 kWh occurred between the trips (below guard threshold)', async () => {
    const trips = makeConsecutiveTrips(2 * 60_000, 3.5);
    const chargeStart = new Date(trips[0].endTime.getTime() + 30_000);
    const chargeEnd   = new Date(chargeStart.getTime() + 60_000);
    const chargingSessionRows = [{
      id: 'sess-1',
      vehicleId: 'veh-1',
      startTime: chargeStart,
      endTime: chargeEnd,
      energyAddedKwh: 2, // <= 3 kWh — current business policy does not treat this as a real stop
    }];
    const { prisma, config } = makePrismaForTrips(trips, chargingSessionRows);
    const svc = new TripReconcilerService(prisma, config);

    const result = await svc.runManual('veh-1', 365);

    expect(result.merged).toBe(1);
    expect(result.skippedDueToCharging).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('a broken chargingSession.findFirst mock surfaces as a real error, not a silent pass', async () => {
    // Guards against the exact regression this spec file previously had: a Prisma mock
    // missing `chargingSession` entirely made every test throw instead of exercising
    // the guard. If chargingSession is undefined, production code must still throw.
    const trips = makeConsecutiveTrips(2 * 60_000, 3.5);
    const { prisma, config } = makePrismaForTrips(trips);
    delete prisma.chargingSession;
    const svc = new TripReconcilerService(prisma, config);

    await expect(svc.runManual('veh-1', 365)).rejects.toThrow();
  });

  // ── Max-gap policy — the actual cross-day safety mechanism ───────────────

  it('does not merge trips separated by more than the max gap, even with a wide scan window', async () => {
    // 25 h apart (e.g. two different days' home departures) but at the exact same
    // location — proximity alone would allow a merge, only the time gap should block it.
    const trips = makeConsecutiveTrips(25 * 60 * 60_000, 0.05);
    const { prisma, config } = makePrismaForTrips(trips);
    const svc = new TripReconcilerService(prisma, config);

    // days=365 — a wide scan window does not, by itself, cause a false merge.
    const result = await svc.runManual('veh-1', 365);

    expect(result.merged).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
