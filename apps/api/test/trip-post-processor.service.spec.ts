/**
 * E2E test for TripPostProcessorService — 5-stage pipeline.
 *
 * Uses a mock PrismaService (no DB), passes synthetic trip data, and asserts
 * that reliability score, repair reasons, efficiency clamp, distance
 * recomputation, and energy recovery all behave correctly.
 *
 * GPS track design rule: speed implied between consecutive points must stay
 * < 200 km/h to avoid the GPS jump filter (Stage 1 threshold).
 * For stage 2 (distance recomputation): note Math.round(km * 10) / 10 rounds
 * to 1 decimal place — plan coordinate offsets accordingly.
 */

import { TripPostProcessorService } from '../src/trips/trip-post-processor.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTrip(overrides: Record<string, any> = {}): any {
  return {
    id: 'trip-1',
    vehicleId: 'veh-1',
    startTime: new Date('2026-03-18T10:00:00Z'),
    endTime: new Date('2026-03-18T10:30:00Z'),
    startSoc: 80,
    endSoc: 60,
    distanceKm: 50,
    energyUsedKwh: null,
    efficiencyWhkm: null,
    reliability: null,
    repairReason: null,
    qualityScore: null,
    vehicle: {
      batteryCapacityDetected: null,
      batteryCapacityUsable: null,
      vehicleSpec: { batteryUsableKwh: 75 },
    },
    ...overrides,
  };
}

/** GPS point with coordinates spaced to stay < 200 km/h between consecutive entries */
function pt(lat: number, lon: number, ts: Date, power = 0): any {
  return { latitude: lat, longitude: lon, timestamp: ts, power };
}

