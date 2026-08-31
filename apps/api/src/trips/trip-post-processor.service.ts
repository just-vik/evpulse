import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MapMatchingService } from '../maps/map-matching.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { appendRepairTags, RepairTag } from './repair-tag.utils';

/**
 * TripPostProcessorService — 5-stage repair + scoring pipeline for completed trips.
 *
 * Stage 1 — removeOutliers:
 *   Load trip points; null out GPS coordinates that fail the jump filter (> 200 km/h implied).
 *   Count invalid GPS points for the reliability score.
 *
 * Stage 2 — recomputeDistance:
 *   Recalculate distanceKm using only valid GPS points (non-null lat/lon).
 *
 * Stage 3 — recomputeEnergy:
 *   If energyUsedKwh is missing/implausible, recover from SOC delta (SOC-only model).
 *   For LOW reliability trips: always use SOC-only (avoid noisy power integral).
 *
 * Stage 4 — computeEfficiency:
 *   efficiencyWhkm = energyUsedKwh * 1000 / distanceKm.
 *   Clamp: > 600 Wh/km → null energy and efficiency (physically impossible).
 *
 * Stage 5 — assignReliability:
 *   score = 100
 *     − gaps * 5            (each gap > 60 s)
 *     − gpsJumps * 10       (each GPS teleport)
 *     − invalidPoints * 2   (each nulled GPS point)
 *     − interpolationRatio * 30  (fraction of synthetic points)
 *   HIGH ≥ 80 | MED ≥ 50 | LOW < 50
 *
 * All stages are idempotent — safe to re-run.
 *
 * Не вызывает TripReconciler: после merge reconcileAt ведёт сюда cron; повторного merge по этому пути нет.
 */
@Injectable()
export class TripPostProcessorService {
  private readonly logger = new Logger(TripPostProcessorService.name);

  /** Same idea as trip-detector STOP_TIMEOUT city — trim parked tail on already-persisted trips. */
  private readonly PARK_TAIL_TRIM_MS = 900_000;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly mapMatching?: MapMatchingService,
    @Optional() private readonly geocoding?: GeocodingService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Process all completed trips that lack a reliability score or haven't been map-matched yet
   *  (up to 200 per run).
   *  Also re-processes LOW reliability trips that still have null energyUsedKwh
   *  (reconstructed trips are created with reliability='LOW' before post-processing). */
  async processUnrated(vehicleId?: string, force = false): Promise<{ processed: number }> {
    const where: any = {
      ...(vehicleId ? { vehicleId } : {}),
      endTime: { not: null },
    };
    if (!force) {
      where.OR = [
        { reliability: null },                                                // not yet processed
        { reliability: 'LOW', energyUsedKwh: null },                          // LOW + missing energy (always retry — repairReason is set on first pass, don't block retries)
        { reliability: 'LOW', efficiencyWhkm: { lt: 50 } },                  // implausibly low efficiency (< 50 Wh/km is physically impossible for a Tesla)
        { startSoc: 0 },                                                      // corrupted startSoc
        { endSoc: null, endTime: { not: null } },                             // missing endSoc
        { endLocation: null, endLat: { not: null }, endTime: { not: null } }, // missing end address
        { startLocation: null, startLat: { not: null }, endTime: { not: null } }, // missing start address
      ];
    }
    const trips = await this.prisma.trip.findMany({
      where,
      include: { vehicle: { include: { vehicleSpec: true } } },
      orderBy: { startTime: 'desc' },
      take: 200,
    });

    let processed = 0;
    const seenTripIds = new Set<string>();
    for (const trip of trips) {
      seenTripIds.add(trip.id);
      await this.processTrip(trip).catch((e: Error) =>
        this.logger.warn(`Post-processor failed for trip ${trip.id}: ${e.message}`),
      );
      processed++;
    }

    // Legacy rows (long wall time vs short distance) are skipped by the normal OR — re-run them once.
    const extraIds = await this.findTripIdsForParkTailRepair(vehicleId, 120);
    for (const id of extraIds) {
      if (seenTripIds.has(id)) continue;
      const t = await this.prisma.trip.findUnique({
        where: { id },
        include: { vehicle: { include: { vehicleSpec: true } } },
      });
      if (!t) continue;
      seenTripIds.add(id);
      await this.processTrip(t).catch((e: Error) =>
        this.logger.warn(`Post-processor failed for trip ${id}: ${e.message}`),
      );
      processed++;
    }

    if (processed > 0) {
      this.logger.log(`Post-processor: rated ${processed} trips${vehicleId ? ` for ${vehicleId}` : ''}`);
    }
    return { processed };
  }

  /**
   * Trips needing metrics repair: long parked tail (huge duration, small distance) or
   * implausible odometer (large distance in a few minutes).
   */
  private async findTripIdsForParkTailRepair(vehicleId: string | undefined, limit: number): Promise<string[]> {
    if (vehicleId) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM trips t
        WHERE t."endTime" IS NOT NULL
          AND t."startTime" IS NOT NULL
          AND t."vehicleId" = ${vehicleId}
          AND (
            (
              EXTRACT(EPOCH FROM (t."endTime" - t."startTime")) > 7200
              AND (t."distanceKm" IS NULL OR t."distanceKm" < 60)
            )
            OR (
              t."distanceKm" IS NOT NULL
              AND t."distanceKm" > 80
              AND EXTRACT(EPOCH FROM (t."endTime" - t."startTime")) BETWEEN 60 AND 1200
            )
          )
        ORDER BY t."startTime" DESC
        LIMIT ${limit}
      `;
      return rows.map(r => r.id);
    }
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM trips t
      WHERE t."endTime" IS NOT NULL
        AND t."startTime" IS NOT NULL
        AND (
          (
            EXTRACT(EPOCH FROM (t."endTime" - t."startTime")) > 7200
            AND (t."distanceKm" IS NULL OR t."distanceKm" < 60)
          )
          OR (
            t."distanceKm" IS NOT NULL
            AND t."distanceKm" > 80
            AND EXTRACT(EPOCH FROM (t."endTime" - t."startTime")) BETWEEN 60 AND 1200
          )
        )
      ORDER BY t."startTime" DESC
      LIMIT ${limit}
    `;
    return rows.map(r => r.id);
  }

