import { TripBackfillService } from '../src/trips/trip-backfill.service';

/**
 * Regression test for backfillFromRawTelemetry()'s payloadKind dispatch (telemetry
 * audit, Oct 2026, commit 2/4: "persist raw fleet telemetry events"). This is the third
 * telemetry_raw consumer (besides TelemetryPipelineService's replay and
 * TelemetryReplayController) — trip rebuild replays telemetry_raw directly and used to
 * read `.speed`/`.power`/etc. straight off the row, assuming it was always an
 * already-normalized DTO. A tesla_fleet_telemetry_v1 row (the real Tesla event: { vin,
 * createdAt, data: [...] }) has none of those top-level fields, so without dispatching
 * through normalizeRawTelemetryPayload() first, trip rebuild would silently feed the
 * detector all-undefined points for every new-format row.
 */
describe('TripBackfillService.backfillFromRawTelemetry — payloadKind dispatch', () => {
  const VEHICLE_ID = 'veh-raw-backfill';

  const teslaEvent = {
    vin: '5YJSA1E26HF000000',
    createdAt: '2026-04-01T10:00:00.000Z',
    data: [
      { key: 'VehicleSpeed', value: { doubleValue: 56 } },
      { key: 'BatteryLevel', value: { doubleValue: 61 } },
    ],
  };
  const legacyPoint = {
    timestamp: '2026-04-01T10:00:05.000Z',
    speed: 40,
    power: 6,
    soc: 60,
  };

  function buildService(rows: any[]) {
    const checkTripState = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      telemetryRaw: {
        findMany: jest.fn()
          .mockResolvedValueOnce(rows)
          .mockResolvedValueOnce([]), // second page empty → loop exits
      },
      trip: {
        findMany: jest.fn().mockResolvedValue([]), // filterAnomalousTrips: nothing to filter
      },
    };
    const tripDetector = { checkTripState };
    const service = new TripBackfillService(
      prisma as any,
      tripDetector as any,
      {} as any, // geocoding — unused by this path
      {} as any, // tripReconciler — unused by this path
      {} as any, // lock — unused by this path
      {} as any, // config — unused by this path
    );
    return { service, checkTripState };
  }

  it('нормализует tesla_fleet_telemetry_v1 raw event перед передачей в trip detector', async () => {
    const { service, checkTripState } = buildService([
      {
        id: 'raw-1',
        receivedAt: new Date('2026-04-01T10:00:00.500Z'),
        payload: teslaEvent,
        payloadKind: 'tesla_fleet_telemetry_v1',
      },
    ]);

    await service.backfillFromRawTelemetry(
      VEHICLE_ID,
      new Date('2026-04-01T00:00:00.000Z'),
      new Date('2026-04-02T00:00:00.000Z'),
    );

    expect(checkTripState).toHaveBeenCalledTimes(1);
    const [vehicleId, point] = checkTripState.mock.calls[0];
    expect(vehicleId).toBe(VEHICLE_ID);
    // Must be the normalized values (speed in km/h, soc from BatteryLevel) — not
    // undefined, which is what reading .speed/.soc off the raw Tesla event directly
    // would have produced.
    expect(point.speed).toBe(56);
    expect(point.soc).toBe(61);
    expect(point.timestamp).toBe('2026-04-01T10:00:00.000Z');
  });

  it('продолжает работать как раньше для legacy normalized_v1 (и для payloadKind=null) строк', async () => {
    const { service, checkTripState } = buildService([
      { id: 'raw-2', receivedAt: new Date('2026-04-01T10:00:05.000Z'), payload: legacyPoint, payloadKind: 'normalized_v1' },
      { id: 'raw-3', receivedAt: new Date('2026-04-01T10:00:06.000Z'), payload: { ...legacyPoint, timestamp: '2026-04-01T10:00:06.000Z' }, payloadKind: null },
    ]);

    await service.backfillFromRawTelemetry(
      VEHICLE_ID,
      new Date('2026-04-01T00:00:00.000Z'),
      new Date('2026-04-02T00:00:00.000Z'),
    );

    expect(checkTripState).toHaveBeenCalledTimes(2);
    expect(checkTripState.mock.calls[0][1].speed).toBe(40);
    expect(checkTripState.mock.calls[0][1].soc).toBe(60);
    expect(checkTripState.mock.calls[1][1].speed).toBe(40);
  });
});
