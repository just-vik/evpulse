import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../infra/redis.provider';
import type Redis from 'ioredis';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * Minimum number of qualifying sessions before we'll update the baseline.
 * Below this the estimate variance is too high to trust.
 */
const MIN_QUALITY_SESSIONS = 3;

/**
 * Below this battery temperature the BMS artificially limits accessible
 * capacity. Sessions in cold conditions produce systematically low estimates
 * and must be excluded.
 */
const MIN_BATTERY_TEMP_C = 5;

@Injectable()
export class BatteryHealthService {
  private readonly logger = new Logger(BatteryHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Cron ──────────────────────────────────────────────────────────────────

  /**
   * DISABLED 2026-09-10 — BatteryAnalyticsService.updateBatteryMetrics() is
   * now the sole canonical writer to BatteryHealth (see docs/calculations/
   * battery-health.md "Canonical engine"). This service (Engine A) is kept
   * as legacy/comparison-only per that decision; its @Cron trigger is
   * removed so it can no longer race BatteryAnalyticsService's own 03:00
   * UTC cron to write the "latest" row. The method itself is left callable
   * (e.g. for manual comparison via scripts/compare-battery-health-engines.ts)
   * — only the automatic schedule is disabled.
   *
   * Previously: daily capacity backfill at 03:30 UTC — 30 min after
   * BatteryAnalyticsService's cron (03:00) so the two heavy scans didn't
   * overlap. Processes ALL historical sessions (no take limit).
   */
  async scheduledCapacityBackfill(): Promise<void> {
    if (!isWorkerRole()) return;
    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: { id: true },
    });
    if (!vehicles.length) return;
    this.logger.log(`[Cron] Capacity backfill for ${vehicles.length} vehicle(s)`);
    for (const v of vehicles) {
      await this.backfillCapacityFromHistory(v.id).catch((e: Error) =>
        this.logger.warn(`[BatteryHealth] Backfill skipped for ${v.id}: ${e.message}`),
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Estimate current battery capacity from the most recent 50 charging sessions.
   * Called by BatteryAnalyticsService.updateBatteryMetrics() after each session.
   *
   * Formula: capacity_kWh = energy_added_kWh / (ΔSOC / 100)
   *
   * Quality filter (TezLab method — excludes noisy partial charges):
   *   • deltaSoc  ≥ 25 %  — enough SOC swing to reduce BMS measurement error
   *   • endSoc    ≥ 90 %  — near-full charges give the best capacity estimate
   *
   * Fallback (basic filter):
   *   Used when fewer than MIN_QUALITY_SESSIONS qualifying sessions exist.
   *   Accepts any positive deltaSoc charge so new users get an estimate quickly.
   *
   * Temperature guard: sessions where batteryTemp < MIN_BATTERY_TEMP_C are
   * excluded (BMS limits accessible pack capacity in cold conditions).
   *
   * Aggregation: weighted median (robust to outliers).
   */
  async estimateCapacityFromCharging(vehicleId: string) {
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        energyAddedKwh: { not: null },
        // startSoc is a required (non-nullable) column — filtering it with
        // `{ not: null }` is always true but Prisma 5.x rejects the
        // predicate outright at runtime for a non-nullable field, throwing
        // "Argument `not` must not be null" on every call. endSoc IS
        // nullable, so its `{ not: null }` filter stays.
        endSoc: { not: null },
        endTime: { not: null },
      },
      orderBy: { startTime: 'desc' },
      take: 50,
    });

