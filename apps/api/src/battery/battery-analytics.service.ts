import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isWorkerRole } from '../runtime/runtime-role';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../infra/redis.provider';
import type Redis from 'ioredis';
import { isValidTrip } from '../ml/trip-validator';

/**
 * BatteryAnalyticsService - Production-grade battery SOH analysis
 *
 * Three SOH calculation methods (TeslaMate-inspired):
 *
 * Method 1 - Trip-based (Rated Range):
 *   estimated_range_km / rated_range_km * 100
 *   Requires: display_range + rated_range from telemetry
 *
 * Method 2 - Energy Capacity (Charging):
 *   energy_added_kwh / (soc_change / 100) = estimated_capacity
 *   soh = estimated_capacity / nominal_capacity * 100
 *   Filter: soc_change > 10%, full charge preferred (endSoc > 95%)
 *
 * Method 3 - Consumption-based (Trip energy):
 *   energy_used_kwh / (soc_drop / 100) = estimated_capacity
 *   soh = estimated_capacity / nominal_capacity * 100
 *   Filter: soc_drop > 20%, distance > 20km
 *
 * Temperature correction: ~0.4% capacity per °C below 20°C
 * BMS calibration filter: discard samples within 2% of nominal (BMS may not have recalibrated)
 * Weighted median: Method 2 (0.4) + Method 3 (0.4) + Method 1 (0.2)
 */
