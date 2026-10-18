/**
 * Integration: Fleet Telemetry ↔ REST polling handover guard.
 *
 * When fleet:live:vin:{vin} is present in Redis (5-min TTL, renewed by every
 * MQTT flush), _fetchVehicleTelemetryInner returns null early and never calls
 * tripDetector.checkTripState — avoids double-processing while Fleet Telemetry
 * is healthy and saves API quota.
 *
 * When the key expires (Fleet Telemetry degrades), the REST poll proceeds to
 * call checkTripState with the normalized telemetry — the P1-B fix.
 *
 * Scenarios:
 *   A. fleet:live:vin active  → REST poll returns null, checkTripState not called
 *   B. fleet:live:vin absent  → REST poll calls checkTripState with shift_state
 *   C. Fleet → REST transition → first poll skips, second calls checkTripState
 *      exactly once (no double-close or double-start)
 */

import { TelemetryFetcherService } from '../src/tesla-fleet/telemetry-fetcher.service';

const VEHICLE_ID = 'veh-1';
const VEHICLE_VIN = 'VIN123';
const USER_ID    = 'user-1';

function parkedVehicleData(overrides: Record<string, any> = {}) {
  return {
    drive_state: {
      shift_state: 'P',
      speed:       null,
      latitude:    50.0587,
      longitude:    8.4155,
      heading:     180,
      power:       0,
      gps_as_of:   null,
      ...overrides.drive_state,
    },
    charge_state: {
      charging_state:         'Disconnected',
      usable_battery_level:   69,
      battery_level:          71,
      charge_energy_added:    0,
      charger_actual_current: 0,
      charger_voltage:        0,
    },
    climate_state: { outside_temp: 12 },
    vehicle_state: { odometer: 27981.0 },
    location_data: {},
    ...overrides,
  };
}

/** Redis mock whose fleet:live:vin behaviour can be changed between calls. */
function buildRedisMock() {
  let fleetLive = false;
  const mock = {
    _setFleetLive: (v: boolean) => { fleetLive = v; },
    get: jest.fn().mockImplementation((key: string) => {
      if (key === `fleet:live:vin:${VEHICLE_VIN}`) {
        return Promise.resolve(fleetLive ? '1' : null);
      }
      // all other keys (wake-hint, sleep-confirmed, ratelimit, billing): null → no skip
      return Promise.resolve(null);
    }),
    set:              jest.fn().mockResolvedValue('OK'),
    del:              jest.fn().mockResolvedValue(1),
    eval:             jest.fn().mockResolvedValue(1),   // slidingWindow allow
    zadd:             jest.fn().mockResolvedValue(1),
    zcard:            jest.fn().mockResolvedValue(1),
    pexpire:          jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(1),
    lpush:            jest.fn().mockResolvedValue(1),
    ltrim:            jest.fn().mockResolvedValue('OK'),
    incr:             jest.fn().mockResolvedValue(1),
    expire:           jest.fn().mockResolvedValue(1),
  };
  return mock;
}

function buildFetcher(tripDetectorMock: any, redis: any, vehicleData = parkedVehicleData()) {
  const rawRedis = buildRedisMock();
  const prisma = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: VEHICLE_ID, vin: VEHICLE_VIN, teslaId: 12345,
      }),
    },
  };
  const teslaOAuth  = { getValidAccessToken: jest.fn().mockResolvedValue('token') };
  const teslaFleet  = {
    getVehicleSummary: jest.fn().mockResolvedValue({ state: 'online' }),
    getVehicleData:    jest.fn().mockResolvedValue(vehicleData),
  };
  const stateMachine = {
    updateVehicleState: jest.fn().mockResolvedValue(undefined),
    setSleeping:        jest.fn().mockResolvedValue(undefined),
    getVehicleState:    jest.fn().mockResolvedValue({ state: 'driving' }),
  };
  return new TelemetryFetcherService(
    teslaFleet as any,
    teslaOAuth as any,
    stateMachine as any,
    { savePoint: jest.fn() } as any,
    tripDetectorMock as any,
    { checkChargingState: jest.fn() } as any,
    { addPoint: jest.fn() } as any,
    prisma as any,
    redis as any,
    rawRedis as any,
    undefined,
    undefined,
    {
      increment:  jest.fn(),
      decrement:  jest.fn(),
      trackWake:  jest.fn().mockResolvedValue(undefined),
    } as any,
  );
}

