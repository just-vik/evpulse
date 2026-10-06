import {
  MOVING_SPEED_THRESHOLD_KMH,
  VehicleState,
  VehicleStateMachineService,
  classifyVehicleState,
} from '../src/tesla-fleet/vehicle-state-machine.service';
import {
  VehicleAnalyticsService,
  resolveTripContractState,
  toFreshness,
} from '../src/analytics/vehicle-analytics.service';
import { TelemetryGateway } from '../src/websockets/telemetry.gateway';

// VehicleStateContract v1 (Patch B). Vehicle state is classified in exactly one
// place (classifyVehicleState); every entry point — REST (updateVehicleState),
// generic telemetry (updateFromTelemetry), and the analytics read path — must
// agree with it. The critical regression: a car in D/R at 0 km/h is STOPPED,
// never PARKED.

const NOW = new Date('2026-10-06T14:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('classifyVehicleState — one classifier for all telemetry paths', () => {
  it('P + 0 km/h → parked', () => {
    expect(classifyVehicleState({ speed: 0, shiftState: 'P' })).toBe(VehicleState.PARKED);
  });

  it('D + 0 km/h → stopped (regression: 0 km/h in gear is NOT parked)', () => {
    const state = classifyVehicleState({ speed: 0, shiftState: 'D' });
    expect(state).toBe(VehicleState.STOPPED);
    expect(state).not.toBe(VehicleState.PARKED);
  });

  it('R + 0 km/h → stopped', () => {
    expect(classifyVehicleState({ speed: 0, shiftState: 'R' })).toBe(VehicleState.STOPPED);
  });

  it('D + >2 km/h → driving', () => {
    expect(classifyVehicleState({ speed: 30, shiftState: 'D' })).toBe(VehicleState.DRIVING);
  });

  it('GPS-drift speed (≤2 km/h) in D does not count as driving', () => {
    expect(classifyVehicleState({ speed: 1.5, shiftState: 'P' })).toBe(VehicleState.PARKED);
    expect(classifyVehicleState({ speed: 1.5, shiftState: 'D' })).toBe(VehicleState.STOPPED);
  });

  it('charging → charging, and charging takes precedence over speed', () => {
    expect(classifyVehicleState({ speed: 0, chargingState: 'Charging', shiftState: 'P' }))
      .toBe(VehicleState.CHARGING);
    expect(classifyVehicleState({ speed: 40, chargingState: 'Charging', shiftState: 'D' }))
      .toBe(VehicleState.CHARGING);
  });

  it('missing shift_state at 0 km/h → parked (no fabricated STOPPED)', () => {
    expect(classifyVehicleState({ speed: 0, shiftState: null })).toBe(VehicleState.PARKED);
  });

  it('moving threshold is the single named constant: at it → not driving, just above → driving', () => {
    expect(classifyVehicleState({ speed: MOVING_SPEED_THRESHOLD_KMH, shiftState: 'D' }))
      .toBe(VehicleState.STOPPED);
    expect(classifyVehicleState({ speed: MOVING_SPEED_THRESHOLD_KMH + 0.1, shiftState: 'D' }))
      .toBe(VehicleState.DRIVING);
  });

  it('charging is decided by charging_state only — a positive power reading alone is not charging', () => {
    // Decision carried over from the analytics read path (power > 1 removed): power alone
    // is ambiguous (HVAC, preconditioning). Real charging detection stays on charging_state.
    expect(classifyVehicleState({ speed: 0, chargingState: null, shiftState: 'P' }))
      .toBe(VehicleState.PARKED);
    expect(classifyVehicleState({ speed: 0, chargingState: 'Charging', shiftState: 'P' }))
      .toBe(VehicleState.CHARGING);
  });
});

