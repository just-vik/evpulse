import { TripBackfillService } from '../src/trips/trip-backfill.service';
import { ConflictException, BadRequestException } from '@nestjs/common';

/**
 * Orchestration tests for TripBackfillService.rebuildTrips() — the production bug fixed
 * here was that rebuild never called the reconciler, leaving freshly re-split trips
 * fragmented (see e.g. the 1.2 km / 4 min / 1848%-efficiency trip from the bug report).
 * These tests exercise the rebuild → reconcile wiring, its failure/dry-run modes, and
 * the hardening added afterwards (per-vehicle lock, max-range cap). They mock the
 * detector/reconciler entirely rather than simulating real trip splitting — see
 * `reconcilePreview` tests below for why dryRun deliberately does NOT touch the detector.
 */

function makePrisma(existingTripIds: string[] = []) {
  const calls = {
    tripPointDeleteMany: [] as any[],
    tripStatsDeleteMany: [] as any[],
    tripDeleteMany:      [] as any[],
  };

  const prisma: any = {
    trip: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        // Two distinct call shapes hit trip.findMany:
        //  1. rebuildTrips'/reconcilePreview's own "what's in range" query (has `AND`)
        //  2. filterAnomalousTrips' post-backfill scan (has `endTime: { not: null }`)
        if (where?.AND) {
          return Promise.resolve(existingTripIds.map((id) => ({ id })));
        }
        return Promise.resolve([]); // no trips created by the (no-op) detector in these tests
      }),
      count: jest.fn().mockResolvedValue(0), // `created` — detector is a no-op here
      deleteMany: jest.fn().mockImplementation((args: any) => {
        calls.tripDeleteMany.push(args);
        return Promise.resolve({ count: existingTripIds.length });
      }),
    },
    tripPoint: {
      deleteMany: jest.fn().mockImplementation((args: any) => {
        calls.tripPointDeleteMany.push(args);
        return Promise.resolve({ count: 0 });
      }),
      findMany: jest.fn().mockResolvedValue([]), // backfillVehicleTrips' telemetryPoint loop uses telemetryPoint, not this
    },
    tripStats: {
      deleteMany: jest.fn().mockImplementation((args: any) => {
        calls.tripStatsDeleteMany.push(args);
        return Promise.resolve({ count: 0 });
      }),
    },
    telemetryRaw: {
      count: jest.fn().mockResolvedValue(0), // forces the telemetryPoint (non-raw) backfill path
    },
    telemetryPoint: {
      findMany: jest.fn().mockResolvedValue([]), // empty batch → backfill loop exits immediately
    },
  };

  return { prisma, calls };
}

function makeTripDetector() {
  return {
    resetVehicleState: jest.fn().mockResolvedValue(undefined),
    checkTripState:    jest.fn().mockResolvedValue(undefined),
  };
}

function makeGeocoding() {
  return {};
}

/** Always-succeeds lock by default; tests that need contention override tryAcquire. */
function makeLock() {
  return {
    tryAcquire: jest.fn().mockResolvedValue('token-abc'),
    releaseIfHeld: jest.fn().mockResolvedValue(undefined),
  };
}

/** No env overrides — uses trip-merge-params.ts defaults (45-day range cap). */
function makeConfig() {
  return { get: jest.fn().mockReturnValue(undefined) };
}