  /**
   * Last timestamp to keep when a long stationary suffix (speed ≤1 or null) spans ≥ minSpanMs.
   * Mirrors TripDetectorService.trimLongStationarySuffix.
   */
  private computeParkedTailTrimEnd(
    points: { timestamp: Date; speed: number | null }[],
    windowEnd: Date,
    minSpanMs: number,
  ): Date | null {
    const slice = points
      .filter(p => p.timestamp.getTime() <= windowEnd.getTime())
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (slice.length < 3) return null;

    const r = slice.length - 1;
    let lastMove = -1;
    for (let i = r; i >= 0; i--) {
      if ((slice[i]!.speed ?? 0) > 1) {
        lastMove = i;
        break;
      }
    }

    let newLen = slice.length;
    if (lastMove >= 0) {
      const tailStart = lastMove + 1;
      if (tailStart < slice.length) {
        const spanMs = slice[r]!.timestamp.getTime() - slice[tailStart]!.timestamp.getTime();
        if (spanMs >= minSpanMs) {
          newLen = tailStart + 1;
        }
      }
    } else {
      let l = r;
      while (l > 0 && (slice[l - 1]!.speed ?? 0) <= 1) l--;
      const spanMs = slice[r]!.timestamp.getTime() - slice[l]!.timestamp.getTime();
      if (spanMs >= minSpanMs && l > 0) {
        newLen = l + 1;
      }
    }

    if (newLen >= slice.length) return null;
    const candidateEnd = slice[newLen - 1]!.timestamp;
    if (candidateEnd.getTime() - slice[0]!.timestamp.getTime() < 30_000) return null;
    return candidateEnd;
  }

