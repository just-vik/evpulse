/**
 * CURRENT-BEHAVIOR characterization tests — group 1 of 2, per
 * docs/calculations/tariff-resolver.md §12 ("do not mix these two
 * groups"). These pin what the five tariff-resolution paths return,
 * including disagreements and practically-dead fallback constants — they
 * describe the current SYSTEM BEHAVIOR (values, not implementations), not
 * the TariffResolverService contract's own test group.
 *
 * UPDATE (ChargingCostService migration): as of
 * docs/calculations/tariff-resolver.md §9's first production migration,
 * ChargingCostService.calculateSessionCost's non-catalog tiers now
 * delegate to a real TariffResolverService instead of inline settings
 * lookups. This describe block still asserts the exact same expected
 * values as before the migration — that's the point: unchanged assertions
 * passing against changed internals is the regression proof that the
 * migration preserved behavior. VehicleAnalyticsService/CostForecastService
 * below are NOT migrated yet and still exercise their original,
 * pre-resolver code paths.
 *
 * This file covers the three paths with clean, directly-callable public
 * methods: ChargingCostService.calculateSessionCost, VehicleAnalyticsService
 * .getCostSummary, CostForecastService.resolveRate/forecastForVehicle. The
 * other two (TripDetectorService's trip-finalize cost block and
 * TripGapRecoveryService) are inline snippets deep inside much larger
 * state machines with no dedicated test infrastructure of their own yet —
 * deliberately not attempted here; see the PR/commit note for the scoping
 * question that raises.
 */

import { ChargingCostService } from '../src/charging/charging-cost.service';
import { TariffResolverService } from '../src/charging/tariff-resolver.service';
import { VehicleAnalyticsService } from '../src/analytics/vehicle-analytics.service';
import { CostForecastService } from '../src/analytics/cost-forecast.service';

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

const VEHICLE_ID = 'veh-1';

// The real seed values from vehicles.service.ts (see charging.md) — used
// as the settings fixture throughout so these tests reflect an actual
// newly-created vehicle, not an arbitrarily-chosen test number.
const REAL_SEED_SETTINGS = {
  homeChargingRate: 0.35,
  superchargerRate: 0.49,
  thirdPartyRate: 0.55,
  superchargerOffPeakRate: null,
  timezone: 'Europe/Berlin',
};

