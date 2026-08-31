import { Processor, Process, InjectQueue, OnQueueFailed } from '@nestjs/bull';
import { Logger, Injectable, Optional, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Job, Queue } from 'bull';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { TELEMETRY_QUEUE } from './queues.constants';
import { TelemetryService } from '../telemetry/telemetry.service';
import { TelemetryGateway } from '../websockets/telemetry.gateway';
import { TelemetryFetcherService } from '../tesla-fleet/telemetry-fetcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { TelemetryPipelineService } from '../telemetry/telemetry-pipeline.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * TelemetryProcessor — smart self-scheduling polling.
 *
 * Each fetch-telemetry job re-enqueues itself with a state-aware delay:
 *   DRIVING   2 s  — real-time GPS / speed / power
 *   CHARGING  8 s  — SoC, charge rate
 *   PARKED   30 s  — occasional online check
 *   SLEEPING 600 s — 10 min; prevent vampire drain
 *   OFFLINE  300 s — retry every 5 min
 *
 * Bull jobId `fetch-<vehicleId>` deduplicates — batch safety-net and
 * bootstrap recovery never create duplicate jobs.
 *
 * NOTE: redisProvider must be registered in QueuesModule providers.
 */

// When MQTT fleet telemetry is active, REST is skipped entirely (fleet:live:vin key).
// These delays apply only when MQTT is NOT streaming (car fully idle/offline).
// Target: stay within ~10 EUR/month Tesla API budget for 1 vehicle.
const STATE_DELAY_MS: Record<string, number> = {
  driving:  2_000,      // MQTT handles real-time; REST only as gap-fill (skipped if live)
  charging: 300_000,    // 5 min — MQTT covers charge rate; no need for 8s REST
  parked:   600_000,    // 10 min — car is idle; reduce REST polls significantly
  sleeping: 1_800_000,  // 30 min — car sleeping; rare check to detect external wake
  offline:  900_000,    // 15 min — retry interval when car is offline
};
const DEFAULT_DELAY_MS = 30_000;

