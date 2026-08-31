import { ChargingSyncService } from '../src/tesla-fleet/charging-sync.service';
import { TripCleanupService } from '../src/trips/trip-cleanup.service';

function makeChargingPrisma(overrides: Partial<any> = {}) {
  const row = {
    id: 'sess-1',
    startTime: new Date('2026-03-27T10:00:00Z'),
    endTime: new Date('2026-03-27T10:40:00Z'),
    energyAddedKwh: 20,
    costSource: null,
    billingSyncAttempts: 0,
    billingNextSyncAt: null,
    vehicle: { id: 'veh-1', vin: 'VIN123', userId: 'user-1' },
    ...overrides,
  };

  const updates: any[] = [];
  const prisma = {
    chargingSession: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }: any) => {
        updates.push(data);
        return Promise.resolve({ ...row, ...data });
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    _updates: updates,
  };
  return prisma as any;
}

describe('Golden scenarios: 403 / sleep / split / charging', () => {
  it('403: marks pending sessions as scope_missing', async () => {
    const prisma = makeChargingPrisma();
    const teslaFleet = {
      getChargingHistory: jest.fn().mockRejectedValue(new Error('BILLING_SCOPE_MISSING')),
    };
    const teslaOAuth = {
      getValidAccessToken: jest.fn().mockResolvedValue('token'),
    };
    const svc = new ChargingSyncService(prisma, teslaFleet as any, teslaOAuth as any);

    await (svc as any).syncOneSession('sess-1');

    expect(prisma.chargingSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { costSource: 'scope_missing' },
      }),
    );
  });

  it('sleep: no token schedules retry with incremented attempts', async () => {
    const prisma = makeChargingPrisma({ billingSyncAttempts: 2 });
    const teslaFleet = { getChargingHistory: jest.fn() };
    const teslaOAuth = {
      getValidAccessToken: jest.fn().mockRejectedValue(new Error('vehicle_sleeping')),
    };
    const svc = new ChargingSyncService(prisma, teslaFleet as any, teslaOAuth as any);

    await (svc as any).syncOneSession('sess-1');

    expect(prisma.chargingSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-1' },
        data: expect.objectContaining({
          billingSyncAttempts: 3,
        }),
      }),
    );
  });

  it('charging: finalized Tesla billing writes tesla_api and resets retry state', async () => {
    const prisma = makeChargingPrisma();
    const teslaFleet = {
      getChargingHistory: jest.fn().mockResolvedValue([
        {
          chargeStartDateTime: '2026-03-27T10:00:30Z',
          chargeStopDateTime: '2026-03-27T10:39:00Z',
          totalDue: 8,
          chargerType: 'SUPERCHARGER',
          siteLocationName: 'SC Berlin',
          fees: [
            {
              feeType: 'CHARGING',
              uom: 'kwh',
              usageBase: 20,
              currencyCode: 'EUR',
            },
          ],
        },
      ]),
    };
    const teslaOAuth = {
      getValidAccessToken: jest.fn().mockResolvedValue('token'),
    };
    const svc = new ChargingSyncService(prisma, teslaFleet as any, teslaOAuth as any);

    await (svc as any).syncOneSession('sess-1');

    const lastUpdate = prisma._updates[prisma._updates.length - 1];
    expect(lastUpdate.costSource).toBe('tesla_api');
    expect(lastUpdate.billingSyncAttempts).toBe(0);
    expect(lastUpdate.billingNextSyncAt).toBeNull();
  });

  it('split: TripCleanupService.runMerge delegates to TripReconcilerService', async () => {
    const reconciler = { runManual: jest.fn().mockResolvedValue({ merged: 1 }) };
    const prisma = {} as any;
    const svc = new TripCleanupService(prisma, {} as any, reconciler as any);
    const { merged } = await svc.runMerge('veh-1');
    expect(merged).toBe(1);
    // Deliberately narrow (2 days, not a wider historical scan) — the hourly auto-merge
    // only needs to heal recent splits. See the JSDoc on TripCleanupService.runMerge for
    // why this is intentional, not a stale default.
    expect(reconciler.runManual).toHaveBeenCalledWith('veh-1', 2);
  });
});
