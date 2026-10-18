import { TripPostProcessorService } from '../src/trips/trip-post-processor.service';

/**
 * Tests for TripPostProcessorService.processMissingCost() — costTotal backfill (POT-2 follow-up).
 *
 * Root cause: multiple paths leave costTotal = null on a completed trip:
 *   - Transient tariff failure during finalizeTripToDb (POT-2)
 *   - Transient tariff failure during gap recovery (ARCH-4A)
 *   - Every merge in TripReconcilerService (ARCH-4B — always nulls on merge)
 *
 * Fix: processMissingCost() runs after processUnrated() in autoRepairTrips() (every 10 min).
 * It fetches up to 50 trips with costTotal = null AND energyUsedKwh > 0, resolves the current
 * tariff rate for each, and writes costTotal with a CAS-style updateMany so a concurrent
 * process's write is never overwritten.
 *
 * Rate policy: current tariff (VehicleSettings.homeChargingRate or canonicalDefaultRate).
 * Not guaranteed historically accurate — acknowledged limitation documented on the method.
 *
 * Tests verify:
 *   1. costTotal = null, positive energy → cost calculated and written.
 *   2. Resolver throws → trip left null for next run (loop continues).
 *   3. energyUsedKwh = null or 0 → trip not selected (WHERE filter).
 *   4. costTotal set by another process after fetch → updateMany.count = 0, not overwritten.
 *   5. Limit is respected.
 *   6. Tariff error on one trip does not abort others.
 *   7. DB updateMany error propagates — not masked by tariff catch block.
 */

const VEH = 'veh-backfill-1';

function buildTrip(id: string, energyUsedKwh: number | null) {
  return { id, vehicleId: VEH, energyUsedKwh };
}

function buildPrisma(trips: ReturnType<typeof buildTrip>[]) {
  const updateManyResult = { count: 1 };
  const prisma = {
    trip: {
      findMany:    jest.fn().mockResolvedValue(trips),
      updateMany:  jest.fn().mockResolvedValue(updateManyResult),
    },
  };
  return prisma;
}

function buildService(
  prisma: any,
  tariffResolver?: { resolve: jest.Mock },
) {
  // Position 4 — @Optional() deliberately absent; undefined passed for positions 2 and 3
  return new TripPostProcessorService(
    prisma as any,
    undefined,   // mapMatching
    undefined,   // geocoding
    tariffResolver as any,
  );
}

describe('TripPostProcessorService — processMissingCost (costTotal backfill)', () => {

  it('1. costTotal null, positive energy → cost written using current tariff rate', async () => {
    const prisma = buildPrisma([buildTrip('trip-1', 5.0)]);
    const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.processMissingCost();

    expect(result.repaired).toBe(1);
    expect(prisma.trip.updateMany).toHaveBeenCalledWith({
      where: { id: 'trip-1', costTotal: null },
      data:  { costTotal: 1.75 }, // round(5.0 * 0.35 * 100) / 100
    });
  });

  it('2. resolver throws → trip stays null, loop continues to remaining trips', async () => {
    const prisma = buildPrisma([
      buildTrip('trip-fail', 5.0),
      buildTrip('trip-ok',   5.0),
    ]);
    const tariffResolver = {
      resolve: jest.fn()
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce({ rate: 0.35 }),
    };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.processMissingCost();

    expect(result.repaired).toBe(1);
    // trip-fail was skipped (resolver threw) — no update for it
    const updatedIds = (prisma.trip.updateMany as jest.Mock).mock.calls.map((c: any) => c[0].where.id);
    expect(updatedIds).not.toContain('trip-fail');
    expect(updatedIds).toContain('trip-ok');
  });

  it('3. WHERE filter excludes trips with null or zero energyUsedKwh', async () => {
    // Trips with null/0 energy must not reach the tariff call.
    // Verified by asserting the findMany WHERE clause is correct.
    const prisma = buildPrisma([]); // empty result — filtered out at DB level
    const tariffResolver = { resolve: jest.fn() };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.processMissingCost();

    expect(result.repaired).toBe(0);
    expect(tariffResolver.resolve).not.toHaveBeenCalled();
    const whereArg = (prisma.trip.findMany as jest.Mock).mock.calls[0][0].where;
    expect(whereArg.energyUsedKwh).toEqual({ not: null, gt: 0 });
    expect(whereArg.costTotal).toBeNull();
    expect(whereArg.endTime).toEqual({ not: null });
  });

  it('4. costTotal set concurrently → updateMany.count = 0, existing value preserved', async () => {
    const prisma = buildPrisma([buildTrip('trip-race', 5.0)]);
    // Simulate concurrent write: updateMany reports 0 rows changed (costTotal was already set)
    (prisma.trip.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.processMissingCost();

    expect(result.repaired).toBe(0);
    // updateMany WAS called (tariff resolved OK) but with costTotal: null guard in WHERE
    expect(prisma.trip.updateMany).toHaveBeenCalledWith({
      where: { id: 'trip-race', costTotal: null },
      data:  expect.objectContaining({ costTotal: expect.any(Number) }),
    });
  });

  it('5. limit is respected — findMany is called with take = limit', async () => {
    const prisma = buildPrisma([]); // result doesn't matter
    const tariffResolver = { resolve: jest.fn() };
    const svc = buildService(prisma, tariffResolver);

    await svc.processMissingCost(undefined, 2);

    expect(prisma.trip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
  });

  it('6. tariff error on one trip → other trips still processed', async () => {
    const prisma = buildPrisma([
      buildTrip('trip-a', 4.0),
      buildTrip('trip-b', 6.0),
      buildTrip('trip-c', 2.5),
    ]);
    const tariffResolver = {
      resolve: jest.fn()
        .mockRejectedValueOnce(new Error('network error')) // trip-a fails
        .mockResolvedValue({ rate: 0.35 }),                // trip-b, trip-c succeed
    };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.processMissingCost();

    expect(result.repaired).toBe(2);
    expect(prisma.trip.updateMany).toHaveBeenCalledTimes(2);
    const ids = (prisma.trip.updateMany as jest.Mock).mock.calls.map((c: any) => c[0].where.id);
    expect(ids).toEqual(['trip-b', 'trip-c']); // trip-a skipped
  });

  it('7. DB updateMany error propagates — not masked by tariff catch block', async () => {
    const prisma = buildPrisma([buildTrip('trip-db-err', 5.0)]);
    (prisma.trip.updateMany as jest.Mock).mockRejectedValue(new Error('connection reset'));
    const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
    const svc = buildService(prisma, tariffResolver);

    // DB error must propagate out of processMissingCost — not absorbed by the tariff catch
    await expect(svc.processMissingCost()).rejects.toThrow('connection reset');
  });
});
