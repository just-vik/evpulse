import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { PrismaService } from '../prisma/prisma.service';
import { isValidTrip } from './trip-validator';

type DrivingMode = 'city' | 'highway' | 'mixed';

// Cache TTL by vehicle state
const TTL_MOVING_SEC = 5;
const TTL_PARKED_SEC = 60;

// Minimum trips required per mode for context-specific prediction
const MIN_TRIPS_PER_MODE = 4;

/**
 * RangePredictorService
 *
 * Context-aware range prediction using real trip history.
 * Improvements over v1:
 *   - Context-aware mode partitioning (city / highway / mixed)
 *   - Non-linear step-function temperature factor
 *   - Physics-based elevation penalty (0.3 Wh per metre of climb)
 *   - Driver aggressiveness profile derived from recent trip history
 *   - Confidence score as numeric 0–1 (not just high/med/low string)
 *   - Adaptive cache TTL: 5 s while moving, 60 s while parked
 */
@Injectable()
export class RangePredictorService {
  private readonly logger = new Logger(RangePredictorService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async predict(
    vehicleId: string,
    currentSoc: number,
    context?: { speedKmh?: number; tempC?: number },
  ): Promise<{
    rangeKm: number;
    efficiencyWhKm: number;
    basedOnTrips: number;
    confidence: 'high' | 'medium' | 'low';
    confidenceScore: number;
    drivingMode: DrivingMode;
    tempC: number | null;
    batteryKwh: number;
  } | null> {
    const speedKmh = context?.speedKmh;
    const mode     = this.inferMode(speedKmh);
    const isMoving = speedKmh != null && speedKmh > 5;

    const cacheKey = `ml:range:${vehicleId}:${Math.round(currentSoc)}:${mode}`;
    const cached   = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Fetch last 40 trips — wider pool so mode-filtered slice stays large enough
    const rawTrips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        distanceKm:      { gt: 5 },
        efficiencyWhkm:  { not: null },
        endTime:         { not: null },
      },
      orderBy: { startTime: 'desc' },
      take:    40,
      include: { stats: true },
    });

    if (rawTrips.length < 3) return null;

    // Multi-filter: remove physically impossible / corrupted trips before any ML
    const allTrips = rawTrips.filter(isValidTrip);
    if (allTrips.length < 3) return null;

    // Try to use mode-specific subset; fall back to full pool
    const modeTrips = allTrips.filter(t => this.tripMode(t.stats?.avgSpeed) === mode);
    const trips     = modeTrips.length >= MIN_TRIPS_PER_MODE ? modeTrips : allTrips;

    const vehicle = await this.prisma.vehicle.findUnique({
      where:   { id: vehicleId },
      include: { vehicleSpec: true },
    });
    const batteryKwh: number =
      (vehicle as any)?.batteryCapacityDetected ??
      vehicle?.vehicleSpec?.batteryUsableKwh ??
      75;

    const tempC       = context?.tempC ?? (await this.getRecentTemp(vehicleId));
    const batteryTempC = await this.getRecentBatteryTemp(vehicleId);

    // Driver profile: ratio of recent median efficiency to mode baseline
    const driverFactor = await this.driverAggressiveness(vehicleId, allTrips);

    const tempMult = this.tempFactor(tempC);
    let score = 0, totalWeight = 0, weight = 1.0;

    for (const trip of trips) {
      const baseEff = trip.efficiencyWhkm!;
      let modifier  = 1.0;

      // ── Speed modifier (mode-aware) ──────────────────────────────────
      const avgSpeed = trip.stats?.avgSpeed ?? 60;
      if      (avgSpeed > 120) modifier *= 1.35;
      else if (avgSpeed > 110) modifier *= 1.22;
      else if (avgSpeed > 90)  modifier *= 1.10;
      else if (avgSpeed < 40)  modifier *= 0.90;
      else if (avgSpeed < 55)  modifier *= 0.95;

      // ── Aerodynamic drag: drag ∝ speed² ──────────────────────────────
      // At 130 km/h → +8% over baseline (100 km/h reference)
      modifier *= 1 + Math.pow(avgSpeed / 100, 2) * 0.08;

      // ── Temperature (non-linear step function) ──────────────────────
      modifier *= tempMult;

      // ── Elevation (physics: ~0.3 Wh per metre of climb) ─────────────
      const elevGainM    = trip.stats?.elevationGain ?? 0;
      const distKm       = trip.distanceKm!;
      const elevWhPerKm  = distKm > 0 ? (elevGainM * 0.3) / distKm : 0;
      modifier           += elevWhPerKm / Math.max(baseEff, 100); // fractional increase

      score       += (baseEff * modifier) * weight;
      totalWeight += weight;
      weight      *= 0.88; // recency decay
    }

    let predictedEffWhKm = score / totalWeight;

    // Apply driver aggressiveness factor: aggressive drivers use more energy
    predictedEffWhKm *= 1 + driverFactor * 0.25;

    // Battery temperature correction (separate from ambient air temp):
    //   Cold pack (<10°C): internal resistance rises → more energy lost as heat
    //   Hot pack (>40°C): BMS limits power to protect cells → less regen captured
    if (batteryTempC != null) {
      if (batteryTempC < 10) predictedEffWhKm *= 1.10;
      else if (batteryTempC > 40) predictedEffWhKm *= 1.08;
    }

    // SOC nonlinearity: battery delivers less useful energy at the extremes
    //   >80 %  SOC: BMS buffer + regen limited  → -8 % effective capacity
    //   >60 %  SOC: normal range                → -3 % (slight taper)
    //   20–60 % SOC: full linear range          → baseline
    //   <20 %  SOC: voltage sag, safety buffer  → -15 % effective capacity
    const socFactor =
      currentSoc > 80 ? 0.92 :
      currentSoc > 60 ? 0.97 :
      currentSoc > 20 ? 1.00 :
      0.85;

    const usableKwh = batteryKwh * (currentSoc / 100) * socFactor;
    const rangeKm   = (usableKwh * 1000) / predictedEffWhKm;

    const confidenceScore = Math.min(0.95, 0.5 + (trips.length / 40) * 0.45);
    const confidence: 'high' | 'medium' | 'low' =
      confidenceScore >= 0.80 ? 'high'
      : confidenceScore >= 0.60 ? 'medium'
      : 'low';

    const result = {
      rangeKm:         Math.round(rangeKm),
      efficiencyWhKm:  Math.round(predictedEffWhKm),
      basedOnTrips:    trips.length,
      confidence,
      confidenceScore: Math.round(confidenceScore * 100) / 100,
      drivingMode:     mode,
      tempC,
      batteryKwh,
    };

    const ttl = isMoving ? TTL_MOVING_SEC : TTL_PARKED_SEC;
    await (this.redis as any).set(cacheKey, JSON.stringify(result), 'EX', ttl);
    return result;
  }

  /**
   * Lightweight live prediction — used by TripEngineV2 for real-time WebSocket events.
   */
  async predictLive(vehicleId: string, soc: number, speedKmh: number): Promise<number | null> {
    if (soc <= 0) return null;
    try {
      const result = await this.predict(vehicleId, soc, { speedKmh });
      return result?.rangeKm ?? null;
    } catch {
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Infer driving mode from current speed */
  private inferMode(speedKmh?: number): DrivingMode {
    if (speedKmh == null)   return 'mixed';
    if (speedKmh < 45)      return 'city';
    if (speedKmh > 85)      return 'highway';
    return 'mixed';
  }

  /** Categorise a trip by its average speed */
  private tripMode(avgSpeed?: number | null): DrivingMode {
    if (avgSpeed == null)   return 'mixed';
    if (avgSpeed < 50)      return 'city';
    if (avgSpeed > 90)      return 'highway';
    return 'mixed';
  }

  /**
   * Non-linear temperature factor (step function).
   * Returns a multiplier > 1 that increases predicted Wh/km in cold weather.
   *   >20°C → 1.00 (no penalty)
   *   10–20°C → 1.05 (+5 %)
   *    0–10°C → 1.15 (+15 %)
   *  -10–0°C  → 1.30 (+30 %)
   *   <-10°C  → 1.40 (+40 %)
   */
  private tempFactor(tempC: number | null): number {
    if (tempC == null) return 1.0;
    if (tempC > 20)    return 1.0;
    if (tempC > 10)    return 1.05;
    if (tempC > 0)     return 1.15;
    if (tempC > -10)   return 1.30;
    return 1.40;
  }

  /**
   * Driver aggressiveness scalar 0–1.
   * Computes median efficiency of the most recent 10 trips vs a baseline of
   * 170 Wh/km (typical Model Y LR highway). A driver consistently above baseline
   * gets a positive scalar that inflates the predicted Wh/km.
   */
  private async driverAggressiveness(
    vehicleId: string,
    recentTrips: { efficiencyWhkm: number | null }[],
  ): Promise<number> {
    const BASELINE_WH_KM = 170;
    const efficiencies = recentTrips
      .slice(0, 10)
      .map(t => t.efficiencyWhkm)
      .filter((e): e is number => e != null);

    if (efficiencies.length < 3) return 0;

    const sorted = [...efficiencies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Positive → aggressive (above baseline), clamped [0, 1]
    const ratio = (median - BASELINE_WH_KM) / BASELINE_WH_KM;
    return Math.min(1, Math.max(0, ratio));
  }

  private async getRecentTemp(vehicleId: string): Promise<number | null> {
    const p = await this.prisma.telemetryPoint.findFirst({
      where:   { vehicleId, outsideTemp: { not: null } },
      orderBy: { timestamp: 'desc' },
      select:  { outsideTemp: true },
    });
    return p?.outsideTemp ?? null;
  }

  private async getRecentBatteryTemp(vehicleId: string): Promise<number | null> {
    const p = await this.prisma.telemetryPoint.findFirst({
      where:   { vehicleId, batteryTemp: { not: null } },
      orderBy: { timestamp: 'desc' },
      select:  { batteryTemp: true },
    });
    return p?.batteryTemp ?? null;
  }
}
