import { Test, TestingModule } from '@nestjs/testing';
import { TelemetryPipelineService } from '../src/telemetry/telemetry-pipeline.service';
import { TelemetryService } from '../src/telemetry/telemetry.service';
import { TripDetectorService } from '../src/trips/trip-detector.service';
import { ChargingDetectorService } from '../src/charging/charging-detector.service';
import { TelemetrySanitizerService } from '../src/telemetry/telemetry-sanitizer.service';
import { TelemetryEventEngine } from '../src/telemetry/telemetry-event-engine.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/infra/redis.provider';
import {
  VehicleStateMachineService,
  VehicleState,
} from '../src/tesla-fleet/vehicle-state-machine.service';

describe('TelemetryPipelineService', () => {
  let service: TelemetryPipelineService;
  let telemetryService: { createManyTelemetryPoints: jest.Mock };
  let tripDetector: { checkTripState: jest.Mock };
  let chargingDetector: { checkChargingState: jest.Mock };
  let stateMachine: { getVehicleState: jest.Mock; updateFromTelemetry: jest.Mock };

  beforeEach(async () => {
    telemetryService = {
      createManyTelemetryPoints: jest.fn().mockResolvedValue({ count: 0 }),
    };

    tripDetector = {
      checkTripState: jest.fn().mockResolvedValue(undefined),
    };

    chargingDetector = {
      checkChargingState: jest.fn().mockResolvedValue(undefined),
    };

    stateMachine = {
      getVehicleState: jest.fn().mockResolvedValue({ state: VehicleState.DRIVING }),
      updateFromTelemetry: jest.fn().mockResolvedValue({
        justWoke: false,
        newState: VehicleState.DRIVING,
      }),
    };

    const redisMock = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelemetryPipelineService,
        { provide: REDIS_CLIENT, useValue: redisMock },
        {
          provide: PrismaService,
          useValue: {
            telemetryRaw: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
          },
        },
        { provide: TelemetryService, useValue: telemetryService },
        { provide: TripDetectorService, useValue: tripDetector },
        { provide: ChargingDetectorService, useValue: chargingDetector },
        { provide: TelemetrySanitizerService, useValue: { sanitize: (_: string, pts: any[]) => pts } },
        { provide: VehicleStateMachineService, useValue: stateMachine },
        {
          provide: TelemetryEventEngine,
          useValue: { process: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<TelemetryPipelineService>(TelemetryPipelineService);
  });

  it('должен пропускать первую точку и отбросить идентичную слишком раннюю', async () => {
    const vehicleId = 'veh-1';
    const baseTs = new Date('2026-03-12T10:00:00.000Z');

    await service.processBatch(vehicleId, [
      {
        timestamp: baseTs,
        soc: 50,
        speed: 30,
        power: 10,
        batteryRangeKm: 200,
      } as any,
      {
        timestamp: new Date(baseTs.getTime() + 1_000), // +1s < deltaMs (5s для DRIVING)
        soc: 50,
        speed: 30,
        power: 10,
        batteryRangeKm: 200,
      } as any,
    ]);

    expect(telemetryService.createManyTelemetryPoints).toHaveBeenCalledTimes(1);
    const [, aggregated] =
      telemetryService.createManyTelemetryPoints.mock.calls[0];

    // Должна сохраниться только первая точка
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].timestamp).toEqual(baseTs);
  });

  it('должен сохранять вторую точку при заметном изменении значений', async () => {
    const vehicleId = 'veh-2';
    const baseTs = new Date('2026-03-12T10:00:00.000Z');

    await service.processBatch(vehicleId, [
      {
        timestamp: baseTs,
        soc: 50,
        speed: 30,
        power: 10,
        batteryRangeKm: 200,
        latitude: 10,
        longitude: 10,
      } as any,
      {
        timestamp: new Date(baseTs.getTime() + 2_000), // 2s < deltaMs, но значения изменились
        soc: 49,
        speed: 40,
        power: 15,
        batteryRangeKm: 195,
        latitude: 10.0005,
        longitude: 10.0005,
      } as any,
    ]);

    expect(telemetryService.createManyTelemetryPoints).toHaveBeenCalledTimes(1);
    const [, aggregated] =
      telemetryService.createManyTelemetryPoints.mock.calls[0];

    // Обе точки должны пройти
    expect(aggregated).toHaveLength(2);
  });

  it('должен увеличивать окно deltaMs для PARKED', async () => {
    stateMachine.getVehicleState.mockResolvedValueOnce({
      state: VehicleState.PARKED,
    });

    const vehicleId = 'veh-3';
    const baseTs = new Date('2026-03-12T10:00:00.000Z');

    await service.processBatch(vehicleId, [
      {
        timestamp: baseTs,
        soc: 80,
        speed: 0,
        power: 0,
        batteryRangeKm: 300,
        latitude: 10,
        longitude: 10,
      } as any,
      {
        timestamp: new Date(baseTs.getTime() + 30_000), // 30s < 60s для PARKED
        soc: 80,
        speed: 0,
        power: 0,
        batteryRangeKm: 300,
        latitude: 10.00001,
        longitude: 10.00001,
      } as any,
    ]);

    const [, aggregated] =
      telemetryService.createManyTelemetryPoints.mock.calls[0];

    // В PARKED вторая точка должна быть отброшена как "почти та же" слишком рано
    expect(aggregated).toHaveLength(1);
  });

  it('должен вызывать детекторы поездок и зарядки на каждую сырую точку', async () => {
    const vehicleId = 'veh-4';

    await service.processBatch(vehicleId, [
      { timestamp: new Date(), soc: 10 } as any,
      { timestamp: new Date(), soc: 20 } as any,
      { timestamp: new Date(), soc: 30 } as any,
    ]);

    expect(tripDetector.checkTripState).toHaveBeenCalledTimes(3);
    expect(chargingDetector.checkChargingState).toHaveBeenCalledTimes(3);
  });

  it('должен включать state-поля в payloadHash для dedup', () => {
    const basePoint: any = {
      timestamp: new Date('2026-03-20T10:00:00.000Z'),
      soc: 55.1,
      speed: 12.3,
      power: 5.5,
      latitude: 50.45,
      longitude: 30.52,
    };

    const h1 = (service as any).payloadHash('veh-5', {
      ...basePoint,
      charging_state: 'Disconnected',
      shift_state: 'D',
      charge_energy_added: 0,
    });
    const h2 = (service as any).payloadHash('veh-5', {
      ...basePoint,
      charging_state: 'Charging',
      shift_state: 'P',
      charge_energy_added: 1.25,
    });

    expect(h1).not.toEqual(h2);
  });
});