function makePrisma(trip: any, points: any[], telemetryPoints: any[] = []) {
  const updated: any[] = [];
  const telemetryFindFirst = jest
    .fn()
    // startOdoBefore
    .mockResolvedValueOnce(null)
    // startOdoAfter
    .mockResolvedValueOnce(null)
    // endOdoRow
    .mockResolvedValueOnce(null)
    // startSoc repair lookup
    .mockResolvedValueOnce(null)
    // endSoc repair lookup
    .mockResolvedValueOnce(null);
  return {
    chargingSession: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    trip: {
      findMany:   jest.fn().mockResolvedValue([trip]),
      findUnique: jest.fn().mockResolvedValue(trip),
      update:     jest.fn().mockImplementation(({ data }: any) => {
        updated.push(data);
        return Promise.resolve({ ...trip, ...data });
      }),
      delete:     jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    tripPoint: {
      findMany:   jest.fn().mockResolvedValue(points),
      updateMany: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    tripStats: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    // telemetryPoint: odometer anchors, tail-window after trip end, optional fallback points
    telemetryPoint: {
      findMany: jest.fn().mockImplementation((args: any) => {
        if (args?.where?.timestamp?.gt != null && args?.where?.timestamp?.lte != null) {
          return Promise.resolve([]);
        }
        return Promise.resolve(telemetryPoints);
      }),
      findFirst: telemetryFindFirst,
    },
    _updated: updated,
  };
}

// ─── TripPostProcessorService tests ──────────────────────────────────────────

describe('TripPostProcessorService', () => {

  // ── Clean trip with pre-set energy → HIGH reliability ────────────────────

  it('assigns HIGH reliability to a clean trip with valid energy and distance', async () => {
    // Pre-set energyUsedKwh so we don't rely on GPS-based distance recomputation.
    // Empty GPS array: Stage 1 finds no invalid points, Stage 2 skips (< 2 valid pts).
    // Score = 100, energyUsedKwh = 15 → HIGH.
    //
    // socDrop = 80 - 60 = 20% >= the 2% "SOC-delta is ground truth" threshold (Stage 3:
    // "Energy source priority for trips" — BMS coulomb counting beats the power integral,
    // which undercounts net consumption because regen returns as negative power). So the
    // pipeline recomputes energy from SOC instead of trusting the pre-set power-integral
    // value outright, and tags the trip 'energy_from_soc_preferred' accordingly. The
    // recomputed value (20% of 75 kWh = 15 kWh) happens to numerically match the pre-set
    // value here — this trip fixture just isn't a case where the two sources disagree.
    const trip = makeTrip({
      startSoc: 80, endSoc: 60,
      distanceKm: 50,
      energyUsedKwh: 15,  // 300 Wh/km — physically plausible
    });
    const prisma = makePrisma(trip, []);  // no points = no GPS to analyse
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.reliability).toBe('HIGH');
    expect(saved.energyUsedKwh).toBeCloseTo(15, 1);
    expect(saved.efficiencyWhkm).toBeCloseTo(300, 0);
    expect(saved.qualityScore).toBeGreaterThanOrEqual(80);
    expect(saved.repairReason).toBe('energy_from_soc_preferred');
  });

  // ── Stage 1: GPS teleport → gps_cleaned repair reason ────────────────────

  it('detects GPS teleport and adds gps_cleaned repair reason', async () => {
    const BASE = new Date('2026-03-18T10:00:00Z');
    const points = [
      pt(55.0000, 37.0000, BASE),
      // 1° in 0.5 s → ~111 km in 0.5 s → 800,000 km/h >> 200 km/h → GPS jump
      pt(56.0000, 38.0000, new Date(BASE.getTime() + 500)),
      // Normal continuation
      pt(55.0010, 37.0010, new Date(BASE.getTime() + 30_000)),
    ];

    const trip = makeTrip({ startSoc: 80, endSoc: 70, energyUsedKwh: 7.5, distanceKm: 25 });
    const prisma = makePrisma(trip, points);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.repairReason).toContain('gps_cleaned');
    expect(saved.reliability).toBeDefined();
  });

  // ── Stage 2: distance recomputation fires when track differs >10% ─────────

  it('recomputes distance when GPS track differs by more than 10%', async () => {
    const BASE = new Date('2026-03-18T10:00:00Z');
    // Points ~0.15° lat apart, 10 min between each → ~16.7 km / 600s ≈ 100 km/h ✓
    const points = [
      pt(55.00, 37.00, BASE),
      pt(55.15, 37.00, new Date(BASE.getTime() + 600_000)),
      pt(55.30, 37.00, new Date(BASE.getTime() + 1_200_000)),
    ];

    // Pre-set distanceKm = 10 (GPS haversine gives ~33 km → >10% diff → recomputed)
    const trip = makeTrip({
      startSoc: 80, endSoc: 55,
      distanceKm: 10,
      energyUsedKwh: 12,
    });
    const prisma = makePrisma(trip, points);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    // Recomputed distance ~33 km >> 10% diff from 10 km
    expect(saved.repairReason).toContain('distance_recomputed');
    // After recompute: efficiency = 12000/33 ≈ 364 Wh/km — valid, not clamped
    expect(saved.efficiencyWhkm).toBeGreaterThan(0);
    expect(saved.efficiencyWhkm).toBeLessThan(600);
  });

  // ── Stage 4: efficiency > 600 Wh/km → null both energy and efficiency ─────

  it('nulls out efficiency and energy when efficiency > 600 Wh/km', async () => {
    // Empty GPS → Stage 2 skips → distanceKm stays at 0.1 km
    // SOC drop 40% × 75 kWh = 30 kWh → efficiency = 30000/0.1 = 300,000 >> 600
    const trip = makeTrip({
      startSoc: 80, endSoc: 40,
      distanceKm: 0.1,  // 100 m
      energyUsedKwh: null,
    });
    const prisma = makePrisma(trip, []);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.efficiencyWhkm).toBeNull();
    expect(saved.energyUsedKwh).toBeNull();
    expect(saved.repairReason).toContain('efficiency_out_of_range');
  });

  // ── Stage 4: efficiency ≤ 0 (negative energy) → null ─────────────────────

  it('resets implausible negative energy and keeps efficiency null', async () => {
    // energyUsedKwh = -5 (corrupt sensor reading)
    // SOC went UP (charging noise) → SOC model gives null → stays at -5
    // Stage 4: efficiency = -5000/20 = -250 ≤ 0 → clamp both to null
    const trip = makeTrip({
      startSoc: 50, endSoc: 80,  // SOC rose — impossible for driving
      distanceKm: 20,
      energyUsedKwh: -5,
    });
    const prisma = makePrisma(trip, []);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.efficiencyWhkm).toBeNull();
    expect(saved.energyUsedKwh).toBeNull();
    expect(saved.repairReason).toContain('energy_implausible_reset');
  });

  // ── Stage 5: gap penalty drives reliability below HIGH ────────────────────

  it('rejects a gappy track whose SOC-preferred energy is physically implausible for the GPS distance → LOW', async () => {
    const BASE = new Date('2026-03-18T10:00:00Z');
    // Points 0.001° apart per 2 minutes → implied ~3.8 km/h ✓ (< 200 km/h)
    // GPS haversine of these 6 points ≈ 0.64 km total (5 × ~0.128 km each).
    const points = [
      pt(55.0000, 37.0000, BASE),
      pt(55.0010, 37.0010, new Date(BASE.getTime() + 2 * 60_000)),
      pt(55.0020, 37.0020, new Date(BASE.getTime() + 4 * 60_000)),
      pt(55.0030, 37.0030, new Date(BASE.getTime() + 6 * 60_000)),
      pt(55.0040, 37.0040, new Date(BASE.getTime() + 8 * 60_000)),
      pt(55.0050, 37.0050, new Date(BASE.getTime() + 10 * 60_000)),
    ];

    // startSoc=80, endSoc=75 → socDrop=5% >= the 2% SOC-priority threshold, so the
    // pipeline discards the pre-set 0.2 kWh power-integral energy and recomputes from
    // SOC instead: 5% of 75 kWh usable = 3.75 kWh. Over the ~0.64 km GPS distance that's
    // ~5859 Wh/km — no Tesla loses 5% charge in 640 metres, so Stage 4's >600 Wh/km
    // plausibility gate correctly discards the energy entirely, which forces LOW
    // regardless of the (otherwise-MEDIUM) gap-penalty score. This is intentional:
    // the safety threshold must not be weakened to make an old fixture pass — see the
    // next test for the gap-penalty→MEDIUM path exercised under a plausible energy value.
    const trip = makeTrip({
      startSoc: 80, endSoc: 75, distanceKm: 1.5, energyUsedKwh: 0.2,
    });
    const prisma = makePrisma(trip, points);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.energyUsedKwh).toBeNull();
    expect(saved.efficiencyWhkm).toBeNull();
    expect(saved.reliability).toBe('LOW');
  });

  it('applies gap penalty and yields MEDIUM reliability for a gappy track (plausible energy, SOC drop below priority threshold)', async () => {
    const BASE = new Date('2026-03-18T10:00:00Z');
    // Same gappy GPS track as above (5 gaps each >60 s: −25 points → score ≈ 75 →
    // MEDIUM, below the HIGH threshold of 80).
    const points = [
      pt(55.0000, 37.0000, BASE),
      pt(55.0010, 37.0010, new Date(BASE.getTime() + 2 * 60_000)),
      pt(55.0020, 37.0020, new Date(BASE.getTime() + 4 * 60_000)),
      pt(55.0030, 37.0030, new Date(BASE.getTime() + 6 * 60_000)),
      pt(55.0040, 37.0040, new Date(BASE.getTime() + 8 * 60_000)),
      pt(55.0050, 37.0050, new Date(BASE.getTime() + 10 * 60_000)),
    ];

    // startSoc=80, endSoc=79 → socDrop=1%, BELOW the 2% SOC-priority threshold, so the
    // pre-set power-integral energy (0.2 kWh) is kept as-is instead of being overridden.
    // Efficiency = 0.2 kWh × 1000 / ~0.64 km GPS distance ≈ 313 Wh/km — plausible (<600),
    // so this exercises the gap-penalty scoring path in isolation from Stage 3's SOC
    // priority / Stage 4's implausibility gate.
    const trip = makeTrip({
      startSoc: 80, endSoc: 79, distanceKm: 1.5, energyUsedKwh: 0.2,
    });
    const prisma = makePrisma(trip, points);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    // 5 gaps × 5 pts = −25 → score ≈ 75: below HIGH(80) but above LOW(50)
    expect(saved.qualityScore).toBeLessThan(80);
    expect(saved.qualityScore).toBeGreaterThanOrEqual(50);
    expect(saved.reliability).toBe('MEDIUM');
    expect(saved.energyUsedKwh).toBeCloseTo(0.2, 2);
  });

  // ── Stage 3: LOW reliability always uses SOC energy model ────────────────

  it('forces SOC-only energy model for LOW reliability trips', async () => {
    // Trip already has LOW reliability with suspiciously high power-integral energy
    const trip = makeTrip({
      reliability: 'LOW',
      startSoc: 80, endSoc: 60,
      distanceKm: 50,
      energyUsedKwh: 99,  // noisy power integral — should be overridden by SOC model
    });
    const prisma = makePrisma(trip, []);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    // SOC model: (80−60)/100 × 75 = 15 kWh
    expect(saved.energyUsedKwh).toBeCloseTo(15, 1);
  });

  // ── Stage 3: energy recovery from SOC when energyUsedKwh is missing ──────

  it('recovers energy from SOC delta when energyUsedKwh is null', async () => {
    const trip = makeTrip({
      startSoc: 90, endSoc: 70,
      distanceKm: 50, energyUsedKwh: null,
    });
    const prisma = makePrisma(trip, []);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    // SOC model: 20/100 × 75 = 15 kWh
    expect(saved.energyUsedKwh).toBeCloseTo(15, 1);
    expect(saved.repairReason).toContain('energy_recovered_from_soc');
  });

  // ── repairReason separator is | (not ;) ───────────────────────────────────

  it('joins multiple repair reasons with | separator (not semicolon)', async () => {
    const BASE = new Date('2026-03-18T10:00:00Z');
    // GPS teleport triggers gps_cleaned; tiny distance + large SOC drop triggers efficiency_out_of_range
    const points = [
      pt(55.0000, 37.0000, BASE),
      pt(56.0000, 38.0000, new Date(BASE.getTime() + 500)),    // GPS jump (1° in 0.5s)
      pt(55.0001, 37.0001, new Date(BASE.getTime() + 30_000)),
    ];

    const trip = makeTrip({
      startSoc: 80, endSoc: 40,
      distanceKm: 0.1,
      energyUsedKwh: null,
    });
    const prisma = makePrisma(trip, points);
    const svc = new TripPostProcessorService(prisma as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.repairReason).toContain('gps_cleaned');
    // Must use | as separator — never semicolons
    expect(saved.repairReason).not.toContain(';');
    if (saved.repairReason?.includes('|')) {
      const parts = (saved.repairReason as string).split('|');
      parts.forEach((p: string) => expect(p.trim().length).toBeGreaterThan(0));
    }
  });
});

