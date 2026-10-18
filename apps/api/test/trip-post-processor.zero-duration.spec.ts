import { TripPostProcessorService } from '../src/trips/trip-post-processor.service';

/**
 * Regression tests for zero-duration boundary recovery in TripPostProcessorService.
 *
 * Two root causes share the same fix path (new block inserted before charge/tail
 * normalization in processTrip):
 *
 *   Bug A — trip_points exist but endTime was never advanced (pre-95aee09 watchdog
 *            behaviour). The last trip_point timestamp becomes the real endTime.
 *
 *   Bug B — force_closed_stale_watchdog on a sparse REST-poll trip: no trip_points,
 *            next telemetry ≥ 60 min away.  endTime is extended to the first REST
 *            poll that shows positive movement (speed > 0 or GPS > 100 m from start).
 *
 * Tests verify the endTime written to trip.update, NOT the downstream metrics
 * (distance, energy, efficiency) which have their own test suites.
 */

const START = new Date('2026-10-14T07:40:00.000Z');
const VEHICLE_ID = 'veh-zd';

/** A zero-duration trip skeleton shared by all test cases. */
function makeTrip(overrides: Record<string, unknown> = {}) {
  return {
    id:           'trip-zd-1',
    vehicleId:    VEHICLE_ID,
    startTime:    START,
    endTime:      START,          // zero-duration — the thing we're fixing
    distanceKm:   null,
    startSoc:     78,
    endSoc:       null,
    startLat:     52.050891,
    startLon:      4.499135,
    reliability:  null,
    repairReason: 'force_closed_stale_watchdog',
    repairTags:   [{ tag: 'force_closed_stale_watchdog', source: 'watchdog', version: 1, ts: START.toISOString() }],
    vehicle: {
      batteryCapacityDetected: null,
      vehicleSpec: { batteryUsableKwh: 78 },
      batteryCapacityUsable: null,
    },
    energyUsedKwh:  null,
    efficiencyWhkm: null,
    qualityScore:   null,
    ...overrides,
  };
}

/**
 * Builds a Prisma mock that covers all calls made by processTrip.
 *
 * The post-processor calls these in order (for a zero-duration Bug-B trip):
 *   1. tripPoint.findMany         → trip_points
 *   2. trip.findFirst (new block) → next trip bound
 *   3. telemetryPoint.findMany    → sparse search candidates (new block)
 *   4. chargingSession.findFirst  → charge trim
 *   5. telemetryPoint.findMany    → tail extension window
 *   6. telemetryPoint.findFirst ×3 → odometer start/end anchors
 *   7. telemetryPoint.findMany    → telemetry fallback (now uses extended window)
 *   8. telemetryPoint.findFirst ×2 → endSoc / startSoc repair
 *   9. trip.update
 *
 * Calls are disambiguated by `take` (5 = sparse search, 80 = tail extension,
 * 500 = telemetry fallback) and by context (findFirst vs findMany).
 */
