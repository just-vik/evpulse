import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';
import { ChargingCostService } from './charging-cost.service';

/**
 * Merges fragmented charging sessions (same physical plug-in) caused by telemetry gaps:
 * the detector used to end a session after a few minutes of missing/low power even when
 * Tesla still reported Charging — producing e.g. 09:29 + 14:25 rows for one home session.
 *
 * Merge rules (conservative for DC / Supercharger, looser for slow AC home):
 * - Same vehicle, same chargerType
 * - B starts after A ends, gap ≤ maxGap (20 min for DC/SC; 24h for home AC types)
 * - Same UTC calendar day for long-gap merges (home)
 * - SOC: do not merge if the car clearly lost charge across the gap (B.start << A.end)
 */
@Injectable()
export class ChargingReconcilerService {
  private readonly logger = new Logger(ChargingReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chargingCost: ChargingCostService,
  ) {}

  @Cron('*/12 * * * *')
  async reconcileCron(): Promise<void> {
    if (!isWorkerRole()) return;
    const r = await this.runManual(undefined, 90);
    if (r.merged > 0) {
      this.logger.log(`[ChargingReconciler] merged ${r.merged} session pair(s)`);
    }
  }

  async runManual(vehicleId?: string, days = 90): Promise<{ merged: number }> {
    const since = new Date(Date.now() - days * 86_400_000);
    const vehicles = await this.prisma.vehicle.findMany({
      where: vehicleId ? { id: vehicleId } : {},
      select: { id: true },
    });

    let merged = 0;
    for (const v of vehicles) {
      merged += await this.mergeVehicleSessions(v.id, since);
    }
    return { merged };
  }

  private async mergeVehicleSessions(vehicleId: string, since: Date): Promise<number> {
    let total = 0;
    let pass = 0;
    // Re-scan until stable (handles A+B+C chains)
    while (pass < 20) {
      pass++;
      // Include sessions that *started* before `since` but overlap the window (pair with a newer row).
      const sessions = await this.prisma.chargingSession.findMany({
        where: {
          vehicleId,
          OR: [{ startTime: { gte: since } }, { endTime: { gte: since } }],
        },
        orderBy: { startTime: 'asc' },
      });
      if (sessions.length < 2) break;

      let mergedThisPass = false;
      for (let i = 0; i < sessions.length - 1; i++) {
        const a = sessions[i];
        const b = sessions[i + 1];
        if (!a.endTime) continue; // open session — should be last; if not, skip pair
        if (!this.canMergePair(a, b)) continue;

        await this.mergePairInTx(a.id, b.id);
        total++;
        mergedThisPass = true;
        break;
      }
      if (!mergedThisPass) break;
    }
    return total;
  }

  private canMergePair(
    a: { endTime: Date | null; startTime: Date; startSoc: number; endSoc: number | null; chargerType: string | null; startLat: number | null; startLng: number | null },
    b: {
      endTime: Date | null;
      startTime: Date;
      startSoc: number;
      chargerType: string | null;
      startLat: number | null;
      startLng: number | null;
    },
  ): boolean {
    if (!a.endTime) return false;
    const gapMs = b.startTime.getTime() - a.endTime.getTime();
    if (gapMs < 0) return false;

    const maxGap = maxGapMs(a.chargerType);
    if (gapMs > maxGap) return false;

    if ((a.chargerType ?? null) !== (b.chargerType ?? null)) return false;

    if (gapMs > 20 * 60_000 && !isSlowHomeCharger(a.chargerType)) return false;

    if (!socCompatibleForMerge(a.endSoc, b.startSoc)) return false;

    // Long gap @ home: same plug-in → start(A) vs start(B) should be close (schema has no endLat on session).
    if (gapMs > 20 * 60_000 && isSlowHomeCharger(a.chargerType)) {
      if (
        a.startLat != null &&
        a.startLng != null &&
        b.startLat != null &&
        b.startLng != null
      ) {
        const d = haversineM(a.startLat, a.startLng, b.startLat, b.startLng);
        if (d > 1800) return false;
      }
    }

    return true;
  }

  private async mergePairInTx(keepId: string, dropId: string): Promise<void> {
    const [a, b] = await Promise.all([
      this.prisma.chargingSession.findUnique({ where: { id: keepId } }),
      this.prisma.chargingSession.findUnique({ where: { id: dropId } }),
    ]);
    if (!a || !b || !a.endTime) return;

    const energy = (a.energyAddedKwh ?? 0) + (b.energyAddedKwh ?? 0);
    const maxPower = Math.max(a.maxPowerKw ?? 0, b.maxPowerKw ?? 0);
    const endTime = b.endTime;
    const endSoc = endTime ? (b.endSoc ?? a.endSoc) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.chargingPoint.updateMany({
        where: { sessionId: dropId },
        data: { sessionId: keepId },
      });
      await tx.chargingSession.update({
        where: { id: keepId },
        data: {
          endTime,
          endSoc,
          energyAddedKwh: energy > 0 ? Math.round(energy * 1000) / 1000 : null,
          maxPowerKw: maxPower > 0 ? maxPower : null,
          chargingEfficiency: null,
        },
      });
      await tx.chargingSession.delete({ where: { id: dropId } });
    });

    if (endTime) {
      this.chargingCost.calculateSessionCost(keepId).catch(() => undefined);
    }

    this.logger.log(
      `[ChargingReconciler] merged ${dropId} → ${keepId} ` +
      `(energy≈${energy.toFixed(2)} kWh, end=${endTime?.toISOString() ?? 'open'})`,
    );
  }
}

function isSlowHomeCharger(type: string | null): boolean {
  return ['home_slow', 'home_wall', 'ac_home', 'ac_slow', 'ac_city'].includes(type ?? '');
}

function maxGapMs(chargerType: string | null): number {
  return isSlowHomeCharger(chargerType) ? 24 * 60 * 60 * 1000 : 20 * 60 * 1000;
}

/** Reject merge if the battery clearly lost a lot of charge across the gap (unplugged). */
function socCompatibleForMerge(aEnd: number | null, bStart: number | null): boolean {
  if (aEnd == null || bStart == null) return true;
  if (bStart < aEnd - 2) return false;
  return true;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