describe('CURRENT BEHAVIOR: ChargingCostService.calculateSessionCost', () => {
  function makeService(session: any) {
    const prisma: any = {
      chargingSession: {
        findUnique: jest.fn(async () => session),
        update: jest.fn(async ({ data }: any) => ({ ...session, ...data })),
      },
      // TariffResolverService's own dependency — reads the SAME settings
      // object the session fixture carries, so the resolver sees exactly
      // what ChargingCostService used to read inline pre-migration.
      vehicleSettings: {
        findUnique: jest.fn(async () => session.vehicle?.settings ?? REAL_SEED_SETTINGS),
      },
    };
    // superchargerPricing/teslaOAuth are @Optional() — omitted entirely to
    // characterize the "no catalog stack available" branch, which is also
    // exactly what a session with no GPS hits regardless.
    const tariffResolver = new TariffResolverService(prisma, undefined, undefined, {
      canonicalDefaultRate: 0.35,
      canonicalCurrency: 'EUR',
    });
    const service = new ChargingCostService(prisma, undefined, undefined, tariffResolver);
    return { service, prisma, tariffResolver };
  }

  it('home charging (default bucket) uses settings.homeChargingRate = €0.35 as-persisted', async () => {
    const session = {
      id: 's1', vehicleId: VEHICLE_ID, chargerType: 'ac_home', maxPowerKw: 7,
      energyAddedKwh: 10, startTime: new Date(), costSource: null,
      vehicle: { id: VEHICLE_ID, userId: 'u1', settings: REAL_SEED_SETTINGS },
    };
    const { service, prisma } = makeService(session);

    await service.calculateSessionCost('s1');

    const written = (prisma.chargingSession.update as jest.Mock).mock.calls[0][0].data;
    expect(written.costPerKwh).toBe(0.35);
    expect(written.costSource).toBe('tariff');
    expect(written.costTotal).toBe(3.5); // 10 kWh * 0.35
    expect(written.currency).toBe('EUR');
  });

  it('3rd-party DC <50kW uses settings.thirdPartyRate = €0.55 (the real seed, not the €0.45 declared elsewhere)', async () => {
    const session = {
      id: 's2', vehicleId: VEHICLE_ID, chargerType: 'dc_third', maxPowerKw: 40,
      energyAddedKwh: 20, startTime: new Date(), costSource: null,
      vehicle: { id: VEHICLE_ID, userId: 'u1', settings: REAL_SEED_SETTINGS },
    };
    const { service, prisma } = makeService(session);

    await service.calculateSessionCost('s2');

    const written = (prisma.chargingSession.update as jest.Mock).mock.calls[0][0].data;
    expect(written.costPerKwh).toBe(0.55);
    expect(written.costSource).toBe('tariff');
  });

  it('explicit Tesla Supercharger, no GPS, no off-peak config: uses settings.superchargerRate directly (€0.49)', async () => {
    const session = {
      id: 's3', vehicleId: VEHICLE_ID, chargerType: 'supercharger', maxPowerKw: 150,
      energyAddedKwh: 30, startTime: new Date(), costSource: null,
      startLat: null, startLng: null,
      vehicle: { id: VEHICLE_ID, userId: 'u1', settings: REAL_SEED_SETTINGS },
    };
    const { service, prisma } = makeService(session);

    await service.calculateSessionCost('s3');

    const written = (prisma.chargingSession.update as jest.Mock).mock.calls[0][0].data;
    expect(written.costPerKwh).toBe(0.49);
    expect(written.costSource).toBe('supercharger');
  });

  it('KNOWN, ACCEPTED DIVERGENCE: when VehicleSettings is entirely missing, the migrated service now uses one shared canonicalDefaultRate instead of the old per-bucket hardcoded literal', async () => {
    // Pre-migration: settings?.homeChargingRate ?? 0.32 (home bucket) vs
    // settings?.thirdPartyRate ?? 0.45 (third-party bucket) -- two
    // different hardcoded numbers depending on chargerType. Post-migration:
    // TariffResolverService's single canonicalDefaultRate (0.35, see
    // ChargingModule) applies regardless of bucket. This branch requires a
    // vehicle with NO VehicleSettings row at all, which VehiclesService's
    // "always ensure VehicleSettings exist" guarantee makes practically
    // unreachable in production (charging.md) -- documented here as the
    // one accepted exception per the migration's own ground rules, not
    // silently absorbed into the "unchanged" assertions above.
    const session = {
      id: 's-no-settings', vehicleId: VEHICLE_ID, chargerType: 'ac_home', maxPowerKw: 7,
      energyAddedKwh: 10, startTime: new Date(), costSource: null,
      vehicle: { id: VEHICLE_ID, userId: 'u1', settings: null },
    };
    const { service, prisma } = makeService(session);

    await service.calculateSessionCost('s-no-settings');

    const written = (prisma.chargingSession.update as jest.Mock).mock.calls[0][0].data;
    expect(written.costPerKwh).toBe(0.35); // NOT the old 0.32 home-bucket literal
    expect(written.costSource).toBe('tariff');
  });

  it('a session already costed as manual is never recalculated', async () => {
    const session = {
      id: 's4', vehicleId: VEHICLE_ID, chargerType: 'ac_home', maxPowerKw: 7,
      energyAddedKwh: 10, startTime: new Date(), costSource: 'manual',
      vehicle: { id: VEHICLE_ID, userId: 'u1', settings: REAL_SEED_SETTINGS },
    };
    const { service, prisma } = makeService(session);

    await service.calculateSessionCost('s4');

    expect(prisma.chargingSession.update).not.toHaveBeenCalled();
  });

  it('a session already costed via tesla_api is never recalculated', async () => {
    const session = {
      id: 's5', vehicleId: VEHICLE_ID, chargerType: 'ac_home', maxPowerKw: 7,
      energyAddedKwh: 10, startTime: new Date(), costSource: 'tesla_api',
      vehicle: { id: VEHICLE_ID, userId: 'u1', settings: REAL_SEED_SETTINGS },
    };
    const { service, prisma } = makeService(session);

    await service.calculateSessionCost('s5');

    expect(prisma.chargingSession.update).not.toHaveBeenCalled();
  });
});

