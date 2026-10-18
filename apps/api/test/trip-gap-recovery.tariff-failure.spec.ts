import { TripGapRecoveryService } from '../src/trips/trip-gap-recovery.service';

/**
 * Regression tests for ARCH-4 Finding A — tariff resolution exception in _recover() loop.
 *
 * Root cause: `tariffResolver.resolve()` was called with no try/catch. A transient DB
 * error causes an exception that exits the for loop, aborting all subsequent pair
 * processing (poison-pill effect). Any pairs after the failing one are silently missed
 * for the duration of the outage.
 *
 * Fix: wrap `tariffResolver.resolve()` in try/catch. On error: log warn with vehicleId,
 * set costTotal = null, and continue processing the remaining pairs. The trip is still
 * created; only cost attribution is deferred.
 *
 * Tests verify:
 *   1. resolve() throws → trip is created with costTotal = null.
 *   2. Error for pair 0 → pair 1 continues processing.
 *   3. Successful resolve → costTotal is calculated correctly.
 *   4. prisma.trip.create throws → error is not masked by the tariff handler.
 */

const VEHICLE_ID = 'veh-gap-1';

// Base time (well within the 24 h runManual window)
const T = Date.now() - 5 * 3600_000;

function makePoint(
  offsetMs: number,
  lat: number,
  lon: number,
  soc: number,
  odometer: number,
) {
  return {
    vehicleId: VEHICLE_ID,
    timestamp: new Date(T - offsetMs),
    latitude:  lat,
    longitude: lon,
    soc,
    odometer,
  };
}

// Pair A→B: 1 h gap, 50 km odo, ~50 km GPS, SOC 80→75
const POINT_A = makePoint(2 * 3600_000, 50.00, 8.4,  80, 1000);
const POINT_B = makePoint(1 * 3600_000, 50.45, 8.4,  75, 1050);

// Pair B→C: second valid pair for loop-continues test
const POINT_C = makePoint(             0, 50.90, 8.4,  70, 1100);

function buildPrisma(opts: { tripCreate?: jest.Mock } = {}) {
  const created: any[] = [];
  const tripCreate =
    opts.tripCreate ??
    jest.fn().mockImplementation(({ data }: any) => {
      created.push(data);
      return Promise.resolve({ id: `trip-${created.length}`, ...data });
    });

  const prisma = {
    telemetryPoint: {
      findMany: jest.fn(),
    },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: VEHICLE_ID,
        batteryCapacityDetected: 75,
        vehicleSpec: null,
      }),
    },
    trip: {
      findFirst: jest.fn().mockResolvedValue(null),
      create:    tripCreate,
      update:    jest.fn().mockResolvedValue({}),
    },
    chargingSession: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  return { prisma, created, tripCreate };
}

function buildService(prisma: any, tariffResolver?: { resolve: jest.Mock }) {
  const geocoding = { reverseShort: jest.fn().mockResolvedValue(null) };
  return new TripGapRecoveryService(prisma as any, geocoding as any, tariffResolver as any);
}

describe('TripGapRecoveryService — tariff failure (ARCH-4)', () => {

  it('1. resolve() throws → trip is created with costTotal = null', async () => {
    const { prisma, created } = buildPrisma();
    prisma.telemetryPoint.findMany.mockResolvedValue([POINT_A, POINT_B]);
    const tariffResolver = { resolve: jest.fn().mockRejectedValue(new Error('DB timeout')) };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.runManual(VEHICLE_ID, 1);

    expect(result.recovered).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].costTotal).toBeNull();
  });

  it('2. tariff error for pair 0 → pair 1 is still processed', async () => {
    const { prisma, created } = buildPrisma();
    // Three points → pairs (A,B) and (B,C) both have energyUsedKwh > 0
    prisma.telemetryPoint.findMany.mockResolvedValue([POINT_A, POINT_B, POINT_C]);
    const tariffResolver = {
      resolve: jest.fn()
        .mockRejectedValueOnce(new Error('first pair fails'))
        .mockResolvedValueOnce({ rate: 0.35 }),
    };
    const svc = buildService(prisma, tariffResolver);

    const result = await svc.runManual(VEHICLE_ID, 1);

    expect(result.recovered).toBe(2);
    expect(created).toHaveLength(2);
    expect(created[0].costTotal).toBeNull();         // pair A→B: tariff failed
    expect(created[1].costTotal).toBeGreaterThan(0); // pair B→C: tariff succeeded
  });

  it('3. successful resolve → costTotal is calculated correctly', async () => {
    const { prisma, created } = buildPrisma();
    prisma.telemetryPoint.findMany.mockResolvedValue([POINT_A, POINT_B]);
    const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
    const svc = buildService(prisma, tariffResolver);

    await svc.runManual(VEHICLE_ID, 1);

    expect(created).toHaveLength(1);
    // energyUsedKwh = (80-75)/100 * 75 = 3.75 kWh
    expect(created[0].energyUsedKwh).toBeCloseTo(3.75, 2);
    // costTotal = round(3.75 * 0.35 * 100) / 100 = round(131.25) / 100 = 1.31
    expect(created[0].costTotal).toBeCloseTo(1.31, 2);
  });

  it('4. prisma.trip.create throws → error propagates, not masked by tariff handler', async () => {
    const tripCreate = jest.fn().mockRejectedValue(new Error('unique constraint violation'));
    const { prisma } = buildPrisma({ tripCreate });
    prisma.telemetryPoint.findMany.mockResolvedValue([POINT_A, POINT_B]);
    const tariffResolver = { resolve: jest.fn().mockResolvedValue({ rate: 0.35 }) };
    const svc = buildService(prisma, tariffResolver);

    await expect(svc.runManual(VEHICLE_ID, 1)).rejects.toThrow('unique constraint violation');
  });
});
