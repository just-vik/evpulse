/**
 * Regression: billing counter must increment exactly once per REST poll —
 * only for the billable GET /vehicle_data request, NOT for GET /vehicles/{id}
 * (getVehicleSummary), which Tesla does not charge as a Daten call.
 *
 * Root cause of the 2026-10-19 incident: recordEstimatedBillingRequest was
 * called after both getVehicleSummary and getVehicleData, doubling the counter
 * and causing the fleet budget-breaker to fire at ~50 % of real Daten spend,
 * degrading REST polling to 1 call/hour and losing trip data for the morning.
 */

import { TelemetryFetcherService } from '../src/tesla-fleet/telemetry-fetcher.service';

const VEHICLE_ID  = 'veh-billing-test';
const VEHICLE_VIN = 'VIN_BILLING';
const USER_ID     = 'user-billing-test';

function parkedVehicleData() {
  return {
    drive_state:   { shift_state: 'P', speed: null, latitude: 50.1, longitude: 8.4, heading: 0, power: 0, gps_as_of: null },
    charge_state:  { charging_state: 'Disconnected', usable_battery_level: 60, battery_level: 62, charge_energy_added: 0, charger_actual_current: 0, charger_voltage: 0 },
    climate_state: { outside_temp: 15 },
    vehicle_state: { odometer: 45000 },
    location_data: {},
  };
}

function buildRedisMock() {
  return {
    get:              jest.fn().mockResolvedValue(null),
    set:              jest.fn().mockResolvedValue('OK'),
    del:              jest.fn().mockResolvedValue(1),
    eval:             jest.fn().mockResolvedValue(1),
    incr:             jest.fn().mockResolvedValue(1),
    expire:           jest.fn().mockResolvedValue(1),
    zadd:             jest.fn().mockResolvedValue(1),
    zcard:            jest.fn().mockResolvedValue(1),
    pexpire:          jest.fn().mockResolvedValue(1),
    zremrangebyscore: jest.fn().mockResolvedValue(1),
    lpush:            jest.fn().mockResolvedValue(1),
    ltrim:            jest.fn().mockResolvedValue('OK'),
  };
}

function buildFetcherWithRawRedis(teslaFleet: any) {
  const rawRedis = buildRedisMock();
  const redis    = buildRedisMock();
  const prisma   = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({ id: VEHICLE_ID, vin: VEHICLE_VIN, teslaId: 99999 }),
    },
  };
  const teslaOAuth   = { getValidAccessToken: jest.fn().mockResolvedValue('tok') };
  const stateMachine = {
    updateVehicleState: jest.fn().mockResolvedValue(undefined),
    setSleeping:        jest.fn().mockResolvedValue(undefined),
    getVehicleState:    jest.fn().mockResolvedValue({ state: 'parked' }),
  };
  const svc = new TelemetryFetcherService(
    teslaFleet as any,
    teslaOAuth as any,
    stateMachine as any,
    { savePoint: jest.fn() } as any,
    { checkTripState: jest.fn() } as any,
    { checkChargingState: jest.fn() } as any,
    { addPoint: jest.fn() } as any,
    prisma as any,
    redis as any,
    rawRedis as any,
    undefined,
    undefined,
    { increment: jest.fn(), decrement: jest.fn(), trackWake: jest.fn().mockResolvedValue(undefined) } as any,
  );
  return { svc, rawRedis, teslaFleet };
}

beforeAll(() => { jest.spyOn(Math, 'random').mockReturnValue(0); });
afterAll(() => { jest.restoreAllMocks(); });

describe('TelemetryFetcherService — billing counter (Daten regression)', () => {

  it('full poll increments billing counter exactly once — only vehicle_data is billable', async () => {
    const teslaFleet = {
      getVehicleSummary: jest.fn().mockResolvedValue({ state: 'online' }),
      getVehicleData:    jest.fn().mockResolvedValue(parkedVehicleData()),
    };
    const { svc, rawRedis } = buildFetcherWithRawRedis(teslaFleet);

    await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );

    expect(teslaFleet.getVehicleSummary).toHaveBeenCalledTimes(1);
    expect(teslaFleet.getVehicleData).toHaveBeenCalledTimes(1);

    // recordEstimatedBillingRequest calls rawRedis.incr twice per invocation
    // (vehicle-specific key + fleet-wide key).  With the fix, it is called
    // exactly once (after getVehicleData), so incr total = 2.
    const incrCalls: string[] = rawRedis.incr.mock.calls.map((c: any[]) => c[0] as string);
    const billingIncrCalls = incrCalls.filter(k => k.startsWith('tesla:billing:'));

    expect(billingIncrCalls).toHaveLength(2); // vehicle key + fleet key, once each
    expect(billingIncrCalls.some(k => k.includes('fleet-req-count'))).toBe(true);
    expect(billingIncrCalls.some(k => k.includes(`req-count:${VEHICLE_ID}`))).toBe(true);
  });

  it('getVehicleSummary returning asleep skips vehicle_data — billing counter not incremented', async () => {
    const teslaFleet = {
      getVehicleSummary: jest.fn().mockResolvedValue({ state: 'asleep' }),
      getVehicleData:    jest.fn().mockResolvedValue(parkedVehicleData()),
    };
    const { svc, rawRedis } = buildFetcherWithRawRedis(teslaFleet);

    await (svc as any)._fetchVehicleTelemetryInner(
      VEHICLE_ID, USER_ID, { bypassSlidingWindow: true },
    );

    expect(teslaFleet.getVehicleData).not.toHaveBeenCalled();

    const billingIncrCalls = rawRedis.incr.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter(k => k.startsWith('tesla:billing:'));

    // No billable call was made — counter must not move
    expect(billingIncrCalls).toHaveLength(0);
  });

});
