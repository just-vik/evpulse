import { Controller, Get, Post, Param, UseGuards, Request, Query, Body, NotFoundException } from '@nestjs/common';

/** Google-encoded polyline → [lng, lat] pairs (server-side, no external deps). */
function decodePolylineServer(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lng / 1e5, lat / 1e5]); // [lng, lat] for MapLibre
  }
  return out;
}
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { TripDetectorService } from './trip-detector.service';
import { TripMaintenanceService } from './trip-maintenance.service';
import { TripReconcilerService } from './trip-reconciler.service';
import { TripPostProcessorService } from './trip-post-processor.service';
import { BillingService } from '../billing/billing.service';
import { clampDateRange } from '../billing/entitlements.helper';
import { PrismaService } from '../prisma/prisma.service';
import { RepairTag } from './repair-tag.utils';

@ApiTags('trips')
@Controller('trips')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TripsController {
  constructor(
    private readonly tripDetectorService: TripDetectorService,
    private readonly vehiclesService: VehiclesService,
    private readonly maintenance: TripMaintenanceService,
    private readonly tripReconcilerService: TripReconcilerService,
    private readonly tripPostProcessorService: TripPostProcessorService,
    private readonly billingService: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Get trips for a vehicle
   */
  @Get('vehicle/:vehicleId')
  @ApiOperation({ summary: 'Get trips for a vehicle' })
  async getTrips(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('limit') limit?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const ent = await this.billingService.getCurrent(req.user.id);
    const { from: effectiveFrom, to: effectiveTo, clamped, limitDays } = clampDateRange(
      {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      },
      ent,
      'tripHistoryDays',
    );
    const trips = await this.tripDetectorService.getTripsForVehicle(
      vehicleId,
      limit ? Number(limit) : 50,
      effectiveFrom,
      effectiveTo,
    );
    return { data: trips, meta: { clamped, limitDays, plan: ent.plan } };
  }

  /**
   * Heatmap points — all polylines for a vehicle, decoded to [lng, lat] pairs.
   * Front-end can feed directly into MapLibre's GeoJSON source + heatmap layer.
   * Capped at 500 trips; samples every 4th point to keep payload small.
   */
  @Get('vehicle/:vehicleId/heatmap')
  @ApiOperation({ summary: 'Get sampled route points for heatmap rendering' })
  async getHeatmap(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const d = days ? Math.min(Number(days), 365) : 90;
    const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    const trips = await this.prisma.trip.findMany({
      where: { vehicleId, startTime: { gte: since }, polyline: { not: null } },
      select: { polyline: true },
      orderBy: { startTime: 'desc' },
      take: 500,
    });
    // Decode polylines server-side and return flat [lng, lat] pairs (sampled every 4 pts)
    const points: [number, number][] = [];
    for (const { polyline } of trips) {
      if (!polyline) continue;
      const coords = decodePolylineServer(polyline);
      for (let i = 0; i < coords.length; i += 4) {
        points.push(coords[i]); // already [lng, lat]
      }
    }
    return { points, tripCount: trips.length };
  }

  /**
   * Get trip statistics
   */
  @Get('vehicle/:vehicleId/stats')
  @ApiOperation({ summary: 'Get trip statistics' })
  async getTripStats(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const ent = await this.billingService.getCurrent(req.user.id);
    const requestedDays = days ? Number(days) : 30;
    const effectiveDays = Math.min(requestedDays, ent.analyticsDepthDays);
    const clamped = requestedDays > effectiveDays;
    const stats = await this.tripDetectorService.getTripStats(vehicleId, effectiveDays);
    return { data: stats, meta: { clamped, limitDays: ent.analyticsDepthDays, plan: ent.plan } };
  }

  /**
   * Delete existing trips in the date range and rebuild from raw telemetry_points.
   * Use this to fix days where the detector produced wrong trips.
   * Rebuild also re-reconciles (merges) fragments over the same range afterwards.
   *
   * POST /trips/vehicle/:vehicleId/rebuild
   * Body: { from: "ISO string", to?: "ISO string", dryRun?: boolean }
   *
   * dryRun=true performs no writes, but is NOT a full-rebuild simulation — it only
   * previews reconciliation of trips that already exist in the range (response has
   * `previewKind: 'reconcile_existing_only'`). It does not replay telemetry through the
   * detector. See TripBackfillService.reconcilePreview() for why.
   *
   * Hardening: owner-only (vehiclesService.findOne throws ForbiddenException on mismatch),
   * rate-limited, range capped server-side (tripRebuildMaxRangeDays), and the real
   * (non-dryRun) path is serialized per-vehicle — a concurrent rebuild for the same
   * vehicle returns 409 instead of racing.
   */
  @Post('vehicle/:vehicleId/rebuild')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Delete and rebuild trips from telemetry for a date range',
    description: 'dryRun=true previews reconciliation of existing trips only — it does not simulate telemetry re-detection.',
  })
  async rebuildTrips(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Body() body: {
      from: string;
      to?: string;
      /**
       * dryRun=true performs reconcile_existing_only;
       * it does not simulate telemetry re-detection or a full rebuild.
       * Future: a dedicated `mode: 'reconcile_preview' | 'full_rebuild'` field would be
       * clearer than an overloaded boolean, but isn't needed until full_rebuild exists —
       * not changing the contract for that alone right now.
       */
      dryRun?: boolean;
    },
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    if (!body.from) throw new Error('from is required');
    const from = new Date(body.from);
    const to = body.to ? new Date(body.to) : new Date();
    return this.maintenance.rebuildTrips(vehicleId, from, to, { dryRun: body.dryRun === true });
  }

  /**
   * Backfill trips for a vehicle from existing telemetry_points.
   *
   * POST /trips/vehicle/:vehicleId/backfill
   * Optional body: { from?: string; to?: string }
   */
  @Post('vehicle/:vehicleId/backfill')
  @ApiOperation({ summary: 'Backfill trips for a vehicle from raw telemetry_points' })
  async backfillTrips(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Body()
    body: {
      from?: string;
      to?: string;
    } = {},
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h by default
    const from = body.from ? new Date(body.from) : defaultFrom;
    const to = body.to ? new Date(body.to) : new Date();

    const result = await this.maintenance.backfillVehicleTrips(vehicleId, from, to);
    return { status: 'ok', ...result };
  }

  /**
   * Backfill reverse-geocoded addresses for trips that have GPS but no address strings.
   * POST /trips/vehicle/:vehicleId/backfill-addresses
   */
  @Post('vehicle/:vehicleId/backfill-addresses')
  @ApiOperation({ summary: 'Backfill geocoded addresses for trips without location names' })
  async backfillAddresses(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const result = await this.maintenance.backfillAddresses(vehicleId);
    return { status: 'ok', ...result };
  }

  /**
   * Remove phantom trips (< 300m, < 60s, SOC increased during short drive).
   * POST /trips/vehicle/:vehicleId/cleanup-phantoms
   */
  @Post('vehicle/:vehicleId/cleanup-phantoms')
  @ApiOperation({ summary: 'Delete phantom/noise trips for a vehicle' })
  async cleanupPhantoms(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const result = await this.maintenance.cleanupPhantoms(vehicleId);
    return { status: 'ok', ...result };
  }

  /**
   * Склейка фрагментов одной вылазки (см. TripReconcilerService: max gap, proximity, короткий gap без proximity).
   * POST /trips/vehicle/:vehicleId/reconcile?days=30&force=true
   */
  @Post('vehicle/:vehicleId/reconcile')
  @ApiOperation({
    summary: 'Merge split trips (reconciler)',
    description:
      'force=true — учитывать поездки, завершённые < 2 мин назад. Ответ: merged = число слитых пар.',
  })
  async reconcileTrips(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days?: number,
    @Query('force') force?: string,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const d = days ? Math.min(Math.max(1, Number(days)), 365) : 30;
    const forceRecent = force === 'true' || force === '1';
    const { merged } = await this.tripReconcilerService.runManual(vehicleId, d, forceRecent);
    return { status: 'ok', merged, mergedPairs: merged };
  }

  /**
   * Recover trips missed due to telemetry gaps (sleeping car).
   * POST /trips/vehicle/:vehicleId/recover-gaps?days=3
   */
  @Post('vehicle/:vehicleId/recover-gaps')
  @ApiOperation({ summary: 'Recover missing trips from odometer/SOC gaps' })
  async recoverGaps(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const result = await this.maintenance.recoverGaps(vehicleId, days ? Number(days) : 3);
    return { status: 'ok', ...result };
  }

  /**
   * Data quality summary for a single trip.
   * GET /trips/:tripId/quality
   *
   * Returns a structured quality object with score, reliability tier,
   * and all repair/audit tags — suitable for UI badges and debugging.
   */
  @Get(':tripId/quality')
  @ApiOperation({ summary: 'Get data quality report for a trip' })
  async getTripQuality(
    @Param('tripId') tripId: string,
    @Request() req,
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true, vehicleId: true,
        qualityScore: true, reliability: true,
        repairReason: true, repairTags: true,
        distanceKm: true, energyUsedKwh: true, efficiencyWhkm: true,
        endTime: true, startTime: true,
        anomalyFlags: true,
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    // Ownership check via vehicleId
    await this.vehiclesService.findOne(trip.vehicleId, req.user.id);

    const tags = Array.isArray(trip.repairTags) ? (trip.repairTags as unknown as RepairTag[]) : [];
    const issues = tags.map(t => t.tag);

    // Human-readable severity based on tag content
    const severity: 'ok' | 'warning' | 'repaired' | 'degraded' = (() => {
      if (issues.some(i => i.includes('watchdog') || i.includes('force_closed') || i.includes('gap_recovery'))) return 'repaired';
      if (issues.some(i => i.includes('gps_cleaned') || i.includes('interpolat') || i.includes('odometer'))) return 'warning';
      if ((trip.qualityScore ?? 100) < 50) return 'degraded';
      return 'ok';
    })();

    return {
      tripId,
      score:       trip.qualityScore ?? null,
      reliability: trip.reliability  ?? null,
      severity,
      issues,
      repairTags:  tags,
      // Legacy string for compat
      repairReason: trip.repairReason ?? null,
      meta: {
        distanceKm:    trip.distanceKm,
        energyUsedKwh: trip.energyUsedKwh,
        efficiencyWhkm: trip.efficiencyWhkm,
        anomalyFlags:  trip.anomalyFlags,
        durationMs: trip.endTime && trip.startTime
          ? trip.endTime.getTime() - trip.startTime.getTime()
          : null,
      },
    };
  }

  /**
   * Timestamped GPS points for a trip (used by Trip Replay feature).
   * GET /trips/:tripId/points
   * Returns up to 500 points with lat, lng, timestamp, speed, power, soc, elevation.
   */
  @Get(':tripId/points')
  @ApiOperation({ summary: 'Get GPS + elevation telemetry points for Trip Replay' })
  async getTripPoints(
    @Param('tripId') tripId: string,
    @Request() req,
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, vehicleId: true, startTime: true, endTime: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    await this.vehiclesService.findOne(trip.vehicleId, req.user.id);

    // Fetch up to 500 GPS points ordered by timestamp; skip points without coordinates
    const points = await this.prisma.tripPoint.findMany({
      where: {
        tripId,
        latitude:  { not: null },
        longitude: { not: null },
      },
      orderBy: { timestamp: 'asc' },
      take: 500,
      select: {
        timestamp:  true,
        latitude:   true,
        longitude:  true,
        speed:      true,
        power:      true,
        soc:        true,
        elevationM: true,
      },
    });

    return {
      tripId,
      startTime: trip.startTime,
      endTime:   trip.endTime,
      points: points.map(p => ({
        t:    p.timestamp.toISOString(),
        lat:  p.latitude,
        lng:  p.longitude,
        spd:  p.speed      ?? null,
        pwr:  p.power      ?? null,
        soc:  p.soc        ?? null,
        elev: p.elevationM ?? null,
      })),
    };
  }

  /**
   * Repair trips where endTime is much later than the last GPS point (force-end bug).
   * POST /trips/vehicle/:vehicleId/repair-endtime?days=3
   */
  @Post('vehicle/:vehicleId/repair-endtime')
  @ApiOperation({ summary: 'Fix trips where endTime is bloated (hours past last GPS point)' })
  async repairEndTime(
    @Param('vehicleId') vehicleId: string,
    @Request() req,
    @Query('days') days?: number,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);
    const d = days ? Math.min(Math.max(1, Number(days)), 30) : 3;
    const { repaired } = await this.maintenance.repairBloatedEndTimes(vehicleId, d);
    return { status: 'ok', repaired };
  }

  /**
   * Manually trigger post-processor (map matching + reliability scoring).
   * POST /trips/post-process
   * Optional query: ?vehicleId=xxx
   */
  @Post('post-process')
  @ApiOperation({ summary: 'Run post-processor: map matching + reliability scoring. ?force=true re-runs all trips.' })
  async postProcess(
    @Request() req,
    @Query('vehicleId') vehicleId?: string,
    @Query('force') force?: string,
  ) {
    if (vehicleId) {
      await this.vehiclesService.findOne(vehicleId, req.user.id);
    }
    const result = await this.tripPostProcessorService.processUnrated(vehicleId, force === 'true');
    return { status: 'ok', ...result };
  }
}
