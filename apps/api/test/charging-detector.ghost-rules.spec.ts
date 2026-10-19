/**
 * Regression tests for the ghost-session guard in ChargingDetectorService.endSession().
 *
 * The guard prevents three categories of false-positive sessions from being persisted:
 *
 *   Rule A — roundedEnergy < 0.05 kWh (< 50 Wh)
 *     Catches any sub-threshold residual regardless of SOC or duration.
 *     Triggered by: regen spikes, BMS flickers, stale buffer replay.
 *
 *   Rule B — durationMs < 2 min AND socDelta < 0.5% AND roundedEnergy < 0.1 kWh
 *     Very short session with no meaningful SOC gain.
 *     Triggered by: brief cable insertion, brief preconditioning bleed-through.
 *
 *   Rule C — socDelta < -1% AND roundedEnergy < 5 kWh AND durationMs < 30 min
 *     Short session where SOC dropped (car was not actually gaining charge) and
 *     only a tiny amount of energy was recorded.
 *     Triggered by: regen during a very brief stop, parking-lot noise.
 *
 *     Duration guard (30 min): late-detected real sessions (car arrived mid-charge)
 *     have a small chargeEnergyAdded delta because most energy was already delivered
 *     before EVPulse detected the session. The SOC drop then comes from subsequent
 *     driving recorded in the next REST poll. Without the duration guard, the Sep 29
 *     49.91 kWh Wiesbaden SC session was deleted: EVPulse detected charging at
 *     04:49 UTC (27 min after real start), and the closing poll at 06:50 UTC had
 *     SOC=73% (after driving away) vs start SOC=76% — socDelta=-3 AND energy=3.52 kWh.
 */

import { ChargingDetectorService } from '../src/charging/charging-detector.service';

const VEHICLE_ID = 'veh-ghost-test';
const CAP_KWH    = 77;

function makeSession(opts: {
  startSoc:     number;
  sessionAgeMs: number;
  chargerType?: string;
}) {
  return {
    id:          'sess-ghost',
    vehicleId:   VEHICLE_ID,
    startSoc:    opts.startSoc,
    startTime:   new Date(Date.now() - opts.sessionAgeMs),
    chargerType: opts.chargerType ?? 'tesla_sc',
    endTime:     null,
  };
}

function buildService(session: any, updates: any[], deletes: string[]) {
  const prisma = {
    chargingSession: {
      findFirst: jest.fn().mockResolvedValue(session),
      update:    jest.fn().mockImplementation(({ data }: any) => {
        updates.push(data);
        return Promise.resolve({ ...session, ...data });
      }),
      delete:    jest.fn().mockImplementation(({ where }: any) => {
        deletes.push(where.id);
        return Promise.resolve({});
      }),
    },
    chargingPoint: {
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

// ─── Rule A ──────────────────────────────────────────────────────────────────

describe('Ghost Rule A — sub-50 Wh energy', () => {

  it('energy < 0.05 kWh, SOC flat → deleted (SOC-fallback inactive, Rule A fires)', async () => {
    // SOC must stay flat so the SOC-delta fallback does not inflate energy above the
    // 0.05 kWh threshold before the ghost guard runs.
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 50, sessionAgeMs: 10 * 60_000 });
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 50 }, 0.04, new Date()); // SOC unchanged

    expect(deletes).toContain('sess-ghost');
    expect(updates).toHaveLength(0);
  });

  it('energy = 0.05 kWh (boundary), SOC flat → NOT a ghost', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 50, sessionAgeMs: 10 * 60_000 });
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 50 }, 0.05, new Date());

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

});

// ─── Rule B ──────────────────────────────────────────────────────────────────

describe('Ghost Rule B — very short session, no SOC gain', () => {

  it('< 2 min, SOC flat, energy < 0.1 kWh → deleted', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 60, sessionAgeMs: 90 * 1000 }); // 90s
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 60 }, 0.08, new Date());

    expect(deletes).toContain('sess-ghost');
    expect(updates).toHaveLength(0);
  });

  it('< 2 min but SOC rose by 1% → NOT a ghost (real brief AC connection)', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 60, sessionAgeMs: 90 * 1000 });
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 61 }, 0.08, new Date());

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it('> 2 min, SOC flat, energy < 0.1 kWh → NOT a ghost (duration exceeds Rule B window)', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 60, sessionAgeMs: 3 * 60_000 }); // 3 min
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 60 }, 0.08, new Date());

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

});

// ─── Rule C ──────────────────────────────────────────────────────────────────

describe('Ghost Rule C — SOC drop + small energy (with 30-min duration guard)', () => {

  it('SOC drop, energy < 5 kWh, short session → deleted (true regen ghost)', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 65, sessionAgeMs: 5 * 60_000 }); // 5 min
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 62 }, 1.5, new Date());  // SOC -3

    expect(deletes).toContain('sess-ghost');
    expect(updates).toHaveLength(0);
  });

  it('SOC drop exactly at boundary (durationMs = 30 min) → NOT deleted (≥ 30 min exempt)', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 76, sessionAgeMs: 30 * 60_000 }); // exactly 30 min
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 73 }, 3.52, new Date()); // Sep 29 exact values

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it('Sep 29 scenario: late-detected SC, 2h session, SOC drop from post-drive poll → NOT deleted', async () => {
    // Real scenario: Tesla charging started 04:22 UTC, EVPulse detected at 04:49 UTC.
    // chargeEnergyAdded delta = 3.52 kWh (only tail visible). Closing poll at 06:50 UTC
    // captured post-drive SOC=73% vs session-start SOC=76% (already-driving when polled).
    // Before fix: socDelta=-3 AND energy=3.52 < 5 → Rule C fired → 49.91 kWh session deleted.
    // After fix:  durationMs ≈ 121 min ≥ 30 min → Rule C exempt → session preserved.
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 76, sessionAgeMs: 121 * 60_000 }); // 2h 1min
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 73 }, 3.52, new Date());

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
    // Session preserved — energy underreported (3.52 vs real 49.91 kWh) but not deleted
    const saved = updates[0];
    expect(saved.energyAddedKwh).toBeGreaterThan(0);
  });

  it('SOC drop, energy 4.9 kWh, 29 min session → deleted (< 30 min, Rule C fires)', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 50, sessionAgeMs: 29 * 60_000 });
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 47 }, 4.9, new Date());

    expect(deletes).toContain('sess-ghost');
    expect(updates).toHaveLength(0);
  });

  it('SOC drop, energy ≥ 5 kWh → NOT deleted regardless of duration (Rule C energy threshold)', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 70, sessionAgeMs: 3 * 60_000 }); // short session
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 67 }, 5.0, new Date()); // exactly 5 kWh

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it('SOC rose → Rule C never applies even with small energy', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 60, sessionAgeMs: 5 * 60_000 });
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 62 }, 1.5, new Date()); // SOC +2

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

});

// ─── Normal sessions (all rules pass) ────────────────────────────────────────

describe('Normal session — all ghost rules pass', () => {

  it('SOC +10%, 40 kWh, 60 min → saved', async () => {
    const updates: any[] = []; const deletes: string[] = [];
    const session = makeSession({ startSoc: 30, sessionAgeMs: 60 * 60_000 });
    const svc = buildService(session, updates, deletes);

    await (svc as any).endSession(VEHICLE_ID, { soc: 40 }, 40, new Date());

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].energyAddedKwh).toBeCloseTo(40, 1);
  });

});