// ─── Stage 6: map matching / route reconstruction wiring ─────────────────────
//
// MapMatchingService itself is unit-tested in map-matching.service.spec.ts.
// These tests verify the post-processor correctly consumes its diagnostics:
// a route that needed a singleton bridge must never be reported as HIGH
// confidence, an OSRM failure must never clobber the existing route, and
// re-processing the same trip must not duplicate tags or flip the result.

describe('TripPostProcessorService — map matching wiring', () => {
  const BASE = new Date('2026-03-18T10:00:00Z');
  // Mirrors the file's known-good "clean trip" fixture (startSoc 80→60, distanceKm 50,
  // energyUsedKwh 15 — SOC-preferred energy model reproduces 15 kWh regardless of GPS),
  // extended with 3 GPS points ~25 km apart / 20 min apart (≈75 km/h, no jump-filter
  // trip, GPS distance ≈ the preset 50 km so Stage 2 doesn't rewrite it) so the map
  // matching branch (validPoints.length >= 3) actually runs.
  const points = [
    pt(55.0000, 37.00, BASE),
    pt(55.2246, 37.00, new Date(BASE.getTime() + 1_200_000)),
    pt(55.4492, 37.00, new Date(BASE.getTime() + 2_400_000)),
  ];

  function makeMockMapMatching(result: any) {
    return { match: jest.fn().mockResolvedValue(result) };
  }

  it('downgrades HIGH reliability to MEDIUM when the route required a singleton bridge', async () => {
    const trip = makeTrip({
      startSoc: 80, endSoc: 60, distanceKm: 50, energyUsedKwh: 15,
      // Must cover the full points range (last point is BASE + 2_400_000 ms) —
      // otherwise effectivePoints filters the last point out silently, leaving
      // only 2 valid points and routing into the gap-recovery branch instead
      // of the validPoints.length >= 3 branch this suite is testing.
      endTime: new Date(BASE.getTime() + 2_460_000),
    });
    const prisma = makePrisma(trip, points);
    const mapMatching = makeMockMapMatching({
      polyline: 'xyz', distanceKm: 50, type: 'estimated',
      segmentCount: 4, singletonBridgeCount: 2, largestGapSeconds: 483,
      matchedDistanceKm: 15, routedDistanceKm: 35,
    });
    const svc = new TripPostProcessorService(prisma as any, mapMatching as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    // This trip's energy/SOC data alone would score HIGH — the bridge must cap it.
    expect(saved.reliability).toBe('MEDIUM');
    expect(saved.repairReason).toContain('route_singleton_bridged(2)');
    expect(saved.repairReason).toContain('map_route_estimated');
    expect(saved.repairReason).not.toMatch(/(^|\|)map_matched(\||$)/);
  });

  it('does not downgrade reliability when the route matched without any bridge', async () => {
    const trip = makeTrip({
      startSoc: 80, endSoc: 60, distanceKm: 50, energyUsedKwh: 15,
      // Must cover the full points range (last point is BASE + 2_400_000 ms) —
      // otherwise effectivePoints filters the last point out silently, leaving
      // only 2 valid points and routing into the gap-recovery branch instead
      // of the validPoints.length >= 3 branch this suite is testing.
      endTime: new Date(BASE.getTime() + 2_460_000),
    });
    const prisma = makePrisma(trip, points);
    const mapMatching = makeMockMapMatching({
      polyline: 'xyz', distanceKm: 50, type: 'matched',
      segmentCount: 1, singletonBridgeCount: 0, largestGapSeconds: 60,
      matchedDistanceKm: 50, routedDistanceKm: 0,
    });
    const svc = new TripPostProcessorService(prisma as any, mapMatching as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    expect(saved.reliability).toBe('HIGH');
    expect(saved.repairReason).toContain('map_matched');
    expect(saved.repairReason).not.toContain('route_singleton_bridged');
  });

  it('preserves the existing polyline when OSRM is unreachable (no clobbering with empty/wrong data)', async () => {
    const trip = makeTrip({
      startSoc: 80, endSoc: 60, distanceKm: 50, energyUsedKwh: 15,
      // Must cover the full points range (last point is BASE + 2_400_000 ms) —
      // otherwise effectivePoints filters the last point out silently, leaving
      // only 2 valid points and routing into the gap-recovery branch instead
      // of the validPoints.length >= 3 branch this suite is testing.
      endTime: new Date(BASE.getTime() + 2_460_000),
    });
    const prisma = makePrisma(trip, points);
    const mapMatching = makeMockMapMatching(null);
    const svc = new TripPostProcessorService(prisma as any, mapMatching as any);

    await svc.processTripById('trip-1');

    const saved = prisma._updated[0];
    // polyline key must be omitted from the update payload entirely —
    // a Prisma partial update leaves the existing DB value untouched.
    expect('polyline' in saved).toBe(false);
  });

  it('does not duplicate repair tags or change the result across repeated runs', async () => {
    const trip = makeTrip({
      startSoc: 80, endSoc: 60, distanceKm: 50, energyUsedKwh: 15,
      // Must cover the full points range (last point is BASE + 2_400_000 ms) —
      // otherwise effectivePoints filters the last point out silently, leaving
      // only 2 valid points and routing into the gap-recovery branch instead
      // of the validPoints.length >= 3 branch this suite is testing.
      endTime: new Date(BASE.getTime() + 2_460_000),
    });
    const prisma = makePrisma(trip, points);
    // Make update() persist back onto the same `trip` object, so the second
    // processTripById() call sees what the first one actually wrote —
    // the shared makePrisma() helper normally keeps findUnique() static,
    // which would hide any accumulation bug.
    prisma.trip.update = jest.fn().mockImplementation(({ data }: any) => {
      Object.assign(trip, data);
      prisma._updated.push(data);
      return Promise.resolve(trip);
    });
    const mapMatching = makeMockMapMatching({
      polyline: 'xyz', distanceKm: 50, type: 'estimated',
      segmentCount: 4, singletonBridgeCount: 2, largestGapSeconds: 483,
      matchedDistanceKm: 15, routedDistanceKm: 35,
    });
    const svc = new TripPostProcessorService(prisma as any, mapMatching as any);

    await svc.processTripById('trip-1');
    const firstTags = (trip.repairTags ?? []).map((t: any) => t.tag).sort();
    const firstReliability = trip.reliability;
    const firstReason = trip.repairReason;

    await svc.processTripById('trip-1');
    const secondTags = (trip.repairTags ?? []).map((t: any) => t.tag).sort();

    expect(secondTags).toEqual(firstTags);
    expect(trip.reliability).toBe(firstReliability);
    expect(trip.repairReason).toBe(firstReason);
  });
});