    if (!sessions.length) return null;

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleSpec: true },
    });
    if (!vehicle) return null;

    return this._computeAndPersistCapacity(vehicleId, sessions, vehicle);
  }

  /**
   * Estimate battery capacity from ALL historical charging sessions (no limit).
   * Gives a more accurate baseline than estimateCapacityFromCharging() (last 50)
   * because it weights the full charge history. Run once daily by cron and
   * on-demand (e.g. after a manual tariff backfill).
   *
   * @param since  Only consider sessions from this date onwards.
   *               Omit to include the entire history.
   */
  async backfillCapacityFromHistory(vehicleId: string, since?: Date): Promise<void> {
    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        energyAddedKwh: { not: null },
        // See the identical comment in estimateCapacityFromCharging() above —
        // startSoc is non-nullable, so `{ not: null }` on it throws at runtime.
        endSoc: { not: null },
        endTime: { not: null },
        ...(since ? { startTime: { gte: since } } : {}),
      },
      orderBy: { startTime: 'desc' },
    });

    if (!sessions.length) return;

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleSpec: true },
    });
    if (!vehicle) return;

    await this._computeAndPersistCapacity(vehicleId, sessions, vehicle);
  }

  // ── Core computation ───────────────────────────────────────────────────────

  private async _computeAndPersistCapacity(
    vehicleId: string,
    sessions: Array<{
      id: string;
      startSoc: number;
      endSoc: number | null;
      energyAddedKwh: number | null;
    }>,
    vehicle: { batteryCapacityNominal: number; vehicleSpec: { batteryNominalKwh: number | null } | null },
  ) {
    const nominal =
      vehicle.vehicleSpec?.batteryNominalKwh ??
      vehicle.batteryCapacityNominal;

    // Fetch nearest battery temperature for each session in one JOIN query.
    // Sessions without nearby telemetry get null → not filtered (benefit of the doubt).
    const sessionIds = sessions.map(s => s.id);
    const tempMap = await this._fetchSessionBatteryTemps(vehicleId, sessionIds);

    type Sample = { cap: number; weight: number; isQuality: boolean };
    const samples: Sample[] = [];
    let coldSkipped = 0;

    for (const s of sessions) {
      // Temperature guard: skip when BMS is artificially capacity-limited
      const temp = tempMap.get(s.id);
      if (temp != null && temp < MIN_BATTERY_TEMP_C) {
        coldSkipped++;
        continue;
      }

      const deltaSoc = ((s.endSoc ?? 0) - s.startSoc);
      if (deltaSoc <= 0) continue;
      const energy = s.energyAddedKwh ?? 0;
      if (energy <= 0) continue;

      const cap = energy / (deltaSoc / 100);
      // Physical bounds: 20–120 kWh covers all Tesla models
      if (cap < 20 || cap > 120) continue;

      // Temperature correction: cold Li-ion cells show reduced accessible capacity.
      // Divide by the piecewise factor to normalise to the 20°C reference baseline
      // (e.g. a 75 kWh reading at 5°C ≈ 81 kWh at 20°C after correction).
      // Sessions with unknown battery temp are used without correction (benefit of the doubt).
      const factor = temp != null ? batteryTempCapacityFactor(temp) : 1.0;
      const correctedCap = factor > 0 ? cap / factor : cap;
      if (correctedCap < 20 || correctedCap > 120) continue;

      const isQuality = deltaSoc >= 25 && (s.endSoc ?? 0) >= 90;
      samples.push({ cap: correctedCap, weight: deltaSoc, isQuality });
    }

    if (coldSkipped > 0) {
      this.logger.debug(
        `[BatteryHealth] ${vehicleId}: skipped ${coldSkipped} cold session(s) (<${MIN_BATTERY_TEMP_C}°C)`,
      );
    }

    if (!samples.length) return null;

    // ── Choose quality vs fallback set ───────────────────────────────────────
    const qualitySamples = samples.filter(s => s.isQuality);
    const usedSamples = qualitySamples.length >= MIN_QUALITY_SESSIONS
      ? qualitySamples
      : samples;

    const method = qualitySamples.length >= MIN_QUALITY_SESSIONS
      ? 'charging_quality'
      : 'charging_simple';

    if (qualitySamples.length < MIN_QUALITY_SESSIONS && qualitySamples.length > 0) {
      this.logger.debug(
        `[BatteryHealth] ${vehicleId}: only ${qualitySamples.length} quality session(s) — using all ${samples.length} as fallback`,
      );
    }

    // ── Weighted median ──────────────────────────────────────────────────────
    // Sort by capacity value, then find the 50th percentile of cumulative weight.
    usedSamples.sort((a, b) => a.cap - b.cap);
    const totalWeight = usedSamples.reduce((s, x) => s + x.weight, 0);
    let cumWeight = 0;
    let medianCap = usedSamples[usedSamples.length - 1].cap;
    for (const s of usedSamples) {
      cumWeight += s.weight;
      if (cumWeight >= totalWeight / 2) {
        medianCap = s.cap;
        break;
      }
    }

    const detectedCapacity = Math.round(medianCap * 10) / 10;
    // Cap at 100%: estimated > nominal means measurement noise, not a super-battery.
    const sohPercent = nominal > 0 ? Math.min(100, (medianCap / nominal) * 100) : 100;
    const degradationPercent = nominal > 0 ? Math.max(0, (1 - medianCap / nominal) * 100) : 0;

    // ── Confidence score ─────────────────────────────────────────────────────
    const n = usedSamples.length;
    const isQualityBatch = method === 'charging_quality';
    const confidence = isQualityBatch
      ? Math.min(0.95, 0.5 + (n / 10) * 0.45)
      : Math.min(0.70, 0.3 + (n / 15) * 0.40);

    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { batteryCapacityDetected: detectedCapacity },
    });

    const entry = await this.prisma.batteryHealth.create({
      data: {
        vehicleId,
        sohPercent:           Math.round(sohPercent * 100) / 100,
        estimatedCapacityKwh: detectedCapacity,
        nominalCapacityKwh:   nominal,
        degradationPercent:   Math.round(degradationPercent * 100) / 100,
        method,
        confidenceScore:      Math.round(confidence * 100) / 100,
        sampleCount:          n,
        chargingSoh:          Math.round(sohPercent * 100) / 100,
      },
    });

    // Invalidate cached history windows so the next request reflects new SOH.
    this.scanAndDel(`battery:history:v1:${vehicleId}:*`);

    this.logger.log(
      `[BatteryHealth] ${vehicleId}: ${detectedCapacity} kWh SOH ${entry.sohPercent}% ` +
      `(${degradationPercent.toFixed(1)}% degradation) via ${method} ` +
      `[${n} sessions, confidence ${entry.confidenceScore}]`,
    );

    return entry;
  }

  // ── Trend & forecast ──────────────────────────────────────────────────────

  /**
   * Weekly SOH trend for the vehicle.
   * Groups battery_health records by ISO week, picking the most-confident
   * (then most-recent) entry per week so noisy same-day duplicates don't
   * inflate the series.
   *
   * @param weeks  How many weeks back to scan (default 52).
   * @returns Array of { week, sohPercent, estimatedCapacityKwh, method, confidenceScore }
   *          sorted ascending by week.
   */
  async getDegradationTrend(vehicleId: string, weeks = 52) {
    const since = new Date();
    since.setDate(since.getDate() - weeks * 7);

    const records = await this.prisma.batteryHealth.findMany({
      where: { vehicleId, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        sohPercent: true,
        estimatedCapacityKwh: true,
        method: true,
        confidenceScore: true,
      },
    });

    if (!records.length) return [];

    // Group by ISO year-week string ("2026-W21")
    type WeekEntry = {
      week: string;
      sohPercent: number;
      estimatedCapacityKwh: number;
      method: string;
      confidenceScore: number;
    };
    const byWeek = new Map<string, typeof records[0]>();
    for (const r of records) {
      const d = new Date(r.createdAt);
      // ISO week: Thursday-anchored
      const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      const weekNum = Math.ceil(
        ((d.getTime() - jan4.getTime()) / 86_400_000 + jan4.getUTCDay() + 1) / 7,
      );
      const key = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      const existing = byWeek.get(key);
      if (
        !existing ||
        r.confidenceScore > existing.confidenceScore ||
        (r.confidenceScore === existing.confidenceScore &&
          r.createdAt > existing.createdAt)
      ) {
        byWeek.set(key, r);
      }
    }

    return Array.from(byWeek.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, r]): WeekEntry => ({
        week,
        // Clip legacy >100% records (range-method noise) so they don't skew regression.
        sohPercent: Math.min(100, r.sohPercent),
        estimatedCapacityKwh: r.estimatedCapacityKwh,
        method: r.method,
        confidenceScore: r.confidenceScore,
      }));
  }

  /**
   * Linear regression on the weekly SOH series to estimate when the battery
   * will reach 80% SOH (the standard "end of useful life" threshold).
   *
   * Requires ≥ 4 weekly data points with non-zero slope before producing a
   * forecast — below that the estimate variance is too high.
   *
   * @returns {
   *   slope: %/year (negative = degrading),
   *   currentSoh: latest SOH %,
   *   forecastDate: ISO date when 80% is reached, or null if not degrading / insufficient data,
   *   yearsToThreshold: numeric years from now, or null,
   *   r2: goodness-of-fit (0–1),
   *   dataPoints: number of weekly points used,
   * }
   */
  async forecastDegradation(vehicleId: string) {
    const trend = await this.getDegradationTrend(vehicleId, 104); // up to 2 years

    if (trend.length < 4) {
      return {
        slope: null, currentSoh: trend[trend.length - 1]?.sohPercent ?? null,
        forecastDate: null, yearsToThreshold: null, r2: null,
        dataPoints: trend.length,
        reason: 'insufficient_data',
      };
    }

    // Convert to (x = days since first point, y = sohPercent) pairs
    const t0 = 0;
    const xs = trend.map((_, i) => i * 7); // week index → days
    const ys = trend.map(p => p.sohPercent);
    const n  = xs.length;

    const sumX  = xs.reduce((a, b) => a + b, 0);
    const sumY  = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const sumX2 = xs.reduce((s, x) => s + x * x, 0);

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) {
      return {
        slope: 0, currentSoh: ys[n - 1], forecastDate: null,
        yearsToThreshold: null, r2: 0, dataPoints: n, reason: 'flat',
      };
    }

    const slopePerDay = (n * sumXY - sumX * sumY) / denom;
    const intercept   = (sumY - slopePerDay * sumX) / n;
    const slopePerYear = slopePerDay * 365;

    // R² goodness-of-fit
    const yMean = sumY / n;
    const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
    const ssRes = xs.reduce((s, x, i) => s + (ys[i] - (intercept + slopePerDay * x)) ** 2, 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    const currentSoh = ys[n - 1];

    if (slopePerDay >= 0) {
      // Not degrading (or improving — unlikely but possible in short windows)
      return {
        slope: +slopePerYear.toFixed(3), currentSoh, forecastDate: null,
        yearsToThreshold: null, r2: +r2.toFixed(3), dataPoints: n, reason: 'not_degrading',
      };
    }

    // Days from last data point until the regression line hits 80%
    const lastX = xs[n - 1];
    const daysToThreshold = (80 - (intercept + slopePerDay * lastX)) / slopePerDay;
    const forecastMs = Date.now() + daysToThreshold * 86_400_000;
    const forecastDate = new Date(forecastMs).toISOString().slice(0, 10);
    const yearsToThreshold = +(daysToThreshold / 365).toFixed(1);

    return {
      slope:             +slopePerYear.toFixed(3),
      currentSoh,
      forecastDate:      yearsToThreshold > 0 && yearsToThreshold < 50 ? forecastDate : null,
      yearsToThreshold:  yearsToThreshold > 0 && yearsToThreshold < 50 ? yearsToThreshold : null,
      r2:                +r2.toFixed(3),
      dataPoints:        n,
      reason:            'ok',
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Batch-fetch the battery temperature nearest to each session's start time.
   * Uses a single JOIN query (not N+1). Sessions without nearby telemetry
   * (e.g. missing GPS lock or brand-new vehicle) return null in the map —
   * callers must NOT filter those sessions out (benefit of the doubt).
   *
   * Search window: [startTime − 15 min, startTime + 10 min]
   */
  private async _fetchSessionBatteryTemps(
    vehicleId: string,
    sessionIds: string[],
  ): Promise<Map<string, number | null>> {
    if (!sessionIds.length) return new Map();

    // cuid IDs are alphanumeric-only (no quotes or special chars) — safe for literal interpolation.
    const idList = sessionIds.map(id => `'${id}'`).join(',');
    const rows = (await (this.prisma.$queryRawUnsafe as any)(
      `SELECT DISTINCT ON (cs.id)
         cs.id,
         tp."batteryTemp"
       FROM "charging_sessions" cs
       LEFT JOIN "telemetry_points" tp ON
         tp."vehicleId" = cs."vehicleId"
         AND tp."timestamp" BETWEEN cs."startTime" - INTERVAL '15 minutes'
                                 AND cs."startTime" + INTERVAL '10 minutes'
         AND tp."batteryTemp" IS NOT NULL
       WHERE cs.id IN (${idList})
       ORDER BY cs.id, ABS(EXTRACT(EPOCH FROM (tp."timestamp" - cs."startTime")))`,
    )) as Array<{ id: string; batteryTemp: number | null }>;

    return new Map(rows.map(r => [r.id, r.batteryTemp]));
  }

  /**
   * Iterates via SCAN (cursor-based, non-blocking) and DELetes all keys
   * matching `pattern`. Unlike KEYS, SCAN never blocks the Redis event loop.
   */
  private scanAndDel(pattern: string): void {
    const sweep = async (cursor: string) => {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      if (keys.length > 0) await this.redis.del(...keys);
      if (nextCursor !== '0') await sweep(nextCursor);
    };
    sweep('0').catch(() => { /* non-critical */ });
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────────

/**
 * Piecewise linear temperature capacity factor for Li-ion cells.
 *
 * Returns the fraction of 20°C reference capacity that is accessible at tempC.
 * Used to normalise cold-weather charging sessions to a common baseline so that
 * a January session and a July session contribute equally to the SOH estimate.
 *
 *   ≥ 20°C : 1.000  (baseline, no correction)
 *   10°C   : 0.960  (−0.40 %/°C  in the 10→20 range)
 *    0°C   : 0.890  (−0.70 %/°C  in the  0→10 range — cold slows Li-ion kinetics)
 *  −10°C   : 0.790  (−1.00 %/°C  below 0 — lithium plating risk accelerates loss)
 *  < −10°C : 0.790  (floor — do not extrapolate further; sessions are excluded anyway)
 *
 * Source: empirical fit to published Tesla Model Y capacity-vs-temperature curves.
 */
function batteryTempCapacityFactor(tempC: number): number {
  if (tempC >= 20)  return 1.000;
  if (tempC >= 10)  return 1.000 - (20 - tempC) * 0.004;
  if (tempC >=  0)  return 0.960 - (10 - tempC) * 0.007;
  if (tempC >= -10) return 0.890 - ( 0 - tempC) * 0.010;
  return 0.790;
}