@Processor(TELEMETRY_QUEUE)
@Injectable()
export class TelemetryProcessor {
  private readonly logger = new Logger(TelemetryProcessor.name);

  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly telemetryGateway: TelemetryGateway,
    private readonly prisma: PrismaService,
    @InjectQueue(TELEMETRY_QUEUE) private readonly telemetryQueue: Queue,
    @Optional() private readonly telemetryFetcher?: TelemetryFetcherService,
    @Inject(REDIS_CLIENT) private readonly redis?: Redis,
    @Optional() private readonly pipeline?: TelemetryPipelineService,
  ) {}

  // ── Push ingest path (Fleet Telemetry / manual) ──────────────────────────

  @Process({ name: 'ingest-telemetry', concurrency: 5 })
  async ingestTelemetry(job: Job<{ vehicleId: string; data: any; traceId?: string }>) {
    const { vehicleId, data } = job.data;
    const traceId = job.data.traceId ?? randomUUID();
    const startTime = Date.now();

    try {
      // Normalize data to array of points
      const points: any[] = Array.isArray(data) ? data : [data];

      if (this.pipeline) {
        // Preferred path: full pipeline with dedup, detectors, aggregation
        const { CreateTelemetryPointDto } = await import('../telemetry/dto/telemetry.dto');
        await this.pipeline.processBatch(vehicleId, points, 'fleet_telemetry', traceId);
      } else {
        // Fallback: direct createTelemetryPoint for each point
        for (const point of points) {
          const telemetryPoint = await this.telemetryService.createTelemetryPoint(
            vehicleId,
            {
              soc:        point.soc || point.battery_level,
              speed:      point.speed,
              power:      point.power,
              current:    point.current,
              voltage:    point.voltage,
              latitude:   point.latitude,
              longitude:  point.longitude,
              batteryTemp: point.battery_temp,
              outsideTemp: point.outside_temp,
              insideTemp:  point.inside_temp,
              odometer:   point.odometer,
              heading:    point.heading,
              timestamp:  point.timestamp ? new Date(point.timestamp) : new Date(),
            },
          );

          this.telemetryGateway.emitTelemetryUpdate(vehicleId, {
            ...telemetryPoint,
            timestamp: telemetryPoint.timestamp.toISOString(),
          });
        }
      }

      this.logger.debug(
        `[${traceId}] ingest OK vehicleId=${vehicleId} points=${points.length} duration=${Date.now() - startTime}ms`,
      );

      return { success: true, traceId, duration: Date.now() - startTime };
    } catch (error) {
      this.logger.error(`[${traceId}] [ingest] vehicle ${vehicleId}: ${error.message}`);
      // Re-throw so Bull retries
      throw error;
    }
  }

  // ── DLQ handler ──────────────────────────────────────────────────────────

  @OnQueueFailed()
  async handleFailed(job: Job, error: Error) {
    const traceId = job.data?.traceId ?? 'unknown';
    const jobName = job.name;
    const jobId = job.id;

    this.logger.warn(
      `[DLQ] job=${jobName} id=${jobId} traceId=${traceId} attempt=${job.attemptsMade} error=${error.message}`,
    );

    if (this.redis) {
      const entry = JSON.stringify({
        jobName,
        jobId,
        traceId,
        data: job.data,
        error: error.message,
        stack: error.stack?.slice(0, 500),
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      });

      await this.redis.lpush('dlq:jobs:telemetry', entry);
      await this.redis.ltrim('dlq:jobs:telemetry', 0, 999);
    }
  }

  // ── Smart polling path ───────────────────────────────────────────────────

  @Process('fetch-telemetry')
  async handleFetchTelemetry(job: Job<{ vehicleId: string; userId: string }>) {
    const { vehicleId, userId } = job.data;

    try {
      this.logger.debug(
        `TelemetryFetcher available: ${!!this.telemetryFetcher} for vehicle ${vehicleId}`,
      );
      // Отметка прогресса, чтобы Bull не воспринимал долгие запросы как "зависшие".
      await job.progress(10);

      if (!this.telemetryFetcher) {
        this.logger.warn(`TelemetryFetcher not available for vehicle ${vehicleId}`);
        await this.scheduleNext(vehicleId, userId, DEFAULT_DELAY_MS);
        return { success: false, reason: 'TelemetryFetcher not initialized' };
      }

      const telemetryPoint = await this.telemetryFetcher.fetchVehicleTelemetry(vehicleId, userId);

      // Broadcast fresh telemetry via WebSocket immediately (before buffer flush)
      if (telemetryPoint) {
        this.telemetryGateway.emitTelemetryUpdate(vehicleId, telemetryPoint);
      }

      // Re-enqueue with state-aware delay (self-scheduling loop)
      const delay = await this.delayForVehicle(vehicleId);
      await this.scheduleNext(vehicleId, userId, delay);

      this.logger.debug(`[fetch] vehicle=${vehicleId} next=${delay / 1000}s`);
      await job.progress(100);
      return { success: true };
    } catch (error) {
      this.logger.error(`[fetch] vehicle ${vehicleId}: ${error.message}`);
      // Back off 60 s on error so we don't hammer an asleep/offline vehicle
      await this.scheduleNext(vehicleId, userId, 60_000);
      return { success: false, error: error.message };
    }
  }

  // ── Batch safety-net (cron every minute) ─────────────────────────────────

  @Process('batch-fetch-telemetry')
  async handleBatchFetchTelemetry(_job: Job) {
    const accounts = await this.prisma.teslaAccount.findMany({
      include: {
        vehicleLinks: {
          include: { vehicle: { select: { id: true, status: true, teslaId: true } } },
        },
      },
    });

    let enqueued = 0;
    for (const account of accounts) {
      for (const link of account.vehicleLinks) {
        // Не полагаемся на произвольный статус, важнее наличие teslaId.
        if (!link.vehicle.teslaId) continue;
        const vehicleId = link.vehicle.id;
        const delay = await this.delayForVehicle(vehicleId);
        await this.scheduleNext(vehicleId, account.userId, delay);
        enqueued++;
      }
    }

    this.logger.log(`[batch] safety-net verified ${enqueued} vehicles`);
    return { processed: enqueued };
  }

  // ── Batch ingest ─────────────────────────────────────────────────────────

  @Process('batch-ingest-telemetry')
  async processBatchTelemetry(job: Job<{ vehicleId: string; points: any[] }>) {
    const { vehicleId, points } = job.data;
    this.logger.log(`[batch-ingest] ${points.length} points for vehicle ${vehicleId}`);

    // Use createMany for bulk inserts — up to 30× faster than individual INSERTs
    const chunkSize = 500;
    for (let i = 0; i < points.length; i += chunkSize) {
      const chunk = points.slice(i, i + chunkSize);
      await this.telemetryService.createManyTelemetryPoints(vehicleId, chunk);
    }

    return { success: true, pointsProcessed: points.length };
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  @Process('cleanup-telemetry')
  async cleanupOldTelemetry() {
    this.logger.log('[cleanup] Pruning old telemetry');
    await this.telemetryService.pruneOldTelemetry(30);
    return { success: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Enqueue fetch-telemetry with a stable jobId for deduplication.
   * Bull silently drops the add if a job with this ID already exists in
   * waiting / delayed / active state.
   */
  private async scheduleNext(vehicleId: string, userId: string, delay: number) {
    await this.telemetryQueue.add(
      'fetch-telemetry',
      { vehicleId, userId },
      {
        delay,
        jobId:            `fetch-${vehicleId}`,
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5_000 },
        removeOnComplete: 10,
        removeOnFail:     20,
      },
    );
  }

  /** Read vehicle state from DB and return corresponding poll delay (ms). */
  private async delayForVehicle(vehicleId: string): Promise<number> {
    const row = await this.prisma.vehicleState.findUnique({
      where:  { vehicleId },
      select: { state: true },
    });
    return STATE_DELAY_MS[row?.state?.toLowerCase() ?? ''] ?? DEFAULT_DELAY_MS;
  }

  /**
   * Watchdog для "застрявших" fetch-telemetry jobs.
   * Если Bull пометил job как failed со stalled‑reason, переочередим её.
   */
  @Cron('*/5 * * * *') // every 5 minutes
  async requeueStalledFetchJobs() {
    if (!isWorkerRole()) return;
    const failed = await this.telemetryQueue.getFailed();
    let recovered = 0;

    for (const job of failed) {
      if (job.name !== 'fetch-telemetry') continue;

      const data = job.data as { vehicleId?: string; userId?: string };
      if (!data?.vehicleId || !data?.userId) continue;

      this.logger.warn(
        `[watchdog] requeue stalled fetch-telemetry for vehicle ${data.vehicleId}`,
      );

      await job.remove();
      await this.scheduleNext(data.vehicleId, data.userId, DEFAULT_DELAY_MS);
      recovered++;
    }

    if (recovered > 0) {
      this.logger.log(
        `[watchdog] requeued ${recovered} stalled fetch-telemetry job(s)`,
      );
    }
  }
}
