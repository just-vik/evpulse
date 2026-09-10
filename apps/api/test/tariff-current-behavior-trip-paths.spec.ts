/**
 * CURRENT-BEHAVIOR characterization — isolated tariff-logic snippets from
 * TripDetectorService and TripGapRecoveryService. Second half of the
 * 5-path characterization set (see tariff-current-behavior.spec.ts for the
 * other three); kept in a separate file for the same reason: this is the
 * CURRENT-BEHAVIOR group per docs/calculations/tariff-resolver.md Sec 12,
 * never to be merged with future TariffResolverService contract tests.
 *
 * SCOPING DECISION (explicit, not incidental): TripDetectorService is a
 * ~1900-line stateful state machine and TripGapRecoveryService drives real
 * trip reconstruction — both with no existing test harness. Standing up
 * full fixtures for either just to reach a 9-line tariff-selection snippet
 * was judged disproportionate for a pre-consolidation characterization
 * pass. Instead, each snippet below is a byte-for-byte MIRROR of the real
 * source lines, run in isolation against a minimal fake `prisma`. This is
 * NOT exercising the real code path — if the source changes, these mirrors
 * must be updated to match or this file silently tests the wrong thing.
 * Do not treat this file as end-to-end coverage of either service.
 *
 * TripDetectorService and TripGapRecoveryService are now BOTH MIGRATED to
 * TariffResolverService (see the MIGRATED describe blocks below and commit
 * history) — their CURRENT-BEHAVIOR blocks stay put as the pre-migration
 * pinned record, per the never-merge rule above; they are not re-run
 * against the real migrated code.
 */

import { TariffResolverService } from '../src/charging/tariff-resolver.service';

interface FakeSettings {
  homeChargingRate?: number | null;
  chargingCost?: number | null;
}

/**
 * MIRROR of trip-detector.service.ts:1355-1364 (verified at commit
 * 0ab37e5 — "Cost per trip" block inside finalizeTripToDb).
 */
async function tripFinalizeCostSnippet(
  prisma: { vehicleSettings: { findUnique: (args: any) => Promise<FakeSettings | null> } },
  vehicleId: string,
  energyUsedKwh: number | null,
): Promise<number | null> {
  let costTotal: number | null = null;
  if (energyUsedKwh != null) {
    const settings = await prisma.vehicleSettings.findUnique({ where: { vehicleId } });
    const rateEurKwh = (settings?.homeChargingRate ?? 0) > 0
      ? settings!.homeChargingRate!
      : (settings?.chargingCost ?? 0) > 0
        ? settings!.chargingCost!
        : 0.25;
    costTotal = Math.round(energyUsedKwh * rateEurKwh * 100) / 100;
  }
  return costTotal;
}

/**
 * MIRROR of trip-gap-recovery.service.ts:185-192 ("Cost" block inside the
 * recovered-trip creation flow, verified at commit 0ab37e5).
 */
async function gapRecoveryCostSnippet(
  prisma: { vehicleSettings: { findUnique: (args: any) => Promise<FakeSettings | null> } },
  vehicleId: string,
  energyUsedKwh: number | null,
): Promise<number | null> {
  const settings = await prisma.vehicleSettings.findUnique({ where: { vehicleId } });
  const rateEurKwh = settings?.homeChargingRate ?? 0.35;
  const costTotal = energyUsedKwh != null
    ? Math.round(energyUsedKwh * rateEurKwh * 100) / 100
    : null;
  return costTotal;
}

function makePrisma(settings: FakeSettings | null) {
  return { vehicleSettings: { findUnique: jest.fn(async () => settings) } };
}

describe('CURRENT BEHAVIOR (isolated snippet): TripDetectorService trip-finalize cost', () => {
  it('uses homeChargingRate when it is a positive real value (the actual €0.35 seed)', async () => {
    const prisma = makePrisma({ homeChargingRate: 0.35, chargingCost: 0 });
    const result = await tripFinalizeCostSnippet(prisma, 'veh-1', 20);
    expect(result).toBe(7); // 20 * 0.35
  });

  it('falls through to chargingCost when homeChargingRate is exactly 0 (a real >0 guard, not just ??)', async () => {
    const prisma = makePrisma({ homeChargingRate: 0, chargingCost: 0.4 });
    const result = await tripFinalizeCostSnippet(prisma, 'veh-1', 10);
    expect(result).toBe(4); // 10 * 0.4 -- proves the >0 check actually skips a zero rate
  });

  it('falls through to the hardcoded €0.25 when both homeChargingRate and chargingCost are 0', async () => {
    const prisma = makePrisma({ homeChargingRate: 0, chargingCost: 0 });
    const result = await tripFinalizeCostSnippet(prisma, 'veh-1', 10);
    expect(result).toBe(2.5); // 10 * 0.25
  });

  it('falls through to the hardcoded €0.25 when the settings row is entirely missing', async () => {
    const prisma = makePrisma(null);
    const result = await tripFinalizeCostSnippet(prisma, 'veh-1', 10);
    expect(result).toBe(2.5);
  });

  it('returns null (not 0, not a crash) when energyUsedKwh is null', async () => {
    const prisma = makePrisma({ homeChargingRate: 0.35 });
    const result = await tripFinalizeCostSnippet(prisma, 'veh-1', null);
    expect(result).toBeNull();
    expect(prisma.vehicleSettings.findUnique).not.toHaveBeenCalled(); // short-circuited before any lookup
  });
});

