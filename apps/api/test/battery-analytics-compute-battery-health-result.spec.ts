import { BatteryAnalyticsService } from '../src/battery/battery-analytics.service';
import { BATTERY_HEALTH_ALGORITHM_VERSION } from '../src/battery/battery-health-result';

/**
 * Characterization tests for computeBatteryHealthResult() — the pure
 * calculation extracted in commit 61cb1b4. These pin today's actual
 * behavior (three estimators, weighted-median blend with weights
 * 1.0/0.9/0.8, linear temperature correction, [70,100] clamp) with
 * hand-computed expected values, so a future formula change shows up as a
 * failing test instead of silent drift.
 *
 * Explicitly out of scope here (per instruction): BatteryHealthService
 * (the other engine) and Prisma persistence (updateBatteryMetrics's
 * `create()` call) — this file only exercises
 * BatteryAnalyticsService -> computeBatteryHealthResult() -> BatteryHealthResult.
 *
 * Mocking approach: a tiny in-memory fixture store plus a generic
 * Prisma-`where`-matcher (handles the gt/gte/lte/not-null operators this
 * service's queries actually use), so the two different `chargingSession
 * .findMany` call sites (the SOH estimator's 30-day window vs. the
 * baseline-lock's all-time window) get correctly different result sets
 * from one shared fixture array, the same way real Postgres would filter
 * them — rather than a flat stub that returns the same rows regardless of
 * `where`.
 */

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function matchesWhere(row: any, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const val = row[key];
    if (cond !== null && typeof cond === 'object') {
      if ('gt' in cond) return val != null && val > cond.gt;
      if ('gte' in cond) return val != null && val >= cond.gte;
      if ('lte' in cond) return val != null && val <= cond.lte;
      if ('not' in cond) return cond.not === null ? val != null : val !== cond.not;
      return true;
    }
    return val === cond;
  });
}

interface Fixtures {
  vehicleId: string;
  vehicle: any;
  chargingSessions: any[];
  trips: any[];
  rangeRows: Array<{ soc: number; rangeKm: number }>;
  tempPoints: Array<{ batteryTemp: number }>;
  baselineHighKwh: number | null;
  baselineMediumKwh: number | null;
}

const VEHICLE_ID = 'veh-1';

function baseFixtures(overrides: Partial<Fixtures> = {}): Fixtures {
  return {
    vehicleId: VEHICLE_ID,
    vehicle: {
      id: VEHICLE_ID,
      vehicleSpec: { batteryNominalKwh: 75, batteryUsableKwh: 75, rangeWltp: 450 },
      batteryCapacityNominal: null,
      batteryCapacityUsable: null,
      batteryCapacityDetected: null,
      batteryCyclesTotal: null,
      batteryCycleChargeTotal: null,
    },
    chargingSessions: [],
    trips: [],
    rangeRows: [],
    tempPoints: [],
    baselineHighKwh: null,
    baselineMediumKwh: null,
    ...overrides,
  };
}

/** 3 sessions, capacity fixed at 71.25 kWh independent of nominal (energy
 *  and ΔSOC are what's fixed; SOH itself depends on whichever nominal the
 *  service resolves) — endSoc=90 so each gets baseline-lock-style weight
 *  2.0 in the within-method median, though with 3 identical capacities the
 *  weight only matters for tie-breaking, not the result. */
function chargingSessionsAt71_25kWh(): any[] {
  return [0, 1, 2].map(i => ({
    vehicleId: VEHICLE_ID,
    startSoc: 20,
    endSoc: 90,
    energyAddedKwh: 49.875, // capacity = 49.875 / (70/100) = 71.25 kWh
    startTime: daysAgo(5 + i),
    endTime: daysAgo(5 + i),
    chargerType: 'ac_home',
  }));
}

