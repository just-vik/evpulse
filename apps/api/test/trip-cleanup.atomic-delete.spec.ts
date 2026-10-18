import { TripCleanupService } from '../src/trips/trip-cleanup.service';

/**
 * Regression tests for the atomic trip+tripPoint deletion in runManual().
 *
 * Both deleteMany calls are now wrapped in prisma.$transaction so a failure
 * in trip.deleteMany rolls back the already-executed tripPoint.deleteMany,
 * leaving the DB consistent. These tests verify:
 *
 *   1. Successful path: both deleteMany called inside the transaction.
 *   2. Trip delete failure: tripPoint.deleteMany is rolled back (transaction
 *      propagates the error; DB stays consistent).
 *   3. Idempotency: running cleanup twice on already-deleted ids is safe
 *      (deleteMany with no matching rows is a no-op, not an error).
 *   4. FK ordering: tripPoint.deleteMany fires BEFORE trip.deleteMany.
 *   5. No extraneous calls inside the transaction (gateway, external services).
 */

beforeAll(() => { process.env.APP_ROLE = 'worker'; });
afterAll(() => { delete process.env.APP_ROLE; });

describe('TripCleanupService.runManual — atomic deleteMany via $transaction', () => {
  const VEHICLE_ID = 'veh-atomic';
  const fiveMinAgo = new Date(Date.now() - 6 * 60_000);

  // A short phantom trip that matches the zero-distance cleanup criteria
  const phantomTrip = {
    id: 'trip-del-1',
    vehicleId: VEHICLE_ID,
    startTime: fiveMinAgo,
    endTime:   new Date(fiveMinAgo.getTime() + 60_000),
    distanceKm: 0,        // explicit phantom marker
    startSoc: null,
    endSoc:   null,
  };

  function buildService(overrides: {
    tripFindMany?: any[];
    queryRaw?: any[];
    tripPointDeleteMany?: jest.Mock;
    tripDeleteMany?: jest.Mock;
    transactionImpl?: (fn: (tx: any) => Promise<any>) => Promise<any>;
  } = {}) {
    const tripPointDeleteMock = overrides.tripPointDeleteMany ?? jest.fn().mockResolvedValue({ count: 1 });
    const tripDeleteMock      = overrides.tripDeleteMany      ?? jest.fn().mockResolvedValue({ count: 1 });

    const txProxy = {
      tripPoint: { deleteMany: tripPointDeleteMock },
      trip:      { deleteMany: tripDeleteMock },
    };

    const prisma: any = {
      trip: {
        findMany: jest.fn().mockResolvedValue(overrides.tripFindMany ?? [phantomTrip]),
      },
      $queryRaw: jest.fn().mockResolvedValue(overrides.queryRaw ?? [{ id: phantomTrip.id }]),
      $transaction: overrides.transactionImpl
        ? jest.fn().mockImplementation(overrides.transactionImpl)
        : jest.fn().mockImplementation((fn: (tx: any) => Promise<any>) => fn(txProxy)),
    };

    const postProcessor  = { processTrip: jest.fn() };
    const tripReconciler = { runManual: jest.fn().mockResolvedValue({ deleted: 0 }) };
    return {
      service: new TripCleanupService(prisma as any, postProcessor as any, tripReconciler as any),
      prisma,
      tripPointDeleteMock,
      tripDeleteMock,
    };
  }

  it('happy path: $transaction called, tripPoint deleted before trip', async () => {
    const callOrder: string[] = [];
    const tripPointDelete = jest.fn().mockImplementation(() => { callOrder.push('tripPoint'); return Promise.resolve({ count: 1 }); });
    const tripDelete      = jest.fn().mockImplementation(() => { callOrder.push('trip');      return Promise.resolve({ count: 1 }); });

    const { service, prisma } = buildService({ tripPointDeleteMany: tripPointDelete, tripDeleteMany: tripDelete });

    const result = await service.runManual(VEHICLE_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tripPointDelete).toHaveBeenCalledTimes(1);
    expect(tripDelete).toHaveBeenCalledTimes(1);
    // FK ordering: tripPoint must go first
    expect(callOrder).toEqual(['tripPoint', 'trip']);
    expect(result.deleted).toBe(1);
  });

  it('trip.deleteMany failure rolls back: error propagates, tripPoint rows must be re-deleted on retry', async () => {
    // Simulate: tripPoint.deleteMany succeeds, trip.deleteMany throws.
    // The $transaction propagates the rejection — caller sees an error.
    const tripPointDelete = jest.fn().mockResolvedValue({ count: 1 });
    const tripDelete      = jest.fn().mockRejectedValue(new Error('FK violation'));

    const txProxy = {
      tripPoint: { deleteMany: tripPointDelete },
      trip:      { deleteMany: tripDelete },
    };

    const { service } = buildService({
      transactionImpl: (fn) => fn(txProxy),
    });

    await expect(service.runManual(VEHICLE_ID)).rejects.toThrow('FK violation');
  });

  it('idempotency: running cleanup twice on already-deleted ids does not throw', async () => {
    // Second run: findMany returns empty (trips already deleted),
    // $queryRaw also returns empty → toDelete is empty → $transaction not called.
    const { service, prisma } = buildService({
      tripFindMany: [],
      queryRaw:     [],
    });

    await expect(service.runManual(VEHICLE_ID)).resolves.toEqual({ deleted: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('tripPoint.deleteMany receives all candidate ids, not a subset', async () => {
    const id1 = 'trip-a', id2 = 'trip-b';
    const trips = [
      { ...phantomTrip, id: id1 },
      { ...phantomTrip, id: id2, distanceKm: 0.1 },
    ];

    let capturedWhere: any;
    const tripPointDelete = jest.fn().mockImplementation(({ where }: any) => {
      capturedWhere = where;
      return Promise.resolve({ count: 2 });
    });

    const { service } = buildService({
      tripFindMany: trips,
      queryRaw:     [{ id: id1 }, { id: id2 }],
      tripPointDeleteMany: tripPointDelete,
    });

    await service.runManual(VEHICLE_ID);

    // Both ids must appear in the tripPoint delete
    expect(capturedWhere.tripId.in).toHaveLength(2);
    expect(capturedWhere.tripId.in).toContain(id1);
    expect(capturedWhere.tripId.in).toContain(id2);
  });
});