/**
 * MIRROR of trip-detector.service.ts's migrated "Cost per trip" block
 * (finalizeTripToDb, post-TariffResolverService migration) -- same scoping
 * rationale as the CURRENT-BEHAVIOR mirror above: no full state-machine
 * fixtures, just the tariff-selection lines run in isolation, but against
 * a REAL TariffResolverService rather than a re-implemented snippet, so
 * this one can't silently drift from the resolver's actual contract.
 * No chargerType/location is ever passed -- confirmed by tracing the real
 * finalizeTripToDb(): the trip builder never captures charger metadata.
 */
async function tripFinalizeCostViaResolver(
  resolver: TariffResolverService,
  vehicleId: string,
  energyUsedKwh: number | null,
): Promise<number | null> {
  if (energyUsedKwh == null) return null;
  const resolution = await resolver.resolve({ purpose: 'actual_cost', vehicleId });
  return Math.round(energyUsedKwh * resolution.rate * 100) / 100;
}

function makeResolver(settings: FakeSettings | null) {
  const prisma: any = {
    vehicleSettings: { findUnique: jest.fn(async () => settings) },
    vehicle: { findUnique: jest.fn(async () => null) },
  };
  return new TariffResolverService(prisma, undefined, undefined, {
    canonicalDefaultRate: 0.35,
    canonicalCurrency: 'EUR',
  });
}