  /** Re-process a specific trip. Safe to call at any time. */
  async processTripById(tripId: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { vehicle: { include: { vehicleSpec: true } } },
    });
    if (!trip) return;
    await this.processTrip(trip);
  }

  // ─── Pipeline ──────────────────────────────────────────────────────────────

  private async processTrip(trip: any): Promise<void> {
    const repairReasons: string[] = [];
    let adjustedEndTime: Date | null = (trip.endTime as Date | null) ?? null;
    let adjustedEndSoc: number | null = null;

    // FIX 7: Tags that must survive post-processor re-runs — never overwrite them.
    // The watchdog, backfill, gap-recovery, and state-engine services write these tags
    // to convey HOW the trip was created/closed; the post-processor must preserve them.
    const PRESERVED_TAGS = new Set([
      'force_closed_stale_watchdog',
      'force_closed_stale_watchdog_no_point',
      'force_closed_charging_transition', // set by TelemetryEventEngine on DRIVING→CHARGING
      'gap_recovery',
      'reconstructed',
      'merged_from_signal_loss',
      'backfill',
    ]);
    const existingRepair: string = (trip.repairReason as string | null) ?? '';
    const preservedTags = existingRepair
      .split('|')
      .filter(t => PRESERVED_TAGS.has(t));

    // Load points for GPS analysis
    let points = await this.prisma.tripPoint.findMany({
      where:   { tripId: trip.id },
      orderBy: { timestamp: 'asc' },
      select:  {
        latitude: true,
        longitude: true,
        speed: true,
        power: true,
        timestamp: true,
        soc: true,
        interpolated: true,
      },
    });

    // Trip-end normalization (pre-repair):
    // 1) trim trip to charging start when trip accidentally includes charging time;
    // 2) extend trip end when telemetry shows clear movement shortly after endTime.
    if (adjustedEndTime) {
      const overlappingCharge = await this.prisma.chargingSession.findFirst({
        where: {
          vehicleId: trip.vehicleId as string,
          startTime: { gte: trip.startTime as Date, lte: adjustedEndTime },
          endTime:   { not: null },
        },
        orderBy: { startTime: 'asc' },
        select: { startTime: true, endTime: true, startSoc: true, energyAddedKwh: true },
      });

      if (overlappingCharge && (overlappingCharge.energyAddedKwh ?? 0) >= 2) {
        adjustedEndTime = overlappingCharge.startTime;
        adjustedEndSoc = overlappingCharge.startSoc ?? adjustedEndSoc;
        repairReasons.push('trip_trimmed_to_charge_start');
      }

      const tailWindowEnd = new Date(adjustedEndTime.getTime() + 10 * 60_000);
      const tailPoints = await this.prisma.telemetryPoint.findMany({
        where: {
          vehicleId: trip.vehicleId as string,
          timestamp: { gt: adjustedEndTime, lte: tailWindowEnd },
        },
        orderBy: { timestamp: 'asc' },
        take: 80,
        select: { timestamp: true, speed: true, power: true, soc: true, chargingState: true },
      });

      const firstMoving = tailPoints.find((p) =>
        (p.speed ?? 0) > 8 && (p.chargingState ?? '') !== 'Charging',
      );
      if (firstMoving) {
        const gapMs = firstMoving.timestamp.getTime() - adjustedEndTime.getTime();
        if (gapMs <= 4 * 60_000) {
          const afterMove = tailPoints.filter((p) => p.timestamp >= firstMoving.timestamp);
          const stableStop = afterMove.find((p) =>
            (p.speed ?? 0) < 1.5 &&
            Math.abs(p.power ?? 0) < 3 &&
            (p.chargingState ?? '') !== 'Charging',
          );
          const candidateEnd = stableStop?.timestamp ?? afterMove[afterMove.length - 1]?.timestamp ?? null;
          if (candidateEnd && candidateEnd.getTime() > adjustedEndTime.getTime()) {
            adjustedEndTime = candidateEnd;
            const socNearEnd = [...afterMove]
              .reverse()
              .find((p) => p.timestamp.getTime() <= candidateEnd.getTime() && (p.soc ?? 0) > 0);
            adjustedEndSoc = socNearEnd?.soc ?? adjustedEndSoc;
            repairReasons.push('trip_end_extended_from_tail_motion');
          }
        }
      }
    }

    // 3) Persisted parked tail (pre–detector-fix trips): drop duplicate stationary points and
    //    move endTime to the real stop so duration/efficiency match TeslaMate.
    //
    // Pipeline order (must stay this way): load points → charge/tail adjust → parked-tail trim
    // (mutates `points` + DB) → tripEndTime → odometer window → Stage 1–2 GPS distance / energy.
    // If trim ran after distance, metrics would still use the long tail.
    const endForTailScan = adjustedEndTime ?? (trip.endTime as Date | null);
    if (endForTailScan && points.length >= 3) {
      const trimmedEnd = this.computeParkedTailTrimEnd(points, endForTailScan, this.PARK_TAIL_TRIM_MS);
      if (trimmedEnd && trimmedEnd.getTime() < endForTailScan.getTime() - 60_000) {
        adjustedEndTime = trimmedEnd;
        repairReasons.push('parked_tail_trimmed');
        this.logger.log(
          `Trip ${trip.id}: parked_tail_trimmed trimmedEnd=${trimmedEnd.toISOString()} previousEnd=${endForTailScan.toISOString()}`,
        );
        await this.prisma.tripPoint.deleteMany({
          where: { tripId: trip.id, timestamp: { gt: trimmedEnd } },
        });
        points = points.filter(
          (p: any) => (p.timestamp as Date).getTime() <= trimmedEnd.getTime(),
        );
        const lastPt = points[points.length - 1] as { soc?: number | null } | undefined;
        if (lastPt && (lastPt.soc ?? 0) > 0) {
          adjustedEndSoc = lastPt.soc ?? adjustedEndSoc;
        }
      }
    }

    const tripEndTime = adjustedEndTime ?? (trip.endTime as Date);
    if (points.length === 0 && trip.startTime && tripEndTime) {
      const telemetryFallback = await this.prisma.telemetryPoint.findMany({
        where: {
          vehicleId: trip.vehicleId as string,
          timestamp: { gte: trip.startTime as Date, lte: tripEndTime },
        },
        orderBy: { timestamp: 'asc' },
        select: {
          latitude: true,
          longitude: true,
          speed: true,
          power: true,
          timestamp: true,
          soc: true,
        },
        take: 500,
      });
      if (telemetryFallback.length > 0) {
        points = telemetryFallback.map((p: any) => ({ ...p, interpolated: false }));
        repairReasons.push('points_recovered_from_telemetry');
      }
    }
    const effectivePoints = points.filter((p: any) => (p.timestamp as Date).getTime() <= tripEndTime.getTime());
    // FIX 6: Interpolated points are synthetic (GPS linearly interpolated between known fixes).
    // They corrupt the GPS jump filter (implied speed is always within range since they're
    // linearly placed) and inflate GPS-derived distance on straight-line paths.
    // Use raw points for GPS analysis; interpolated points only contribute energy/SOC data.
    const realPoints = effectivePoints.filter((p: any) => !p.interpolated);

    // Load odometer readings from raw telemetry using anchor-based approach.
    // Odometer arrives via MQTT every ~30 s, so the first reading for a trip may arrive
    // 10–30 s after trip start (car has already driven 0.3–0.5 km at that point).
    // Using global min/max over the trip window underestimates that initial segment.
    //
    // For the START anchor: use the last odometer reading AT OR BEFORE startTime
    // (car was parked, value is stable). If none exists, use first reading within 60s after.
    // For the END anchor: use the last odometer reading at or shortly after endTime.
    // This correctly anchors both endpoints regardless of MQTT delivery timing.
    const [startOdoBefore, startOdoAfter, endOdoRow] = await Promise.all([
      // Last stable odo reading before trip start (parked state, value is stable)
      this.prisma.telemetryPoint.findFirst({
        where: {
          vehicleId:  trip.vehicleId as string,
          timestamp:  { lte: trip.startTime as Date },
          odometer:   { not: null },
        },
        orderBy: { timestamp: 'desc' },
        select:  { odometer: true, timestamp: true },
      }),
      // First odo reading after trip start (within 60 s — before car gets far)
      this.prisma.telemetryPoint.findFirst({
        where: {
          vehicleId:  trip.vehicleId as string,
          timestamp:  { gt: trip.startTime as Date, lte: new Date((trip.startTime as Date).getTime() + 60_000) },
          odometer:   { not: null },
        },
        orderBy: { timestamp: 'asc' },
        select:  { odometer: true, timestamp: true },
      }),
      // Last odo reading during the trip (up to 15 min after end).
      // Using trip.startTime as lower bound instead of endTime-3min because
      // on buffer-replay trips the car can stop sending telemetry 5-10 min
      // before the trip closes, leaving the end odometer outside a narrow window.
      // 15 min window (was 2 min) handles the case where fleet telemetry drops mid-trip:
      // the trip closes at last-known-event but REST polling continues for several more
      // minutes capturing real movement — we want that final odometer reading.
      this.prisma.telemetryPoint.findFirst({
        where: {
          vehicleId:  trip.vehicleId as string,
          timestamp:  { gte: trip.startTime as Date, lte: new Date(tripEndTime.getTime() + 15 * 60_000) },
          odometer:   { not: null },
        },
        orderBy: { timestamp: 'desc' },
        select:  { odometer: true },
      }),
    ]);

    // Prefer last-before-start (car was stationary, odo is stable).
    // Fall back to first-after-start if no pre-trip reading exists (first trip ever, or DB gap).
    const startOdoRow = startOdoBefore ?? startOdoAfter;

    if (
      startOdoRow?.odometer != null &&
      endOdoRow?.odometer != null &&
      endOdoRow.odometer < startOdoRow.odometer
    ) {
      repairReasons.push('odometer_non_monotonic');
    }

    const rawOdoDist =
      startOdoRow?.odometer != null &&
      endOdoRow?.odometer   != null &&
      endOdoRow.odometer > startOdoRow.odometer
        ? Math.round((endOdoRow.odometer - startOdoRow.odometer) * 10) / 10
        : null;
    // Ignore tiny odometer deltas — these are rounding artifacts from sleep/wake cycles,
    // not real movement. A real trip is always > 0.3 km.
    let odometerDistKm = rawOdoDist != null && rawOdoDist >= 0.3 ? rawOdoDist : null;

    const durationMsForOdoSanity =
      trip.startTime && tripEndTime
        ? tripEndTime.getTime() - (trip.startTime as Date).getTime()
        : 0;
    const durationHours = durationMsForOdoSanity / 3_600_000;
    if (
      odometerDistKm != null &&
      durationHours > 0.05 &&
      odometerDistKm > durationHours * 130 + 15
    ) {
      this.logger.log(
        `Trip ${trip.id}: odometer_rejected_vs_duration rawOdoKm=${odometerDistKm} durationHours=${durationHours.toFixed(2)} ceilingKm=${(durationHours * 130 + 15).toFixed(1)}`,
      );
      odometerDistKm = null;
      repairReasons.push('odometer_rejected_vs_duration');
    }

    // ── Stage 1: removeOutliers ───────────────────────────────────────────
    let invalidGpsPoints = 0;
    let gpsJumps         = 0;

    const validPoints: { lat: number; lon: number; ts: Date }[] = [];
    let prevGps: { lat: number; lon: number; ts: Date } | null = null;

    for (const p of realPoints) {
      const lat = p.latitude  as number | null;
      const lon = p.longitude as number | null;
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
        invalidGpsPoints++;
        continue;
      }
      if (prevGps) {
        const dtMs   = (p.timestamp as Date).getTime() - prevGps.ts.getTime();
        const distKm = haversineKm(prevGps.lat, prevGps.lon, lat, lon);
        if (dtMs > 0 && dtMs < 180_000) {
          const impliedKmh = distKm / (dtMs / 3_600_000);
          if (impliedKmh > 200) {
            gpsJumps++;
            invalidGpsPoints++;
            continue;
          }
        }
      }
      const pt = { lat, lon, ts: p.timestamp as Date };
      validPoints.push(pt);
      prevGps = pt;
    }

    if (gpsJumps > 0 || invalidGpsPoints > 0) {
      repairReasons.push(`gps_cleaned(${gpsJumps}jumps,${invalidGpsPoints}invalid)`);
    }

    // ── Stage 2: recomputeDistance ────────────────────────────────────────
    let distanceKm = trip.distanceKm as number | null;

    // When majority of GPS points are invalid (>50% null), the sparse GPS
    // haversine severely underestimates actual distance — the valid segments
    // are only the brief windows where GPS lock was held (e.g. on buffer-replay
    // trips from Tesla Fleet Telemetry where most historical points have no GPS).
    // Odometer is monotonically accurate and is unaffected by GPS gaps, so use
    // it directly instead of blending it 50/50 with the degraded GPS haversine.
    const gpsInvalidRatio = realPoints.length > 0 ? invalidGpsPoints / realPoints.length : 0;
    if (gpsInvalidRatio > 0.5 && odometerDistKm && odometerDistKm > 0.5) {
      // 3% threshold (vs 5% elsewhere) — with 87% null GPS we're very confident
      // the odometer is more accurate than any GPS-derived distance.
      if (Math.abs(odometerDistKm - (distanceKm ?? 0)) / (distanceKm || 1) > 0.03) {
        distanceKm = odometerDistKm;
        repairReasons.push('distance_from_odometer_low_gps_coverage');
      }
    } else if (validPoints.length >= 2) {
      let gpsDistKm = 0;
      for (let i = 1; i < validPoints.length; i++) {
        gpsDistKm += haversineKm(
          validPoints[i - 1].lat, validPoints[i - 1].lon,
          validPoints[i].lat,     validPoints[i].lon,
        );
      }
      gpsDistKm = Math.round(gpsDistKm * 10) / 10;

      // Five-way distance selection based on GPS/odometer agreement ratio:
      //   ratio < 0.75  → GPS severely underestimates (tunnel/signal gap) → use odometer
      //   ratio 0.75–0.92 → moderate undercount → blend both sources (hybrid)
      //   ratio 0.92–1.20 → good agreement → trust GPS (more granular than 30s odo)
      //   ratio 1.20–1.40 → GPS slightly overestimates (minor jumps survived stage 1) → blend
      //   ratio > 1.40  → GPS severely overestimates (GPS artifact) → use odometer
      const ratio = odometerDistKm && odometerDistKm > 0.5 ? gpsDistKm / odometerDistKm : 1;

      let newDistanceKm: number | null = null;
      let distanceTag = '';
      if (odometerDistKm && odometerDistKm > 0.5) {
        if (ratio < 0.75) {
          newDistanceKm = odometerDistKm;
          distanceTag   = 'distance_from_odometer';
        } else if (ratio < 0.92) {
          newDistanceKm = Math.round((gpsDistKm + odometerDistKm) / 2 * 10) / 10;
          distanceTag   = 'distance_hybrid';
        } else if (ratio <= 1.20) {
          newDistanceKm = gpsDistKm;
          distanceTag   = 'distance_recomputed';
        } else if (ratio <= 1.40) {
          // GPS slightly above odo — small jumps that passed stage-1 filter; blend
          newDistanceKm = Math.round((gpsDistKm + odometerDistKm) / 2 * 10) / 10;
          distanceTag   = 'distance_hybrid_gps_high';
        } else {
          // GPS severely above odo — GPS artifact; odometer is authoritative
          newDistanceKm = odometerDistKm;
          distanceTag   = 'distance_from_odometer_gps_artifact';
        }
      } else {
        newDistanceKm = gpsDistKm;
        distanceTag   = 'distance_recomputed';
      }

      if (newDistanceKm !== null && Math.abs(newDistanceKm - (distanceKm ?? 0)) / (distanceKm ?? 1) > 0.05) {
        distanceKm = newDistanceKm;
        repairReasons.push(distanceTag);
      }
    } else if (odometerDistKm && odometerDistKm > 0.5) {
      // No valid GPS points at all (buffer-replay with 100% null coords) but
      // odometer is available — use it directly as the authoritative distance.
      // Without this branch such trips keep their finalization haversine (=0 or
      // very wrong) forever, because validPoints.length < 2 skips the 5-way logic.
      if (Math.abs(odometerDistKm - (distanceKm ?? 0)) / (distanceKm || 1) > 0.05) {
        distanceKm = odometerDistKm;
        repairReasons.push('distance_from_odometer_no_gps');
      }
    }

    // ── Stage 3: recomputeEnergy ──────────────────────────────────────────
    const usableKwh = this.getUsableKwh(trip.vehicle);

    // Repair startSoc=0: the trip detector bug stored 0 when the first telemetry
    // point at trip-start lacked SOC. Look up the actual SOC from the nearest
    // telemetry point within 5 min before/at trip.startTime.
    let startSoc = trip.startSoc as number | null;
    let repairedStartSoc: number | null = null;
    if ((startSoc === 0 || startSoc == null) && trip.startTime) {
      const lookbackStart = new Date((trip.startTime as Date).getTime() - 10 * 60_000);
      const lookforwardEnd = new Date((trip.startTime as Date).getTime() + 2 * 60_000);
      const nearbyPoint = await this.prisma.telemetryPoint.findFirst({
        where: {
          vehicleId: trip.vehicleId as string,
          timestamp: { gte: lookbackStart, lte: lookforwardEnd },
          soc: { not: null, gt: 0 },
        },
        orderBy: { timestamp: 'desc' },
        select: { soc: true },
      });
      if (nearbyPoint?.soc != null && nearbyPoint.soc > 0) {
        repairedStartSoc = nearbyPoint.soc;
        startSoc = repairedStartSoc;
        repairReasons.push('start_soc_repaired');
        this.logger.debug(`Trip ${trip.id}: repaired startSoc 0→${startSoc}`);
      }
    }

    // Repair endSoc=null: look up the last SOC reading at or just before trip.endTime.
    // This covers trips where the in-memory buffer was lost on API restart —
    // the trip finalizer couldn't capture endSoc from the buffer.
    // Order DESC + narrow forward window (+30 s) so we take the final in-trip SOC,
    // not the first post-trip poll that could be the start SOC of the next trip
    // (common when gap between trips is < 5 min — previously the +5 min window
    // and ASC order grabbed the wrong value).
    let endSoc = adjustedEndSoc ?? (trip.endSoc as number | null);
    if (endSoc == null && tripEndTime) {
      const lookbackStart  = new Date(tripEndTime.getTime() - 3 * 60_000);
      const lookforwardEnd = new Date(tripEndTime.getTime() + 30_000);
      const nearbyEndPoint = await this.prisma.telemetryPoint.findFirst({
        where: {
          vehicleId: trip.vehicleId as string,
          timestamp: { gte: lookbackStart, lte: lookforwardEnd },
          soc: { not: null, gt: 0 },
        },
        orderBy: { timestamp: 'desc' },
        select: { soc: true },
      });
      if (nearbyEndPoint?.soc != null && nearbyEndPoint.soc > 0) {
        endSoc = nearbyEndPoint.soc;
        repairReasons.push('end_soc_repaired');
        this.logger.debug(`Trip ${trip.id}: repaired endSoc null→${endSoc}`);
      }
    }

    // Guard against impossible SOC rise within one trip.
    // Real trips should not end significantly above start SOC (small +regen noise aside).
    // This commonly happens when the detector closes too late around charge transitions.
    const socRise = startSoc != null && endSoc != null ? endSoc - startSoc : null;
    if (socRise != null && socRise > 3) {
      const endTime = trip.endTime as Date | null;
      const lookbackStart = endTime ? new Date(endTime.getTime() - 10 * 60_000) : null;
      // Strong charging signature: high positive power while nearly stationary.
      const chargingLikeInTrip = effectivePoints.some((p: any) =>
        (p.power ?? 0) > 8 && (p.speed ?? 999) < 1.5,
      );

      let correctedEndSoc: number | null = null;
      if (endTime && lookbackStart && startSoc != null) {
        const nearEnd = await this.prisma.telemetryPoint.findFirst({
          where: {
            vehicleId: trip.vehicleId as string,
            timestamp: { gte: lookbackStart, lte: endTime },
            soc: { not: null, gt: 0, lte: startSoc + 1.5 },
          },
          orderBy: { timestamp: 'desc' },
          select: { soc: true },
        });
        correctedEndSoc = nearEnd?.soc ?? null;
      }

      endSoc = correctedEndSoc ?? startSoc;
      repairReasons.push(chargingLikeInTrip ? 'soc_rise_clamped_charge_contamination' : 'soc_rise_clamped');
      this.logger.debug(
        `Trip ${trip.id}: clamped impossible soc rise (start=${startSoc}, end=>${trip.endSoc}, fixed=${endSoc})`,
      );
    }

    // P1: within-trip SOC rise (no charging) — do not trust SOC-delta energy model.
    // Scan only the interior of the trip (skip first/last 60 s) to avoid initialization
    // jitter at trip open and boundary bleed from the next trip's start SOC at trip close.
    // Require 2 consecutive rises > 1% — a single sub-1% tick is regen noise, not charging.
    let socSeriesContaminated = false;
    {
      const startMs = (trip.startTime as Date).getTime();
      const endMs   = tripEndTime.getTime();
      const interiorPoints = effectivePoints.filter(
        (p: any) =>
          (p.timestamp as Date).getTime() > startMs + 60_000 &&
          (p.timestamp as Date).getTime() < endMs   - 60_000,
      );
      let consecutiveRises = 0;
      for (let i = 1; i < interiorPoints.length; i++) {
        const s0 = interiorPoints[i - 1].soc as number | null;
        const s1 = interiorPoints[i].soc as number | null;
        if (s0 != null && s1 != null && s1 > s0 + 1.0) {
          consecutiveRises++;
          if (consecutiveRises >= 2) {
            socSeriesContaminated = true;
            break;
          }
        } else {
          consecutiveRises = 0;
        }
      }
    }
    if (startSoc != null && endSoc != null && endSoc >= startSoc) {
      const lastLowerSoc = [...effectivePoints]
        .reverse()
        .find((p: any) => (p.soc ?? 999) <= startSoc - 0.5 && (p.soc ?? 0) > 0);
      if (lastLowerSoc?.soc != null) {
        endSoc = lastLowerSoc.soc;
        repairReasons.push('end_soc_from_intrip_min');
      }
    }

    if (socSeriesContaminated) {
      repairReasons.push('soc_rise_in_trip');
    }

    const socDrop   = startSoc != null && endSoc != null ? startSoc - endSoc : null;
    // 0.5% minimum: covers short trips where SoC has ~0.5% measurement granularity.
    // For a 72 kWh pack, 0.5% = 0.36 kWh ≈ 2.4 km at 150 Wh/km — measurable.
    const socEnergy =
      !socSeriesContaminated &&
      socDrop != null &&
      socDrop >= 0.5 &&
      usableKwh > 0
      ? Math.round((socDrop / 100) * usableKwh * 100) / 100
      : null;

    let energyUsedKwh = trip.energyUsedKwh as number | null;

    // Discard implausibly low power-integral energy (<50 Wh/km over meaningful distance).
    // A Tesla cannot physically drive below ~50 Wh/km even on a steep downhill.
    // Values this low indicate buffer loss on restart, charging energy leakage, or
    // regen-only data — SOC-delta reconstruction gives a far better estimate.
    if (energyUsedKwh != null && distanceKm != null && distanceKm > 2) {
      const tentativeEff = (energyUsedKwh * 1000) / distanceKm;
      if (tentativeEff < 50) {
        this.logger.debug(`Trip ${trip.id}: discarding implausible energy ${energyUsedKwh} kWh (${tentativeEff.toFixed(1)} Wh/km for ${distanceKm} km)`);
        energyUsedKwh = null;
        repairReasons.push('energy_implausible_reset');
      }
    }

    // Energy source priority for trips:
    //   1. SOC-delta ≥ 2%  — BMS coulomb counting is the ground truth.  Power integral
    //      undercounts net consumption: regen returns as negative power and partially
    //      cancels drive-phase draw in the sum.  2% = ~1.6 kWh on a 78 kWh pack,
    //      which is enough resolution to be more accurate than the integral.
    //   2. Power integral kept when socDrop < 2% (too coarse) or SOC is contaminated.
    //   3. SOC-delta 0.5–2% as last resort when integral is missing or LOW reliability.
    const currentReliability = trip.reliability as string | null;
    const socEnergyIsReliable = socEnergy != null && (socDrop ?? 0) >= 2;
    if (socEnergyIsReliable) {
      const hadPowerIntegral = energyUsedKwh != null && energyUsedKwh > 0;
      energyUsedKwh = socEnergy;
      repairReasons.push(hadPowerIntegral ? 'energy_from_soc_preferred' : 'energy_recovered_from_soc');
    } else if (!energyUsedKwh || energyUsedKwh <= 0 || currentReliability === 'LOW') {
      if (socEnergy != null) {
        energyUsedKwh = socEnergy;
        if (!trip.energyUsedKwh || trip.energyUsedKwh <= 0) {
          repairReasons.push('energy_recovered_from_soc');
        }
      }
    }
    // Trimmed-to-charge trips can be marked contaminated by stale point tails.
    // In that specific case, if start/end SOC is valid and energy is still null, recover from SOC anyway.
    if (
      energyUsedKwh == null &&
      repairReasons.includes('trip_trimmed_to_charge_start') &&
      startSoc != null &&
      endSoc != null &&
      startSoc > endSoc
    ) {
      energyUsedKwh = Math.round(((startSoc - endSoc) / 100) * usableKwh * 100) / 100;
      repairReasons.push('energy_recovered_from_soc_trimmed');
    }

    // ── Stage 4: computeEfficiency ────────────────────────────────────────
    const isReconstructed = (trip.repairReason as string | null)?.includes('reconstructed') ?? false;
    let efficiencyWhkm: number | null = null;
    if (energyUsedKwh != null && distanceKm != null && distanceKm > 0) {
      const computed = Math.round((energyUsedKwh * 1000 / distanceKm) * 10) / 10;
      if (computed > 600 || computed <= 0) {
        efficiencyWhkm = null;
        // For reconstructed trips the straight-line distance is an estimate, so the
        // efficiency ratio may be unreliable — keep energy but null efficiency.
        if (!isReconstructed) energyUsedKwh = null;
        repairReasons.push('efficiency_out_of_range');
      } else {
        efficiencyWhkm = computed;
      }
    }

    // ── Stage 5: assignReliability ────────────────────────────────────────
    // FIX 6b: Count gaps > 60 s using only REAL (non-interpolated) points.
    // Synthetic interpolated points are placed at 60 s intervals and would
    // bridge actual data gaps, masking them from the gap counter and inflating
    // the quality score artificially.
    let gapCount = 0;
    for (let i = 1; i < realPoints.length; i++) {
      const dtMs = (realPoints[i].timestamp as Date).getTime() - (realPoints[i - 1].timestamp as Date).getTime();
      if (dtMs > 60_000) gapCount++;
    }

    const totalPoints = realPoints.length;
    const invalidRatio = totalPoints > 0 ? invalidGpsPoints / totalPoints : 0;

    // FIX 4: Include interpolation ratio in quality score.
    // Interpolated points are synthetic GPS-fill between sparse real fixes —
    // they degrade trip accuracy (straight-line GPS, no events, estimated distance).
    // Penalise proportionally: 100% interpolated = −30 pts (same weight as invalid GPS ratio).
    const interpolatedCount = effectivePoints.filter((p: any) => p.interpolated).length;
    const interpolationRatio = effectivePoints.length > 0 ? interpolatedCount / effectivePoints.length : 0;

    let score = 100;
    score -= gapCount           * 5;
    score -= gpsJumps           * 10;
    score -= invalidGpsPoints   * 2;
    score -= invalidRatio       * 30;
    // Fleet Telemetry only emits fields when they change — gaps between points are normal
    // even with perfect signal quality (e.g. stable highway speed = no speed events for 30 s).
    // Halved vs. REST interpolation penalty to avoid unfairly penalising high-quality Fleet trips.
    score -= interpolationRatio * 15;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // P1: min distance / duration gates for quality & ratings — cap score
    const tripDurationMs =
      tripEndTime && trip.startTime
        ? tripEndTime.getTime() - (trip.startTime as Date).getTime()
        : 0;
    const tooShortForRatings =
      (distanceKm ?? 0) < 0.3 || tripDurationMs < 60_000;
    if (tooShortForRatings) {
      score = Math.min(score, 50);
      repairReasons.push('short_trip_rating_gate');
    }

    let reliability: 'HIGH' | 'MEDIUM' | 'LOW';
    if (score >= 80 && energyUsedKwh != null) {
      reliability = 'HIGH';
    } else if (score >= 50 && energyUsedKwh != null) {
      reliability = 'MEDIUM';
    } else {
      reliability = 'LOW';
    }

    // ── Stage 6: Map Matching ─────────────────────────────────────────────
    // Snap GPS points to the road network via OSRM and replace the stored
    // polyline with a real road-following route.
    //
    // For GPS-tracked trips (3+ valid GPS points): use /match to snap trace.
    //   The matched distance is more accurate than haversine-sum, so we also
    //   update distanceKm — but only when the match covers ≥ 80% of the
    //   odometer-based distance to avoid false downgrades from partial matches.
    //
    // For gap-recovery trips (start + end only, 0 trip_points): use /route
    //   to get the shortest road path. This gives the map a real route instead
    //   of a straight line. We do NOT update distanceKm for these (odometer
    //   is more accurate than the shortest path for actual trip distance).
    let matchedPolyline: string | null = null;
    let matchedDistanceKm: number | null = null;
    let routeType: 'matched' | 'estimated' | null = null;

    if (this.mapMatching) {
      const isGapRecovery = (trip.repairReason as string | null)?.includes('gap_recovery') ?? false;

      if (!isGapRecovery && validPoints.length >= 3) {
        // GPS-tracked trip — snap the real track to roads
        const result = await this.mapMatching.match(
          validPoints.map(p => ({ lat: p.lat, lon: p.lon, timestamp: p.ts })),
        );
        if (result) {
          matchedPolyline = result.polyline;
          routeType       = result.type;

          // Distance priority: OSRM > odometer/hybrid > GPS haversine
          // OSRM result is most accurate when GPS coverage is good (≥10 points).
          // For sparse GPS (odometer/hybrid was used), only accept OSRM if it agrees
          // within 15% of the odometer reference (avoids undercount from partial matches).
          const usedNonGps = repairReasons.some(r =>
            r.startsWith('distance_from_odometer') || r.startsWith('distance_hybrid'),
          );
          const reference  = odometerDistKm ?? distanceKm;
          const osrmOk = reference
            ? result.distanceKm >= reference * 0.85 && result.distanceKm <= reference * 1.30
            : result.distanceKm > 0;

          if (osrmOk) {
            // Full GPS coverage: OSRM is ground truth
            if (!usedNonGps || validPoints.length >= 10) {
              matchedDistanceKm = result.distanceKm;
            }
            // Sparse GPS: OSRM is plausible → use as hybrid with odometer
            else if (odometerDistKm) {
              matchedDistanceKm = Math.round((result.distanceKm + odometerDistKm) / 2 * 10) / 10;
            }
            repairReasons.push('map_matched');
          }
        }
      } else if (isGapRecovery || validPoints.length <= 2) {
        // Gap-recovery or sparse trip — generate a road route between endpoints
        const from = validPoints.length >= 1 ? validPoints[0]         : null;
        const to   = validPoints.length >= 2 ? validPoints[validPoints.length - 1] : null;
        const startLat = (trip.startLat as number | null) ?? from?.lat;
        const startLon = (trip.startLon as number | null) ?? from?.lon;
        const endLat   = (trip.endLat   as number | null) ?? to?.lat;
        const endLon   = (trip.endLon   as number | null) ?? to?.lon;

        if (startLat && startLon && endLat && endLon) {
          const result = await this.mapMatching.match([
            { lat: startLat, lon: startLon },
            { lat: endLat,   lon: endLon   },
          ]);
          if (result) {
            matchedPolyline = result.polyline;
            routeType       = result.type;   // always 'estimated' for 2-point route
            // For gap-recovery, keep the odometer-based distanceKm as-is
          }
        }
      }
    }

    // ── Geocode missing startLocation ─────────────────────────────────────
    let repairedStartLocation: string | null = null;
    if (!trip.startLocation && this.geocoding) {
      const startLat = (trip.startLat as number | null) ?? (validPoints.length >= 1 ? validPoints[0].lat : null);
      const startLon = (trip.startLon as number | null) ?? (validPoints.length >= 1 ? validPoints[0].lon : null);
      if (startLat != null && startLon != null) {
        repairedStartLocation = await this.geocoding.reverseShort(startLat, startLon).catch(() => null);
        if (repairedStartLocation) repairReasons.push('start_location_geocoded');
      }
    }

    // ── Geocode missing endLocation ───────────────────────────────────────
    let repairedEndLocation: string | null = null;
    if (!trip.endLocation && this.geocoding) {
      const endLat = (trip.endLat as number | null) ?? (validPoints.length >= 1 ? validPoints[validPoints.length - 1].lat : null);
      const endLon = (trip.endLon as number | null) ?? (validPoints.length >= 1 ? validPoints[validPoints.length - 1].lon : null);
      if (endLat != null && endLon != null) {
        repairedEndLocation = await this.geocoding.reverseShort(endLat, endLon).catch(() => null);
        if (repairedEndLocation) repairReasons.push('end_location_geocoded');
      }
    }

    // ── Write back ────────────────────────────────────────────────────────
    const repairedEndSoc = repairReasons.includes('end_soc_repaired') ? endSoc : null;
    const shouldWriteEndSoc =
      adjustedEndSoc != null ||
      repairedEndSoc != null ||
      repairReasons.includes('trip_trimmed_to_charge_start') ||
      repairReasons.includes('end_soc_from_intrip_min') ||
      repairReasons.includes('parked_tail_trimmed');

    // Build merged legacy repairReason string (backward compat)
    const mergedRepairReason = (() => {
      const allTags = [...preservedTags, ...repairReasons.filter(r => !PRESERVED_TAGS.has(r))];
      return allTags.length ? allTags.join('|') : 'ok';
    })();

    // Build structured JSONB repairTags: preserve existing tags + append new post-processor tags.
    // Only computed tags (non-origin) are added by the post-processor source.
    const postProcessorTags = repairReasons
      .filter(r => !PRESERVED_TAGS.has(r))
      .map(tag => ({ tag, source: 'post-processor' as const }));
    const mergedRepairTags: RepairTag[] = appendRepairTags(
      (trip.repairTags as RepairTag[] | null | undefined),
      postProcessorTags,
    );

    await this.prisma.trip.update({
      where: { id: trip.id },
      data: {
        ...(tripEndTime && (!trip.endTime || Math.abs(tripEndTime.getTime() - (trip.endTime as Date).getTime()) > 1000)
          ? { endTime: tripEndTime }
          : {}),
        distanceKm:    matchedDistanceKm ?? distanceKm ?? undefined,
        energyUsedKwh: energyUsedKwh,
        efficiencyWhkm: efficiencyWhkm,
        qualityScore:  score,
        reliability,
        repairReason:  mergedRepairReason,
        repairTags:    mergedRepairTags.length ? (mergedRepairTags as any) : undefined,
        ...(repairedStartSoc      != null ? { startSoc:      repairedStartSoc      } : {}),
        ...(shouldWriteEndSoc ? { endSoc: endSoc ?? repairedEndSoc ?? trip.endSoc ?? null } : {}),
        ...(repairedStartLocation != null ? { startLocation: repairedStartLocation } : {}),
        ...(repairedEndLocation   != null ? { endLocation:   repairedEndLocation   } : {}),
        ...(matchedPolyline ? { polyline: matchedPolyline } : {}),
        ...(routeType ? { routeType, mapMatchedAt: new Date() } : {}),
      },
    });
  }

  private getUsableKwh(vehicle: any): number {
    return (
      vehicle?.batteryCapacityDetected ??
      vehicle?.vehicleSpec?.batteryUsableKwh ??
      vehicle?.batteryCapacityUsable ??
      78  // was 75 — Model Y LR (most common) has 78 kWh usable; VehicleSpecsService populates this accurately
    );
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R     = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
