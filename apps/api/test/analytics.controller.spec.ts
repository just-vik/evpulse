import { AnalyticsController } from '../src/analytics/analytics.controller';

describe('AnalyticsController tenant boundaries', () => {
  it('должен запрашивать dataset только для vehicleId владельца', async () => {
    const vehiclesService = {
      findOne: jest.fn().mockResolvedValue({ id: 'veh-1' }),
    };
    const efficiencyDataset = {
      buildDataset: jest.fn().mockResolvedValue([{ tripId: 't1' }]),
    };

    const controller = new AnalyticsController(
      {} as any,
      vehiclesService as any,
      efficiencyDataset as any,
      {} as any,
      {} as any,
    );

    const req = { user: { id: 'user-1' } };
    const result = await controller.getEfficiencyDataset('veh-1', req as any, 50);

    expect(vehiclesService.findOne).toHaveBeenCalledWith('veh-1', 'user-1');
    expect(efficiencyDataset.buildDataset).toHaveBeenCalledWith('veh-1', 50);
    expect(result).toEqual([{ tripId: 't1' }]);
  });
});