// Eliminate random jitter so tests complete quickly and deterministically.
beforeAll(() => { jest.spyOn(Math, 'random').mockReturnValue(0); });
afterAll(() => { jest.restoreAllMocks(); });

describe('TelemetryFetcherService — Fleet↔REST handover guard', () => {

  it('A: fleet:live:vin active — REST poll returns null without calling checkTripState', async () => {
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const redis = buildRedisMock();
    redis._setFleetLive(true);  // Fleet Telemetry is streaming
    const svc = buildFetcher({ checkTripState }, redis);

    const result = await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );

    // Guard fires: returns null early, never touches tripDetector
    expect(result).toBeNull();
    expect(checkTripState).not.toHaveBeenCalled();
  });

  it('B: fleet:live:vin absent — REST poll calls checkTripState with normalized telemetry', async () => {
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const redis = buildRedisMock();
    redis._setFleetLive(false);  // Fleet Telemetry degraded / key expired
    const svc = buildFetcher({ checkTripState }, redis);

    await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );

    expect(checkTripState).toHaveBeenCalledTimes(1);
    expect(checkTripState).toHaveBeenCalledWith(
      VEHICLE_ID,
      expect.objectContaining({ shift_state: 'P', speed: 0 }),
    );
  });

  it('C: Fleet→REST transition — second poll calls checkTripState exactly once, no double-call', async () => {
    // Simulates TTL expiry on fleet:live:vin:
    //   Poll 1: key present  → REST skips (Fleet Telemetry owns the state machine)
    //   Poll 2: key expired  → REST proceeds → checkTripState called once
    // Verifies there is no window where both paths call checkTripState for the
    // same event (which could produce a double-start or spurious trip close).
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const redis = buildRedisMock();
    const svc = buildFetcher({ checkTripState }, redis);

    // --- Poll 1: Fleet Telemetry is live ---
    redis._setFleetLive(true);
    const r1 = await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );
    expect(r1).toBeNull();
    expect(checkTripState).not.toHaveBeenCalled();

    // --- Simulate TTL expiry: fleet:live:vin key gone ---
    redis._setFleetLive(false);

    // --- Poll 2: REST takes over ---
    await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );

    // Exactly one call across both polls — no double-processing during handover
    expect(checkTripState).toHaveBeenCalledTimes(1);
    expect(checkTripState).toHaveBeenCalledWith(
      VEHICLE_ID,
      expect.objectContaining({ shift_state: 'P' }),
    );
  });

  it('C2: driving REST poll after Fleet degradation calls checkTripState with D state', async () => {
    // Verifies the guard is transparent to shift_state content: once fleet:live expires,
    // a driving REST poll correctly feeds checkTripState (not just parked ones).
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const redis = buildRedisMock();
    redis._setFleetLive(false);

    const drivingData = parkedVehicleData({
      drive_state: {
        shift_state: 'D',
        speed:       37.0,   // mph → ~59.5 km/h after normalization
        latitude:    50.18,
        longitude:    8.43,
        heading:     90,
        power:       -15,
        gps_as_of:   null,
      },
    });
    const svc = buildFetcher({ checkTripState }, redis, drivingData);

    await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );

    expect(checkTripState).toHaveBeenCalledTimes(1);
    const args = checkTripState.mock.calls[0][1];
    expect(args.shift_state).toBe('D');
    expect(args.speed).toBeGreaterThan(50);   // ~59.5 km/h
  });
});
