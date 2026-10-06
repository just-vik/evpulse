import { getDataQuality, VehicleAnalyticsService } from '../src/analytics/vehicle-analytics.service';

// P1.2.1 canonical freshness policy — recalibrated against real production
// telemetry cadence for a parked vehicle (observed gaps: 50s–6m20s). See the
// doc comment on getDataQuality for the full rationale; this is the single
// canonical helper — REST, WebSocket, and any future consumer must all read
// dataQuality from here, never recompute their own thresholds.
describe('getDataQuality — canonical freshness thresholds', () => {
  it('0s → REALTIME', () => {
    expect(getDataQuality(0)).toBe('REALTIME');
  });

  it('59s → REALTIME', () => {
    expect(getDataQuality(59)).toBe('REALTIME');
  });

  it('60s → DELAYED', () => {
    expect(getDataQuality(60)).toBe('DELAYED');
  });

  it('299s → DELAYED', () => {
    expect(getDataQuality(299)).toBe('DELAYED');
  });

  it('300s → STALE', () => {
    expect(getDataQuality(300)).toBe('STALE');
  });

  it('899s → STALE', () => {
    expect(getDataQuality(899)).toBe('STALE');
  });

  it('900s → OFFLINE', () => {
    expect(getDataQuality(900)).toBe('OFFLINE');
  });

  it('null → OFFLINE', () => {
    expect(getDataQuality(null)).toBe('OFFLINE');
  });

  it('a very large value → OFFLINE (no upper bound cliff)', () => {
    expect(getDataQuality(999_999)).toBe('OFFLINE');
  });
});

/**
 * Regression tests for the freshness-semantics fix (Oct 2026 State Contract audit).
 *
 * Before this fix, getVehicleStatus() computed freshness from
 * max(latest telemetry timestamp, VehicleState.lastUpdate) — but
 * VehicleStateMachineService.setSleeping() stamps lastUpdate = now on every
 * FAILED REST poll (vehicle_sleeping, zero new data), not just on real
 * telemetry arrival. A vehicle that had been silently asleep for hours could
 * read back as dataQuality='REALTIME' purely because the last (failed) poll
 * attempt happened recently — freshness must reflect real telemetry age only.
 */
describe('VehicleAnalyticsService.getVehicleStatus — freshness reflects real telemetry only', () => {
  function telemetryPoint(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      timestamp: new Date(),
      soc: 50,
      batteryRangeKm: 200,
      speed: 0,
      power: 0,
      batteryTemp: 20,
      voltage: 350,
      outsideTemp: 15,
      insideTemp: 20,
      odometer: 1000,
      ...overrides,
    };
  }

  function buildService(opts: { latest: any; dbState: any }) {
    const prisma = {
      vehicleState: { findUnique: jest.fn().mockResolvedValue(opts.dbState) },
      chargingSession: { findFirst: jest.fn().mockResolvedValue(null) },
      trip: { findFirst: jest.fn().mockResolvedValue(null) },
      telemetryPoint: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const telemetryService = { getLatestPoint: jest.fn().mockResolvedValue(opts.latest) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const service = new VehicleAnalyticsService(
      prisma as any, telemetryService as any, redis as any,
      undefined as any, undefined as any, {} as any,
    );
    return service;
  }

  // Fixed system clock — freshnessSec is computed internally from Date.now(),
  // so pinning "now" is what makes the expected values exact instead of
  // tolerance-banded, and removes any dependency on real test execution speed.
  const NOW = new Date('2026-10-06T14:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('1. fresh telemetry + stale state.lastUpdate → REALTIME (state timestamp is irrelevant)', async () => {
    const service = buildService({
      latest: telemetryPoint({ timestamp: new Date(NOW.getTime() - 10_000) }), // 10s ago
      dbState: { state: 'parked', lastUpdate: new Date(NOW.getTime() - 3_600_000), chargingState: null, locked: true },
    });
    const status = await service.getVehicleStatus('veh-1');
    expect(status.dataQuality).toBe('REALTIME');
    expect(status.dataFreshnessSec).toBe(10);
  });

  it('2. stale telemetry + just-refreshed SLEEPING state.lastUpdate → STALE, NOT REALTIME', async () => {
    const service = buildService({
      latest: telemetryPoint({ timestamp: new Date(NOW.getTime() - 10 * 60_000) }), // 10 min ago
      // setSleeping() stamps lastUpdate = now on a failed poll, with no new telemetry.
      dbState: { state: 'sleeping', lastUpdate: NOW, chargingState: null, locked: true },
    });
    const status = await service.getVehicleStatus('veh-2');
    expect(status.dataQuality).toBe('STALE');
    expect(status.dataFreshnessSec).toBe(600);
  });

  it('3. no telemetry at all + sleeping → freshnessSec null, dataQuality OFFLINE', async () => {
    const service = buildService({
      latest: null,
      dbState: { state: 'sleeping', lastUpdate: NOW, chargingState: null, locked: true },
    });
    const status = await service.getVehicleStatus('veh-3');
    expect(status.dataFreshnessSec).toBeNull();
    expect(status.dataQuality).toBe('OFFLINE');
  });

  it('4. control: fresh telemetry + fresh, agreeing state → REALTIME (happy path unaffected)', async () => {
    const service = buildService({
      latest: telemetryPoint({ timestamp: NOW }),
      dbState: { state: 'parked', lastUpdate: NOW, chargingState: null, locked: true },
    });
    const status = await service.getVehicleStatus('veh-4');
    expect(status.dataQuality).toBe('REALTIME');
    expect(status.dataFreshnessSec).toBe(0);
  });
});
