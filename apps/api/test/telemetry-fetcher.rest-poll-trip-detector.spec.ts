/**
 * Regression: P1-B — REST polling does not feed TripDetectorService.
 *
 * Bug: TelemetryFetcherService._fetchVehicleTelemetryInner fetches REST telemetry,
 * stores the point, and returns — but never calls tripDetector.checkTripState.
 * When Fleet Telemetry degrades (rate limited), no new MQTT events reach
 * TelemetryPipelineService (the only other call site for checkTripState). The
 * trip state machine never times out; the watchdog eventually closes the trip
 * after 30–50 min of idle.
 *
 * Real incident (2026-10-18): car parked at 10:45, Fleet Telemetry degraded
 * after 10:40. Next REST poll brought shift_state=P at 10:44, but
 * checkTripState was never called. The watchdog closed the trip at ~11:20.
 *
 * Fix: after `normalizeTeslaPayload(vehicleData)` in _fetchVehicleTelemetryInner,
 * call `this.tripDetector.checkTripState(vehicleId, telemetryPoint)` before
 * returning. This feeds parked/stopped data to the trip state machine regardless
 * of which ingest path is active.
 *
 * These tests FAIL against the pre-fix code and PASS after the fix.
 */

import { TelemetryFetcherService } from '../src/tesla-fleet/telemetry-fetcher.service';

/** Minimal REST API vehicle_data payload that normalizeTeslaPayload maps to shift_state='P' */
function parkedVehicleData(overrides: Record<string, any> = {}) {
  return {
    drive_state: {
      shift_state: 'P',
      speed:       null,
      latitude:    50.0587,
      longitude:   8.4155,
      heading:     180,
      power:       0,
      gps_as_of:   null,
    },
    charge_state: {
      charging_state:           'Disconnected',
      usable_battery_level:     69,
      battery_level:            71,
      charge_energy_added:      0,
      charger_actual_current:   0,
      charger_voltage:          0,
    },
    climate_state: { outside_temp: 12 },
    vehicle_state: { odometer: 27981.0 },  // miles
    location_data: {},
    ...overrides,
  };
}

function buildRedisMock() {
  const store = new Map<string, string>();
  return {
    get:    jest.fn().mockResolvedValue(null),       // no rate limits, no fleet-live
    set:    jest.fn().mockResolvedValue('OK'),
    del:    jest.fn().mockResolvedValue(1),
    eval:   jest.fn().mockResolvedValue(1),          // slidingWindow: allow
    zadd:   jest.fn().mockResolvedValue(1),
    zcard:  jest.fn().mockResolvedValue(1),
    pexpire: jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(1),
    lpush:  jest.fn().mockResolvedValue(1),
    ltrim:  jest.fn().mockResolvedValue('OK'),
    incr:   jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
}

function buildSvc(tripDetectorMock: any) {
  const redis    = buildRedisMock();
  const rawRedis = buildRedisMock();

  const prisma = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'veh-1', vin: 'VIN123', teslaId: 12345,
      }),
    },
  };

  const teslaOAuth = {
    getValidAccessToken: jest.fn().mockResolvedValue('access-token-123'),
  };

  const teslaFleet = {
    getVehicleSummary: jest.fn().mockResolvedValue({ state: 'online' }),
    getVehicleData:    jest.fn().mockResolvedValue(parkedVehicleData()),
  };

  const stateMachine = {
    updateVehicleState: jest.fn().mockResolvedValue(undefined),
    setSleeping:        jest.fn().mockResolvedValue(undefined),
    getVehicleState:    jest.fn().mockResolvedValue({ state: 'driving' }),
  };

  const telemetryService = { savePoint: jest.fn().mockResolvedValue(undefined) };

  const chargingDetector = { checkChargingState: jest.fn().mockResolvedValue(undefined) };

  const telemetryBuffer = {
    addPoint: jest.fn().mockResolvedValue(undefined),
  };

  const chargingSync    = undefined;
  const tripPattern     = undefined;
  const apiUsage        = { increment: jest.fn(), decrement: jest.fn(), trackWake: jest.fn().mockResolvedValue(undefined) };

  const svc = new TelemetryFetcherService(
    teslaFleet as any,
    teslaOAuth as any,
    stateMachine as any,
    telemetryService as any,
    tripDetectorMock as any,
    chargingDetector as any,
    telemetryBuffer as any,
    prisma as any,
    redis as any,
    rawRedis as any,
    chargingSync,
    tripPattern,
    apiUsage as any,
  );

  return { svc, teslaFleet, redis };
}

