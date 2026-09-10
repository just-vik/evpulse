/**
 * CONTRACT tests for TariffResolverService — the future/new-system group,
 * deliberately kept separate from tariff-current-behavior*.spec.ts (the
 * CURRENT-BEHAVIOR group) per docs/calculations/tariff-resolver.md §12.
 * These assert the policy that document defines, not what the five old
 * implementations happen to do today.
 *
 * TariffResolverService is not yet wired into any of the five consumers —
 * these tests exercise it in isolation.
 */

import { TariffResolverService, TariffResolverConfig } from '../src/charging/tariff-resolver.service';

const VEHICLE_ID = 'veh-1';
const CONFIG: TariffResolverConfig = { canonicalDefaultRate: 0.30, canonicalCurrency: 'EUR' };

const REAL_SEED_SETTINGS = {
  homeChargingRate: 0.35,
  superchargerRate: 0.49,
  thirdPartyRate: 0.55,
};

function makeResolver(opts: {
  settings?: any;
  vehicle?: any;
  historicalSessions?: any[];
  superchargerPricing?: any;
  teslaOAuth?: any;
  config?: TariffResolverConfig | undefined;
} = {}) {
  const prisma: any = {
    vehicle: { findUnique: jest.fn(async () => opts.vehicle ?? { userId: 'u1' }) },
    vehicleSettings: { findUnique: jest.fn(async () => opts.settings ?? null) },
    chargingSession: { findMany: jest.fn(async () => opts.historicalSessions ?? []) },
  };
  const resolver = new TariffResolverService(
    prisma,
    opts.superchargerPricing,
    opts.teslaOAuth,
    'config' in opts ? opts.config : CONFIG,
  );
  return { resolver, prisma };
}

