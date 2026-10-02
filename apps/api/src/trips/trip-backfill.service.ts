import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TripDetectorService } from './trip-detector.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { TripReconcilerService } from './trip-reconciler.service';
import { DistributedLockService } from '../common/services/distributed-lock.service';
import { tripRebuildMaxRangeDays } from './trip-merge-params';
import { normalizeRawTelemetryPayload } from '../telemetry/raw-telemetry-payload';

/** Full rebuild: delete → detect → filter → reconcile, all executed for real. */
export interface RebuildTripsResult {
  status: 'completed' | 'partial';
  dryRun: false;
  rangeStart: string;
  rangeEnd: string;
  // Legacy fields — kept as-is, the web UI reads these directly (trips/page.tsx).
  deleted: number;
  processed: number;
  socUpFiltered: number;
  // Structured summary
  detected: number;
  created: number;
  filtered: number;
  reconciled: boolean;
  merged: number;
  skippedDueToCharging: number;
  warnings: string[];
}

/**
 * dryRun result. IMPORTANT: this does NOT simulate trip detection/re-splitting — it only
 * previews reconciliation of trips that *currently exist* in the range. A true full-rebuild
 * simulation (replay telemetry → detect → filter → reconcile, all in-memory) would require
 * either duplicating TripDetectorService's ~1900-line, deeply Prisma-coupled state machine
 * (trip.create/update/delete, tripPoint writes, Redis-backed detector-cache persistence,
 * geocoding, event/telemetry-gateway emits interleaved throughout) or refactoring it behind
 * an in-memory persistence adapter — both too large to do safely as part of this fix.
 * `previewKind` makes that limitation explicit in the response so callers can't mistake
 * this for a full-rebuild forecast. See trip-backfill.service.ts's `reconcilePreview()`.
 */
export interface ReconcilePreviewResult {
  previewKind: 'reconcile_existing_only';
  status: 'dry_run';
  dryRun: true;
  rangeStart: string;
  rangeEnd: string;
  /** trips currently in range — what a real rebuild would delete before re-detecting */
  existingTrips: number;
  /** adjacent pairs within the max-gap time window (before charging/proximity guards) */
  candidatePairs: number;
  /** pairs that would actually merge if reconciliation ran now, on today's trips */
  mergeablePairs: number;
  skippedDueToCharging: number;
  warnings: string[];
}