const VEHICLE_ID = 'veh-1';
const USER_ID    = 'user-1';

describe('TelemetryFetcherService — P1-B REST poll must feed TripDetectorService', () => {
  it('BUG (historical): REST polling previously skipped tripDetector entirely', async () => {
    // Pre-fix: _fetchVehicleTelemetryInner stored the telemetry point and returned
    // without ever calling tripDetector.checkTripState. Trip state machine was blind
    // to REST polls — only Fleet Telemetry (MQTT) woke it. When Fleet Telemetry
    // degraded, trips stayed open until the stale watchdog (30–50 min delay).
    //
    // The bug was: `this.tripDetector` was injected but unused in this code path.
    //
    // After fix: checkTripState is called on every successful REST poll. The
    // following tests verify the exact arguments.
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const tripDetector   = { checkTripState };
    const { svc } = buildSvc(tripDetector);

    await (svc as any)._fetchVehicleTelemetryInner(VEHICLE_ID, USER_ID, { bypassSlidingWindow: true });

    // Post-fix: checkTripState is called (fix is in place).
    expect(checkTripState).toHaveBeenCalledTimes(1);
  });

  it('after fix: REST poll calls tripDetector.checkTripState with parsed telemetry', async () => {
    // This test FAILS against the pre-fix code (checkTripState not called)
    // and PASSES after the fix (checkTripState called with shift_state: 'P').
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const tripDetector   = { checkTripState };
    const { svc } = buildSvc(tripDetector);

    await (svc as any)._fetchVehicleTelemetryInner(VEHICLE_ID, USER_ID, { bypassSlidingWindow: true });

    expect(checkTripState).toHaveBeenCalledTimes(1);
    expect(checkTripState).toHaveBeenCalledWith(
      VEHICLE_ID,
      expect.objectContaining({
        shift_state: 'P',
        speed:       0,   // null mph → 0 km/h
      }),
    );
  });

  it('after fix: REST poll with driving data calls checkTripState with non-null speed', async () => {
    // Verifies the fix works for driving states too, not just parked.
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const tripDetector   = { checkTripState };

    const drivingVehicleData = parkedVehicleData({
      drive_state: {
        shift_state: 'D',
        speed:       37.0,   // mph → ~59.6 km/h after normalization
        latitude:    50.18,
        longitude:   8.43,
        heading:     90,
        power:       -15,
        gps_as_of:   null,
      },
    });

    const redis    = buildRedisMock();
    const rawRedis = buildRedisMock();
    const prisma = {
      vehicle: { findUnique: jest.fn().mockResolvedValue({ id: 'veh-1', vin: 'VIN123', teslaId: 12345 }) },
    };
    const teslaOAuth  = { getValidAccessToken: jest.fn().mockResolvedValue('token') };
    const teslaFleet  = {
      getVehicleSummary: jest.fn().mockResolvedValue({ state: 'online' }),
      getVehicleData:    jest.fn().mockResolvedValue(drivingVehicleData),
    };
    const stateMachine = {
      updateVehicleState: jest.fn().mockResolvedValue(undefined),
      setSleeping: jest.fn().mockResolvedValue(undefined),
      getVehicleState: jest.fn().mockResolvedValue({ state: 'driving' }),
    };
    const svc = new TelemetryFetcherService(
      teslaFleet as any, teslaOAuth as any, stateMachine as any,
      { savePoint: jest.fn() } as any, tripDetector as any,
      { checkChargingState: jest.fn() } as any,
      { addPoint: jest.fn() } as any,
      prisma as any, redis as any, rawRedis as any,
      undefined, undefined, { increment: jest.fn(), decrement: jest.fn(), trackWake: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await (svc as any)._fetchVehicleTelemetryInner(VEHICLE_ID, USER_ID, { bypassSlidingWindow: true });

    expect(checkTripState).toHaveBeenCalledWith(
      VEHICLE_ID,
      expect.objectContaining({ shift_state: 'D' }),
    );
    const call = checkTripState.mock.calls[0][1];
    expect(call.speed).toBeGreaterThan(50);  // ~59.6 km/h
  });
});
