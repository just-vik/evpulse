import { TelemetryGateway } from '../src/websockets/telemetry.gateway';

describe('TelemetryGateway tenant boundaries', () => {
  it('должен отклонять subscribe на чужой vehicleId', async () => {
    const vehiclesService = {
      assertOwnership: jest.fn().mockRejectedValue(new Error('forbidden')),
    };

    const gateway = new TelemetryGateway(
      {} as any,
      {} as any,
      vehiclesService as any,
    );

    const client = {
      id: 'socket-1',
      data: { userId: 'user-1' },
      emit: jest.fn(),
      join: jest.fn(),
    } as any;

    const result = await gateway.handleSubscribeVehicle({ vehicleId: 'veh-foreign' }, client);

    expect(vehiclesService.assertOwnership).toHaveBeenCalledWith('veh-foreign', 'user-1');
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Access denied' });
    expect(result).toEqual({ event: 'error', message: 'Access denied' });
  });
});

// P1.2 telemetry freshness fix — emitTelemetryUpdate now computes
// lastUpdate/dataQuality/dataFreshnessSec from an optional sourceTimestamp
// (defaults to "now", matching every real call site, which all emit
// synchronously with newly-received data).
describe('TelemetryGateway.emitTelemetryUpdate freshness', () => {
  function makeGatewayWithMockServer() {
    const gateway = new TelemetryGateway({} as any, {} as any, {} as any);
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    (gateway as any).server = { to };
    return { gateway, to, emit };
  }

  function lastPayload(emit: jest.Mock) {
    return emit.mock.calls[emit.mock.calls.length - 1][1];
  }

  it('fresh event (no sourceTimestamp, i.e. "now") → REALTIME', () => {
    const { gateway, to, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', { soc: 80 });

    expect(to).toHaveBeenCalledWith('vehicle:veh-1');
    const payload = lastPayload(emit);
    expect(payload.dataQuality).toBe('REALTIME');
    expect(payload.dataFreshnessSec).toBe(0);
    expect(typeof payload.lastUpdate).toBe('string');
  });

  it('delayed event (60s old source data) → DELAYED', () => {
    const { gateway, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', {}, new Date(Date.now() - 60_000));

    const payload = lastPayload(emit);
    expect(payload.dataQuality).toBe('DELAYED');
    expect(payload.dataFreshnessSec).toBeGreaterThanOrEqual(59);
    expect(payload.dataFreshnessSec).toBeLessThan(65);
  });

  it('stale event (300s old source data) → STALE', () => {
    const { gateway, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', {}, new Date(Date.now() - 300_000));

    expect(lastPayload(emit).dataQuality).toBe('STALE');
  });

  // P1.2.1: 700s is a normal parked-vehicle telemetry gap (observed range in
  // production: 50s–6m20s) — this must land in STALE, not OFFLINE.
  it('stale event (700s old source data, a normal parked-vehicle gap) → STALE', () => {
    const { gateway, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', {}, new Date(Date.now() - 700_000));

    expect(lastPayload(emit).dataQuality).toBe('STALE');
  });

  it('offline event (900s old source data) → OFFLINE', () => {
    const { gateway, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', {}, new Date(Date.now() - 900_000));

    expect(lastPayload(emit).dataQuality).toBe('OFFLINE');
  });

  it('no source timestamp available (null) → OFFLINE, lastUpdate/dataFreshnessSec both null', () => {
    const { gateway, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', {}, null);

    const payload = lastPayload(emit);
    expect(payload.lastUpdate).toBeNull();
    expect(payload.dataFreshnessSec).toBeNull();
    expect(payload.dataQuality).toBe('OFFLINE');
  });

  it('payload carries only the expected top-level keys — no secret/VIN/token leakage', () => {
    const { gateway, emit } = makeGatewayWithMockServer();

    gateway.emitTelemetryUpdate('veh-1', { soc: 80 });

    const payload = lastPayload(emit);
    expect(Object.keys(payload).sort()).toEqual(
      ['data', 'dataFreshnessSec', 'dataQuality', 'lastUpdate', 'timestamp', 'type', 'vehicleId'].sort(),
    );
  });

  it('does not emit at all when server is not yet initialised (no crash, no partial payload)', () => {
    const gateway = new TelemetryGateway({} as any, {} as any, {} as any);
    expect(() => gateway.emitTelemetryUpdate('veh-1', { soc: 80 })).not.toThrow();
  });
});
