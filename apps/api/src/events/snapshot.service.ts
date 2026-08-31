/**
 * SnapshotService — periodic vehicle state snapshots for time-travel debugging
 * and fast recovery after service restart (Redis cold start).
 *
 * Strategy:
 *  • take() is called by TelemetryPipelineService on every significant state
 *    transition — keeps the snapshot table up to date without a polling cron.
 *  • bootstrapFromDb() is called at service startup to hydrate Redis state from
 *    the latest DB snapshot (cold-start path), so detectors don't start blind.
 *  • purgeOld() is called by a nightly cron to keep the table ≤ 30 days.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

export interface VehicleStatePayload {
  speed:          number;
  soc?:           number | null;
  power:          number;
  lat?:           number | null;
  lng?:           number | null;
  vehicleState?:  string;
  charging_state?: string | null;
  updatedAt?:     number;
  [key: string]:  unknown;
}

export type SnapshotTrigger = 'transition' | 'heartbeat' | 'cold_start' | 'pipeline';

@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  /** Minimum gap between two consecutive snapshots for the same vehicle (ms).
   *  Prevents write amplification when telemetry arrives at high cadence. */
  private readonly MIN_SNAPSHOT_INTERVAL_MS = 5 * 60_000; // 5 min

  /** In-memory debounce: vehicleId → last snapshot timestamp (ms epoch) */
  private readonly lastSnapshotAt = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a state snapshot — debounced to MIN_SNAPSHOT_INTERVAL_MS.
   *
   * @param force - bypass the debounce (use on state transitions)
   */
  async take(
    vehicleId: string,
    state:     VehicleStatePayload,
    trigger:   SnapshotTrigger = 'pipeline',
    force      = false,
  ): Promise<void> {
    const now    = Date.now();
    const lastTs = this.lastSnapshotAt.get(vehicleId) ?? 0;
    if (!force && now - lastTs < this.MIN_SNAPSHOT_INTERVAL_MS) return;

    this.lastSnapshotAt.set(vehicleId, now);
    try {
      await this.prisma.vehicleStateSnapshot.create({
        data: {
          vehicleId,
          snapshotAt: new Date(now),
          trigger,
          state:      state as any,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Snapshot write failed for ${vehicleId}: ${err?.message}`);
    }
  }

  /**
   * Returns the most recent snapshot for a vehicle — used on cold start to
   * hydrate the in-memory detector cache when Redis state is unavailable.
   */
  async getLatest(vehicleId: string): Promise<VehicleStatePayload | null> {
    const snap = await this.prisma.vehicleStateSnapshot.findFirst({
      where:   { vehicleId },
      orderBy: { snapshotAt: 'desc' },
      select:  { state: true },
    });
    return snap ? (snap.state as VehicleStatePayload) : null;
  }

  /**
   * Returns a page of snapshots sorted newest-first — used for time-travel
   * debugging via the `/api/v1/vehicles/:id/snapshots` endpoint.
   */
  async list(
    vehicleId: string,
    limit      = 20,
    before?:   Date,
  ) {
    return this.prisma.vehicleStateSnapshot.findMany({
      where: {
        vehicleId,
        ...(before ? { snapshotAt: { lt: before } } : {}),
      },
      orderBy: { snapshotAt: 'desc' },
      take:    limit,
      select:  { id: true, snapshotAt: true, trigger: true, state: true },
    });
  }

  // ── Nightly purge of snapshots older than 30 days ────────────────────────
  //
  // A single unbounded DELETE on a large table holds a long-running transaction
  // that blocks autovacuum and can spike replication lag.  We instead delete
  // in fixed-size batches (≤ PURGE_BATCH_SIZE rows per iteration) with a brief
  // yield between batches to let autovacuum and other writers interleave.

  private static readonly PURGE_BATCH_SIZE = 10_000;

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOld(): Promise<void> {
    const cutoff    = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const batchSize = SnapshotService.PURGE_BATCH_SIZE;
    let   total      = 0;
    let   iterations = 0;
    const MAX_ITER   = 1_000; // hard guard: prevents infinite loop if rows keep
                               // appearing faster than we delete (clock skew, etc.)

    // Fetch IDs in batches and delete by PK — avoids a full-table scan on
    // every iteration and keeps each transaction short.
    while (iterations++ < MAX_ITER) {
      const rows = await this.prisma.vehicleStateSnapshot.findMany({
        where:   { snapshotAt: { lt: cutoff } },
        select:  { id: true },
        take:    batchSize,
      });

      if (!rows.length) break;

      const ids        = rows.map((r) => r.id);
      const { count }  = await this.prisma.vehicleStateSnapshot.deleteMany({
        where: { id: { in: ids } },
      });

      total += count;

      if (count > 0) {
        this.logger.debug(`Purge batch #${iterations}: deleted ${count} snapshots (total so far: ${total})`);
      }

      // Yield to the event loop between batches so other requests can proceed.
      if (rows.length < batchSize) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (iterations >= MAX_ITER) {
      this.logger.warn(`Snapshot purge hit MAX_ITER=${MAX_ITER} — possible runaway; total deleted so far: ${total}`);
    }

    if (total > 0) {
      this.logger.log(`Purged ${total} vehicle state snapshots older than 30 days`);
    }
  }
}
