import { ChargingDetectorService } from '../src/charging/charging-detector.service';

/**
 * Regression tests for the SOC-delta energy fallback in ChargingDetectorService.endSession().
 *
 * The fallback was added to handle EU cars that lack ChargeEnergyAdded in Fleet Telemetry,
 * causing the power integral to produce 0 kWh when all REST poll gaps exceed the 15-min cap.
 *
 * Two activation paths (guarded separately to avoid BMS-recalibration false positives):
 *   - energyKwh > 0: use SOC estimate only when it is ≥30% higher than the integral
 *   - energyKwh = 0: accept SOC estimate only when session lasted ≥5 min
 *
 * The zero-integral path was a latent bug before eb7f807: any positive SOC change
 * satisfied `socDeltaKwh > 0 * 1.3 = 0`, including brief BMS recalibration events.
 */
describe('ChargingDetectorService.endSession — SOC-delta energy fallback', () => {
  const VEHICLE_ID = 'veh-soc-test';
  const CAP_KWH = 72;

  function makeSession(startSoc: number, sessionAgeMs: number) {
    return {
      id: 'sess-1',
      vehicleId: VEHICLE_ID,
      startSoc,
      startTime: new Date(Date.now() - sessionAgeMs),
      chargerType: 'ac_home',
      endTime: null,
    };
  }

  function buildService(session: any, capturedUpdates: any[], capturedDeletes: string[]) {
    const prisma = {
      chargingSession: {
        findFirst: jest.fn().mockResolvedValue(session),
        update: jest.fn().mockImplementation(({ data }: any) => {
          capturedUpdates.push(data);
          return Promise.resolve({ ...session, ...data });
        }),
        delete: jest.fn().mockImplementation(({ where }: any) => {
          capturedDeletes.push(where.id);
          return Promise.resolve({});
        }),
      },
      chargingPoint: {
        // No points → maxPower = null, but doesn't affect energy fallback logic
        findMany: jest.fn().mockResolvedValue([]),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({
          batteryCapacityDetected: CAP_KWH,
          batteryCapacityUsable:   CAP_KWH,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    return new ChargingDetectorService(prisma as any);
  }

  // ─── Path A: energyKwh === 0 ─────────────────────────────────────────────

  it('energyKwh=0, session < 5 min: SOC fallback does NOT fire (ghost guard deletes)', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    // SOC +20% would be 72 × 0.20 × 1.07 ≈ 15.4 kWh — but session is only 3 min
    const session = makeSession(40, 3 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: 60 }, 0, new Date());

    // SOC fallback not applied → energyKwh stays 0 → ghost Rule A (< 50 Wh) fires
    expect(deletes).toContain('sess-1');
    expect(updates).toHaveLength(0);
  });

  it('energyKwh=0, session exactly 5 min: SOC fallback FIRES (border ≥ 5 min)', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    const session = makeSession(40, 5 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: 60 }, 0, new Date());

    // 5 min exactly crosses the >= threshold
    expect(deletes).toHaveLength(0);
    expect(updates[0].energyAddedKwh).toBeCloseTo(72 * 0.20 * 1.07, 1); // ≈ 15.4
  });

  it('energyKwh=0, session 30 min, SOC +20%: SOC fallback applies, result ≈ 15.4 kWh', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    const session = makeSession(40, 30 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: 60 }, 0, new Date());

    expect(deletes).toHaveLength(0);
    expect(updates[0].energyAddedKwh).toBeCloseTo(72 * 0.20 * 1.07, 1);
  });

  it('energyKwh=0, SOC gain < 1% (BMS noise): SOC fallback not applicable, ghost deleted', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    // startSoc=60, endSoc=60.5 → gain = 0.5% < 1 threshold
    const session = makeSession(60, 20 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: 60 }, 0, new Date());

    // socGain < 1 → socDeltaKwh = null → useSocFallback = false → energyKwh = 0 → ghost deleted
    expect(deletes).toContain('sess-1');
  });

  // ─── Path B: energyKwh > 0 ────────────────────────────────────────────────

  it('energyKwh=5, SOC estimate=6 kWh (×1.2 < 1.3 threshold): integral kept', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    // 6 kWh = (SOC delta / 100) × 72 × 1.07 → SOC delta ≈ 7.8%
    // startSoc=42, endSoc=49.8 ≈ 50
    const socEstimate = 6.0;
    const startSoc = 42;
    const endSoc = Math.round(startSoc + (socEstimate / (CAP_KWH * 1.07)) * 100);
    const session = makeSession(startSoc, 40 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: endSoc }, 5.0, new Date());

    // socDeltaKwh ≈ 6.0, energyKwh=5: 6.0 / 5.0 = 1.2 < 1.3 → integral kept
    expect(updates[0].energyAddedKwh).toBeCloseTo(5.0, 1);
  });

  it('energyKwh=5, SOC estimate=7 kWh (×1.4 > 1.3 threshold): SOC estimate used', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    // 7 kWh = (SOC delta / 100) × 72 × 1.07 → SOC delta ≈ 9.1%
    const startSoc = 40;
    const endSoc = Math.round(startSoc + (7.0 / (CAP_KWH * 1.07)) * 100);
    const session = makeSession(startSoc, 40 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: endSoc }, 5.0, new Date());

    // socDeltaKwh ≈ 7.0, energyKwh=5: 7.0 / 5.0 = 1.4 > 1.3 → SOC estimate wins
    expect(updates[0].energyAddedKwh).toBeGreaterThan(5.0);
    expect(updates[0].energyAddedKwh).toBeCloseTo(7.0, 0);
  });

  it('energyKwh>0, SOC estimate exactly 1.3× integral: integral kept (strict > required)', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    // socDeltaKwh = energyKwh * 1.3 exactly → NOT > 1.3× → integral kept
    const startSoc = 40;
    const exactEstimate = 5.0 * 1.3; // 6.5
    const endSoc = Math.round(startSoc + (exactEstimate / (CAP_KWH * 1.07)) * 100);
    const session = makeSession(startSoc, 40 * 60_000);
    const service = buildService(session, updates, deletes);

    await (service as any).endSession(VEHICLE_ID, { soc: endSoc }, 5.0, new Date());

    expect(updates[0].energyAddedKwh).toBeCloseTo(5.0, 1);
  });

  // ─── Ghost guard interaction ──────────────────────────────────────────────

  it('energyKwh=0, session 10 min, SOC unchanged: SOC fallback cannot apply (no gain), ghost deleted', async () => {
    const updates: any[] = [];
    const deletes: string[] = [];
    const session = makeSession(50, 10 * 60_000);
    const service = buildService(session, updates, deletes);

    // endSoc = startSoc (no change)
    await (service as any).endSession(VEHICLE_ID, { soc: 50 }, 0, new Date());

    expect(deletes).toContain('sess-1');
    expect(updates).toHaveLength(0);
  });
});
