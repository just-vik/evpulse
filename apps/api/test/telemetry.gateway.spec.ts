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