describe('STOPPED polling cadence — regression guard against a 2s STOPPED', () => {
  it('D + 0 km/h → STOPPED with a 30s fallback cadence, not the DRIVING cadence', async () => {
    const prisma = {
      vehicleState: { upsert: jest.fn().mockImplementation(async ({ create }: any) => ({ ...create, lastUpdate: NOW })) },
    };
    const service = new VehicleStateMachineService(prisma as any);
    await service.updateVehicleState('veh-1', {
      drive_state: { speed: 0, shift_state: 'D', timestamp: NOW_SEC },
      charge_state: { charging_state: 'Disconnected' },
      vehicle_state: { is_user_present: true },
    });
    const data = await service.getVehicleState('veh-1');
    expect(data.state).toBe(VehicleState.STOPPED);
    expect(data.pollingInterval).toBe(30);
  });

  it('DRIVING keeps the 2s cadence (cadence is per state, not per "active" bucket)', async () => {
    const prisma = {
      vehicleState: { upsert: jest.fn().mockImplementation(async ({ create }: any) => ({ ...create, lastUpdate: NOW })) },
    };
    const service = new VehicleStateMachineService(prisma as any);
    await service.updateVehicleState('veh-1', {
      drive_state: { speed: 40, shift_state: 'D', timestamp: NOW_SEC },
      charge_state: { charging_state: 'Disconnected' },
      vehicle_state: { is_user_present: true },
    });
    const data = await service.getVehicleState('veh-1');
    expect(data.state).toBe(VehicleState.DRIVING);
    expect(data.pollingInterval).toBe(2);
  });
});

describe('VehicleStateMachineService — REST entry (updateVehicleState → determineState)', () => {
  function build() {
    const prisma = {
      vehicleState: {
        upsert: jest.fn().mockImplementation(async ({ create }: any) => ({
          ...create, lastUpdate: NOW,
        })),
      },
    };
    return { service: new VehicleStateMachineService(prisma as any), prisma };
  }

  function restData(opts: { speed: number; shiftState?: string | null; charging?: string; present?: boolean; idleSec?: number }) {
    return {
      drive_state: {
        speed: opts.speed,
        shift_state: opts.shiftState ?? null,
        timestamp: NOW_SEC - (opts.idleSec ?? 0),
      },
      charge_state: { charging_state: opts.charging ?? 'Disconnected' },
      vehicle_state: { is_user_present: opts.present ?? true },
    };
  }

  async function stateFor(data: any): Promise<string> {
    const { service, prisma } = build();
    await service.updateVehicleState('veh-1', data);
    return prisma.vehicleState.upsert.mock.calls[0][0].update.state;
  }

  it('P + 0 km/h → parked (REST path reads shift_state)', async () => {
    expect(await stateFor(restData({ speed: 0, shiftState: 'P' }))).toBe('parked');
  });

  it('D + 0 km/h → stopped (REST path reads shift_state)', async () => {
    expect(await stateFor(restData({ speed: 0, shiftState: 'D' }))).toBe('stopped');
  });

  it('R + 0 km/h → stopped (REST path reads shift_state)', async () => {
    expect(await stateFor(restData({ speed: 0, shiftState: 'R' }))).toBe('stopped');
  });

  it('D + >2 km/h → driving', async () => {
    expect(await stateFor(restData({ speed: 30, shiftState: 'D' }))).toBe('driving');
  });

  it('charging → charging', async () => {
    expect(await stateFor(restData({ speed: 0, shiftState: 'P', charging: 'Charging' }))).toBe('charging');
  });

  it('user absent and idle > 10 min at 0 km/h → sleeping', async () => {
    expect(await stateFor(restData({
      speed: 0, shiftState: 'P', present: false, idleSec: 20 * 60,
    }))).toBe('sleeping');
  });

  it('no drive_state at all → offline', async () => {
    expect(await stateFor({})).toBe('offline');
    expect(await stateFor(null)).toBe('offline');
  });
});