describe('CURRENT BEHAVIOR: VehicleAnalyticsService.getCostSummary', () => {
  // UPDATE (VehicleAnalyticsService migration): getCostSummary's fallback
  // for sessions with no persisted cost now delegates to a real
  // TariffResolverService instead of its own substring-based
  // classification. Three tests below intentionally assert NEW values,
  // each documented as an approved, real (shadow-comparison-verified)
  // behavior change -- not silent drift:
  //   - ac_city/ac_fast: were misclassified as home (old `includes('ac')`
  //     substring bug), now correctly resolve as third_party.
  //   - non-home sessions: used the caller's pricePerKwh (prod default
  //     €0.13), now use settings.thirdPartyRate (real seed €0.55).
  //   - tesla_sc/supercharger: had NO dedicated branch at all before (fell
  //     into the generic non-home bucket); now resolves through the
  //     canonical Supercharger tariff tier. This is the one real session
  //     the live shadow comparison against production data actually found.
  // The plain 'ac_home' case is genuinely unchanged (both old and new
  // classify it as home) and is kept as a true regression assertion.
  function makeService(fixtures: { settings?: any; sessions: any[]; distanceKm: number }) {
    const prisma: any = {
      vehicleSettings: {
        findUnique: jest.fn(async () => fixtures.settings ?? null),
      },
      chargingSession: {
        findMany: jest.fn(async ({ where }: any) =>
          fixtures.sessions.filter(s => matchesWhere(s, where)),
        ),
      },
      trip: {
        aggregate: jest.fn(async () => ({ _sum: { distanceKm: fixtures.distanceKm } })),
      },
    };
    const tariffResolver = new TariffResolverService(prisma, undefined, undefined, {
      canonicalDefaultRate: 0.35,
      canonicalCurrency: 'EUR',
    });
    // getCostSummary caches via cacheGet/cacheSet — stub both as no-ops so
    // repeated calls in the same test don't need a real cache backend.
    const service = new VehicleAnalyticsService(prisma, {} as any, {} as any, undefined as any, undefined as any, tariffResolver);
    jest.spyOn(service as any, 'cacheGet').mockResolvedValue(null);
    jest.spyOn(service as any, 'cacheSet').mockResolvedValue(undefined);
    return { service, prisma };
  }

  it('prefers a session\'s persisted costTotal over re-deriving a rate', async () => {
    const { service } = makeService({
      settings: { chargingCost: 0, homeChargingRate: 0.35 },
      sessions: [
        { vehicleId: VEHICLE_ID, energyAddedKwh: 10, costTotal: 99, cost: null, chargerType: 'ac_home', startTime: new Date(), endTime: new Date() },
      ],
      distanceKm: 100,
    });

    const result = await service.getCostSummary(VEHICLE_ID, 0.13);

    expect(result.totalCost).toBe(99); // NOT 10*0.35 -- persisted value wins
    expect(result.costPerKm).toBeCloseTo(0.99, 5);
  });

  it('UNCHANGED: home charger types still use homeChargingRate when costTotal is missing', async () => {
    const { service } = makeService({
      settings: REAL_SEED_SETTINGS,
      sessions: [
        { vehicleId: VEHICLE_ID, energyAddedKwh: 10, costTotal: null, cost: null, chargerType: 'ac_home', startTime: new Date(), endTime: new Date() },
      ],
      distanceKm: 100,
    });

    const result = await service.getCostSummary(VEHICLE_ID, 0.13);

    expect(result.totalCost).toBe(3.5); // 10 * 0.35 (home), not the 0.13 pricePerKwh param
  });

  it('APPROVED CHANGE: non-home charger types now use settings.thirdPartyRate, not the caller pricePerKwh', async () => {
    const { service } = makeService({
      settings: REAL_SEED_SETTINGS, // thirdPartyRate: 0.55
      sessions: [
        { vehicleId: VEHICLE_ID, energyAddedKwh: 10, costTotal: null, cost: null, chargerType: 'dc_third', startTime: new Date(), endTime: new Date() },
      ],
      distanceKm: 100,
    });

    const result = await service.getCostSummary(VEHICLE_ID, 0.13);

    // Before: 10 * 0.13 = 1.3 (caller pricePerKwh). After: 10 * 0.55 = 5.5.
    expect(result.totalCost).toBe(5.5);
  });

  it('APPROVED CHANGE: ac_city/ac_fast are reclassified from home to third_party (fixes the old includes(\'ac\') substring bug)', async () => {
    const { service } = makeService({
      settings: REAL_SEED_SETTINGS,
      sessions: [
        { vehicleId: VEHICLE_ID, energyAddedKwh: 10, costTotal: null, cost: null, chargerType: 'ac_city', startTime: new Date(), endTime: new Date() },
      ],
      distanceKm: 100,
    });

    const result = await service.getCostSummary(VEHICLE_ID, 0.13);

    // Before: 'ac_city'.includes('ac') -> misclassified home -> 10*0.35=3.5
    // After: correctly third_party -> 10*0.55=5.5
    expect(result.totalCost).toBe(5.5);
  });

  it('APPROVED CHANGE: tesla_sc/supercharger sessions now resolve the Supercharger tariff instead of falling into the generic non-home bucket', async () => {
    // This is the exact real-world case the live shadow comparison against
    // production data found: a tesla_sc session with no persisted cost.
    const { service } = makeService({
      settings: REAL_SEED_SETTINGS, // superchargerRate: 0.49
      sessions: [
        { vehicleId: VEHICLE_ID, energyAddedKwh: 10, costTotal: null, cost: null, chargerType: 'tesla_sc', startTime: new Date(), endTime: new Date() },
      ],
      distanceKm: 100,
    });

    const result = await service.getCostSummary(VEHICLE_ID, 0.13);

    // Before: no supercharger-aware branch existed -> treated as non-home -> 10*0.13=1.3
    // After: vehicle_settings.supercharger tier -> 10*0.49=4.9
    expect(result.totalCost).toBe(4.9);
  });
});

