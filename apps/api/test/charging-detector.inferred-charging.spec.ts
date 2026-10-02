import { ChargingDetectorService } from '../src/charging/charging-detector.service';

/**
 * Regression tests for ChargingDetectorService after the Oct 2026 power-polarity fix
 * (commit "normalize charging power polarity"). normalizeTeslaPayload() now makes
 * charging power positive everywhere (matching DCChargingPower/ACChargingPower),
 * including the PackVoltage×PackCurrent fallback, which used to produce a negative
 * value for the same event. That removed the one thing `inferredCharging` used to
 * rely on to tell real fallback-sourced charging apart from battery preconditioning
 * (which also draws positive power from the battery while parked) — both are
 * positive now. `inferredCharging` was switched from a power-sign check to a
 * charging-current check (preconditioning isn't plugged in, so it has none).
 *
 * ChargingDetectorService had zero existing tests before this commit.
 */
describe('ChargingDetectorService.checkChargingState — inferredCharging after power-polarity fix', () => {
  function buildService() {
    const sessions: any[] = [];
    const prisma = {
      chargingSession: {
        findFirst: jest.fn().mockResolvedValue(null), // no pre-existing open session
        create: jest.fn().mockImplementation(({ data }: any) => {
          const row = { id: `sess-${sessions.length + 1}`, endTime: null, ...data };
          sessions.push(row);
          return Promise.resolve(row);
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new ChargingDetectorService(prisma as any);
    return { service, sessions };
  }

  it('preconditioning (positive power, parked, no charging current, no ChargingState) does NOT start a session', async () => {
    const { service, sessions } = buildService();
    await service.checkChargingState('veh-1', {
      power: 25,            // positive, canonical now — same magnitude preconditioning always had
      current: 0,           // not plugged in: no charger current at all
      charging_state: undefined,
      speed: 0,
      timestamp: '2026-06-01T10:00:00.000Z',
    });
    expect(sessions).toHaveLength(0);
  });

  it('real charging via fallback (ChargingState missing from this batch, but real charging current present) DOES start a session', async () => {
    const { service, sessions } = buildService();
    await service.checkChargingState('veh-2', {
      power: 25,            // same positive magnitude as the preconditioning case above
      current: 32,          // real charger current (e.g. a 32A home charger)
      charging_state: undefined,
      speed: 0,
      timestamp: '2026-06-01T10:00:00.000Z',
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startSoc).toBeDefined();
  });

  it('normal path (explicit ChargingState=Charging, DCChargingPower-sourced power) still starts a session', async () => {
    const { service, sessions } = buildService();
    await service.checkChargingState('veh-3', {
      power: 7.4,           // AC home charger, explicit ACChargingPower — unaffected by this fix
      current: 32,
      charging_state: 'Charging',
      soc: 61,
      speed: 0,
      timestamp: '2026-06-01T10:00:00.000Z',
    });
    expect(sessions).toHaveLength(1);
  });

  it('low positive power while parked and unplugged (e.g. sentry mode / vampire drain) does not start a session', async () => {
    const { service, sessions } = buildService();
    await service.checkChargingState('veh-4', {
      power: 0.3,
      current: 0,
      charging_state: undefined,
      speed: 0,
      timestamp: '2026-06-01T10:00:00.000Z',
    });
    expect(sessions).toHaveLength(0);
  });
});
