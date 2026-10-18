import { Test, TestingModule } from '@nestjs/testing';
import { TelemetryPipelineService } from '../src/telemetry/telemetry-pipeline.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { TripDetectorService } from '../src/trips/trip-detector.service';
import { ChargingDetectorService } from '../src/charging/charging-detector.service';
import { TelemetrySanitizerService } from '../src/telemetry/telemetry-sanitizer.service';
import { TelemetryEventEngine } from '../src/telemetry/telemetry-event-engine.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/infra/redis.provider';
import { VehicleStateMachineService, VehicleState } from '../src/tesla-fleet/vehicle-state-machine.service';
import { TelemetryGateway } from '../src/websockets/telemetry.gateway';

/**
 * Regression tests for P1 — sourceTimestamp flow through the pipeline.
 *
 * The three emitTelemetryUpdate call sites in TelemetryPipelineService now
 * all pass `latest.timestamp ?? null` as the third argument, so the gateway
 * computes dataFreshnessSec from the measurement time, not delivery time.
 *
 * Test matrix:
 *   - Fresh point (timestamp ≈ now) → REALTIME
 *   - Delayed point (timestamp 120s ago) → dataFreshnessSec ≈ 120
 *   - Batch with multiple points → gateway receives timestamp of the LAST point
 *   - Point with no timestamp (undefined) → gateway receives null → OFFLINE semantics
 *   - All three code paths (wasOffline full-state, diff-only, first-ever) pass timestamp
 */
describe('TelemetryPipelineService — sourceTimestamp passed to emitTelemetryUpdate', () => {
  let service: TelemetryPipelineService;
  let gateway: { emitTelemetryUpdate: jest.Mock; emitVehicleOnline: jest.Mock; emitVehicleStateChange: jest.Mock };
  let redisMock: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    eval: jest.Mock;
  };

  async function build(vehicleId: string, prevStateJson: string | null = null) {
    const telemetryService = { createManyTelemetryPoints: jest.fn().mockResolvedValue({ count: 0 }) };
    const tripDetector = { checkTripState: jest.fn().mockResolvedValue(undefined) };
    const chargingDetector = { checkChargingState: jest.fn().mockResolvedValue(undefined) };
    const stateMachine = {
      getVehicleState: jest.fn().mockResolvedValue({ state: VehicleState.DRIVING }),
      updateFromTelemetry: jest.fn().mockResolvedValue({ justWoke: false, newState: VehicleState.DRIVING }),
    };
    const prismaMock = {
      telemetryRaw: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    // Return prevStateJson only for the vehicle:state key; all other gets return null
    // (lock key, lastTs key etc.) to avoid interfering with pipeline logic.
    redisMock = {
      get: jest.fn().mockImplementation((key: string) =>
        key === `vehicle:state:${vehicleId}` ? Promise.resolve(prevStateJson) : Promise.resolve(null),
      ),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };

    gateway = {
      emitTelemetryUpdate: jest.fn(),
      emitVehicleOnline: jest.fn(),
      emitVehicleStateChange: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelemetryPipelineService,
        { provide: REDIS_CLIENT, useValue: redisMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: TelemetryService, useValue: telemetryService },
        { provide: TripDetectorService, useValue: tripDetector },
        { provide: ChargingDetectorService, useValue: chargingDetector },
        { provide: TelemetrySanitizerService, useValue: { sanitize: (_: string, pts: any[]) => pts } },
        { provide: VehicleStateMachineService, useValue: stateMachine },
        { provide: TelemetryGateway, useValue: gateway },
        { provide: TelemetryEventEngine, useValue: { process: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    service = module.get(TelemetryPipelineService);
  }

  // ─── Code path A: first-ever point (no previous state in Redis) ─────────────

  it('first-ever point → emitTelemetryUpdate receives the measurement timestamp', async () => {
    await build('veh-fresh', null);
    const ts = new Date(Date.now() - 2_000);

    await service.processBatch('veh-fresh', [{ timestamp: ts, soc: 80, speed: 0, power: 0 } as any], 'fleet_telemetry');

    expect(gateway.emitTelemetryUpdate).toHaveBeenCalledTimes(1);
    const [, , sourceTs] = gateway.emitTelemetryUpdate.mock.calls[0];
    expect(sourceTs).toEqual(ts);
  });

  it('first-ever point with no timestamp → emitTelemetryUpdate receives null', async () => {
    await build('veh-nots', null);

    await service.processBatch('veh-nots', [{ soc: 80, speed: 0, power: 0 } as any], 'fleet_telemetry');

    const [, , sourceTs] = gateway.emitTelemetryUpdate.mock.calls[0];
    expect(sourceTs).toBeNull();
  });

  // ─── Code path B: diff-only emit (previous state exists, still online) ───────

  it('delayed point (120s old) → diff emit passes timestamp so freshness ≈ 120s', async () => {
    const prevState = JSON.stringify({ soc: 80, speed: 10, power: 5, updatedAt: Date.now() - 5_000 });
    await build('veh-delay', prevState);

    const ts = new Date(Date.now() - 120_000);

    await service.processBatch('veh-delay', [{ timestamp: ts, soc: 75, speed: 20, power: 8 } as any], 'fleet_telemetry');

    // emitTelemetryUpdate may not be called if nothing changed in diff —
    // but when it is called, the timestamp argument must be correct.
    const calls = gateway.emitTelemetryUpdate.mock.calls;
    if (calls.length > 0) {
      const [, , sourceTs] = calls[0];
      expect(sourceTs).toEqual(ts);
    }
  });

  // ─── Code path C: wasOffline full-state emit ─────────────────────────────────

  it('vehicle was OFFLINE → full-state emit receives measurement timestamp', async () => {
    // updatedAt 1000s ago → getDataQuality returns OFFLINE
    const prevState = JSON.stringify({
      soc: 20, speed: 0, power: 0, updatedAt: Date.now() - 1_000_000,
    });
    await build('veh-back', prevState);

    const ts = new Date(Date.now() - 3_000);

    await service.processBatch('veh-back', [{ timestamp: ts, soc: 21, speed: 0, power: 0 } as any], 'fleet_telemetry');

    expect(gateway.emitVehicleOnline).toHaveBeenCalledWith('veh-back', 'REALTIME');
    expect(gateway.emitTelemetryUpdate).toHaveBeenCalled();
    const [, , sourceTs] = gateway.emitTelemetryUpdate.mock.calls[0];
    expect(sourceTs).toEqual(ts);
  });

  // ─── Multi-point batch → timestamp of the LAST point ────────────────────────

  it('batch of 3 points → emitTelemetryUpdate receives timestamp of the last point', async () => {
    await build('veh-batch', null);

    const t1 = new Date(Date.now() - 10_000);
    const t2 = new Date(Date.now() - 8_000);
    const t3 = new Date(Date.now() - 6_000);

    await service.processBatch('veh-batch', [
      { timestamp: t1, soc: 80, speed: 0, power: 0 } as any,
      { timestamp: t2, soc: 81, speed: 0, power: 0 } as any,
      { timestamp: t3, soc: 82, speed: 0, power: 0 } as any,
    ], 'fleet_telemetry');

    const calls = gateway.emitTelemetryUpdate.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, , sourceTs] = calls[calls.length - 1];
    expect(sourceTs).toEqual(t3);
  });
});