/** 2 trips, capacity fixed at 67.5 kWh (energyUsedKwh / (ΔSOC/100)). */
function tripsAt67_5kWh(): any[] {
  return [0, 1].map(i => ({
    vehicleId: VEHICLE_ID,
    startSoc: 80,
    endSoc: 20,
    energyUsedKwh: 40.5, // capacity = 40.5 / (60/100) = 67.5 kWh
    distanceKm: 200,
    efficiencyWhkm: 202.5, // 40500 Wh / 200 km — within isValidTrip's [80,400]
    startTime: daysAgo(3 + i),
    endTime: daysAgo(3 + i),
    stats: { avgSpeed: 80 },
  }));
}

/** 5 range observations giving rangeAt100 = 450 exactly (225/50*100). */
function rangeRowsAt450(): Array<{ soc: number; rangeKm: number }> {
  return Array.from({ length: 5 }, () => ({ soc: 50, rangeKm: 225 }));
}

function makeService(fixtures: Fixtures) {
  const prisma: any = {
    vehicle: {
      findUnique: jest.fn(async () => fixtures.vehicle),
    },
    chargingSession: {
      findMany: jest.fn(async ({ where }: any) =>
        fixtures.chargingSessions.filter(s => matchesWhere(s, where)),
      ),
    },
    trip: {
      findMany: jest.fn(async ({ where }: any) =>
        fixtures.trips.filter(t => matchesWhere(t, where)),
      ),
    },
    telemetryPoint: {
      findMany: jest.fn(async ({ where }: any) =>
        fixtures.tempPoints.filter(p => matchesWhere({ ...p, vehicleId: VEHICLE_ID }, where)),
      ),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('batteryBaselineHighKwh')) {
        return [{
          batteryBaselineHighKwh: fixtures.baselineHighKwh,
          batteryBaselineMediumKwh: fixtures.baselineMediumKwh,
        }];
      }
      if (sql.includes('telemetry_points') && sql.includes('batteryRangeKm')) {
        return fixtures.rangeRows;
      }
      throw new Error(`Unexpected $queryRaw in test: ${sql.slice(0, 80)}`);
    }),
    // Baseline-lock writes — not under test here (see file header); always
    // a no-op so tests never depend on a real UPDATE having "happened."
    $executeRaw: jest.fn(async () => 0),
    batteryHealth: {
      create: jest.fn(async ({ data }: any) => ({ id: 'dry-run', timestamp: new Date(), ...data })),
    },
  };

  const redis: any = { get: async () => null, set: async () => 'OK' };
  const service = new BatteryAnalyticsService(prisma, redis);
  return { service, prisma };
}

