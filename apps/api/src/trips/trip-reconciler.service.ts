import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';
import {
  haversineKmMerge,
  tripReconcileMaxGapMs,
  tripReconcileMaxProximityKm,
  tripReconcileShortGapMs,
} from './trip-merge-params';

/**
 * TripReconcilerService
 *
 * Runs every 5 minutes and merges consecutive trips for the same vehicle
 * where the gap between end-of-trip-A and start-of-trip-B is ≤ maxGap (default 6 h).
 *
 * Covers: красные светофоры, короткие потери сигнала и **многоостановочные выезды**
 * (после P промежуточная поездка склеивается с следующей, если разрыв и география позволяют).
 *
 * Merge strategy:
 *   - Keep trip A (the earlier one), delete trip B
 *   - Re-assign all of trip B's trip_points to trip A
 *   - endTime / endSoc / endLocation taken from trip B
 *   - distanceKm = A.distance + B.distance
 *   - energyUsedKwh recalculated from merged SOC drop × battery capacity
 *   - efficiencyWhkm recalculated from merged energy / merged distance
 *
 * reconcileAt после merge откладывает постпроцессор; cron в TripCleanupService обрабатывает
 * только processTrip и сбрасывает reconcileAt в null. Постпроцессор reconciler не вызывает — цикла merge→reconcile нет.
 */
export interface ReconcilePair {
  vehicleId: string;
  keptTripId: string;
  removedTripId: string;
  gapSeconds: number;
  reason: 'merged' | 'duplicate_removed';
}

export interface ReconcileResult {
  merged: number;
  /** Adjacent trip pairs within the max-gap time window — i.e. time-plausible merge
   *  candidates, before the charging/proximity/signal-loss guards are applied. */
  candidatePairs: number;
  skippedDueToCharging: number;
  pairs: ReconcilePair[];
}