describe('VehicleStateMachineService — generic telemetry entry (updateFromTelemetry)', () => {
  function build() {
    const prisma = {
      vehicleState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return new VehicleStateMachineService(prisma as any);
  }

  it('propagates shift_state: D + 0 km/h → stopped', async () => {
    const service = build();
    const r = await service.updateFromTelemetry('veh-1', {
      speed: 0, power: 0, charging_state: 'Disconnected', shift_state: 'D',
    });
    expect(r.newState).toBe(VehicleState.STOPPED);
  });

  it('P + 0 km/h → parked', async () => {
    const service = build();
    const r = await service.updateFromTelemetry('veh-1', {
      speed: 0, power: 0, charging_state: 'Disconnected', shift_state: 'P',
    });
    expect(r.newState).toBe(VehicleState.PARKED);
  });

  it('>2 km/h → driving, with or without shift_state', async () => {
    const service = build();
    const r = await service.updateFromTelemetry('veh-1', { speed: 40, shift_state: null });
    expect(r.newState).toBe(VehicleState.DRIVING);
  });
});

describe('Classifier parity — REST and generic paths agree on identical input', () => {
  it('D + 0 km/h classifies identically through both entry points', async () => {
    const restPrisma = {
      vehicleState: { upsert: jest.fn().mockImplementation(async ({ create }: any) => ({ ...create, lastUpdate: NOW })) },
    };
    const restService = new VehicleStateMachineService(restPrisma as any);
    await restService.updateVehicleState('veh-1', {
      drive_state: { speed: 0, shift_state: 'D', timestamp: NOW_SEC },
      charge_state: { charging_state: 'Disconnected' },
      vehicle_state: { is_user_present: true },
    });
    const restState = restPrisma.vehicleState.upsert.mock.calls[0][0].update.state;

    const genericService = new VehicleStateMachineService({
      vehicleState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any);
    const generic = await genericService.updateFromTelemetry('veh-1', {
      speed: 0, charging_state: 'Disconnected', shift_state: 'D',
    });

    expect(restState).toBe('stopped');
    expect(generic.newState).toBe('stopped');
    expect(restState).toBe(generic.newState);
  });
});

describe('Trip contract — derived trip state', () => {
  it('open trip + realtime → active', () => {
    expect(resolveTripContractState(true, 'realtime')).toBe('active');
  });

  it('open trip + delayed → active', () => {
    expect(resolveTripContractState(true, 'delayed')).toBe('active');
  });

  it('open trip + stale → waiting_for_telemetry', () => {
    expect(resolveTripContractState(true, 'stale')).toBe('waiting_for_telemetry');
  });

  it('open trip + no_data → waiting_for_telemetry', () => {
    expect(resolveTripContractState(true, 'no_data')).toBe('waiting_for_telemetry');
  });

  it('no open trip → null, regardless of freshness', () => {
    expect(resolveTripContractState(false, 'realtime')).toBeNull();
    expect(resolveTripContractState(false, 'no_data')).toBeNull();
  });

  it('freshness spelling maps 1:1 from DataQuality', () => {
    expect(toFreshness('REALTIME')).toBe('realtime');
    expect(toFreshness('DELAYED')).toBe('delayed');
    expect(toFreshness('STALE')).toBe('stale');
    expect(toFreshness('OFFLINE')).toBe('no_data');
  });
});

describe('VehicleAnalyticsService.getVehicleStatus — trip + freshness contract', () => {
  function telemetryPoint(overrides: Record<string, unknown> = {}) {
    return {
      timestamp: NOW, soc: 50, batteryRangeKm: 200, speed: 0, power: 0,
      batteryTemp: 20, voltage: 350, outsideTemp: 15, insideTemp: 20, odometer: 1000,
      shift_state: 'P', charging_state: 'Disconnected',
      ...overrides,
    };
  }

  function build(opts: { latest: any; openTrip: { id: string } | null; dbState?: string }) {
    const prisma = {
      vehicleState: { findUnique: jest.fn().mockResolvedValue({ state: opts.dbState ?? 'parked', lastUpdate: NOW, chargingState: null, locked: true }) },
      chargingSession: { findFirst: jest.fn().mockResolvedValue(null) },
      trip: { findFirst: jest.fn().mockResolvedValue(opts.openTrip) },
      telemetryPoint: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const telemetryService = { getLatestPoint: jest.fn().mockResolvedValue(opts.latest) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const service = new VehicleAnalyticsService(
      prisma as any, telemetryService as any, redis as any, undefined as any, undefined as any, {} as any,
    );
    return { service, prisma };
  }

  it('open trip + fresh telemetry → trip.id set, state active, freshness realtime', async () => {
    const { service } = build({ latest: telemetryPoint({ timestamp: NOW }), openTrip: { id: 'trip-A' } });
    const s = await service.getVehicleStatus('veh-1');
    expect(s.trip).toEqual({ id: 'trip-A', state: 'active' });
    expect(s.freshness).toBe('realtime');
  });

  it('open trip + telemetry 10 min old → waiting_for_telemetry, freshness stale', async () => {
    const { service } = build({
      latest: telemetryPoint({ timestamp: new Date(NOW.getTime() - 10 * 60_000) }),
      openTrip: { id: 'trip-B' },
    });
    const s = await service.getVehicleStatus('veh-1');
    expect(s.trip).toEqual({ id: 'trip-B', state: 'waiting_for_telemetry' });
    expect(s.freshness).toBe('stale');
  });

  it('no open trip → trip {id: null, state: null}', async () => {
    const { service } = build({ latest: telemetryPoint({ timestamp: NOW }), openTrip: null });
    const s = await service.getVehicleStatus('veh-1');
    expect(s.trip).toEqual({ id: null, state: null });
  });

  it('closed trip never becomes active: lookup is restricted to endTime IS NULL', async () => {
    const { service, prisma } = build({ latest: telemetryPoint({ timestamp: NOW }), openTrip: null });
    await service.getVehicleStatus('veh-1');
    expect(prisma.trip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ vehicleId: 'veh-1', endTime: null }) }),
    );
  });

  it('D + 0 km/h in the analytics read path is stopped, not parked (regression)', async () => {
    // The read path re-derives vehicleState from fresh telemetry only when the stored
    // state is passive (sleeping/offline/waking); a stored 'parked' is trusted as-is.
    // So the regression is exercised from a passive stored state.
    const { service } = build({
      latest: telemetryPoint({ timestamp: NOW, speed: 0, shift_state: 'D', charging_state: 'Disconnected' }),
      openTrip: null,
      dbState: 'sleeping',
    });
    const s = await service.getVehicleStatus('veh-1');
    expect(s.vehicleState).toBe('stopped');
  });

  it('no telemetry at all → freshness no_data, lastTelemetryAt null, trip still reported', async () => {
    const { service } = build({ latest: null, openTrip: { id: 'trip-C' } });
    const s = await service.getVehicleStatus('veh-1');
    expect(s.freshness).toBe('no_data');
    expect(s.lastTelemetryAt).toBeNull();
    expect(s.trip).toEqual({ id: 'trip-C', state: 'waiting_for_telemetry' });
  });
});

