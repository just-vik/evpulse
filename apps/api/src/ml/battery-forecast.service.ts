import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';

const CACHE_TTL_SEC = 3_600; // battery trend changes slowly — cache 1 h

/**
 * BatteryForecastService
 *
 * Projects battery capacity degradation using linear regression on the
 * existing BatteryHealth time-series. EMA smoothing removes measurement noise
 * before fitting the trend line.
 *
 * Returns: current capacity, 30-day & 1-year forecast, degradation rate.
 */
@Injectable()
export class BatteryForecastService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async forecast(vehicleId: string): Promise<{
    currentCapacityKwh: number;
    forecast30dKwh:     number;
    forecast365dKwh:    number;
    degradationPctPerYear: number;
    currentSohPct:      number;
    sampleCount:        number;
    dataSpanDays:       number;
    trend: 'stable' | 'slow_decline' | 'fast_decline';
  } | null> {
    const cacheKey = `ml:battery:${vehicleId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const history = await this.prisma.batteryHealth.findMany({
      where:   { vehicleId },
      orderBy: { timestamp: 'asc' },
      select:  { timestamp: true, estimatedCapacityKwh: true },
    });

    // Need at least 5 data points for a meaningful regression
    if (history.length < 5) return null;

    // Filter out clearly erroneous readings (0 kWh, > 120 kWh)
    const clean = history.filter(h => h.estimatedCapacityKwh > 10 && h.estimatedCapacityKwh < 120);
    if (clean.length < 5) return null;

    // EMA smoothing — alpha=0.25 gives moderate responsiveness
    const rawCapacity = clean.map(h => h.estimatedCapacityKwh);
    const smoothed    = this.ema(rawCapacity, 0.25);

    // Linear regression on smoothed series (slope = kWh per measurement)
    const n    = smoothed.length;
    const x    = smoothed.map((_, i) => i);
    const y    = smoothed;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi)    => sum + xi * xi, 0);
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;

    // Measurement frequency (samples per day)
    const daySpan = (
      clean[n - 1].timestamp.getTime() - clean[0].timestamp.getTime()
    ) / 86_400_000;
    const samplesPerDay = n / Math.max(daySpan, 1);

    const currentCapacity = smoothed[n - 1];

    const [nominalKwh, actualCycles] = await Promise.all([
      this.getNominal(vehicleId),
      this.getActualCycles(vehicleId),
    ]);

    const forecast30d  = currentCapacity + slope * (samplesPerDay * 30);

    // Two-phase degradation model:
    // Phase 1 (early life, < 200 full cycles): fast SEI layer growth
    // Phase 2 (mature, 200–800): linear slow decline
    // Phase 3 (aged, > 800): accelerating again (electrolyte depletion)
    // Use real cycle count from batteryCyclesTotal, or estimate from data span as fallback.
    const cycles     = actualCycles ?? daySpan * 0.5;
    const phaseSlope = cycles < 200  ? slope * 1.5   // early-life: faster than trend
                     : cycles < 800  ? slope * 0.8   // mature: trend overstates
                     :                 slope * 1.2;   // aged: accelerating again

    const forecast365d = currentCapacity + phaseSlope * (samplesPerDay * 365);

    const degradationPctPerYear =
      Math.abs(slope) * samplesPerDay * 365 / nominalKwh * 100;

    const trend: 'stable' | 'slow_decline' | 'fast_decline' =
      degradationPctPerYear < 1   ? 'stable'
      : degradationPctPerYear < 3 ? 'slow_decline'
      : 'fast_decline';

    const result = {
      currentCapacityKwh:    Math.round(currentCapacity * 10) / 10,
      forecast30dKwh:        Math.round(Math.max(forecast30d,  0) * 10) / 10,
      forecast365dKwh:       Math.round(Math.max(forecast365d, 0) * 10) / 10,
      degradationPctPerYear: Math.round(degradationPctPerYear * 10) / 10,
      currentSohPct:         Math.round((currentCapacity / nominalKwh) * 1000) / 10,
      sampleCount:           n,
      dataSpanDays:          Math.round(daySpan),
      trend,
    };

    await (this.redis as any).set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SEC);
    return result;
  }

  // Exponential Moving Average — removes measurement noise before regression
  private ema(values: number[], alpha = 0.25): number[] {
    if (!values.length) return [];
    const result = [values[0]];
    for (let i = 1; i < values.length; i++) {
      result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
    }
    return result;
  }

  private async getNominal(vehicleId: string): Promise<number> {
    const v = await this.prisma.vehicle.findUnique({
      where:   { id: vehicleId },
      include: { vehicleSpec: true },
    });
    // Prefer locked baseline → detected → spec
    return (
      (v as any)?.batteryCapacityBaseline ??
      (v as any)?.batteryCapacityDetected ??
      v?.vehicleSpec?.batteryUsableKwh ??
      75
    );
  }

  private async getActualCycles(vehicleId: string): Promise<number | null> {
    const v = await this.prisma.vehicle.findUnique({
      where:  { id: vehicleId },
      select: { batteryCyclesTotal: true, batteryCycleChargeTotal: true } as any,
    });
    if (!v) return null;
    const d = (v as any).batteryCyclesTotal      as number | null;
    const c = (v as any).batteryCycleChargeTotal as number | null;
    // Average of drive + charge sources when both available; else use either
    if (d != null && c != null) return (d + c) / 2;
    return d ?? c ?? null;
  }
}