@Injectable()
export class TripReconcilerService {
  private readonly logger = new Logger(TripReconcilerService.name);
  private readonly maxGapMs: number;
  private readonly maxProximityKm: number;
  private readonly shortGapMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.maxGapMs = tripReconcileMaxGapMs(this.config);
    this.maxProximityKm = tripReconcileMaxProximityKm(this.config);
    this.shortGapMs = tripReconcileShortGapMs(this.config);
  }

  @Cron('*/5 * * * *')
  async reconcileRecent(): Promise<void> {
    if (!isWorkerRole()) return;
    // Only look at trips that finished in the last 30 minutes, but not the
    // last 2 minutes (give the detector time to write the end record).
    const since  = new Date(Date.now() - 30 * 60_000);
    const before = new Date(Date.now() -  2 * 60_000);
    await this._reconcile({ endTimeSince: since, endTimeBefore: before });
  }

  /**
   * Manual trigger exposed via the trips controller.
   * Looks back up to `days` days so operators can heal historical data.
   * @param forceRecent — если true, включает поездки, завершённые менее 2 мин назад (обычно отрезаются, чтобы не конфликтовать с детектором).
   */
  async runManual(
    vehicleId?: string,
    days = 30,
    forceRecent = false,
    opts?: { dryRun?: boolean },
  ): Promise<ReconcileResult> {
    const since = new Date(Date.now() - days * 86_400_000);
    const before = forceRecent ? new Date() : new Date(Date.now() - 2 * 60_000);
    return this._reconcile({ vehicleId, endTimeSince: since, endTimeBefore: before, dryRun: opts?.dryRun });
  }

  /**
   * Scoped reconciliation for an explicit [from, to] range — vehicle-scoped, no
   * global scan. Used after a manual rebuild: the 5-min/hourly crons only look
   * at windows relative to "now" and never reach a historical date range that
   * was just rebuilt, so freshly re-created trip fragments would otherwise stay
   * split forever.
   *
   * The query window is padded by the current max-merge-gap policy (not an
   * arbitrary large range) so a trip just outside [from, to] can still merge
   * with one freshly rebuilt just inside it.
   */
  async reconcileRange(
    vehicleId: string,
    from: Date,
    to: Date,
    opts?: { dryRun?: boolean },
  ): Promise<ReconcileResult> {
    const paddedSince  = new Date(from.getTime() - this.maxGapMs);
    const paddedBefore = new Date(to.getTime()   + this.maxGapMs);
    return this._reconcile({
      vehicleId,
      endTimeSince:  paddedSince,
      endTimeBefore: paddedBefore,
      dryRun: opts?.dryRun,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async _reconcile(opts: {
    vehicleId?:    string;
    endTimeSince:  Date;
    endTimeBefore: Date;
    dryRun?:       boolean;
  }): Promise<ReconcileResult> {
    const trips = await this.prisma.trip.findMany({
      where: {
        ...(opts.vehicleId ? { vehicleId: opts.vehicleId } : {}),
        endTime: { gte: opts.endTimeSince, lt: opts.endTimeBefore },
      },
      orderBy: [{ vehicleId: 'asc' }, { startTime: 'asc' }],
      select: {
        id:            true,
        vehicleId:     true,
        startTime:     true,
        endTime:       true,
        distanceKm:    true,
        energyUsedKwh: true,
        efficiencyWhkm: true,
        startSoc:      true,
        endSoc:        true,
        startLocation: true,
        endLocation:   true,
        startLat:      true,
        startLon:      true,
        endLat:        true,
        endLon:        true,
      },
    });

    // Group by vehicle
    const byVehicle = new Map<string, typeof trips>();
    for (const t of trips) {
      if (!byVehicle.has(t.vehicleId)) byVehicle.set(t.vehicleId, []);
      byVehicle.get(t.vehicleId)!.push(t);
    }

    let mergedCount = 0;
    let candidatePairsCount = 0;
    let skippedDueToCharging = 0;
    const pairs: ReconcilePair[] = [];

    for (const [vehicleId, vTrips] of byVehicle) {
      // Battery capacity for energy recalculation
      const vehicle = await this.prisma.vehicle.findUnique({
        where:   { id: vehicleId },
        include: { vehicleSpec: true },
      });
      const usableKwh =
        (vehicle as any)?.batteryCapacityDetected ??
        vehicle?.vehicleSpec?.batteryUsableKwh ??
        75;

      // Walk the sorted list; when we merge B into A, we stay at index i
      // so that A (now with B's endTime) can be compared to the next trip.
      for (let i = 0; i < vTrips.length - 1; i++) {
        const a = vTrips[i];
        const b = vTrips[i + 1];

        if (!a.endTime || !b.endTime) continue;

        const gapMs = b.startTime.getTime() - a.endTime.getTime();
        if (gapMs < 0) {
          // Negative gap = trips overlap. If B is fully contained within A it is a
          // duplicate (e.g. created by a backfill that missed A because A started
          // before the rebuild range). Delete B and continue with the next candidate.
          if (b.endTime && a.endTime && b.endTime <= a.endTime) {
            if (!opts.dryRun) {
              await this.prisma.$transaction(async (tx) => {
                await tx.tripPoint.deleteMany({ where: { tripId: b.id } });
                await tx.tripStats.deleteMany({ where: { tripId: b.id } });
                await tx.trip.delete({ where: { id: b.id } });
              });
            }
            this.logger.warn(`[Reconciler]${opts.dryRun ? ' [dry-run]' : ''} Deleted duplicate trip ${b.id} (fully contained within ${a.id})`);
            pairs.push({ vehicleId, keptTripId: a.id, removedTripId: b.id, gapSeconds: Math.round(gapMs / 1000), reason: 'duplicate_removed' });
            vTrips.splice(i + 1, 1);
            i--;
            mergedCount++;
          } else {
            this.logger.debug(`[SKIP] ${a.id}→${b.id} partial_overlap gap_ms=${Math.round(gapMs)}`);
          }
          continue;
        }
        if (gapMs > this.maxGapMs) {
          this.logger.debug(
            `[SKIP] ${a.id}→${b.id} gap_too_large gap_s=${Math.round(gapMs / 1000)} max_s=${Math.round(this.maxGapMs / 1000)}`,
          );
          continue;
        }

        // Time-plausible merge candidate — within the gap window, still subject to the
        // charging/proximity/signal-loss guards below before it actually merges.
        candidatePairsCount++;

        // SC / charging guard: never merge two trips if a significant charging session
        // (> 3 kWh) occurred between them. This covers Supercharger stops and home
        // charging between outings — cases where the gap is short but the trips are
        // genuinely distinct (the car was plugged in, not just parked).
        if (a.endTime && b.startTime) {
          const chargingBetween = await this.prisma.chargingSession.findFirst({
            where: {
              vehicleId: a.vehicleId,
              startTime: { gte: a.endTime,   lte: b.startTime },
              endTime:   { not: null },
              energyAddedKwh: { gte: 3 },
            },
            select: { id: true },
          });
          if (chargingBetween) {
            skippedDueToCharging++;
            this.logger.debug(
              `[SKIP] ${a.id}→${b.id} charging_session_between (session ${chargingBetween.id})`,
            );
            continue;
          }
        }

        if (gapMs > this.shortGapMs) {
          // Signal-loss guard: only merge if trip A ended while the car was MOVING.
          // Use the average of the last 3 GPS points so a momentary stop at a red light
          // (speed=0 on the last point) does not falsely classify a signal-loss split
          // as a genuine parking stop.
          const lastPointsOfA = await this.prisma.tripPoint.findMany({
            where:   { tripId: a.id },
            orderBy: { timestamp: 'desc' },
            take:    3,
            select:  { speed: true, timestamp: true },
          });
          const avgLastSpeedA = lastPointsOfA.length
            ? lastPointsOfA.reduce((sum, p) => sum + (p.speed ?? 0), 0) / lastPointsOfA.length
            : 0;
          if (avgLastSpeedA < 5) {
            this.logger.debug(
              `[SKIP] ${a.id}→${b.id} trip_A_ended_parked avgSpeed=${avgLastSpeedA.toFixed(1)} — genuine parking stop, not signal loss`,
            );
            continue;
          }

          const coords = await this.resolveMergeProximityCoords(a.id, b.id, a, b);
          if (!coords) {
            this.logger.debug(`[SKIP] ${a.id}→${b.id} missing_gps_after_trip_points_fallback`);
            continue;
          }
          const proximityKm = haversineKmMerge(coords.elat, coords.elon, coords.slat, coords.slon);
          if (proximityKm == null) {
            this.logger.debug(`[SKIP] ${a.id}→${b.id} invalid_coordinates_for_haversine`);
            continue;
          }
          if (proximityKm > this.maxProximityKm) {
            this.logger.debug(
              `[SKIP] ${a.id}→${b.id} proximity_check_failed d_km=${proximityKm.toFixed(2)} max_km=${this.maxProximityKm}`,
            );
            continue;
          }
        }

        const mergedDistance = (a.distanceKm ?? 0) + (b.distanceKm ?? 0);
        const socDrop        = (a.startSoc ?? 0) - (b.endSoc ?? a.startSoc ?? 0);
        const mergedEnergy   = socDrop > 1
          ? Math.round((socDrop / 100) * usableKwh * 100) / 100
          : null;
        const rawEff         = mergedDistance > 0 && mergedEnergy != null
          ? Math.round((mergedEnergy * 1000 / mergedDistance) * 10) / 10
          : null;
        const mergedEfficiency = rawEff != null && rawEff <= 600 ? rawEff : null;

        if (!opts.dryRun) {
          await this.prisma.$transaction(async (tx) => {
            // Re-parent trip B's points to trip A
            await tx.tripPoint.updateMany({
              where: { tripId: b.id },
              data: { tripId: a.id },
            });

            // Update trip A with merged values.
            // Reset reliability & repairReason so the post-processor re-runs on the merged trip
            // and recalculates distance (from odometer), energy, efficiency, and map matching.
            const reconcileAt = new Date(Date.now() + 120_000 + Math.random() * 480_000);
            await tx.trip.update({
              where: { id: a.id },
              data: {
                endTime: b.endTime,
                endSoc: b.endSoc,
                endLocation: b.endLocation,
                endLat: b.endLat,
                endLon: b.endLon,
                distanceKm: Math.round(mergedDistance * 10) / 10,
                energyUsedKwh: mergedEnergy,
                efficiencyWhkm: mergedEfficiency,
                reliability: null,
                repairReason: null,
                qualityScore: null,
                reconcileAt,
              },
            });

            // Delete trip B stats (FK) then trip B
            await tx.tripStats.deleteMany({ where: { tripId: b.id } });
            await tx.trip.delete({ where: { id: b.id } });
          });
        }

        this.logger.log(
          `[Reconciler]${opts.dryRun ? ' [dry-run]' : ''} Merged ${b.id} → ${a.id} ` +
          `(gap ${Math.round(gapMs / 1000)}s, ${mergedDistance.toFixed(1)} km merged)`,
        );

        pairs.push({ vehicleId, keptTripId: a.id, removedTripId: b.id, gapSeconds: Math.round(gapMs / 1000), reason: 'merged' });

        // Update in-memory record so the next loop iteration sees the merged trip
        vTrips[i] = {
          ...a,
          endTime:        b.endTime,
          endSoc:         b.endSoc,
          endLocation:    b.endLocation,
          distanceKm:     mergedDistance,
          energyUsedKwh:  mergedEnergy,
          efficiencyWhkm: mergedEfficiency,
        };
        vTrips.splice(i + 1, 1); // remove B
        i--;                      // re-check position i against new i+1
        mergedCount++;
      }
    }

    if (mergedCount > 0) {
      this.logger.log(`[Reconciler]${opts.dryRun ? ' [dry-run]' : ''} Total merged: ${mergedCount} trip pair(s)`);
    }

    return { merged: mergedCount, candidatePairs: candidatePairsCount, skippedDueToCharging, pairs };
  }

  /**
   * Конец A / начало B: сначала поля trip, при null — крайние trip_points (телеметрия Tesla в БД).
   */
  private async resolveMergeProximityCoords(
    tripAId: string,
    tripBId: string,
    a: { endLat: number | null; endLon: number | null },
    b: { startLat: number | null; startLon: number | null },
  ): Promise<{ elat: number; elon: number; slat: number; slon: number } | null> {
    let elat = a.endLat;
    let elon = a.endLon;
    let slat = b.startLat;
    let slon = b.startLon;

    if (elat == null || elon == null) {
      const last = await this.prisma.tripPoint.findFirst({
        where:   { tripId: tripAId },
        orderBy: { timestamp: 'desc' },
        select:  { latitude: true, longitude: true },
      });
      if (last?.latitude != null && last?.longitude != null) {
        elat = last.latitude as number;
        elon = last.longitude as number;
      }
    }
    if (slat == null || slon == null) {
      const first = await this.prisma.tripPoint.findFirst({
        where:   { tripId: tripBId },
        orderBy: { timestamp: 'asc' },
        select:  { latitude: true, longitude: true },
      });
      if (first?.latitude != null && first?.longitude != null) {
        slat = first.latitude as number;
        slon = first.longitude as number;
      }
    }

    if (elat == null || elon == null || slat == null || slon == null) return null;
    return { elat, elon, slat, slon };
  }
}
