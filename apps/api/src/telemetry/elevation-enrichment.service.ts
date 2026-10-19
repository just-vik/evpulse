import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { isWorkerRole } from '../runtime/runtime-role';

interface ElevationResult {
  elevation: number;
}

const VEHICLE_MASS_KG = 2200;

/**
 * Backfills elevationM on telemetry_points that have lat/lng but no elevation.
 *
 * API: resolves from ELEVATION_API_URL env var. Default: public Open-Elevation.
 * Self-hosted: set to http://tesla-opentopodata:5000/v1/srtm (same POST schema).
 *
 * After a successful batch, re-calculates trip_stats.elevationGain and
 * trips.efficiencyWhkm (terrain-corrected) for every trip whose points
 * were just enriched — fixing the architectural gap where in-memory buffer
 * points had no elevation at trip-close time.
 *
 * 429 handling: exponential backoff starting at 2 min, doubling up to 1 hour.
 * Resets to baseline on any successful response.
 */
@Injectable()
export class ElevationEnrichmentService {
  private readonly logger = new Logger(ElevationEnrichmentService.name);
  private readonly BATCH_SIZE = 100;
  private readonly apiUrl: string;

  // ── 429 backoff state (singleton, resets on worker restart) ────────────────
  private backoffUntil: Date | null = null;
  private backoffMs = 2 * 60_000;
  private readonly MAX_BACKOFF_MS = 60 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) {
    this.apiUrl =
      process.env.ELEVATION_API_URL ??
      'https://api.open-elevation.com/api/v1/lookup';
  }

  @Cron('0 */5 * * * *') // every 5 minutes
  async enrichPendingPoints(): Promise<void> {
    if (!isWorkerRole()) return;
    if (this.backoffUntil && new Date() < this.backoffUntil) return;

    try {
      const points = await this.prisma.$queryRaw<
        { id: string; vehicleId: string; timestamp: Date; latitude: number; longitude: number }[]
      >`
        SELECT id, "vehicleId", timestamp, latitude, longitude
        FROM telemetry_points
        WHERE latitude  IS NOT NULL
          AND longitude IS NOT NULL
          AND "elevationM" IS NULL
          AND timestamp > NOW() - INTERVAL '30 days'
        ORDER BY timestamp DESC
        LIMIT ${this.BATCH_SIZE}
      `;

      if (!points.length) return;

      const locations = points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));

      const res = await firstValueFrom(
        this.http.post<{ results: ElevationResult[] }>(
          this.apiUrl,
          { locations },
          { timeout: 15_000 },
        ),
      );

      const results = res.data?.results;
      if (!Array.isArray(results) || results.length !== points.length) {
        this.logger.warn(
          `Elevation API returned ${results?.length ?? 0} results for ${points.length} points`,
        );
        return;
      }

      const enriched: typeof points = [];
      for (let i = 0; i < points.length; i++) {
        const elev = results[i]?.elevation;
        if (elev == null || !Number.isFinite(elev)) continue;
        await this.prisma.$executeRaw`
          UPDATE telemetry_points SET "elevationM" = ${elev} WHERE id = ${points[i].id}
        `;
        enriched.push(points[i]);
      }

      if (enriched.length > 0) {
        this.logger.log(
          `Elevation enriched: ${enriched.length}/${points.length} points`,
        );
        this.backoffMs = 2 * 60_000;
        this.backoffUntil = null;

        await this.recomputeAffectedTrips(enriched).catch((e: Error) =>
          this.logger.warn(`Trip elevation recompute failed: ${e.message}`),
        );
      }
    } catch (err: any) {
      const status: number = err.response?.status ?? 0;
      if (status === 429 || err.message?.includes('429')) {
        this.backoffUntil = new Date(Date.now() + this.backoffMs);
        this.logger.warn(
          `Elevation API 429 — backoff ${this.backoffMs / 60_000} min until ${this.backoffUntil.toISOString()}`,
        );
        this.backoffMs = Math.min(this.backoffMs * 2, this.MAX_BACKOFF_MS);
      } else {
        this.logger.warn(`Elevation enrichment failed: ${err.message}`);
      }
    }
  }

  // ── Trip stats recompute ────────────────────────────────────────────────────

  private async recomputeAffectedTrips(
    enriched: { vehicleId: string; timestamp: Date }[],
  ): Promise<void> {
    const vehicleIds = [...new Set(enriched.map((p) => p.vehicleId))];
    const minTs = enriched.reduce(
      (m, p) => (p.timestamp < m ? p.timestamp : m),
      enriched[0].timestamp,
    );
    const maxTs = enriched.reduce(
      (m, p) => (p.timestamp > m ? p.timestamp : m),
      enriched[0].timestamp,
    );

    for (const vehicleId of vehicleIds) {
      const trips = await this.prisma.$queryRaw<
        { id: string; startTime: Date; endTime: Date; energyUsedKwh: number | null; distanceKm: number | null }[]
      >`
        SELECT id, "startTime", "endTime", "energyUsedKwh", "distanceKm"
        FROM trips
        WHERE "vehicleId" = ${vehicleId}
          AND "endTime"   IS NOT NULL
          AND "startTime" <= ${maxTs}
          AND "endTime"   >= ${minTs}
      `;

      for (const trip of trips) {
        await this.recomputeTripElevation(vehicleId, trip).catch(() => {});
      }
    }
  }

  private async recomputeTripElevation(
    vehicleId: string,
    trip: {
      id: string;
      startTime: Date;
      endTime: Date;
      energyUsedKwh: number | null;
      distanceKm: number | null;
    },
  ): Promise<void> {
    const pts = await this.prisma.$queryRaw<{ elevationM: number }[]>`
      SELECT "elevationM"
      FROM telemetry_points
      WHERE "vehicleId" = ${vehicleId}
        AND timestamp   >= ${trip.startTime}
        AND timestamp   <= ${trip.endTime}
        AND "elevationM" IS NOT NULL
      ORDER BY timestamp ASC
    `;

    if (pts.length < 2) return;

    let elevationGain = 0;
    for (let i = 1; i < pts.length; i++) {
      const delta = pts[i].elevationM - pts[i - 1].elevationM;
      if (delta > 0) elevationGain += delta;
    }

    await this.prisma.$executeRaw`
      UPDATE trip_stats SET "elevationGain" = ${Math.round(elevationGain)}
      WHERE "tripId" = ${trip.id}
    `;

    // Terrain-corrected efficiency (net elevation, not cumulative gain)
    const netElevM = pts[pts.length - 1].elevationM - pts[0].elevationM;
    if (trip.energyUsedKwh != null && trip.distanceKm != null && trip.distanceKm > 0) {
      const elevEnergyKwh = +(VEHICLE_MASS_KG * 9.81 * netElevM / 3_600_000).toFixed(4);
      const flatEnergy = Math.max(0.01, trip.energyUsedKwh - elevEnergyKwh);
      const corrected = Math.round((flatEnergy * 1000 / trip.distanceKm) * 10) / 10;
      if (corrected > 0 && corrected <= 600) {
        await this.prisma.$executeRaw`
          UPDATE trips
          SET "efficiencyWhkm" = ${corrected}
          WHERE id = ${trip.id}
            AND (
              "efficiencyWhkm" IS NULL
              OR ABS("efficiencyWhkm" - ${corrected}) > 1.0
            )
        `;
      }
    }
  }
}
