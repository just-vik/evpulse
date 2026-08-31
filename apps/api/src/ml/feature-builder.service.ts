import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TripFeatures {
  tripId:              string;
  avgSpeedKmh:         number;
  maxSpeedKmh:         number;
  cityRatio:           number;   // fraction of points with speed < 50 km/h
  highwayRatio:        number;   // fraction of points with speed > 80 km/h
  elevationGainM:      number;
  tempAvgC:            number | null;
  distanceKm:          number;
  energyKwh:           number | null;
  efficiencyWhKm:      number | null;
  durationMin:         number;
  // Extended features — driving style
  accelerationVariance: number;  // variance of Δspeed between consecutive points
  stopCount:           number;   // number of full stops (speed = 0 after being in motion)
  idleTimeRatio:       number;   // fraction of duration where speed = 0
  regenRatio:          number;   // fraction of points where power < 0 (regen braking active)
  jerk:                number;   // avg |Δacceleration| — smoothness of acceleration changes
  speedStability:      number;   // std(speed) — lower = more cruise-like driving
}

/**
 * FeatureBuilderService
 *
 * Extracts ML-ready features from a completed trip.
 * Called by TripDetectorService after finalization.
 *
 * Features are designed for:
 *   • Range prediction context correction
 *   • Driving style classification (city vs highway, aggressive vs efficient)
 *   • Efficiency model training
 *
 * Results are NOT persisted — downstream services receive features directly
 * or via the calling context.
 */
@Injectable()
export class FeatureBuilderService {
  private readonly logger = new Logger(FeatureBuilderService.name);

  constructor(private readonly prisma: PrismaService) {}

  async buildForTrip(tripId: string): Promise<TripFeatures | null> {
    const trip = await this.prisma.trip.findUnique({
      where:   { id: tripId },
      include: { stats: true },
    });
    if (!trip || !trip.endTime) return null;

    // Sample up to 200 points; include power for regen detection
    const points = await this.prisma.tripPoint.findMany({
      where:   { tripId },
      orderBy: { timestamp: 'asc' },
      take:    200,
      select:  { speed: true, latitude: true, longitude: true, soc: true, timestamp: true, power: true },
    });

    const tempAvgC = await this.getTripAvgTemp(trip.vehicleId, trip.startTime, trip.endTime);

    const speeds = points.map(p => p.speed).filter((s): s is number => s != null);
    const total  = speeds.length || 1;

    const cityPts    = speeds.filter(s => s < 50).length;
    const highwayPts = speeds.filter(s => s > 80).length;

    const avgSpeedKmh = speeds.length
      ? speeds.reduce((a, b) => a + b, 0) / speeds.length
      : trip.stats?.avgSpeed ?? 0;

    const maxSpeedKmh = speeds.length
      ? Math.max(...speeds)
      : trip.stats?.maxSpeed ?? 0;

    const durationMin = trip.endTime
      ? (trip.endTime.getTime() - trip.startTime.getTime()) / 60_000
      : 0;

    // ── Extended features ─────────────────────────────────────────────

    // Acceleration variance + jerk (Δacceleration)
    let accelVariance = 0;
    let jerk          = 0;
    if (speeds.length > 2) {
      const deltas    = speeds.slice(1).map((s, i) => s - speeds[i]); // signed Δspeed
      const absDelta  = deltas.map(Math.abs);
      const meanDelta = absDelta.reduce((a, b) => a + b, 0) / absDelta.length;
      accelVariance   = Math.round(
        absDelta.reduce((s, d) => s + (d - meanDelta) ** 2, 0) / absDelta.length * 100,
      ) / 100;

      // Jerk = avg |Δacceleration| = avg |Δ(Δspeed)| between consecutive pairs
      if (deltas.length > 1) {
        const jerkVals = deltas.slice(1).map((d, i) => Math.abs(d - deltas[i]));
        jerk = Math.round((jerkVals.reduce((a, b) => a + b, 0) / jerkVals.length) * 100) / 100;
      }
    }

    // Speed stability: std(speed) — lower = more consistent cruise-like driving
    let speedStability = 0;
    if (speeds.length > 1) {
      const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      speedStability  = Math.round(
        Math.sqrt(speeds.reduce((s, v) => s + (v - meanSpeed) ** 2, 0) / speeds.length) * 10,
      ) / 10;
    }

    // Stop count: transitions from speed > 2 → speed = 0
    let stopCount = 0;
    for (let i = 1; i < speeds.length; i++) {
      if (speeds[i] === 0 && speeds[i - 1] > 2) stopCount++;
    }

    // Idle time ratio: fraction of points where speed = 0
    const idlePoints    = speeds.filter(s => s === 0).length;
    const idleTimeRatio = Math.round((idlePoints / total) * 100) / 100;

    // Regen ratio: fraction of points where power < 0 (regenerative braking)
    const powers     = points.map(p => (p as any).power).filter((pw: unknown) => pw != null) as number[];
    const regenPts   = powers.filter(pw => pw < 0).length;
    const regenRatio = powers.length > 0
      ? Math.round((regenPts / powers.length) * 100) / 100
      : 0;

    const features: TripFeatures = {
      tripId,
      avgSpeedKmh:         Math.round(avgSpeedKmh * 10) / 10,
      maxSpeedKmh:         Math.round(maxSpeedKmh * 10) / 10,
      cityRatio:           Math.round((cityPts  / total) * 100) / 100,
      highwayRatio:        Math.round((highwayPts / total) * 100) / 100,
      elevationGainM:      trip.stats?.elevationGain ?? 0,
      tempAvgC,
      distanceKm:          trip.distanceKm ?? 0,
      energyKwh:           trip.energyUsedKwh ?? null,
      efficiencyWhKm:      trip.efficiencyWhkm ?? null,
      durationMin:         Math.round(durationMin),
      accelerationVariance: accelVariance,
      stopCount,
      idleTimeRatio,
      regenRatio,
      jerk,
      speedStability,
    };

    this.logger.debug(
      `[Features] trip=${tripId} speed=${features.avgSpeedKmh}km/h ` +
      `city=${features.cityRatio} hwy=${features.highwayRatio} ` +
      `eff=${features.efficiencyWhKm}Wh/km stops=${stopCount} regen=${regenRatio} jerk=${jerk} σspd=${speedStability}`,
    );

    return features;
  }

  private async getTripAvgTemp(
    vehicleId: string,
    start: Date,
    end: Date,
  ): Promise<number | null> {
    const result = await this.prisma.telemetryPoint.aggregate({
      where: {
        vehicleId,
        timestamp:   { gte: start, lte: end },
        outsideTemp: { not: null },
      },
      _avg: { outsideTemp: true },
    });
    return result._avg.outsideTemp ?? null;
  }
}
