import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TripPostProcessorService } from './trip-post-processor.service';
import { TripDetectorService } from './trip-detector.service';
import { TripReconcilerService } from './trip-reconciler.service';
import { isWorkerRole } from '../runtime/runtime-role';
import { appendRepairTag } from './repair-tag.utils';

/**
 * TripCleanupService
 *
 * Periodically deletes "phantom" trips — detector artefacts:
 *   - distance < 300 m (parking manoeuvre, U-turn)
 *   - duration < 60 s
 *   - SOC rose ≥5% at distance < 2 km (charging noise)
 *
 * Runs every 6 hours and only considers trips older than 5 min
 * (to avoid deleting an active trip).
 */
@Injectable()
export class TripCleanupService {
  private readonly logger = new Logger(TripCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postProcessor: TripPostProcessorService,
    private readonly tripReconciler: TripReconcilerService,
  ) {}

  @Cron('0 */6 * * *')
  async cleanupPhantomTrips(): Promise<void> {
    if (!isWorkerRole()) return;
    const { deleted } = await this.runManual();
    if (deleted > 0) {
      this.logger.log(`Phantom trip cleanup: removed ${deleted} trips`);
    }
  }

  /** Auto-repair: rate and repair trips that are missing a reliability score.
   *  Runs every 10 min — lightweight, processes at most 200 trips per run. */
  @Cron('*/10 * * * *')
  async autoRepairTrips(): Promise<void> {
    if (!isWorkerRole()) return;
    const { processed } = await this.postProcessor.processUnrated();
    if (processed > 0) {
      this.logger.log(`Auto-repair: processed ${processed} unrated trips`);
    }
  }

  /**
   * P1 phase-2: delayed reconciliation — trips with reconcileAt <= now get a full post-processor pass.
   * Runs every minute; capped batch to avoid spikes.
   */
  @Cron('* * * * *')
  async reconcileScheduledTrips(): Promise<void> {
    if (!isWorkerRole()) return;
    const now = new Date();
    const due = await this.prisma.trip.findMany({
      where: {
        reconcileAt: { lte: now },
        endTime:     { not: null },
      },
      select: { id: true },
      take:   40,
      orderBy: { reconcileAt: 'asc' },
    });
    if (!due.length) return;

    for (const { id } of due) {
      try {
        await this.postProcessor.processTripById(id);
        await this.prisma.trip.update({
          where: { id },
          data: { reconcileAt: null },
        });
      } catch (e: any) {
        this.logger.warn(`Reconcile phase-2 failed for ${id}: ${e?.message ?? e}`);
        await this.prisma.trip.update({
          where: { id },
          data: { reconcileAt: new Date(Date.now() + 2 * 60_000) },
        }).catch(() => {});
      }
    }
    this.logger.log(`P1 reconcile: processed ${due.length} trip(s)`);
  }

  /**
   * Auto-merge: find consecutive trips that should be one trip (signal loss mid-drive).
   *
   * Merges pair A→B if:
   *   - gap between A.endTime and B.startTime < 10 min
   *   - end of A → start of B distance < 2 km
   *   - both trips belong to same vehicle
   *
   * Merge: copy B's points to A, update A's end fields, delete B.
   * Runs every hour — heavier operation, caps at 20 merges per run.
   */
  @Cron('0 * * * *')
  async autoMergeTrips(): Promise<void> {
    if (!isWorkerRole()) return;
    const { merged } = await this.runMerge();
    if (merged > 0) {
      this.logger.log(`Auto-merge: merged ${merged} trip pairs`);
    }
  }

  /**
   * Hourly auto-merge delegates to {@link TripReconcilerService} (same rules as the 5‑minute reconciler).
   * `days=2` — deliberately narrow: this cron only needs to heal recent splits (signal
   * loss, detector restarts). Actual cross-day false-merge safety now comes primarily
   * from the reconciler's own `maxGapMs` (10 min, see trip-merge-params.ts) — two trips
   * separated by hours/days never satisfy that gap regardless of scan window size. The
   * narrow window here is mainly about scope/performance for the hourly job; the
   * 30-day-capable `runManual`/`POST .../reconcile` endpoint exists for wider manual healing.
   */
  async runMerge(vehicleId?: string): Promise<{ merged: number }> {
    return this.tripReconciler.runManual(vehicleId, 2);
  }

