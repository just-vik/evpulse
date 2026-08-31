import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { TELEMETRY_QUEUE, VEHICLE_SYNC_QUEUE } from './queues.constants';
import { Cron, CronExpression } from '@nestjs/schedule';
import { isWorkerRole } from '../runtime/runtime-role';

@Injectable()
export class TelemetryQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelemetryQueueService.name);

  constructor(
    @InjectQueue(TELEMETRY_QUEUE) private readonly telemetryQueue: Queue,
    @InjectQueue(VEHICLE_SYNC_QUEUE) private readonly vehicleSyncQueue: Queue,
  ) {}

  /**
   * On API restart, immediately trigger a batch fetch so we don't wait up to
   * 60 seconds for the first cron tick.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!isWorkerRole()) {
      this.logger.log('Skipping telemetry queue bootstrap (APP_ROLE=api)');
      return;
    }
    this.logger.log('Bootstrap: enqueuing initial batch telemetry fetch');
    await this.telemetryQueue.add(
      'batch-fetch-telemetry',
      {},
      { jobId: 'bootstrap-batch', removeOnComplete: 10, removeOnFail: 10 },
    );
  }

  async enqueueTelemetryFetch(vehicleId: string, userId: string, vehicleState?: string) {
    // Backpressure: shed non-critical load when queue is overwhelmed
    const waiting = await this.telemetryQueue.getWaitingCount();
    if (waiting > 10_000) {
      const state = (vehicleState ?? '').toLowerCase();
      if (['parked', 'sleeping', 'offline'].includes(state)) {
        this.logger.warn(`[backpressure] dropping ${vehicleId} (state=${state}, queue=${waiting})`);
        return;
      }
    }
    if (waiting > 50_000) {
      this.logger.warn(`[backpressure] queue CRITICAL (${waiting}), dropping ${vehicleId}`);
      return;
    }

    await this.telemetryQueue.add(
      'fetch-telemetry',
      { vehicleId, userId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );
    this.logger.debug(`Enqueued telemetry fetch for vehicle ${vehicleId}`);
  }

  async getQueueDepth(): Promise<number> {
    return this.telemetryQueue.getWaitingCount();
  }

  async enqueueVehicleSync(userId: string) {
    await this.vehicleSyncQueue.add(
      'sync-vehicles',
      { userId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
      },
    );
    this.logger.debug(`Enqueued vehicle sync for user ${userId}`);
  }

  // Scheduled job: fetch telemetry for all active vehicles every 30 minutes (fallback only)
  @Cron('*/30 * * * *')
  async scheduledTelemetryFetch() {
    if (!isWorkerRole()) return;
    this.logger.log('Running scheduled telemetry fetch');
    await this.telemetryQueue.add(
      'batch-fetch-telemetry',
      {},
      {
        removeOnComplete: 10,
        removeOnFail: 10,
      },
    );
  }

  // Retention: prune raw telemetry points older than 30 days (runs at 03:00 UTC)
  @Cron('0 3 * * *')
  async scheduledRetention() {
    if (!isWorkerRole()) return;
    this.logger.log('Scheduling telemetry retention cleanup');
    await this.telemetryQueue.add(
      'cleanup-telemetry',
      {},
      { removeOnComplete: 5, removeOnFail: 5 },
    );
  }

  // Scheduled job: sync vehicles every hour
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledVehicleSync() {
    if (!isWorkerRole()) return;
    this.logger.log('Running scheduled vehicle sync');
    await this.vehicleSyncQueue.add(
      'batch-sync-vehicles',
      {},
      { removeOnComplete: 5 },
    );
  }

  async getQueueStats() {
    const [telemetryStats, syncStats] = await Promise.all([
      this.getQueueInfo(this.telemetryQueue),
      this.getQueueInfo(this.vehicleSyncQueue),
    ]);

    return {
      telemetry: telemetryStats,
      vehicleSync: syncStats,
    };
  }

  private async getQueueInfo(queue: Queue) {
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }
}