@Injectable()
export class TripBackfillService {
  private readonly logger = new Logger(TripBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tripDetector: TripDetectorService,
    private readonly geocoding: GeocodingService,
    private readonly tripReconciler: TripReconcilerService,
    private readonly lock: DistributedLockService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Delete existing trips in the date range and rebuild them from telemetry_points.
   *
   * Unlike plain backfill, this is safe to run on a range that already has trips —
   * it wipes them first so no duplicates are created. Use this to fix days where the
   * detector produced wrong trips (merges, inflated endTime, missing splits).
   *
   * Steps:
   *   1. Delete all trips (+ points, stats) that started in [from, to]
   *   2. Reset the in-memory detector state for the vehicle so it starts clean
   *   3. Run backfill from telemetry_points — this re-SPLITS trips but never merges them
   *   4. Run TripReconcilerService over the same [from, to] range to re-merge fragments
   *      (signal-loss splits, short stops) — background reconcile crons only look at
   *      windows relative to "now" and never reach a historical range like this one.
   *
   * Pass `{ dryRun: true }` for a **reconcile-only** preview — see `reconcilePreview()`'s
   * doc comment for exactly what that does and doesn't simulate.
   *
   * Hardening: [from, to] is capped at `tripRebuildMaxRangeDays()` (resource protection,
   * not billing) and the real (non-dryRun) path is serialized per-vehicle via a Redis
   * lock — a second concurrent real rebuild for the same vehicle is rejected with 409
   * rather than racing on the same delete/insert range.
   */
  async rebuildTrips(
    vehicleId: string,
    from: Date,
    to: Date = new Date(),
    opts: { dryRun?: boolean } = {},
  ): Promise<RebuildTripsResult | ReconcilePreviewResult> {
    this.assertRangeWithinLimit(from, to);

    if (opts.dryRun) {
      return this.reconcilePreview(vehicleId, from, to);
    }

    const rangeStart = from.toISOString();
    const rangeEnd = to.toISOString();

    const lockKey = `trip-rebuild-lock:${vehicleId}`;
    const lockToken = await this.lock.tryAcquire(lockKey, 600 /* 10 min — generous for a large range */);
    if (!lockToken) {
      // Generic message deliberately — no vehicleId in the client-facing error. The
      // endpoint is already JWT + ownership-gated, so this isn't a real leak today, but
      // avoids echoing internal identifiers into responses/screenshots/client logs
      // (relevant once this becomes multi-tenant SaaS).
      throw new ConflictException('A rebuild is already in progress for this vehicle.');
    }

    try {
      this.logger.log(`[Rebuild] Deleting trips for ${vehicleId} from ${rangeStart} to ${rangeEnd}`);

      // Delete all trips that OVERLAP the [from, to] range — not just trips that started
      // within it. A trip that started before `from` but ended inside the range would
      // survive the old startTime >= from filter and cause duplicate overlapping records
      // after the backfill replay creates new trips for the same telemetry window.
      const existingTrips = await this.prisma.trip.findMany({
        where: {
          vehicleId,
          AND: [
            { startTime: { lte: to } },
            { OR: [{ endTime: { gte: from } }, { endTime: null }] },
          ],
        },
        select: { id: true },
      });
      const ids = existingTrips.map(t => t.id);

      if (ids.length > 0) {
        await this.prisma.tripPoint.deleteMany({ where: { tripId: { in: ids } } });
        await this.prisma.tripStats.deleteMany({ where: { tripId: { in: ids } } });
        await this.prisma.trip.deleteMany({ where: { id: { in: ids } } });
        this.logger.log(`[Rebuild] Deleted ${ids.length} trip(s)`);
      }

      // Reset in-memory detector state so it doesn't carry over stale DRIVING/STOPPING state
      await this.tripDetector.resetVehicleState(vehicleId);

      // Prefer raw telemetry (has shift_state + higher resolution) when available
      const hasRaw = await this.prisma.telemetryRaw.count({
        where: { vehicleId, receivedAt: { gte: from, lte: to } },
      }).then(n => n > 0);

      const result = hasRaw
        ? await this.backfillFromRawTelemetry(vehicleId, from, to)
        : await this.backfillVehicleTrips(vehicleId, from, to);

      const filtered = result.socUpFiltered;
      const created = await this.prisma.trip.count({
        where: { vehicleId, startTime: { gte: from, lte: to } },
      });
      const detected = created + filtered;

      const warnings: string[] = [];
      let reconciled = false;
      let merged = 0;
      let skippedDueToCharging = 0;

      try {
        const reconcileResult = await this.tripReconciler.reconcileRange(vehicleId, from, to);
        reconciled = true;
        merged = reconcileResult.merged;
        skippedDueToCharging = reconcileResult.skippedDueToCharging;
        this.logger.log(
          `[Rebuild] Reconciled ${vehicleId} ${rangeStart}→${rangeEnd}: merged=${merged} skippedDueToCharging=${skippedDueToCharging}`,
        );
      } catch (e: any) {
        // Detection + filtering already succeeded and is valid on its own — a failed merge
        // pass is a degraded-but-safe partial result, not data corruption. Surface it
        // explicitly rather than reporting a silent "completed".
        const msg = `Reconciliation failed after rebuild: ${e?.message ?? e}`;
        this.logger.error(`[Rebuild] ${msg}`);
        warnings.push(msg);
      }

      return {
        status: reconciled ? 'completed' : 'partial',
        dryRun: false,
        rangeStart,
        rangeEnd,
        deleted: ids.length,
        processed: result.processed,
        socUpFiltered: filtered,
        detected,
        created,
        filtered,
        reconciled,
        merged,
        skippedDueToCharging,
        warnings,
      };
    } finally {
      await this.lock.releaseIfHeld(lockKey, lockToken);
    }
  }

  /**
   * Preview of reconciliation over trips that **currently exist** in the range — NOT a
   * simulation of the full rebuild pipeline (delete → detect → filter → reconcile).
   *
   * `previewKind: 'reconcile_existing_only'` documents that limitation on every response
   * so a caller can't mistake this for a rebuild forecast. A true full-rebuild dry run
   * (replay telemetry → detect → filter → reconcile, all in-memory, zero writes) would
   * need TripDetectorService itself to support a non-persisting mode — that's a real,
   * separately-scoped piece of work (see the class-level doc comment on
   * `ReconcilePreviewResult`), not something to fake here. When that exists, it should
   * ship as its own `rebuildPreview()` with `previewKind: 'full_rebuild'`.
   *
   * No writes: only `trip.findMany` (read) and `TripReconcilerService.reconcileRange`
   * called with `{ dryRun: true }`, which itself performs zero Prisma writes.
   */
  private async reconcilePreview(vehicleId: string, from: Date, to: Date): Promise<ReconcilePreviewResult> {
    const rangeStart = from.toISOString();
    const rangeEnd = to.toISOString();

    const existingTrips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        AND: [
          { startTime: { lte: to } },
          { OR: [{ endTime: { gte: from } }, { endTime: null }] },
        ],
      },
      select: { id: true },
    });

    const warnings: string[] = [
      'This preview only reconciles trips that currently exist in the range — it does ' +
      'NOT simulate telemetry re-detection/re-splitting. A real rebuild deletes and ' +
      're-detects trips from scratch first, which can produce different fragments than ' +
      'what this preview evaluated.',
    ];

    let candidatePairs = 0;
    let mergeablePairs = 0;
    let skippedDueToCharging = 0;
    try {
      const preview = await this.tripReconciler.reconcileRange(vehicleId, from, to, { dryRun: true });
      candidatePairs = preview.candidatePairs;
      mergeablePairs = preview.merged;
      skippedDueToCharging = preview.skippedDueToCharging;
    } catch (e: any) {
      const msg = `Reconciliation preview failed: ${e?.message ?? e}`;
      this.logger.error(`[ReconcilePreview] ${msg}`);
      warnings.push(msg);
    }

    return {
      previewKind: 'reconcile_existing_only',
      status: 'dry_run',
      dryRun: true,
      rangeStart,
      rangeEnd,
      existingTrips: existingTrips.length,
      candidatePairs,
      mergeablePairs,
      skippedDueToCharging,
      warnings,
    };
  }

  private assertRangeWithinLimit(from: Date, to: Date): void {
    const maxDays = tripRebuildMaxRangeDays(this.config);
    const spanMs = to.getTime() - from.getTime();
    if (spanMs > maxDays * 86_400_000) {
      throw new BadRequestException(
        `Requested range spans more than ${maxDays} days — split into smaller requests.`,
      );
    }
  }

  /**
   * Rebuild trips by replaying telemetry_raw payloads through the trip detector.
   * This is preferred over telemetry_points because:
   *   - telemetry_raw has higher resolution (Fleet Telemetry at ~10s intervals)
   *   - payloads include shift_state which enables accurate trip splitting
   *   - telemetry_points is downsampled and loses short-stop events
   */
  async backfillFromRawTelemetry(
    vehicleId: string,
    from: Date,
    to: Date = new Date(),
  ): Promise<{ processed: number; socUpFiltered: number }> {
    this.logger.log(`[RawRebuild] Replaying telemetry_raw for ${vehicleId} from ${from.toISOString()} to ${to.toISOString()}`);

    const batchSize = 2000;
    let totalProcessed = 0;
    const seenTimestamps = new Set<string>();
    let lastId: string | undefined;

    while (true) {
      const rows = await this.prisma.telemetryRaw.findMany({
        where: {
          vehicleId,
          receivedAt: { gte: from, lte: to },
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: { id: true, receivedAt: true, payload: true, payloadKind: true },
      });

      if (!rows.length) break;

      for (const row of rows) {
        const rawPayload = typeof row.payload === 'string' ? JSON.parse(row.payload as string) : row.payload;
        // Dispatches on payloadKind: legacy rows are already DTO-shaped, new Fleet
        // Telemetry rows hold the original Tesla event and get normalizeTeslaPayload()
        // run on them here — see raw-telemetry-payload.ts.
        const p = normalizeRawTelemetryPayload(rawPayload, row.payloadKind);
        if (!p) continue;
        const ts: string = p.timestamp ?? row.receivedAt.toISOString();

        // Dedup by payload timestamp — raw table has multiple copies per event
        if (seenTimestamps.has(ts)) continue;
        seenTimestamps.add(ts);

        const speed = p.speed ?? 0;
        const power = p.power ?? 0;

        // Infer charging state the same way as regular backfill
        const inferredCharging = (speed < 3 && power >= 7);
        const inferredChargingState = p.charging_state ?? (inferredCharging ? 'Charging' : undefined);

        await this.tripDetector.checkTripState(vehicleId, {
          timestamp:      ts,
          speed:          p.speed     ?? undefined,
          power:          p.power     ?? undefined,
          latitude:       p.latitude  ?? undefined,
          longitude:      p.longitude ?? undefined,
          odometer:       p.odometer  ?? undefined,
          soc:            p.soc       ?? undefined,
          charging_state: inferredChargingState,
          shift_state:    p.shift_state ?? undefined,
          charge_energy_added: p.charge_energy_added ?? null,
        });

        totalProcessed++;
      }

      lastId = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }

    this.logger.log(`[RawRebuild] Completed for ${vehicleId}: replayed ${totalProcessed} unique raw points`);

    const socUpFiltered = await this.filterAnomalousTrips(vehicleId, from, to);
    if (socUpFiltered > 0) {
      this.logger.warn(`[RawRebuild] Removed ${socUpFiltered} anomalous trip(s) for ${vehicleId}`);
    }

    return { processed: totalProcessed, socUpFiltered };
  }

  /**
   * Backfill trips for a vehicle from raw telemetry_points.
   * WARNING: assumes trips table is either empty for this range,
   * or that duplicates are acceptable for initial migration.
   */
  async backfillVehicleTrips(
    vehicleId: string,
    from: Date,
    to: Date = new Date(),
  ): Promise<{ processed: number; socUpFiltered: number }> {
    this.logger.log(
      `Backfilling trips for vehicle ${vehicleId} from ${from.toISOString()} to ${to.toISOString()}`,
    );

    const batchSize = 2000;
    let cursor: Date | null = from;
    let totalProcessed = 0;
    let prevSoc: number | null = null;
    let prevTs: Date | null = null;

    while (true) {
      const points = await this.prisma.telemetryPoint.findMany({
        where: {
          vehicleId,
          timestamp: {
            gte: cursor,
            lte: to,
          },
        },
        orderBy: { timestamp: 'asc' },
        take: batchSize,
      });

      if (!points.length) break;

      for (const p of points) {
        const speed = p.speed ?? 0;
        const power = p.power ?? 0;
        const soc = p.soc ?? null;
        const socUp = soc != null && prevSoc != null ? soc - prevSoc : 0;
        const dtSec = prevTs ? Math.max(1, Math.round((p.timestamp.getTime() - prevTs.getTime()) / 1000)) : null;

        // Hard split rule for historical backfill:
        // infer charging transition when we see stationary/high-power charging
        // or a fast SOC increase while not moving.
        const inferredCharging =
          (speed < 3 && power >= 7) ||
          (dtSec != null && dtSec <= 15 * 60 && speed < 5 && socUp >= 1.0);
        const inferredChargingState = inferredCharging ? 'Charging' : undefined;

        await this.tripDetector.checkTripState(vehicleId, {
          // TripDetector ожидает ISO‑строку, конвертируем Date → string
          timestamp: p.timestamp.toISOString(),
          speed:     p.speed     ?? undefined,
          power:     p.power     ?? undefined,
          latitude:  p.latitude  ?? undefined,
          longitude: p.longitude ?? undefined,
          odometer:  p.odometer  ?? undefined,
          soc:       p.soc       ?? undefined,
          charging_state: inferredChargingState,
          shift_state: (p as any).shiftState ?? undefined,
        });

        prevSoc = soc;
        prevTs = p.timestamp;
      }

      totalProcessed += points.length;
      cursor = points[points.length - 1].timestamp;

      if (points.length < batchSize) break;
    }

    this.logger.log(
      `Backfill completed for vehicle ${vehicleId}: processed ${totalProcessed} telemetry points`,
    );

    const socUpFiltered = await this.filterAnomalousTrips(vehicleId, from, to);
    if (socUpFiltered > 0) {
      this.logger.warn(`[Backfill] Removed ${socUpFiltered} anomalous trip(s) for ${vehicleId}`);
    }

    return { processed: totalProcessed, socUpFiltered };
  }

  // Remove physically inconsistent trips after a backfill or rebuild.
  // Two classes of anomaly:
  //   1. SOC-up: SOC rose >= 1% during a meaningful drive (charging artefact)
  //   2. Impossible speed: average speed > 300 km/h (GPS jump artefact, e.g. 50 km in 9 min)
  private async filterAnomalousTrips(vehicleId: string, from: Date, to: Date): Promise<number> {
    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        startTime: { gte: from, lte: to },
        endTime: { not: null },
      },
      select: { id: true, startSoc: true, endSoc: true, distanceKm: true, startTime: true, endTime: true },
    });

    const ids = trips.filter((t) => {
      const dist = t.distanceKm ?? 0;
      const durationMs = t.endTime!.getTime() - t.startTime.getTime();

      // Rules mirror TripCleanupService.runManual() so backfill and live-engine
      // produce identical results without waiting for the 6-hour cleanup cron.

      // Ghost trip: parking manoeuvre / Tesla woke up briefly
      if (dist < 0.3) return true;

      // Very short trip that still covers some distance (U-turn, lot exit)
      if (durationMs < 60_000 && dist < 2.0) return true;

      // SOC-up: SOC rose ≥1% while traveling — charging artefact or detector bug
      if (dist >= 1.0 && t.startSoc != null && t.endSoc != null && (t.endSoc - t.startSoc) >= 1.0) return true;

      // Impossible speed: GPS jump artefact (e.g. 50 km in 9 min = 333 km/h)
      if (dist >= 1.0) {
        const durationHours = durationMs / 3_600_000;
        if (durationHours > 0 && dist / durationHours > 300) return true;
      }

      return false;
    }).map((t) => t.id);

    if (!ids.length) return 0;

    await this.prisma.tripPoint.deleteMany({ where: { tripId: { in: ids } } });
    await this.prisma.tripStats.deleteMany({ where: { tripId: { in: ids } } });
    await this.prisma.trip.deleteMany({ where: { id: { in: ids } } });
    return ids.length;
  }

  /**
   * Backfill reverse-geocoded addresses for trips that have GPS data but no address strings.
   * Uses Nominatim with 1 req/sec rate limiting — runs ~1 min per 50 trips.
   */
  async backfillAddresses(vehicleId: string): Promise<{ updated: number }> {
    const trips = await this.prisma.trip.findMany({ where: { vehicleId } });

    // A location needs geocoding if it's null OR if it looks like a raw "lat,lon" string
    const needsGeocode = (loc: string | null) =>
      !loc || /^-?\d+\.\d+,-?\d+\.\d+$/.test(loc);

    const toGeocode = trips.filter(
      t => needsGeocode(t.startLocation) || needsGeocode(t.endLocation),
    );

    this.logger.log(`Backfilling addresses for ${toGeocode.length}/${trips.length} trips`);
    let updated = 0;

    for (const trip of toGeocode) {
      // Parse existing "lat,lon" string or look up from trip_points
      const getCoords = async (loc: string | null, order: 'asc' | 'desc') => {
        if (loc && /^-?\d+\.\d+,-?\d+\.\d+$/.test(loc)) {
          const [lat, lon] = loc.split(',').map(Number);
          return { latitude: lat, longitude: lon };
        }
        return this.prisma.tripPoint.findFirst({
          where: { tripId: trip.id, latitude: { gt: -90 }, longitude: { gt: -180 } },
          orderBy: { timestamp: order },
        });
      };

      const [startCoords, endCoords] = await Promise.all([
        needsGeocode(trip.startLocation) ? getCoords(trip.startLocation, 'asc') : null,
        needsGeocode(trip.endLocation) ? getCoords(trip.endLocation, 'desc') : null,
      ]);

      const [startLocation, endLocation] = await Promise.all([
        startCoords?.latitude && startCoords?.longitude
          ? this.geocoding.reverseShort(startCoords.latitude, startCoords.longitude).catch(() => null)
          : null,
        endCoords?.latitude && endCoords?.longitude
          ? this.geocoding.reverseShort(endCoords.latitude, endCoords.longitude).catch(() => null)
          : null,
      ]);

      if (startLocation || endLocation) {
        await this.prisma.trip.update({
          where: { id: trip.id },
          data: {
            ...(startLocation ? { startLocation } : {}),
            ...(endLocation ? { endLocation } : {}),
          },
        });
        updated++;
      }
    }

    this.logger.log(`Address backfill complete: updated ${updated}/${toGeocode.length} trips`);
    return { updated };
  }
}