describe('TariffResolverService — actual_cost', () => {
  it('Supercharger catalog wins over everything when it resolves (highest priority)', async () => {
    const superchargerPricing = { getRateForSession: jest.fn(async () => ({ ratePerKwh: 0.42, stationName: 'A9 Nord', source: 'tesla_api' })) };
    const teslaOAuth = { getValidAccessToken: jest.fn(async () => 'tok') };
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, superchargerPricing, teslaOAuth });

    const result = await resolver.resolve({
      purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger',
      location: { latitude: 50.1, longitude: 8.6 }, timestamp: new Date(),
    });

    expect(result).toEqual({ rate: 0.42, currency: 'EUR', source: 'supercharger_catalog' });
    expect(superchargerPricing.getRateForSession).toHaveBeenCalled();
  });

  it('falls through to vehicle_settings.supercharger when the catalog has no match', async () => {
    const superchargerPricing = { getRateForSession: jest.fn(async () => null) };
    const teslaOAuth = { getValidAccessToken: jest.fn(async () => 'tok') };
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, superchargerPricing, teslaOAuth });

    const result = await resolver.resolve({
      purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger',
      location: { latitude: 50.1, longitude: 8.6 },
    });

    expect(result).toEqual({ rate: 0.49, currency: 'EUR', source: 'vehicle_settings.supercharger' });
  });

  it('falls through to vehicle_settings.supercharger when the catalog call throws', async () => {
    const superchargerPricing = { getRateForSession: jest.fn(async () => { throw new Error('network'); }) };
    const teslaOAuth = { getValidAccessToken: jest.fn(async () => 'tok') };
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, superchargerPricing, teslaOAuth });

    const result = await resolver.resolve({
      purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger',
      location: { latitude: 50.1, longitude: 8.6 },
    });

    expect(result.source).toBe('vehicle_settings.supercharger');
  });

  it('skips the catalog entirely when no location is given, going straight to vehicle_settings.supercharger', async () => {
    const superchargerPricing = { getRateForSession: jest.fn() };
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, superchargerPricing });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger' });

    expect(superchargerPricing.getRateForSession).not.toHaveBeenCalled();
    expect(result).toEqual({ rate: 0.49, currency: 'EUR', source: 'vehicle_settings.supercharger' });
  });

  it('Supercharger ToD: uses the standard (peak) rate during the configured peak window', async () => {
    const { resolver } = makeResolver({
      settings: { ...REAL_SEED_SETTINGS, superchargerOffPeakRate: 0.30, superchargerPeakStart: 8, superchargerPeakEnd: 22, timezone: 'Europe/Berlin' },
    });

    const result = await resolver.resolve({
      purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger',
      timestamp: new Date('2026-06-15T12:00:00Z'), // noon UTC = noon or +1/+2h Berlin, well within 8-22
    });

    expect(result).toEqual({ rate: 0.49, currency: 'EUR', source: 'vehicle_settings.supercharger' });
  });

  it('Supercharger ToD: uses the off-peak rate outside the configured peak window', async () => {
    const { resolver } = makeResolver({
      settings: { ...REAL_SEED_SETTINGS, superchargerOffPeakRate: 0.30, superchargerPeakStart: 8, superchargerPeakEnd: 22, timezone: 'Europe/Berlin' },
    });

    const result = await resolver.resolve({
      purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger',
      timestamp: new Date('2026-06-15T02:00:00Z'), // 2am UTC = 4am Berlin (summer) -- outside 8-22
    });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'vehicle_settings.supercharger' });
  });

  it('Supercharger ToD: with no off-peak rate configured, always uses the standard rate regardless of time', async () => {
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS }); // superchargerOffPeakRate undefined

    const result = await resolver.resolve({
      purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger',
      timestamp: new Date('2026-06-15T02:00:00Z'),
    });

    expect(result).toEqual({ rate: 0.49, currency: 'EUR', source: 'vehicle_settings.supercharger' });
  });

  it('0 is treated as unconfigured for homeChargingRate, falling through to the default tier', async () => {
    const { resolver } = makeResolver({ settings: { ...REAL_SEED_SETTINGS, homeChargingRate: 0 } });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_home' });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'default' });
  });

  it('0 is treated as unconfigured for thirdPartyRate, falling through to the default tier', async () => {
    const { resolver } = makeResolver({ settings: { ...REAL_SEED_SETTINGS, thirdPartyRate: 0 } });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'dc_third' });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'default' });
  });

  it('0 is treated as unconfigured for superchargerRate, falling through to the default tier (canonicalizes the TripDetector-vs-TripGapRecovery divergence)', async () => {
    const { resolver } = makeResolver({ settings: { ...REAL_SEED_SETTINGS, superchargerRate: 0 } });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger' });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'default' });
  });

  it('resolves vehicle_settings.third_party for third-party charger types', async () => {
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_city' });

    expect(result).toEqual({ rate: 0.55, currency: 'EUR', source: 'vehicle_settings.third_party' });
  });

  it('resolves vehicle_settings.home for home charger types and for an unrecognized/missing chargerType', async () => {
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS });

    const home = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_home' });
    const unknown = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID });

    expect(home).toEqual({ rate: 0.35, currency: 'EUR', source: 'vehicle_settings.home' });
    expect(unknown).toEqual({ rate: 0.35, currency: 'EUR', source: 'vehicle_settings.home' });
  });

  it('never uses historical_sessions for actual_cost, even when >=3 priced sessions exist', async () => {
    const { resolver, prisma } = makeResolver({
      settings: REAL_SEED_SETTINGS,
      historicalSessions: [
        { costTotal: 1, energyAddedKwh: 1 }, { costTotal: 1, energyAddedKwh: 1 }, { costTotal: 1, energyAddedKwh: 1 },
      ],
    });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_home' });

    expect(result.source).not.toBe('historical_sessions');
    expect(prisma.chargingSession.findMany).not.toHaveBeenCalled(); // not even queried for this purpose
  });

  it('falls through to the canonical default when no settings row exists', async () => {
    const { resolver } = makeResolver({ settings: null });

    const result = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_home' });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'default' });
  });
});

