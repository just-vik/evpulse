import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelemetryFetcherService } from '../tesla-fleet/telemetry-fetcher.service';
import { isWorkerRole } from '../runtime/runtime-role';

@Injectable()
export class StreamWatchdogService {
  private readonly logger = new Logger(StreamWatchdogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly telemetryFetcher: TelemetryFetcherService,
  ) {}

  /**
   * Every 30 minutes: ensures adaptive polling loop is alive.
   * This is a supervisor for the loop — it does not make Tesla API calls itself.
   * The loop's own sleep-confirmed + fleet-live logic prevents unnecessary Daten.
   */
  @Cron('*/30 * * * *') // every 30 minutes
  async ensurePollingFallback() {
    if (!isWorkerRole()) return;
    const links = await this.prisma.teslaVehicleLink.findMany({
      include: { teslaAccount: true },
    });
    if (!links.length) return;

    for (const link of links) {
      const vehicleId = link.vehicleId;
      const userId = link.teslaAccount.userId;
      // Restart loop if it died; startAdaptivePolling is a no-op when already running.
      this.telemetryFetcher.startAdaptivePolling(vehicleId, userId);
    }
  }
}

