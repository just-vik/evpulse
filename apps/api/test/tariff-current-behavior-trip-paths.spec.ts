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
 */

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