  /**
   * Stale open trip watchdog — runs every 20 minutes.
   *
   * A trip is "stale" if:
   *   - endTime IS NULL (still open)
   *   - startTime > 2 hours ago (not just started)
   *   - the vehicle's latest telemetry point is > 30 min old AND shows speed = 0
   *     OR the trip is > 6 hours old (unconditional force-close)
   *
   * Closes the trip at the timestamp of the last known telemetry point.
   * These trips arise from telemetry gaps — the detector never received
   * the "speed=0, power=0" point that would normally finalize the trip.
   */
  @Cron('*/20 * * * *')
  async closeStaleOpenTrips(): Promise<void> {
    if (!isWorkerRole()) return;
    // 30-min minimum: safe because staleEnough already requires telemetry to be
    // > 30 min old AND speed ≤ 2. The previous 2-hour threshold left trips open
    // for 2+ hours when the car slept shortly after parking (e.g. 30-min trip).
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000);
    const sixHoursAgo  = new Date(Date.now() - 6 * 60 * 60_000);

    const staleTrips = await this.prisma.trip.findMany({
      where: { endTime: null, startTime: { lt: thirtyMinAgo } },
      orderBy: { startTime: 'asc' },
      take: 50,
    });

    let closed = 0;
    for (const trip of staleTrips) {
      // Get the latest telemetry point for this vehicle
      const latest = await this.prisma.$queryRaw<Array<{ ts: Date; speed: number | null; soc: number | null }>>`
        SELECT timestamp AS ts, speed, soc
        FROM telemetry_points
        WHERE "vehicleId" = ${trip.vehicleId}
        ORDER BY timestamp DESC
        LIMIT 1
      `;
      const latestPoint = latest[0];
      // Fallback to telemetry_raw when parsed telemetry_points are stale/missing.
      // This prevents hanging open trips during parser outages.
      let fallbackRaw: { ts: Date; speed: number | null; soc: number | null } | null = null;
      if (!latestPoint) {
        const raw = await this.prisma.$queryRaw<Array<{ ts: Date; speed: number | null; soc: number | null }>>`
          SELECT "receivedAt" AS ts,
                 NULLIF(payload->>'speed','')::double precision AS speed,
                 NULLIF(payload->>'soc','')::double precision   AS soc
          FROM telemetry_raw
          WHERE "vehicleId" = ${trip.vehicleId}
          ORDER BY "receivedAt" DESC
          LIMIT 1
        `;
        fallbackRaw = raw[0] ?? null;
      }

      const sourcePoint = latestPoint ?? fallbackRaw;
      const latestAge   = sourcePoint ? Date.now() - sourcePoint.ts.getTime() : Infinity;
      const staleEnough = latestAge > 30 * 60_000 || trip.startTime < sixHoursAgo;
      // In economy mode (reduced polling), the last telemetry may show speed > 2 (car was
      // still moving when last polled), even though the car has been parked for 40+ min.
      // Key insight: FORCE_END_GAP_MS = 10 min. If no telemetry for > 15 min, the detector
      // would have force-ended the trip had any telemetry arrived. Silence > 15 min = car
      // is asleep / parked. Safe to treat as stopped without requiring speed < 2.
      const telemetrySilentTooLong = latestAge > 15 * 60_000;
      const carStopped  = !sourcePoint || (sourcePoint.speed ?? 0) < 2 || telemetrySilentTooLong;

      if (staleEnough && carStopped) {
        // Use the last MOVING telemetry point as endTime instead of the latest parked point.
        // Using latest telemetry inflates trip duration by hours of parked time.
        // If no moving point found, fall back to trip startTime + a small buffer.
        const lastMoving = await this.prisma.$queryRaw<Array<{ ts: Date; soc: number | null }>>`
          SELECT timestamp AS ts, soc
          FROM telemetry_points
          WHERE "vehicleId" = ${trip.vehicleId}
            AND speed > 2
            AND timestamp >= ${trip.startTime}
          ORDER BY timestamp DESC
          LIMIT 1
        `;
        const endPoint = lastMoving[0] ?? sourcePoint;
        const endTime  = endPoint?.ts ?? new Date();
        const watchdogTag = sourcePoint ? 'force_closed_stale_watchdog' : 'force_closed_stale_watchdog_no_point';
        const repairTags  = appendRepairTag((trip as any).repairTags, watchdogTag, 'watchdog');
        await this.prisma.trip.update({
          where: { id: trip.id },
          data: {
            endTime,
            endSoc:       (sourcePoint?.soc ?? endPoint?.soc) ?? null,
            repairReason: watchdogTag,
            repairTags:   repairTags as any,
            reconcileAt:  TripDetectorService.scheduleTripReconcileAt(),
          },
        });
        this.logger.warn(
          `[Watchdog] Force-closed stale trip ${trip.id} (vehicle ${trip.vehicleId}) ` +
          `started ${trip.startTime.toISOString()}, endTime=${endTime.toISOString()}`,
        );
        closed++;
      }
    }
    if (closed > 0) this.logger.log(`[Watchdog] Closed ${closed} stale open trip(s)`);
  }

  /**
   * Stale open charging session watchdog — runs every 20 minutes.
   *
   * Closes charging sessions that have been open > 4 hours but the car is
   * no longer charging. "No longer charging" means:
   *   - power has been < 0.5 kW for the last 10 min (handles 2kW home chargers),
   *     OR charging_state ≠ 'Charging' in the latest telemetry.
   *   - OR car is driving (speed > 5 km/h)
   *   - OR session > 8 hours old (unconditional force-close)
   *
   * NOTE: The old threshold (|power| < 5 kW) incorrectly closed 2kW home
   * chargers every 2 hours. The correct floor is 0.5 kW (our PAUSE_THRESHOLD).
   * We also require the power to be low for at least 10 min (3 consecutive
   * parked points) to avoid false-closing during brief BMS pauses.
   */
  @Cron('*/20 * * * *')
  async closeStaleChargingSessions(): Promise<void> {
    if (!isWorkerRole()) return;
    // Raise minimum age to 4 h — home chargers (2kW) may run for 6–12 h.
    // Exception: sessions where the most recent telemetry shows a terminal state
    // (Disconnected/Complete/Stopped) can be closed immediately regardless of age.
    const fourHoursAgo  = new Date(Date.now() - 4 * 60 * 60_000);
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60_000);
    const thirtyMinAgo  = new Date(Date.now() - 30 * 60_000);

    // Include sessions ≥ 30 min old — terminal state check below will skip young active sessions
    const staleSessions = await this.prisma.chargingSession.findMany({
      where: { endTime: null, startTime: { lt: thirtyMinAgo } },
      take: 20,
    });

    let closed = 0;
    for (const session of staleSessions) {
      // Read last 3 telemetry points to check sustained power-off (10+ min window).
      // NOTE: column names follow Prisma camelCase convention ("chargingState", not "charging_state").
      const recent = await this.prisma.$queryRaw<Array<{ ts: Date; speed: number | null; power: number | null; soc: number | null; chargingState: string | null }>>`
        SELECT timestamp AS ts, speed, power, soc, "chargingState"
        FROM telemetry_points
        WHERE "vehicleId" = ${session.vehicleId}
        ORDER BY timestamp DESC
        LIMIT 3
      `;
      if (!recent.length) continue;
      const pt = recent[0];

      // Car is driving — definitely not charging
      const isDriving = (pt.speed ?? 0) > 5;

      // Power sustainedly low: all 3 recent points show < 0.5 kW (not just a BMS pause)
      const allLowPower = recent.every(r => Math.abs(r.power ?? 0) < 0.5);

      // Charging state explicitly ended (prefer BMS signal over power heuristic)
      const stateEnded = pt.chargingState != null &&
        pt.chargingState !== 'Charging' && pt.chargingState !== 'NoPower';

      // Unconditional close for very old sessions
      const forceClose = session.startTime < eightHoursAgo;

      // For young sessions (< 4h): only close if we have a terminal state signal.
      // For old sessions: close on any "not charging" signal.
      const isYoungSession = session.startTime >= fourHoursAgo;
      const notCharging = isDriving || stateEnded || (!isYoungSession && allLowPower && recent.length >= 3);

      if (notCharging || forceClose) {
        // Use the last point where power was still meaningful as endTime.
        const lastChargingPt = await this.prisma.$queryRaw<Array<{ ts: Date; soc: number | null }>>`
          SELECT timestamp AS ts, soc
          FROM telemetry_points
          WHERE "vehicleId" = ${session.vehicleId}
            AND ABS(power) >= 0.5
            AND timestamp >= ${session.startTime}
          ORDER BY timestamp DESC
          LIMIT 1
        `;
        const endPt  = lastChargingPt[0] ?? pt;
        const energy = await this.estimateChargingEnergy(session.vehicleId, session.startTime, endPt.ts);
        await this.prisma.chargingSession.update({
          where: { id: session.id },
          data: {
            endTime:        endPt.ts,
            endSoc:         endPt.soc ?? pt.soc ?? null,
            energyAddedKwh: energy > 0 ? Math.round(energy * 100) / 100 : undefined,
            maxPowerKw:     session.maxPowerKw ?? undefined,
          },
        });
        this.logger.warn(
          `[Watchdog] Force-closed stale charging session ${session.id} ` +
          `(vehicle ${session.vehicleId}) started ${session.startTime.toISOString()}, ` +
          `endTime=${endPt.ts.toISOString()}, energy=${energy.toFixed(2)} kWh`,
        );
        closed++;
      }
    }
    if (closed > 0) this.logger.log(`[Watchdog] Closed ${closed} stale charging session(s)`);
  }

  /**
   * Estimate energy added during a charging window.
   *
   * Priority:
   *   1. chargeEnergyAdded delta from telemetry_points (Tesla BMS counter, most accurate)
   *   2. SOC delta × battery capacity (fallback)
   */
  private async estimateChargingEnergy(vehicleId: string, from: Date, to: Date): Promise<number> {
    // 1. Try Tesla's onboard charger energy counter (stored since we added the column)
    const ceaRows = await this.prisma.$queryRaw<Array<{ cea: number | null }>>`
      SELECT "chargeEnergyAdded" AS cea
      FROM telemetry_points
      WHERE "vehicleId" = ${vehicleId}
        AND timestamp >= ${from} AND timestamp <= ${to}
        AND "chargeEnergyAdded" IS NOT NULL
      ORDER BY timestamp ASC
      LIMIT 1
    `;
    const ceaEnd = await this.prisma.$queryRaw<Array<{ cea: number | null }>>`
      SELECT "chargeEnergyAdded" AS cea
      FROM telemetry_points
      WHERE "vehicleId" = ${vehicleId}
        AND timestamp >= ${from} AND timestamp <= ${to}
        AND "chargeEnergyAdded" IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const ceaStart = ceaRows[0]?.cea;
    const ceaFinal = ceaEnd[0]?.cea;
    if (ceaStart != null && ceaFinal != null && ceaFinal > ceaStart) {
      return ceaFinal - ceaStart;
    }

    // 2. SOC delta × battery capacity fallback
    const pts = await this.prisma.$queryRaw<Array<{ soc: number | null }>>`
      SELECT soc FROM telemetry_points
      WHERE "vehicleId" = ${vehicleId}
        AND timestamp >= ${from} AND timestamp <= ${to}
        AND soc IS NOT NULL
      ORDER BY timestamp ASC
      LIMIT 1
    `;
    const endPts = await this.prisma.$queryRaw<Array<{ soc: number | null }>>`
      SELECT soc FROM telemetry_points
      WHERE "vehicleId" = ${vehicleId}
        AND timestamp >= ${from} AND timestamp <= ${to}
        AND soc IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 1
    `;
    const startSoc = pts[0]?.soc;
    const endSoc   = endPts[0]?.soc;
    if (startSoc == null || endSoc == null || endSoc <= startSoc) return 0;

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleSpec: true },
    });
    const usableKwh =
      (vehicle as any)?.batteryCapacityDetected ??
      vehicle?.vehicleSpec?.batteryUsableKwh ??
      75;

    return ((endSoc - startSoc) / 100) * usableKwh;
  }

  async runManual(vehicleId?: string): Promise<{ deleted: number }> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);

    const candidates = await this.prisma.trip.findMany({
      where: {
        ...(vehicleId ? { vehicleId } : {}),
        endTime:   { not: null },
        startTime: { lt: fiveMinutesAgo },
        OR: [
          { distanceKm: { lt: 0.3 } },
          { distanceKm: { lt: 2.0 }, startSoc: { not: null }, endSoc: { not: null } },
        ],
      },
      select: { id: true, distanceKm: true, startSoc: true, endSoc: true, startTime: true, endTime: true },
    });

    const toDelete: string[] = [];

    for (const trip of candidates) {
      if ((trip.distanceKm ?? 0) < 0.3) {
        toDelete.push(trip.id);
        continue;
      }

      const durationMs = trip.endTime
        ? trip.endTime.getTime() - trip.startTime.getTime()
        : null;
      if (durationMs !== null && durationMs < 60_000) {
        toDelete.push(trip.id);
        continue;
      }

      if (
        trip.startSoc != null &&
        trip.endSoc   != null &&
        trip.endSoc - trip.startSoc >= 5 &&
        (trip.distanceKm ?? 0) < 2.0
      ) {
        toDelete.push(trip.id);
      }
    }

    if (!toDelete.length) return { deleted: 0 };

    await this.prisma.tripPoint.deleteMany({ where: { tripId: { in: toDelete } } });
    await this.prisma.trip.deleteMany({ where: { id: { in: toDelete } } });

    return { deleted: toDelete.length };
  }

  /**
   * Repair "bloated" trips where endTime is much later than the last real GPS point.
   *
   * Root cause: the force-end logic used to set endTime = now when data.speed > 10,
   * but data.speed came from the NEXT trip's first telemetry point (car driving again
   * after a long parking break). This inflated trip duration by hours and caused the
   * reconciler to merge genuinely separate trips.
   *
   * Fix: for each closed trip where endTime is > 20 min after the last trip_point,
   * set endTime = last moving trip_point timestamp (speed > 2), then schedule
   * post-processor to re-compute distance/energy/efficiency.
   *
   * Runs automatically every hour on trips from the last 3 days.
   * Also exposed as a manual endpoint for on-demand repair.
   */
  // Endtime repair is now scheduled by SystemMaintenanceCronService (every hour).
  async repairBloatedEndTimesAuto(): Promise<void> {
    if (!isWorkerRole()) return;
    const { repaired } = await this.repairBloatedEndTimes(undefined, 3);
    if (repaired > 0) {
      this.logger.log(`[EndTimeRepair] Repaired ${repaired} trip(s) with bloated endTime`);
    }
  }

  async repairBloatedEndTimes(
    vehicleId?: string,
    days = 3,
  ): Promise<{ repaired: number }> {
    const since = new Date(Date.now() - days * 86_400_000);

    // Find closed trips potentially affected — duration > 2h is a conservative filter
    // (most legitimate trips are < 2h; a 4h57m trip is a red flag).
    const candidates = await this.prisma.trip.findMany({
      where: {
        ...(vehicleId ? { vehicleId } : {}),
        endTime:   { not: null },
        startTime: { gte: since },
      },
      select: {
        id: true,
        vehicleId: true,
        startTime: true,
        endTime: true,
        repairTags: true,
      },
    });

    let repaired = 0;
    for (const trip of candidates) {
      if (!trip.endTime) continue;

      // Find the last trip_point with speed > 2 (actually moving)
      const lastMoving = await this.prisma.$queryRaw<Array<{ ts: Date; soc: number | null }>>`
        SELECT timestamp AS ts, soc
        FROM trip_points
        WHERE "tripId" = ${trip.id}
          AND speed > 2
        ORDER BY timestamp DESC
        LIMIT 1
      `;
      if (!lastMoving.length) continue;

      const lastPointTs = lastMoving[0].ts;
      const bloatMs = trip.endTime.getTime() - lastPointTs.getTime();

      // Only repair if endTime is > 20 min after last real moving point.
      // 20 min is conservative: stops at Supercharger, traffic, STOPPING timeout
      // (city=4 min, highway=8 min) are all < 20 min. Genuine 20+ min bloat = bug.
      if (bloatMs <= 20 * 60_000) continue;

      const repairTags = appendRepairTag(
        (trip as any).repairTags,
        `endtime_repaired_bloat_${Math.round(bloatMs / 60_000)}min`,
        'endtime_repair',
      );

      await this.prisma.trip.update({
        where: { id: trip.id },
        data: {
          endTime:      lastPointTs,
          repairReason: 'endtime_repaired_bloat',
          repairTags:   repairTags as any,
          reconcileAt:  TripDetectorService.scheduleTripReconcileAt(),
          // Reset quality so post-processor re-runs
          reliability:  null,
          qualityScore: null,
        },
      });

      this.logger.log(
        `[EndTimeRepair] Trip ${trip.id}: endTime corrected from ${trip.endTime.toISOString()} ` +
        `→ ${lastPointTs.toISOString()} (bloat was ${Math.round(bloatMs / 60_000)} min)`,
      );
      repaired++;
    }

    return { repaired };
  }
}
