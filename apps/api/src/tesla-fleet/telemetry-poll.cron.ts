import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryFetcherService } from './telemetry-fetcher.service';
import { ChargingSyncService } from './charging-sync.service';
import { REDIS_CLIENT } from '../infra/redis.provider';
import { isWorkerRole } from '../runtime/runtime-role';

/** Force a REST fetch if no telemetry for this many milliseconds.
 * MQTT pipeline updates vehicle:last_seen on every streaming point, so this
 * threshold is only hit when fleet telemetry is genuinely silent.
 * Configurable via TESLA_FORCE_FETCH_AFTER_MS env var (default 30 min).
 */
const FORCE_FETCH_AFTER_MS =
  parseInt(process.env.TESLA_FORCE_FETCH_AFTER_MS ?? '', 10) || 30 * 60_000;

/**
 * TelemetryPollCronService
 *
 * Резервный (cron-базированный) поллинг Tesla Fleet API, который обходит
 * возможные проблемы с Bull/BullMQ и гарантирует, что хотя бы раз в минуту
 * мы попытаемся получить свежие данные vehicle_data для всех активных машин.
 *
 * Вся бизнес-логика остаётся внутри TelemetryFetcherService, здесь только
 * выборка связанных машин и вызов fetchVehicleTelemetry.
 */
@Injectable()
export class TelemetryPollCronService implements OnModuleInit {
  private readonly logger = new Logger(TelemetryPollCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetryFetcher: TelemetryFetcherService,
    @Optional() private readonly chargingSync?: ChargingSyncService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * On startup, launch adaptive polling loops for all active linked vehicles.
   * Cron-based polling below remains as a safety fallback.
   */
  async onModuleInit() {
    if (!isWorkerRole()) {
      this.logger.log('Skipping adaptive polling init (APP_ROLE=api)');
      return;
    }
    try {
      const accounts = await this.prisma.teslaAccount.findMany({
        include: {
          vehicleLinks: {
            include: {
              vehicle: { select: { id: true, status: true, teslaId: true, vin: true } },
            },
          },
        },
      });

      let started = 0;

      for (const account of accounts) {
        for (const link of account.vehicleLinks) {
        // Не зависим от status: главное, чтобы была связка с Tesla.
        if (!link.vehicle.teslaId) continue;

          this.telemetryFetcher.startAdaptivePolling(
            link.vehicle.id,
            account.userId,
          );
          started++;
        }
      }

      this.logger.log(
        `Adaptive polling: started loops for ${started} active vehicle(s) across ${accounts.length} Tesla account(s)`,
      );

      // Boot backfill: if service restarted mid-session, the startTime/startSoc in DB may
      // reflect when polling caught up rather than when charging actually began. Trigger a
      // backfill for any open session that is less than 45 minutes old.
      if (this.chargingSync) {
        for (const account of accounts) {
          for (const link of account.vehicleLinks) {
            const vin = link.vehicle.vin;
            if (!vin || !link.vehicle.teslaId) continue;
            const openSession = await this.prisma.chargingSession.findFirst({
              where: { vehicleId: link.vehicle.id, endTime: null },
              select: { id: true, startTime: true },
            }).catch(() => null);
            if (!openSession) continue;
            const ageMs = Date.now() - openSession.startTime.getTime();
            if (ageMs < 45 * 60_000) {
              this.logger.log(`[BootBackfill] Triggering backfill for open session on vehicle ${link.vehicle.id} (age ${Math.round(ageMs / 60_000)} min)`);
              this.chargingSync.backfillSessionStart(link.vehicle.id, vin, account.userId)
                .catch((e: any) => this.logger.warn(`[BootBackfill] ${link.vehicle.id}: ${e.message}`));
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to start adaptive polling loops on module init: ${error.message}`,
      );
    }
  }

  /**
   * Force-fetch fallback: runs every 5 minutes and triggers a REST poll for
   * any vehicle whose last_seen heartbeat is older than FORCE_FETCH_AFTER_MS
   * AND fleet telemetry is not currently streaming.
   *
   * This is a safety net for when the adaptive polling loop misses a cycle
   * (e.g. after a worker restart) or fleet telemetry connectivity drops.
   * Sleeping vehicles are skipped — fleet push will deliver data on wake.
   */
  @Cron('*/5 * * * *')
  async forceFetchStalenessCheck() {
    if (!isWorkerRole()) return;
    if (!this.redis) return;
    try {
      const accounts = await this.prisma.teslaAccount.findMany({
        include: {
          vehicleLinks: {
            include: {
              vehicle: { select: { id: true, teslaId: true, vin: true } },
            },
          },
        },
      });

      for (const account of accounts) {
        for (const link of account.vehicleLinks) {
          if (!link.vehicle.teslaId) continue;
          const vehicleId = link.vehicle.id;
          const vin = link.vehicle.vin;

          // Skip if fleet telemetry is actively streaming — car is pushing its own data.
          if (vin) {
            const fleetLive = await (this.redis as any)
              .get(`fleet:live:vin:${vin}`)
              .catch(() => null);
            if (fleetLive) continue;
          }

          // Skip if Tesla recently confirmed the car is asleep — no point spending
          // a Daten call every 5 min just to hear "asleep" again. Fleet push clears this.
          if (vin) {
            const sleepConfirmed = await (this.redis as any)
              .get(`tesla:sleep-confirmed:vin:${vin}`)
              .catch(() => null);
            if (sleepConfirmed) continue;
          }

          const raw = await (this.redis as any).get(`vehicle:last_seen:${vehicleId}`);
          // When Redis key is absent (cold start / TTL expiry), seed from DB rather
          // than defaulting to epoch-0 which produces a ~56-year staleness reading.
          let lastSeenMs = raw ? parseInt(raw, 10) : 0;
          if (!lastSeenMs) {
            const latest = await this.prisma.telemetryPoint.findFirst({
              where:   { vehicleId },
              orderBy: { timestamp: 'desc' },
              select:  { timestamp: true },
            }).catch(() => null);
            lastSeenMs = latest ? latest.timestamp.getTime() : Date.now();
            if (lastSeenMs) {
              await (this.redis as any).set(`vehicle:last_seen:${vehicleId}`, lastSeenMs, 'EX', 3600);
            }
          }
          const staleness = Date.now() - lastSeenMs;

          if (staleness > FORCE_FETCH_AFTER_MS) {
            this.logger.debug(
              `[ForceFetch] ${vehicleId}: stale ${Math.round(staleness / 1000)}s, triggering REST poll`,
            );
            this.telemetryFetcher.fetchVehicleTelemetry(vehicleId, account.userId)
              .catch((e: any) =>
                this.logger.warn(`[ForceFetch] ${vehicleId}: ${e.message}`),
              );
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`forceFetchStalenessCheck error: ${e.message}`);
    }
  }
}