@Injectable()
export class BatteryAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(BatteryAnalyticsService.name);

  // Correction factor: capacity loss per °C below reference temperature
  private readonly TEMP_CORRECTION_PER_DEGREE = 0.004; // 0.4%/°C
  private readonly TEMP_REFERENCE_C = 20;

  // Tesla BMS reports charge_energy_added = energy stored in battery (measured at pack terminals).
  // This is ALREADY the post-conversion value — no efficiency correction required regardless of
  // charger type (DC Supercharger bypasses onboard charger; AC goes through it, but BMS still
  // measures battery-side). Factor kept as constant for future non-BMS data sources.
  private readonly DC_CHARGING_EFFICIENCY = 1.0;

  // HIGH-confidence baseline: near-full charges (endSoc ≥ 90%) — BMS recalibrated, most accurate.
  private readonly BASELINE_HIGH_MIN_SAMPLES = 10;
  private readonly BASELINE_HIGH_MAX_STD_DEV = 2.5; // kWh

  // MEDIUM-confidence baseline: partial charges (endSoc 70–90%) — less accurate, used as fallback.
  private readonly BASELINE_MED_MIN_SAMPLES = 15;
  private readonly BASELINE_MED_MAX_STD_DEV = 3.5; // kWh

  // Minimum SOC delta for any session to be considered in baseline estimation.
  private readonly BASELINE_MIN_SOC_DELTA = 30;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getBaselineStatus(vehicleId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      batteryBaselineHighKwh:        number | null;
      batteryBaselineHighLockedAt:   Date    | null;
      batteryBaselineMediumKwh:      number | null;
      batteryBaselineMediumLockedAt: Date    | null;
      batteryCyclesTotal:            number | null;
      batteryCycleChargeTotal:       number | null;
      batteryCapacityDetected:       number | null;
      batteryCapacityUsable:         number;
    }>>`
      SELECT "batteryBaselineHighKwh", "batteryBaselineHighLockedAt",
             "batteryBaselineMediumKwh", "batteryBaselineMediumLockedAt",
             "batteryCyclesTotal", "batteryCycleChargeTotal",
             "batteryCapacityDetected", "batteryCapacityUsable"
      FROM   vehicles WHERE id = ${vehicleId}
    `;
    if (!rows.length) return { baselineLocked: false };
    const v = rows[0];
    const d = v.batteryCyclesTotal;
    const c = v.batteryCycleChargeTotal;
    const effectiveKwh = v.batteryBaselineHighKwh ?? v.batteryBaselineMediumKwh;
    return {
      baselineLocked:           effectiveKwh != null,
      baselineConfidence:       v.batteryBaselineHighKwh ? 'HIGH' : effectiveKwh ? 'MEDIUM' : 'NONE',
      baselineHighKwh:          v.batteryBaselineHighKwh,
      baselineHighLockedAt:     v.batteryBaselineHighLockedAt,
      baselineMediumKwh:        v.batteryBaselineMediumKwh,
      baselineMediumLockedAt:   v.batteryBaselineMediumLockedAt,
      effectiveBaselineKwh:     effectiveKwh,
      detectedKwh:              v.batteryCapacityDetected,
      specUsableKwh:            v.batteryCapacityUsable,
      cyclesDrive:              d,
      cyclesCharge:             c,
      cyclesEffective:          d != null && c != null ? (d + c) / 2 : (d ?? c),
    };
  }

  async onModuleInit(): Promise<void> {
    // Log baseline lock status for all active vehicles on startup.
    // Using raw SQL to avoid TypeScript/Prisma select type issues with new columns.
    this.logger.log('Checking battery baseline lock status for all active vehicles…');
    try {
      const rows = await this.prisma.$queryRaw<Array<{
        id:                            string;
        batteryBaselineHighKwh:        number | null;
        batteryBaselineHighLockedAt:   Date    | null;
        batteryBaselineMediumKwh:      number | null;
        batteryCyclesTotal:            number | null;
        batteryCycleChargeTotal:       number | null;
        batteryCapacityDetected:       number | null;
      }>>`
        SELECT id,
               "batteryBaselineHighKwh",
               "batteryBaselineHighLockedAt",
               "batteryBaselineMediumKwh",
               "batteryCyclesTotal",
               "batteryCycleChargeTotal",
               "batteryCapacityDetected"
        FROM   vehicles
        WHERE  status = 'active'
      `;

      for (const v of rows) {
        const highKwh = v.batteryBaselineHighKwh;
        const medKwh  = v.batteryBaselineMediumKwh;
        const eff     = highKwh ?? medKwh;
        const d       = v.batteryCyclesTotal;
        const c       = v.batteryCycleChargeTotal;
        const cycles  = d != null && c != null ? (d + c) / 2 : (d ?? c);

        if (highKwh != null) {
          this.logger.log(
            `🔒 [HIGH] Baseline LOCKED for ${v.id}: ${highKwh} kWh ` +
            `(locked ${v.batteryBaselineHighLockedAt?.toISOString() ?? '?'}) ` +
            `cycles=${cycles?.toFixed(0) ?? 'N/A'}`,
          );
        } else if (medKwh != null) {
          this.logger.log(
            `🔒 [MEDIUM] Baseline LOCKED for ${v.id}: ${medKwh} kWh ` +
            `(need ≥${this.BASELINE_HIGH_MIN_SAMPLES} full charges for HIGH tier)`,
          );
        } else {
          this.logger.warn(
            `⏳ Baseline NOT locked for ${v.id} ` +
            `(detected=${v.batteryCapacityDetected?.toFixed(2) ?? 'N/A'} kWh) ` +
            `— need ≥${this.BASELINE_HIGH_MIN_SAMPLES} full charges (endSoc≥90%, socDelta≥30%, stdDev<${this.BASELINE_HIGH_MAX_STD_DEV} kWh) ` +
            `OR ≥${this.BASELINE_MED_MIN_SAMPLES} partial charges (endSoc 70–90%)`,
          );
        }
      }
    } catch (e: any) {
      this.logger.error(`Baseline status check failed: ${e?.message ?? String(e)}`, e?.stack);
    }

    // If battery_health is empty (e.g. after a manual reset or first run),
    // run an immediate recalculation for all active vehicles instead of waiting
    // for the 3 AM cron.
    if (isWorkerRole()) {
      try {
        const count = await this.prisma.batteryHealth.count();
        if (count === 0) {
          this.logger.log('battery_health is empty — running immediate recalculation on startup');
          const vehicles = await this.prisma.vehicle.findMany({
            where: { status: 'active' },
            select: { id: true },
          });
          for (const v of vehicles) {
            await this.updateBatteryMetrics(v.id).catch((e: Error) =>
              this.logger.warn(`Startup recalc failed for ${v.id}: ${e.message}`),
            );
          }
        }
      } catch (e: any) {
        this.logger.warn(`Startup recalc check failed: ${e?.message ?? String(e)}`);
      }
    }
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  /**
   * Track energy throughput for cycle counting.
   * Call with source='drive' after each trip, source='charge' after each charging session.
   *
   * Using two independent sources averages out measurement errors:
   *   - Drive energy can miss regen / HVAC from vehicle-side
   *   - Charge energy includes AC→DC conversion losses
   * Final effective cycles = (driveTotal + chargeTotal) / 2 when both available.
   */
  async trackCycles(vehicleId: string, energyKwh: number, source: 'drive' | 'charge' = 'drive'): Promise<void> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: {
        batteryCyclesTotal:      true,
        batteryCycleChargeTotal: true,
      } as any,
    });
    if (!vehicle) return;

    // Use effective baseline (HIGH > MEDIUM > detected > spec)
    const { effectiveKwh } = await this.getEffectiveBaseline(vehicleId);
    const capacity = effectiveKwh ?? 75;
    const delta    = energyKwh / capacity;

    if (source === 'drive') {
      const newTotal = ((vehicle as any).batteryCyclesTotal ?? 0) + delta;
      await this.prisma.vehicle.update({
        where: { id: vehicleId },
        data:  { batteryCyclesTotal: Math.round(newTotal * 100) / 100 } as any,
      });
    } else {
      // Apply AC→DC charging efficiency (energy stored ≈ 90% of energy added)
      const storedDelta = delta * 0.90;
      const newTotal    = ((vehicle as any).batteryCycleChargeTotal ?? 0) + storedDelta;
      await this.prisma.vehicle.update({
        where: { id: vehicleId },
        data:  { batteryCycleChargeTotal: Math.round(newTotal * 100) / 100 } as any,
      });
    }
  }

  /**
   * Effective cycle count: average of drive and charge totals when both available.
   * Falls back to whichever source has data.
   */
  async getEffectiveCycles(vehicleId: string): Promise<number | null> {
    const v = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { batteryCyclesTotal: true, batteryCycleChargeTotal: true } as any,
    });
    if (!v) return null;
    const d = (v as any).batteryCyclesTotal    as number | null;
    const c = (v as any).batteryCycleChargeTotal as number | null;
    if (d != null && c != null) return (d + c) / 2;
    return d ?? c ?? null;
  }

  // ============================================================================
  // PRIVATE — BASELINE HELPERS
  // ============================================================================

  /**
   * Read both baseline tiers from DB and return the effective one.
   * Priority: HIGH (endSoc≥90% sessions) > MEDIUM (endSoc 70–90% sessions) > null.
   */
  private async getEffectiveBaseline(vehicleId: string): Promise<{
    highKwh:    number | null;
    medKwh:     number | null;
    effectiveKwh: number | null;
    confidence: 'HIGH' | 'MEDIUM' | 'NONE';
    locked:     boolean;
  }> {
    const [row] = await this.prisma.$queryRaw<Array<{
      batteryBaselineHighKwh:   number | null;
      batteryBaselineMediumKwh: number | null;
    }>>`
      SELECT "batteryBaselineHighKwh", "batteryBaselineMediumKwh"
      FROM   vehicles WHERE id = ${vehicleId}
    `;
    if (!row) return { highKwh: null, medKwh: null, effectiveKwh: null, confidence: 'NONE', locked: false };
    const h = row.batteryBaselineHighKwh;
    const m = row.batteryBaselineMediumKwh;
    const eff = h ?? m ?? null;
    return {
      highKwh:     h,
      medKwh:      m,
      effectiveKwh: eff,
      confidence:  h ? 'HIGH' : m ? 'MEDIUM' : 'NONE',
      locked:      eff != null,
    };
  }

  /**
   * Calculate and store current SOH for a vehicle.
   * Called after each telemetry batch or charging session completion.
   */
  async updateBatteryMetrics(vehicleId: string): Promise<void> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleSpec: true },
    });
    if (!vehicle) {
      this.logger.warn(`Vehicle ${vehicleId} not found`);
      return;
    }

    // Try to lock both baseline tiers (no-op if already locked or not enough data)
    await this.tryLockBaseline(vehicleId);

    // Re-fetch to pick up the freshly locked baseline values
    const baseline = await this.getEffectiveBaseline(vehicleId);

    const nominalKwh    = vehicle.vehicleSpec?.batteryNominalKwh ?? vehicle.batteryCapacityNominal ?? 75;
    const specUsableKwh = vehicle.vehicleSpec?.batteryUsableKwh  ?? vehicle.batteryCapacityUsable  ?? 75;
    const detectedKwh   = (vehicle as any).batteryCapacityDetected as number | null | undefined;

    // Priority: locked baseline (HIGH > MEDIUM) > detected > spec
    const usableKwh = (baseline.effectiveKwh && baseline.effectiveKwh > 10)
      ? baseline.effectiveKwh
      : (detectedKwh && detectedKwh > 10)
        ? detectedKwh
        : specUsableKwh;

    // WLTP range: use spec if available, else derive from 169 Wh/km (Model Y LR EU default).
    // Exposed as a separate variable so lowConfidence can be flagged when spec is missing.
    const wltpRangeKm = vehicle.vehicleSpec?.rangeWltp
      ?? (nominalKwh * 1000) / 169;
    const wltpIsFromSpec = vehicle.vehicleSpec?.rangeWltp != null;

    const [tripSoh, chargingSoh, rangeSoh, avgTemp, currentCycles] = await Promise.all([
      this.calculateSohFromTrips(vehicleId, usableKwh),
      this.calculateSohFromCharging(vehicleId, usableKwh),
      this.calculateSohFromRange(vehicleId, wltpRangeKm),
      this.getRecentAvgBatteryTemp(vehicleId),
      this.getEffectiveCycles(vehicleId),
    ]);

    const validMethods: { soh: number; weight: number; name: string }[] = [];
    if (rangeSoh !== null) validMethods.push({ soh: rangeSoh, weight: 1.0, name: 'range' });
    if (chargingSoh !== null) validMethods.push({ soh: chargingSoh, weight: 0.9, name: 'charging' });
    if (tripSoh !== null) validMethods.push({ soh: tripSoh, weight: 0.8, name: 'trip' });

    if (validMethods.length === 0) {
      this.logger.debug(`Not enough data for SOH calculation on vehicle ${vehicleId}`);
      return;
    }

    // Weighted median across all available methods
    const rawSoh = this.weightedMedianWeighted(
      validMethods.map(m => ({ soh: m.soh, weight: m.weight })),
    );

    // Temperature correction: adjust upward if measured below 20°C
    const tempCorrectedSoh = this.applyTemperatureCorrection(rawSoh, avgTemp);

    // Below 70% = data quality issue, skip. Cap at 100% — >100 indicates wrong nominal
    // reference (new car range estimation overshoot), not a super-battery.
    const MAX_SOH = 100;
    if (tempCorrectedSoh < 70) {
      this.logger.warn(
        `SOH ${tempCorrectedSoh.toFixed(1)}% < 70% for vehicle ${vehicleId} — ` +
        `likely bad trip data or wrong nominal. Skipping record.`,
      );
      return;
    }
    const finalSoh = Math.min(MAX_SOH, Math.max(70, tempCorrectedSoh));
    const estimatedCapacity = (finalSoh / 100) * usableKwh;
    const degradation = 100 - finalSoh;

    const confidence = Math.min(1.0, validMethods.length / 3);
    const methodNames = validMethods.map(m => m.name).join('+');

    await this.prisma.batteryHealth.create({
      data: {
        vehicleId,
        sohPercent: Math.round(finalSoh * 100) / 100,
        estimatedCapacityKwh: Math.round(estimatedCapacity * 10) / 10,
        nominalCapacityKwh: usableKwh,
        degradationPercent: Math.round(degradation * 100) / 100,
        method: validMethods.length > 1 ? 'weighted_median' : methodNames,
        confidenceScore: Math.round(confidence * 100) / 100,
        sampleCount: validMethods.length,
        tripSoh: tripSoh !== null ? Math.round(Math.min(100, tripSoh) * 100) / 100 : null,
        chargingSoh: chargingSoh !== null ? Math.round(Math.min(100, chargingSoh) * 100) / 100 : null,
        ratedRangeSoh: rangeSoh !== null ? Math.round(Math.min(100, rangeSoh) * 100) / 100 : null,
        avgBatteryTempC: avgTemp,
        cycles: currentCycles != null ? Math.round(currentCycles * 10) / 10 : null,
      } as any,
    });

    this.logger.log(
      `SOH updated for vehicle ${vehicleId}: ${finalSoh.toFixed(1)}% (${estimatedCapacity.toFixed(1)}kWh), ` +
      `confidence=${confidence.toFixed(2)}, methods=[${methodNames}], ` +
      `wltp=${wltpRangeKm.toFixed(0)}km(${wltpIsFromSpec ? 'spec' : 'estimated'}), ` +
      `temp=${avgTemp ?? 'N/A'}°C, cycles=${currentCycles?.toFixed(0) ?? 'N/A'}`,
    );
  }

  /**
   * Get current battery health summary for a vehicle.
   */
  async getBatteryHealth(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleSpec: true },
    });
    if (!vehicle) return null;

    const latest = await this.prisma.batteryHealth.findFirst({
      where: { vehicleId },
      orderBy: { timestamp: 'desc' },
    });

    const nominalKwh    = vehicle.vehicleSpec?.batteryNominalKwh ?? vehicle.batteryCapacityNominal;
    const usableKwh     = vehicle.vehicleSpec?.batteryUsableKwh  ?? vehicle.batteryCapacityUsable;
    const [baseline, effectiveCycles] = await Promise.all([
      this.getEffectiveBaseline(vehicleId),
      this.getEffectiveCycles(vehicleId),
    ]);

    const baselineLocked   = baseline.locked;
    const baselineLockedAt = baseline.highKwh != null
      ? null  // lockedAt fetched separately if needed
      : null;

    // If no health record yet, return spec-based defaults
    if (!latest) {
      const qualifyingHighCount0 = await this.prisma.chargingSession.count({
        where: { vehicleId, endTime: { not: null }, endSoc: { gte: 90 }, energyAddedKwh: { gte: 1 } },
      });
      return {
        vehicleId,
        sohPercent:           100,
        estimatedCapacityKwh: usableKwh,
        nominalCapacityKwh:   nominalKwh,
        degradationPercent:   0,
        method:               'none',
        confidenceScore:      0,
        lowData:              true,
        dataQuality:          'learning' as const,
        chargesNeededForHighBaseline: Math.max(0, this.BASELINE_HIGH_MIN_SAMPLES - qualifyingHighCount0),
        qualifyingChargeSessions: qualifyingHighCount0,
        baselineLocked,
        baselineConfidence:   baseline.confidence,
        baselineHighKwh:      baseline.highKwh,
        baselineMediumKwh:    baseline.medKwh,
        baselineKwh:          baseline.effectiveKwh,
        cycles:               effectiveCycles,
        updatedAt:            null,
        vehicle: {
          model: vehicle.model,
          year:  vehicle.year,
          spec:  vehicle.vehicleSpec,
        },
      };
    }

    // Display SOH:
    //   - Baseline locked (any tier) → show exact value
    //   - No baseline yet            → cap at 100% (spec might be wrong, avoid 105% confusion)
    const rawSoh     = latest.sohPercent;
    const displaySoh = baselineLocked ? rawSoh : Math.min(100, rawSoh);
    const isEstimate = !baselineLocked; // any unconfirmed state = estimate

    // Count qualifying sessions to inform the "N more charges needed" UI.
    const qualifyingHighCount = await this.prisma.chargingSession.count({
      where: {
        vehicleId,
        endTime:       { not: null },
        endSoc:        { gte: 90 },
        energyAddedKwh: { gte: 1 },
      },
    });
    const chargesNeededForHighBaseline = Math.max(
      0,
      this.BASELINE_HIGH_MIN_SAMPLES - qualifyingHighCount,
    );

    // dataQuality: single field the frontend uses to decide what to show.
    const dataQuality: 'learning' | 'ok' | 'high' =
      baseline.confidence === 'HIGH'   ? 'high' :
      baseline.confidence === 'MEDIUM' ? 'ok'   : 'learning';

    return {
      vehicleId,
      sohPercent:           displaySoh,
      sohRaw:               rawSoh,
      isEstimate,
      dataQuality,                        // 'learning' | 'ok' | 'high'
      chargesNeededForHighBaseline,       // 0 when already locked
      qualifyingChargeSessions:           qualifyingHighCount,
      estimatedCapacityKwh: latest.estimatedCapacityKwh,
      nominalCapacityKwh:   latest.nominalCapacityKwh,
      degradationPercent:   Math.max(0, 100 - displaySoh),
      method:               latest.method,
      confidenceScore:      latest.confidenceScore,
      lowData:              latest.confidenceScore < 0.6,
      tripSoh:              latest.tripSoh,
      chargingSoh:          latest.chargingSoh,
      ratedRangeSoh:        latest.ratedRangeSoh,
      avgBatteryTempC:      latest.avgBatteryTempC,
      baselineLocked,
      baselineConfidence:   baseline.confidence,
      baselineHighKwh:      baseline.highKwh,
      baselineMediumKwh:    baseline.medKwh,
      baselineKwh:          baseline.effectiveKwh,
      cycles:               effectiveCycles ?? (latest as any).cycles,
      updatedAt:            latest.timestamp,
      vehicle: {
        model: vehicle.model,
        year:  vehicle.year,
        spec: vehicle.vehicleSpec,
      },
    };
  }

  /**
   * Returns a time-ordered list of BatteryHealth snapshots for the requested
   * window.  Each element is shaped like the full BatteryHealth response so
   * the frontend can render historical SOH charts without a bespoke type.
   *
   * The `updatedAt` field is mapped from the stored `timestamp` column.
   */
  private static readonly HISTORY_MAX_POINTS  = 1_000;
  private static readonly HISTORY_CACHE_TTL_S = 60; // seconds

  async getBatteryHealthHistory(vehicleId: string, days = 30) {
    // v1 prefix allows bumping the key version when the response schema changes,
    // making old cached entries automatically fall off without an explicit flush.
    const cacheKey = `battery:history:v1:${vehicleId}:${days}`;

    // ── Cache read ─────────────────────────────────────────────────────────
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // Redis unavailable — fall through to DB
    }

    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    // Fetch all matching rows; LTTB needs the full dataset to pick the most
    // visually significant points.  The composite index makes this fast.
    const rows = await this.prisma.batteryHealth.findMany({
      where:   { vehicleId, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });

    const max    = BatteryAnalyticsService.HISTORY_MAX_POINTS;
    const source = rows.length > max ? this.lttb(rows, max) : rows;

    const result = source.map((r) => ({
      vehicleId:            r.vehicleId,
      sohPercent:           Math.min(100, r.sohPercent),
      sohRaw:               r.sohPercent,
      degradationPercent:   r.degradationPercent,
      estimatedCapacityKwh: r.estimatedCapacityKwh,
      nominalCapacityKwh:   r.nominalCapacityKwh,
      confidenceScore:      r.confidenceScore,
      method:               r.method,
      baselineLocked:       false,
      updatedAt:            r.timestamp.toISOString(),
    }));

    // ── Cache write (fire-and-forget) ─────────────────────────────────────
    this.redis
      .set(cacheKey, JSON.stringify(result), 'EX', BatteryAnalyticsService.HISTORY_CACHE_TTL_S)
      .catch(() => { /* non-critical */ });

    return result;
  }

  /**
   * Largest-Triangle-Three-Buckets downsampler.
   *
   * Each row is treated as a 2-D point where:
   *   x = timestamp (ms since epoch)
   *   y = sohPercent
   *
   * The algorithm selects the point in each bucket that forms the largest
   * triangle area with the selected point from the previous bucket and the
   * centroid of the next bucket, preserving the visual shape of the curve.
   *
   * Reference: Sveinn Steinarsson — "Downsampling Time Series for Visual
   * Representation" (2013), https://skemman.is/handle/1946/15343
   */
  private lttb<T extends { sohPercent: number; timestamp: Date }>(
    data:   T[],
    target: number,
  ): T[] {
    const n = data.length;
    // Fast-paths: nothing to downsample, or degenerate target
    if (n <= target) return data;
    if (target <= 2) return [data[0], data[n - 1]];

    const sampled: T[] = [data[0]];
    const bucketSize   = (n - 2) / (target - 2);

    let a = 0; // index of previously selected point

    for (let i = 0; i < target - 2; i++) {
      // Boundaries of current bucket
      const lo = Math.floor((i + 1) * bucketSize) + 1;
      const hi = Math.min(Math.floor((i + 2) * bucketSize) + 1, n - 1);

      // Centroid of next bucket (used as the "far point" for area calc)
      let nextAvgX = 0;
      let nextAvgY = 0;
      const nxtLo  = hi;
      const nxtHi  = Math.min(Math.floor((i + 3) * bucketSize) + 1, n - 1);
      for (let j = nxtLo; j < nxtHi; j++) {
        nextAvgX += data[j].timestamp.getTime();
        nextAvgY += data[j].sohPercent;
      }
      const nxtCount = Math.max(1, nxtHi - nxtLo);
      nextAvgX /= nxtCount;
      nextAvgY /= nxtCount;

      const aX  = data[a].timestamp.getTime();
      const aY  = data[a].sohPercent;

      let maxArea  = -1;
      let maxIndex = lo;
      for (let j = lo; j < hi; j++) {
        const area = Math.abs(
          (aX - nextAvgX) * (data[j].sohPercent - aY) -
          (aX - data[j].timestamp.getTime()) * (nextAvgY - aY),
        );
        if (area > maxArea) { maxArea = area; maxIndex = j; }
      }

      sampled.push(data[maxIndex]);
      a = maxIndex;
    }

    sampled.push(data[n - 1]);
    return sampled;
  }

  /**
   * Get degradation trend over time.
   */
  async getDegradationTrend(vehicleId: string, days = 90) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const healthPoints = await this.prisma.batteryHealth.findMany({
      where: {
        vehicleId,
        timestamp: { gte: startDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (healthPoints.length === 0) return null;

    const latest = healthPoints[healthPoints.length - 1];
    const earliest = healthPoints[0];

    // Need at least 3 distinct days of data spread over 7+ days to compute a reliable trend.
    // With fewer points, the slope is meaningless (noise dominates).
    const MIN_TREND_SAMPLES = 3;
    const MIN_TREND_SPAN_DAYS = 7;
    const spanDays = (latest.timestamp.getTime() - earliest.timestamp.getTime()) / (1000 * 60 * 60 * 24);
    const hasTrend = healthPoints.length >= MIN_TREND_SAMPLES && spanDays >= MIN_TREND_SPAN_DAYS;

    const monthsElapsed = Math.max(spanDays / 30, 0.001);
    const degradationPerMonth = hasTrend
      ? (latest.degradationPercent - earliest.degradationPercent) / monthsElapsed
      : null;

    return {
      vehicleId,
      period: { startDate, endDate: new Date(), days },
      samples: healthPoints.length,
      hasTrend,
      latestSoh: Math.min(100, latest.sohPercent),
      latestCapacity: latest.estimatedCapacityKwh,
      latestDegradation: Math.max(0, latest.degradationPercent),
      degradationPerMonth,
      // null when hasTrend=false — frontend should show "insufficient data"
      projectedSoh1Year: hasTrend && degradationPerMonth !== null
        ? Math.max(50, Math.min(100, latest.sohPercent - degradationPerMonth * 12))
        : null,
      projectedSoh5Year: hasTrend && degradationPerMonth !== null
        ? Math.max(50, Math.min(100, latest.sohPercent - degradationPerMonth * 60))
        : null,
      data: healthPoints.map((p) => ({
        timestamp: p.timestamp,
        sohPercent: Math.min(100, p.sohPercent),
        capacity: p.estimatedCapacityKwh,
        degradation: Math.max(0, p.degradationPercent),
        method: p.method,
        confidence: p.confidenceScore,
      })),
    };
  }

  /**
   * High-level degradation forecast: current SOH and projections.
   */
  async getDegradationForecast(vehicleId: string) {
    const trend = await this.getDegradationTrend(vehicleId, 365);
    if (!trend) {
      return {
        vehicleId,
        currentSoh: 100,
        projectedSoh1Year: null,
        projectedSoh5Year: null,
        degradationPerMonth: null,
        hasTrend: false,
      };
    }

    return {
      vehicleId,
      currentSoh: trend.latestSoh,
      projectedSoh1Year: trend.projectedSoh1Year,
      projectedSoh5Year: trend.projectedSoh5Year,
      degradationPerMonth: trend.degradationPerMonth,
      hasTrend: trend.hasTrend,
    };
  }

  /**
   * Estimate charge cycles.
   */
  async getChargeCycles(vehicleId: string) {
    const sessions = await this.prisma.chargingSession.findMany({
      where: { vehicleId, endTime: { not: null }, endSoc: { not: null } },
    });

    if (sessions.length === 0) return null;

    const totalCycles = sessions.reduce((sum, session) => {
      const socChange = (session.endSoc ?? 0) - session.startSoc;
      return sum + Math.max(0, socChange) / 100;
    }, 0);

    return {
      vehicleId,
      estimatedFullCycles: Math.round(totalCycles * 100) / 100,
      totalCharges: sessions.length,
      averageSocPerCharge: Math.round(
        sessions.reduce((s, sess) => s + Math.max(0, (sess.endSoc ?? 0) - sess.startSoc), 0) / sessions.length,
      ),
    };
  }

  /**
   * Detect vampire drain (overnight SOC loss without charging).
   */
  async detectVampireDrain(vehicleId: string, hoursIdle = 8) {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const events = await this.prisma.telemetryEvent.findMany({
      where: {
        vehicleId,
        timestamp: { gte: oneWeekAgo },
        eventType: 'vehicle_sleep',
      },
      orderBy: { timestamp: 'asc' },
    });

    const drainEvents: { timestamp: Date; drain: number; drainPerHour: number }[] = [];

    for (let i = 0; i < events.length - 1; i++) {
      const start = events[i];
      const end = events[i + 1];
      const timeDiff =
        (end.timestamp.getTime() - start.timestamp.getTime()) / (1000 * 3600);

      if (timeDiff < hoursIdle) continue;

      const startSoc = (start.payloadJson as any)?.soc ?? 0;
      const endSoc = (end.payloadJson as any)?.soc ?? 0;
      const drain = startSoc - endSoc;

      if (drain > 0) {
        drainEvents.push({
          timestamp: start.timestamp,
          drain,
          drainPerHour: Math.round((drain / timeDiff) * 100) / 100,
        });
      }
    }

    if (drainEvents.length === 0) return null;

    const avgDrain =
      drainEvents.reduce((s, e) => s + e.drainPerHour, 0) / drainEvents.length;

    return {
      vehicleId,
      detectedSessions: drainEvents.length,
      averageDrainPerHour: Math.round(avgDrain * 100) / 100,
      totalDrainThisWeek: drainEvents.reduce((s, e) => s + e.drain, 0),
      events: drainEvents,
    };
  }

  // ============================================================================
  // SCHEDULED — Daily SOH recalculation for all active vehicles
  // ============================================================================

  /**
   * Daily recalculation of battery SOH for all active vehicles.
   * Runs at 03:00 UTC to avoid peak traffic hours.
   * Picks up data from the previous day's trips and charging sessions.
   */
  @Cron('0 3 * * *')
  async scheduledBatteryAnalytics(): Promise<void> {
    if (!isWorkerRole()) return;
    const vehicles = await this.prisma.vehicle.findMany({
      where: { status: 'active' },
      select: { id: true },
    });

    if (!vehicles.length) return;

    this.logger.log(`[Cron] Daily battery analytics for ${vehicles.length} vehicles`);
    let updated = 0;
    for (const vehicle of vehicles) {
      await this.updateBatteryMetrics(vehicle.id).catch((e: Error) =>
        this.logger.warn(`[Cron] Battery analytics skipped for ${vehicle.id}: ${e.message}`),
      );
      updated++;
    }
    this.logger.log(`[Cron] Battery analytics complete — updated ${updated}/${vehicles.length}`);
  }

  // ============================================================================
  // PRIVATE — BASELINE LOCK (dual-tier)
  // ============================================================================

  /**
   * Attempt to lock HIGH and/or MEDIUM baseline tiers from charging sessions.
   *
   * HIGH (endSoc ≥ 90%): BMS fully recalibrated — most accurate capacity read.
   *   Requires ≥10 sessions, stdDev < 2.5 kWh.
   *
   * MEDIUM (endSoc 70–90%): Partial charges — usable fallback, less accurate.
   *   Requires ≥15 sessions, stdDev < 3.5 kWh.
   *
   * Both tiers require: socDelta ≥ 30% (enough range for accurate extrapolation)
   *                     startSoc ≤ 60% (avoids top-of-charge-only sessions)
   *
   * Once locked a tier never changes — it becomes the permanent SOH denominator for that tier.
   */
  private async tryLockBaseline(vehicleId: string): Promise<void> {
    const current = await this.getEffectiveBaseline(vehicleId);
    // Only attempt locking the tiers that aren't locked yet
    const needHigh = current.highKwh == null;
    const needMed  = current.medKwh  == null;
    if (!needHigh && !needMed) return; // both tiers already locked

    // Fetch all candidate sessions in one query
    const allSessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        energyAddedKwh: { gt: 0 },
        endSoc:         { gte: 70 },
        startSoc:       { lte: 60 },
      },
      select: {
        energyAddedKwh: true,
        startSoc:       true,
        endSoc:         true,
        chargerType:    true,
      },
    });

    const highEst: number[] = [];
    const medEst:  number[] = [];

    for (const s of allSessions) {
      const socChange = (s.endSoc ?? 0) - s.startSoc;
      if (socChange < this.BASELINE_MIN_SOC_DELTA || !s.energyAddedKwh) continue;

      const isDc    = s.chargerType === 'supercharger' || s.chargerType === 'dc_fast';
      const eff     = isDc ? this.DC_CHARGING_EFFICIENCY : 0.90;
      const stored  = s.energyAddedKwh * eff;
      const capacity = stored / (socChange / 100);

      if (capacity < 40 || capacity > 130) continue; // physically implausible

      if ((s.endSoc ?? 0) >= 90) {
        highEst.push(capacity);
      } else {
        medEst.push(capacity);
      }
    }

    const now = new Date();

    // Try to lock HIGH tier
    if (needHigh) {
      const result = this.evaluateBaseline(highEst, this.BASELINE_HIGH_MIN_SAMPLES, this.BASELINE_HIGH_MAX_STD_DEV);
      if (result) {
        await this.prisma.$executeRaw`
          UPDATE vehicles
          SET "batteryBaselineHighKwh" = ${result.median},
              "batteryBaselineHighLockedAt" = ${now},
              "batteryCapacityBaseline" = ${result.median},
              "batteryBaselineLockedAt" = ${now}
          WHERE id = ${vehicleId}
        `;
        this.logger.log(
          `🔒 [HIGH] Baseline LOCKED for ${vehicleId}: ${result.median} kWh ` +
          `(n=${result.n}, stdDev=${result.stdDev.toFixed(2)} kWh)`,
        );
      } else {
        this.logger.debug(
          `[HIGH] Baseline not ready for ${vehicleId}: n=${highEst.length}/${this.BASELINE_HIGH_MIN_SAMPLES}`,
        );
      }
    }

    // Try to lock MEDIUM tier
    if (needMed) {
      const result = this.evaluateBaseline(medEst, this.BASELINE_MED_MIN_SAMPLES, this.BASELINE_MED_MAX_STD_DEV);
      if (result) {
        await this.prisma.$executeRaw`
          UPDATE vehicles
          SET "batteryBaselineMediumKwh" = ${result.median},
              "batteryBaselineMediumLockedAt" = ${now}
          WHERE id = ${vehicleId}
        `;
        // Also set legacy alias if HIGH not available
        if (current.highKwh == null) {
          await this.prisma.$executeRaw`
            UPDATE vehicles
            SET "batteryCapacityBaseline" = ${result.median},
                "batteryBaselineLockedAt" = ${now}
            WHERE id = ${vehicleId} AND "batteryBaselineHighKwh" IS NULL
          `;
        }
        this.logger.log(
          `🔒 [MEDIUM] Baseline LOCKED for ${vehicleId}: ${result.median} kWh ` +
          `(n=${result.n}, stdDev=${result.stdDev.toFixed(2)} kWh)`,
        );
      } else {
        this.logger.debug(
          `[MEDIUM] Baseline not ready for ${vehicleId}: n=${medEst.length}/${this.BASELINE_MED_MIN_SAMPLES}`,
        );
      }
    }
  }

  /**
   * Evaluate a set of capacity estimates for baseline locking.
   * Returns { median, stdDev, n } if criteria are met, null otherwise.
   */
  private evaluateBaseline(
    estimates: number[],
    minSamples: number,
    maxStdDev: number,
  ): { median: number; stdDev: number; n: number } | null {
    if (estimates.length < minSamples) return null;

    const sorted   = [...estimates].sort((a, b) => a - b);
    const median   = Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
    const mean     = estimates.reduce((s, v) => s + v, 0) / estimates.length;
    const variance = estimates.reduce((s, v) => s + (v - mean) ** 2, 0) / estimates.length;
    const stdDev   = Math.sqrt(variance);

    if (stdDev >= maxStdDev) return null;
    return { median, stdDev, n: estimates.length };
  }

  // ============================================================================
  // PRIVATE — SOH CALCULATION METHODS
  // ============================================================================

  /**
   * Method 1: Range-based (most accurate, TeslaMate approach)
   * Extrapolates ideal_battery_range to 100% SOC, compares against WLTP rated range.
   * Uses median over 90 days to filter outliers (temp, speed, HVAC effects).
   */
  /**
   * wltpRangeKm: pre-computed from spec or estimated at 169 Wh/km.
   * Caller supplies it so the method stays side-effect free.
   */
  private async calculateSohFromRange(vehicleId: string, wltpRangeKm: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ soc: number; rangeKm: number }>>`
      SELECT soc, "batteryRangeKm" as "rangeKm"
      FROM telemetry_points
      WHERE "vehicleId" = ${vehicleId}
        AND soc BETWEEN 50 AND 100
        AND "batteryRangeKm" IS NOT NULL
        AND "batteryRangeKm" > 10
        AND timestamp >= NOW() - INTERVAL '90 days'
      ORDER BY timestamp DESC
      LIMIT 200
    `;

    if (rows.length < 5) return null;

    const rangeAt100 = rows.map(r => (r.rangeKm / r.soc) * 100);
    const sorted = [...rangeAt100].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const soh = (median / wltpRangeKm) * 100;

    if (soh < 50 || soh > 130) return null;
    return soh;
  }

  /**
   * Method 3: Consumption-based (Trip energy)
   * capacity = energy_used / (soc_drop / 100)
   * soh = capacity / nominal * 100
   *
   * Quality filters:
   * - SOC drop > 20%
   * - Distance > 20 km
   * - Result within [50%, 110%] of nominal
   */
  private async calculateSohFromTrips(vehicleId: string, nominalKwh: number): Promise<number | null> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        startTime: { gte: thirtyDaysAgo },
        endTime: { not: null },
        energyUsedKwh: { gt: 0 },
        endSoc: { not: null },
      },
    });

    const validCapacities: number[] = [];

    for (const trip of trips) {
      const socDrop = trip.startSoc - (trip.endSoc ?? 0);

      // Hard physics filters: SOC drop must be meaningful, distance sufficient
      if (socDrop < 20 || !trip.energyUsedKwh) continue;

      // Multi-filter: reject physically impossible / corrupted trips
      if (!isValidTrip(trip)) continue;

      const estimatedCapacity = trip.energyUsedKwh / (socDrop / 100);
      const soh = (estimatedCapacity / nominalKwh) * 100;

      // Discard physically impossible SOH values
      if (soh < 50 || soh > 110) continue;

      validCapacities.push(soh);
    }

    if (validCapacities.length < 2) return null;

    return this.weightedMedian(validCapacities);
  }

  /**
   * Method 2: Energy Capacity (Charging sessions)
   * capacity = energy_added * efficiency / (soc_change / 100)
   * soh = capacity / nominal * 100
   *
   * Quality filters:
   * - SOC change > 10%
   * - Cycle filtering: 20% < SOC_delta (avoids BMS buffer zones at very low SOC)
   *   Full charges (ending ≥ 95%) are always included — BMS calibrated and reliable.
   * - DC charging efficiency applied: billing energy ≠ stored energy (93% efficiency)
   * - Result within [50%, 110%] of nominal
   */
  private async calculateSohFromCharging(vehicleId: string, nominalKwh: number): Promise<number | null> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        startTime: { gte: thirtyDaysAgo },
        endTime: { not: null },
        energyAddedKwh: { gt: 0 },
        endSoc: { not: null },
      },
    });

    const validCapacities: { soh: number; weight: number }[] = [];

    for (const session of sessions) {
      const socChange = (session.endSoc ?? 0) - session.startSoc;
      if (socChange < 10 || !session.energyAddedKwh) continue;

      // Skip very small SOC deltas (BMS buffer zone noise)
      if (socChange <= 20) {
        this.logger.debug(
          `Skipping charging session (SOC ${session.startSoc}% → ${session.endSoc}%): delta too small (${socChange}%)`,
        );
        continue;
      }

      // Tesla BMS reports battery-side energy. DC_CHARGING_EFFICIENCY = 1.0 for BMS data.
      // chargerType check kept for future non-BMS data sources.
      const isDc = session.chargerType === 'tesla_sc'
        || session.chargerType === 'dc_fast'
        || session.chargerType === 'ccs'
        || session.chargerType === 'supercharger';
      const storedEnergy = isDc
        ? session.energyAddedKwh * this.DC_CHARGING_EFFICIENCY
        : session.energyAddedKwh;

      const estimatedCapacity = storedEnergy / (socChange / 100);
      const soh = (estimatedCapacity / nominalKwh) * 100;

      if (soh < 50 || soh > 110) continue;

      // Sessions ending at full charge (BMS recalibrated) get higher weight
      const weight = (session.endSoc ?? 0) >= 90 ? 2.0 : 1.0;
      validCapacities.push({ soh, weight });
    }

    if (validCapacities.length < 2) return null;

    return this.weightedMedianWeighted(validCapacities);
  }

  /**
   * Apply temperature correction to SOH estimate.
   * At low temperatures, capacity appears lower; we correct upward.
   */
  private applyTemperatureCorrection(soh: number, avgTempC: number | null): number {
    if (avgTempC === null) return soh;

    if (avgTempC < this.TEMP_REFERENCE_C) {
      const deltaDegrees = this.TEMP_REFERENCE_C - avgTempC;
      const correction = deltaDegrees * this.TEMP_CORRECTION_PER_DEGREE * 100;
      return soh + correction;
    }

    return soh;
  }

  /**
   * Get average battery temperature from the last 30 days of telemetry.
   */
  private async getRecentAvgBatteryTemp(vehicleId: string): Promise<number | null> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const points = await this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        timestamp: { gte: thirtyDaysAgo },
        batteryTemp: { not: null },
      },
      select: { batteryTemp: true },
      take: 1000,
    });

    if (points.length === 0) return null;

    const sum = points.reduce((s, p) => s + (p.batteryTemp ?? 0), 0);
    return Math.round((sum / points.length) * 10) / 10;
  }

  /**
   * Compute the median of an array.
   */
  private weightedMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Compute weighted median: sort by value, then pick the item at the
   * cumulative-weight midpoint.
   */
  private weightedMedianWeighted(items: { soh: number; weight: number }[]): number {
    const sorted = [...items].sort((a, b) => a.soh - b.soh);
    const totalWeight = sorted.reduce((s, i) => s + i.weight, 0);
    const halfWeight = totalWeight / 2;

    let cumulative = 0;
    for (const item of sorted) {
      cumulative += item.weight;
      if (cumulative >= halfWeight) return item.soh;
    }

    return sorted[sorted.length - 1].soh;
  }
}
