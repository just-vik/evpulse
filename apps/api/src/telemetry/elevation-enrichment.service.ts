import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { isWorkerRole } from '../runtime/runtime-role';

interface ElevationResult {
  latitude: number;
  longitude: number;
  elevation: number;
}

/**
 * Backfills elevationM on telemetry_points that have lat/lng but no elevation.
 * Uses the free Open-Elevation API (https://api.open-elevation.com).
 * Runs every 5 minutes, processes up to 100 points per run.
 */
@Injectable()
export class ElevationEnrichmentService {
  private readonly logger = new Logger(ElevationEnrichmentService.name);
  private readonly API_URL = 'https://api.open-elevation.com/api/v1/lookup';
  private readonly BATCH_SIZE = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
  ) {}

  @Cron('0 */5 * * * *') // every 5 minutes
  async enrichPendingPoints(): Promise<void> {
    if (!isWorkerRole()) return;
    try {
      // Find recent points with coords but no elevation
      const points = await this.prisma.$queryRaw<
        { id: string; latitude: number; longitude: number }[]
      >`
        SELECT id, latitude, longitude
        FROM telemetry_points
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND "elevationM" IS NULL
          AND timestamp > NOW() - INTERVAL '30 days'
        ORDER BY timestamp DESC
        LIMIT ${this.BATCH_SIZE}
      `;

      if (!points.length) return;

      const locations = points.map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
      }));

      const res = await firstValueFrom(
        this.http.post<{ results: ElevationResult[] }>(
          this.API_URL,
          { locations },
          { timeout: 15_000 },
        ),
      );

      const results = res.data?.results;
      if (!Array.isArray(results) || results.length !== points.length) {
        this.logger.warn(`Elevation API returned ${results?.length} results for ${points.length} points`);
        return;
      }

      let updated = 0;
      for (let i = 0; i < points.length; i++) {
        const elev = results[i]?.elevation;
        if (elev == null || !Number.isFinite(elev)) continue;
        await this.prisma.$executeRaw`
          UPDATE telemetry_points SET "elevationM" = ${elev} WHERE id = ${points[i].id}
        `;
        updated++;
      }

      if (updated > 0) {
        this.logger.log(`Elevation enriched: ${updated}/${points.length} points`);
      }
    } catch (err: any) {
      this.logger.warn(`Elevation enrichment failed: ${err.message}`);
    }
  }
}