describe('BatteryAnalyticsService.computeBatteryHealthResult', () => {
  describe('canonical computation — all 3 estimators', () => {
    it('blends range/charging/trip with weights 1.0/0.9/0.8 via weighted median', async () => {
      const fixtures = baseFixtures({
        chargingSessions: chargingSessionsAt71_25kWh(), // soh = 71.25/75*100 = 95
        trips: tripsAt67_5kWh(),                        // soh = 67.5/75*100 = 90
        rangeRows: rangeRowsAt450(),                    // soh = 450/450*100 = 100
      });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      // sorted by soh: trip(90, w0.8), charging(95, w0.9), range(100, w1.0)
      // totalWeight=2.7, halfWeight=1.35; cumulative 0.8 < 1.35, +0.9=1.7 >= 1.35 -> charging(95)
      expect(result).not.toBeNull();
      expect(result!.value).toBe(95);
      expect(result!.rawValue).toBe(95); // no temp correction applied (no temp fixture)
      expect(result!.source).toBe('weighted_median');
      expect(result!.methodCount).toBe(3);
      expect(result!.observationCount).toBe(5 + 3 + 2); // range rows + charging sessions + trips
      expect(result!.confidence).toBe(1); // 3/3
      expect(result!.algorithmVersion).toBe(BATTERY_HEALTH_ALGORITHM_VERSION);
    });
  });

  describe('result contract — partial method sets', () => {
    it('reports source as the single method name when only one contributes', async () => {
      const fixtures = baseFixtures({ chargingSessions: chargingSessionsAt71_25kWh() });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      expect(result!.value).toBe(95);
      expect(result!.source).toBe('charging');
      expect(result!.methodCount).toBe(1);
      expect(result!.observationCount).toBe(3);
      expect(result!.confidence).toBe(0.33); // Math.round(1/3 * 100) / 100
    });

    it('blends 2 methods (range missing) and still reports weighted_median', async () => {
      const fixtures = baseFixtures({
        chargingSessions: chargingSessionsAt71_25kWh(), // soh 95, weight 0.9
        trips: tripsAt67_5kWh(),                        // soh 90, weight 0.8
      });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      // halfWeight = 1.7/2 = 0.85; cumulative trip 0.8 < 0.85, +0.9=1.7 >= 0.85 -> charging(95)
      expect(result!.value).toBe(95);
      expect(result!.source).toBe('weighted_median');
      expect(result!.methodCount).toBe(2);
      expect(result!.observationCount).toBe(5); // 3 sessions + 2 trips
      expect(result!.confidence).toBe(0.67); // Math.round(2/3 * 100) / 100
    });
  });

  describe('input edge cases', () => {
    it('returns null when no estimator has enough data', async () => {
      const fixtures = baseFixtures(); // nothing at all
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      expect(result).toBeNull();
    });

    it('returns null (not a low-confidence record) when the blended estimate is below the 70% floor', async () => {
      // capacity 45kWh / nominal 75 = 60% — passes calculateSohFromCharging's
      // own [50,110] bound, but fails the final <70 floor in the blend.
      const fixtures = baseFixtures({
        chargingSessions: [0, 1].map(i => ({
          vehicleId: VEHICLE_ID,
          startSoc: 20,
          endSoc: 90,
          energyAddedKwh: 31.5, // 31.5 / 0.7 = 45 kWh capacity
          startTime: daysAgo(5 + i),
          endTime: daysAgo(5 + i),
          chargerType: 'ac_home',
        })),
      });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      expect(result).toBeNull();
    });

    it('discards a charging session outlier outside [50,110]% of nominal', async () => {
      // capacity 200kWh / nominal 75 = 267% -> discarded inside
      // calculateSohFromCharging itself, not just at the blend stage.
      const outlierPlusValid = [
        {
          vehicleId: VEHICLE_ID, startSoc: 20, endSoc: 90,
          energyAddedKwh: 140, // 140/0.7 = 200 kWh -> out of [50,110]% of 75kWh nominal
          startTime: daysAgo(5), endTime: daysAgo(5), chargerType: 'ac_home',
        },
        ...chargingSessionsAt71_25kWh(),
      ];
      const fixtures = baseFixtures({ chargingSessions: outlierPlusValid });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      // Only the 3 valid (71.25kWh) sessions should count -- the outlier
      // must not shift the median or inflate observationCount to 4.
      expect(result!.value).toBe(95);
      expect(result!.observationCount).toBe(3);
    });

    it('applies linear temperature correction and preserves the pre-clamp value in rawValue', async () => {
      const fixtures = baseFixtures({
        chargingSessions: chargingSessionsAt71_25kWh(), // soh 95
        tempPoints: [
          { batteryTemp: 0, timestamp: daysAgo(1) },
          { batteryTemp: 0, timestamp: daysAgo(2) },
          { batteryTemp: 0, timestamp: daysAgo(3) },
        ],
      });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      // correction = (20-0) * 0.004 * 100 = 8 -> tempCorrected = 95+8 = 103
      // clamped to MAX_SOH=100 for display, but rawValue keeps 103.
      expect(result!.rawValue).toBe(103);
      expect(result!.value).toBe(100);
    });

    it('uses a locked baseline capacity instead of nominal/spec when present', async () => {
      const fixtures = baseFixtures({
        chargingSessions: chargingSessionsAt71_25kWh(), // fixed capacity 71.25kWh
        baselineHighKwh: 80, // overrides the 75kWh spec/nominal fallback
      });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      // soh = 71.25 / 80 * 100 = 89.0625 -> rounds to 89.06
      expect(result!.value).toBeCloseTo(89.06, 2);
      expect((result as any).nominalCapacityKwh).toBe(80);
    });

    it('falls back to vehicle.batteryCapacityNominal when vehicleSpec is missing', async () => {
      const fixtures = baseFixtures({
        vehicle: {
          id: VEHICLE_ID,
          vehicleSpec: null,
          batteryCapacityNominal: 70,
          batteryCapacityUsable: 70,
          batteryCapacityDetected: null,
          batteryCyclesTotal: null,
          batteryCycleChargeTotal: null,
        },
        chargingSessions: chargingSessionsAt71_25kWh(),
      });
      const { service } = makeService(fixtures);

      const result = await service.computeBatteryHealthResult(VEHICLE_ID);

      expect((result as any).nominalCapacityKwh).toBe(70);
    });
  });

  describe('updateBatteryMetrics — thin adapter/writer only', () => {
    it('persists exactly what computeBatteryHealthResult returns, without recomputing anything', async () => {
      const fixtures = baseFixtures();
      const { service, prisma } = makeService(fixtures);

      const canned = {
        value: 91.23, rawValue: 95.5, source: 'weighted_median' as const,
        observationCount: 7, methodCount: 2, confidence: 0.67,
        algorithmVersion: BATTERY_HEALTH_ALGORITHM_VERSION,
        estimatedCapacityKwh: 68.4, nominalCapacityKwh: 75, degradationPercent: 8.77,
        tripSoh: 90, chargingSoh: 95, ratedRangeSoh: null,
        avgBatteryTempC: -3.2, cycles: 42.1,
        wltpRangeKm: 450, wltpIsFromSpec: true, methodNames: 'charging+trip',
      };
      // Proves updateBatteryMetrics does not run its own version of the
      // estimator/blend logic — it can only produce this exact row if it
      // took every value from computeBatteryHealthResult's return, not from
      // independently querying charging sessions/trips/range itself.
      jest.spyOn(service, 'computeBatteryHealthResult').mockResolvedValue(canned as any);

      await service.updateBatteryMetrics(VEHICLE_ID);

      expect(prisma.chargingSession.findMany).not.toHaveBeenCalled();
      expect(prisma.trip.findMany).not.toHaveBeenCalled();
      expect(prisma.batteryHealth.create).toHaveBeenCalledTimes(1);

      const written = (prisma.batteryHealth.create as jest.Mock).mock.calls[0][0].data;
      expect(written).toMatchObject({
        vehicleId: VEHICLE_ID,
        sohPercent: canned.value,
        estimatedCapacityKwh: canned.estimatedCapacityKwh,
        nominalCapacityKwh: canned.nominalCapacityKwh,
        degradationPercent: canned.degradationPercent,
        method: canned.source,
        confidenceScore: canned.confidence,
        sampleCount: canned.methodCount,
        tripSoh: canned.tripSoh,
        chargingSoh: canned.chargingSoh,
        ratedRangeSoh: canned.ratedRangeSoh,
        avgBatteryTempC: canned.avgBatteryTempC,
        cycles: canned.cycles,
      });
    });

    it('writes nothing when computeBatteryHealthResult returns null (insufficient data / below-floor)', async () => {
      const fixtures = baseFixtures();
      const { service, prisma } = makeService(fixtures);
      jest.spyOn(service, 'computeBatteryHealthResult').mockResolvedValue(null);

      await service.updateBatteryMetrics(VEHICLE_ID);

      expect(prisma.batteryHealth.create).not.toHaveBeenCalled();
    });
  });
});
