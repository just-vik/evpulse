import { Injectable, Logger, Inject } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service'
import { TelemetryFetcherService } from './telemetry-fetcher.service'
import { REDIS_CLIENT } from '../infra/redis.provider'
import { isWorkerRole } from '../runtime/runtime-role'

@Injectable()
export class GapRecoveryService {
  private readonly logger = new Logger(GapRecoveryService.name)
  private readonly GAP_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes
  private readonly LOCK_TTL_S       = 300             // 5-minute distributed lock

  constructor(
    private readonly prisma:   PrismaService,
    private readonly fetcher:  TelemetryFetcherService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async recoverGaps(): Promise<void> {
    if (!isWorkerRole()) return;

    const links = await this.prisma.teslaVehicleLink.findMany({
      include: {
        vehicle:      { select: { id: true, status: true, teslaId: true, vin: true } },
        teslaAccount: { select: { userId: true } },
      },
    })

    const now = Date.now()
    let recovered = 0

    for (const link of links) {
      if (!link.vehicle.teslaId) continue
      const vehicleId = link.vehicle.id
      const userId    = link.teslaAccount.userId

      const last = await this.prisma.telemetryPoint.findFirst({
        where:   { vehicleId },
        orderBy: { timestamp: 'desc' },
        select:  { timestamp: true },
      })

      const gap = now - (last?.timestamp?.getTime() ?? 0)
      if (gap <= this.GAP_THRESHOLD_MS) continue

      // Skip if car is confirmed sleeping — fleet push will signal when it wakes.
      // Avoids burning a Daten call every 10 min while the car sleeps overnight.
      if (link.vehicle.vin) {
        const sleepConfirmed = await this.redis.get(`tesla:sleep-confirmed:vin:${link.vehicle.vin}`).catch(() => null);
        if (sleepConfirmed) continue;
      }

      // Distributed lock — prevents TripGapRecoveryService from running concurrently
      // on the same vehicle and producing duplicate telemetry points.
      const lockKey = `gap:recovery:lock:${vehicleId}`
      const locked  = await this.redis.set(lockKey, '1', 'EX', this.LOCK_TTL_S, 'NX')
      if (locked !== 'OK') continue // another process is already recovering this vehicle

      try {
        this.logger.log(`[GapRecovery] vehicle=${vehicleId} gap=${Math.round(gap / 60000)}min — fetching`)
        await this.fetcher.fetchVehicleTelemetry(vehicleId, userId)
        recovered++
      } catch (e: any) {
        this.logger.warn(`[GapRecovery] failed: ${e.message}`)
      } finally {
        await this.redis.del(lockKey)
      }
    }

    if (recovered > 0) {
      this.logger.log(`[GapRecovery] Recovered ${recovered} vehicles`)
    }
  }
}
