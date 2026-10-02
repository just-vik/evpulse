import { TelemetryReplayController } from '../src/telemetry/telemetry-replay.controller';

/**
 * Regression test for the debug replay endpoint's payloadKind dispatch (telemetry
 * audit, Oct 2026, commit 2/4: "persist raw fleet telemetry events"). This is the
 * second telemetry_raw consumer (besides TelemetryPipelineService's internal replay)
 * — it used to blindly cast `row.payload as CreateTelemetryPointDto`, which for a new
 * tesla_fleet_telemetry_v1 row (the real Tesla event) would hand the pipeline an
 * object with no `speed`/`soc`/`timestamp` fields at all.
 */
describe('TelemetryReplayController — payloadKind dispatch', () => {
  const VEHICLE_ID = 'veh-replay-1';

  const teslaEvent = {
    vin: '5YJSA1E26HF000000',
    createdAt: '2026-04-01T10:00:00.000Z',
    data: [
      { key: 'VehicleSpeed', value: { doubleValue: 56 } },
      { key: 'BatteryLevel', value: { doubleValue: 61 } },
    ],
  };
  const legacyPoint = { timestamp: '2026-04-01T10:00:05.000Z', speed: 40, soc: 60 };

  function buildController(rows: any[]) {
    const processBatch = jest.fn().mockResolvedValue(undefined);
    const vehiclesService = { findOne: jest.fn().mockResolvedValue({ id: VEHICLE_ID }) };
    const prisma = { telemetryRaw: { findMany: jest.fn().mockResolvedValue(rows) } };
    const pipeline = { processBatch };
    const controller = new TelemetryReplayController(vehiclesService as any, prisma as any, pipeline as any);
    return { controller, processBatch };
  }

  it('нормализует tesla_fleet_telemetry_v1 raw event перед processBatch, не кастует его напрямую в DTO', async () => {
    const { controller, processBatch } = buildController([
      { id: 'raw-1', payload: teslaEvent, payloadKind: 'tesla_fleet_telemetry_v1' },
    ]);

    const result = await controller.replay(
      VEHICLE_ID,
      { from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T23:00:00.000Z' },
      { user: { id: 'user-1' } },
    );

    expect(processBatch).toHaveBeenCalledTimes(1);
    const [vehicleId, batch, source] = processBatch.mock.calls[0];
    expect(vehicleId).toBe(VEHICLE_ID);
    expect(source).toBe('replay');
    expect(batch).toHaveLength(1);
    expect(batch[0].speed).toBe(56);
    expect(batch[0].soc).toBe(61);
    expect(batch[0].timestamp).toEqual(new Date('2026-04-01T10:00:00.000Z'));
    expect(result.processed).toBe(1);
  });

  it('продолжает работать для legacy normalized_v1 строк', async () => {
    const { controller, processBatch } = buildController([
      { id: 'raw-2', payload: legacyPoint, payloadKind: 'normalized_v1' },
    ]);

    await controller.replay(
      VEHICLE_ID,
      { from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T23:00:00.000Z' },
      { user: { id: 'user-1' } },
    );

    const [, batch] = processBatch.mock.calls[0];
    expect(batch[0].speed).toBe(40);
    expect(batch[0].soc).toBe(60);
  });

  it('отбрасывает нераспознаваемые payload вместо падения, не вызывает processBatch для пустого batch', async () => {
    const { controller, processBatch } = buildController([
      { id: 'raw-3', payload: { garbage: true }, payloadKind: 'normalized_v1' }, // no timestamp → rawPayloadToPoint returns null
    ]);

    const result = await controller.replay(
      VEHICLE_ID,
      { from: '2026-04-01T00:00:00.000Z', to: '2026-04-01T23:00:00.000Z' },
      { user: { id: 'user-1' } },
    );

    expect(processBatch).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });
});