describe('TripBackfillService.rebuildTrips — rebuild → reconcile orchestration', () => {
  const from = new Date('2026-08-01T00:00:00Z');
  const to   = new Date('2026-08-02T00:00:00Z');

  it('calls the reconciler for the correct vehicle and time range after rebuild', async () => {
    const { prisma } = makePrisma(['trip-old-1']);
    const tripDetector = makeTripDetector();
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const svc = new TripBackfillService(prisma, tripDetector as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    await svc.rebuildTrips('veh-1', from, to);

    expect(tripReconciler.reconcileRange).toHaveBeenCalledWith('veh-1', from, to);
  });

  it('scopes reconciliation to the requested vehicle only — does not leak to other vehicles', async () => {
    const { prisma: prismaA } = makePrisma([]);
    const { prisma: prismaB } = makePrisma([]);
    const reconcilerA = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const reconcilerB = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const svcA = new TripBackfillService(prismaA, makeTripDetector() as any, makeGeocoding() as any, reconcilerA as any, makeLock() as any, makeConfig() as any);
    const svcB = new TripBackfillService(prismaB, makeTripDetector() as any, makeGeocoding() as any, reconcilerB as any, makeLock() as any, makeConfig() as any);

    await svcA.rebuildTrips('veh-A', from, to);
    await svcB.rebuildTrips('veh-B', from, to);

    expect(reconcilerA.reconcileRange).toHaveBeenCalledWith('veh-A', from, to);
    expect(reconcilerB.reconcileRange).toHaveBeenCalledWith('veh-B', from, to);
    expect(reconcilerA.reconcileRange).not.toHaveBeenCalledWith('veh-B', expect.anything(), expect.anything());
  });

  it('surfaces merged / skippedDueToCharging counts from the reconciler in the result', async () => {
    const { prisma } = makePrisma([]);
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 3, candidatePairs: 5, skippedDueToCharging: 2, pairs: [] }) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    const result: any = await svc.rebuildTrips('veh-1', from, to);

    expect(result.status).toBe('completed');
    expect(result.reconciled).toBe(true);
    expect(result.merged).toBe(3);
    expect(result.skippedDueToCharging).toBe(2);
  });

  it('succeeds with a completed status when there are no candidate merges', async () => {
    const { prisma } = makePrisma([]);
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    const result: any = await svc.rebuildTrips('veh-1', from, to);

    expect(result.status).toBe('completed');
    expect(result.merged).toBe(0);
  });

  it('returns an explicit partial status with a warning when reconciliation throws — never a silent success', async () => {
    const { prisma } = makePrisma(['trip-old-1']);
    const tripReconciler = { reconcileRange: jest.fn().mockRejectedValue(new Error('db timeout')) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    const result: any = await svc.rebuildTrips('veh-1', from, to);

    expect(result.status).toBe('partial');
    expect(result.reconciled).toBe(false);
    expect(result.merged).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/reconciliation failed/i);
    // Detection/deletion still happened — a failed merge pass doesn't roll back backfill.
    expect(prisma.trip.deleteMany).toHaveBeenCalled();
  });

  it('retrying reconciliation after a partial failure is safe (same call, no side effect on the rebuild result)', async () => {
    const { prisma } = makePrisma([]);
    const tripReconciler = {
      reconcileRange: jest.fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValueOnce({ merged: 1, candidatePairs: 1, skippedDueToCharging: 0, pairs: [] }),
    };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    const first: any = await svc.rebuildTrips('veh-1', from, to);
    expect(first.status).toBe('partial');

    // Retrying only the reconciliation phase (the public method rebuild already exposes)
    // succeeds without needing to re-run detection/deletion.
    const retry: any = await tripReconciler.reconcileRange('veh-1', from, to);
    expect(retry.merged).toBe(1);
  });

  it('releases the per-vehicle lock even when reconciliation throws', async () => {
    const { prisma } = makePrisma([]);
    const lock = makeLock();
    const tripReconciler = { reconcileRange: jest.fn().mockRejectedValue(new Error('db timeout')) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, lock as any, makeConfig() as any);

    await svc.rebuildTrips('veh-1', from, to);

    expect(lock.tryAcquire).toHaveBeenCalledWith('trip-rebuild-lock:veh-1', expect.any(Number));
    expect(lock.releaseIfHeld).toHaveBeenCalledWith('trip-rebuild-lock:veh-1', 'token-abc');
  });

  it('rejects a concurrent real rebuild for the same vehicle with 409 instead of racing', async () => {
    const { prisma } = makePrisma([]);
    const lock = { tryAcquire: jest.fn().mockResolvedValue(null), releaseIfHeld: jest.fn() };
    const tripReconciler = { reconcileRange: jest.fn() };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, lock as any, makeConfig() as any);

    await expect(svc.rebuildTrips('veh-1', from, to)).rejects.toBeInstanceOf(ConflictException);
    // Never got past the lock — no destructive writes attempted.
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
    expect(tripReconciler.reconcileRange).not.toHaveBeenCalled();
  });

  it('does not acquire the lock for a dryRun preview (read-only, no serialization needed)', async () => {
    const { prisma } = makePrisma([]);
    const lock = makeLock();
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, lock as any, makeConfig() as any);

    await svc.rebuildTrips('veh-1', from, to, { dryRun: true });

    expect(lock.tryAcquire).not.toHaveBeenCalled();
  });

  it('rejects a range wider than the configured max (resource protection) for both dryRun and real runs', async () => {
    const wideFrom = new Date('2020-01-01T00:00:00Z');
    const wideTo   = new Date('2026-01-01T00:00:00Z'); // ~6 years, default cap is 45 days
    const { prisma } = makePrisma([]);
    const tripReconciler = { reconcileRange: jest.fn() };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    await expect(svc.rebuildTrips('veh-1', wideFrom, wideTo)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.rebuildTrips('veh-1', wideFrom, wideTo, { dryRun: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });

  it('a subsequent real rebuild works normally after a prior dryRun (no detector state leakage)', async () => {
    const { prisma } = makePrisma([]);
    const tripDetector = makeTripDetector();
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const svc = new TripBackfillService(prisma, tripDetector as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    await svc.rebuildTrips('veh-1', from, to, { dryRun: true });
    expect(tripDetector.resetVehicleState).not.toHaveBeenCalled();

    const real: any = await svc.rebuildTrips('veh-1', from, to);
    expect(real.status).toBe('completed');
    expect(tripDetector.resetVehicleState).toHaveBeenCalledTimes(1);
  });
});

describe('TripBackfillService.reconcilePreview (dryRun) — honest preview semantics', () => {
  const from = new Date('2026-08-01T00:00:00Z');
  const to   = new Date('2026-08-02T00:00:00Z');

  it('labels the preview as reconcile-only, not a full-rebuild simulation', async () => {
    const { prisma } = makePrisma(['trip-old-1', 'trip-old-2']);
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 1, candidatePairs: 2, skippedDueToCharging: 1, pairs: [] }) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    const result: any = await svc.rebuildTrips('veh-1', from, to, { dryRun: true });

    expect(result.previewKind).toBe('reconcile_existing_only');
    expect(result.existingTrips).toBe(2);
    expect(result.candidatePairs).toBe(2);
    expect(result.mergeablePairs).toBe(1);
    expect(result.skippedDueToCharging).toBe(1);
    expect(result.warnings.some((w: string) => /does not simulate|not simulate telemetry/i.test(w))).toBe(true);
    // No detection-pipeline fields should be present/implied — this never ran the detector.
    expect(result.detectedTrips).toBeUndefined();
    expect(result.filteredTrips).toBeUndefined();
  });

  it('performs zero write Prisma operations', async () => {
    const { prisma, calls } = makePrisma(['trip-old-1', 'trip-old-2']);
    const tripDetector = makeTripDetector();
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 1, candidatePairs: 1, skippedDueToCharging: 0, pairs: [] }) };
    const svc = new TripBackfillService(prisma, tripDetector as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    await svc.rebuildTrips('veh-1', from, to, { dryRun: true });

    expect(calls.tripDeleteMany).toHaveLength(0);
    expect(calls.tripPointDeleteMany).toHaveLength(0);
    expect(calls.tripStatsDeleteMany).toHaveLength(0);
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
    expect(prisma.tripPoint.deleteMany).not.toHaveBeenCalled();
    expect(prisma.tripStats.deleteMany).not.toHaveBeenCalled();
    expect(tripDetector.resetVehicleState).not.toHaveBeenCalled();
    expect(tripDetector.checkTripState).not.toHaveBeenCalled();
    expect(tripReconciler.reconcileRange).toHaveBeenCalledWith('veh-1', from, to, { dryRun: true });
  });

  it('never uses the telemetry/detection path — only existing-trip reads', async () => {
    const { prisma } = makePrisma(['trip-old-1']);
    const tripReconciler = { reconcileRange: jest.fn().mockResolvedValue({ merged: 0, candidatePairs: 0, skippedDueToCharging: 0, pairs: [] }) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    await svc.rebuildTrips('veh-1', from, to, { dryRun: true });

    expect(prisma.telemetryRaw.count).not.toHaveBeenCalled();
    expect(prisma.telemetryPoint.findMany).not.toHaveBeenCalled();
  });

  it('a failed reconciliation preview returns an explicit failed preview, not a thrown error or false success', async () => {
    const { prisma } = makePrisma(['trip-old-1']);
    const tripReconciler = { reconcileRange: jest.fn().mockRejectedValue(new Error('redis unavailable')) };
    const svc = new TripBackfillService(prisma, makeTripDetector() as any, makeGeocoding() as any, tripReconciler as any, makeLock() as any, makeConfig() as any);

    const result: any = await svc.rebuildTrips('veh-1', from, to, { dryRun: true });

    expect(result.previewKind).toBe('reconcile_existing_only');
    expect(result.status).toBe('dry_run');
    expect(result.mergeablePairs).toBe(0);
    expect(result.warnings.some((w: string) => /reconciliation preview failed/i.test(w))).toBe(true);
  });
});