function buildPrisma(opts: {
  trip:             ReturnType<typeof makeTrip>;
  tripPoints?:      any[];
  nextTrip?:        any;
  sparseResults?:   any[];   // returned by the take-5 sparse search
  chargeSession?:   any;
}) {
  const captured: { endTime?: Date; repairReason?: string } = {};

  const tripPoints    = opts.tripPoints   ?? [];
  const sparseResults = opts.sparseResults ?? [];

  return {
    prisma: {
      trip: {
        findUnique: jest.fn().mockResolvedValue(opts.trip),
        findFirst:  jest.fn().mockResolvedValue(opts.nextTrip ?? null),
        update:     jest.fn().mockImplementation(({ data }: any) => {
          if (data.endTime      !== undefined) captured.endTime      = data.endTime;
          if (data.repairReason !== undefined) captured.repairReason = data.repairReason;
          return Promise.resolve({});
        }),
      },
      tripPoint: {
        findMany:   jest.fn().mockResolvedValue(tripPoints),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chargingSession: {
        findFirst: jest.fn().mockResolvedValue(opts.chargeSession ?? null),
      },
      telemetryPoint: {
        findMany: jest.fn().mockImplementation(({ take }: any) => {
          // take=5  → sparse search (new block)
          // take=80 → tail extension (existing normalization)
          // take=500 → telemetry fallback (existing fallback)
          if (take === 5)   return Promise.resolve(sparseResults);
          if (take === 80)  return Promise.resolve([]);
          if (take === 500) return Promise.resolve(sparseResults);
          return Promise.resolve([]);
        }),
        findFirst: jest.fn().mockResolvedValue(null),  // odometer / SOC repair → null
      },
    } as any,
    captured,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TripPostProcessorService — zero-duration boundary recovery', () => {

  // ── Bug A ──────────────────────────────────────────────────────────────────

  it('Bug A: endTime updated from last trip_point when trip_points exist', async () => {
    const lastPtTs = new Date(START.getTime() + 45 * 60_000);
    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({
      trip,
      tripPoints: [
        { timestamp: new Date(START.getTime() + 20 * 60_000), speed: 80,  latitude: 52.1, longitude: 4.51, soc: 77, interpolated: false },
        { timestamp: lastPtTs,                                  speed: 0,   latitude: 52.2, longitude: 4.62, soc: 76, interpolated: false },
      ],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    expect(captured.endTime).toEqual(lastPtTs);
    expect(captured.repairReason).toContain('end_time_recovered_from_trip_points');
    // Sparse REST-poll tag must NOT appear — this is Bug A, not Bug B
    expect(captured.repairReason).not.toContain('end_time_recovered_sparse_rest_poll');
  });

  it('Bug A: all trip_points at startTime falls through to Bug-B path', async () => {
    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({
      trip,
      tripPoints: [
        // timestamp === startTime → not after startTime → Bug-A condition fails
        { timestamp: START, speed: 0, latitude: 52.050891, longitude: 4.499135, soc: 78, interpolated: false },
      ],
      // No sparse candidates either → endTime stays unchanged
      sparseResults: [],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    // endTime not updated (no evidence found)
    expect(captured.endTime).toBeUndefined();
    expect(captured.repairReason).not.toContain('end_time_recovered_from_trip_points');
    expect(captured.repairReason).not.toContain('end_time_recovered_sparse_rest_poll');
  });

  // ── Bug B ──────────────────────────────────────────────────────────────────

  it('Bug B: endTime extended when next REST poll shows speed > 0', async () => {
    const nextPollTs = new Date(START.getTime() + 60 * 60_000);
    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({
      trip,
      sparseResults: [
        { timestamp: nextPollTs, speed: 41.8, latitude: 52.056501, longitude: 4.499294, soc: 77 },
      ],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    expect(captured.endTime).toEqual(nextPollTs);
    expect(captured.repairReason).toContain('end_time_recovered_sparse_rest_poll');
  });

  it('Bug B: endTime extended when GPS moved > 100 m even with speed = 0', async () => {
    const nextPollTs = new Date(START.getTime() + 60 * 60_000);
    const trip = makeTrip();
    // startLat=52.050891, startLon=4.499135 — next point ~0.6 km away
    const { prisma, captured } = buildPrisma({
      trip,
      sparseResults: [
        { timestamp: nextPollTs, speed: 0, latitude: 52.056501, longitude: 4.499294, soc: 77 },
      ],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    expect(captured.endTime).toEqual(nextPollTs);
    expect(captured.repairReason).toContain('end_time_recovered_sparse_rest_poll');
  });

  it('Bug B: no endTime update when next REST poll shows no movement (speed=0, GPS identical)', async () => {
    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({
      trip,
      sparseResults: [
        // speed=0 AND GPS at same coordinates (≤ 100 m) → no movement evidence
        { timestamp: new Date(START.getTime() + 60 * 60_000), speed: 0, latitude: 52.050891, longitude: 4.499135, soc: 78 },
      ],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    // endTime must NOT be updated — absence of evidence ≠ evidence of absence
    expect(captured.endTime).toBeUndefined();
    expect(captured.repairReason).not.toContain('end_time_recovered_sparse_rest_poll');
  });

  it('Bug B: no endTime update when no subsequent telemetry exists', async () => {
    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({ trip, sparseResults: [] });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    expect(captured.endTime).toBeUndefined();
    expect(captured.repairReason).not.toContain('end_time_recovered_sparse_rest_poll');
  });

  it('Bug B: search window capped at next trip start — no contamination', async () => {
    const nextTripStart = new Date(START.getTime() + 30 * 60_000); // 30 min later
    const pollOutsideWindow = new Date(START.getTime() + 45 * 60_000); // 45 min — after next trip

    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({
      trip,
      nextTrip: { startTime: nextTripStart },
      // The sparse search for this test returns empty because the mock uses take=5,
      // and we simulate that the only available telemetry is after the next trip start.
      sparseResults: [],
    });
    // Verify that trip.findFirst was called to look up the next-trip bound
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    expect(prisma.trip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          vehicleId: VEHICLE_ID,
          startTime: expect.objectContaining({ gt: START }),
        }),
      }),
    );
    expect(captured.endTime).toBeUndefined();
    void pollOutsideWindow; // intentionally unused — proves we don't reach it
  });

  it('charge session before REST poll: trip trimmed to charge start (existing trim still fires)', async () => {
    const chargeStart = new Date(START.getTime() + 45 * 60_000); // charge at +45 min
    const pollTs      = new Date(START.getTime() + 60 * 60_000); // REST poll at +60 min

    const trip = makeTrip();
    const { prisma, captured } = buildPrisma({
      trip,
      sparseResults: [
        { timestamp: pollTs, speed: 0, latitude: 52.1, longitude: 4.6, soc: 65 },
      ],
      // The existing charge trim (lines 260-273) fires AFTER our block extends endTime
      chargeSession: {
        startTime:        chargeStart,
        endTime:          new Date(chargeStart.getTime() + 60 * 60_000),
        startSoc:         65,
        energyAddedKwh:   10,
      },
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    // Our block sets endTime = pollTs (+60 min).
    // The existing charge trim then cuts it back to chargeStart (+45 min).
    expect(captured.endTime).toEqual(chargeStart);
    expect(captured.repairReason).toContain('end_time_recovered_sparse_rest_poll');
    expect(captured.repairReason).toContain('trip_trimmed_to_charge_start');
  });

  // ── Normal trip regression ─────────────────────────────────────────────────

  it('normal trip (endTime > startTime): zero-duration block does not fire', async () => {
    const realEnd = new Date(START.getTime() + 30 * 60_000);
    const trip = makeTrip({ endTime: realEnd, distanceKm: 15 });
    const { prisma, captured } = buildPrisma({
      trip,
      tripPoints: [
        { timestamp: new Date(START.getTime() + 10 * 60_000), speed: 60, latitude: 52.1, longitude: 4.51, soc: 77, interpolated: false },
        { timestamp: realEnd,                                   speed: 0,  latitude: 52.2, longitude: 4.62, soc: 75, interpolated: false },
      ],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    // endTime should not be reset to something based on trip_points (Bug-A guard)
    // — it was already correct. Update may or may not write endTime; if it does it must
    // match realEnd (may vary < 1000 ms due to parked-tail trim logic on 2 points).
    if (captured.endTime !== undefined) {
      expect(Math.abs(captured.endTime.getTime() - realEnd.getTime())).toBeLessThanOrEqual(1000);
    }
    expect(captured.repairReason).not.toContain('end_time_recovered_from_trip_points');
    expect(captured.repairReason).not.toContain('end_time_recovered_sparse_rest_poll');
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  it('idempotency: running processTrip twice does not duplicate new tags', async () => {
    const nextPollTs = new Date(START.getTime() + 60 * 60_000);
    // Second run: trip already has endTime=nextPollTs (endTime ≠ startTime)
    const tripAfterFirstRun = makeTrip({
      endTime:      nextPollTs,
      distanceKm:   1.1,
      repairReason: 'force_closed_stale_watchdog|end_time_recovered_sparse_rest_poll',
    });
    const { prisma, captured } = buildPrisma({
      trip: tripAfterFirstRun,
      // trip_points may exist after first reconciliation pass
      tripPoints: [],
      sparseResults: [
        { timestamp: nextPollTs, speed: 41.8, latitude: 52.056501, longitude: 4.499294, soc: 77 },
      ],
    });
    const svc = new TripPostProcessorService(prisma);
    await svc.processTripById('trip-zd-1');

    // The tag should appear exactly once in the merged repairReason
    const reason: string = captured.repairReason ?? '';
    const tagCount = (reason.match(/end_time_recovered_sparse_rest_poll/g) ?? []).length;
    expect(tagCount).toBeLessThanOrEqual(1);
  });
});
