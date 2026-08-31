import { FleetTelemetryWorker } from '../src/tesla-fleet/fleet-telemetry.worker';

describe('FleetTelemetryWorker DLQ escalation', () => {
  it('эскалирует сообщение в DLQ после max retry и делает ACK', async () => {
    const redis = {
      incr: jest.fn().mockResolvedValue(3),
      expire: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      xack: jest.fn().mockResolvedValue(1),
    };
    const worker = new FleetTelemetryWorker(
      redis as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
    );

    await (worker as any).handleBatchFailure(
      'veh-1',
      ['1700000000000-0'],
      [{ timestamp: new Date('2026-03-20T10:00:00.000Z'), soc: 50 }],
      'autoclaim',
      new Error('boom'),
    );

    expect(redis.lpush).toHaveBeenCalledWith(
      'dlq:jobs:telemetry',
      expect.stringContaining('"jobName":"fleet-worker:autoclaim"'),
    );
    expect(redis.xack).toHaveBeenCalledWith(
      'fleet:telemetry',
      'fleet-workers',
      '1700000000000-0',
    );
  });

  it('не эскалирует в DLQ до достижения лимита retry', async () => {
    const redis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      xack: jest.fn().mockResolvedValue(1),
    };
    const worker = new FleetTelemetryWorker(
      redis as any,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
    );

    await (worker as any).handleBatchFailure(
      'veh-1',
      ['1700000000000-1'],
      [{ timestamp: new Date('2026-03-20T10:00:01.000Z'), soc: 49 }],
      'stream',
      new Error('boom'),
    );

    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it('resolves VIN case-insensitively and caches normalized ids', async () => {
    const redis = {} as any;
    const prisma = {
      vehicle: { findFirst: jest.fn().mockResolvedValue({ id: 'vehicle-123' }) },
      teslaVehicleLink: { findUnique: jest.fn() },
    } as any;
    const worker = new FleetTelemetryWorker(
      redis,
      prisma,
      {} as any,
      { get: jest.fn().mockReturnValue('localhost') } as any,
    );

    const first = await (worker as any).resolveVehicleId('5YJSA1E26HF000000');
    const second = await (worker as any).resolveVehicleId('5yjsa1e26hf000000');

    expect(first).toBe('vehicle-123');
    expect(second).toBe('vehicle-123');
    expect(prisma.vehicle.findFirst).toHaveBeenCalledTimes(1);
  });

  it('resolves numeric Tesla id via teslaVehicleLink', async () => {
    const redis = {} as any;
    const prisma = {
      vehicle: { findFirst: jest.fn() },
      teslaVehicleLink: { findUnique: jest.fn().mockResolvedValue({ vehicleId: 'vehicle-456' }) },
    } as any;
    const worker = new FleetTelemetryWorker(
      redis,
      prisma,
      {} as any,
      { get: jest.fn().mockReturnValue('localhost') } as any,
    );

    const result = await (worker as any).resolveVehicleId('1234567890');

    expect(result).toBe('vehicle-456');
    expect(prisma.teslaVehicleLink.findUnique).toHaveBeenCalledWith({ where: { teslaVehicleId: '1234567890' } });
  });
});
