import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { TelemetryQueueService } from '../queues/telemetry-queue.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * Computes and updates product/SLA metrics every 5 minutes.
 *
 * Metrics updated:
 *   evpulse_vehicle_online_ratio    — fraction with freshness < 600s
 *   evpulse_avg_data_freshness_sec  — mean freshness across all vehicles
 *   evpulse_dlq_depth               — failed jobs in DLQ
 *   evpulse_queue_depth             — telemetry queue waiting depth
 */
@Injectable()
export class ProductMetricsCronService {
  private readonly logger = new Logger(ProductMetricsCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly queueService?: TelemetryQueueService,
  ) {}

  @Cron('*/5 * * * *')
  async updateProductMetrics(): Promise<void> {
    if (!isWorkerRole()) return;
    try {
      await Promise.all([
        this.updateFreshnessMetrics(),
        this.updateDlqDepth(),
        this.updateQueueDepth(),
      ]);
    } catch (e: any) {
      this.logger.warn(`ProductMetrics update failed: ${e.message}`);
    }
  }

  private async updateFreshnessMetrics(): Promise<void> {
    // Get all vehicle IDs from vehicle_states
    const states = await this.prisma.vehicleState.findMany({
      select: { vehicleId: true, lastUpdate: true },
    });

    if (!states.length) {
      this.metrics.vehicleOnlineRatio.set(0);
      this.metrics.avgDataFreshnessSec.set(0);
      return;
    }

    const now = Date.now();
    let online = 0;
    let totalFreshness = 0;

    for (const s of states) {
      const freshnessSec = s.lastUpdate
        ? Math.floor((now - new Date(s.lastUpdate).getTime()) / 1000)
        : 9999;
      totalFreshness += freshnessSec;
      if (freshnessSec < 600) online++;
    }

    this.metrics.vehicleOnlineRatio.set(online / states.length);
    this.metrics.avgDataFreshnessSec.set(Math.round(totalFreshness / states.length));

    this.logger.debug(
      `SLA: ${online}/${states.length} online (ratio=${(online/states.length).toFixed(2)}, avgFreshness=${Math.round(totalFreshness/states.length)}s)`,
    );
  }

  private async updateDlqDepth(): Promise<void> {
    const depth = await (this.redis as any).llen('dlq:jobs:telemetry').catch(() => 0);
    this.metrics.dlqDepth.set(depth);
  }

  private async updateQueueDepth(): Promise<void> {
    if (!this.queueService) return;
    const stats = await this.queueService.getQueueStats();
    this.metrics.queueDepth.set(stats.telemetry.waiting);
  }
}