describe('MIGRATED (isolated snippet): TripDetectorService trip-finalize cost via TariffResolverService', () => {
  it('UNCHANGED: uses homeChargingRate when it is a positive real value (the actual €0.35 seed)', async () => {
    const resolver = makeResolver({ homeChargingRate: 0.35, chargingCost: 0 });
    const result = await tripFinalizeCostViaResolver(resolver, 'veh-1', 20);
    expect(result).toBe(7); // 20 * 0.35
  });

  it('KNOWN, ACCEPTED DIVERGENCE: no longer falls through to chargingCost when homeChargingRate is exactly 0 -- goes straight to the canonical default', async () => {
    // Pre-migration this hit chargingCost (0.4) — see the CURRENT-BEHAVIOR
    // block above. TariffResolverService's vehicle_settings.home tier has
    // no chargingCost fallback (tariff-resolver.md's chargingCost exclusion,
    // already applied identically to ChargingCostService/VehicleAnalyticsService/
    // CostForecastService).
    const resolver = makeResolver({ homeChargingRate: 0, chargingCost: 0.4 });
    const result = await tripFinalizeCostViaResolver(resolver, 'veh-1', 10);
    expect(result).toBe(3.5); // 10 * 0.35 (canonicalDefaultRate), NOT 4 (chargingCost)
  });

  it('KNOWN, ACCEPTED DIVERGENCE: default tier now returns the shared canonicalDefaultRate (0.35) instead of the old hardcoded €0.25', async () => {
    const resolver = makeResolver({ homeChargingRate: 0, chargingCost: 0 });
    const result = await tripFinalizeCostViaResolver(resolver, 'veh-1', 10);
    expect(result).toBe(3.5); // 10 * 0.35, NOT 2.5 (old hardcoded 0.25)
  });

  it('KNOWN, ACCEPTED DIVERGENCE: settings row entirely missing also resolves to canonicalDefaultRate, not the old hardcoded €0.25', async () => {
    const resolver = makeResolver(null);
    const result = await tripFinalizeCostViaResolver(resolver, 'veh-1', 10);
    expect(result).toBe(3.5);
  });

  it('UNCHANGED: returns null (not 0, not a crash) when energyUsedKwh is null, without ever calling the resolver', async () => {
    const resolver = makeResolver({ homeChargingRate: 0.35 });
    const resolveSpy = jest.spyOn(resolver, 'resolve');
    const result = await tripFinalizeCostViaResolver(resolver, 'veh-1', null);
    expect(result).toBeNull();
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe('CURRENT BEHAVIOR (isolated snippet): TripGapRecoveryService cost', () => {
  it('uses homeChargingRate when configured (the actual €0.35 seed)', async () => {
    const prisma = makePrisma({ homeChargingRate: 0.35 });
    const result = await gapRecoveryCostSnippet(prisma, 'veh-1', 20);
    expect(result).toBe(7);
  });

  it('falls through to the hardcoded €0.35 when the settings row is entirely missing', async () => {
    const prisma = makePrisma(null);
    const result = await gapRecoveryCostSnippet(prisma, 'veh-1', 10);
    expect(result).toBe(3.5); // 10 * 0.35 -- dead-code-in-practice, but coincidentally equals the real seed
  });

  it('DIVERGES from TripDetectorService: a homeChargingRate of exactly 0 is used AS-IS, not treated as unconfigured', async () => {
    // This is a real behavioral difference between the two "nearly
    // identical" snippets, not a hypothetical one: TripDetectorService
    // guards with `(...  ?? 0) > 0`, this file's gap-recovery path does
    // not -- it's a plain `??`, which only falls through on null/undefined,
    // never on a real zero. Not currently reachable in production (the
    // real homeChargingRate seed is never 0), but a naive merge of the two
    // snippets during consolidation would silently change this behavior
    // unless it's deliberately decided one way or the other first.
    const prisma = makePrisma({ homeChargingRate: 0 });
    const result = await gapRecoveryCostSnippet(prisma, 'veh-1', 10);
    expect(result).toBe(0); // NOT 3.5 -- proves there is no >0 guard here
  });

  it('returns null when energyUsedKwh is null, but still performs the settings lookup first (unlike TripDetectorService)', async () => {
    // Another real, small divergence: this snippet fetches settings
    // unconditionally, then branches on energyUsedKwh only for the final
    // multiply -- TripDetectorService's snippet short-circuits the lookup
    // itself when energy is null (see the test above). Harmless today
    // (one extra no-op query), but another place the two paths aren't
    // actually identical.
    const prisma = makePrisma({ homeChargingRate: 0.35 });
    const result = await gapRecoveryCostSnippet(prisma, 'veh-1', null);
    expect(result).toBeNull();
    expect(prisma.vehicleSettings.findUnique).toHaveBeenCalledTimes(1);
  });
});

/**
 * MIRROR of trip-gap-recovery.service.ts's migrated "Cost" block, same
 * methodology as the TripDetectorService MIGRATED block above: real
 * TariffResolverService, no chargerType/location (none exists in this
 * code path -- gap-recovered trips have no charger metadata either).
 */
async function gapRecoveryCostViaResolver(
  resolver: TariffResolverService,
  vehicleId: string,
  energyUsedKwh: number | null,
): Promise<number | null> {
  if (energyUsedKwh == null) return null;
  const resolution = await resolver.resolve({ purpose: 'actual_cost', vehicleId });
  return Math.round(energyUsedKwh * resolution.rate * 100) / 100;
}

describe('MIGRATED (isolated snippet): TripGapRecoveryService cost via TariffResolverService', () => {
  it('UNCHANGED: uses homeChargingRate when configured (the actual €0.35 seed)', async () => {
    const resolver = makeResolver({ homeChargingRate: 0.35 });
    const result = await gapRecoveryCostViaResolver(resolver, 'veh-1', 20);
    expect(result).toBe(7);
  });

  it('UNCHANGED (numerically): falls through to canonicalDefaultRate when the settings row is entirely missing', async () => {
    // Old literal was this snippet's own hardcoded 0.35; new literal is
    // TariffResolverService's canonicalDefaultRate, which also happens to
    // be configured as 0.35 today -- a coincidental match, not a
    // guarantee, same caveat as the old comment about this branch being
    // dead-code-in-practice (VehiclesService always ensures a settings row).
    const resolver = makeResolver(null);
    const result = await gapRecoveryCostViaResolver(resolver, 'veh-1', 10);
    expect(result).toBe(3.5);
  });

  it('KNOWN, ACCEPTED DIVERGENCE (synthetic-only): a homeChargingRate of exactly 0 is now treated as unconfigured, converging with TripDetectorService', async () => {
    // This is the one real semantic change from this migration: the old
    // gap-recovery snippet used a plain `?? 0.35`, honoring a literal 0
    // (see the DIVERGES-from-TripDetectorService test above). The resolver
    // canonicalizes the `(x ?? 0) > 0` guard for all consumers, so 0 now
    // falls through to the default tier -- converging the two previously-
    // diverging trip paths onto one behavior.
    //
    // Confirmed via a real-data shadow comparison against the only
    // production VehicleSettings row (vehicle cmmnmqvj80004147xffuos6b3,
    // homeChargingRate=0.32) before this migration: no real settings row
    // has ever had homeChargingRate=0, so this is a synthetic-only accepted
    // behavior difference, not an observed production change -- same
    // treatment as the other "known, accepted divergence" cases across
    // this migration series.
    const resolver = makeResolver({ homeChargingRate: 0 });
    const result = await gapRecoveryCostViaResolver(resolver, 'veh-1', 10);
    expect(result).toBe(3.5); // NOT 0 -- proves the >0 guard now applies here too
  });

  it('CONVERGED with TripDetectorService: returns null without calling the resolver when energyUsedKwh is null', async () => {
    // Old gap-recovery snippet fetched settings unconditionally even when
    // energyUsedKwh was null (see the CURRENT-BEHAVIOR test above) --
    // migration folded this consumer's cost block into the same
    // `if (energyUsedKwh != null)` short-circuit shape already used by
    // TripDetectorService, eliminating that one extra no-op query. Harmless
    // (the old lookup result was never used when energy was null), and
    // consistent with the sibling consumer rather than a new special case.
    const resolver = makeResolver({ homeChargingRate: 0.35 });
    const resolveSpy = jest.spyOn(resolver, 'resolve');
    const result = await gapRecoveryCostViaResolver(resolver, 'veh-1', null);
    expect(result).toBeNull();
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