describe('REST ↔ WebSocket parity — same Contract semantics', () => {
  it('stale telemetry: REST and WS report identical freshness and lastTelemetryAt', async () => {
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60_000);

    const prisma = {
      vehicleState: { findUnique: jest.fn().mockResolvedValue({ state: 'parked', lastUpdate: NOW, chargingState: null, locked: true }) },
      chargingSession: { findFirst: jest.fn().mockResolvedValue(null) },
      trip: { findFirst: jest.fn().mockResolvedValue(null) },
      telemetryPoint: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const latest = {
      timestamp: tenMinAgo, soc: 50, batteryRangeKm: 200, speed: 0, power: 0,
      batteryTemp: 20, voltage: 350, outsideTemp: 15, insideTemp: 20, odometer: 1000,
      shift_state: 'P', charging_state: 'Disconnected',
    };
    const analytics = new VehicleAnalyticsService(
      prisma as any,
      { getLatestPoint: jest.fn().mockResolvedValue(latest) } as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') } as any,
      undefined as any, undefined as any, {} as any,
    );
    const rest = await analytics.getVehicleStatus('veh-1');

    const gateway = new TelemetryGateway({} as any, {} as any, {} as any);
    const emit = jest.fn();
    (gateway as any).server = { to: jest.fn().mockReturnValue({ emit }) };
    gateway.emitTelemetryUpdate('veh-1', { speed: 0 }, tenMinAgo);
    const ws = emit.mock.calls[0][1];

    expect(ws.freshness).toBe(rest.freshness);
    expect(ws.freshness).toBe('stale');
    expect(ws.lastTelemetryAt).toBe(rest.lastTelemetryAt);
    expect(ws.lastTelemetryAt).toBe(tenMinAgo.toISOString());
  });
});