describe('TariffResolverService — forecast', () => {
  it('uses the historical weighted rate when >=3 priced sessions exist', async () => {
    const { resolver } = makeResolver({
      historicalSessions: [
        { costTotal: 3.5, energyAddedKwh: 10 },
        { costTotal: 7.0, energyAddedKwh: 20 },
        { costTotal: 10.5, energyAddedKwh: 30 },
      ],
    });

    const result = await resolver.resolve({ purpose: 'forecast', vehicleId: VEHICLE_ID });

    expect(result).toEqual({ rate: 0.35, currency: 'EUR', source: 'historical_sessions' });
  });

  it('falls through to vehicle_settings when fewer than 3 priced sessions exist', async () => {
    const { resolver } = makeResolver({
      historicalSessions: [{ costTotal: 3.5, energyAddedKwh: 10 }],
      settings: REAL_SEED_SETTINGS,
    });

    const result = await resolver.resolve({ purpose: 'forecast', vehicleId: VEHICLE_ID });

    expect(result).toEqual({ rate: 0.35, currency: 'EUR', source: 'vehicle_settings.home' });
  });

  it('falls through to the canonical default when neither history nor settings exist', async () => {
    const { resolver } = makeResolver({});

    const result = await resolver.resolve({ purpose: 'forecast', vehicleId: VEHICLE_ID });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'default' });
  });

  it('never calls the Supercharger catalog for a forecast', async () => {
    const superchargerPricing = { getRateForSession: jest.fn() };
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, superchargerPricing });

    await resolver.resolve({ purpose: 'forecast', vehicleId: VEHICLE_ID, chargerType: 'supercharger', location: { latitude: 1, longitude: 1 } });

    expect(superchargerPricing.getRateForSession).not.toHaveBeenCalled();
  });
});

describe('TariffResolverService — historical_summary', () => {
  it('never uses historical_sessions (weighted average) to backfill its own gaps', async () => {
    const { resolver, prisma } = makeResolver({
      settings: REAL_SEED_SETTINGS,
      historicalSessions: [
        { costTotal: 1, energyAddedKwh: 1 }, { costTotal: 1, energyAddedKwh: 1 }, { costTotal: 1, energyAddedKwh: 1 },
      ],
    });

    const result = await resolver.resolve({ purpose: 'historical_summary', vehicleId: VEHICLE_ID, chargerType: 'ac_home' });

    expect(result.source).not.toBe('historical_sessions');
    expect(result.source).toBe('vehicle_settings.home');
    expect(prisma.chargingSession.findMany).not.toHaveBeenCalled();
  });

  it('never calls the Supercharger catalog', async () => {
    const superchargerPricing = { getRateForSession: jest.fn() };
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, superchargerPricing });

    await resolver.resolve({ purpose: 'historical_summary', vehicleId: VEHICLE_ID, chargerType: 'supercharger', location: { latitude: 1, longitude: 1 } });

    expect(superchargerPricing.getRateForSession).not.toHaveBeenCalled();
  });

  it('falls through to the canonical default when no settings row exists', async () => {
    const { resolver } = makeResolver({ settings: null });

    const result = await resolver.resolve({ purpose: 'historical_summary', vehicleId: VEHICLE_ID });

    expect(result).toEqual({ rate: 0.30, currency: 'EUR', source: 'default' });
  });
});

describe('TariffResolverService — source provenance is granular', () => {
  it('never returns the coarse "vehicle_settings" string — always a dotted sub-source', async () => {
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS });

    const home = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_home' });
    const thirdParty = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'dc_third' });
    const supercharger = await resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'supercharger' });

    for (const r of [home, thirdParty, supercharger]) {
      expect(r.source).toMatch(/^vehicle_settings\./);
      expect(r.source).not.toBe('vehicle_settings');
    }
  });
});

describe('TariffResolverService — currency is never silently defaulted to EUR', () => {
  it('throws instead of guessing a currency when no TariffResolverConfig is supplied', async () => {
    const { resolver } = makeResolver({ settings: REAL_SEED_SETTINGS, config: undefined });

    await expect(
      resolver.resolve({ purpose: 'actual_cost', vehicleId: VEHICLE_ID, chargerType: 'ac_home' }),
    ).rejects.toThrow(/canonicalCurrency/);
  });

  it('throws instead of guessing when reaching the default tier with no config, even for historical_summary', async () => {
    const { resolver } = makeResolver({ settings: null, config: undefined });

    await expect(
      resolver.resolve({ purpose: 'historical_summary', vehicleId: VEHICLE_ID }),
    ).rejects.toThrow(/canonicalCurrency|TariffResolverConfig/);
  });
});

describe('TariffResolverService — manualCost is not a resolver concern', () => {
  it('the resolver has no manualCost parameter or handling at all (contract-level check)', () => {
    // manualCost is checked by the CALLER before resolve() is ever invoked
    // (tariff-resolver.md §6) -- this is a structural assertion that the
    // method signature carries no such concept, not a runtime behavior test.
    const resolveParams = TariffResolverService.prototype.resolve.length;
    expect(resolveParams).toBe(1); // (context: TariffContext) only
  });
});
