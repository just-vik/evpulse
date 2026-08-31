import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';

const CACHE_TTL_SEC = 300; // 5 min

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export interface Anomaly {
  type:        string;
  severity:    AnomalySeverity;
  message:     string;
  value:       number;
  baseline:    number;
  deviationPct: number;
}

/**
 * AnomalyDetectionService
 *
 * Detects three classes of production-relevant anomalies:
 *   1. High energy consumption (efficiency spike vs rolling baseline)
 *   2. Vampire drain (SOC loss per hour while parked)
 *   3. Slow charging (actual rate vs expected max)
 *
 * Each anomaly includes a severity, human-readable message, raw value,
 * and baseline — ready to push to NotificationEngine or display in UI.
 */
@Injectable()
export class AnomalyDetectionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async detect(vehicleId: string): Promise<Anomaly[]> {
    const cacheKey = `ml:anomalies:${vehicleId}`;
    const cached   = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const anomalies: Anomaly[] = [
      ...(await this.checkEfficiency(vehicleId)),
      ...(await this.checkVampireDrain(vehicleId)),
      ...(await this.checkChargingRate(vehicleId)),
    ];

    await (this.redis as any).set(cacheKey, JSON.stringify(anomalies), 'EX', CACHE_TTL_SEC);
    return anomalies;
  }

  // ── 1. Efficiency anomaly ───────────────────────────────────────────────────
  private async checkEfficiency(vehicleId: string): Promise<Anomaly[]> {
    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        distanceKm:    { gt: 5 },
        efficiencyWhkm: { not: null },
        endTime:        { not: null },
      },
      orderBy: { startTime: 'desc' },
      take: 30,
    });

    if (trips.length < 5) return [];

    // Rolling baseline = median of the oldest 80% (excludes recent outliers)
    const sorted      = [...trips].sort((a, b) => a.efficiencyWhkm! - b.efficiencyWhkm!);
    const baselineSet = sorted.slice(0, Math.floor(sorted.length * 0.8));
    const baseline    = baselineSet.reduce((s, t) => s + t.efficiencyWhkm!, 0) / baselineSet.length;

    const recentTrips = trips.slice(0, 5);
    const recentAvg   = recentTrips.reduce((s, t) => s + t.efficiencyWhkm!, 0) / recentTrips.length;

    const deviation = (recentAvg - baseline) / baseline;

    if (deviation <= 0.25) return []; // ≤ 25% above baseline = normal variation

    const severity: AnomalySeverity = deviation > 0.50 ? 'critical' : 'warning';
    return [{
      type:         'high_consumption',
      severity,
      message:      `Recent trips use ${Math.round(deviation * 100)}% more energy than your baseline (${Math.round(baseline)} Wh/km avg → ${Math.round(recentAvg)} Wh/km recently)`,
      value:        Math.round(recentAvg),
      baseline:     Math.round(baseline),
      deviationPct: Math.round(deviation * 100),
    }];
  }

  // ── 2. Vampire drain anomaly ────────────────────────────────────────────────
  private async checkVampireDrain(vehicleId: string): Promise<Anomaly[]> {
    // Look at parked sessions (consecutive telemetry points with speed=0)
    // Find SOC drop per hour during recent parked periods
    const points = await this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        speed: { lte: 1 },
        soc:   { not: null },
      },
      orderBy: { timestamp: 'desc' },
      take: 500,
      select: { timestamp: true, soc: true },
    });

    if (points.length < 10) return [];

    // Find parked sessions (gap < 30 min, at least 1h long)
    const sessions: Array<{ drainPctPerHr: number }> = [];
    let i = 0;
    while (i < points.length - 1) {
      const start = points[i];
      let end = points[i];
      let j = i + 1;

      while (j < points.length) {
        const gapMs = points[j - 1].timestamp.getTime() - points[j].timestamp.getTime(); // descending
        if (gapMs > 30 * 60_000) break; // gap > 30 min ends the session
        end = points[j];
        j++;
      }

      const durationHr = (start.timestamp.getTime() - end.timestamp.getTime()) / 3_600_000;
      const socDrop    = (start.soc ?? 0) - (end.soc ?? 0);

      if (durationHr >= 1 && socDrop > 0) {
        sessions.push({ drainPctPerHr: socDrop / durationHr });
      }
      i = j;
    }

    if (sessions.length < 3) return [];

    const avgDrain   = sessions.reduce((s, p) => s + p.drainPctPerHr, 0) / sessions.length;
    const recentDrain = sessions.slice(0, Math.min(3, sessions.length))
      .reduce((s, p) => s + p.drainPctPerHr, 0) / Math.min(3, sessions.length);

    // Normal vampire drain: 0.2–0.5% SOC/hr. Flag > 1% as warning, > 2% as critical.
    const normalBaseline = 0.4;
    if (recentDrain <= 1.0) return [];

    const severity: AnomalySeverity = recentDrain > 2.0 ? 'critical' : 'warning';
    const deviation = (recentDrain - normalBaseline) / normalBaseline;
    return [{
      type:         'high_vampire_drain',
      severity,
      message:      `Vampire drain is ${recentDrain.toFixed(1)}%/hr while parked (normal ≤0.5%/hr). Check Sentry Mode, climate, or software issues.`,
      value:        Math.round(recentDrain * 10) / 10,
      baseline:     normalBaseline,
      deviationPct: Math.round(deviation * 100),
    }];
  }

  // ── 3. Slow charging anomaly ────────────────────────────────────────────────
  private async checkChargingRate(vehicleId: string): Promise<Anomaly[]> {
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        energyAddedKwh: { gt: 1 },
        endTime:        { not: null },
      },
      orderBy: { startTime: 'desc' },
      take: 20,
      select: { energyAddedKwh: true, startTime: true, endTime: true, maxPowerKw: true },
    });

    if (sessions.length < 3) return [];

    // Compute average charging rate (kWh / duration hours) across sessions
    const rates = sessions
      .map(s => {
        const hrs = (s.endTime!.getTime() - s.startTime.getTime()) / 3_600_000;
        return hrs > 0 ? (s.energyAddedKwh ?? 0) / hrs : 0;
      })
      .filter(r => r > 0.5); // filter sub-1kW noise

    if (rates.length < 3) return [];

    // Baseline = top-quartile average (best sessions = expected capability)
    const sortedRates = [...rates].sort((a, b) => b - a);
    const topQ        = sortedRates.slice(0, Math.ceil(sortedRates.length * 0.25));
    const baseline    = topQ.reduce((s, r) => s + r, 0) / topQ.length;

    const recentRate  = rates[0]; // most recent session
    const deviation   = (baseline - recentRate) / baseline;

    if (deviation <= 0.30) return []; // ≤ 30% below baseline = acceptable

    const severity: AnomalySeverity = deviation > 0.50 ? 'critical' : 'warning';
    return [{
      type:         'slow_charging',
      severity,
      message:      `Last charging session added only ${recentRate.toFixed(1)} kW avg vs your usual ${baseline.toFixed(1)} kW. Check cable, charger, or battery temp.`,
      value:        Math.round(recentRate * 10) / 10,
      baseline:     Math.round(baseline * 10) / 10,
      deviationPct: Math.round(deviation * 100),
    }];
  }
}
