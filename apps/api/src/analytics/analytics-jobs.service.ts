import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkerRole } from '../runtime/runtime-role';

@Injectable()
export class AnalyticsJobsService {
  private readonly logger = new Logger(AnalyticsJobsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hourly refresh of vehicle_daily_stats.
   * Uses CONCURRENTLY to avoid blocking readers.
   */
  @Cron('0 * * * *')
  async refreshDailyStats() {
    if (!isWorkerRole()) return;
    try {
      await this.prisma.$executeRawUnsafe(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY vehicle_daily_stats',
      );
      this.logger.log('vehicle_daily_stats refreshed');
    } catch (err) {
      this.logger.error('Failed refreshing vehicle_daily_stats', err as any);
    }
  }
}

