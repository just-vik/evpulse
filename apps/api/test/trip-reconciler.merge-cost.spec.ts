import { TripReconcilerService } from '../src/trips/trip-reconciler.service';

/**
 * Regression tests for ARCH-4 Finding B — stale costTotal after trip merge.
 *
 * Root cause: `tx.trip.update` in the merge transaction did not include `costTotal`.
 * Trip A's original `costTotal` was calculated from its own `energyUsedKwh`, but
 * after merging trip B, `energyUsedKwh` is recalculated from the combined SOC drop.
 * The stored `costTotal` no longer matches the stored `energyUsedKwh` — a silent
 * financial accuracy error.
 *
 * Fix: add `costTotal: null` to the merge transaction's `trip.update` data block.
 * `null` is the canonical "not calculated" sentinel used throughout the platform;
 * it makes the stale cost visible to the post-processor and cost-backfill pipeline.
 *
 * Tests verify:
 *   1. Merged trip has costTotal = null.
 *   2. Recalculated fields (energyUsedKwh, endTime, efficiencyWhkm, etc.) are correct.
 *   3. Transaction error propagates; no separate update is made outside the transaction.
 */

const VEH = 'veh-rec-1';

// Gap = 0 ms (trip B starts exactly when trip A ends) → shortGapMs guard is skipped.
// Default shortGapMs = 3 min; 0 < 3 min → signal-loss and proximity checks are bypassed.
function buildTrips() {
  const T = Date.now() - 5 * 3600_000; // well in the past; won't hit the 2-min recent filter
  const tripA = {
    id:             'trip-a',
    vehicleId:      VEH,
    startTime:      new Date(T - 2 * 3600_000),
    endTime:        new Date(T - 1 * 3600_000),
    distanceKm:     20,
    energyUsedKwh:  3.75,
    efficiencyWhkm: 187.5,
    startSoc:       90,
    endSoc:         85,
    startLocation:  'Start A',
    endLocation:    'End A',
    startLat:       50.0,
    startLon:       8.4,
    endLat:         50.1,
    endLon:         8.4,
  };
  const tripB = {
    id:             'trip-b',
    vehicleId:      VEH,
    startTime:      new Date(T - 1 * 3600_000), // gap = 0 → skips signal-loss guard
    endTime:        new Date(T),
    distanceKm:     20,
    energyUsedKwh:  3.75,
    efficiencyWhkm: 187.5,
    startSoc:       85,
    endSoc:         80,
    startLocation:  'Start B',
    endLocation:    'End B',
    startLat:       50.1,
    startLon:       8.4,
    endLat:         50.2,
    endLon:         8.4,
  };
  return [tripA, tripB];
}

function buildPrisma(trips: ReturnType<typeof buildTrips>) {
  const txUpdate     = jest.fn().mockResolvedValue({});
  const txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const txDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const txDelete     = jest.fn().mockResolvedValue({});

  const txMock = {
    tripPoint: { updateMany: txUpdateMany },
    trip:      { update: txUpdate, delete: txDelete },
    tripStats: { deleteMany: txDeleteMany },
  };

  const prisma = {
    trip: {
      findMany: jest.fn().mockResolvedValue(trips),
      update:   jest.fn().mockResolvedValue({}),
    },
    tripPoint: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id:                       VEH,
        batteryCapacityDetected:  75,
        vehicleSpec:              null,
      }),
    },
    chargingSession: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockImplementation(async (callback: (tx: any) => any) =>
      callback(txMock),
    ),
  };

  return { prisma, txMock, txUpdate, txUpdateMany, txDeleteMany, txDelete };
}

function buildService(prisma: any) {
  const configService = { get: jest.fn().mockReturnValue(undefined) };
  return new TripReconcilerService(prisma as any, configService as any);
}

describe('TripReconcilerService — costTotal = null after merge (ARCH-4)', () => {

  it('1. merged trip has costTotal = null', async () => {
    const trips = buildTrips();
    const { prisma, txUpdate } = buildPrisma(trips);
    const svc = buildService(prisma);

    const result = await svc.runManual(VEH, 30);

    expect(result.merged).toBe(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate.mock.calls[0][0].data.costTotal).toBeNull();
  });

  it('2. recalculated fields are correct after merge', async () => {
    const trips = buildTrips();
    const { prisma, txUpdate } = buildPrisma(trips);
    const svc = buildService(prisma);

    await svc.runManual(VEH, 30);

    const data = txUpdate.mock.calls[0][0].data;
    // Structural fields from trip B
    expect(data.endTime).toEqual(trips[1].endTime);
    expect(data.endSoc).toBe(trips[1].endSoc);      // 80
    expect(data.endLocation).toBe('End B');
    // Distance: 20 + 20 = 40 km
    expect(data.distanceKm).toBe(40);
    // Energy: (90 − 80) / 100 × 75 = 7.5 kWh
    expect(data.energyUsedKwh).toBeCloseTo(7.5, 2);
    // Efficiency: 7500 Wh / 40 km = 187.5 Wh/km
    expect(data.efficiencyWhkm).toBeCloseTo(187.5, 1);
    // Post-processor flags reset
    expect(data.reliability).toBeNull();
    expect(data.repairReason).toBeNull();
    expect(data.qualityScore).toBeNull();
    // reconcileAt is a future Date
    expect(data.reconcileAt).toBeInstanceOf(Date);
    expect(data.reconcileAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('3. $transaction error propagates; no separate trip.update is made', async () => {
    const trips = buildTrips();
    const { prisma } = buildPrisma(trips);
    prisma.$transaction.mockRejectedValue(new Error('deadlock detected'));
    const svc = buildService(prisma);

    await expect(svc.runManual(VEH, 30)).rejects.toThrow('deadlock detected');
    // No update was issued outside the transaction
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });
});