describe('CURRENT BEHAVIOR: CostForecastService.resolveRate / forecastForVehicle', () => {
  function makeService(fixtures: { sessions: any[]; settings?: any; dailyEnergyRows?: any[] }) {
    const prisma: any = {
      chargingSession: {
        findMany: jest.fn(async ({ where }: any) =>
          fixtures.sessions.filter(s => matchesWhere(s, where)),
        ),
      },
      vehicleSettings: {
        findUnique: jest.fn(async () => fixtures.settings ?? null),
      },
      dailyEnergy: {
        findMany: jest.fn(async () => fixtures.dailyEnergyRows ?? []),
      },
      trip: {
        groupBy: jest.fn(async () => []),
      },
    };
    const service = new CostForecastService(prisma);
    return { service, prisma };
  }

  it('uses the weighted average of >=3 real-cost sessions when available (source: sessions)', async () => {
    const { service } = makeService({
      sessions: [
        { vehicleId: VEHICLE_ID, costTotal: 3.5, energyAddedKwh: 10 },
        { vehicleId: VEHICLE_ID, costTotal: 7.0, energyAddedKwh: 20 },
        { vehicleId: VEHICLE_ID, costTotal: 10.5, energyAddedKwh: 30 },
      ],
    });

    const result = await service.resolveRate(VEHICLE_ID);

    expect(result.source).toBe('sessions');
    expect(result.rate).toBeCloseTo(0.35, 5); // (3.5+7+10.5)/(10+20+30)
  });

  it('falls back to settings.homeChargingRate when fewer than 3 priced sessions exist (source: settings)', async () => {
    const { service } = makeService({
      sessions: [{ vehicleId: VEHICLE_ID, costTotal: 3.5, energyAddedKwh: 10 }],
      settings: { homeChargingRate: 0.35, chargingCost: 0 },
    });

    const result = await service.resolveRate(VEHICLE_ID);

    expect(result.source).toBe('settings');
    expect(result.rate).toBe(0.35);
  });

  it('falls back to the hardcoded €0.25 only when settings itself is entirely absent (source: default)', async () => {
    const { service } = makeService({ sessions: [], settings: null });

    const result = await service.resolveRate(VEHICLE_ID);

    expect(result.source).toBe('default');
    expect(result.rate).toBe(0.25);
  });

  it('forecastForVehicle multiplies avgEnergyPerDay by the resolved rate for week/month projections', async () => {
    const { service } = makeService({
      sessions: [],
      settings: { homeChargingRate: 0.35, chargingCost: 0 },
      dailyEnergyRows: Array.from({ length: 10 }, () => ({ energyUsedKwh: 9 })), // 90 kWh over 30-day window
    });

    const result = await service.forecastForVehicle(VEHICLE_ID);

    expect(result.avgEnergyPerDay).toBe(3); // 90/30, divided by period length not row count
    expect(result.rateSource).toBe('settings');
    expect(result.effectiveRate).toBe(0.35);
    expect(result.weeklyCost).toBeCloseTo(3 * 7 * 0.35, 5);
    expect(result.monthlyCost).toBeCloseTo(3 * 30 * 0.35, 5);
  });
});
